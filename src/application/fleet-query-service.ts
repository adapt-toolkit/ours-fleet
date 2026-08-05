import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupervisorBackend } from '../supervisor/types.js';
import { controlRequest } from '../session/control.js';
import { SessionControlError, type SessionSnapshot } from '../session/types.js';
import { readExitRecord, readRestartLedger } from '../runner.js';
import { Tmux } from '../tmux.js';
import { roleCapabilities, type CapabilityContext } from './capabilities.js';
import { FleetError } from './errors.js';
import { RoleRepository } from './role-repository.js';
import type { Problem, RoleCapabilities, RoleRecord, RoleStatus } from './types.js';

interface MonitorMarker {
  mode: 'fleet' | 'native' | 'unknown';
  health: 'armed' | 'degraded' | 'failed' | 'unknown';
  updatedAt?: string;
  detail?: string;
  stale: boolean;
}

const clean = (value: string, max = 512) =>
  value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);

function boundedText(path: string, max = 16 * 1024): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) return undefined;
    return readFileSync(path, 'utf8');
  } catch { return undefined; }
}

function readMonitor(dir: string, now = Date.now()): MonitorMarker {
  const owner = clean(boundedText(join(dir, '.monitor-owner'), 64) ?? '');
  const raw = clean(boundedText(join(dir, '.monitor-status')) ?? '');
  const statAt = (() => {
    try { return lstatSync(join(dir, '.monitor-status')).mtime.toISOString(); } catch { return undefined; }
  })();
  const lower = raw.toLowerCase();
  const health = /fail|error/.test(lower) ? 'failed'
    : /degrad|api error/.test(lower) ? 'degraded'
    : raw ? 'armed' : 'unknown';
  const stale = statAt ? now - Date.parse(statAt) > 60_000 : true;
  return {
    mode: owner === 'fleet' || owner === 'native' ? owner : 'unknown',
    health, updatedAt: statAt, detail: raw || undefined, stale,
  };
}

function readIsolation(dir: string): { degraded: boolean; detail?: string } {
  const text = boundedText(join(dir, '.isolation-degraded'));
  return text ? { degraded: true, detail: clean(text) } : { degraded: false };
}

function sessionOverall(
  supervisor: RoleStatus['supervisor'], session: RoleStatus['session'],
  restart: RoleStatus['restart'], monitor: RoleStatus['monitor'],
  isolation: RoleStatus['isolation'], problems: Problem[],
): RoleStatus['overall'] {
  if (restart.circuit === 'open' || monitor.health === 'failed' || monitor.health === 'degraded'
      || isolation.degraded
      || problems.some(problem => problem.severity === 'error' || problem.source === 'watchdog')
      || session.readiness === 'failed') return 'attention';
  // A reachable ACP/tmux session is the user's live interaction surface. Its
  // evidence remains authoritative even when a service manager no longer owns
  // the process (for example, a detached ACP session with an inactive unit).
  if (session.reachability === 'online'
      && (session.readiness === 'running' || session.readiness === 'awaiting_permission'))
    return 'busy';
  if (session.reachability === 'online' && session.readiness === 'idle') return 'ready';
  if (session.reachability === 'offline'
      && (session.evidence === 'authoritative' || supervisor.liveness === 'stopped'))
    return 'offline';
  return 'unknown';
}

export interface FleetQueryOptions {
  repository: RoleRepository;
  supervisor: SupervisorBackend;
  tmux?: Tmux;
  control?: typeof controlRequest;
  capabilityContext?: CapabilityContext;
  /**
   * Watchdog anomalies feeding into Needs Attention (Task 19): roleId -> worst
   * current finding across all watchdogs. Optional and absent by default so
   * every pre-existing caller (and its tests) is unaffected; runtime.ts wires
   * the real provider, built from watchdog reports on disk.
   */
  watchdogFindings?: () => Map<string, { watchdog: string; status: string; reason: string }>;
}

export class FleetQueryService {
  private readonly tmux: Tmux;
  private readonly control: typeof controlRequest;
  constructor(private readonly options: FleetQueryOptions) {
    this.tmux = options.tmux ?? new Tmux();
    this.control = options.control ?? controlRequest;
  }

  async list(): Promise<Array<{ role: RoleRecord; status: RoleStatus; capabilities: RoleCapabilities }>> {
    const roles = await this.options.repository.list();
    return Promise.all(roles.map(async role => {
      const status = await this.status(role);
      return { role, status, capabilities: roleCapabilities(role, status, this.options.capabilityContext) };
    }));
  }

  async detail(id: string): Promise<{ role: RoleRecord; status: RoleStatus; capabilities: RoleCapabilities }> {
    const role = await this.options.repository.get(id);
    if (!role) throw new FleetError('role_not_found', `no such role '${id}'`, { provesOffline: false });
    const status = await this.status(role);
    return { role, status, capabilities: roleCapabilities(role, status, this.options.capabilityContext) };
  }

  async status(role: RoleRecord): Promise<RoleStatus> {
    const observedAt = new Date().toISOString();
    const live = await this.options.supervisor.liveness(role.id)
      .catch(error => ({ state: 'unknown' as const, detail: (error as Error).message }));
    const dir = this.options.repository.stateDir(role);
    const restart = dir ? readRestartLedger(dir) : {
      circuit: 'closed' as const, consecutiveImmediateFailures: 0, nextDelayMs: 0,
      lastReason: '', openedAt: undefined,
    };
    const monitor = dir ? readMonitor(dir) : {
      mode: 'unknown' as const, health: 'unknown' as const, stale: true,
    };
    const isolation = dir ? readIsolation(dir) : { degraded: false };
    const lastExit = dir ? readExitRecord(join(dir, '.exit-status')) ?? undefined : undefined;
    const session = await this.session(role, dir, live.state);
    const problems = [...role.problems];
    if (live.state === 'running' && session.reachability !== 'online')
      problems.push({
        code: 'supervisor_session_disagreement', severity: 'warning',
        detail: 'supervisor is live but the session is not reachable',
      });
    if (role.lifetime === 'permanent' && live.state === 'stopped'
        && session.reachability === 'online')
      problems.push({
        code: 'session_supervisor_disagreement', severity: 'warning',
        detail: 'session is live while its permanent supervisor service is inactive',
      });
    const watchdogFinding = this.options.watchdogFindings?.().get(role.id);
    if (watchdogFinding)
      problems.push({
        code: 'watchdog_finding', severity: 'warning',
        detail: `${watchdogFinding.watchdog}: ${watchdogFinding.status} — ${watchdogFinding.reason}`,
        source: 'watchdog',
      });
    const supervisor = {
      backend: this.options.supervisor.id, liveness: live.state,
      nativeState: live.detail.split(/\s/)[0], detail: clean(live.detail),
    };
    return {
      roleId: role.id, observedAt,
      overall: sessionOverall(supervisor, session, restart, monitor, isolation, problems),
      supervisor, session,
      restart: {
        circuit: restart.circuit,
        consecutiveImmediateFailures: restart.consecutiveImmediateFailures,
        nextDelayMs: restart.nextDelayMs,
        lastReason: restart.lastReason || undefined,
        openedAt: restart.openedAt,
      },
      monitor, lastExit, isolation, problems,
    };
  }

  private async session(
    role: RoleRecord, dir: string | undefined, supervisor: 'running' | 'stopped' | 'unknown',
  ): Promise<RoleStatus['session']> {
    const intended = role.configuredBackend;
    if (intended === 'acp' && dir) {
      try {
        const response = await this.control(dir, { command: 'snapshot' }, 2_000);
        if (!response.ok) throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'snapshot failed');
        const snapshot = response.result as SessionSnapshot & {
          protocolVersion?: number; features?: string[];
        };
        return {
          backend: 'acp', reachability: snapshot.alive ? 'online' : 'offline',
          readiness: snapshot.readiness, evidence: 'authoritative',
          sessionId: snapshot.sessionId, lastError: snapshot.lastError,
          pendingPermissionId: snapshot.pendingPermissionId,
          protocolVersion: snapshot.protocolVersion, features: snapshot.features,
          runtimeModel: snapshot.runtimeModel, reasoningEffort: snapshot.reasoningEffort,
        };
      } catch (error) {
        const failure = error instanceof SessionControlError ? error.kind : 'backend';
        const offline = failure === 'offline';
        return {
          backend: 'acp',
          reachability: offline ? 'offline'
            : failure === 'control-unavailable' ? 'unavailable' : 'unknown',
          readiness: offline ? 'failed' : 'unknown',
          evidence: 'authoritative', lastError: clean((error as Error).message),
        };
      }
    }
    if (intended === 'tmux' || role.detectedBackend === 'tmux') {
      try {
        const has = await this.tmux.has(role.id);
        return {
          backend: 'tmux', reachability: has ? 'online' : supervisor === 'stopped' ? 'offline' : 'unknown',
          readiness: has ? 'idle' : supervisor === 'running' ? 'starting' : 'failed',
          evidence: 'inferred',
        };
      } catch (error) {
        return {
          backend: 'tmux', reachability: 'unknown', readiness: 'unknown',
          evidence: 'inferred', lastError: clean((error as Error).message),
        };
      }
    }
    return {
      backend: 'unknown', reachability: supervisor === 'stopped' ? 'offline' : 'unknown',
      readiness: supervisor === 'stopped' ? 'failed' : 'unknown', evidence: 'inferred',
    };
  }
}
