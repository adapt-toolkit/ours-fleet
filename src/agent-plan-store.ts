import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readSync, unlinkSync, writeSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, parse, resolve, sep } from 'node:path';
import {
  decodeAgentPlan, encodeAgentPlan, MAX_AGENT_PLAN_ENVELOPE_BYTES,
  type AgentPlanEnvelope,
} from './agent-plan-codec.js';
import type { AgentPlan } from './agent-plan.js';

export const AGENT_PLAN_STORE_FILENAME = 'agent-plan.json';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PRIVATE_TOKEN = /^[a-f0-9]{8,64}(?:-[a-f0-9]{4,64}){0,7}$/iu;

export type AgentPlanStoreErrorCode =
  | 'invalid_label' | 'unsafe_state_directory' | 'secure_open_unavailable'
  | 'not_found' | 'unsafe_file' | 'read_failed' | 'invalid_plan'
  | 'binding_mismatch' | 'write_failed' | 'publication_conflict' | 'cleanup_failed';

export class AgentPlanStoreError extends Error {
  constructor(readonly code: AgentPlanStoreErrorCode, readonly label: string) {
    super(`agent plan store ${label}: ${code}`);
    this.name = 'AgentPlanStoreError';
  }
}

export interface AgentPlanStoreBindings {
  agentId: string;
  generation: number;
  planDigest: string;
  snapshotDigest: string;
}

export interface AgentPlanStoreDeps {
  randomUUID?(): string;
  lstat?(path: string): BigIntStats;
  open?(path: string, flags: number, mode?: number): number;
  fstat?(fd: number): BigIntStats;
  read?(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  write?(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsync?(fd: number): void;
  close?(fd: number): void;
  link?(existingPath: string, newPath: string): void;
  unlink?(path: string): void;
  /** Deterministic race/fault seams; production callers leave these absent. */
  beforeOpenFinal?(): void;
  beforePublish?(): void;
}

interface Identity { dev: string; ino: string; size: number; mtimeNs: string }

const identity = (stat: BigIntStats): Identity => ({
  dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
  mtimeNs: String(stat.mtimeNs),
});
const same = (left: Identity, right: Identity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs;

function checkedLabel(label: string): string {
  if (!LABEL.test(label)) throw new AgentPlanStoreError('invalid_label', 'invalid');
  return label;
}

function fail(code: AgentPlanStoreErrorCode, label: string): never {
  throw new AgentPlanStoreError(code, label);
}

function sys(deps: AgentPlanStoreDeps) {
  return {
    lstat: deps.lstat ?? ((path: string) => lstatSync(path, { bigint: true })),
    open: deps.open ?? openSync,
    fstat: deps.fstat ?? ((fd: number) => fstatSync(fd, { bigint: true })),
    read: deps.read ?? readSync,
    write: deps.write ?? writeSync,
    fsync: deps.fsync ?? fsyncSync,
    close: deps.close ?? closeSync,
    link: deps.link ?? linkSync,
    unlink: deps.unlink ?? unlinkSync,
  };
}

function assertStateDirectory(stateDir: string, label: string, deps: AgentPlanStoreDeps): string {
  const io = sys(deps);
  const absolute = resolve(stateDir);
  const root = parse(absolute).root;
  let cursor = root;
  try {
    for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      const stat = io.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_state_directory', label);
    }
  } catch (error) {
    if (error instanceof AgentPlanStoreError) throw error;
    fail('unsafe_state_directory', label);
  }
  return absolute;
}

function assertBindings(envelope: Readonly<AgentPlanEnvelope>, expected: AgentPlanStoreBindings, label: string): void {
  if (envelope.agentId !== expected.agentId || envelope.generation !== expected.generation
      || envelope.planDigest !== expected.planDigest
      || envelope.snapshotDigest !== expected.snapshotDigest)
    fail('binding_mismatch', label);
}

function secureRead(
  stateDir: string, expected: AgentPlanStoreBindings, label: string, deps: AgentPlanStoreDeps,
): { bytes: Buffer; envelope: Readonly<AgentPlanEnvelope> } {
  if (typeof constants.O_NOFOLLOW !== 'number') fail('secure_open_unavailable', label);
  const io = sys(deps);
  const dir = assertStateDirectory(stateDir, label, deps);
  const path = join(dir, AGENT_PLAN_STORE_FILENAME);
  let beforePath: BigIntStats;
  try { beforePath = io.lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('not_found', label);
    fail('read_failed', label);
  }
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) fail('unsafe_file', label);
  deps.beforeOpenFinal?.();
  let fd: number;
  try { fd = io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { fail('read_failed', label); }
  try {
    const before = io.fstat(fd);
    if (!before.isFile() || (Number(before.mode) & 0o777) !== 0o600
        || before.size <= 0n || before.size > BigInt(MAX_AGENT_PLAN_ENVELOPE_BYTES))
      fail('unsafe_file', label);
    if (!same(identity(beforePath), identity(before))) fail('unsafe_file', label);
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = io.read(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('read_failed', label);
      offset += count;
    }
    const after = io.fstat(fd);
    let afterPath: BigIntStats;
    try { afterPath = io.lstat(path); } catch { fail('read_failed', label); }
    if (!same(identity(before), identity(after)) || !same(identity(after), identity(afterPath)))
      fail('unsafe_file', label);
    let envelope: Readonly<AgentPlanEnvelope>;
    try { envelope = decodeAgentPlan(bytes); } catch { fail('invalid_plan', label); }
    assertBindings(envelope, expected, label);
    return { bytes, envelope };
  } finally {
    try { io.close(fd); } catch { fail('read_failed', label); }
  }
}

/** Securely read the fixed AgentPlan artifact and verify all caller-pinned bindings. */
export function readStoredAgentPlan(
  stateDir: string, expected: AgentPlanStoreBindings, label = 'agent', deps: AgentPlanStoreDeps = {},
): Readonly<AgentPlanEnvelope> {
  const safeLabel = checkedLabel(label);
  try { return secureRead(stateDir, expected, safeLabel, deps).envelope; }
  catch (error) {
    if (error instanceof AgentPlanStoreError) throw error;
    fail('read_failed', safeLabel);
  }
}

/**
 * Durably publish a write-once AgentPlan. A hard-link is the no-clobber commit:
 * only one contender can create the fixed final name, and no winner is replaced.
 */
export function storeAgentPlan(
  stateDir: string, plan: AgentPlan, expected: AgentPlanStoreBindings,
  label = 'agent', deps: AgentPlanStoreDeps = {},
): Readonly<AgentPlanEnvelope> {
  const safeLabel = checkedLabel(label);
  try { return storeAgentPlanInternal(stateDir, plan, expected, safeLabel, deps); }
  catch (error) {
    if (error instanceof AgentPlanStoreError) throw error;
    fail('write_failed', safeLabel);
  }
}

function storeAgentPlanInternal(
  stateDir: string, plan: AgentPlan, expected: AgentPlanStoreBindings,
  safeLabel: string, deps: AgentPlanStoreDeps,
): Readonly<AgentPlanEnvelope> {
  if (typeof constants.O_NOFOLLOW !== 'number') fail('secure_open_unavailable', safeLabel);
  const io = sys(deps);
  const dir = assertStateDirectory(stateDir, safeLabel, deps);
  const path = join(dir, AGENT_PLAN_STORE_FILENAME);
  let bytes: Buffer;
  try { bytes = encodeAgentPlan(plan); } catch { fail('invalid_plan', safeLabel); }
  let candidate: Readonly<AgentPlanEnvelope>;
  try { candidate = decodeAgentPlan(bytes); } catch { fail('invalid_plan', safeLabel); }
  assertBindings(candidate, expected, safeLabel);
  let token: string;
  try { token = (deps.randomUUID ?? randomUUID)(); }
  catch { fail('write_failed', safeLabel); }
  if (typeof token !== 'string' || !PRIVATE_TOKEN.test(token)) fail('write_failed', safeLabel);
  const temp = join(dir, `.${AGENT_PLAN_STORE_FILENAME}.${token}.tmp`);
  let fd: number | undefined;
  let tempExists = false;
  let published = false;
  try {
    try {
      fd = io.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | constants.O_NOFOLLOW, 0o600);
      tempExists = true;
      const stat = io.fstat(fd);
      if (!stat.isFile() || (Number(stat.mode) & 0o777) !== 0o600) fail('write_failed', safeLabel);
      for (let offset = 0; offset < bytes.length;) {
        const count = io.write(fd, bytes, offset, bytes.length - offset);
        if (count <= 0) fail('write_failed', safeLabel);
        offset += count;
      }
      io.fsync(fd);
      io.close(fd);
      fd = undefined;
    } catch (error) {
      if (error instanceof AgentPlanStoreError) throw error;
      fail('write_failed', safeLabel);
    }
    deps.beforePublish?.();
    assertStateDirectory(dir, safeLabel, deps);
    try { io.link(temp, path); published = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('write_failed', safeLabel);
      const extant = secureRead(dir, expected, safeLabel, deps);
      if (!extant.bytes.equals(bytes)) fail('publication_conflict', safeLabel);
      return extant.envelope;
    }
    try { io.unlink(temp); tempExists = false; }
    catch { fail('cleanup_failed', safeLabel); }
    // Directory fsync is best effort because some supported platforms reject it.
    try {
      const dirFd = io.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { io.fsync(dirFd); } finally { io.close(dirFd); }
    } catch { /* publication is already atomic and the file itself was fsynced */ }
    return secureRead(dir, expected, safeLabel, deps).envelope;
  } finally {
    if (fd !== undefined) { try { io.close(fd); } catch { /* retain primary stable error */ } }
    if (tempExists) {
      try { io.unlink(temp); tempExists = false; }
      catch {
        if (!published) fail('cleanup_failed', safeLabel);
      }
    }
  }
}
