import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { replaceFileAtomically } from '../atomic-file.js';
import type { ResolvedRoleLoop } from './config.js';

export interface LoopCounts {
  started: number; completed: number; failed: number; cancelled: number;
  skipped: number; skippedBusy: number; skippedMissed: number;
}

export interface LoopRuntimeState {
  definitionHash: string;
  promptHash: string;
  enabled: boolean;
  operatorDisabled: boolean;
  nextScheduledAt: string;
  nextDueAt: string;
  lastScheduledAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: string | null;
  lastCancellationSource: string | null;
  lastRunId: string | null;
  activeRunId: string | null;
  counts: LoopCounts;
  lastError: { kind: string; at: string } | null;
}

export interface ScheduledLoopsFile {
  version: 1;
  role: string;
  generation: string;
  clock: { lastWallMs: number };
  health: 'healthy' | 'degraded' | 'failed';
  anomaly: string | null;
  loops: Record<string, LoopRuntimeState>;
}

const zeroCounts = (): LoopCounts => ({
  started: 0, completed: 0, failed: 0, cancelled: 0,
  skipped: 0, skippedBusy: 0, skippedMissed: 0,
});

export const increment = (value: number, amount = 1): number =>
  Math.min(Number.MAX_SAFE_INTEGER, value + Math.max(0, amount));

export function deterministicJitter(
  role: string, loop: string, nominalMs: number, maximumMs: number,
): number {
  if (maximumMs <= 0) return 0;
  const digest = createHash('sha256').update(`${role}\0${loop}\0${nominalMs}`).digest();
  const value = digest.readUIntBE(0, 6);
  return value % (maximumMs + 1);
}

export function scheduledLoopsPath(stateDir: string): string {
  return join(stateDir, '.scheduled-loops.json');
}

export function readScheduledLoops(stateDir: string): ScheduledLoopsFile | undefined {
  try {
    const path = scheduledLoopsPath(stateDir);
    if (!safeStateFile(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as ScheduledLoopsFile;
    return validFile(value) ? value : undefined;
  } catch { return undefined; }
}

export class ScheduledLoopStateStore {
  readonly path: string;
  readonly fresh: boolean;
  state: ScheduledLoopsFile;

  constructor(
    stateDir: string, role: string, definitions: ResolvedRoleLoop[], now: number,
    private readonly log: (line: string) => void,
  ) {
    this.path = scheduledLoopsPath(stateDir);
    let restored: ScheduledLoopsFile | undefined;
    let corrupt = false;
    if (existsSync(this.path)) {
      try {
        if (!safeStateFile(this.path)) throw new Error('insecure scheduled-loop state');
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as ScheduledLoopsFile;
        if (!validFile(parsed) || parsed.role !== role) throw new Error('invalid scheduled-loop state');
        restored = parsed;
        chmodSync(this.path, 0o600);
      } catch {
        corrupt = true;
        try { renameSync(this.path, `${this.path}.corrupt-${now}`); } catch {}
      }
    }
    this.fresh = !restored;
    this.state = restored ?? {
      version: 1, role, generation: '', clock: { lastWallMs: now },
      health: corrupt ? 'degraded' : 'healthy', anomaly: corrupt ? 'corrupt_state_recovered' : null,
      loops: {},
    };
    this.reconcile(definitions, now, Boolean(restored));
    if (corrupt) this.log(`[${role}] scheduled loops recovered corrupt state; delayed cadence reinitialized`);
  }

  reconcile(definitions: ResolvedRoleLoop[], now: number, recoverActive = false): void {
    const next: Record<string, LoopRuntimeState> = {};
    for (const definition of definitions) {
      const old = this.state.loops[definition.name];
      if (old?.definitionHash === definition.definitionHash) {
        next[definition.name] = {
          ...old, promptHash: definition.promptHash, enabled: definition.enabled,
        };
      } else {
        const nominal = now + definition.initialDelayMs;
        next[definition.name] = {
          ...(old ?? {}),
          definitionHash: definition.definitionHash, promptHash: definition.promptHash,
          enabled: definition.enabled,
          nextScheduledAt: new Date(nominal).toISOString(),
          nextDueAt: new Date(nominal + deterministicJitter(
            definition.role, definition.name, nominal, definition.jitterMs)).toISOString(),
          lastScheduledAt: old?.lastScheduledAt ?? null,
          lastStartedAt: old?.lastStartedAt ?? null,
          lastFinishedAt: old?.lastFinishedAt ?? null,
          lastOutcome: old?.lastOutcome ?? null,
          lastCancellationSource: old?.lastCancellationSource ?? null,
          lastRunId: old?.lastRunId ?? null,
          activeRunId: old?.activeRunId ?? null,
          counts: old?.counts ?? zeroCounts(), lastError: old?.lastError ?? null,
          operatorDisabled: old?.operatorDisabled ?? false,
        };
      }
      if (recoverActive && next[definition.name].activeRunId) {
        const item = next[definition.name];
        item.counts.failed = increment(item.counts.failed);
        item.lastOutcome = 'abandoned_restart';
        item.lastFinishedAt = new Date(now).toISOString();
        item.lastError = { kind: 'abandoned_restart', at: new Date(now).toISOString() };
        item.activeRunId = null;
        this.state.health = 'degraded';
        this.state.anomaly = 'abandoned_restart';
      }
    }
    this.state.loops = next;
    this.state.generation = createHash('sha256').update(JSON.stringify(definitions.map(item => ({
      name: item.name, definitionHash: item.definitionHash, promptHash: item.promptHash,
    })))).digest('hex');
    this.state.clock.lastWallMs = now;
    this.persist();
  }

  persist(): void {
    replaceFileAtomically(this.path, JSON.stringify(this.state, null, 2) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }
}

function validFile(value: unknown): value is ScheduledLoopsFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as ScheduledLoopsFile;
  if (file.version !== 1 || typeof file.role !== 'string' || !file.clock
      || !Number.isSafeInteger(file.clock.lastWallMs) || !file.loops || typeof file.loops !== 'object')
    return false;
  return (file.health === 'healthy' || file.health === 'degraded' || file.health === 'failed')
    && (file.anomaly === null || typeof file.anomaly === 'string')
    && Object.values(file.loops).every(item => item && typeof item === 'object'
    && typeof item.definitionHash === 'string' && typeof item.promptHash === 'string'
    && typeof item.nextScheduledAt === 'string' && typeof item.nextDueAt === 'string'
    && Number.isFinite(Date.parse(item.nextScheduledAt)) && Number.isFinite(Date.parse(item.nextDueAt))
    && typeof item.enabled === 'boolean' && typeof item.operatorDisabled === 'boolean'
    && item.counts && Object.values(item.counts).every(count => Number.isSafeInteger(count) && count >= 0)
    && (item.activeRunId === null || typeof item.activeRunId === 'string'));
}

function safeStateFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600
      && (uid === undefined || stat.uid === uid);
  } catch { return false; }
}
