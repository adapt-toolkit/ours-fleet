import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  attachOursClient, type AttachOursClientOptions, type OursClient,
} from '@ours.network/sdk/client';

import { classifyIdentityPresence, type FetchLike, type IdentityPresence } from './monitor.js';
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
  requestSignal?: AbortSignal;
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
  try {
    const { identities: _identities, ...generation } = await probeSelectedDaemon(deps, readClientProfile(env));
    return generation;
  }
  catch { return { state: 'unavailable', reason: 'CLIENT_GATEWAY_PROFILE_INVALID' }; }
}

/** Container selection uses public SDK reads; daemon paths/PIDs remain opaque metadata. */
async function probeSelectedDaemon(
  deps: GenerationProbeDeps,
  profile: ExplicitClientProfile,
): Promise<DaemonGenerationProbe & { identities?: unknown[] }> {
  // Defer credential-file access to SDK selection, which checks the configured
  // daemon identity/capability before it reads or sends the credential.
  let client: Pick<OursClient, 'version' | 'identities' | 'close'> | undefined;
  try {
    const options: AttachOursClientOptions = {
      endpoint: profile.endpoint, expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath,
      sessionMode: 'external', leaseToken: randomUUID(), env: {}, requestSignal: deps.requestSignal,
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
    return {state:'ready', identities, generation:{
      bootId:progress.bootId, pid:progress.pid, startedAt:progress.startedAt, stateDir:info.stateDir,
    }};
  } catch {
    // Failed selection, auth or transport is unavailable, never owner death.
    return {state:'unavailable', reason:'DAEMON_SELECTED_PROBE_UNAVAILABLE'};
  } finally { await client?.close().catch(() => undefined); }
}

export interface SelectedDaemonHealthSnapshot {
  generation: DaemonGenerationProbe;
  identities?: unknown[];
}

export interface SelectedDaemonHealthLease {
  sample(): Promise<SelectedDaemonHealthSnapshot>;
  presence(name: string, snapshot: SelectedDaemonHealthSnapshot): IdentityPresence;
  release(): void;
}

interface SelectedHealthOwner {
  consumers: number;
  sample(): Promise<SelectedDaemonHealthSnapshot>;
  stop(): void;
}
const selectedHealthOwners = new Map<string, SelectedHealthOwner>();
const unavailableHealth = (reason: string): SelectedDaemonHealthSnapshot => ({
  generation: { state: 'unavailable', reason },
});

/** Retained runtime health, independent of browser delivery and stream readiness. */
export function acquireSelectedDaemonHealth(
  env: NodeJS.ProcessEnv, deps: GenerationProbeDeps = {},
): SelectedDaemonHealthLease {
  let profile: ExplicitClientProfile;
  try { profile = readClientProfile(env); }
  catch {
    return {
      sample: async () => unavailableHealth('CLIENT_GATEWAY_PROFILE_INVALID'),
      presence: () => ({ state: 'unknown', detail: 'selected daemon unavailable' }),
      release: () => {},
    };
  }
  // Credentials are part of the selection boundary, not merely endpoint identity.
  const key = JSON.stringify([profile.endpoint, profile.expectedInstanceId, profile.credentialPath]);
  let owner = selectedHealthOwners.get(key);
  if (!owner) {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let current: SelectedDaemonHealthSnapshot | undefined;
    let nextProbeAt = 0;
    let pending: Promise<SelectedDaemonHealthSnapshot> | undefined;
    let cancelProbe: (() => void) | undefined;
    const run = (): Promise<SelectedDaemonHealthSnapshot> => {
      let client: Pick<OursClient, 'version' | 'identities' | 'close'> | undefined;
      let closed = false;
      let cancelled = false;
      const request = new AbortController();
      const close = async () => {
        if (client && !closed) { closed = true; await client.close().catch(() => undefined); }
      };
      let deadline: NodeJS.Timeout | undefined;
      const interrupted = new Promise<SelectedDaemonHealthSnapshot>(resolve => {
        cancelProbe = () => {
          cancelled = true;
          request.abort();
          void close();
          resolve(unavailableHealth('DAEMON_SELECTED_PROBE_UNAVAILABLE'));
        };
        deadline = setTimeout(cancelProbe, 10_000);
        deadline.unref?.();
      });
      const probe = probeSelectedDaemon({ ...deps, requestSignal: request.signal, attachClient: async options => {
        client = await (deps.attachClient?.(options) ?? attachOursClient(options));
        if (cancelled) { void close(); throw new Error('health probe cancelled'); }
        return { version: (...args) => client!.version(...args),
          identities: () => client!.identities(), close };
      } }, profile).then(({ identities, ...generation }) => ({ generation, identities }));
      pending = Promise.race([probe, interrupted]).then(snapshot => {
        if (!stopped) current = snapshot;
        return snapshot;
      }).finally(() => {
        if (deadline) clearTimeout(deadline);
        cancelProbe = undefined;
        pending = undefined;
        if (!stopped) {
          nextProbeAt = Date.now() + 2_000;
          timer = setTimeout(() => { void run(); }, 2_000);
          timer.unref?.();
        }
      });
      return pending;
    };
    owner = {
      consumers: 0,
      sample: () => {
        if (pending) return pending;
        if (current && Date.now() < nextProbeAt) return Promise.resolve(current);
        // A delayed timer after process suspension cannot certify old absence.
        if (timer) clearTimeout(timer);
        return run();
      },
      stop: () => { stopped = true; if (timer) clearTimeout(timer); cancelProbe?.(); },
    };
    selectedHealthOwners.set(key, owner);
    void run();
  }
  const retained = owner;
  retained.consumers++;
  let released = false;
  return {
    sample: () => released ? Promise.resolve(unavailableHealth('HEALTH_OWNER_RELEASED')) : retained.sample(),
    presence: (name, snapshot) => snapshot.generation.state === 'ready'
      ? classifyIdentityPresence(name, snapshot.identities)
      : { state: 'unknown', detail: 'selected daemon unavailable' },
    release: () => {
      if (released) return;
      released = true;
      if (--retained.consumers === 0) { retained.stop(); selectedHealthOwners.delete(key); }
    },
  };
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
