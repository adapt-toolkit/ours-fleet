/**
 * Task Progress (append-only milestone log) and To review (self-contained
 * review package: Markdown plus retained files).
 *
 * Entries and review metadata live in the task record and change only under
 * the task lock. Review file bytes live in Fleet's private per-task store,
 * outside the agent-writable workspace, and are removed with the task.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stateRoot } from '../paths.js';
import { MAX_FILE_BYTES, openDirectory } from '../file-delivery/reader.js';
import { contributionUnread, getTask, reviewRevision, TaskStateError, updateTaskContribution } from './task-state.js';
import { assertWorkspacePresent } from './workspace.js';
import type {
  TaskContributionAuthor, TaskProgressEntry, TaskRecord, TaskReview, TaskReviewArtifact,
} from './types.js';

export const PROGRESS_TEXT_MAX = 4_000;
export const PROGRESS_MAX_ENTRIES = 200;
export const REVIEW_MARKDOWN_MAX = 50_000;
export const REVIEW_MAX_ARTIFACTS = 20;
export const REVIEW_ARTIFACT_MAX_BYTES = MAX_FILE_BYTES;
/** Stored bytes per task, including copies not yet referenced. */
const REVIEW_STORE_MAX_BYTES = 200 * 1024 * 1024;
const REVIEW_STORE_MAX_FILES = 40;
/** An unreferenced copy older than this belongs to a failed or abandoned attach. */
const ORPHAN_AGE_MS = 10 * 60 * 1000;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TASK_ID = /^[0-9a-z]{9}[0-9a-f]{8}$/;
const ARTIFACT_ID = /^[a-f0-9-]{36}$/;

/** Types a browser can open safely from a blob; everything else is download-only. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
  '.json': 'application/json', '.csv': 'text/csv', '.diff': 'text/x-diff', '.patch': 'text/x-diff',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.html': 'text/html', '.svg': 'image/svg+xml',
};

export class TaskReviewError extends Error {
  constructor(readonly code: 'invalid_request' | 'idempotency_conflict' | 'limit_exceeded' | 'conflict' | 'not_found', message: string) {
    super(message);
  }
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw new TaskStateError('invalid task ID: expected the canonical 17-character lowercase ID');
}

/**
 * Retry keys are scoped to the author: an agent by its authenticated identity
 * CID (stable across MCP and CLI), or by role name when no CID is known; the
 * local operator by surface.
 */
function authorKey(author: TaskContributionAuthor): string {
  if (author.kind !== 'agent') return `local_control:${author.surface}`;
  return author.identity_cid ? `agent-cid:${author.identity_cid}` : `agent:${author.role}`;
}

function checkRequestKey(requestKey: string | undefined): void {
  if (requestKey !== undefined && !REQUEST_KEY.test(requestKey))
    throw new TaskReviewError('invalid_request', 'request_key must be 1-128 characters of letters, digits, ".", "_", ":" or "-"');
}

export function reviewArtifactMime(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function checkArtifactName(name: string): string {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 240 || /[/\\\x00-\x1f\x7f]/.test(name)
      || name === '.' || name === '..' || name.trim() !== name)
    throw new TaskReviewError('invalid_request', 'file name must be 1-240 bytes without slashes, control characters or surrounding spaces');
  return name;
}

// ── Progress ───────────────────────────────────────────────────────────

export function listTaskProgress(taskId: string): TaskProgressEntry[] {
  assertTaskId(taskId);
  return getTask(taskId).progress ?? [];
}

/** Browser snapshot: entry bodies and their saved read state come from one task record. */
export function taskProgressSnapshot(taskId: string): Array<Omit<TaskProgressEntry, 'request_key'> & { unread: boolean }> {
  assertTaskId(taskId);
  const task = getTask(taskId);
  const reads = task.contribution_reads;
  const seen = new Set(reads?.progress_read);
  return (task.progress ?? []).map(entry => ({
    ...publicProgressEntry(entry), unread: !!reads && !seen.has(entry.id),
  }));
}

/**
 * Append one milestone. Text is kept exactly as written; whitespace-only text is
 * rejected. A retry with the same author-scoped request_key returns the original
 * entry; the same key with different text is a conflict.
 */
export function appendTaskProgress(taskId: string, input: {
  text: string; author: TaskContributionAuthor; requestKey?: string;
}): { entry: TaskProgressEntry; replayed: boolean } {
  assertTaskId(taskId);
  if (typeof input.text !== 'string' || !input.text.trim())
    throw new TaskReviewError('invalid_request', 'progress text is required');
  if (input.text.length > PROGRESS_TEXT_MAX)
    throw new TaskReviewError('invalid_request', `progress text maximum is ${PROGRESS_TEXT_MAX} characters`);
  checkRequestKey(input.requestKey);
  return updateTaskContribution<{ entry: TaskProgressEntry; replayed: boolean }>(taskId, task => {
    const progress = task.progress ?? [];
    if (input.requestKey) {
      const previous = progress.find(entry => entry.request_key === input.requestKey
        && sameAuthor(entry.author, input.author));
      if (previous) {
        if (previous.text !== input.text)
          throw new TaskReviewError('idempotency_conflict', 'request_key was already used for a different progress entry');
        return { value: { entry: previous, replayed: true }, changed: false };
      }
    }
    if (progress.length >= PROGRESS_MAX_ENTRIES)
      throw new TaskReviewError('limit_exceeded', `task progress is limited to ${PROGRESS_MAX_ENTRIES} entries`);
    const entry: TaskProgressEntry = {
      id: randomUUID(), at: new Date().toISOString(), author: input.author, text: input.text,
      ...(input.requestKey ? { request_key: input.requestKey } : {}),
    };
    task.progress = [...progress, entry];
    return { value: { entry, replayed: false }, changed: true };
  });
}

// ── Review Markdown ────────────────────────────────────────────────────

/** Every change to the package gets the next revision, so readers can tell any two states apart. */
function nextRevision(review: TaskReview | undefined): number {
  return reviewRevision(review) + 1;
}

export function getTaskReview(taskId: string): TaskReview | undefined {
  assertTaskId(taskId);
  return getTask(taskId).review;
}

/**
 * Replace the review Markdown. `expectedMarkdown` is what the writer last read
 * ('' when none); a different current value is a stale edit. Re-sending the
 * value already stored succeeds, so retries are safe.
 */
export function setTaskReviewMarkdown(taskId: string, input: {
  markdown: string; expectedMarkdown: string; author: TaskContributionAuthor;
}): TaskReview {
  assertTaskId(taskId);
  if (typeof input.markdown !== 'string' || typeof input.expectedMarkdown !== 'string')
    throw new TaskReviewError('invalid_request', 'markdown and expected markdown must be strings');
  if (input.markdown.length > REVIEW_MARKDOWN_MAX)
    throw new TaskReviewError('invalid_request', `review markdown maximum is ${REVIEW_MARKDOWN_MAX} characters`);
  return updateTaskContribution(taskId, task => {
    const current = task.review?.markdown ?? '';
    if (current === input.markdown && task.review) return { value: task.review, changed: false };
    if (current !== input.expectedMarkdown)
      throw new TaskReviewError('conflict', 'The review package changed elsewhere. Read it again before replacing it.');
    task.review = {
      revision: nextRevision(task.review), markdown: input.markdown, updated_at: new Date().toISOString(),
      updated_by: input.author, artifacts: task.review?.artifacts ?? [],
    };
    return { value: task.review, changed: true };
  });
}

// ── Review artifact store ──────────────────────────────────────────────

export const reviewStoreRoot = () => join(stateRoot(), 'task-review-artifacts');
export function reviewStoreDirectory(taskId: string): string {
  assertTaskId(taskId);
  return join(reviewStoreRoot(), taskId);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new TaskReviewError('conflict', 'task review store is not a private directory');
}

/** Remove copies no record references once they are old enough to be abandoned. */
function sweepOrphans(dir: string, referenced: ReadonlySet<string>, now = Date.now()): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  for (const name of readdirSync(dir)) {
    const match = /^([a-f0-9-]{36})\.(data|part)$/.exec(name);
    const path = join(dir, name), stat = lstatSync(path);
    if (match && !referenced.has(match[1]!) && now - stat.mtimeMs > ORPHAN_AGE_MS && stat.isFile()) {
      unlinkSync(path); continue;
    }
    files++; bytes += stat.size;
  }
  return { files, bytes };
}

/** A file being read; `verify` fails when it changed since it was opened. */
export type Source = { size: number; body: ReadableStream<Uint8Array>; close(): Promise<void>; verify?(): Promise<void> };
type Stored = { id: string; size: number; sha256: string };

const changed = () => new TaskReviewError('conflict', 'the file changed while it was being copied');

/** Read the whole source once, bounded by its declared size, then confirm it did not change. */
async function consume(source: Source, signal: AbortSignal | undefined, sink: (chunk: Uint8Array, offset: number) => void): Promise<{ size: number; sha256: string }> {
  const reader = source.body.getReader();
  try {
    const hash = createHash('sha256'); let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.length > source.size) throw changed();
      hash.update(chunk.value); sink(chunk.value, size);
      size += chunk.value.length;
    }
    if (size !== source.size) throw changed();
    await source.verify?.();
    return { size, sha256: hash.digest('hex') };
  } finally {
    await reader.cancel().catch(() => {});
    await source.close();
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

interface Reservation { id: string; fd: number; dir: number }
const inDir = (dir: number, name: string) => `/proc/self/fd/${dir}/${name}`;

/**
 * Admit one copy under the task lock: the task exists and is not being
 * deleted, the quota holds, and the reservation is made at once by creating
 * the partial file at its declared size in the pinned store directory. A
 * deletion accepted later removes the whole store; this copy then only writes
 * into an unlinked directory and its commit is refused.
 */
function reserveCopy(taskId: string, dir: string, size: number): Reservation {
  return updateTaskContribution(taskId, task => {
    privateDirectory(reviewStoreRoot()); privateDirectory(dir);
    const pinned = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(pinned), named = lstatSync(dir);
      if (opened.dev !== named.dev || opened.ino !== named.ino) throw new TaskReviewError('conflict', 'task review store moved');
      const used = sweepOrphans(inDir(pinned, ''), new Set((task.review?.artifacts ?? []).map(artifact => artifact.id)));
      if (used.files >= REVIEW_STORE_MAX_FILES || used.bytes + size > REVIEW_STORE_MAX_BYTES)
        throw new TaskReviewError('limit_exceeded', 'the task review store is full; detach files you no longer need');
      const id = randomUUID();
      const fd = openSync(inDir(pinned, `${id}.part`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { ftruncateSync(fd, size); } catch (error) { closeSync(fd); unlinkSync(inDir(pinned, `${id}.part`)); throw error; }
      return { value: { id, fd, dir: pinned }, changed: false };
    } catch (error) { closeSync(pinned); throw error; }
  });
}

/**
 * Copy into the pinned store, then make the bytes durable before any record
 * can reference them: file fsync, rename, then fsync of the store directory
 * and of the directories that may have been created for it.
 */
async function copyIntoStore(taskId: string, dir: string, source: Source, signal?: AbortSignal): Promise<Stored> {
  let reservation: Reservation | undefined;
  try {
    reservation = reserveCopy(taskId, dir, source.size);
    const target = reservation;
    const digest = await consume(source, signal, (chunk, at) => {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(target.fd, chunk, offset, chunk.length - offset, at + offset);
        if (!written) throw new Error('short review artifact write');
        offset += written;
      }
    });
    fchmodSync(target.fd, 0o400); fsyncSync(target.fd);
    renameSync(inDir(target.dir, `${target.id}.part`), inDir(target.dir, `${target.id}.data`));
    fsyncSync(target.dir);
    syncDirectory(reviewStoreRoot()); syncDirectory(stateRoot());
    return { id: target.id, ...digest };
  } catch (error) {
    if (reservation) {
      for (const name of [`${reservation.id}.part`, `${reservation.id}.data`])
        try { unlinkSync(inDir(reservation.dir, name)); } catch { /* absent, or removed with the store */ }
    }
    throw error;
  } finally {
    if (reservation) { closeSync(reservation.fd); closeSync(reservation.dir); }
    else await source.close();
  }
}

function removeStoredFile(dir: string, id: string): void {
  try { unlinkSync(join(dir, `${id}.data`)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameAuthor(a: TaskContributionAuthor, b: TaskContributionAuthor): boolean {
  return authorKey(a) === authorKey(b);
}

/**
 * Attach one file to the review package: reserve under the task lock, copy
 * into the private store, then commit metadata under the lock again; any
 * failure removes the copy. A retry with the same author-scoped request_key
 * is compared by content without storing another copy: identical content
 * returns the original artifact, different content is a conflict. Without a
 * key an interrupted call may or may not have attached: read the package
 * before retrying.
 */
export async function attachTaskReviewArtifact(taskId: string, input: {
  name: string; source: Source; author: TaskContributionAuthor; requestKey?: string; signal?: AbortSignal;
  /** Test seam: runs after the bytes are durable, before the record references them. */
  beforeCommit?(stored: Stored): void;
  /** Test seam: runs after a keyed retry was read, before it is confirmed under the lock. */
  beforeReplay?(): void;
}): Promise<{ artifact: TaskReviewArtifact; replayed: boolean }> {
  let dir: string, name: string, previous: TaskReviewArtifact | undefined;
  try {
    dir = reviewStoreDirectory(taskId);
    name = checkArtifactName(input.name);
    checkRequestKey(input.requestKey);
    if (!Number.isSafeInteger(input.source.size) || input.source.size < 0 || input.source.size > REVIEW_ARTIFACT_MAX_BYTES)
      throw new TaskReviewError('limit_exceeded', 'review files are limited to 20 MiB');
    previous = input.requestKey ? getTask(taskId).review?.artifacts.find(artifact =>
      artifact.request_key === input.requestKey && sameAuthor(artifact.added_by, input.author)) : undefined;
  } catch (error) { await input.source.close(); throw error; }
  const replay = (artifact: TaskReviewArtifact, digest: { sha256: string }) => {
    if (artifact.name !== name || artifact.sha256 !== digest.sha256)
      throw new TaskReviewError('idempotency_conflict', 'request_key was already used for a different review file');
    return { artifact, replayed: true };
  };
  if (previous) {
    const digest = await consume(input.source, input.signal, () => {});
    input.beforeReplay?.();
    // Confirm under the lock that the original is still part of the package and the task still accepts writes.
    return updateTaskContribution(taskId, task => {
      const current = task.review?.artifacts.find(artifact =>
        artifact.request_key === input.requestKey && sameAuthor(artifact.added_by, input.author));
      if (!current) throw new TaskReviewError('not_found', 'the file attached with this request_key was removed meanwhile; attach it again with a new key');
      return { value: replay(current, digest), changed: false };
    });
  }
  const stored = await copyIntoStore(taskId, dir, input.source, input.signal);
  try {
    input.beforeCommit?.(stored);
    const result = updateTaskContribution<{ artifact: TaskReviewArtifact; replayed: boolean }>(taskId, task => {
      const review = task.review ?? { markdown: '', updated_at: new Date().toISOString(), updated_by: input.author, artifacts: [] };
      // A concurrent attach with the same key may have committed meanwhile.
      const raced = input.requestKey ? review.artifacts.find(artifact =>
        artifact.request_key === input.requestKey && sameAuthor(artifact.added_by, input.author)) : undefined;
      if (raced) return { value: replay(raced, stored), changed: false };
      if (review.artifacts.length >= REVIEW_MAX_ARTIFACTS)
        throw new TaskReviewError('limit_exceeded', `a review package holds at most ${REVIEW_MAX_ARTIFACTS} files`);
      const artifact: TaskReviewArtifact = {
        id: stored.id, name, mime: reviewArtifactMime(name), size: stored.size, sha256: stored.sha256,
        added_at: new Date().toISOString(), added_by: input.author,
        ...(input.requestKey ? { request_key: input.requestKey } : {}),
      };
      task.review = { ...review, revision: nextRevision(task.review), updated_at: artifact.added_at,
        updated_by: input.author, artifacts: [...review.artifacts, artifact] };
      return { value: { artifact, replayed: false }, changed: true };
    });
    if (result.replayed) removeStoredFile(dir, stored.id);
    return result;
  } catch (error) {
    try { removeStoredFile(dir, stored.id); } catch { /* the sweep removes it later */ }
    throw error;
  }
}

/** Remove a file from the package; repeating it after success reports not found. */
export function detachTaskReviewArtifact(taskId: string, artifactId: string, input: { author: TaskContributionAuthor }): TaskReviewArtifact {
  const dir = reviewStoreDirectory(taskId);
  const removed = updateTaskContribution(taskId, task => {
    const artifact = task.review?.artifacts.find(item => item.id === artifactId);
    if (!artifact || !task.review) throw new TaskReviewError('not_found', 'review file not found');
    task.review = { ...task.review, revision: nextRevision(task.review), updated_at: new Date().toISOString(),
      updated_by: input.author, artifacts: task.review.artifacts.filter(item => item.id !== artifactId) };
    return { value: artifact, changed: true };
  });
  try { removeStoredFile(dir, removed.id); } catch { /* an unreferenced copy is swept later */ }
  return removed;
}

/** Bytes of a referenced artifact, integrity-checked; only the owning task can name it. */
export async function readTaskReviewArtifact(taskId: string, artifactId: string): Promise<{ artifact: TaskReviewArtifact; bytes: Buffer }> {
  assertTaskId(taskId);
  if (!ARTIFACT_ID.test(artifactId)) throw new TaskReviewError('not_found', 'review file not found');
  const artifact = getTask(taskId).review?.artifacts.find(item => item.id === artifactId);
  if (!artifact) throw new TaskReviewError('not_found', 'review file not found');
  const root = await openDirectory(reviewStoreDirectory(taskId)).catch(() => {
    throw new TaskReviewError('not_found', 'review file is no longer stored');
  });
  try {
    let fd: number;
    try { fd = openSync(`/proc/self/fd/${root.fd}/${artifact.id}.data`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new TaskReviewError('not_found', 'review file is no longer stored'); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size !== artifact.size)
        throw new TaskReviewError('conflict', 'stored review file failed its integrity check');
      const bytes = readFileSync(fd);
      if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new TaskReviewError('conflict', 'stored review file failed its integrity check');
      return { artifact, bytes };
    } finally { closeSync(fd); }
  } finally { await root.close(); }
}

/** Task deletion: remove every retained review file of the task. */
export function deleteTaskReviewStore(taskId: string): void {
  const dir = reviewStoreDirectory(taskId);
  let stat;
  try { stat = lstatSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe task review store ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── Sources ────────────────────────────────────────────────────────────

/** True when `path` names an entry strictly inside `root`, compared by path components. */
export function insideDirectory(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** The task's owned workspace, validated against its ownership marker. */
export function taskWorkspaceRoot(task: TaskRecord): string {
  if (!task.workspace) throw new TaskReviewError('invalid_request', `task ${task.task_id} has no owned workspace`);
  assertWorkspacePresent(task.workspace, 'task', task.task_id);
  return task.workspace.path;
}

/** Identity and change times of an opened file; any difference means it changed or was replaced. */
async function fingerprint(file: FileHandle): Promise<string> {
  const stat = await file.stat({ bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}

async function fileStream(file: FileHandle, size: number): Promise<Source> {
  const opened = await fingerprint(file);
  const verify = async () => { if (await fingerprint(file) !== opened) throw changed(); };
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await file.close(); } };
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await verify();
      const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size - position + 1)));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) { controller.close(); return; }
      position += bytesRead;
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
  });
  return { size, body, close, verify };
}

/**
 * Open a file inside the task workspace in this process's own OS context (the
 * CLI). Every component below the pinned workspace is opened without
 * following symlinks; the file must be one regular, singly-linked file.
 */
export async function openTaskWorkspaceFile(task: TaskRecord, input: string, cwd = process.cwd()): Promise<Source & { name: string }> {
  const root = taskWorkspaceRoot(task);
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f]/.test(input))
    throw new TaskReviewError('invalid_request', 'invalid file path');
  if (input.split(/[\\/]/).includes('..'))
    throw new TaskReviewError('invalid_request', 'the file path must not contain ".." components');
  const absolute = resolve(cwd, input);
  if (!insideDirectory(root, absolute))
    throw new TaskReviewError('invalid_request', `review files must be inside the task workspace ${root}`);
  const parts = relative(root, absolute).split(sep);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let dir = await openDirectory(root);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, flags | constants.O_DIRECTORY).catch(() => {
        throw new TaskReviewError('invalid_request', 'the file path must not pass through symlinks or missing directories');
      });
      await dir.close(); dir = next;
    }
    const file = await open(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`, flags).catch((error: NodeJS.ErrnoException) => {
      throw new TaskReviewError('invalid_request', error.code === 'ELOOP' ? 'the file must not be a symlink' : 'file not found or not readable');
    });
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new TaskReviewError('invalid_request', 'only regular files can be attached');
      if (stat.nlink !== 1) throw new TaskReviewError('invalid_request', 'hard-linked files cannot be attached');
      if (stat.size > REVIEW_ARTIFACT_MAX_BYTES) throw new TaskReviewError('limit_exceeded', 'review files are limited to 20 MiB');
      return { ...await fileStream(file, stat.size), name: basename(absolute) };
    } catch (error) { await file.close(); throw error; }
  } finally { await dir.close(); }
}

/** Size of the store, for diagnostics and tests. */
export function reviewStoreFiles(taskId: string): string[] {
  try { return readdirSync(reviewStoreDirectory(taskId)).sort(); } catch { return []; }
}

/** Wire shapes: retry keys stay internal. */
export function publicProgressEntry(entry: TaskProgressEntry): Omit<TaskProgressEntry, 'request_key'> {
  const { request_key: _key, ...rest } = entry;
  return rest;
}
export function publicReview(review: TaskReview): TaskReview {
  return { ...review, revision: reviewRevision(review), artifacts: review.artifacts.map(({ request_key: _key, ...rest }) => rest) };
}

/** Compact summary for list and detail payloads; bodies are fetched separately. */
export function taskContributionSummary(task: TaskRecord): {
  progress_count: number; progress_unread: number; review_unread: boolean;
  review: { has_markdown: boolean; artifact_count: number; revision: number; updated_at?: string };
} {
  const unread = contributionUnread(task);
  return {
    progress_count: task.progress?.length ?? 0,
    progress_unread: unread.progress,
    review_unread: unread.review,
    review: {
      has_markdown: !!task.review?.markdown.trim(),
      artifact_count: task.review?.artifacts.length ?? 0,
      revision: reviewRevision(task.review),
      ...(task.review ? { updated_at: task.review.updated_at } : {}),
    },
  };
}

