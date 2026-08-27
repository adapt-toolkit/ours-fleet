import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { withConfigGraphLock } from './config-graph-lock.js';

const SHA = /^sha256:[a-f0-9]{64}$/u; const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX = 64 * 1024; const MAX_TRANSITIONS = 16;
export class AgentRuntimeRecordError extends Error {
  constructor(readonly code: 'invalid' | 'unsafe' | 'corrupt' | 'conflict' | 'write_failed') {
    super(`agent runtime record: ${code}`); this.name = 'AgentRuntimeRecordError';
  }
}
export interface RuntimeCommon {
  agentId: string; generation: number; planDigest: string; snapshotDigest: string;
  reservationDigest: string; identityEvidenceDigest: string; runtimeInstanceKey: string;
}
export interface RuntimeTransition extends RuntimeCommon {
  schemaVersion: 1; kind: 'AgentRuntimeTransition'; chain: 'launch' | 'restore' | 'retire';
  requestActionId: string; authorizationRevision: string; ordinal: number;
  from: string | null; state: string; prevDigest: string | null;
  event: Record<string, unknown>; digest: string;
}
export interface RuntimeActiveClaim extends RuntimeCommon {
  schemaVersion: 1; kind: 'AgentRuntimeActiveClaim'; claimDigest: string;
}
export interface RuntimePrerequisite extends RuntimeCommon {
  schemaVersion: 1; kind: 'AgentRuntimePrerequisite'; operation: RuntimeTransition['chain'];
  requestActionId: string; authorizationRevision: string; prerequisiteDigest: string;
}
export interface RuntimeRecordFaults {
  afterClaim?(): void; duringClaimIndex?(): void; beforeSecureOpen?(path: string): void;
  afterOperationIndex?(operation: 'start' | 'restore' | 'retire'): void;
  afterTransition?(state: string): void;
  write?(fd: number, bytes: Buffer, offset: number, length: number): number;
}
export const runtimeDigest = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const runtimeCanonical = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value).filter(key => key !== 'length');
    if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== value.length
        || names.some((key, index) => key !== String(index)))
      throw new AgentRuntimeRecordError('invalid');
    return `[${value.map(runtimeCanonical).join(',')}]`;
  }
  if (!value || typeof value !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length > 0
      || Object.keys(value).length !== Object.getOwnPropertyNames(value).length)
    throw new AgentRuntimeRecordError('invalid');
  return `{${Object.keys(value).sort().map(key => {
    const child = (value as Record<string, unknown>)[key]; if (child === undefined) throw new AgentRuntimeRecordError('invalid');
    return `${JSON.stringify(key)}:${runtimeCanonical(child)}`;
  }).join(',')}}`;
};
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const eventSchemas: Record<RuntimeTransition['chain'], Record<string, readonly string[]>> = {
  launch: {
    prerequisites_validated: ['prerequisiteDigest'], active_claimed: ['claimDigest'],
    start_authorized: ['startEffectKey'], starting: [],
    started: ['provider','providerRuntimeId','startEvidenceDigest','receiptDigest'],
    readiness_checking: [], ready: ['evidenceDigest'], not_ready: ['evidenceDigest'], ambiguous: ['reason'],
  },
  restore: { restore_authorized: ['restoreRequestKey'], reconciling: [], restored: ['evidenceDigest'],
    missing: ['evidenceDigest'], ambiguous: ['reason'] },
  retire: { retire_authorized: ['retireEffectKey'], reconciling: [], retiring: ['evidenceDigest'],
    retired: [], retire_failed: [], already_absent: ['evidenceDigest'], ambiguous: ['reason'] },
};
function validEvent(chain: RuntimeTransition['chain'], state: string, event: Record<string, unknown>): boolean {
  const keys = eventSchemas[chain][state];
  if (!keys || !exact(event, keys)) return false;
  for (const [key, value] of Object.entries(event)) {
    if (typeof value !== 'string' || value.length < 1) return false;
    if (key.endsWith('Digest') || key.endsWith('Key')) { if (!SHA.test(value)) return false; }
    else if (!TOKEN.test(value)) return false;
  }
  if ('reason' in event) {
    const reasons: Record<RuntimeTransition['chain'], readonly string[]> = {
      launch: ['start_unknown', 'readiness_unknown'], restore: ['restore_unknown'],
      retire: ['retire_unknown', 'ownership_unknown'],
    };
    if (!reasons[chain].includes(String(event.reason))) return false;
  }
  return true;
}
const safe = (value: string) => {
  if (!TOKEN.test(value)) throw new AgentRuntimeRecordError('invalid');
  return Buffer.from(value).toString('base64url');
};
function noSymlink(path: string): void {
  const absolute = resolve(path); const root = parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new AgentRuntimeRecordError('unsafe'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof AgentRuntimeRecordError) throw error; throw new AgentRuntimeRecordError('unsafe');
    }
  }
}
function privateDir(path: string): void {
  noSymlink(dirname(path)); mkdirSync(path, { recursive: true, mode: 0o700 }); noSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
    throw new AgentRuntimeRecordError('unsafe');
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs;
function secureBytes(path: string, faults: RuntimeRecordFaults): Buffer {
  noSymlink(dirname(path)); let before: BigIntStats;
  try { before = lstatSync(path, { bigint: true }); } catch { throw new AgentRuntimeRecordError('corrupt'); }
  if (!before.isFile() || before.isSymbolicLink() || (Number(before.mode) & 0o777) !== 0o600
      || before.size < 1n || before.size > BigInt(MAX)) throw new AgentRuntimeRecordError('unsafe');
  faults.beforeSecureOpen?.(path); let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd, { bigint: true });
    if (!same(before, opened) || !opened.isFile() || (Number(opened.mode) & 0o777) !== 0o600)
      throw new AgentRuntimeRecordError('unsafe');
    const bytes = Buffer.alloc(Number(opened.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new AgentRuntimeRecordError('corrupt'); offset += count;
    }
    if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, lstatSync(path, { bigint: true })))
      throw new AgentRuntimeRecordError('unsafe');
    return bytes;
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* stable */ } }
}
function secureJson(path: string, faults: RuntimeRecordFaults): Record<string, unknown> {
  const bytes = secureBytes(path, faults); let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new AgentRuntimeRecordError('corrupt'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || `${runtimeCanonical(value)}\n` !== bytes.toString('utf8')) throw new AgentRuntimeRecordError('corrupt');
  return value as Record<string, unknown>;
}
function publish(path: string, bytes: Buffer, faults: RuntimeRecordFaults): void {
  privateDir(dirname(path)); const temp = join(dirname(path), `.${randomUUID()}.tmp`); let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (let offset = 0; offset < bytes.length;) {
      const count = faults.write?.(fd, bytes, offset, bytes.length - offset)
        ?? writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new AgentRuntimeRecordError('write_failed'); offset += count;
    }
    fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !secureBytes(path, faults).equals(bytes))
        throw new AgentRuntimeRecordError('conflict');
    }
    const dirFd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* stable */ }
    try { unlinkSync(temp); } catch { /* private temp */ }
  }
}

export class AgentRuntimeRecordStore {
  constructor(private readonly faults: RuntimeRecordFaults = {}) {}
  agentRoot(canonicalDir: string, agentId: string): string {
    noSymlink(canonicalDir); const root = dirname(dirname(dirname(canonicalDir)));
    if (basename(root) !== Buffer.from(agentId).toString('base64url'))
      throw new AgentRuntimeRecordError('invalid');
    return root;
  }
  async claim(canonicalDir: string, common: RuntimeCommon, requestActionId: string,
    authorizationRevision: string, validatePrerequisites: () => void): Promise<Readonly<RuntimeActiveClaim>> {
    const root = this.agentRoot(canonicalDir, common.agentId); privateDir(join(root, 'runtime-operation-indexes'));
    return withConfigGraphLock(join(root, '.runtime-active'), 'exclusive', () => {
      validatePrerequisites();
      const path = join(root, 'runtime-active-claim.json');
      let extant: RuntimeActiveClaim | undefined;
      try { extant = this.readClaim(canonicalDir, common.agentId); } catch (error) {
        if (!(error instanceof AgentRuntimeRecordError) || error.code !== 'corrupt') throw error;
      }
      const unsigned = { schemaVersion: 1 as const, kind: 'AgentRuntimeActiveClaim' as const, ...common };
      const claim = { ...unsigned, claimDigest: runtimeDigest(runtimeCanonical(unsigned)) };
      if (extant) {
        if (runtimeCanonical(extant) !== runtimeCanonical(claim)) throw new AgentRuntimeRecordError('conflict');
      } else publish(path, Buffer.from(`${runtimeCanonical(claim)}\n`), this.faults);
      this.faults.afterClaim?.(); this.faults.duringClaimIndex?.();
      const indexUnsigned = { schemaVersion: 1, kind: 'AgentRuntimeOperationIndex', operation: 'start',
        requestActionId, authorizationRevision, runtimeInstanceKey: common.runtimeInstanceKey,
        claimDigest: claim.claimDigest };
      const index = { ...indexUnsigned, indexDigest: runtimeDigest(runtimeCanonical(indexUnsigned)) };
      publish(join(root, 'runtime-operation-indexes', `${safe(requestActionId)}.json`),
        Buffer.from(`${runtimeCanonical(index)}\n`), this.faults);
      this.faults.afterOperationIndex?.('start');
      return Object.freeze(claim);
    });
  }
  publishPrerequisite(canonicalDir: string, operation: RuntimeTransition['chain'], requestActionId: string,
    authorizationRevision: string, common: RuntimeCommon): Readonly<RuntimePrerequisite> {
    const root = this.agentRoot(canonicalDir, common.agentId); const dir = join(root, 'runtime-prerequisites');
    privateDir(dir);
    const unsigned = { schemaVersion: 1 as const, kind: 'AgentRuntimePrerequisite' as const, operation,
      requestActionId, authorizationRevision, ...common };
    const value = { ...unsigned, prerequisiteDigest: runtimeDigest(runtimeCanonical(unsigned)) };
    publish(join(dir, `${safe(requestActionId)}.json`), Buffer.from(`${runtimeCanonical(value)}\n`), this.faults);
    return Object.freeze(value);
  }
  readPrerequisite(canonicalDir: string, operation: RuntimeTransition['chain'], requestActionId: string,
    authorizationRevision: string, common: RuntimeCommon): RuntimePrerequisite {
    const path = join(this.agentRoot(canonicalDir, common.agentId), 'runtime-prerequisites', `${safe(requestActionId)}.json`);
    const value = secureJson(path, this.faults);
    if (!exact(value, ['schemaVersion','kind','operation','requestActionId','authorizationRevision','agentId',
      'generation','planDigest','snapshotDigest','reservationDigest','identityEvidenceDigest','runtimeInstanceKey',
      'prerequisiteDigest'])) throw new AgentRuntimeRecordError('corrupt');
    const record = value as unknown as RuntimePrerequisite; const { prerequisiteDigest, ...unsigned } = record;
    if (record.schemaVersion !== 1 || record.kind !== 'AgentRuntimePrerequisite' || record.operation !== operation
        || record.requestActionId !== requestActionId || record.authorizationRevision !== authorizationRevision
        || !Object.entries(common).every(([key,val]) => (record as unknown as Record<string,unknown>)[key] === val)
        || !SHA.test(prerequisiteDigest) || runtimeDigest(runtimeCanonical(unsigned)) !== prerequisiteDigest)
      throw new AgentRuntimeRecordError('corrupt');
    return record;
  }
  async withActiveLock<T>(canonicalDir: string, agentId: string, validatePrerequisites: () => void,
    fn: (claim: Readonly<RuntimeActiveClaim>) => T | Promise<T>): Promise<T> {
    const root = this.agentRoot(canonicalDir, agentId);
    return withConfigGraphLock(join(root, '.runtime-active'), 'exclusive', async () => {
      validatePrerequisites(); return fn(this.readClaim(canonicalDir, agentId));
    });
  }
  indexOperation(canonicalDir: string, agentId: string, operation: 'restore'|'retire',
    requestActionId: string, authorizationRevision: string, runtimeInstanceKey: string,
    effectKey: string): void {
    const root = this.agentRoot(canonicalDir, agentId); privateDir(join(root, 'runtime-operation-indexes'));
    const unsigned = { schemaVersion:1, kind:'AgentRuntimeOperationIndex', operation, requestActionId,
      authorizationRevision, runtimeInstanceKey, effectKey };
    const value = { ...unsigned, indexDigest:runtimeDigest(runtimeCanonical(unsigned)) };
    publish(join(root,'runtime-operation-indexes',`${safe(requestActionId)}.json`),
      Buffer.from(`${runtimeCanonical(value)}\n`), this.faults);
    this.faults.afterOperationIndex?.(operation);
  }
  readOperationIndex(canonicalDir: string, agentId: string, operation: 'start'|'restore'|'retire',
    requestActionId: string, authorizationRevision: string, runtimeInstanceKey: string,
    effectKey: string): Record<string, unknown> {
    const value = secureJson(join(this.agentRoot(canonicalDir, agentId), 'runtime-operation-indexes',
      `${safe(requestActionId)}.json`), this.faults);
    const start = operation === 'start';
    const keys = start
      ? ['schemaVersion','kind','operation','requestActionId','authorizationRevision','runtimeInstanceKey','claimDigest','indexDigest']
      : ['schemaVersion','kind','operation','requestActionId','authorizationRevision','runtimeInstanceKey','effectKey','indexDigest'];
    if (!exact(value, keys)) throw new AgentRuntimeRecordError('corrupt');
    const { indexDigest, ...unsigned } = value;
    if (value.schemaVersion !== 1 || value.kind !== 'AgentRuntimeOperationIndex' || value.operation !== operation
        || value.requestActionId !== requestActionId || value.authorizationRevision !== authorizationRevision
        || value.runtimeInstanceKey !== runtimeInstanceKey || value[start ? 'claimDigest' : 'effectKey'] !== effectKey
        || typeof indexDigest !== 'string' || !SHA.test(indexDigest)
        || runtimeDigest(runtimeCanonical(unsigned)) !== indexDigest)
      throw new AgentRuntimeRecordError('corrupt');
    return value;
  }
  readClaim(canonicalDir: string, agentId: string): RuntimeActiveClaim {
    const value = secureJson(join(this.agentRoot(canonicalDir, agentId), 'runtime-active-claim.json'), this.faults);
    if (!exact(value, ['schemaVersion', 'kind', 'agentId', 'generation', 'planDigest', 'snapshotDigest',
      'reservationDigest', 'identityEvidenceDigest', 'runtimeInstanceKey', 'claimDigest']))
      throw new AgentRuntimeRecordError('corrupt');
    const claim = value as unknown as RuntimeActiveClaim; const { claimDigest, ...unsigned } = claim;
    if (claim.schemaVersion !== 1 || claim.kind !== 'AgentRuntimeActiveClaim'
        || !SHA.test(claimDigest) || runtimeDigest(runtimeCanonical(unsigned)) !== claimDigest)
      throw new AgentRuntimeRecordError('corrupt');
    return claim;
  }
  chainDir(canonicalDir: string, chain: RuntimeTransition['chain'], requestActionId: string): string {
    return chain === 'launch' ? join(canonicalDir, 'runtime-launch-transitions')
      : join(canonicalDir, `runtime-${chain}s`, safe(requestActionId), 'transitions');
  }
  readChain(canonicalDir: string, chain: RuntimeTransition['chain'], requestActionId: string,
    common: RuntimeCommon): RuntimeTransition[] {
    const dir = this.chainDir(canonicalDir, chain, requestActionId); privateDir(dir);
    const names = readdirSync(dir).filter(name => !name.startsWith('.')).sort();
    if (names.length > MAX_TRANSITIONS) throw new AgentRuntimeRecordError('corrupt');
    return names.map((name, ordinal, all) => {
      if (!/^\d{8}-[a-z_]+\.json$/u.test(name)) throw new AgentRuntimeRecordError('corrupt');
      const value = secureJson(join(dir, name), this.faults);
      if (!exact(value, ['schemaVersion','kind','chain','requestActionId','authorizationRevision','agentId',
        'generation','planDigest','snapshotDigest','reservationDigest','identityEvidenceDigest','runtimeInstanceKey',
        'ordinal','from','state','prevDigest','event','digest'])) throw new AgentRuntimeRecordError('corrupt');
      const record = value as unknown as RuntimeTransition; const prior = ordinal ? all[ordinal - 1] : undefined;
      const previous = ordinal ? secureJson(join(dir, prior!), this.faults) : undefined;
      const { digest, ...unsigned } = record;
      if (record.schemaVersion !== 1 || record.kind !== 'AgentRuntimeTransition' || record.chain !== chain
          || record.requestActionId !== requestActionId || record.ordinal !== ordinal
          || name !== `${String(ordinal).padStart(8,'0')}-${record.state}.json`
          || record.from !== (previous?.state ?? null) || record.prevDigest !== (previous?.digest ?? null)
          || !Object.entries(common).every(([key,val]) => (record as unknown as Record<string,unknown>)[key] === val)
          || !validEvent(chain, record.state, record.event)
          || !SHA.test(digest) || runtimeDigest(runtimeCanonical(unsigned)) !== digest)
        throw new AgentRuntimeRecordError('corrupt');
      return record;
    });
  }
  async append(canonicalDir: string, chain: RuntimeTransition['chain'], requestActionId: string,
    authorizationRevision: string, common: RuntimeCommon, state: string, event: Record<string,unknown>): Promise<void> {
    if (!validEvent(chain, state, event)) throw new AgentRuntimeRecordError('invalid');
    const dir = this.chainDir(canonicalDir, chain, requestActionId); privateDir(dir);
    await withConfigGraphLock(join(dir, '.lock-anchor'), 'exclusive', () => {
      const records = this.readChain(canonicalDir, chain, requestActionId, common); const prior = records.at(-1);
      const duplicate = records.find(value => value.state === state);
      if (duplicate) {
        if (duplicate.authorizationRevision !== authorizationRevision
            || runtimeCanonical(duplicate.event) !== runtimeCanonical(event))
          throw new AgentRuntimeRecordError('conflict');
        return;
      }
      if (records.length >= MAX_TRANSITIONS) throw new AgentRuntimeRecordError('conflict');
      const unsigned = { schemaVersion:1 as const, kind:'AgentRuntimeTransition' as const, chain,
        requestActionId, authorizationRevision, ...common, ordinal:records.length,
        from:prior?.state ?? null, state, prevDigest:prior?.digest ?? null, event };
      publish(join(dir, `${String(records.length).padStart(8,'0')}-${state}.json`),
        Buffer.from(`${runtimeCanonical({ ...unsigned, digest:runtimeDigest(runtimeCanonical(unsigned)) })}\n`), this.faults);
      this.faults.afterTransition?.(state);
    });
  }
  publishArtifact(canonicalDir: string, name: string, value: Record<string,unknown>): void {
    if (!['runtime-binding.json','runtime-provenance.json'].includes(name)) throw new AgentRuntimeRecordError('invalid');
    publish(join(canonicalDir,name), Buffer.from(`${runtimeCanonical(value)}\n`), this.faults);
  }
  readArtifact(canonicalDir: string, name: string): Record<string,unknown> {
    const value = secureJson(join(canonicalDir,name), this.faults);
    const binding = name === 'runtime-binding.json';
    const keys = binding
      ? ['schemaVersion','kind','agentId','generation','planDigest','snapshotDigest','reservationDigest',
        'identityEvidenceDigest','runtimeInstanceKey','startEffectKey','adapterDescriptorDigest','provider',
        'providerRuntimeId','startEvidenceDigest']
      : name === 'runtime-provenance.json'
        ? ['schemaVersion','kind','requestActionId','authorizationRevision','agentId','generation','planDigest',
          'snapshotDigest','reservationDigest','identityEvidenceDigest','runtimeInstanceKey','startEffectKey',
          'adapterDescriptorDigest','startEvidenceDigest','adapterId','adapterVersion']
        : [];
    if (keys.length === 0 || !exact(value, keys)
        || value.schemaVersion !== 1
        || value.kind !== (binding ? 'AgentRuntimeBinding' : 'AgentRuntimeProvenance'))
      throw new AgentRuntimeRecordError('corrupt');
    for (const [key, child] of Object.entries(value)) {
      if (key === 'schemaVersion' || key === 'generation') {
        if (!Number.isSafeInteger(child) || Number(child) < 1) throw new AgentRuntimeRecordError('corrupt');
      } else if (typeof child !== 'string' || child.length < 1
          || (key.endsWith('Digest') || key.endsWith('Key') ? !SHA.test(child) : !TOKEN.test(child)))
        throw new AgentRuntimeRecordError('corrupt');
    }
    return value;
  }
}
