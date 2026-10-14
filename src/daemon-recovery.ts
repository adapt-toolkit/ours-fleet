import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  attachOursClient, type AttachOursClientOptions, type OursClient,
} from '@ours.network/sdk/client';

import { type FetchLike } from './monitor.js';
import { readClientProfile, type ExplicitClientProfile } from './client-profile.js';
import { replaceFileAtomically } from './atomic-file.js';

export const DAEMON_RECOVERY_MAX_ATTEMPTS = 6;
export const DAEMON_RECOVERY_INITIAL_BACKOFF_MS = 1_000;
export const DAEMON_RECOVERY_MAX_BACKOFF_MS = 5_000;
export const DAEMON_RECOVERY_DEADLINE_MS = 60_000;

const STARTUP_PHASES = new Set([
  'initializing', 'wrapper', 'registrar', 'identities', 'reconciliation',
  'server', 'ready', 'failed',
]);

export interface DaemonGeneration {
  bootId: string;
  pid: number;
  startedAt: number;
  stateDir: string;
}

export type DaemonGenerationProbe =
  | { state: 'ready'; generation: DaemonGeneration }
  | { state: 'unavailable'; reason: string };

export type DaemonGenerationObservation =
  | { kind: 'baseline' | 'stable' | 'available'; generation: DaemonGeneration }
  | { kind: 'changed'; previous: DaemonGeneration; generation: DaemonGeneration }
  | { kind: 'lost' | 'unavailable'; previous?: DaemonGeneration; reason: string };

interface StartupProgress {
  version: 1;
  pid: number;
  bootId: string;
  phase: string;
  startedAt: number;
  updatedAt: number;
  completed?: number;
  total?: number;
}

interface GenerationProbeDeps {
  readText?(path: string): string;
  canonicalize?(path: string): string;
  attachClient?(
    options: AttachOursClientOptions,
  ): Pick<OursClient, 'version' | 'identities' | 'close'> | Promise<Pick<OursClient, 'version' | 'identities' | 'close'>>;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function startupProgress(value: unknown): StartupProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !positiveInteger(row.pid)
      || typeof row.bootId !== 'string' || row.bootId.length === 0
      || typeof row.phase !== 'string' || !STARTUP_PHASES.has(row.phase)
      || !finiteTimestamp(row.startedAt) || !finiteTimestamp(row.updatedAt)) return undefined;
  if ((row.updatedAt as number) < (row.startedAt as number)) return undefined;
  if ((row.completed === undefined) !== (row.total === undefined)) return undefined;
  if (row.completed !== undefined
      && (!Number.isSafeInteger(row.completed) || (row.completed as number) < 0
        || !Number.isSafeInteger(row.total) || (row.total as number) < 0
        || (row.completed as number) > (row.total as number))) return undefined;
  return row as unknown as StartupProgress;
}

/** Read generation and readiness through the selected gateway. Server paths are opaque. */
export async function probeDaemonGeneration(
  fetch: FetchLike,
  env: NodeJS.ProcessEnv,
  deps: GenerationProbeDeps = {},
): Promise<DaemonGenerationProbe> {
  try { return await probeSelectedDaemon(deps, readClientProfile(env)); }
  catch { return { state: 'unavailable', reason: 'CLIENT_GATEWAY_PROFILE_INVALID' }; }
}

/** Container selection uses public SDK reads; daemon paths/PIDs remain opaque metadata. */
async function probeSelectedDaemon(
  deps: GenerationProbeDeps,
  profile: ExplicitClientProfile,
): Promise<DaemonGenerationProbe> {
  // Defer credential-file access to SDK selection, which checks the configured
  // daemon identity/capability before it reads or sends the credential.
  let client: Pick<OursClient, 'version' | 'identities' | 'close'> | undefined;
  try {
    const options: AttachOursClientOptions = {
      endpoint: profile.endpoint, expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath,
      sessionMode: 'external', leaseToken: randomUUID(), env: {},
    };
    client = await (deps.attachClient?.(options) ?? attachOursClient(options));
    const info = await client.version({startup:true});
    if (info.name !== 'ours' || !positiveInteger(info.pid)
        || typeof info.stateDir !== 'string' || !info.stateDir)
      return {state:'unavailable', reason:'DAEMON_INFO_INVALID'};
    const progress = startupProgress(info.startup);
    if (!progress) return {state:'unavailable', reason:'DAEMON_PROGRESS_INVALID'};
    if (progress.phase !== 'ready') return {state:'unavailable', reason:'DAEMON_PROGRESS_NOT_READY'};
    if (progress.pid !== info.pid) return {state:'unavailable', reason:'DAEMON_GENERATION_MISMATCH'};
    const identities = await client.identities();
    if (!Array.isArray(identities)) return {state:'unavailable', reason:'DAEMON_IDENTITIES_INVALID'};
    if (!identities.length) return {state:'unavailable', reason:'DAEMON_IDENTITIES_NOT_READY'};
    return {state:'ready', generation:{
      bootId:progress.bootId, pid:progress.pid, startedAt:progress.startedAt, stateDir:info.stateDir,
    }};
  } catch {
    // Failed selection, auth or transport is unavailable, never owner death.
    return {state:'unavailable', reason:'DAEMON_SELECTED_PROBE_UNAVAILABLE'};
  } finally { await client?.close().catch(() => undefined); }
}

export class DaemonGenerationObserver {
  private current?: DaemonGeneration;
  private unavailable = false;

  observe(probe: DaemonGenerationProbe): DaemonGenerationObservation {
    if (probe.state === 'unavailable') {
      // Cold startup has no generation to lose. Do not manufacture a recovery
      // epoch before the first corroborated ready observation.
      if (!this.current) return { kind: 'unavailable', reason: probe.reason };
      const kind = this.unavailable ? 'unavailable' : 'lost';
      this.unavailable = true;
      return { kind, previous: this.current, reason: probe.reason };
    }
    const next = probe.generation;
    const previous = this.current;
    this.current = next;
    if (!previous) {
      this.unavailable = false;
      return { kind: 'baseline', generation: next };
    }
    const changed = previous.bootId !== next.bootId
      || previous.pid !== next.pid
      || previous.startedAt !== next.startedAt
      || previous.stateDir !== next.stateDir;
    const wasUnavailable = this.unavailable;
    this.unavailable = false;
    if (changed) return { kind: 'changed', previous, generation: next };
    return { kind: wasUnavailable ? 'available' : 'stable', generation: next };
  }
}

export function daemonRecoveryBackoff(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(
    DAEMON_RECOVERY_INITIAL_BACKOFF_MS * 2 ** exponent,
    DAEMON_RECOVERY_MAX_BACKOFF_MS,
  );
}

export type RecoveryPath = 'agent' | 'owner';
export type RecoveryPathResult = { ok: true } | { ok: false; reason: string };

function safeRecoveryReason(reason: string, fallback = 'RECOVERY_PATH_FAILED'): string {
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(reason) ? reason : fallback;
}

export interface RoleRecoveryControllerOptions {
  role: string;
  identity: string;
  stateDir: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  recoverAgent(epoch: string): Promise<RecoveryPathResult>;
  recoverOwner(epoch: string): Promise<RecoveryPathResult>;
  log(line: string): void;
}

export interface RecoveryStatus {
  version: 1;
  identity: string;
  epoch: string;
  state: 'recovering' | 'recovered' | 'degraded' | 'cancelled';
  paths: Record<RecoveryPath, { state: 'pending' | 'recovered' | 'degraded'; attempts: number; reason?: string }>;
  updatedAt: string;
}

export function readDaemonRecoveryStatus(dir: string): RecoveryStatus | undefined {
  try {
    const raw = readFileSync(join(dir, '.daemon-recovery.json'), 'utf8');
    if (raw.length > 16 * 1024) return undefined;
    const value = JSON.parse(raw) as Partial<RecoveryStatus>;
    if (value.version !== 1 || typeof value.epoch !== 'string'
        || !['recovering', 'recovered', 'degraded', 'cancelled'].includes(value.state ?? '')
        || !value.paths || typeof value.paths !== 'object') return undefined;
    for (const name of ['agent', 'owner'] as const) {
      const path = value.paths[name];
      if (!path || !['pending', 'recovered', 'degraded'].includes(path.state)
          || !Number.isSafeInteger(path.attempts) || path.attempts < 0
          || (path.reason !== undefined && !/^[A-Z0-9_]{1,96}$/.test(path.reason))) return undefined;
    }
    return value as RecoveryStatus;
  } catch { return undefined; }
}

/** Per-role, per-generation bounded recovery with path-level fault isolation. */
export class RoleRecoveryController {
  private token = 0;
  private activeEpoch?: string;
  private active?: Promise<RecoveryStatus>;
  private status?: RecoveryStatus;

  constructor(private readonly options: RoleRecoveryControllerOptions) {}

  recover(generation: DaemonGeneration): Promise<RecoveryStatus> {
    const epoch = createHash('sha256').update([
      generation.bootId, generation.pid, generation.startedAt, generation.stateDir,
    ].join('\0')).digest('hex').slice(0, 24);
    if (this.activeEpoch === epoch && this.active) return this.active;
    const token = ++this.token;
    this.activeEpoch = epoch;
    const deadline = this.options.now() + DAEMON_RECOVERY_DEADLINE_MS;
    const status: RecoveryStatus = {
      version: 1, identity: this.options.identity, epoch, state: 'recovering',
      paths: {
        agent: { state: 'pending', attempts: 0 },
        owner: { state: 'pending', attempts: 0 },
      },
      updatedAt: new Date(this.options.now()).toISOString(),
    };
    this.status = status;
    this.write(status, token);
    const runPath = async (
      path: RecoveryPath, operation: (epoch: string) => Promise<RecoveryPathResult>,
    ): Promise<void> => {
      let lastReason = 'RECOVERY_ATTEMPTS_EXHAUSTED';
      for (let attempt = 1; attempt <= DAEMON_RECOVERY_MAX_ATTEMPTS; attempt++) {
        if (token !== this.token) return;
        if (this.options.now() >= deadline) { lastReason = 'RECOVERY_DEADLINE_EXCEEDED'; break; }
        status.paths[path] = { state: 'pending', attempts: attempt };
        this.write(status, token);
        try {
          const remaining = Math.max(0, deadline - this.options.now());
          let timer: NodeJS.Timeout | undefined;
          const result = await Promise.race([
            operation(epoch),
            new Promise<RecoveryPathResult>(resolve => {
              timer = setTimeout(() => resolve({ ok: false, reason: 'RECOVERY_DEADLINE_EXCEEDED' }), remaining);
              timer.unref?.();
            }),
          ]).finally(() => { if (timer) clearTimeout(timer); });
          if (token !== this.token) return;
          if (result.ok) {
            status.paths[path] = { state: 'recovered', attempts: attempt };
            this.write(status, token);
            return;
          }
          lastReason = safeRecoveryReason(result.reason);
        } catch (error) {
          lastReason = safeRecoveryReason(
            error instanceof Error && error.name
              ? `RECOVERY_${error.name.toUpperCase()}` : 'RECOVERY_UNKNOWN_ERROR',
            'RECOVERY_UNKNOWN_ERROR',
          );
        }
        if (attempt < DAEMON_RECOVERY_MAX_ATTEMPTS) {
          const wait = Math.min(daemonRecoveryBackoff(attempt), Math.max(0, deadline - this.options.now()));
          await this.options.sleep(wait);
        }
      }
      if (token !== this.token) return;
      status.paths[path] = {
        state: 'degraded', attempts: status.paths[path].attempts, reason: lastReason,
      };
      this.write(status, token);
    };
    const active = Promise.all([
      runPath('agent', this.options.recoverAgent),
      runPath('owner', this.options.recoverOwner),
    ]).then(() => {
      if (token !== this.token) {
        status.state = 'cancelled';
        return status;
      }
      status.state = Object.values(status.paths).every(path => path.state === 'recovered')
        ? 'recovered' : 'degraded';
      this.write(status, token);
      return status;
    });
    this.active = active;
    return active;
  }

  cancel(): void {
    const token = ++this.token;
    this.activeEpoch = undefined;
    this.active = undefined;
    if (this.status?.state === 'recovering') {
      this.status.state = 'cancelled';
      this.write(this.status, token);
    }
  }

  noteLoss(reason: string): void {
    const token = ++this.token;
    this.activeEpoch = undefined;
    this.active = undefined;
    const status: RecoveryStatus = {
      version: 1, identity: this.options.identity, epoch: '', state: 'degraded',
      paths: {
        agent: { state: 'degraded', attempts: 0, reason: safeRecoveryReason(reason, 'DAEMON_UNAVAILABLE') },
        owner: { state: 'degraded', attempts: 0, reason: safeRecoveryReason(reason, 'DAEMON_UNAVAILABLE') },
      },
      updatedAt: new Date(this.options.now()).toISOString(),
    };
    this.status = status;
    this.write(status, token);
  }

  private write(status: RecoveryStatus, token: number): void {
    if (token !== this.token) return;
    status.updatedAt = new Date(this.options.now()).toISOString();
    replaceFileAtomically(join(this.options.stateDir, '.daemon-recovery.json'),
      JSON.stringify(status, null, 2) + '\n', 0o600);
    this.options.log(`[${this.options.role}] daemon recovery ${status.state} epoch=${status.epoch || 'unavailable'}`);
  }
}
