import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  runOnce, runTemp, runSupervised, reserveLaunchSlot, readExitRecord,
  readRestartLedger, resetRestartLedger, writeRestartLedger, backoffFor, loadTempRole,
  RESTART_FAIL_THRESHOLD, RUN_MARKER_FILE,
  TEMP_IDENTITY_CLOSE_DEBOUNCE_MS, TEMP_IDENTITY_POLL_MS,
  isRecoverableTempStartupCancellation, managedFleetProxyEnv,
  SUPERVISOR_RECYCLE_REQUIRED, SupervisorRecycleRequiredError,
  type AttemptResult, type RunnerDeps,
} from '../src/runner.js';
import {
  ACP_CANCEL_DEADLINE_EXCEEDED, classifyChildExit, classifyShellStatus, turnResult,
  type ExitRecord, type SessionHandle, type TurnResult,
} from '../src/session/types.js';
import { registerAdapter } from '../src/harness/registry.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { fakeAdapter } from './registry.test.js';
import type { Exec } from '../src/exec.js';
import type { HarnessAdapter } from '../src/harness/types.js';
import type { MonitorOpts } from '../src/monitor.js';
import {
  OwnerBinderConflictError, OwnerBinderHandoffTimeoutError,
} from '../src/owner-channel/binder.js';
import { prepareTempSupervisor } from '../src/temp-lifecycle.js';
import type { ResolvedRole } from '../src/config.js';
import { AcpSession } from '../src/session/acp.js';
import { writeV2Fixture } from './v2-fixture.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-run-'));
  process.env.OURS_FLEET_HOME = dir;
  registerAdapter(fakeAdapter);
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/** Records the monitor lifecycle the runner drives, and proves prime happens
 *  before the agent session is created. */
function monitorRecorder(sessionCreated: () => boolean) {
  const rec = {
    constructed: 0,
    primedBeforeSession: null as boolean | null,
    resetCursor: null as boolean | null,
    ranPid: null as number | null,
    stopped: false,
    env: null as NodeJS.ProcessEnv | null,
  };
  const createMonitor = (opts: MonitorOpts) => {
    rec.constructed++;
    rec.env = opts.deps.env;
    return {
      prime: async options => {
        rec.primedBeforeSession = !sessionCreated();
        rec.resetCursor = options?.resetCursor ?? false;
      },
      run: async (pid: number) => { rec.ranPid = pid; },
      stop: () => { rec.stopped = true; },
    };
  };
  return { rec, createMonitor };
}

/** Fake agent session that dies after `lifeChecks` liveness polls and writes
 * `.exit-status` at the moment of death. */
function fakeWorld(opts: { exitCode?: string; lifeChecks?: number; exitDelayMs?: number; exitFile?: string; rawExitRecord?: string; exitResult?: ExitRecord | null; bwrap?: 'ok' | 'missing'; cpuDelegated?: boolean; legacyExitFile?: boolean; sessionGone?: boolean; recoveryGate?: Promise<void> } = {}) {
  const paneCommands: string[] = [];
  const recoveryPrompts: string[] = [];
  const starts: Array<{ mode: 'fresh' | 'resume'; argv: string[]; env: Record<string, string> }> = [];
  let clock = 0;
  let checks = 0;
  let sessionCreated = false;
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'bwrap') return { stdout: 'bubblewrap 0.11.1\n', stderr: '', code: opts.bwrap === 'missing' ? 127 : 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const { rec, createMonitor } = monitorRecorder(() => sessionCreated);
  const deps = {
    exec,
    cpuDelegated: () => opts.cpuDelegated ?? true,
    probeGeneration: async () => ({ state: 'ready' as const, generation: {
      bootId: 'test-boot', pid: 1, startedAt: 1, stateDir: dir,
    } }),
    isAlive: () => {
      checks++;
      if (checks >= (opts.lifeChecks ?? 2)) {
        if (opts.exitFile) writeFileSync(opts.exitFile, opts.rawExitRecord ?? (opts.legacyExitFile
          ? (opts.exitCode ?? '0') + '\n'                       // pre-upgrade `echo $?`
          : JSON.stringify({ version: 1, backend: 'acp', status: Number(opts.exitCode ?? '0') })));
        return false;
      }
      return true;
    },
    sleep: async (ms: number) => { clock += opts.exitDelayMs ?? ms; },
    now: () => clock,
    log: () => {},
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ cursor: 0, events: [] }) }),
    createMonitor,
    startAgentSession: async (_adapter: unknown, options: { mode: 'fresh' | 'resume'; launch: { argv: string[]; env: Record<string, string> } }) => {
      sessionCreated = true;
      paneCommands.push(options.launch.argv.join(' '));
      starts.push({ mode: options.mode, argv: options.launch.argv, env: options.launch.env });
      let closed = false;
      let seq = 0;
      const conversationListeners = new Set<(event: any) => void>();
      const emit = (event: any) => conversationListeners.forEach(listener => listener({
        schemaVersion: 1, roleId: 'A', eventId: `event-${++seq}`, seq,
        at: '2026-08-30T00:00:00Z', sessionGeneration: 'fake-generation', ...event,
      }));
      return {
        backend: 'acp' as const,
        pid: 4242,
        isAlive: () => {
          if (closed) return false;
          checks++;
          return checks < (opts.lifeChecks ?? 2);
        },
        snapshot: () => ({ backend: 'acp' as const, alive: !closed, readiness: 'idle' as const }),
        queuePrompt: async (text: string) => {
          const promptId = text.includes('[fleet-recovery]') ? `recovery-${seq}` : 'fake-prompt';
          if (text.includes('[fleet-recovery]')) {
            recoveryPrompts.push(text);
            await opts.recoveryGate;
            emit({ kind: 'prompt.admitted', promptId, payload: { queuedBehind: 0 } });
            for (const [toolCallId, title, rawInput] of [
              ['choose', 'choose_identity', { name: 'A', force: false }],
              ['current', 'current_identity', {}],
              ['messages', 'get_messages', {}],
            ] as const) emit({
              kind: 'tool.upsert', promptId, toolCallId,
              payload: { toolCallId, snapshot: true, title, status: 'completed',
                rawInput: { json: rawInput, bytes: 2 } },
            });
            emit({ kind: 'turn.completed', promptId, payload: { outcome: 'completed' } });
          }
          return {
            promptId, queuedBehind: 0,
            completion: Promise.resolve(turnResult(true, 'completed')),
          };
        },
        submitPrompt: async () => turnResult(true, 'completed'),
        interrupt: async () => ({ state: 'settled' as const }),
        respondPermission: () => true,
        eventsSince: () => [],
        subscribe: () => () => {},
        subscribeConversation: (listener: (event: any) => void) => {
          conversationListeners.add(listener); return () => conversationListeners.delete(listener);
        },
        setControllerAttached: () => {},
        exitResult: () => Object.prototype.hasOwnProperty.call(opts, 'exitResult')
          ? opts.exitResult!
          : opts.sessionGone
            ? { version: 1 as const, class: 'session-destroyed' as const,
                detail: 'session no longer exists' }
            : opts.rawExitRecord === ACP_CANCEL_DEADLINE_EXCEEDED
              ? { version: 1 as const, class: 'cancelled' as const,
                  detail: ACP_CANCEL_DEADLINE_EXCEEDED }
              : classifyShellStatus(Number(opts.exitCode ?? 0)),
        close: async () => { closed = true; },
      };
    },
  };
  return { deps, paneCommands, starts, monitor: rec, recoveryPrompts };
}

const writeCfg = (roles: Record<string, object>) =>
  writeV2Fixture(join(dir, 'fleet.yaml'), { roles });

describe('managed fleet child environment', () => {
  it('does not register fleet lifecycle spawning for a room member', async () => {
    const name = 'RoomMember';
    const d = agentDir(name, true); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name, harness: 'fake', session: 'acp', identity: name, sourceFile: '(temp)',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64), identity_name: name,
        invite_id: 'invite-1', invite: 'secret', role: 'LocalCoordinator',
        task: 'Coordinate.', owner_seat_cid: null,
      },
    }));
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    const registered: unknown[] = [];
    await runOnce(name, { temp: true }, { ...deps, createControlServer: () => ({
      start: async () => {}, close: async () => {},
      setFleetSpawner: value => { registered.push(value); }, setFleetAuditor: () => {},
      setOwnerChannel: () => {}, setConfigReloader: () => {}, setLoopManager: () => {},
    }) });
    expect(registered).toEqual([]);
  });

  it('keeps fleet lifecycle spawning registered for a persistent Coordinator', async () => {
    writeCfg({ Coordinator: { harness: 'fake', session: 'acp' } });
    const d = agentDir('Coordinator'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    const registered: unknown[] = [];
    await runOnce('Coordinator', {}, { ...deps, createControlServer: () => ({
      start: async () => {}, close: async () => {},
      setFleetSpawner: value => { registered.push(value); }, setFleetAuditor: () => {},
      setOwnerChannel: () => {}, setConfigReloader: () => {}, setLoopManager: () => {},
    }) });
    expect(registered).toHaveLength(1); expect(registered[0]).toBeTypeOf('function');
  });

  it('installs a durable local auditor before control startup for a no-owner temporary watchdog role', async () => {
    const name = 'Watchdog-fleet-health';
    const d = agentDir(name, true); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name, harness: 'fake', session: 'acp', identity: name, sourceFile: '(temp)',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
    }));
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    let auditor: any;
    await runOnce(name, { temp: true }, { ...deps, createControlServer: () => ({
      start: async () => {
        expect(auditor).toBeDefined();
        const begun = await auditor.begin('11111111-1111-4111-8111-111111111111',
          ['status', '--token', 'private']);
        await auditor.finish({ correlationId: begun.correlationId,
          class: 'success', effect: 'completed', exitCode: 0 });
      },
      close: async () => {}, setFleetSpawner: () => {},
      setFleetAuditor: value => { auditor = value; }, setOwnerChannel: () => {},
      setConfigReloader: () => {}, setLoopManager: () => {},
    }) });
    const ledger = JSON.parse(readFileSync(join(d, '.fleet-command-audit.json'), 'utf8'));
    expect(ledger.attempts).toHaveLength(1);
    expect(ledger.attempts[0]).toMatchObject({ caller: name, invocation: 'delivered',
      classification: { route: 'supervisor-proxy/read-only', decision: 'allow' },
      argv: ['status', '--token', '[REDACTED:value]'],
      outcome: { class: 'success', effect: 'completed', delivery: 'delivered' } });
  });

  it('closes the child and never starts control when the local audit ledger is invalid', async () => {
    writeCfg({ A: { harness: 'fake', session: 'acp' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.fleet-command-audit.json'), '{"version":2,"attempts":[]}\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    const startSession = deps.startAgentSession;
    const closed = vi.fn();
    deps.startAgentSession = async (...args: Parameters<typeof startSession>) => {
      const session = await startSession(...args);
      const close = session.close.bind(session);
      session.close = async () => { closed(); await close(); };
      return session;
    };
    const controlStarted = vi.fn();
    await expect(runOnce('A', {}, { ...deps, createControlServer: () => ({
      start: async () => { controlStarted(); }, close: async () => {}, setFleetSpawner: () => {},
      setFleetAuditor: () => {}, setOwnerChannel: () => {}, setConfigReloader: () => {},
      setLoopManager: () => {},
    }) })).rejects.toThrow(/invalid fleet command audit ledger/);
    expect(closed).toHaveBeenCalledOnce();
    expect(controlStarted).not.toHaveBeenCalled();
  });

  it('installs the owner-backed auditor before control startup and never swaps it', async () => {
    writeCfg({ A: { harness: 'fake', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    let ownerStarted = false;
    const begin = vi.fn(async () => {
      expect(ownerStarted).toBe(false);
      return { correlationId: 'owner-correlation', invocation: 'delivered' } as any;
    });
    deps.createOwnerChannel = () => ({
      start: async () => { ownerStarted = true; }, drain: async () => {}, close: async () => {},
      manage: async () => { throw new Error('not used'); }, beginFleetCommandAudit: begin,
      finishFleetCommandAudit: async () => ({}) as any,
    });
    let auditor: any;
    let registrations = 0;
    await runOnce('A', {}, { ...deps, createControlServer: () => ({
      start: async () => {
        expect(auditor).toBeDefined();
        await auditor.begin('22222222-2222-4222-8222-222222222222', ['status']);
      },
      close: async () => {}, setFleetSpawner: () => {},
      setFleetAuditor: value => { auditor = value; registrations++; },
      setOwnerChannel: () => {}, setConfigReloader: () => {}, setLoopManager: () => {},
    }) });
    expect(begin).toHaveBeenCalledOnce();
    expect(ownerStarted).toBe(true);
    expect(registrations).toBe(1);
  });

  it.each(['', '0', '1'])
  ('actively omits supervised ACP OURS_AUTOSTART=%j and preserves sibling env', value => {
    const role = {
      name: 'A', harness: 'fake', session: 'acp', identity: 'A', sourceFile: 'x',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      permissionsDeclared: false,
      monitor: {
        mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 2_000,
        inject: 'notification', interrupt: false, turn_fail_threshold: 3,
      },
      env: { OURS_AUTOSTART: value, FLEET_SIBLING_ENV: 'kept' },
    } satisfies ResolvedRole;
    const env = managedFleetProxyEnv(role, '/state');
    expect(env).not.toHaveProperty('OURS_AUTOSTART');
    expect(env.FLEET_SIBLING_ENV).toBe('kept');
  });
});

describe('runOnce isolation', () => {
  it('wraps the agent command under bwrap when the role declares isolation', async () => {
    writeCfg({ A: { harness: 'fake', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).toContain('bwrap');
    expect(paneCommands[0]).toMatch(/--.*fakebin/);      // original argv after --
  });

  it('resolves and read-only binds a home-scoped agent launcher', async () => {
    const binDir = join(dir, '.local', 'bin');
    const launcher = join(binDir, 'home-launcher');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    registerAdapter({
      ...fakeAdapter,
      id: 'home-runtime',
      agentSession: {
        ...fakeAdapter.agentSession,
        prepareLaunch: (_role, prep) => ({ argv: ['home-launcher'], env: prep.env }),
      },
    });
    writeCfg({ A: { harness: 'home-runtime', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try { await runOnce('A', {}, deps); }
    finally { process.env.PATH = oldPath; }
    expect(paneCommands[0]).toContain(`--ro-bind-try ${launcher} ${launcher}`);
    expect(paneCommands[0]).toMatch(new RegExp(`--.*${launcher}`));
  });

  it('does not wrap when the role has no isolation block', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).not.toContain('bwrap');
    expect(paneCommands[0]).toContain('fakebin');
  });

  it('still captures the exit code from a wrapped role', async () => {
    writeCfg({ A: { harness: 'fake', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    // clean exit (code 0) rotates the session-id, proving exit capture worked
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
  });

  it('degrades to un-isolated (no bwrap) when the backend is unavailable under warn', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'warn' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).not.toContain('bwrap');
    expect(paneCommands[0]).toContain('fakebin');
  });

  it('strict + unavailable backend refuses to launch', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'strict' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await expect(runOnce('A', {}, deps)).rejects.toThrow(/strict|unavailable|refus/i);
  });

  it('composes a systemd-run resource scope OUTSIDE the sandbox when resources are set', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { resources: { mem: '256M', cpu: '1', pids: 128 } } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), cpuDelegated: true });
    await runOnce('A', {}, deps);
    const cmd = paneCommands[0];
    expect(cmd).toContain('systemd-run');
    expect(cmd).toContain('MemoryMax=256M');
    expect(cmd).toContain('CPUQuota=100%');
    expect(cmd).toContain('TasksMax=128');
    expect(cmd.indexOf('systemd-run')).toBeLessThan(cmd.indexOf('bwrap')); // resource scope is outermost
  });

  it('degrades cpu cap to a warning when the cpu controller is not delegated', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { resources: { mem: '256M', cpu: '2' } } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), cpuDelegated: false });
    await runOnce('A', {}, deps);
    const cmd = paneCommands[0];
    expect(cmd).toContain('MemoryMax=256M');   // mem still enforced
    expect(cmd).not.toContain('CPUQuota');       // cpu dropped
  });

  it('applies resource caps even when the sandbox degrades to none', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'warn', resources: { mem: '128M' } } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await runOnce('A', {}, deps);
    const cmd = paneCommands[0];
    expect(cmd).not.toContain('bwrap');          // sandbox degraded
    expect(cmd).toContain('systemd-run');        // but resources still capped
    expect(cmd).toContain('MemoryMax=128M');
  });

  it('writes a .isolation-degraded marker when isolation degrades under warn', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'warn' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await runOnce('A', {}, deps);
    const marker = join(d, '.isolation-degraded');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toMatch(/bubblewrap|bwrap|unavailable/i);
  });

  it('clears a stale .isolation-degraded marker when isolation succeeds', async () => {
    writeCfg({ A: { harness: 'fake', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.isolation-degraded'), 'stale\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(existsSync(join(d, '.isolation-degraded'))).toBe(false);
  });
});

describe('daemon generation recovery integration', () => {
  it('does not report active recovery after an ordinary clean persistent shutdown', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const world = fakeWorld({ lifeChecks: 4, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, world.deps);
    expect(existsSync(join(d, '.daemon-recovery.json'))).toBe(false);
  });

  it('observes baseline before session, collapses loss/change, and proves one exact recovery turn', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const world = fakeWorld({ lifeChecks: 10, exitFile: join(d, '.exit-status') });
    const generations = [
      { state: 'ready' as const, generation: { bootId: 'boot-1', pid: 1, startedAt: 1, stateDir: dir } },
      { state: 'unavailable' as const, reason: 'DAEMON_INFO_UNREACHABLE' },
      { state: 'ready' as const, generation: { bootId: 'boot-2', pid: 2, startedAt: 2, stateDir: dir } },
    ];
    let probes = 0;
    world.deps.probeGeneration = async () => generations[Math.min(probes++, generations.length - 1)];
    await runOnce('A', {}, world.deps);
    expect(world.recoveryPrompts).toHaveLength(1);
    expect(world.recoveryPrompts[0]).toContain('force false');
    const statusPath = join(d, '.daemon-recovery.json');
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statusPath, 'utf8'))).toMatchObject({
      identity: 'A', state: 'recovered',
      paths: { agent: { state: 'recovered', attempts: 1 }, owner: { state: 'recovered', attempts: 1 } },
    });
    expect(readFileSync(join(d, '.session-id'), 'utf8')).toBeTruthy();
  });
});

describe('runOnce', () => {
  it('applies default lossless worklog rotation before launching the role', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const original = 'HISTORICAL-START\n' + 'old line\n'.repeat(140_000)
      + 'RESTART-CONTINUITY ž 🧪\n';
    writeFileSync(join(d, 'WORKLOG.md'), original);
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });

    await runOnce('A', {}, deps);

    const active = readFileSync(join(d, 'WORKLOG.md'), 'utf8');
    expect(Buffer.byteLength(active)).toBeLessThanOrEqual(256 * 1024);
    expect(active).toContain('RESTART-CONTINUITY ž 🧪');
    const archive = readdirSync(d).find(name => /^WORKLOG\..+\.md$/.test(name));
    expect(archive).toBeDefined();
    expect(readFileSync(join(d, archive!), 'utf8')).toBe(original);
    const provenance = JSON.parse(readFileSync(join(d, '.worklog-rotation.json'), 'utf8'));
    expect(provenance).toMatchObject({
      archive, archiveContainsFullSnapshot: true,
      olderArchives: 'WORKLOG.archives', recentArchiveLimit: 12,
    });
  });

  it('upgrades legacy temp snapshots to explicit monitor ownership', () => {
    const d = agentDir('OldTemp', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name: 'OldTemp',
      harness: 'fake',
      session: 'acp',
      identity: 'OldTemp',
      sourceFile: '(temp)',
      monitor: {
        enabled: true,
        wake_sources: ['message_received'],
        batch_ms: 2000,
        inject: 'notification',
      },
    }));

    expect(loadTempRole('OldTemp').monitor)
      .toMatchObject({ mode: 'fleet', enabled: true, interrupt: false });
  });

  it('fresh boot writes markers and launches with fresh args', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps, paneCommands, starts } = fakeWorld({ exitCode: '1', lifeChecks: 30, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(existsSync(join(d, '.session-id'))).toBe(true);
    expect(starts[0].mode).toBe('fresh');
    expect(paneCommands[0]).toContain('--fake-prep');
    expect(starts[0].env).toMatchObject({ FAKE: '1' });
    // crash (code 1, slow) keeps .booted → next run resumes
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('clean exit rotates session-id and clears .booted', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
    expect(existsSync(join(d, '.booted'))).toBe(false);
  });

  it('fast-failing resume self-heals to fresh', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps, starts } = fakeWorld(
      { exitCode: '1', exitDelayMs: 100, exitFile: join(d, '.exit-status') }); // dies ~0.2s < 20s
    await runOnce('A', {}, deps);
    expect(starts[0].mode).toBe('resume');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
    expect(existsSync(join(d, '.booted'))).toBe(false);
  });

  it('keeps resume state when a resumed cancellation recovery fails fast again', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({
      exitDelayMs: 100,
      exitFile: join(d, '.exit-status'),
      // AcpSession supplies this typed reason directly in its ExitRecord. The
      // malformed legacy record is only a deterministic seam for giving runOnce
      // the same detail without a real adapter or a cancellation timer.
      rawExitRecord: ACP_CANCEL_DEADLINE_EXCEEDED,
    });

    const result = await runOnce('A', {}, deps);

    expect(result).toMatchObject({ mode: 'resume', rotated: false });
    expect(result.exit.detail).toContain(ACP_CANCEL_DEADLINE_EXCEEDED);
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).toBe('KEEP');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('slow crash keeps resume state', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');
    // 30 liveness checks × 2000ms simulated = 60s > fastFailSecs
    const { deps } = fakeWorld({ exitCode: '137', lifeChecks: 30, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).toBe('KEEP');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  /**
   * FleetRetrospector's `.booted` still read 07:05:43 after its 07:35:57
   * restart, because `.booted` was only written on the fresh path. Any health
   * check reading it reported the original boot for a role that had restarted.
   */
  it('stamps .booted on a resume attempt, not just the first boot', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');            // an earlier boot's marker
    const { deps } = fakeWorld({ exitCode: '137', lifeChecks: 30, exitFile: join(d, '.exit-status') });

    const result = await runOnce('A', {}, deps);

    expect(result.mode).toBe('resume');               // existence semantics preserved
    const stamped = readFileSync(join(d, '.booted'), 'utf8').trim();
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z resume$/);
  });
});

describe('creation-time isolation reaches the FIRST launch', () => {
  it("a role whose config carries `isolation` is sandbox-wrapped on its first start", async () => {
    // This is the property --isolation-file exists for: the very first process
    // is confined, not the one after the operator edits fleet.yaml.
    writeCfg({ Sec: { harness: 'fake', isolation: { network: 'deny' } } });
    const d = agentDir('Sec');
    mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('Sec', {}, deps);
    expect(paneCommands[0]).toContain('bwrap');
    expect(paneCommands[0]).toContain('--unshare-net');      // network: deny honoured
    expect(paneCommands[0]).toMatch(/--.*fakebin/);
  });
});

describe('exit classification', () => {
  const readRecord = (d: string) =>
    JSON.parse(readFileSync(join(d, '.exit-status'), 'utf8')) as { class: string; detail: string };

  it('classifies a shell wait status into clean, program-exit, or signal', () => {
    expect(classifyShellStatus(0)).toMatchObject({ class: 'clean', code: 0 });
    expect(classifyShellStatus(1)).toMatchObject({ class: 'program-exit', code: 1 });
    expect(classifyShellStatus(127)).toMatchObject({ class: 'program-exit', code: 127 });
    expect(classifyShellStatus(137)).toMatchObject({ class: 'signal', signal: 'SIG9' });
    expect(classifyShellStatus(143)).toMatchObject({ class: 'signal', signal: 'SIG15' });
  });

  it('classifies a child exit reported by node, keeping the real signal name', () => {
    expect(classifyChildExit(0, null)).toMatchObject({ class: 'clean', code: 0 });
    expect(classifyChildExit(3, null)).toMatchObject({ class: 'program-exit', code: 3 });
    expect(classifyChildExit(null, 'SIGKILL')).toMatchObject({ class: 'signal', signal: 'SIGKILL' });
    expect(classifyChildExit(null, null)).toMatchObject({ class: 'unknown' });
  });

  it('never calls an absent or unreadable record a crash', () => {
    const p = join(dir, 'nothing-here');
    expect(readExitRecord(p)).toBeNull();
    writeFileSync(p, '');
    expect(readExitRecord(p)).toMatchObject({ class: 'unknown' });
    writeFileSync(p, 'garbage not json');
    expect(readExitRecord(p)).toMatchObject({ class: 'unknown' });
    expect(JSON.stringify(readExitRecord(p))).not.toContain('crash');
  });

  it('still reads a bare number left by a pre-upgrade pane', () => {
    const p = join(dir, 'legacy');
    writeFileSync(p, '0\n');
    expect(readExitRecord(p)).toMatchObject({ class: 'clean', code: 0 });
    writeFileSync(p, '137\n');
    expect(readExitRecord(p)).toMatchObject({ class: 'signal', signal: 'SIG9' });
  });

  /** label, shell status, resulting class, does the next start resume? */
  const EXIT_CASES: Array<[string, string, string, boolean]> = [
    ['a clean exit', '0', 'clean', false],
    ['a non-zero program exit', '1', 'program-exit', true],
    ['a signal', '137', 'signal', true],
  ];

  for (const [label, status, cls, resumes] of EXIT_CASES) {
    it(`records ${label} and ${resumes ? 'resumes' : 'starts fresh'} next time`, async () => {
      writeCfg({ A: { harness: 'fake' } });
      const d = agentDir('A'); mkdirSync(d, { recursive: true });
      writeFileSync(join(d, '.session-id'), 'OLD\n');
      writeFileSync(join(d, '.booted'), '');
      // 30 liveness checks × 2000ms simulated keeps it out of the fast-fail window
      const { deps } = fakeWorld({ exitCode: status, lifeChecks: 30, exitFile: join(d, '.exit-status') });
      await runOnce('A', {}, deps);
      expect(readRecord(d).class).toBe(cls);
      expect(existsSync(join(d, '.booted'))).toBe(resumes);
    });
  }

  it('a missing record with the session still alive is unknown, and keeps context', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({ lifeChecks: 30, exitResult: null });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('unknown');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('a destroyed session is its own class, not a program exit', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({ lifeChecks: 30, sessionGone: true });
    await runOnce('A', {}, deps);
    const record = readRecord(d);
    expect(record.class).toBe('session-destroyed');
    expect(record.detail).toContain('no longer exists');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('a session destroyed early is NOT treated as a fast-failing resume', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');                   // resume mode
    // dies after ~0.2s simulated — well inside fastFailSecs (20)
    const { deps } = fakeWorld({ exitDelayMs: 100, sessionGone: true });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('session-destroyed');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).toBe('KEEP');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('a program that exits fast during resume still self-heals to fresh', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({ exitCode: '1', exitDelayMs: 100, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('program-exit');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
  });

  it('a legacy bare-number record drives the same decision', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    const { deps } = fakeWorld({
      exitCode: '0', legacyExitFile: true, exitFile: join(d, '.exit-status'),
    });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('clean');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
  });
});

describe('runOnce ACP startup outcome', () => {
  const acpFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');

  /** The fake adapter, taught to launch the ACP fixture as its agent process. */
  const acpAdapter: HarnessAdapter = {
    ...fakeAdapter,
    id: 'fake-acp',
    agentSession: {
      ...fakeAdapter.agentSession,
      prepareLaunch: () => ({ argv: [process.execPath, acpFixture], env: {} }),
      start: options => AcpSession.start({
        name: options.role.name, argv: options.launch.argv, cwd: options.cwd,
        env: options.launch.env, stateDir: options.stateDir, mode: options.mode,
        permissions: options.permissions, permissionMode: options.permissionMode,
        scrubObsoleteOursAutostart: true, log: options.log,
      }),
    },
    effectivePermissionMode: role => ({
      fleetMode: role.permissions.approval === 'allow' ? 'allow'
        : role.permissions.approval === 'auto' ? 'auto' : 'ask',
      nativeMode: role.permissions.approval === 'allow' ? 'fixture-allow' : 'fixture-ask',
    }),
  };

  /** Real-clock deps: an ACP session is a real child process, not a fake pane. */
  function acpDeps() {
    const logs: string[] = [];
    const exec: Exec = async () => ({ stdout: '', stderr: '', code: 0 });
    return {
      logs,
      deps: {
        exec,
        cpuDelegated: () => true,
        isAlive: () => true,
        sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 25))),
        now: () => Date.now(),
        log: (l: string) => { logs.push(l); },
        fetch: async () => ({ status: 200, ok: true, json: async () => ({ cursor: 0, events: [] }) }),
        createMonitor: () => ({ prime: async () => {}, run: async () => {}, stop: () => {} }),
      },
    };
  }

  beforeEach(() => { registerAdapter(acpAdapter); });

  it('passes only provenance attached to the exact ACP launch into the session', async () => {
    registerAdapter({
      ...acpAdapter,
      id: 'fake-acp-provenance',
      agentSession: {
        ...acpAdapter.agentSession,
        prepareLaunch: () => ({
          argv: ['fixture-acp'], env: {},
          adapterState: { permissionMetadataSource: 'codex-acp' },
        }),
      },
    });
    writeCfg({ A: {
      harness: 'fake-acp-provenance', session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'wait' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();
    let observedSource: string | undefined;
    let alive = true;
    const fakeAcp: SessionHandle = {
      backend: 'acp', pid: 4242,
      isAlive: () => alive,
      snapshot: () => ({ backend: 'acp', alive, readiness: 'idle' }),
      queuePrompt: async (_text, options) => {
        alive = false;
        return {
          promptId: 'startup', queuedBehind: 0, origin: options?.origin,
          completion: Promise.resolve(turnResult(true, 'completed', 'end_turn')),
        };
      },
      submitPrompt: async (text, options) =>
        (await fakeAcp.queuePrompt(text, options)).completion,
      interrupt: async () => ({ state: 'settled' }),
      respondPermission: () => false,
      eventsSince: () => [],
      subscribe: () => () => {},
      setControllerAttached: () => {},
      exitResult: () => ({ version: 1, class: 'clean', code: 0, detail: 'test complete' }),
      close: async () => { alive = false; },
    };
    const runnerDeps: Partial<RunnerDeps> = {
      ...deps,
      startAgentSession: async (_adapter, options) => {
        observedSource = (options.launch.adapterState as { permissionMetadataSource?: string })
          ?.permissionMetadataSource;
        return fakeAcp;
      },
      createControlServer: () => ({
        start: async () => {}, close: async () => {},
        setFleetSpawner: () => {}, setFleetAuditor: () => {}, setOwnerChannel: () => {},
        setConfigReloader: () => {}, setLoopManager: () => {},
      }),
    };

    await runOnce('A', {}, runnerDeps);
    expect(observedSource).toBe('codex-acp');
  });

  it.each(['normal', 'recovery-refused', 'cancel-error', 'cancel-refused'])('keeps the same ACP process through startup watchdog recovery (%s)', async mode => {
    writeCfg({ A: { harness: 'fake-acp', session: 'acp' } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();
    let session: AcpSession | undefined;
    let starts = 0;
    const running = runOnce('A', {}, { ...deps, startAgentSession: async (_adapter, options) => {
      starts++;
      session = await AcpSession.start({ name: 'A',
        argv: [process.execPath, join(dirname(acpFixture), 'stall-acp-agent.mjs')],
        stateDir: options.stateDir, cwd: options.cwd, mode: 'fresh',
        env: { STALL_FIXTURE_MODE: mode }, permissions: options.permissions,
        permissionMetadataSource: 'codex-acp',
        stallRecovery: { timeoutMs: 500, tickMs: 60_000, cancelWaitMs: 1_000 }, log: deps.log,
      });
      return session;
    } });
    try {
      await vi.waitFor(() => expect(session?.conversationPage({ limit: 100 }).events
        .some(e => JSON.stringify(e).includes('willRetry'))).toBe(true));
      const live = session as unknown as { activeTurn: { lastProgressAt: number }; stallWatchdog: { tick(): Promise<void> } };
      live.activeTurn.lastProgressAt -= 2_000;
      await live.stallWatchdog.tick();
      await vi.waitFor(() => expect(logs.some(line => line.includes('[A] up;'))).toBe(true));
      expect(starts).toBe(1); expect(session!.isAlive()).toBe(true);
      if (mode !== 'normal') expect(logs.some(line => line.includes('requires operator attention; keeping supervisor alive'))).toBe(true);
    } finally { await session?.close(); }
    await running;
  });

  it('a refused startup prompt fails the role instead of logging it up', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      env: { ACP_FIXTURE_STOP_REASON: 'refusal' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/startup prompt refused/);
    expect(logs.some(l => l.includes('[A] up;'))).toBe(false);
  });

  it('a cancelled startup prompt fails the role too', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      env: { ACP_FIXTURE_STOP_REASON: 'cancelled' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/startup prompt cancelled/);
    expect(logs.some(l => l.includes('[A] up;'))).toBe(false);
  });

  it('keeps only typed temp wake cancellations nonterminal at startup', () => {
    const cancelled = (source?: Parameters<typeof turnResult>[4]) =>
      turnResult(true, 'cancelled', 'cancelled', undefined, source);
    expect(isRecoverableTempStartupCancellation(true, cancelled('local-console'))).toBe(true);
    expect(isRecoverableTempStartupCancellation(true, cancelled('fleet-monitor'))).toBe(true);
    expect(isRecoverableTempStartupCancellation(false, cancelled('local-console'))).toBe(false);
    expect(isRecoverableTempStartupCancellation(true, cancelled())).toBe(false);
    expect(isRecoverableTempStartupCancellation(true, cancelled('owner'))).toBe(false);
    expect(isRecoverableTempStartupCancellation(true, cancelled('shutdown'))).toBe(false);
    expect(isRecoverableTempStartupCancellation(
      true, turnResult(true, 'refused', 'refusal'))).toBe(false);
    expect(isRecoverableTempStartupCancellation(
      true, turnResult(false, 'failed', 'adapter failed'))).toBe(false);
  });

  it('keeps a temp supervisor alive when a manual interrupt cancels startup for a queued wake', async () => {
    const d = agentDir('T', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name: 'T', harness: 'fake-acp', session: 'acp', identity: 'T',
      monitor: { mode: 'fleet', interrupt: true },
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      sourceFile: '(temp)',
    }));
    writeFileSync(join(d, 'identity-contact-state'), 'must survive the interrupted turn\n');
    prepareTempSupervisor(d, 'T');
    const { deps, logs } = acpDeps();
    const runnerDeps: Partial<RunnerDeps> = deps;
    let stopSupervisor = false;
    let wakeSucceeded = false;
    let controlSession: SessionHandle | undefined;
    let alive = true;
    let startupQueued = false;
    let settleStartup!: (result: TurnResult) => void;
    const queuePrompt: SessionHandle['queuePrompt'] = async (text, options = {}) => {
      if (!startupQueued) {
        startupQueued = true;
        return {
          promptId: 'startup', queuedBehind: 0, origin: options.origin,
          completion: new Promise<TurnResult>(resolve => { settleStartup = resolve; }),
        };
      }
      expect(text).toBe('queued wake after interrupt');
      return {
        promptId: 'wake', queuedBehind: 0, origin: options.origin,
        completion: Promise.resolve(turnResult(true, 'completed', 'end_turn')),
      };
    };
    const fakeAcp: SessionHandle = {
      backend: 'acp', pid: 4242,
      isAlive: () => alive,
      snapshot: () => ({ backend: 'acp', alive, readiness: startupQueued ? 'running' : 'idle' }),
      queuePrompt,
      submitPrompt: async (text, options) => (await queuePrompt(text, options)).completion,
      interrupt: async (source = 'local-console') => {
        settleStartup(turnResult(true, 'cancelled', 'cancelled', undefined, source));
        return { state: 'settled' };
      },
      respondPermission: () => false,
      eventsSince: () => [],
      subscribe: () => () => {},
      setControllerAttached: () => {},
      exitResult: () => ({ version: 1, class: 'clean', code: 0, detail: 'test stop' }),
      close: async () => { alive = false; },
    };
    runnerDeps.startAgentSession = async () => fakeAcp;
    runnerDeps.createControlServer = (_stateDir, session) => {
      controlSession = session;
      return {
        start: async () => {}, close: async () => {},
        setFleetSpawner: () => {}, setFleetAuditor: () => {}, setOwnerChannel: () => {},
        setConfigReloader: () => {}, setLoopManager: () => {},
      };
    };
    runnerDeps.shouldStop = () => stopSupervisor;
    runnerDeps.fetch = async () => ({
      status: 200, ok: true,
      json: async () => ({ identities: [{ name: 'T', temporary: true }] }),
    });
    runnerDeps.createMonitor = opts => ({
      prime: async () => {},
      run: async () => {
        // The daemon notification remains pending while the independent
        // control interrupt settles the startup turn. Delivery must still be
        // possible through the same live session immediately afterwards.
        const interrupted = await controlSession!.interrupt('local-console');
        expect(interrupted).toMatchObject({ state: 'settled' });
        for (let i = 0; i < 100; i++) {
          if (logs.some(line => line.includes('keeping temporary supervisor alive'))) break;
          await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
        const delivered = await opts.deps.delivery!.submit(
          'queued wake after interrupt', { interrupt: true });
        wakeSucceeded = delivered.succeeded;
        expect(delivered).toMatchObject({ succeeded: true, outcome: 'completed' });
        expect(readFileSync(join(d, 'identity-contact-state'), 'utf8'))
          .toBe('must survive the interrupted turn\n');
        stopSupervisor = true;
      },
      stop: () => {},
    });

    await expect(runTemp('T', runnerDeps)).resolves.toBeUndefined();

    expect(wakeSucceeded).toBe(true);
    expect(logs).toContain('[T] ACP startup prompt cancelled by local-console; keeping temporary supervisor alive');
    const recovery = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(recovery).find(name => name.includes('-T-'))!;
    expect(readFileSync(join(recovery, archived, 'identity-contact-state'), 'utf8'))
      .toBe('must survive the interrupted turn\n');
    expect(readFileSync(join(recovery, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"supervisor-signal"');
  }, 20_000);

  it('delivers the adapter-computed permission mode to the ACP session', async () => {
    registerAdapter({
      ...acpAdapter, id: 'fake-acp-mode',
      agentSession: {
        ...acpAdapter.agentSession,
        start: options => AcpSession.start({
          name: options.role.name, argv: options.launch.argv, cwd: options.cwd,
          env: options.launch.env, stateDir: options.stateDir, mode: options.mode,
          permissions: options.permissions, permissionMode: options.permissionMode,
          modeId: 'acceptEdits', scrubObsoleteOursAutostart: true, log: options.log,
        }),
      },
    });
    writeCfg({ A: {
      harness: 'fake-acp-mode', session: 'acp',
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();

    await runOnce('A', {}, deps);
    const events = readFileSync(join(agentDir('A'), '.session-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { kind: string; text?: string });
    expect(events.some(e => e.kind === 'agent_text' && e.text === 'mode:acceptEdits')).toBe(true);
  });

  it('warns once at startup that an unattended role auto-denies', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);
    const warnings = logs.filter(l => l.includes('permission policy: unattended=deny'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('reject_once');
  });

  it('says nothing about auto-denial when the role waits instead', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);
    expect(logs.some(l => l.includes('permission policy'))).toBe(false);
  });

  it('records the ACP child\'s real exit, per class', async () => {
    for (const [code, cls, fresh] of [['0', 'clean', true], ['4', 'program-exit', false]] as const) {
      writeCfg({ A: {
        harness: 'fake-acp', session: 'acp',
        env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_EXIT_CODE: code },
      } });
      const d = agentDir('A');
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, '.session-id'), 'OLD\n');
      const { deps } = acpDeps();

      await runOnce('A', {}, deps);
      const record = JSON.parse(readFileSync(join(d, '.exit-status'), 'utf8'));
      expect(record.class, `exit code ${code}`).toBe(cls);
      if (cls === 'program-exit') expect(record.code).toBe(4);
      // A clean exit rotates under this adapter's policy; a program exit does not.
      expect(readFileSync(join(d, '.session-id'), 'utf8').trim() !== 'OLD').toBe(fresh);
    }
  }, 20_000);

  it('a floor-compliant role starts with ZERO permission prompts', async () => {
    // The startup prompt makes the agent request a tool permission. A role whose
    // resolved permissions clear the floor must have it granted automatically —
    // nothing pending, nothing denied, and the turn completes.
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_ALWAYS_PERMISSION: '1' },
    } });
    const d = agentDir('A');
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);

    const events = readFileSync(join(d, '.session-events.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l) as { kind: string; status?: string; decision?: string });
    const permissions = events.filter(e => e.kind === 'permission');
    expect(permissions.length).toBeGreaterThan(0);                    // one was requested
    expect(permissions.every(e => e.status === 'completed')).toBe(true);  // none left pending
    expect(permissions.every(e => e.decision === 'allowed')).toBe(true);  // and none denied
    expect(logs.some(l => l.includes('[A] up;'))).toBe(true);
    expect(events.some(e => e.kind === 'turn_stop')).toBe(true);      // the turn finished
  }, 20_000);

  it('a completed startup prompt does log the role up', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },      // agent leaves once startup is answered
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);
    expect(logs.some(l => l.includes('[A] up;') && l.includes('session=acp'))).toBe(true);
  });

  it('starts and stops the owner channel with the live ACP session', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();
    let started = 0;
    let closed = 0;
    deps.createOwnerChannel = options => {
      expect(options.role).toBe('A');
      expect(options.config.identity).toBe('A-owner');
      expect(options.session.backend).toBe('acp');
      return {
        start: async () => { started++; },
        drain: async () => {},
        close: async () => {
          expect(existsSync(join(agentDir('A'), '.control.sock'))).toBe(false);
          closed++;
        },
        manage: async () => { throw new Error('not used'); },
      };
    };

    await runOnce('A', {}, deps);
    expect(started).toBe(1);
    expect(closed).toBe(1);
  });

  it('asks only an owned predecessor control route to report a bounded handoff timeout', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    writeFileSync(join(agentDir('A'), '.control.sock'), 'predecessor-route');
    const { deps, logs } = acpDeps();
    const report = vi.fn(async () => {
      expect(readFileSync(join(agentDir('A'), '.control.sock'), 'utf8')).toBe('predecessor-route');
      return 'delivered' as const;
    });
    deps.reportOwnerStartupFailure = report;
    deps.acquireOwnerBinder = async () => {
      throw new OwnerBinderHandoffTimeoutError('owned overlap');
    };

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/owner channel failed to start.*owned overlap/);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(agentDir('A'));
    expect(logs).toContain('[A] owner channel startup recovery notice delivered by authenticated predecessor');
  });

  it('does not guess a recovery route for a foreign owner-channel bind failure', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();
    const report = vi.fn(async () => 'delivered' as const);
    deps.reportOwnerStartupFailure = report;
    deps.acquireOwnerBinder = async () => {
      throw new OwnerBinderConflictError('identity is held by a foreign live session');
    };

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/foreign live session/);
    expect(report).not.toHaveBeenCalled();
  });

  it('starts scheduled loops only after ACP startup and stops them before teardown', async () => {
    writeV2Fixture(join(dir, 'fleet.yaml'), {
      roles: { A: {
        harness: 'fake-acp', session: 'acp',
        env: { ACP_FIXTURE_EXIT_AFTER: '2' },
      } },
      loops: { health: {
        roles: ['A'], interval: '1m', initial_delay: '0s', prompt: 'bounded health pass',
      } },
    });
    const stateDir = agentDir('A');
    mkdirSync(stateDir, { recursive: true });
    const { deps, logs } = acpDeps();
    await runOnce('A', {}, deps);
    const state = JSON.parse(readFileSync(join(stateDir, '.scheduled-loops.json'), 'utf8'));
    expect(state.loops.health.counts).toMatchObject({ started: 1, completed: 1 });
    expect(state.loops.health.activeRunId).toBeNull();
    expect(logs.some(line => line.includes('loop health started'))).toBe(true);
    expect(JSON.stringify(state)).not.toContain('bounded health pass');
  }, 20_000);

  it('installs sealed temporary loops without registering mutable config reload', async () => {
    const name = 'TempLoop';
    const stateDir = agentDir(name, true);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'role.yaml'), stringify({
      name, harness: 'fake', session: 'acp', identity: name, sourceFile: '(temp)',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      temporaryLoopSource: 'agent-template',
      loops: [{
        name: 'progress', role: name, intervalMs: 60_000, initialDelayMs: 60_000,
        jitterMs: 0, enabled: true, prompt: 'sealed progress pass', promptBytes: 20,
        promptHash: 'a'.repeat(64), definitionHash: 'b'.repeat(64), sourceFile: '(sealed)',
      }],
    }));
    const world = fakeWorld({ exitCode: '0', exitFile: join(stateDir, '.exit-status') });
    const installed: unknown[] = [];
    const reloaders: unknown[] = [];
    await runOnce(name, { temp: true }, { ...world.deps, createControlServer: () => ({
      start: async () => {}, close: async () => {}, setFleetSpawner: () => {},
      setFleetAuditor: () => {}, setOwnerChannel: () => {},
      setConfigReloader: value => { reloaders.push(value); },
      setLoopManager: value => { installed.push(value); },
    }) });
    expect(installed).toHaveLength(2);
    expect(installed[0]).toBeDefined();
    expect(installed[1]).toBeUndefined();
    expect(reloaders).toEqual([undefined]);
    const state = JSON.parse(readFileSync(join(stateDir, '.scheduled-loops.json'), 'utf8'));
    expect(state.loops.progress.definitionHash).toBe('b'.repeat(64));
    expect(JSON.stringify(state)).not.toContain('sealed progress pass');
  });

  it('fails closed on temporary loop-manager startup while preserving persistent fallback', async () => {
    const tempName = 'TempFailedLoop';
    const tempDir = agentDir(tempName, true);
    mkdirSync(tempDir, { recursive: true });
    const loop = {
      name: 'progress', role: tempName, intervalMs: 60_000, initialDelayMs: 60_000,
      jitterMs: 0, enabled: true, prompt: 'sealed', promptBytes: 6,
      promptHash: 'c'.repeat(64), definitionHash: 'd'.repeat(64), sourceFile: '(sealed)',
    };
    writeFileSync(join(tempDir, 'role.yaml'), stringify({
      name: tempName, harness: 'fake', session: 'acp', identity: tempName, sourceFile: '(temp)',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      loops: [loop], temporaryLoopSource: 'agent-template',
    }));
    const tempWorld = fakeWorld({ exitCode: '0', exitFile: join(tempDir, '.exit-status') });
    const failManager = () => { throw new Error('injected manager failure'); };
    await expect(runOnce(tempName, { temp: true }, {
      ...tempWorld.deps, createLoopManager: failManager,
    }))
      .rejects.toThrow('configured temporary loop manager failed to start');

    writeV2Fixture(join(dir, 'fleet.yaml'), {
      roles: { PersistentLoop: { harness: 'fake', session: 'acp' } },
      loops: { progress: { roles: ['PersistentLoop'], interval: '1m', prompt: 'persistent' } },
    });
    const persistentDir = agentDir('PersistentLoop');
    mkdirSync(persistentDir, { recursive: true });
    const logs: string[] = [];
    const persistentWorld = fakeWorld({ exitCode: '0', exitFile: join(persistentDir, '.exit-status') });
    await expect(runOnce('PersistentLoop', {}, {
      ...persistentWorld.deps, log: line => logs.push(line), createLoopManager: failManager,
    }))
      .resolves.toBeDefined();
    expect(logs.some(line => line.includes('scheduled loop manager unavailable'))).toBe(true);
  });

  it('steers an interrupting wake during ACP startup instead of cancelling startup', async () => {
    writeCfg({ A: {
      harness: 'fake-acp',
      session: 'acp',
      monitor: { mode: 'fleet', interrupt: true },
      env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_PROMPT_DELAY_MS: '100' },
    } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps } = acpDeps();
    let startupWasActive = false;
    let wakeOutcome: string | undefined;
    deps.createMonitor = opts => ({
      prime: async () => {},
      run: async () => {
        const before = readFileSync(join(d, '.session-events.jsonl'), 'utf8');
        startupWasActive = !before.includes('"kind":"turn_stop"');
        const result = await opts.deps.delivery!.submit('wake during startup', { interrupt: true });
        wakeOutcome = result.outcome;
      },
      stop: () => {},
    });

    await runOnce('A', {}, deps);
    expect(startupWasActive).toBe(true);
    expect(['injected', 'startedNewTurn']).toContain(wakeOutcome);
    const events = readFileSync(join(d, '.session-events.jsonl'), 'utf8');
    expect(events).not.toContain('"stopReason":"cancelled"');
    expect(events).toContain('"kind":"turn_stop"');
  });

  it('steers after_tool directly during ACP startup without waiting or cancelling', async () => {
    writeCfg({ A: {
      harness: 'fake-acp',
      session: 'acp',
      monitor: { mode: 'fleet', interrupt: 'after_tool' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_PROMPT_DELAY_MS: '100' },
    } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps } = acpDeps();
    let wakeOutcome: string | undefined;
    deps.createMonitor = opts => ({
      prime: async () => {},
      run: async () => {
        const result = await opts.deps.delivery!.submit(
          'after_tool wake during startup', { interrupt: 'after_tool' });
        wakeOutcome = result.outcome;
      },
      stop: () => {},
    });

    await runOnce('A', {}, deps);
    expect(['injected', 'startedNewTurn']).toContain(wakeOutcome);
    const events = readFileSync(join(d, '.session-events.jsonl'), 'utf8');
    expect(events).not.toContain('"kind":"monitor_delivery"');
    expect(events).not.toContain('"cancellationSource":"fleet-monitor"');
    expect(events).not.toContain('"stopReason":"cancelled"');
  });
});

describe('runOnce monitor integration', () => {
  it('primes the monitor before creating the session and stops it after pid death', async () => {
    writeCfg({ A: { harness: 'fake' } });   // monitor.mode defaults to fleet
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(monitor.constructed).toBe(1);
    expect(monitor.primedBeforeSession).toBe(true);   // cursor primed before adapter start
    expect(monitor.ranPid).toBe(4242);
    expect(monitor.stopped).toBe(true);               // stopped when the pane pid died
  });

  it('does not construct a fleet monitor when monitor.mode is native', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(monitor.constructed).toBe(0);
  });

  it('re-primes at tip when wake ownership moves from native back to fleet', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    await runOnce('A', {}, fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') }).deps);

    writeCfg({ A: { harness: 'fake', monitor: { mode: 'fleet' } } });
    const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(monitor.resetCursor).toBe(true);
  });

  it('does not request a cursor reset across fleet-to-fleet restarts', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'fleet' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });

    const first = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, first.deps);
    expect(first.monitor.resetCursor).toBe(false);

    const second = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, second.deps);
    expect(second.monitor.resetCursor).toBe(false);
  });

  it('passes service env plus role daemon-profile overrides to the monitor', async () => {
    const savedPort = process.env.OURS_PORT;
    const savedToken = process.env.OURS_API_TOKEN;
    process.env.OURS_PORT = '3001';
    process.env.OURS_API_TOKEN = 'service-token';
    try {
      writeCfg({
        A: {
          harness: 'fake',
          env: {
            OURS_PORT: '4555',
            OURS_API_TOKEN: 'role-token',
            OURS_CONFIG: '/role/ours.json',
            OURS_STATE_DIR: '/role/state',
          },
        },
      });
      const d = agentDir('A'); mkdirSync(d, { recursive: true });
      const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
      await runOnce('A', {}, deps);
      expect(monitor.env?.OURS_PORT).toBe('4555');
      expect(monitor.env?.OURS_API_TOKEN).toBe('role-token');
      expect(monitor.env?.OURS_CONFIG).toBe('/role/ours.json');
      expect(monitor.env?.OURS_STATE_DIR).toBe('/role/state');
      expect(monitor.env?.PATH).toBe(process.env.PATH); // inherited service env remains present
    } finally {
      if (savedPort === undefined) delete process.env.OURS_PORT;
      else process.env.OURS_PORT = savedPort;
      if (savedToken === undefined) delete process.env.OURS_API_TOKEN;
      else process.env.OURS_API_TOKEN = savedToken;
    }
  });
});

describe('temporary identity retirement', () => {
  const writeTemp = (name: string) => {
    const d = agentDir(name, true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name, harness: 'fake', session: 'acp', identity: name,
      monitor: { mode: 'native' }, sourceFile: '(temp)',
    }));
    return d;
  };

  it('closes a live temp session only after a sustained absence of its observed identity', async () => {
    const d = writeTemp('T');
    const world = fakeWorld({ lifeChecks: 100, exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async url => {
      expect(url).toContain('/identities');
      const identities = probes++ === 0
        ? [{ name: 'T', temporary: true }] : [{ name: 'Other' }];
      return { status: 200, ok: true, json: async () => ({ identities }) };
    };

    const result = await runOnce('T', { temp: true }, world.deps);

    expect(result.retirementReason).toBe('identity-closed');
    expect(result.elapsedSecs).toBeGreaterThanOrEqual(TEMP_IDENTITY_CLOSE_DEBOUNCE_MS / 1000);
    expect(probes).toBeGreaterThan(2);
    expect(world.paneCommands).toHaveLength(1);
  });

  it('cancels in-flight generation recovery on temp stop and fences late completion', async () => {
    const d = writeTemp('T');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const world = fakeWorld({ lifeChecks: 100, exitFile: join(d, '.exit-status'), recoveryGate: gate });
    let probes = 0;
    world.deps.probeGeneration = async () => ({ state: 'ready' as const, generation: {
      bootId: probes++ === 0 ? 'boot-1' : 'boot-2', pid: probes, startedAt: probes, stateDir: dir,
    } });
    world.deps.shouldStop = () => true;
    const result = await runOnce('T', { temp: true }, world.deps);
    expect(result.retirementReason).toBe('supervisor-signal');
    expect(world.recoveryPrompts).toHaveLength(1);
    const statusPath = join(d, '.daemon-recovery.json');
    const before = readFileSync(statusPath, 'utf8');
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(readFileSync(statusPath, 'utf8')).toBe(before);
    expect(JSON.parse(before).state).toBe('cancelled');
  });

  it('uses first observed presence as readiness even when a cold bind exceeds the former 30s grace', async () => {
    const d = writeTemp('T');
    const world = fakeWorld({ lifeChecks: 200, exitCode: '0', exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async () => {
      const probe = probes++;
      const identities = probe < 20
        ? [{ name: 'Other' }]
        : probe === 20 ? [{ name: 'T', temporary: true }] : [{ name: 'Other' }];
      return { status: 200, ok: true, json: async () => ({ identities }) };
    };

    const result = await runOnce('T', { temp: true }, world.deps);

    expect(result.retirementReason).toBe('identity-closed');
    expect(result.elapsedSecs).toBeGreaterThan(40);
    expect(probes).toBeGreaterThan(20);
    expect(world.paneCommands).toHaveLength(1);
  });

  it('does not retire before the identity readiness gate is reached', async () => {
    const d = writeTemp('T');
    const world = fakeWorld({ lifeChecks: 100, exitCode: '0', exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async () => {
      probes++;
      return { status: 200, ok: true, json: async () => ({ identities: [{ name: 'Other' }] }) };
    };

    const result = await runOnce('T', { temp: true }, world.deps);

    expect(result.retirementReason).toBeUndefined();
    expect(result.elapsedSecs).toBeGreaterThan(30);
    expect(probes).toBeLessThan(result.elapsedSecs * 2); // no former 2 requests/second hot loop
  });

  it('does not false-retire from a valid-but-empty daemon index after readiness', async () => {
    const d = writeTemp('T');
    const world = fakeWorld({ lifeChecks: 40, exitCode: '0', exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async () => {
      const identities = probes++ === 0 ? [{ name: 'T', temporary: true }] : [];
      return { status: 200, ok: true, json: async () => ({ identities }) };
    };

    const result = await runOnce('T', { temp: true }, world.deps);

    expect(result.retirementReason).toBeUndefined();
    expect(result.elapsedSecs).toBeGreaterThan(TEMP_IDENTITY_CLOSE_DEBOUNCE_MS / 1000);
    expect(probes).toBeLessThanOrEqual(Math.ceil(result.elapsedSecs * 1000 / TEMP_IDENTITY_POLL_MS) + 1);
  });

  it('never probes or changes a permanent role lifecycle', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const world = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async () => {
      probes++;
      return { status: 200, ok: true, json: async () => ({ identities: [] }) };
    };

    await runOnce('A', {}, world.deps);

    expect(probes).toBe(0);
  });
});

describe('reserveLaunchSlot (start gate)', () => {
  const gateDeps = (clock: { t: number }) => ({
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
    log: () => {},
  });

  it('returns now for a lone start and records the timestamp', async () => {
    const clock = { t: 1000 };
    const t = await reserveLaunchSlot(dir, 5000, gateDeps(clock));
    expect(t).toBe(1000);                                   // zero wait for a lone launch
    expect(readFileSync(join(dir, '.last-launch'), 'utf8').trim()).toBe('1000');
  });

  it('spaces successive launches by staggerMs (concurrent boot burst)', async () => {
    const clock = { t: 1000 };                              // clock held: all "arrive" together
    const deps = gateDeps(clock);
    const t1 = await reserveLaunchSlot(dir, 5000, deps);
    const t2 = await reserveLaunchSlot(dir, 5000, deps);
    const t3 = await reserveLaunchSlot(dir, 5000, deps);
    expect([t1, t2, t3]).toEqual([1000, 6000, 11000]);      // spread out by 5000ms each
  });

  it('does not delay a lone start that follows a long idle gap', async () => {
    writeFileSync(join(dir, '.last-launch'), '500');        // ancient prior launch
    const clock = { t: 100000 };
    const t = await reserveLaunchSlot(dir, 5000, gateDeps(clock));
    expect(t).toBe(100000);                                 // max(now, 500+5000) = now
  });

  it('breaks a stale lock left by a crashed launcher instead of deadlocking', async () => {
    mkdirSync(join(dir, '.launch-gate.lock'), { recursive: true });
    writeFileSync(join(dir, '.launch-gate.lock', 'ts'), '0');  // lock stamped far in the past
    const clock = { t: 100000 };                               // now ≫ staleMs ⇒ steal it
    const t = await reserveLaunchSlot(dir, 1000, gateDeps(clock));
    expect(t).toBe(100000);
    expect(existsSync(join(dir, '.launch-gate.lock'))).toBe(false);  // released
  });
});

describe('runOnce start-stagger', () => {
  it('runs the launch through the gate when start_stagger_ms is set (lone = no real wait)', async () => {
    writeV2Fixture(join(dir, 'fleet.yaml'), { start_stagger_ms: 5000, roles: { A: { harness: 'fake' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(paneCommands).toHaveLength(1);                                  // launched
    expect(existsSync(join(stateRoot(), '.last-launch'))).toBe(true);      // gate engaged
  });

  it('touches no launch gate when start_stagger_ms is unset (default behavior)', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(existsSync(join(stateRoot(), '.last-launch'))).toBe(false);
  });
});

describe('runOnce config-path fallback', () => {
  it('falls back to the .config-path marker when no -c is given (systemd restart path)', async () => {
    // Default ~/fleet.yaml has no role A at all — only the custom file does.
    writeCfg({});
    const customCfg = join(dir, 'custom.yaml');
    writeV2Fixture(customCfg, { roles: { A: { harness: 'fake' } } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.config-path'), customCfg + '\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    // No opts.configPath passed — this is exactly what systemd's `_run A` does.
    await expect(runOnce('A', {}, deps)).resolves.not.toThrow();
  });

  it('an explicit configPath still wins over the marker', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const staleCfg = join(dir, 'stale.yaml');
    writeFileSync(staleCfg, stringify({ roles: {} }));   // no A here
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.config-path'), staleCfg + '\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await expect(runOnce('A', { configPath: join(dir, 'fleet.yaml') }, deps)).resolves.not.toThrow();
  });

  it('no marker + no explicit path falls back to the default config, unchanged', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await expect(runOnce('A', {}, deps)).resolves.not.toThrow();
  });
});

describe('runTemp', () => {
  it('runs from the tmp snapshot and archives evidence outside the live roster afterwards', async () => {
    const d = agentDir('T', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'),
      stringify({ name: 'T', harness: 'fake', identity: 'T', sourceFile: 'tmp' }));
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runTemp('T', deps);
    expect(existsSync(d)).toBe(false);
    const archiveRoot = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(archiveRoot).find(name => name.includes('-T-'))!;
    expect(readFileSync(join(archiveRoot, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"session-ended"');
    expect(readFileSync(join(archiveRoot, 'terminations.jsonl'), 'utf8'))
      .toContain('"role":"T"');
  });

  it('settles the supervisor and archives an explicit closed-identity retirement', async () => {
    const d = agentDir('Closed', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name: 'Closed', harness: 'fake', identity: 'Closed', monitor: { mode: 'native' },
      sourceFile: 'tmp',
    }));
    const { deps } = fakeWorld({ lifeChecks: 100, exitFile: join(d, '.exit-status') });
    let probes = 0;
    deps.fetch = async () => ({
      status: 200, ok: true,
      json: async () => ({ identities: probes++ === 0
        ? [{ name: 'Closed', temporary: true }] : [{ name: 'Other' }] }),
    });

    await runTemp('Closed', deps);

    expect(existsSync(d)).toBe(false);
    const archiveRoot = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(archiveRoot).find(name => name.includes('-Closed-'))!;
    expect(readFileSync(join(archiveRoot, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"identity-closed"');
  });

  it('archives a distinct recycle reason and rethrows for a fresh supervisor PID', async () => {
    const d = agentDir('Recycle', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name: 'Recycle', harness: 'fake', identity: 'Recycle', sourceFile: 'tmp',
    }));
    const logs: string[] = [];
    await expect(runTemp('Recycle', { log: line => logs.push(line) }, async () => {
      throw new SupervisorRecycleRequiredError();
    })).rejects.toBeInstanceOf(SupervisorRecycleRequiredError);
    const archiveRoot = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(archiveRoot).find(name => name.includes('-Recycle-'))!;
    expect(readFileSync(join(archiveRoot, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"supervisor-recycle"');
    expect(logs).toContainEqual(expect.stringContaining('failed: supervisor-recycle'));
  });
});

describe('restart-loop containment', () => {
  /** A fake clock and a fake child, so the policy is tested, not the sessions. */
  function supervisorWorld(stateDir: string, opts: {
    /** Seconds each attempt "lasts", by attempt index. Last value repeats. */
    durations?: number[];
    /** Attempts after which the loop stops (default: 20, a runaway guard). */
    stopAfter?: number;
    /** Attempt indices whose session rotated its resume state. */
    rotatesAt?: number[];
    throwAt?: number[];
  } = {}) {
    const durations = opts.durations ?? [0];
    const sleeps: number[] = [];
    const attempts: Array<{ allowResumeRotation?: boolean }> = [];
    const logs: string[] = [];
    let clock = 0;
    const deps: Partial<RunnerDeps> = {
      sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
      log: (l: string) => { logs.push(l); },
      // Stop once the breaker has opened: the real loop then holds down forever
      // on purpose, which against a fake clock is an infinite spin.
      shouldStop: () => attempts.length >= (opts.stopAfter ?? 20)
        || readRestartLedger(stateDir).circuit === 'open',
    };
    const attempt = async (
      _n: string, o: { allowResumeRotation?: boolean },
    ): Promise<AttemptResult> => {
      const i = attempts.length;
      attempts.push({ allowResumeRotation: o.allowResumeRotation });
      if (opts.throwAt?.includes(i)) throw new Error('could not start the session');
      const secs = durations[Math.min(i, durations.length - 1)];
      clock += secs * 1000;
      return {
        elapsedSecs: secs,
        exit: { version: 1, class: 'program-exit', code: 1, detail: 'exited with code 1' },
        rotated: opts.rotatesAt?.includes(i) ?? false,
        mode: 'resume',
      };
    };
    return { deps, attempt, sleeps, attempts, logs };
  }

  const setup = () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    return d;
  };

  it('grows the delay exponentially, bounded', () => {
    expect(backoffFor(0)).toBe(0);
    expect(backoffFor(1)).toBe(2_000);
    expect(backoffFor(2)).toBe(4_000);
    expect(backoffFor(3)).toBe(8_000);
    expect(backoffFor(4)).toBe(16_000);
    expect(backoffFor(5)).toBe(32_000);
    expect(backoffFor(99)).toBe(60_000);          // bounded
  });

  it('escapes the in-process loop for supervisor recycle without touching the restart circuit', async () => {
    const d = setup();
    const logs: string[] = [];
    let attempts = 0;
    const attempt = async (): Promise<AttemptResult> => {
      attempts++;
      throw new SupervisorRecycleRequiredError();
    };
    await expect(runSupervised('A', {}, {
      now: () => 1_000,
      sleep: async () => { throw new Error('must not back off or hold down'); },
      shouldStop: () => false,
      log: line => logs.push(line),
    }, attempt)).rejects.toBeInstanceOf(SupervisorRecycleRequiredError);
    expect(attempts).toBe(1);
    expect(readRestartLedger(d)).toMatchObject({
      consecutiveImmediateFailures: 0,
      circuit: 'closed',
      nextDelayMs: 0,
      lastReason: SUPERVISOR_RECYCLE_REQUIRED,
    });
    expect(logs).toContainEqual(expect.stringContaining(SUPERVISOR_RECYCLE_REQUIRED));
    expect(existsSync(join(d, RUN_MARKER_FILE))).toBe(false);
  });

  it('an immediate-exit program reaches exactly N attempts, then holds down', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1] });
    const ledger = await runSupervised('A', {}, w.deps, w.attempt);

    expect(w.attempts).toHaveLength(RESTART_FAIL_THRESHOLD);   // exactly N child attempts
    expect(ledger.circuit).toBe('open');
    expect(ledger.consecutiveImmediateFailures).toBe(RESTART_FAIL_THRESHOLD);
    expect(ledger.lastReason).toContain('exited with code 1');
    expect(Number.isNaN(Date.parse(ledger.openedAt!))).toBe(false);   // dated reason
    // Backoff was applied between attempts, growing, and never after the open.
    expect(w.sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(w.logs.some(l => l.includes('HELD DOWN'))).toBe(true);
  });

  it('stays held down without starting another child', async () => {
    const d = setup();
    const boot = supervisorWorld(d, { durations: [0.1] });
    await runSupervised('A', {}, boot.deps, boot.attempt);
    expect(readRestartLedger(d).circuit).toBe('open');

    // A fresh runner process (e.g. the host rebooted) must honour the ledger.
    const w = supervisorWorld(d, { stopAfter: 1 });
    let polls = 0;
    w.deps.shouldStop = () => ++polls > 3;
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(w.attempts).toHaveLength(0);            // no child was started at all
  });

  it('the ledger survives a runner restart and keeps counting', async () => {
    const d = setup();
    // Two separate runner "processes", two attempts each.
    for (let i = 0; i < 2; i++) {
      const w = supervisorWorld(d, { durations: [0.1], stopAfter: 2 });
      await runSupervised('A', {}, w.deps, w.attempt);
    }
    expect(readRestartLedger(d).consecutiveImmediateFailures).toBe(4);
    expect(readRestartLedger(d).circuit).toBe('closed');       // one short of N

    const w = supervisorWorld(d, { durations: [0.1], stopAfter: 1 });
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(readRestartLedger(d).circuit).toBe('open');         // the 5th opens it
  });

  it('an explicit reset closes the circuit and releases a held-down runner', async () => {
    const d = setup();
    const first = supervisorWorld(d, { durations: [0.1] });
    await runSupervised('A', {}, first.deps, first.attempt);
    expect(readRestartLedger(d).circuit).toBe('open');

    resetRestartLedger(d);
    expect(readRestartLedger(d).circuit).toBe('closed');
    expect(readRestartLedger(d).consecutiveImmediateFailures).toBe(0);

    const w = supervisorWorld(d, { durations: [0.1], stopAfter: 1 });
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(w.attempts).toHaveLength(1);            // it starts children again
  });

  it('a session that runs for a while clears the streak', async () => {
    const d = setup();
    // Four instant failures, then one long session, then instant failures again.
    const w = supervisorWorld(d, { durations: [0.1, 0.1, 0.1, 0.1, 999, 0.1], stopAfter: 7 });
    await runSupervised('A', {}, w.deps, w.attempt);
    // Without the reset, 7 instant failures would have opened the circuit.
    expect(readRestartLedger(d).circuit).toBe('closed');
    expect(readRestartLedger(d).consecutiveImmediateFailures).toBe(2);
  });

  it('does not let near-threshold failures reset an active restart streak', async () => {
    const d = setup();
    // FleetCoordinator's 2026-08-16 loop crossed the adapter's 20s immediate
    // boundary by small amounts between faster deaths. Each crossing used to
    // erase the durable count, so this sequence could repeat forever at 1/5 or
    // 2/5 despite never sustaining a useful session.
    const w = supervisorWorld(d, {
      durations: [17.3, 19.5, 20.3, 40.7, 32.3],
      stopAfter: RESTART_FAIL_THRESHOLD,
    });

    const ledger = await runSupervised('A', {}, w.deps, w.attempt);

    expect(w.attempts).toHaveLength(RESTART_FAIL_THRESHOLD);
    expect(ledger.circuit).toBe('open');
    expect(ledger.consecutiveImmediateFailures).toBe(RESTART_FAIL_THRESHOLD);
    expect(w.sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  /**
   * FleetRetrospector was OOM-killed at 07:35:49 on 2026-08-17 and restarted by
   * systemd at 07:35:57. `.booted` still read 07:05:43 and the ledger still read
   * `consecutiveImmediateFailures: 0, updatedAt: 07:05:40` — both indicators
   * described the run that had died, because both are only written at attempt
   * boundaries inside a living supervisor process.
   */
  it('records an abrupt termination the previous supervisor never survived to write', async () => {
    const d = setup();
    // A supervisor that was killed: its run marker is still on disk, owned by a
    // pid that is not ours.
    writeFileSync(join(d, RUN_MARKER_FILE), JSON.stringify({
      version: 1, pid: process.pid + 1, startedAt: '2026-08-17T07:05:40.000Z',
    }) + '\n');
    writeRestartLedger(d, {
      version: 1, consecutiveImmediateFailures: 0, lastReason: '', nextDelayMs: 0,
      resumeDiscarded: false, circuit: 'closed', updatedAt: '2026-08-17T07:05:40.293Z',
    });

    const w = supervisorWorld(d, { durations: [100], stopAfter: 1 });
    await runSupervised('A', {}, w.deps, w.attempt);

    const ledger = readRestartLedger(d);
    expect(ledger.lastTermination?.class).toBe('abrupt');
    expect(ledger.lastTermination?.runStartedAt).toBe('2026-08-17T07:05:40.000Z');
    expect(ledger.abruptTerminations).toBe(1);
    expect(ledger.updatedAt).not.toBe('2026-08-17T07:05:40.293Z');
    expect(w.logs.some(l => l.includes('ended abruptly'))).toBe(true);
    // A long, healthy attempt clears the failure streak — and must not erase
    // the fact that the role died and came back.
    expect(ledger.consecutiveImmediateFailures).toBe(0);
    expect(existsSync(join(d, RUN_MARKER_FILE))).toBe(false);   // orderly exit released it
  });

  it('reports a clean previous run when no marker was left behind', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [100], stopAfter: 1 });
    await runSupervised('A', {}, w.deps, w.attempt);

    const ledger = readRestartLedger(d);
    expect(ledger.lastTermination?.class).toBe('clean');
    expect(ledger.abruptTerminations ?? 0).toBe(0);
  });

  it('keeps the abrupt-termination record across an operator ledger reset', () => {
    const d = setup();
    writeRestartLedger(d, {
      version: 1, consecutiveImmediateFailures: 3, lastReason: 'boom', nextDelayMs: 8_000,
      resumeDiscarded: false, circuit: 'open', updatedAt: '2026-08-17T07:35:57.000Z',
      abruptTerminations: 2,
      lastTermination: {
        class: 'abrupt', detail: 'killed', observedAt: '2026-08-17T07:35:57.000Z',
      },
    });

    resetRestartLedger(d);

    const ledger = readRestartLedger(d);
    expect(ledger.circuit).toBe('closed');
    expect(ledger.consecutiveImmediateFailures).toBe(0);
    expect(ledger.abruptTerminations).toBe(2);
    expect(ledger.lastTermination?.class).toBe('abrupt');
  });

  it('closes an active streak after the full recovery window', async () => {
    const d = setup();
    // fake's 20s fast-fail threshold × five tolerated attempts = 100s.
    const w = supervisorWorld(d, {
      durations: [17, 100, 17], rotatesAt: [0], stopAfter: 3,
    });

    await runSupervised('A', {}, w.deps, w.attempt);

    expect(readRestartLedger(d)).toMatchObject({
      circuit: 'closed', consecutiveImmediateFailures: 1, resumeDiscarded: false,
    });
    expect(w.attempts.map(a => a.allowResumeRotation)).toEqual([true, false, true]);
  });

  it('discards resume state at most once in a failure sequence', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1], rotatesAt: [0] });
    await runSupervised('A', {}, w.deps, w.attempt);
    // The first attempt was allowed to rotate; every later one was not.
    expect(w.attempts[0].allowResumeRotation).toBe(true);
    expect(w.attempts.slice(1).every(a => a.allowResumeRotation === false)).toBe(true);
  });

  it('allows rotation again once the streak is broken', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1, 999, 0.1], rotatesAt: [0], stopAfter: 3 });
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(w.attempts[0].allowResumeRotation).toBe(true);
    expect(w.attempts[1].allowResumeRotation).toBe(false);   // still inside the streak
    expect(w.attempts[2].allowResumeRotation).toBe(true);    // long session reset it
  });

  it('a session that cannot even start counts as an immediate failure', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1], throwAt: [0, 1, 2, 3, 4] });
    await runSupervised('A', {}, w.deps, w.attempt);
    const ledger = readRestartLedger(d);
    expect(ledger.circuit).toBe('open');
    expect(ledger.lastReason).toContain('could not start the session');
  });

  it('a corrupt ledger starts clean instead of taking the role down', () => {
    const d = setup();
    writeFileSync(join(d, '.restart-ledger.json'), '{not json');
    expect(readRestartLedger(d)).toMatchObject({ circuit: 'closed', consecutiveImmediateFailures: 0 });
  });
});
