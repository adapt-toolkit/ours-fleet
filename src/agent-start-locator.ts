import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AgentCreationCompletionAuthority, VerifiedCompleteAgentCreation,
} from './agent-creation-transaction.js';
import { readStoredAgentPlan } from './agent-plan-store.js';

export const AGENT_START_LOCATOR_FILENAME = 'agent-start-locator.json';
const SHA = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface AgentStartLocator {
  schemaVersion: 1;
  kind: 'AgentStartLocator';
  agentId: string;
  actionId: string;
  generation: number;
  planDigest: string;
  snapshotDigest: string;
  reservationDigest: string;
  authorizationRevision: string;
  lifetime: 'persistent';
  identityEvidenceDigest: string;
  locatorDigest: string;
}

export class AgentStartLocatorError extends Error {
  constructor(readonly code: 'invalid_completion' | 'invalid_locator' | 'publication_conflict' | 'write_failed') {
    super(`agent start locator: ${code}`);
    this.name = 'AgentStartLocatorError';
  }
}

export interface AgentStartLocatorDeps {
  /** Test/fault seam for the durability boundary; production uses open+fsync+close. */
  fsyncDirectory?(stateDir: string): void;
}

export type AgentStartLocatorExpectedBindings = Readonly<Omit<AgentStartLocator, 'locatorDigest'>>;

const LOCATOR_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'agentId', 'actionId', 'generation', 'planDigest', 'snapshotDigest',
  'reservationDigest', 'authorizationRevision', 'lifetime', 'identityEvidenceDigest', 'locatorDigest',
]);

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new AgentStartLocatorError('invalid_locator');
  return `{${Object.keys(value).sort().map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new AgentStartLocatorError('invalid_locator');
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

function bytes(locator: AgentStartLocator): Buffer {
  return Buffer.from(`${canonical(locator)}\n`, 'utf8');
}

function secureRead(path: string, errorCode: 'invalid_locator' | 'publication_conflict'): Buffer {
  let before;
  try { before = lstatSync(path, { bigint: true }); }
  catch { throw new AgentStartLocatorError(errorCode); }
  if (before.isSymbolicLink() || !before.isFile() || (Number(before.mode) & 0o777) !== 0o600
      || before.size < 1n || before.size > 64n * 1024n)
    throw new AgentStartLocatorError(errorCode);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs)
      throw new AgentStartLocatorError(errorCode);
    const output = Buffer.alloc(Number(opened.size));
    for (let offset = 0; offset < output.length;) {
      const count = readSync(fd, output, offset, output.length - offset, offset);
      if (count <= 0) throw new AgentStartLocatorError(errorCode);
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    for (const stat of [after, afterPath]) {
      if (stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size
          || stat.mtimeNs !== opened.mtimeNs)
        throw new AgentStartLocatorError(errorCode);
    }
    return output;
  } catch (error) {
    if (error instanceof AgentStartLocatorError) throw error;
    throw new AgentStartLocatorError(errorCode);
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ } }
}

/** Secure, read-only presentation for a supervisor that already knows every expected binding. */
export function readAgentStartLocator(
  stateDir: string, expected: AgentStartLocatorExpectedBindings,
): Readonly<AgentStartLocator> {
  try {
    const dir = lstatSync(stateDir, { bigint: true });
    if (dir.isSymbolicLink() || !dir.isDirectory() || (Number(dir.mode) & 0o077) !== 0)
      throw new AgentStartLocatorError('invalid_locator');
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
        || Reflect.ownKeys(expected).sort().join('\0') !== LOCATOR_KEYS.filter(key => key !== 'locatorDigest').sort().join('\0')
        || Reflect.ownKeys(expected).some(key => {
          const descriptor = Object.getOwnPropertyDescriptor(expected, key);
          return !descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || typeof key !== 'string';
        })) throw new AgentStartLocatorError('invalid_locator');
    const payload = secureRead(join(stateDir, AGENT_START_LOCATOR_FILENAME), 'invalid_locator');
    const text = payload.toString('utf8');
    if (!text.endsWith('\n') || Buffer.from(text, 'utf8').length !== payload.length)
      throw new AgentStartLocatorError('invalid_locator');
    const parsed = JSON.parse(text.slice(0, -1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Reflect.ownKeys(parsed).some(key => typeof key !== 'string')
        || Object.keys(parsed).sort().join('\0') !== [...LOCATOR_KEYS].sort().join('\0'))
      throw new AgentStartLocatorError('invalid_locator');
    const unsigned = { ...parsed }; delete unsigned.locatorDigest;
    if (parsed.schemaVersion !== 1 || parsed.kind !== 'AgentStartLocator'
        || parsed.lifetime !== 'persistent' || typeof parsed.agentId !== 'string' || !TOKEN.test(parsed.agentId)
        || typeof parsed.actionId !== 'string' || !TOKEN.test(parsed.actionId) || !Number.isSafeInteger(parsed.generation)
        || (parsed.generation as number) < 1 || typeof parsed.authorizationRevision !== 'string'
        || !TOKEN.test(parsed.authorizationRevision)
        || ![parsed.planDigest, parsed.snapshotDigest, parsed.reservationDigest,
          parsed.identityEvidenceDigest, parsed.locatorDigest].every(value => typeof value === 'string' && SHA.test(value))
        || parsed.locatorDigest !== digest(unsigned)
        || canonical(parsed) + '\n' !== text)
      throw new AgentStartLocatorError('invalid_locator');
    for (const key of LOCATOR_KEYS) {
      if (key !== 'locatorDigest' && parsed[key] !== expected[key as keyof AgentStartLocatorExpectedBindings])
        throw new AgentStartLocatorError('invalid_locator');
    }
    return Object.freeze(parsed as unknown as AgentStartLocator);
  } catch (error) {
    if (error instanceof AgentStartLocatorError) throw error;
    throw new AgentStartLocatorError('invalid_locator');
  }
}

export class AgentStartLocatorPublisher {
  constructor(
    private readonly completion: AgentCreationCompletionAuthority,
    private readonly deps: AgentStartLocatorDeps = {},
  ) {}

  publish(evidence: VerifiedCompleteAgentCreation): Readonly<AgentStartLocator> {
    const complete = this.completion.authenticateComplete(evidence);
    if (!complete) throw new AgentStartLocatorError('invalid_completion');
    const plan = readStoredAgentPlan(complete.canonicalDir, complete, 'start-locator').plan;
    const authorizationRevision = plan.authorizationRevision;
    const unsigned = {
      schemaVersion: 1 as const, kind: 'AgentStartLocator' as const,
      agentId: complete.agentId, actionId: complete.actionId, generation: complete.generation,
      planDigest: complete.planDigest, snapshotDigest: complete.snapshotDigest,
      reservationDigest: complete.reservationDigest, authorizationRevision,
      lifetime: 'persistent' as const, identityEvidenceDigest: complete.identity.evidenceDigest,
    };
    if (![unsigned.planDigest, unsigned.snapshotDigest, unsigned.reservationDigest,
      unsigned.identityEvidenceDigest].every(value => SHA.test(value)))
      throw new AgentStartLocatorError('invalid_completion');
    const locator = Object.freeze({ ...unsigned, locatorDigest: digest(unsigned) });
    this.#store(complete.canonicalDir, locator);
    return locator;
  }

  #store(stateDir: string, locator: AgentStartLocator): void {
    const path = join(stateDir, AGENT_START_LOCATOR_FILENAME);
    const payload = bytes(locator);
    const temp = join(stateDir, `.${AGENT_START_LOCATOR_FILENAME}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    let tempExists = false;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | constants.O_NOFOLLOW, 0o600);
      tempExists = true;
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
        throw new AgentStartLocatorError('write_failed');
      for (let offset = 0; offset < payload.length;) {
        const count = writeSync(fd, payload, offset, payload.length - offset);
        if (count <= 0) throw new AgentStartLocatorError('write_failed');
        offset += count;
      }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temp, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new AgentStartLocatorError('write_failed');
        if (!this.#readExtant(path).equals(payload))
          throw new AgentStartLocatorError('publication_conflict');
      }
      unlinkSync(temp); tempExists = false;
      if (this.deps.fsyncDirectory) this.deps.fsyncDirectory(stateDir);
      else {
        const dir = openSync(stateDir, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } catch (error) {
      if (error instanceof AgentStartLocatorError) throw error;
      throw new AgentStartLocatorError('write_failed');
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* retain primary error */ }
      if (tempExists) try { unlinkSync(temp); } catch { /* retain primary error */ }
    }
  }

  #readExtant(path: string): Buffer {
    return secureRead(path, 'publication_conflict');
  }
}
