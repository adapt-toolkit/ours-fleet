import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, unlinkSync, writeSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import type { AgentPlan } from './agent-plan.js';
import { decodeAgentPlan, encodeAgentPlan } from './agent-plan-codec.js';
import { readStoredAgentPlan, storeAgentPlan } from './agent-plan-store.js';
import { withConfigGraphLock } from './config-graph-lock.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const CANDIDATE = /^(\d{20})-([a-f0-9]{64})$/u;
const MAX_RECORD = 64 * 1024;
const evidenceBrand: unique symbol = Symbol('VerifiedGenerationReservation');

export type GenerationReservationErrorCode =
  | 'invalid_request' | 'not_found' | 'unsafe_root' | 'unsafe_file' | 'action_conflict'
  | 'generation_conflict' | 'corrupt_state' | 'publication_failed';
export class GenerationReservationError extends Error {
  constructor(readonly code: GenerationReservationErrorCode) {
    super(`agent generation reservation: ${code}`); this.name = 'GenerationReservationError';
  }
}
export interface GenerationReservationRecord {
  schemaVersion: 1; kind: 'AgentGenerationReservation'; actionId: string; agentId: string;
  generation: number; planDigest: string; snapshotDigest: string; canonicalDir: string;
  planBytesDigest: string; reservationDigest: string;
}
export interface VerifiedGenerationReservation {
  readonly [evidenceBrand]: true; readonly actionId: string; readonly agentId: string;
  readonly generation: number; readonly planDigest: string; readonly snapshotDigest: string;
  readonly canonicalDir: string; readonly reservationDigest: string;
}
export interface AgentGenerationEvidenceAuthority {
  authenticate(evidence: VerifiedGenerationReservation): Readonly<GenerationReservationRecord> | undefined;
}
export type ExactGenerationReservationBindings = Readonly<Pick<GenerationReservationRecord,
  'actionId' | 'agentId' | 'generation' | 'planDigest' | 'snapshotDigest' | 'canonicalDir'
  | 'planBytesDigest' | 'reservationDigest'>>;
export interface GenerationReservationFaults {
  afterPlan?(): void; afterReservation?(): void; duringIndex?(): void;
  beforeSecureOpen?(path: string): void;
  write?(fd: number, bytes: Buffer, offset: number, length: number): number;
}

const digest = (bytes: Buffer | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new GenerationReservationError('corrupt_state');
  return `{${Object.keys(value).sort().map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new GenerationReservationError('corrupt_state');
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
};
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const safe = (value: string): string => {
  if (!TOKEN.test(value)) throw new GenerationReservationError('invalid_request');
  return Buffer.from(value).toString('base64url');
};
const pad = (value: number): string => String(value).padStart(20, '0');

function assertNoSymlink(path: string): void {
  const absolute = resolve(path); const root = parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new GenerationReservationError('unsafe_root'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof GenerationReservationError) throw error;
      throw new GenerationReservationError('unsafe_root');
    }
  }
}
function privateDir(path: string): void {
  assertNoSymlink(dirname(path)); mkdirSync(path, { recursive: true, mode: 0o700 }); assertNoSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GenerationReservationError('unsafe_root');
  chmodSync(path, 0o700);
}
function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}
function secureBytes(path: string, max = MAX_RECORD, faults: GenerationReservationFaults = {}): Buffer {
  assertNoSymlink(dirname(path));
  let before;
  try { before = lstatSync(path, { bigint: true }); } catch { throw new GenerationReservationError('corrupt_state'); }
  if (before.isSymbolicLink() || !before.isFile() || (Number(before.mode) & 0o777) !== 0o600
      || before.size < 1n || before.size > BigInt(max)) throw new GenerationReservationError('unsafe_file');
  faults.beforeSecureOpen?.(path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) throw new GenerationReservationError('unsafe_file');
    const bytes = Buffer.alloc(Number(opened.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new GenerationReservationError('corrupt_state'); offset += count;
    }
    const after = fstatSync(fd, { bigint: true }); const afterPath = lstatSync(path, { bigint: true });
    if (!sameStat(opened, after) || !sameStat(after, afterPath)) throw new GenerationReservationError('unsafe_file');
    return bytes;
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ } }
}
function readCanonical(path: string, faults: GenerationReservationFaults = {}): Record<string, unknown> {
  const bytes = secureBytes(path, MAX_RECORD, faults); let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new GenerationReservationError('corrupt_state'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || `${canonical(value)}\n` !== bytes.toString('utf8')) throw new GenerationReservationError('corrupt_state');
  return value as Record<string, unknown>;
}
function fsyncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publish(path: string, bytes: Buffer, faults: GenerationReservationFaults): void {
  privateDir(dirname(path)); const temp = join(dirname(path), `.${randomUUID()}.tmp`); let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (let offset = 0; offset < bytes.length;) {
      const count = faults.write?.(fd, bytes, offset, bytes.length - offset)
        ?? writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new GenerationReservationError('publication_failed'); offset += count;
    }
    fsyncSync(fd); closeSync(fd); fd = undefined; assertNoSymlink(dirname(path));
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!secureBytes(path, MAX_RECORD, faults).equals(bytes)) throw new GenerationReservationError('action_conflict');
    }
    fsyncDir(dirname(path));
  } catch (error) {
    if (error instanceof GenerationReservationError) throw error;
    throw new GenerationReservationError('publication_failed');
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ }
    try { unlinkSync(temp); } catch { /* private non-authoritative temp */ }
  }
}

function parseReservation(path: string, faults: GenerationReservationFaults): GenerationReservationRecord {
  const value = readCanonical(path, faults);
  if (!exact(value, ['schemaVersion', 'kind', 'actionId', 'agentId', 'generation', 'planDigest',
    'snapshotDigest', 'canonicalDir', 'planBytesDigest', 'reservationDigest']))
    throw new GenerationReservationError('corrupt_state');
  const record = value as unknown as GenerationReservationRecord;
  const { reservationDigest, ...unsigned } = record;
  if (record.schemaVersion !== 1 || record.kind !== 'AgentGenerationReservation'
      || !TOKEN.test(record.actionId) || !TOKEN.test(record.agentId)
      || !Number.isSafeInteger(record.generation) || record.generation < 1
      || !SHA.test(record.planDigest) || !SHA.test(record.snapshotDigest)
      || !SHA.test(record.planBytesDigest) || !SHA.test(reservationDigest)
      || digest(canonical(unsigned)) !== reservationDigest)
    throw new GenerationReservationError('corrupt_state');
  return Object.freeze(record);
}

export class DurableAgentGenerationAuthority {
  readonly #root: string; readonly #evidence = new WeakMap<object, GenerationReservationRecord>();
  constructor(trustedRoot: string, private readonly faults: GenerationReservationFaults = {}) {
    this.#root = resolve(trustedRoot); privateDir(this.#root);
  }

  async lookup(agentId: string, actionId: string): Promise<VerifiedGenerationReservation | undefined> {
    if (!TOKEN.test(agentId) || !TOKEN.test(actionId)) throw new GenerationReservationError('invalid_request');
    const agentRoot = join(this.#root, 'agents', safe(agentId));
    try { lstatSync(agentRoot); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;
    }
    return withConfigGraphLock(join(agentRoot, '.allocation'), 'exclusive', () =>
      this.#existingLocked(agentRoot, actionId, false));
  }
  async persist(plan: AgentPlan, actionId: string): Promise<VerifiedGenerationReservation> {
    if (!TOKEN.test(actionId) || !TOKEN.test(plan.agentId) || !Number.isSafeInteger(plan.generation)
        || plan.generation < 1 || !SHA.test(plan.planDigest) || !SHA.test(plan.snapshotDigest))
      throw new GenerationReservationError('invalid_request');
    const agentRoot = join(this.#root, 'agents', safe(plan.agentId));
    const actionRoot = join(agentRoot, 'candidates', safe(actionId));
    const candidate = join(actionRoot, `${pad(plan.generation)}-${plan.planDigest.slice(7)}`);
    for (const path of [agentRoot, actionRoot, candidate, join(agentRoot, 'reservations'), join(agentRoot, 'actions')]) privateDir(path);
    const expected = { agentId: plan.agentId, generation: plan.generation,
      planDigest: plan.planDigest, snapshotDigest: plan.snapshotDigest };
    storeAgentPlan(candidate, plan, expected, 'generation');
    const envelope = readStoredAgentPlan(candidate, expected, 'generation'); const bytes = encodeAgentPlan(envelope.plan);
    this.faults.afterPlan?.();
    return withConfigGraphLock(join(agentRoot, '.allocation'), 'exclusive', () =>
      this.#reserveLocked(agentRoot, actionId, candidate, bytes, expected));
  }
  async resume(agentId: string, actionId: string): Promise<VerifiedGenerationReservation> {
    if (!TOKEN.test(agentId) || !TOKEN.test(actionId)) throw new GenerationReservationError('invalid_request');
    const agentRoot = join(this.#root, 'agents', safe(agentId)); privateDir(agentRoot);
    privateDir(join(agentRoot, 'reservations')); privateDir(join(agentRoot, 'actions'));
    return withConfigGraphLock(join(agentRoot, '.allocation'), 'exclusive', () => {
      const existing = this.#existingLocked(agentRoot, actionId, false); if (existing) return existing;
      const candidates = this.#candidates(agentRoot, agentId, actionId);
      if (!candidates.length) throw new GenerationReservationError('not_found');
      const first = candidates[0]!;
      if (candidates.some(candidate => !candidate.bytes.equals(first.bytes)))
        throw new GenerationReservationError('action_conflict');
      return this.#reserveLocked(agentRoot, actionId, first.dir, first.bytes, first.expected);
    });
  }
  authenticate(evidence: VerifiedGenerationReservation): Readonly<GenerationReservationRecord> | undefined {
    return this.#evidence.get(evidence as object);
  }

  #candidates(agentRoot: string, agentId: string, actionId: string) {
    const actionRoot = join(agentRoot, 'candidates', safe(actionId));
    try { assertNoSymlink(actionRoot); } catch { throw new GenerationReservationError('unsafe_root'); }
    let names: string[]; try { names = readdirSync(actionRoot).filter(name => !name.startsWith('.')); }
    catch { return []; }
    return names.map(name => {
      const match = CANDIDATE.exec(name); if (!match) throw new GenerationReservationError('corrupt_state');
      const generation = Number(match[1]); const planDigest = `sha256:${match[2]}`; const dir = join(actionRoot, name);
      const bytes = secureBytes(join(dir, 'agent-plan.json'), 1024 * 1024, this.faults);
      let envelope; try { envelope = decodeAgentPlan(bytes); } catch { throw new GenerationReservationError('corrupt_state'); }
      if (envelope.agentId !== agentId || envelope.generation !== generation || envelope.planDigest !== planDigest)
        throw new GenerationReservationError('corrupt_state');
      const expected = { agentId, generation, planDigest, snapshotDigest: envelope.snapshotDigest };
      readStoredAgentPlan(dir, expected, 'generation');
      return { dir, bytes, expected };
    });
  }
  #reservations(agentRoot: string): GenerationReservationRecord[] {
    const boundAgentId = Buffer.from(basename(agentRoot), 'base64url').toString('utf8');
    return readdirSync(join(agentRoot, 'reservations')).filter(name => !name.startsWith('.')).map(name => {
      if (!name.endsWith('.json')) throw new GenerationReservationError('corrupt_state');
      const record = parseReservation(join(agentRoot, 'reservations', name), this.faults);
      const expected = join(agentRoot, 'candidates', safe(record.actionId), `${pad(record.generation)}-${record.planDigest.slice(7)}`);
      if (record.agentId !== boundAgentId || resolve(record.canonicalDir) !== resolve(expected)
          || !resolve(record.canonicalDir).startsWith(`${resolve(agentRoot)}${sep}`)
          || name !== `${pad(record.generation)}-${record.reservationDigest.slice(7)}.json`)
        throw new GenerationReservationError('corrupt_state');
      return record;
    });
  }
  #readIndex(agentRoot: string, actionId: string): { agentId: string; reservationDigest: string } | undefined {
    const path = join(agentRoot, 'actions', `${safe(actionId)}.json`);
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new GenerationReservationError('corrupt_state');
    }
    const value = readCanonical(path, this.faults);
    if (!exact(value, ['schemaVersion', 'kind', 'actionId', 'agentId', 'reservationDigest', 'indexDigest'])
        || value.schemaVersion !== 1 || value.kind !== 'AgentGenerationActionIndex'
        || value.actionId !== actionId || typeof value.agentId !== 'string' || !TOKEN.test(value.agentId)
        || typeof value.reservationDigest !== 'string' || !SHA.test(value.reservationDigest)
        || typeof value.indexDigest !== 'string' || !SHA.test(value.indexDigest))
      throw new GenerationReservationError('corrupt_state');
    const { indexDigest, ...unsigned } = value;
    if (digest(canonical(unsigned)) !== indexDigest) throw new GenerationReservationError('corrupt_state');
    return { agentId: value.agentId, reservationDigest: value.reservationDigest };
  }
  #existingLocked(agentRoot: string, actionId: string, required: boolean): VerifiedGenerationReservation | undefined {
    privateDir(join(agentRoot, 'reservations')); privateDir(join(agentRoot, 'actions'));
    const reservations = this.#reservations(agentRoot); const index = this.#readIndex(agentRoot, actionId);
    if (index && !reservations.some(record => record.reservationDigest === index.reservationDigest
      && record.actionId === actionId && record.agentId === index.agentId))
      throw new GenerationReservationError('corrupt_state');
    const found = reservations.filter(record => record.actionId === actionId);
    if (found.length > 1) throw new GenerationReservationError('corrupt_state');
    if (!found[0]) {
      if (index) throw new GenerationReservationError('corrupt_state');
      if (required) throw new GenerationReservationError('not_found');
      return undefined;
    }
    this.#verifyPlan(found[0]); this.#repairIndex(agentRoot, found[0]); return this.#issue(found[0]);
  }
  #reserveLocked(agentRoot: string, actionId: string, candidate: string, planBytes: Buffer,
    expected: { agentId: string; generation: number; planDigest: string; snapshotDigest: string }): VerifiedGenerationReservation {
    const extant = this.#existingLocked(agentRoot, actionId, false); if (extant) return extant;
    const candidates = this.#candidates(agentRoot, expected.agentId, actionId);
    if (candidates.some(value => !value.bytes.equals(planBytes))) throw new GenerationReservationError('action_conflict');
    const reservations = this.#reservations(agentRoot);
    if (expected.generation !== reservations.reduce((max, record) => Math.max(max, record.generation), 0) + 1)
      throw new GenerationReservationError('generation_conflict');
    const unsigned = { schemaVersion: 1 as const, kind: 'AgentGenerationReservation' as const,
      actionId, ...expected, canonicalDir: candidate, planBytesDigest: digest(planBytes) };
    const record: GenerationReservationRecord = { ...unsigned, reservationDigest: digest(canonical(unsigned)) };
    publish(join(agentRoot, 'reservations', `${pad(record.generation)}-${record.reservationDigest.slice(7)}.json`),
      Buffer.from(`${canonical(record)}\n`), this.faults);
    this.faults.afterReservation?.(); this.#repairIndex(agentRoot, record); return this.#issue(record);
  }
  #repairIndex(agentRoot: string, record: GenerationReservationRecord): void {
    this.faults.duringIndex?.();
    const unsigned = { schemaVersion: 1, kind: 'AgentGenerationActionIndex', actionId: record.actionId,
      agentId: record.agentId, reservationDigest: record.reservationDigest };
    const value = { ...unsigned, indexDigest: digest(canonical(unsigned)) };
    publish(join(agentRoot, 'actions', `${safe(record.actionId)}.json`), Buffer.from(`${canonical(value)}\n`), this.faults);
  }
  #verifyPlan(record: GenerationReservationRecord): void {
    const envelope = readStoredAgentPlan(record.canonicalDir, record, 'generation');
    if (digest(encodeAgentPlan(envelope.plan)) !== record.planBytesDigest) throw new GenerationReservationError('corrupt_state');
  }
  #issue(record: GenerationReservationRecord): VerifiedGenerationReservation {
    const evidence = Object.freeze({ [evidenceBrand]: true as const, actionId: record.actionId,
      agentId: record.agentId, generation: record.generation, planDigest: record.planDigest,
      snapshotDigest: record.snapshotDigest, canonicalDir: record.canonicalDir,
      reservationDigest: record.reservationDigest });
    this.#evidence.set(evidence, record); return evidence;
  }
}

/** Strictly read-only reconstruction for a supervisor. It never creates locks, directories, or indexes. */
export class DurableAgentGenerationReader implements AgentGenerationEvidenceAuthority {
  readonly #root: string;
  readonly #evidence = new WeakMap<object, GenerationReservationRecord>();
  constructor(trustedRoot: string, private readonly faults: GenerationReservationFaults = {}) {
    this.#root = resolve(trustedRoot);
  }

  readExact(expected: ExactGenerationReservationBindings): VerifiedGenerationReservation {
    if (!TOKEN.test(expected.agentId) || !TOKEN.test(expected.actionId)
        || !Number.isSafeInteger(expected.generation) || expected.generation < 1
        || ![expected.planDigest, expected.snapshotDigest, expected.planBytesDigest,
          expected.reservationDigest].every(value => SHA.test(value)))
      throw new GenerationReservationError('invalid_request');
    const agentRoot = join(this.#root, 'agents', safe(expected.agentId));
    assertNoSymlink(agentRoot);
    const index = this.#readIndex(agentRoot, expected.actionId);
    if (index.agentId !== expected.agentId || index.reservationDigest !== expected.reservationDigest)
      throw new GenerationReservationError('corrupt_state');
    const path = join(agentRoot, 'reservations',
      `${pad(expected.generation)}-${expected.reservationDigest.slice(7)}.json`);
    const record = parseReservation(path, this.faults);
    for (const key of ['actionId', 'agentId', 'generation', 'planDigest', 'snapshotDigest',
      'canonicalDir', 'planBytesDigest', 'reservationDigest'] as const)
      if (record[key] !== expected[key]) throw new GenerationReservationError('corrupt_state');
    const canonicalDir = join(agentRoot, 'candidates', safe(expected.actionId),
      `${pad(expected.generation)}-${expected.planDigest.slice(7)}`);
    if (resolve(record.canonicalDir) !== resolve(canonicalDir)
        || !resolve(record.canonicalDir).startsWith(`${resolve(agentRoot)}${sep}`))
      throw new GenerationReservationError('corrupt_state');
    const envelope = readStoredAgentPlan(record.canonicalDir, record, 'generation-reader');
    if (digest(encodeAgentPlan(envelope.plan)) !== record.planBytesDigest)
      throw new GenerationReservationError('corrupt_state');
    const evidence = Object.freeze({ [evidenceBrand]: true as const, actionId: record.actionId,
      agentId: record.agentId, generation: record.generation, planDigest: record.planDigest,
      snapshotDigest: record.snapshotDigest, canonicalDir: record.canonicalDir,
      reservationDigest: record.reservationDigest });
    this.#evidence.set(evidence, record);
    return evidence;
  }

  authenticate(evidence: VerifiedGenerationReservation): Readonly<GenerationReservationRecord> | undefined {
    return this.#evidence.get(evidence as object);
  }

  #readIndex(agentRoot: string, actionId: string): { agentId: string; reservationDigest: string } {
    const value = readCanonical(join(agentRoot, 'actions', `${safe(actionId)}.json`), this.faults);
    if (!exact(value, ['schemaVersion', 'kind', 'actionId', 'agentId', 'reservationDigest', 'indexDigest'])
        || value.schemaVersion !== 1 || value.kind !== 'AgentGenerationActionIndex'
        || value.actionId !== actionId || typeof value.agentId !== 'string' || !TOKEN.test(value.agentId)
        || typeof value.reservationDigest !== 'string' || !SHA.test(value.reservationDigest)
        || typeof value.indexDigest !== 'string' || !SHA.test(value.indexDigest))
      throw new GenerationReservationError('corrupt_state');
    const { indexDigest, ...unsigned } = value;
    if (digest(canonical(unsigned)) !== indexDigest) throw new GenerationReservationError('corrupt_state');
    return { agentId: value.agentId, reservationDigest: value.reservationDigest };
  }
}
