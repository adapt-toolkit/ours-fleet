import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import type { AgentCreationCompletionAuthority, VerifiedCompleteAgentCreation } from './agent-creation-transaction.js';
import { readStoredAgentPlan } from './agent-plan-store.js';
import { encodeAgentPlan } from './agent-plan-codec.js';
import { readAgentStartLocator, type AgentStartLocatorExpectedBindings } from './agent-start-locator.js';
import { withConfigGraphLock } from './config-graph-lock.js';

export const AGENT_SUPERVISOR_HANDOFF_FILENAME = 'active.json';
const SHA = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const KEYS = ['schemaVersion', 'kind', 'agentId', 'actionId', 'generation', 'planDigest',
  'snapshotDigest', 'reservationDigest', 'authorizationRevision', 'lifetime',
  'identityEvidenceDigest', 'locatorDigest', 'canonicalDir', 'planBytesDigest', 'handoffDigest'] as const;

export interface AgentSupervisorHandoff {
  schemaVersion: 1; kind: 'AgentSupervisorHandoff'; agentId: string; actionId: string;
  generation: number; planDigest: string; snapshotDigest: string; reservationDigest: string;
  authorizationRevision: string; lifetime: 'persistent'; identityEvidenceDigest: string;
  locatorDigest: string; canonicalDir: string; planBytesDigest: string; handoffDigest: string;
}
export interface AgentSupervisorHandoffFaults {
  beforeSecureOpen?(path: string): void;
  beforeReplace?(): void; afterReplace?(): void; fsyncDirectory?(path: string): void;
  fsyncFile?(fd: number): void;
  write?(fd: number, bytes: Buffer, offset: number, length: number): number;
}
export class AgentSupervisorHandoffError extends Error {
  constructor(readonly code: 'invalid_completion' | 'invalid_handoff' | 'generation_conflict' | 'write_failed') {
    super(`agent supervisor handoff: ${code}`); this.name = 'AgentSupervisorHandoffError';
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new AgentSupervisorHandoffError('invalid_handoff');
  return `{${Object.keys(value).sort().map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new AgentSupervisorHandoffError('invalid_handoff');
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}
const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const safe = (value: string): string => {
  if (!TOKEN.test(value)) throw new AgentSupervisorHandoffError('invalid_handoff');
  return Buffer.from(value).toString('base64url');
};
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs;

function assertParents(path: string): void {
  const absolute = resolve(path); const root = parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch { throw new AgentSupervisorHandoffError('invalid_handoff'); }
    if (stat.isSymbolicLink()) throw new AgentSupervisorHandoffError('invalid_handoff');
  }
}

function secureBytes(path: string, faults: AgentSupervisorHandoffFaults = {}): Buffer {
  assertParents(dirname(path)); let before: BigIntStats;
  try { before = lstatSync(path, { bigint: true }); }
  catch { throw new AgentSupervisorHandoffError('invalid_handoff'); }
  if (before.isSymbolicLink() || !before.isFile() || (Number(before.mode) & 0o777) !== 0o600
      || before.size < 1n || before.size > 64n * 1024n)
    throw new AgentSupervisorHandoffError('invalid_handoff');
  faults.beforeSecureOpen?.(path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !same(before, opened)) throw new AgentSupervisorHandoffError('invalid_handoff');
    const bytes = Buffer.alloc(Number(opened.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new AgentSupervisorHandoffError('invalid_handoff'); offset += count;
    }
    if (!same(opened, fstatSync(fd, { bigint: true }))
        || !same(opened, lstatSync(path, { bigint: true })))
      throw new AgentSupervisorHandoffError('invalid_handoff');
    return bytes;
  } catch (error) {
    if (error instanceof AgentSupervisorHandoffError) throw error;
    throw new AgentSupervisorHandoffError('invalid_handoff');
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ } }
}

export function readAgentSupervisorHandoff(trustedRoot: string, agentId: string,
  faults: AgentSupervisorHandoffFaults = {}): Readonly<AgentSupervisorHandoff> {
  try {
    const path = join(resolve(trustedRoot), 'agents', safe(agentId), AGENT_SUPERVISOR_HANDOFF_FILENAME);
    const bytes = secureBytes(path, faults); const text = bytes.toString('utf8');
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== [...KEYS].sort().join('\0')
        || `${canonical(value)}\n` !== text) throw new AgentSupervisorHandoffError('invalid_handoff');
    const record = value as unknown as AgentSupervisorHandoff;
    const { handoffDigest, ...unsigned } = record;
    if (record.schemaVersion !== 1 || record.kind !== 'AgentSupervisorHandoff'
        || record.agentId !== agentId || !TOKEN.test(record.agentId) || !TOKEN.test(record.actionId)
        || !Number.isSafeInteger(record.generation) || record.generation < 1
        || !TOKEN.test(record.authorizationRevision) || record.lifetime !== 'persistent'
        || ![record.planDigest, record.snapshotDigest, record.reservationDigest,
          record.identityEvidenceDigest, record.locatorDigest, record.planBytesDigest,
          handoffDigest].every(value => SHA.test(value))
        || digest(canonical(unsigned)) !== handoffDigest)
      throw new AgentSupervisorHandoffError('invalid_handoff');
    const agentRoot = dirname(path);
    if (resolve(record.canonicalDir) === resolve(agentRoot)
        || !resolve(record.canonicalDir).startsWith(`${resolve(agentRoot)}${sep}`))
      throw new AgentSupervisorHandoffError('invalid_handoff');
    return Object.freeze(record);
  } catch (error) {
    if (error instanceof AgentSupervisorHandoffError) throw error;
    throw new AgentSupervisorHandoffError('invalid_handoff');
  }
}

export class AgentSupervisorHandoffPublisher {
  constructor(private readonly trustedRoot: string, private readonly completion: AgentCreationCompletionAuthority,
    private readonly faults: AgentSupervisorHandoffFaults = {}) {}

  async publish(evidence: VerifiedCompleteAgentCreation): Promise<Readonly<AgentSupervisorHandoff>> {
    const complete = this.completion.authenticateComplete(evidence);
    if (!complete) throw new AgentSupervisorHandoffError('invalid_completion');
    const plan = readStoredAgentPlan(complete.canonicalDir, complete, 'supervisor-handoff').plan;
    const expected: AgentStartLocatorExpectedBindings = { schemaVersion: 1, kind: 'AgentStartLocator',
      agentId: complete.agentId, actionId: complete.actionId, generation: complete.generation,
      planDigest: complete.planDigest, snapshotDigest: complete.snapshotDigest,
      reservationDigest: complete.reservationDigest, authorizationRevision: plan.authorizationRevision,
      lifetime: 'persistent', identityEvidenceDigest: complete.identity.evidenceDigest };
    const locator = readAgentStartLocator(complete.canonicalDir, expected);
    const unsigned = { schemaVersion: 1 as const, kind: 'AgentSupervisorHandoff' as const,
      agentId: expected.agentId, actionId: expected.actionId, generation: expected.generation,
      planDigest: expected.planDigest, snapshotDigest: expected.snapshotDigest,
      reservationDigest: expected.reservationDigest, authorizationRevision: expected.authorizationRevision,
      lifetime: expected.lifetime, identityEvidenceDigest: expected.identityEvidenceDigest,
      locatorDigest: locator.locatorDigest, canonicalDir: complete.canonicalDir,
      planBytesDigest: digest(encodeAgentPlan(plan)) };
    const record = Object.freeze({ ...unsigned, handoffDigest: digest(canonical(unsigned)) });
    await this.#cas(record); return record;
  }

  async #cas(record: AgentSupervisorHandoff): Promise<void> {
    const agentRoot = join(resolve(this.trustedRoot), 'agents', safe(record.agentId));
    assertParents(agentRoot); const stat = lstatSync(agentRoot);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new AgentSupervisorHandoffError('write_failed');
    const path = join(agentRoot, AGENT_SUPERVISOR_HANDOFF_FILENAME);
    await withConfigGraphLock(join(agentRoot, '.active'), 'exclusive', () => {
      let prior: Readonly<AgentSupervisorHandoff> | undefined;
      try { prior = readAgentSupervisorHandoff(this.trustedRoot, record.agentId, this.faults); }
      catch (error) {
        try { lstatSync(path); } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') prior = undefined;
          else throw error;
        }
        if (prior === undefined) { try { lstatSync(path); throw error; } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        } }
      }
      if (prior && canonical(prior) === canonical(record)) return;
      if (prior && (record.generation !== prior.generation + 1 || record.agentId !== prior.agentId))
        throw new AgentSupervisorHandoffError('generation_conflict');
      const bytes = Buffer.from(`${canonical(record)}\n`); const temp = join(agentRoot, `.active.${randomUUID()}.tmp`);
      let fd: number | undefined;
      try {
        fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        for (let offset = 0; offset < bytes.length;) {
          const count = this.faults.write?.(fd, bytes, offset, bytes.length - offset)
            ?? writeSync(fd, bytes, offset, bytes.length - offset);
          if (count <= 0) throw new AgentSupervisorHandoffError('write_failed'); offset += count;
        }
        if (this.faults.fsyncFile) this.faults.fsyncFile(fd); else fsyncSync(fd);
        closeSync(fd); fd = undefined; this.faults.beforeReplace?.();
        renameSync(temp, path); this.faults.afterReplace?.();
        if (this.faults.fsyncDirectory) this.faults.fsyncDirectory(agentRoot);
        else { const dir = openSync(agentRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { fsyncSync(dir); } finally { closeSync(dir); } }
      } catch (error) {
        if (error instanceof AgentSupervisorHandoffError) throw error;
        throw new AgentSupervisorHandoffError('write_failed');
      } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ }
        try { unlinkSync(temp); } catch { /* non-authoritative temp */ } }
    });
  }
}
