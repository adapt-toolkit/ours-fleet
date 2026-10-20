import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTask, getTask, tasksDir, activateTask, reviewTask } from '../src/rooms-tasks/task-state.js';
import { acceptTaskDeletion, settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import {
  appendTaskProgress, attachTaskReviewArtifact, detachTaskReviewArtifact, getTaskReview, listTaskProgress,
  openTaskWorkspaceFile, readTaskReviewArtifact, reviewStoreDirectory, reviewStoreFiles, setTaskReviewMarkdown,
  taskContributionSummary, PROGRESS_MAX_ENTRIES,
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
    // Lifecycle state and other fields are untouched.
    expect(getTask(t.task_id)).toEqual({ ...t, progress: listed });
  });

  it('rejects empty, oversized and malformed input without writing', () => {
    const t = task();
    expect(() => appendTaskProgress(t.task_id, { text: ' \n\t', author: developer })).toThrow(/required/);
    expect(() => appendTaskProgress(t.task_id, { text: 'x'.repeat(4_001), author: developer })).toThrow(/maximum/);
    expect(() => appendTaskProgress(t.task_id, { text: 'ok', requestKey: 'bad key', author: developer })).toThrow(/request_key/);
    expect(() => appendTaskProgress('../escape', { text: 'ok', author: developer })).toThrow(/invalid task ID/);
    expect(listTaskProgress(t.task_id)).toEqual([]);
    expect(getTask(t.task_id).progress).toBeUndefined();
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
    delete legacy.progress; delete legacy.review;
    writeFileSync(path, JSON.stringify(legacy));
    expect(listTaskProgress(t.task_id)).toEqual([]);
    expect(getTaskReview(t.task_id)).toBeUndefined();
    expect(taskContributionSummary(getTask(t.task_id))).toEqual({ progress_count: 0, review: { has_markdown: false, artifact_count: 0 } });
    appendTaskProgress(t.task_id, { text: 'first milestone', author: developer });
    expect(taskContributionSummary(getTask(t.task_id)).progress_count).toBe(1);
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
    await refused(join(ws, '..', 'secret.txt'), /inside the task workspace/);
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
    detachTaskReviewArtifact(t.task_id, first.artifact.id);
    expect(reviewStoreFiles(t.task_id)).toEqual([`${otherAuthor.artifact.id}.data`]);
    await expect(readTaskReviewArtifact(t.task_id, first.artifact.id)).rejects.toThrow(/not found/);
    expect(() => detachTaskReviewArtifact(t.task_id, first.artifact.id)).toThrow(/not found/);
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
});
