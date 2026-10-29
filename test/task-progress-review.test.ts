import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { utimesSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beginTaskDeletionIntent, createTask, getTask, tasksDir, activateTask, reviewTask, acknowledgeTaskProgress, acknowledgeTaskReview } from '../src/rooms-tasks/task-state.js';
import { acceptTaskDeletion, settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import {
  appendTaskProgress, attachTaskReviewArtifact, clearTaskReview, detachTaskReviewArtifact, getTaskReview, listTaskProgress, taskProgressSnapshot,
  openTaskWorkspaceFile, readTaskReviewArtifact, reviewStoreDirectory, reviewStoreFiles, setTaskReviewMarkdown,
  taskContributionSummary, PROGRESS_MAX_ENTRIES, PROGRESS_TEXT_MAX,
} from '../src/rooms-tasks/task-review.js';

const developer = { kind: 'agent', role: 'dev-1', identity_cid: 'A'.repeat(64), surface: 'mcp' } as const;
const critic = { kind: 'agent', role: 'critic-1', surface: 'cli' } as const;
const operator = { kind: 'local_control', surface: 'cli' } as const;

let root: string;
let oldHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-review-test-'));
  oldHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function task() { return createTask({ title: 'work', origin: { type: 'cli' } }); }
async function attachFile(taskId: string, path: string, author: typeof developer | typeof critic | typeof operator = developer, requestKey?: string) {
  const source = await openTaskWorkspaceFile(getTask(taskId), path);
  return attachTaskReviewArtifact(taskId, { name: source.name, source, author, requestKey });
}

describe('task progress', () => {
  it('snapshots exact per-ID reads without mutation and preserves legacy read semantics', async () => {
    const t = task();
    const first = appendTaskProgress(t.task_id, { text: 'old', author: developer, requestKey: 'private-retry-key' }).entry;
    const middle = appendTaskProgress(t.task_id, { text: 'middle', author: developer }).entry;
    const last = appendTaskProgress(t.task_id, { text: 'last', author: developer }).entry;
    await acknowledgeTaskProgress(t.task_id, [middle.id]);
    const before = getTask(t.task_id);
    const snapshot = taskProgressSnapshot(t.task_id);
    expect(snapshot.map(entry => [entry.id, entry.unread])).toEqual([[first.id, true], [middle.id, false], [last.id, true]]);
    expect(snapshot[0]).not.toHaveProperty('request_key');
    expect(getTask(t.task_id)).toEqual(before);
    // Old records predate tracking. Existing entries must not become new after upgrade.
    const path = join(tasksDir(), `${t.task_id}.json`);
    const legacy = { ...before };
    delete legacy.contribution_reads;
    writeFileSync(path, JSON.stringify(legacy));
    expect(taskProgressSnapshot(t.task_id).map(entry => entry.unread)).toEqual([false, false, false]);
    const fresh = appendTaskProgress(t.task_id, { text: 'after upgrade', author: developer }).entry;
    expect(taskProgressSnapshot(t.task_id).map(entry => [entry.id, entry.unread])).toEqual([
      [first.id, false], [middle.id, false], [last.id, false], [fresh.id, true],
    ]);
  });

  it('appends exact authored text in order with stable ids, authors and times', () => {
    const t = task();
    const first = appendTaskProgress(t.task_id, { text: '  Root cause found:\n\n    stale cache key\n', author: developer });
    const second = appendTaskProgress(t.task_id, { text: 'PR opened: https://example.test/pr/1', author: operator });
    const listed = listTaskProgress(t.task_id);
    expect(listed.map(entry => entry.text)).toEqual(['  Root cause found:\n\n    stale cache key\n', 'PR opened: https://example.test/pr/1']);
    expect(listed.map(entry => entry.author)).toEqual([developer, operator]);
    expect(new Set(listed.map(entry => entry.id)).size).toBe(2);
    expect(Date.parse(listed[0]!.at)).toBeLessThanOrEqual(Date.parse(listed[1]!.at));
    expect(first.replayed).toBe(false); expect(second.replayed).toBe(false);
    // The first new entry initializes the durable read boundary; lifecycle and other fields stay intact.
    expect(getTask(t.task_id)).toEqual({
      ...t, progress: listed, contribution_reads: { progress_read: [], review_revision: 0 },
      notification_events: [...t.notification_events!, ...listed.map(entry => ({
        eventId: `task:${t.task_id}:progress:${entry.id}`, taskId: t.task_id,
        title: 'Progress: work', body: entry.text.trim(),
        target: { kind: 'task', taskId: t.task_id }, delivery: 'push-only',
      }))],
    });
  });

  it('rejects empty, oversized and malformed input without writing', () => {
    const t = task();
    expect(() => appendTaskProgress(t.task_id, { text: ' \n\t', author: developer })).toThrow(/required/);
    expect(() => appendTaskProgress(t.task_id, { text: 'x'.repeat(401), author: developer })).toThrow(/maximum/);
    expect(() => appendTaskProgress(t.task_id, { text: 'ok', requestKey: 'bad key', author: developer })).toThrow(/request_key/);
    expect(() => appendTaskProgress('../escape', { text: 'ok', author: developer })).toThrow(/invalid task ID/);
    expect(listTaskProgress(t.task_id)).toEqual([]);
    expect(getTask(t.task_id).progress).toBeUndefined();
  });

  it('limits new entries to 400 code points of the exact text, writing nothing when refused', () => {
    expect(PROGRESS_TEXT_MAX).toBe(400);
    const t = task();
    appendTaskProgress(t.task_id, { text: 'first', author: developer });
    const before = readFileSync(join(tasksDir(), `${t.task_id}.json`), 'utf8');
    const refused = [
      'x'.repeat(401),
      // Astral characters are two UTF-16 units but one code point each.
      '😀'.repeat(401),
      // A combining mark is its own code point: 399 + 'é' (e + U+0301) is 401.
      'x'.repeat(399) + 'e\u0301',
      // Whitespace counts as written; nothing is trimmed before counting.
      ` ${'x'.repeat(400)}`,
      'Готово. '.repeat(50) + 'x',
    ];
    for (const text of refused) {
      expect(() => appendTaskProgress(t.task_id, { text, author: developer, requestKey: 'long' }))
        .toThrow(/is 401 Unicode characters \(code points\); the maximum is 400\. Nothing was saved/);
    }
    // No entry, no retry key, no notification event and no read-state change.
    expect(readFileSync(join(tasksDir(), `${t.task_id}.json`), 'utf8')).toBe(before);
    const accepted = ['x'.repeat(400), '😀'.repeat(400), 'x'.repeat(398) + 'e\u0301', 'Готово. '.repeat(50), '👩‍💻'.repeat(133)];
    for (const text of accepted) expect(appendTaskProgress(t.task_id, { text, author: developer }).entry.text).toBe(text);
    // A joined emoji is several code points: 👩‍💻 is three, so 134 of them are 402.
    expect(() => appendTaskProgress(t.task_id, { text: '👩‍💻'.repeat(134), author: developer })).toThrow(/is 402 Unicode/);
    expect(listTaskProgress(t.task_id)).toHaveLength(1 + accepted.length);
  });

  it('keeps longer entries written before the limit readable and does not block new appends', () => {
    const t = task();
    appendTaskProgress(t.task_id, { text: 'seed', author: developer });
    const path = join(tasksDir(), `${t.task_id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const historical = 'h'.repeat(4_000);
    record.progress[0].text = historical;
    writeFileSync(path, JSON.stringify(record));
    expect(listTaskProgress(t.task_id)[0]!.text).toBe(historical);
    expect(taskProgressSnapshot(t.task_id)[0]!.text).toBe(historical);
    appendTaskProgress(t.task_id, { text: 'next', author: developer });
    expect(listTaskProgress(t.task_id).map(entry => entry.text)).toEqual([historical, 'next']);
  });

  it('replays author-scoped retry keys, refuses changed retries and checks replay before the cap', () => {
    const t = task();
    const original = appendTaskProgress(t.task_id, { text: 'Benchmark: 20x on the fixture only', requestKey: 'bench', author: developer });
    expect(appendTaskProgress(t.task_id, { text: 'Benchmark: 20x on the fixture only', requestKey: 'bench', author: developer }))
      .toEqual({ entry: original.entry, replayed: true });
    expect(() => appendTaskProgress(t.task_id, { text: 'different', requestKey: 'bench', author: developer })).toThrow(/different progress entry/);
    // Another author with the same key and text does not inherit the first author's entry.
    const other = appendTaskProgress(t.task_id, { text: 'Benchmark: 20x on the fixture only', requestKey: 'bench', author: critic });
    expect(other.replayed).toBe(false);
    expect(other.entry.author).toEqual(critic);
    for (let index = listTaskProgress(t.task_id).length; index < PROGRESS_MAX_ENTRIES; index++)
      appendTaskProgress(t.task_id, { text: `entry ${index}`, author: operator });
    expect(() => appendTaskProgress(t.task_id, { text: 'one more', author: operator })).toThrow(/limited to 200/);
    expect(appendTaskProgress(t.task_id, { text: 'Benchmark: 20x on the fixture only', requestKey: 'bench', author: developer }).replayed).toBe(true);
    expect(listTaskProgress(t.task_id)).toHaveLength(PROGRESS_MAX_ENTRIES);
  });

  it('keeps every append from concurrent processes', async () => {
    const t = task();
    const module = resolve('dist/rooms-tasks/task-review.js');
    const writers = Array.from({ length: 4 }, (_, writer) => new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { appendTaskProgress } = await import(${JSON.stringify(module)});
        for (let i = 0; i < 15; i++)
          appendTaskProgress(${JSON.stringify(t.task_id)}, { text: 'writer ${writer} entry ' + i, author: { kind: 'agent', role: 'writer-${writer}', surface: 'cli' } });
      `], { env: { ...process.env, OURS_FLEET_HOME: root }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('exit', code => code === 0 ? done() : fail(new Error(stderr)));
    }));
    await Promise.all(writers);
    const progress = listTaskProgress(t.task_id);
    expect(progress).toHaveLength(60);
    expect(new Set(progress.map(entry => entry.id)).size).toBe(60);
    for (let writer = 0; writer < 4; writer++)
      expect(progress.filter(entry => entry.text.startsWith(`writer ${writer} `)).map(entry => entry.text))
        .toEqual(Array.from({ length: 15 }, (_, i) => `writer ${writer} entry ${i}`));
  });

  it('treats records written before this feature as having no progress or review', () => {
    const t = task();
    const path = join(tasksDir(), `${t.task_id}.json`);
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    delete legacy.progress; delete legacy.review; delete legacy.contribution_reads;
    writeFileSync(path, JSON.stringify(legacy));
    expect(listTaskProgress(t.task_id)).toEqual([]);
    expect(getTaskReview(t.task_id)).toBeUndefined();
    expect(taskContributionSummary(getTask(t.task_id))).toEqual({ progress_count: 0, progress_unread: 0, review_unread: false, review: { has_markdown: false, artifact_count: 0, revision: 0 } });
    appendTaskProgress(t.task_id, { text: 'first milestone', author: developer });
    expect(taskContributionSummary(getTask(t.task_id))).toEqual({ progress_count: 1, progress_unread: 1, review_unread: false, review: { has_markdown: false, artifact_count: 0, revision: 0 } });
    expect(getTask(t.task_id).contribution_reads).toEqual({ progress_read: [], review_revision: 0 });
  });
});

describe('task review package', () => {
  it('replaces Markdown with compare-on-write and accepts an identical retry', () => {
    const t = task();
    setTaskReviewMarkdown(t.task_id, { markdown: '## Outcome\n[PR](https://example.test/pr/1)', expectedMarkdown: '', author: developer });
    expect(() => setTaskReviewMarkdown(t.task_id, { markdown: 'lost update', expectedMarkdown: '', author: critic })).toThrow(/changed elsewhere/);
    expect(setTaskReviewMarkdown(t.task_id, { markdown: '## Outcome\n[PR](https://example.test/pr/1)', expectedMarkdown: '', author: developer }).markdown)
      .toBe('## Outcome\n[PR](https://example.test/pr/1)');
    const updated = setTaskReviewMarkdown(t.task_id, { markdown: 'v2', expectedMarkdown: '## Outcome\n[PR](https://example.test/pr/1)', author: critic });
    expect(updated).toMatchObject({ markdown: 'v2', updated_by: critic, artifacts: [] });
    expect(() => setTaskReviewMarkdown(t.task_id, { markdown: 'x'.repeat(50_001), expectedMarkdown: 'v2', author: critic })).toThrow(/maximum/);
  });

  it('retains attached workspace files through review and reload, integrity-checked', async () => {
    const t = task();
    const spec = join(t.workspace!.path, 'docs', 'spec.md');
    mkdirSync(join(t.workspace!.path, 'docs'));
    writeFileSync(spec, '# Spec\n\nDetails');
    const { artifact } = await attachFile(t.task_id, spec);
    expect(artifact).toMatchObject({ name: 'spec.md', mime: 'text/markdown', size: 15, added_by: developer });
    // The workspace copy can change or disappear; the retained bytes do not.
    rmSync(spec);
    activateTask(t.task_id); reviewTask(t.task_id);
    expect(getTask(t.task_id).state).toBe('review');
    const read = await readTaskReviewArtifact(t.task_id, artifact.id);
    expect(read.bytes.toString()).toBe('# Spec\n\nDetails');
    // A fresh process sees the same durable package.
    const output = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { readTaskReviewArtifact } = await import(${JSON.stringify(resolve('dist/rooms-tasks/task-review.js'))});
        const { bytes } = await readTaskReviewArtifact(${JSON.stringify(t.task_id)}, ${JSON.stringify(artifact.id)});
        process.stdout.write(bytes.toString());
      `], { env: { ...process.env, OURS_FLEET_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('exit', code => code === 0 ? done(stdout) : fail(new Error(stderr)));
    });
    expect(output).toBe('# Spec\n\nDetails');
    // Tampered stored bytes are refused rather than served.
    const stored = join(reviewStoreDirectory(t.task_id), `${artifact.id}.data`);
    rmSync(stored); writeFileSync(stored, '# Spec\n\nChanged');
    await expect(readTaskReviewArtifact(t.task_id, artifact.id)).rejects.toThrow(/integrity/);
  });

  it('only reads regular files inside the task workspace', async () => {
    const t = task(), ws = t.workspace!.path;
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'secret');
    const sibling = `${ws}-sibling`;
    mkdirSync(sibling); writeFileSync(join(sibling, 'file.txt'), 'sibling');
    writeFileSync(join(ws, 'ok.txt'), 'ok');
    symlinkSync(outside, join(ws, 'link.txt'));
    mkdirSync(join(ws, 'real')); writeFileSync(join(ws, 'real', 'inner.txt'), 'inner');
    symlinkSync(join(ws, 'real'), join(ws, 'linkdir'));
    symlinkSync(root, join(ws, 'escape'));
    linkSync(join(ws, 'ok.txt'), join(ws, 'hard.txt'));
    mkdirSync(join(ws, 'folder'));
    const refused = async (path: string, message: RegExp) =>
      expect(openTaskWorkspaceFile(getTask(t.task_id), path)).rejects.toThrow(message);
    await refused(outside, /inside the task workspace/);
    await refused(join(sibling, 'file.txt'), /inside the task workspace/);
    await refused(`${ws}/../secret.txt`, /"\.\." components/);
    await refused(`${ws}/real/../ok.txt`, /"\.\." components/);
    await refused(ws, /inside the task workspace/);
    await refused(join(ws, 'link.txt'), /symlink/);
    await refused(join(ws, 'linkdir', 'inner.txt'), /symlinks/);
    await refused(join(ws, 'escape', 'secret.txt'), /symlinks/);
    await refused(join(ws, 'hard.txt'), /hard-linked/);
    await refused(join(ws, 'folder'), /regular files/);
    await refused(join(ws, 'missing.txt'), /not found/);
    // Relative paths resolve from the caller's directory, then must be inside the workspace.
    const relative = await openTaskWorkspaceFile(getTask(t.task_id), 'real/inner.txt', ws);
    await relative.close();
    expect(relative.name).toBe('inner.txt');
    expect(getTaskReview(t.task_id)).toBeUndefined();
  });

  it('replays keyed attach without another stored copy, refuses changed retries and detaches', async () => {
    const t = task(), ws = t.workspace!.path;
    writeFileSync(join(ws, 'report.pdf'), '%PDF-1.4 fixture');
    const first = await attachFile(t.task_id, join(ws, 'report.pdf'), developer, 'report');
    const again = await attachFile(t.task_id, join(ws, 'report.pdf'), developer, 'report');
    expect(again).toEqual({ artifact: first.artifact, replayed: true });
    expect(reviewStoreFiles(t.task_id)).toEqual([`${first.artifact.id}.data`]);
    writeFileSync(join(ws, 'report.pdf'), '%PDF-1.4 changed');
    await expect(attachFile(t.task_id, join(ws, 'report.pdf'), developer, 'report')).rejects.toThrow(/different review file/);
    expect(reviewStoreFiles(t.task_id)).toEqual([`${first.artifact.id}.data`]);
    // The same key from another author is a separate attachment.
    const otherAuthor = await attachFile(t.task_id, join(ws, 'report.pdf'), critic, 'report');
    expect(otherAuthor.replayed).toBe(false);
    expect(getTaskReview(t.task_id)!.artifacts.map(item => item.id)).toEqual([first.artifact.id, otherAuthor.artifact.id]);
    detachTaskReviewArtifact(t.task_id, first.artifact.id, { author: developer });
    expect(reviewStoreFiles(t.task_id)).toEqual([`${otherAuthor.artifact.id}.data`]);
    await expect(readTaskReviewArtifact(t.task_id, first.artifact.id)).rejects.toThrow(/not found/);
    expect(() => detachTaskReviewArtifact(t.task_id, first.artifact.id, { author: developer })).toThrow(/not found/);
    expect((await readTaskReviewArtifact(t.task_id, otherAuthor.artifact.id)).bytes.toString()).toBe('%PDF-1.4 changed');
  });

  it('does not let one task name another task\'s file', async () => {
    const a = task(), b = task();
    writeFileSync(join(a.workspace!.path, 'a.txt'), 'task a');
    const { artifact } = await attachFile(a.task_id, join(a.workspace!.path, 'a.txt'));
    await expect(readTaskReviewArtifact(b.task_id, artifact.id)).rejects.toThrow(/not found/);
    await expect(readTaskReviewArtifact(a.task_id, '../x')).rejects.toThrow(/not found/);
    // A file of another task's workspace is outside this task's workspace.
    await expect(openTaskWorkspaceFile(getTask(b.task_id), join(a.workspace!.path, 'a.txt'))).rejects.toThrow(/inside the task workspace/);
  });

  it('removes retained files with the task and refuses attachments once deletion is accepted', async () => {
    const t = task(), keep = task();
    writeFileSync(join(t.workspace!.path, 'spec.md'), 'spec');
    writeFileSync(join(keep.workspace!.path, 'keep.md'), 'keep');
    await attachFile(t.task_id, join(t.workspace!.path, 'spec.md'));
    await attachFile(keep.task_id, join(keep.workspace!.path, 'keep.md'));
    appendTaskProgress(t.task_id, { text: 'milestone', author: developer });
    const source = await openTaskWorkspaceFile(getTask(t.task_id), join(t.workspace!.path, 'spec.md'));
    await acceptTaskDeletion(t.task_id, operator);
    await expect(attachTaskReviewArtifact(t.task_id, { name: 'spec.md', source, author: developer })).rejects.toThrow(/pending deletion/);
    expect(() => appendTaskProgress(t.task_id, { text: 'late', author: developer })).toThrow(/pending deletion/);
    await settleTaskDeletion({ taskId: t.task_id, cowork: () => ({ closeRoom: async () => {}, deleteRoom: async () => {} }) as any });
    expect(existsSync(reviewStoreDirectory(t.task_id))).toBe(false);
    expect(reviewStoreFiles(keep.task_id)).toHaveLength(1);
  });
});

describe('review file copy safety', () => {
  it('rejects a source changed while it is read and keeps no bytes', async () => {
    const t = task(), path = join(t.workspace!.path, 'big.bin');
    writeFileSync(path, Buffer.alloc(3 * 1024 * 1024, 65));
    const source = await openTaskWorkspaceFile(getTask(t.task_id), path);
    const reader = source.body.getReader();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        // Change the file in place after the first chunk was read.
        if (++chunks === 1) { const fd = openSync(path, 'r+'); writeSync(fd, Buffer.from('B'), 0, 1, 3 * 1024 * 1024 - 1); closeSync(fd); }
        controller.enqueue(next.value);
      },
    });
    await expect(attachTaskReviewArtifact(t.task_id, { name: 'big.bin', source: { ...source, body }, author: developer }))
      .rejects.toThrow(/changed while it was being copied/);
    expect(getTaskReview(t.task_id)).toBeUndefined();
    expect(reviewStoreFiles(t.task_id)).toEqual([]);
    // A change after the last read is caught by the final check too.
    const late = await openTaskWorkspaceFile(getTask(t.task_id), path);
    const lateReader = late.body.getReader();
    const lateBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await lateReader.read();
        if (next.done) { const fd = openSync(path, 'r+'); writeSync(fd, Buffer.from('C'), 0, 1, 0); closeSync(fd); controller.close(); return; }
        controller.enqueue(next.value);
      },
    });
    await expect(attachTaskReviewArtifact(t.task_id, { name: 'big.bin', source: { ...late, body: lateBody }, author: developer }))
      .rejects.toThrow(/changed while it was being copied/);
    expect(reviewStoreFiles(t.task_id)).toEqual([]);
  });

  it('makes the bytes durable and complete before the record references them, and drops them if the commit fails', async () => {
    const t = task();
    writeFileSync(join(t.workspace!.path, 'spec.md'), '# Spec');
    let seen: string[] = [];
    const source = await openTaskWorkspaceFile(getTask(t.task_id), join(t.workspace!.path, 'spec.md'));
    const { artifact } = await attachTaskReviewArtifact(t.task_id, { name: 'spec.md', source, author: developer, beforeCommit: stored => {
      seen = reviewStoreFiles(t.task_id);
      const data = statSync(join(reviewStoreDirectory(t.task_id), `${stored.id}.data`));
      expect(data.mode & 0o777).toBe(0o400);
      expect(data.size).toBe(6);
      expect(getTaskReview(t.task_id)).toBeUndefined();
    } });
    expect(seen).toEqual([`${artifact.id}.data`]);
    const failing = await openTaskWorkspaceFile(getTask(t.task_id), join(t.workspace!.path, 'spec.md'));
    await expect(attachTaskReviewArtifact(t.task_id, { name: 'again.md', source: failing, author: developer, beforeCommit: () => { throw new Error('crash before commit'); } }))
      .rejects.toThrow(/crash before commit/);
    expect(reviewStoreFiles(t.task_id)).toEqual([`${artifact.id}.data`]);
    expect(getTaskReview(t.task_id)!.artifacts).toHaveLength(1);
  });

  it('answers a keyed retry by content without another copy, even when the store is full', async () => {
    const t = task(), ws = t.workspace!.path;
    writeFileSync(join(ws, 'stable.txt'), 'stable');
    const first = await attachFile(t.task_id, join(ws, 'stable.txt'), developer, 'stable');
    // A recent unreferenced reservation fills the quota.
    const fd = openSync(join(reviewStoreDirectory(t.task_id), '00000000-0000-4000-8000-000000000000.part'), 'w', 0o600);
    ftruncateSync(fd, 200 * 1024 * 1024); closeSync(fd);
    writeFileSync(join(ws, 'new.txt'), 'new');
    await expect(attachFile(t.task_id, join(ws, 'new.txt'))).rejects.toThrow(/store is full/);
    expect(await attachFile(t.task_id, join(ws, 'stable.txt'), developer, 'stable')).toEqual({ artifact: first.artifact, replayed: true });
    writeFileSync(join(ws, 'stable.txt'), 'edited');
    await expect(attachFile(t.task_id, join(ws, 'stable.txt'), developer, 'stable')).rejects.toThrow(/different review file/);
    expect(getTaskReview(t.task_id)!.artifacts).toHaveLength(1);
  });

  it('scopes agent retry keys to the identity CID, falling back to the role name only without one', () => {
    const t = task();
    const a = { kind: 'agent', role: 'dev-1', identity_cid: 'A'.repeat(64), surface: 'mcp' } as const;
    const first = appendTaskProgress(t.task_id, { text: 'same', requestKey: 'k', author: a });
    // The same identity through the CLI replays.
    expect(appendTaskProgress(t.task_id, { text: 'same', requestKey: 'k', author: { ...a, surface: 'cli' } })).toEqual({ entry: first.entry, replayed: true });
    // A different identity reusing the role name does not inherit the entry.
    expect(appendTaskProgress(t.task_id, { text: 'same', requestKey: 'k', author: { ...a, identity_cid: 'B'.repeat(64) } }).replayed).toBe(false);
    const noCid = { kind: 'agent', role: 'dev-1', surface: 'cli' } as const;
    const fallback = appendTaskProgress(t.task_id, { text: 'same', requestKey: 'k', author: noCid });
    expect(fallback.replayed).toBe(false);
    expect(appendTaskProgress(t.task_id, { text: 'same', requestKey: 'k', author: noCid })).toEqual({ entry: fallback.entry, replayed: true });
    expect(listTaskProgress(t.task_id)).toHaveLength(3);
  });

  it('does not confirm a keyed retry whose original was detached or whose task is being deleted meanwhile', async () => {
    const t = task(), ws = t.workspace!.path;
    writeFileSync(join(ws, 'stable.txt'), 'stable');
    const first = await attachFile(t.task_id, join(ws, 'stable.txt'), developer, 'stable');
    const retry = await openTaskWorkspaceFile(getTask(t.task_id), join(ws, 'stable.txt'));
    await expect(attachTaskReviewArtifact(t.task_id, { name: 'stable.txt', source: retry, author: developer, requestKey: 'stable',
      beforeReplay: () => { detachTaskReviewArtifact(t.task_id, first.artifact.id, { author: developer }); } })).rejects.toThrow(/removed meanwhile/);
    const second = await attachFile(t.task_id, join(ws, 'stable.txt'), developer, 'stable-2');
    const late = await openTaskWorkspaceFile(getTask(t.task_id), join(ws, 'stable.txt'));
    await expect(attachTaskReviewArtifact(t.task_id, { name: 'stable.txt', source: late, author: developer, requestKey: 'stable-2',
      beforeReplay: () => { beginTaskDeletionIntent(t.task_id, operator); } })).rejects.toThrow(/pending deletion/);
    expect(second.replayed).toBe(false);
  });
});

describe('task lock', () => {
  const module = () => resolve('dist/rooms-tasks/task-review.js');
  /** One writer process; resolves with its exit code. */
  function writer(taskId: string, text: string) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { appendTaskProgress } = await import(${JSON.stringify(module())});
      appendTaskProgress(${JSON.stringify(taskId)}, { text: ${JSON.stringify(text)}, author: { kind: 'local_control', surface: 'cli' } });
    `], { env: { ...process.env, OURS_FLEET_HOME: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise<number>(resolveExit => child.on('exit', code => resolveExit(code ?? -1)));
    return { done, stderr: () => stderr };
  }
  const lockDir = (taskId: string) => join(tasksDir(), '.locks', taskId);
  const settle = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
  // Read the stored record without the task lock, which these tests hold or break on purpose.
  const stored = (taskId: string): string[] =>
    (JSON.parse(readFileSync(join(tasksDir(), `${taskId}.json`), 'utf8')).progress ?? []).map((entry: { text: string }) => entry.text);

  it('waits for a lock directory whose owner file is not yet or no longer present instead of reclaiming it', async () => {
    // This is the state a lock passed through while it was being released, when the
    // previous release deleted its owner file before the directory.
    const t = task();
    mkdirSync(lockDir(t.task_id), { recursive: true });
    const blocked = writer(t.task_id, 'after the ownerless lock');
    await settle(1_000);
    expect(stored(t.task_id)).toEqual([]);
    rmSync(lockDir(t.task_id), { recursive: true, force: true });
    expect(await blocked.done).toBe(0);
    expect(stored(t.task_id)).toEqual(['after the ownerless lock']);
  });

  it('waits for a live foreign owner and reclaims only a dead or long-abandoned one', async () => {
    const t = task(), dir = lockDir(t.task_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ token: 'foreign', pid: process.pid }));
    const blocked = writer(t.task_id, 'after the live owner');
    await settle(1_000);
    expect(stored(t.task_id)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
    expect(await blocked.done).toBe(0);

    // An owner process that has exited no longer holds the lock.
    const exited = spawn(process.execPath, ['-e', '']);
    const deadPid = await new Promise<number>(resolveExit => exited.on('exit', () => resolveExit(exited.pid!)));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ token: 'dead', pid: deadPid }));
    expect(await writer(t.task_id, 'after the dead owner').done).toBe(0);

    // An ownerless directory left for longer than a claim can take is abandoned.
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(dir, old, old);
    expect(await writer(t.task_id, 'after the abandoned lock').done).toBe(0);
    expect(stored(t.task_id)).toEqual(['after the live owner', 'after the dead owner', 'after the abandoned lock']);
    expect(existsSync(dir)).toBe(false);
  });

  it('never reclaims a live claimer paused right after publishing its lock, and keeps both appends when it resumes', async () => {
    const t = task(), lock = lockDir(t.task_id);
    // A stops itself the moment its lock exists (after mkdir or link of the lock path),
    // before anything else, as a descheduled claimer would.
    const pauseAfterClaim = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      for (const name of ['mkdirSync', 'linkSync', 'renameSync']) {
        const original = fs[name];
        fs[name] = function (...args) {
          const result = original.apply(this, args);
          if (args[name === 'mkdirSync' ? 0 : 1] === ${JSON.stringify(lock)}) process.kill(process.pid, 'SIGSTOP');
          return result;
        };
      }
      syncBuiltinESMExports();
    `;
    const paused = spawn(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(pauseAfterClaim)}`, '--input-type=module', '-e', `
      const { appendTaskProgress } = await import(${JSON.stringify(module())});
      appendTaskProgress(${JSON.stringify(t.task_id)}, { text: 'paused claimer', author: { kind: 'local_control', surface: 'cli' } });
    `], { env: { ...process.env, OURS_FLEET_HOME: root }, stdio: ['ignore', 'ignore', 'inherit'] });
    const pausedDone = new Promise<number>(resolveExit => paused.on('exit', code => resolveExit(code ?? -1)));
    try {
      for (let waited = 0; !existsSync(lock); waited += 20) {
        if (waited > 10_000) throw new Error('paused claimer never took the lock');
        await settle(20);
      }
      const blocked = writer(t.task_id, 'second writer');
      let finished = false;
      void blocked.done.then(() => { finished = true; });
      await settle(7_000);
      expect(finished).toBe(false);
      paused.kill('SIGCONT');
      expect(await pausedDone).toBe(0);
      expect(await blocked.done).toBe(0);
      expect(stored(t.task_id)).toEqual(['paused claimer', 'second writer']);
    } finally {
      paused.kill('SIGCONT');
    }
  }, 30_000);

  it('releases without ever exposing a half-removed lock, so heavy contention keeps every append', async () => {
    const t = task();
    const writers = Array.from({ length: 8 }, (_, index) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { appendTaskProgress } = await import(${JSON.stringify(module())});
        for (let i = 0; i < 20; i++)
          appendTaskProgress(${JSON.stringify(t.task_id)}, { text: 'w${index}-' + i, author: { kind: 'local_control', surface: 'cli' } });
      `], { env: { ...process.env, OURS_FLEET_HOME: root }, stdio: ['ignore', 'ignore', 'inherit'] });
      return new Promise<number>(resolveExit => child.on('exit', code => resolveExit(code ?? -1)));
    });
    expect(await Promise.all(writers)).toEqual(Array(8).fill(0));
    expect(stored(t.task_id)).toHaveLength(160);
  }, 60_000);
});

describe('review revision', () => {
  it('changes with every change to the package, including a same-count file replacement', async () => {
    const t = task(), ws = t.workspace!.path;
    expect(taskContributionSummary(getTask(t.task_id)).review.revision).toBe(0);
    writeFileSync(join(ws, 'spec.md'), 'v1');
    const first = await attachFile(t.task_id, join(ws, 'spec.md'));
    const before = taskContributionSummary(getTask(t.task_id)).review;
    detachTaskReviewArtifact(t.task_id, first.artifact.id, { author: critic });
    writeFileSync(join(ws, 'spec.md'), 'v2');
    await attachFile(t.task_id, join(ws, 'spec.md'));
    const after = taskContributionSummary(getTask(t.task_id)).review;
    expect(after.artifact_count).toBe(before.artifact_count);
    expect(after.revision).toBe(before.revision + 2);
    setTaskReviewMarkdown(t.task_id, { markdown: 'x', expectedMarkdown: '', author: developer });
    expect(taskContributionSummary(getTask(t.task_id)).review.revision).toBe(after.revision + 1);
    expect(getTaskReview(t.task_id)!.updated_by).toEqual(developer);
  });
});

describe('review clear', () => {
  const revisionOf = (taskId: string) => taskContributionSummary(getTask(taskId)).review.revision;

  it('removes Markdown and every file in one fenced change that readers see as an update', async () => {
    const t = task(), ws = t.workspace!.path;
    writeFileSync(join(ws, 'a.md'), 'a'); writeFileSync(join(ws, 'b.md'), 'b');
    setTaskReviewMarkdown(t.task_id, { markdown: 'Owner decision: choose A or B', expectedMarkdown: '', author: developer });
    const a = await attachFile(t.task_id, join(ws, 'a.md')), b = await attachFile(t.task_id, join(ws, 'b.md'));
    const revision = revisionOf(t.task_id);
    acknowledgeTaskReview(t.task_id, revision);
    const cleared = clearTaskReview(t.task_id, { expectedRevision: revision, author: critic });
    expect(cleared.removed.map(item => item.id)).toEqual([a.artifact.id, b.artifact.id]);
    expect(getTaskReview(t.task_id)).toMatchObject({ revision: revision + 1, markdown: '', artifacts: [], updated_by: critic });
    expect(reviewStoreFiles(t.task_id)).toEqual([]);
    await expect(readTaskReviewArtifact(t.task_id, a.artifact.id)).rejects.toThrow(/not found/);
    // Existing read and push semantics: a new revision is unread until seen and pushes once.
    expect(taskContributionSummary(getTask(t.task_id))).toMatchObject({ review_unread: true });
    expect(getTask(t.task_id).notification_events!.map(event => event.eventId)).toContain(`task:${t.task_id}:review:${revision + 1}`);
    // The next request writes from the empty package.
    setTaskReviewMarkdown(t.task_id, { markdown: 'Final acceptance', expectedMarkdown: '', author: developer });
    expect(getTaskReview(t.task_id)).toMatchObject({ revision: revision + 2, markdown: 'Final acceptance', artifacts: [] });
  });

  it('refuses a stale revision after any change, including an edit back to the same Markdown, and changes nothing', async () => {
    const t = task(), ws = t.workspace!.path;
    writeFileSync(join(ws, 'a.md'), 'a');
    setTaskReviewMarkdown(t.task_id, { markdown: 'A', expectedMarkdown: '', author: developer });
    const read = revisionOf(t.task_id);
    // Re-sending the stored Markdown is a no-op, so the read revision still fences.
    setTaskReviewMarkdown(t.task_id, { markdown: 'A', expectedMarkdown: 'A', author: developer });
    expect(revisionOf(t.task_id)).toBe(read);
    // An edit that ends at the same Markdown is still a change since the read.
    setTaskReviewMarkdown(t.task_id, { markdown: 'B', expectedMarkdown: 'A', author: critic });
    setTaskReviewMarkdown(t.task_id, { markdown: 'A', expectedMarkdown: 'B', author: critic });
    const path = join(tasksDir(), `${t.task_id}.json`);
    let before = readFileSync(path, 'utf8');
    expect(() => clearTaskReview(t.task_id, { expectedRevision: read, author: developer })).toThrow(/changed elsewhere/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    // A concurrent attach or detach is a change too; its file survives the refused clear.
    const current = revisionOf(t.task_id);
    const attached = await attachFile(t.task_id, join(ws, 'a.md'), critic);
    before = readFileSync(path, 'utf8');
    expect(() => clearTaskReview(t.task_id, { expectedRevision: current, author: developer })).toThrow(/changed elsewhere/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(reviewStoreFiles(t.task_id)).toEqual([`${attached.artifact.id}.data`]);
    const withFile = revisionOf(t.task_id);
    detachTaskReviewArtifact(t.task_id, attached.artifact.id, { author: critic });
    expect(() => clearTaskReview(t.task_id, { expectedRevision: withFile, author: developer })).toThrow(/changed elsewhere/);
    expect(getTaskReview(t.task_id)!.markdown).toBe('A');
    expect(() => clearTaskReview(t.task_id, { expectedRevision: -1, author: developer })).toThrow(/non-negative integer/);
  });

  it('keeps a file whose attach commits after the clear and refuses a stale retry after the next request', async () => {
    const t = task(), ws = t.workspace!.path;
    writeFileSync(join(ws, 'old.md'), 'old'); writeFileSync(join(ws, 'new.md'), 'new');
    const old = await attachFile(t.task_id, join(ws, 'old.md'));
    const read = revisionOf(t.task_id);
    // The new file's bytes are already stored when the clear commits; only the cleared file is removed.
    const source = await openTaskWorkspaceFile(getTask(t.task_id), join(ws, 'new.md'));
    const late = await attachTaskReviewArtifact(t.task_id, { name: 'new.md', source, author: critic, beforeCommit: () => {
      expect(clearTaskReview(t.task_id, { expectedRevision: read, author: developer }).removed.map(item => item.id)).toEqual([old.artifact.id]);
    } });
    expect(getTaskReview(t.task_id)!.artifacts.map(item => item.id)).toEqual([late.artifact.id]);
    expect(reviewStoreFiles(t.task_id)).toEqual([`${late.artifact.id}.data`]);
    expect((await readTaskReviewArtifact(t.task_id, late.artifact.id)).bytes.toString()).toBe('new');
    // Retrying the old clear after the package was written again removes nothing.
    expect(() => clearTaskReview(t.task_id, { expectedRevision: read, author: developer })).toThrow(/changed elsewhere/);
    expect(reviewStoreFiles(t.task_id)).toEqual([`${late.artifact.id}.data`]);
  });

  it('succeeds unchanged on an empty package at its revision and leaves other tasks alone', async () => {
    const t = task(), other = task();
    const path = join(tasksDir(), `${t.task_id}.json`), before = readFileSync(path, 'utf8');
    expect(clearTaskReview(t.task_id, { expectedRevision: 0, author: developer })).toEqual({ review: undefined, removed: [] });
    expect(() => clearTaskReview(t.task_id, { expectedRevision: 1, author: developer })).toThrow(/changed elsewhere/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    writeFileSync(join(other.workspace!.path, 'keep.md'), 'keep');
    await attachFile(other.task_id, join(other.workspace!.path, 'keep.md'));
    setTaskReviewMarkdown(t.task_id, { markdown: 'x', expectedMarkdown: '', author: developer });
    clearTaskReview(t.task_id, { expectedRevision: 1, author: developer });
    expect(clearTaskReview(t.task_id, { expectedRevision: 2, author: developer }).removed).toEqual([]);
    expect(revisionOf(t.task_id)).toBe(2);
    expect(reviewStoreFiles(other.task_id)).toHaveLength(1);
  });
});
