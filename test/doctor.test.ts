import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { doctor as doctorImpl } from '../src/doctor.js';
import { loadConfig } from '../src/config.js';
import { registerAdapter } from '../src/harness/registry.js';
import { fakeAdapter } from './registry.test.js';
import '../src/harness/claude-code.js';   // registers the production adapters
import '../src/harness/codex.js';
import type { Exec, ExecResult } from '../src/exec.js';
import type { FetchLike } from '../src/monitor.js';
import type { AttachOursClientOptions, OursClient } from '@ours.network/sdk/client';
import { cliPath, installPrefix, pkgRoot } from './install-fixtures.js';

// A stub daemon-API for the monitor reachability probe (design §5).
const stubFetch = (state: 'ok' | '401' | 'down' | 'notdaemon' = 'ok'): FetchLike => async (url) => {
  if (state === 'down') throw new Error('ECONNREFUSED');
  if (url.includes('/state-dir'))
    return { status: state === 'notdaemon' ? 404 : 200, ok: state !== 'notdaemon', json: async () => ({ stateDir: '/s' }) };
  if (state === '401') return { status: 401, ok: false, json: async () => ({}) };
  return { status: 200, ok: true, json: async () => ({ identities: [] }) };
};

let dir: string;
const PROFILE_ENV_KEYS = ['OURS_CONFIG', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_API_TOKEN'] as const;
let savedProfileEnv: Partial<Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-doc-'));
  process.env.OURS_FLEET_HOME = dir;   // empty config → no harness checks unless --harness
  savedProfileEnv = Object.fromEntries(PROFILE_ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.OURS_CONFIG = join(dir, 'missing-ours-config.json');
  process.env.OURS_STATE_DIR = join(dir, 'missing-ours-state');
  delete process.env.OURS_PORT;
  delete process.env.OURS_API_TOKEN;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  for (const key of PROFILE_ENV_KEYS) {
    const value = savedProfileEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

// Every generic doctor test must be blind to the ambient host PATH: a machine
// that happens to have a second ours-fleet installed would otherwise change the
// report and fail tests about tmux or linger. Provenance tests pass their own
// installScan; nothing else may inherit the environment's.
const ISOLATED_SCAN = { path: '', argv1: undefined };
const HEALTHY_DAEMON_INFO = {
  name: 'ours', version: '2.0.1', compat: 2, protocol: 1, pid: 1234, stateDir: '/s',
};
type DoctorDaemonClient = Pick<OursClient, 'version'>;
const healthyDaemon = async (_options: AttachOursClientOptions): Promise<DoctorDaemonClient> => ({
  version: async () => HEALTHY_DAEMON_INFO,
});
const doctor = (
  opts: Parameters<typeof doctorImpl>[0] = {},
  exec?: Parameters<typeof doctorImpl>[1],
  platform?: Parameters<typeof doctorImpl>[2],
  fetchImpl?: Parameters<typeof doctorImpl>[3],
  attachDaemon: Parameters<typeof doctorImpl>[4] = healthyDaemon,
) => doctorImpl({ installScan: ISOLATED_SCAN, ...opts }, exec, platform, fetchImpl, attachDaemon);

const execWith = (table: Record<string, ExecResult>): Exec =>
  async (cmd, args) => table[[cmd, args[0] ?? ''].join(' ')] ?? { stdout: '', stderr: '', code: 0 };

describe('doctor', () => {
  it('flags missing tmux with an install hint', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: '', stderr: '', code: 127 },
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const t = rep.checks.find(c => c.name === 'tmux')!;
    expect(t.ok).toBe(false);
    expect(t.detail).toContain('apt install tmux');
    expect(rep.ok).toBe(false);
  });

  it('flags a stopped ours daemon', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'stopped' }), stderr: '', code: 3 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux', undefined, async () => { throw new TypeError('fetch failed'); });
    const d = rep.checks.find(c => c.name === 'ours daemon')!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain('ours daemon start');
  });

  it('checks the daemon through the SDK without executing the ours CLI', async () => {
    const commands: string[] = [];
    const rep = await doctor({}, async (cmd, args) => {
      commands.push([cmd, ...args].join(' '));
      return { stdout: '', stderr: '', code: 0 };
    }, 'darwin');
    expect(rep.checks.find(c => c.name === 'ours daemon')).toMatchObject({
      ok: true, detail: 'running (2.0.1)',
    });
    expect(commands.every(command => !command.startsWith('ours '))).toBe(true);
  });

  it('reports linger only on linux and passes when all green', async () => {
    const green = execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    });
    const linux = await doctor({}, green, 'linux');
    expect(linux.checks.some(c => c.name === 'linger')).toBe(true);
    expect(linux.ok).toBe(true);
    const mac = await doctor({}, green, 'darwin');
    expect(mac.checks.some(c => c.name === 'linger')).toBe(false);
  });

  it('unknown --harness surfaces as a failed check, not a crash', async () => {
    const rep = await doctor({ harness: 'nope' }, execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    }), 'darwin');
    const h = rep.checks.find(c => c.name === 'nope')!;
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('unknown harness');
  });

  it('recognizes the ACP adapter bundled with ours-fleet when no global bin is on PATH', async () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Coder:\n    harness: codex\n    session: acp\n    monitor:\n      enabled: false\n');
    const rep = await doctor({}, execWith({
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
      'codex --version': { stdout: 'codex-cli 1.0.0', stderr: '', code: 0 },
      'codex plugin': {
        stdout: JSON.stringify({ installed: [{
          pluginId: 'ours@ours-codex-marketplace', installed: true, enabled: true,
        }] }),
        stderr: '',
        code: 0,
      },
      'sh -c': { stdout: '', stderr: '', code: 1 },
    }), 'darwin');
    const acp = rep.checks.find(c => c.name === 'acp: Coder')!;
    expect(acp.ok).toBe(true);
    expect(acp.detail).toContain('bundled');
  });
});

describe('doctor scheduled-loop checkpoint', () => {
  const green = execWith({
    'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
  });

  /** A role with one loop, plus whatever the agent directory should contain. */
  function withLoopRole(opts: {
    lastWallMs?: number; health?: string; running?: boolean; operatorDisabled?: boolean;
  } = {}) {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'), [
      'roles:', '  Coordinator: { harness: fake, session: acp, monitor: { enabled: false } }',
      'loops:', '  health:', '    roles: [Coordinator]', '    interval: 10m',
      '    prompt: check in', '',
    ].join('\n'), { mode: 0o600 });   // loop delivery refuses a group/world-writable config
    const agent = join(dir, '.ours-fleet', 'agents', 'Coordinator');
    mkdirSync(agent, { recursive: true });
    if (opts.running) writeFileSync(join(agent, '.control.sock'), '');
    if (opts.lastWallMs !== undefined) writeFileSync(join(agent, '.scheduled-loops.json'),
      JSON.stringify({
        version: 1, role: 'Coordinator', generation: 'g',
        clock: { lastWallMs: opts.lastWallMs }, health: opts.health ?? 'healthy', anomaly: null,
        loops: {
          health: {
            definitionHash: 'a'.repeat(64), promptHash: 'b'.repeat(64), enabled: true,
            operatorDisabled: opts.operatorDisabled ?? false,
            nextScheduledAt: '2026-08-13T00:00:00.000Z',
            nextDueAt: '2026-08-13T00:00:00.000Z', lastScheduledAt: null, lastStartedAt: null,
            lastFinishedAt: null, lastOutcome: null, lastCancellationSource: null,
            lastRunId: null, activeRunId: null, lastError: null,
            counts: { started: 0, completed: 0, failed: 0, cancelled: 0,
              skipped: 0, skippedBusy: 0, skippedMissed: 0 },
          },
        },
      }), { mode: 0o600 });
    return agent;
  }

  it('fails a running role whose checkpoint stopped advancing, however healthy it claims to be', async () => {
    withLoopRole({ lastWallMs: Date.now() - 2 * 60 * 60_000, health: 'healthy', running: true });
    const check = (await doctor({}, green, 'linux')).checks.find(c => c.name === 'loops: Coordinator')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('not checkpointing');
    expect(check.detail).toContain('last recorded healthy');
  });

  it('passes a running role whose checkpoint is current', async () => {
    withLoopRole({ lastWallMs: Date.now() - 5_000, running: true });
    const check = (await doctor({}, green, 'linux')).checks.find(c => c.name === 'loops: Coordinator')!;
    expect(check.ok).toBe(true);
  });

  it('does not cry wolf over a role that is simply not running', async () => {
    withLoopRole({ lastWallMs: Date.now() - 2 * 60 * 60_000 });
    const check = (await doctor({}, green, 'linux')).checks.find(c => c.name === 'loops: Coordinator')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('not running');
  });

  it('does not call a running role healthy when it never managed to write state at all', async () => {
    withLoopRole({ running: true });   // ENOSPC at startup: socket up, no checkpoint ever written
    const check = (await doctor({}, green, 'linux')).checks.find(c => c.name === 'loops: Coordinator')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('never written scheduled-loop state');
  });

  it('leaves a role with no enabled loop alone however old its checkpoint is', async () => {
    withLoopRole({ lastWallMs: Date.now() - 6 * 60 * 60_000, running: true, operatorDisabled: true });
    const check = (await doctor({}, green, 'linux')).checks.find(c => c.name === 'loops: Coordinator')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('by design');
    expect(check.detail).not.toContain('not checkpointing');
  });

  it('surfaces a recorded failure on a running role', async () => {
    withLoopRole({ lastWallMs: Date.now() - 5_000, health: 'failed', running: true });
    const check = (await doctor({}, green, 'linux')).checks.find(c => c.name === 'loops: Coordinator')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('ours-fleet loops status Coordinator');
  });
});

describe('doctor isolation reporting', () => {
  const green = (over: Record<string, ExecResult> = {}): Exec => execWith({
    'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    'bwrap --version': { stdout: 'bubblewrap 0.11.1', stderr: '', code: 0 },
    'bwrap --ro-bind': { stdout: '', stderr: '', code: 0 },
    ...over,
  });

  it('reports bubblewrap availability (advisory; does not fail doctor)', async () => {
    const rep = await doctor({}, green(), 'linux');
    const bw = rep.checks.find(c => c.name === 'isolation: bubblewrap')!;
    expect(bw).toBeTruthy();
    expect(bw.ok).toBe(true);
    expect(bw.detail).toMatch(/available/i);
  });

  it('reports bubblewrap NOT available without failing doctor when no role needs it', async () => {
    const rep = await doctor({}, green({ 'bwrap --version': { stdout: '', stderr: '', code: 127 } }), 'linux');
    const bw = rep.checks.find(c => c.name === 'isolation: bubblewrap')!;
    expect(bw.ok).toBe(true);
    expect(bw.detail).toMatch(/not available|unavailable|not found/i);
  });

  it('reports per-role effective isolation (backend, net, caps)', async () => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    harness: fake\n    isolation:\n      network: deny\n      resources:\n        mem: 2G\n        cpu: "1"\n');
    const rep = await doctor({}, green(), 'linux', stubFetch('ok'));
    const r = rep.checks.find(c => c.name === 'isolation: Sec')!;
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/bubblewrap/);
    expect(r.detail).toMatch(/deny/);
    expect(r.detail).toMatch(/mem=2G/);
  });

  it('flags a strict role that cannot be sandboxed as a failed check', async () => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    harness: fake\n    isolation:\n      on_unavailable: strict\n');
    const rep = await doctor({}, green({ 'bwrap --version': { stdout: '', stderr: '', code: 127 } }), 'linux', stubFetch('ok'));
    const r = rep.checks.find(c => c.name === 'isolation: Sec')!;
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/strict|refuse/i);
    expect(rep.ok).toBe(false);
  });
});

describe('doctor monitor probe (§5)', () => {
  const green = (over: Record<string, ExecResult> = {}): Exec => execWith({
    'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    ...over,
  });
  const withRole = (monitorYaml: string) => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'), `roles:\n  A:\n    harness: fake\n${monitorYaml}`);
  };

  it('reports the daemon API reachable + authorized for a supervised role', async () => {
    withRole('');   // monitor.mode defaults fleet
    const rep = await doctor({}, green(), 'linux', stubFetch('ok'));
    const m = rep.checks.find(c => c.name === 'monitor: daemon API')!;
    expect(m).toBeTruthy();
    expect(m.ok).toBe(true);
    expect(m.detail).toMatch(/authorized/);
  });

  it('flags a 401 from the daemon API with a token hint', async () => {
    withRole('');
    const rep = await doctor({}, green(), 'linux', stubFetch('401'));
    const m = rep.checks.find(c => c.name === 'monitor: daemon API')!;
    expect(m.ok).toBe(false);
    expect(m.detail).toMatch(/401/);
    expect(m.detail).toMatch(/OURS_API_TOKEN/);
    expect(rep.ok).toBe(false);
  });

  it('flags an unreachable daemon with a start hint', async () => {
    withRole('');
    const rep = await doctor({}, green(), 'linux', stubFetch('down'));
    const m = rep.checks.find(c => c.name === 'monitor: daemon API')!;
    expect(m.ok).toBe(false);
    expect(m.detail).toMatch(/ours daemon start/);
  });

  it('uses config port and apiToken for the same profile as the runtime monitor', async () => {
    const oursConfig = join(dir, 'ours-profile.json');
    writeFileSync(oursConfig, JSON.stringify({ port: 4111, apiToken: 'config-token' }));
    process.env.OURS_CONFIG = oursConfig;
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return { status: 200, ok: true, json: async () => ({}) };
    };
    withRole('');
    const rep = await doctor({}, green(), 'linux', fetch);
    const m = rep.checks.find(c => c.name === 'monitor: daemon API')!;
    expect(m.ok).toBe(true);
    expect(calls.map(c => c.url)).toEqual([
      'http://127.0.0.1:4111/state-dir',
      'http://127.0.0.1:4111/identities',
    ]);
    expect(calls[1].headers).toEqual({ 'x-ours-api-token': 'config-token' });
  });

  it('uses the owner daemon-token when no explicit token is configured', async () => {
    const stateDir = join(dir, 'owner-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'daemon-token'), 'owner-token\n');
    process.env.OURS_STATE_DIR = stateDir;
    let authHeaders: Record<string, string> | undefined;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/identities')) authHeaders = init?.headers;
      return { status: 200, ok: true, json: async () => ({}) };
    };
    withRole('');
    const rep = await doctor({}, green(), 'linux', fetch);
    expect(rep.checks.find(c => c.name === 'monitor: daemon API')?.ok).toBe(true);
    expect(authHeaders).toEqual({ 'x-ours-api-token': 'owner-token' });
  });

  it('deduplicates identical role profiles and probes distinct role.env profiles separately', async () => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'), JSON.stringify({
      roles: {
        A: { harness: 'fake', env: { OURS_PORT: '4201', OURS_API_TOKEN: 'shared' } },
        B: { harness: 'fake', env: { OURS_PORT: '4201', OURS_API_TOKEN: 'shared' } },
        C: { harness: 'fake', env: { OURS_PORT: '4202', OURS_API_TOKEN: 'other' } },
      },
    }));
    const calls: Array<{ url: string; token?: string }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, token: init?.headers?.['x-ours-api-token'] });
      return { status: 200, ok: true, json: async () => ({}) };
    };
    const rep = await doctor({}, green(), 'linux', fetch);
    expect(calls).toHaveLength(4); // two requests per distinct profile, not per role
    expect(calls.filter(c => c.url.includes(':4201/'))).toHaveLength(2);
    expect(calls.filter(c => c.url.includes(':4202/'))).toHaveLength(2);
    expect(calls.find(c => c.url === 'http://127.0.0.1:4201/identities')?.token).toBe('shared');
    expect(calls.find(c => c.url === 'http://127.0.0.1:4202/identities')?.token).toBe('other');
    expect(rep.checks.some(c => c.name === 'monitor: daemon API (A, B)')).toBe(true);
    expect(rep.checks.some(c => c.name === 'monitor: daemon API (C)')).toBe(true);
  });

  it('uses the selected config path in its 401 hint without exposing the token', async () => {
    const oursConfig = join(dir, 'custom-profile.json');
    writeFileSync(oursConfig, JSON.stringify({ apiToken: 'never-print-me' }));
    process.env.OURS_CONFIG = oursConfig;
    withRole('');
    const rep = await doctor({}, green(), 'linux', stubFetch('401'));
    const detail = rep.checks.find(c => c.name === 'monitor: daemon API')!.detail;
    expect(detail).toContain(oursConfig);
    expect(detail).not.toContain('never-print-me');
    expect(detail).not.toContain('~/.ours/config.json');
  });

  it('skips the probe entirely when no role is supervised', async () => {
    let called = false;
    withRole('    monitor:\n      mode: native\n');
    const spy: FetchLike = async (...a) => { called = true; return stubFetch('ok')(...a); };
    const rep = await doctor({}, green(), 'linux', spy);
    expect(rep.checks.find(c => c.name === 'monitor: daemon API')).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('user bus check (#9)', () => {
  let savedXdg: string | undefined;
  beforeEach(() => { savedXdg = process.env.XDG_RUNTIME_DIR; });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
  });

  it('reports the user bus as ok when XDG_RUNTIME_DIR is set', async () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/424242';
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const bus = rep.checks.find(c => c.name === 'user bus');
    expect(bus?.ok).toBe(true);
    expect(bus?.detail).toContain('/run/user/424242');
  });

  it('is a linux-only check', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
      'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
      'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    }), 'darwin');
    expect(rep.checks.find(c => c.name === 'user bus')).toBeUndefined();
  });
});

describe('doctor config validity (1.4)', () => {
  const HEALTHY_HOST = {
    'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
  };
  const run = (opts: Parameters<typeof doctor>[0] = {}) =>
    doctor(opts, execWith(HEALTHY_HOST), 'linux', stubFetch());
  const writeCfg = (yaml: string) => writeFileSync(join(dir, 'fleet.yaml'), yaml);

  /** Every configuration `ours-fleet config` refuses. */
  const REJECTED: Array<[string, string, RegExp]> = [
    ['a YAML syntax error', 'roles:\n  A: [oops\n', /./],
    ['an unknown role key', 'roles:\n  A:\n    harnes: fake\n', /unknown key\(s\) harnes/],
    ['a misspelled permission key', 'roles:\n  A:\n    permissions:\n      aproval: allow\n',
      /permissions: unknown key\(s\) aproval/],
    ['an invalid session backend', 'roles:\n  A:\n    session: telepathy\n', /session: must be one of/],
    ['a role name with illegal characters', 'roles:\n  "bad name":\n    harness: fake\n',
      /invalid role name/],
  ];

  for (const [label, yaml, cause] of REJECTED) {
    it(`fails on ${label}, naming the same cause as \`config\``, async () => {
      writeCfg(yaml);
      // The premise: `config` rejects this exact input.
      expect(() => loadConfig(join(dir, 'fleet.yaml'))).toThrow();
      const parserMessage = (() => {
        try { loadConfig(join(dir, 'fleet.yaml')); return ''; }
        catch (e) { return (e as Error).message; }
      })();

      const rep = await run();
      const cfg = rep.checks.find(c => c.name === 'config')!;
      expect(cfg.ok).toBe(false);
      expect(cfg.detail).toMatch(cause);
      expect(cfg.detail).toBe(parserMessage);      // same actionable cause
      expect(rep.ok).toBe(false);                  // and the command exits non-zero
    });
  }

  it('keeps running the host checks when the config is invalid', async () => {
    writeCfg('roles:\n  A:\n    harnes: fake\n');
    const rep = await run();
    for (const name of ['node', 'tmux', 'ours daemon', 'linger', 'user bus'])
      expect(rep.checks.find(c => c.name === name), name).toBeDefined();
  });

  it('still runs the AI CLI prerequisites when the config resolves no harness', async () => {
    writeCfg('roles:\n  A:\n    harnes: fake\n');
    const rep = await run();
    // Production adapters are registered by importing them (as the CLI does).
    expect(rep.checks.some(c => c.name.startsWith('claude-code: '))).toBe(true);
    expect(rep.checks.some(c => c.name.startsWith('codex: '))).toBe(true);
  });

  it('honours an explicit --harness over the fallback', async () => {
    writeCfg('roles:\n  A:\n    harnes: fake\n');
    const rep = await run({ harness: 'codex' });
    expect(rep.checks.some(c => c.name.startsWith('codex: '))).toBe(true);
    expect(rep.checks.some(c => c.name.startsWith('claude-code: '))).toBe(false);
  });

  it('reports the configured-role count and does not fail an empty fleet', async () => {
    const rep = await run();                          // no fleet.yaml at all
    expect(rep.checks.find(c => c.name === 'roles')).toMatchObject({ ok: true, detail: '0 configured' });
    expect(rep.checks.find(c => c.name === 'config')!.ok).toBe(true);
  });

  it('counts the roles a valid config resolves and names the files', async () => {
    writeCfg('roles:\n  A:\n    harness: fake\n  B:\n    harness: fake\n');
    const rep = await run();
    expect(rep.checks.find(c => c.name === 'roles')!.detail).toBe('2 configured');
    expect(rep.checks.find(c => c.name === 'config')!.detail).toContain('fleet.yaml');
  });

  it('reports the role count as unknown — not zero — when the config did not load', async () => {
    writeCfg('roles:\n  A:\n    harnes: fake\n');
    const rep = await run();
    const rolesCheck = rep.checks.find(c => c.name === 'roles')!;
    expect(rolesCheck.ok).toBe(false);
    expect(rolesCheck.detail).toContain('unknown');
    expect(rolesCheck.detail).not.toContain('0 configured');
  });

  it('fails on a missing explicit config file', async () => {
    const rep = await doctor(
      { configPath: join(dir, 'nope.yaml') }, execWith(HEALTHY_HOST), 'linux', stubFetch());
    const cfg = rep.checks.find(c => c.name === 'config')!;
    expect(cfg.ok).toBe(false);
    expect(cfg.detail).toContain('config not found');
  });
});

describe('doctor permission translation (2.3)', () => {
  const HEALTHY = {
    'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
  };
  const run = () => doctor({}, execWith(HEALTHY), 'linux', stubFetch());
  const writeCfg = (yaml: string) => writeFileSync(join(dir, 'fleet.yaml'), yaml);
  const check = (rep: Awaited<ReturnType<typeof doctor>>, role: string) =>
    rep.checks.find(c => c.name === `permissions: ${role}`)!;

  it('warns on a lossy Claude combination and names the native mode', async () => {
    writeCfg('roles:\n  A:\n    harness: claude-code\n    permissions:\n      approval: allow\n');
    const c = check(await run(), 'A');
    expect(c.ok).toBe(true);                         // lossy is a warning, not a failure
    expect(c.detail).toContain('approval=allow');
    expect(c.detail).toContain('permission_mode=');
    expect(c.detail).toContain('do not exactly represent');
  });

  it('stays quiet for the one Claude combination that is exact', async () => {
    writeCfg('roles:\n  A:\n    harness: claude-code\n'
      + '    permissions:\n      approval: ask\n      filesystem: workspace\n');
    const c = check(await run(), 'A');
    expect(c.detail).toContain('(exact)');
    expect(c.detail).not.toContain('do not exactly represent');
  });

  it('does not warn for Codex, which represents the intent exactly', async () => {
    writeCfg('roles:\n  A:\n    harness: codex\n'
      + '    permissions:\n      approval: allow\n      filesystem: unrestricted\n');
    const c = check(await run(), 'A');
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('(exact)');
    expect(c.detail).toContain('sandbox=danger-full-access');
  });

  it('reports the enforced codex-acp allow + workspace runtime', async () => {
    writeCfg('roles:\n  A:\n    harness: codex\n    session: acp\n'
      + '    permissions:\n      approval: allow\n      filesystem: workspace\n'
      + '      unattended: deny\n');
    const rep = await run();
    const c = check(rep, 'A');
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('mode=agent approval=never sandbox=workspace-write');
    expect(c.detail).toContain('(exact)');
    const floor = rep.checks.find(candidate => candidate.name === 'unattended floor: A')!;
    expect(floor.ok).toBe(true);
    expect(floor.detail).toContain('workspace-edit');
  });

  it('fails the role when its harness declares neutral permissions unsupported', async () => {
    registerAdapter({
      ...fakeAdapter, id: 'no-perms',
      translatePermissions: () => ({ supported: false, reason: 'it has no permission model' }),
    });
    writeCfg('roles:\n  A:\n    harness: no-perms\n');
    const c = check(await run(), 'A');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('cannot express neutral permissions');
    expect(c.detail).toContain('it has no permission model');
  });
});

describe('doctor unattended capability floor (2.1)', () => {
  const HEALTHY = {
    'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
  };
  const run = () => doctor({}, execWith(HEALTHY), 'linux', stubFetch());
  const writeCfg = (yaml: string) => writeFileSync(join(dir, 'fleet.yaml'), yaml);
  const floor = (rep: Awaited<ReturnType<typeof doctor>>, role: string) =>
    rep.checks.find(c => c.name === `unattended floor: ${role}`)!;

  it('fails an under-permissioned unattended role before it is ever started', async () => {
    writeCfg('roles:\n  Worker:\n    harness: claude-code\n'
      + '    permissions:\n      approval: ask\n      unattended: deny\n');
    const rep = await run();
    const c = floor(rep, 'Worker');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('MISSING');
    expect(c.detail).toContain('workspace-edit');
    expect(c.detail).toContain('denied silently');
    expect(rep.ok).toBe(false);                    // and the command exits non-zero
  });

  it('passes a floor-compliant role and lists what it grants', async () => {
    writeCfg('roles:\n  Worker:\n    harness: claude-code\n'
      + '    permissions:\n      approval: allow\n      filesystem: workspace\n      unattended: deny\n');
    const c = floor(await run(), 'Worker');
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('workspace-edit');
    expect(c.detail).toContain('messaging');
  });

  it('warns rather than fails when the role waits instead of denying', async () => {
    writeCfg('roles:\n  Worker:\n    harness: claude-code\n'
      + '    permissions:\n      approval: ask\n      unattended: wait\n');
    const c = floor(await run(), 'Worker');
    expect(c.ok).toBe(true);                       // a human can still attach…
    expect(c.detail).toContain('MISSING');         // …but the shortfall is still stated
    expect(c.detail).toContain('block the turn');
  });

  it('checks Codex roles on the same floor', async () => {
    writeCfg('roles:\n  Under:\n    harness: codex\n'
      + '    permissions:\n      approval: ask\n      unattended: deny\n'
      + '  Ok:\n    harness: codex\n'
      + '    permissions:\n      approval: allow\n      filesystem: workspace\n      unattended: deny\n');
    const rep = await run();
    expect(floor(rep, 'Under').ok).toBe(false);
    expect(floor(rep, 'Ok').ok).toBe(true);
  });

  it('a read-only allow role is failed for exactly the write capabilities', async () => {
    writeCfg('roles:\n  Reader:\n    harness: claude-code\n'
      + '    permissions:\n      approval: allow\n      filesystem: read-only\n      unattended: deny\n');
    const c = floor(await run(), 'Reader');
    expect(c.ok).toBe(false);
    const missing = /MISSING ([^—]+)/.exec(c.detail)![1];
    expect(missing).toContain('write-state');
    expect(missing).toContain('workspace-edit');
    expect(missing).not.toContain('messaging');    // messaging IS granted
    expect(c.detail).toContain('grants only');
    expect(c.detail).toContain('messaging');
  });
});

describe('native overrides contradicting neutral intent (2.4)', () => {
  const HEALTHY = {
    'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
  };
  const run = () => doctor({}, execWith(HEALTHY), 'linux', stubFetch());
  const writeCfg = (yaml: string) => writeFileSync(join(dir, 'fleet.yaml'), yaml);
  const conflicts = (rep: Awaited<ReturnType<typeof doctor>>, role: string) =>
    rep.checks.filter(c => c.name === `permission conflict: ${role}`);

  /** label, role yaml body, expected conflicting key (null = must stay quiet). */
  const CLAUDE: Array<[string, string, string | null]> = [
    ['neutral only', '    permissions:\n      approval: allow\n', null],
    ['native only', '    harness_options:\n      permission_mode: plan\n', null],
    ['both, matching', '    permissions:\n      approval: allow\n'
      + '    harness_options:\n      permission_mode: bypassPermissions\n', null],
    ['both, conflicting', '    permissions:\n      approval: allow\n'
      + '    harness_options:\n      permission_mode: plan\n', 'permission_mode'],
    ['both, conflicting the other way', '    permissions:\n      approval: deny\n'
      + '    harness_options:\n      permission_mode: bypassPermissions\n', 'permission_mode'],
  ];

  for (const [label, body, key] of CLAUDE) {
    it(`Claude, ${label}: ${key ? 'warns' : 'stays quiet'}`, async () => {
      writeCfg(`roles:\n  R:\n    harness: claude-code\n${body}`);
      const found = conflicts(await run(), 'R');
      if (!key) { expect(found).toHaveLength(0); return; }
      expect(found).toHaveLength(1);
      expect(found[0].detail).toContain(`harness_options.${key}=`);
      expect(found[0].detail).toContain('contradicts');
      expect(found[0].detail).toContain('wins');
    });
  }

  /** Codex states TWO native permission settings, so both must be compared. */
  const CODEX: Array<[string, string, string[]]> = [
    ['both, matching', '    permissions:\n      approval: allow\n      filesystem: workspace\n'
      + '    harness_options:\n      approval: never\n      sandbox: workspace-write\n', []],
    ['approval conflicts', '    permissions:\n      approval: allow\n      filesystem: workspace\n'
      + '    harness_options:\n      approval: on-request\n', ['approval']],
    ['sandbox conflicts', '    permissions:\n      approval: allow\n      filesystem: workspace\n'
      + '    harness_options:\n      sandbox: danger-full-access\n', ['sandbox']],
    ['both conflict', '    permissions:\n      approval: ask\n      filesystem: read-only\n'
      + '    harness_options:\n      approval: never\n      sandbox: danger-full-access\n',
      ['approval', 'sandbox']],
    ['native only', '    harness_options:\n      sandbox: danger-full-access\n', []],
  ];

  for (const [label, body, keys] of CODEX) {
    it(`Codex, ${label}: ${keys.length} warning(s)`, async () => {
      writeCfg(`roles:\n  R:\n    harness: codex\n${body}`);
      const found = conflicts(await run(), 'R');
      expect(found).toHaveLength(keys.length);
      for (const key of keys)
        expect(found.some(c => c.detail.includes(`harness_options.${key}=`)), key).toBe(true);
    });
  }

  it('the permission_mode alias is compared as approval for Codex', async () => {
    writeCfg('roles:\n  R:\n    harness: codex\n'
      + '    permissions:\n      approval: allow\n'
      + '    harness_options:\n      permission_mode: on-request\n');
    const found = conflicts(await run(), 'R');
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('harness_options.approval=on-request');
  });

  it('a defaults-level permissions block still counts as a declared source', async () => {
    writeCfg('defaults:\n  permissions:\n    approval: allow\n'
      + 'roles:\n  R:\n    harness: claude-code\n'
      + '    harness_options:\n      permission_mode: plan\n');
    expect(conflicts(await run(), 'R')).toHaveLength(1);
  });

  it('names both values and which one wins', async () => {
    writeCfg('roles:\n  R:\n    harness: claude-code\n'
      + '    permissions:\n      approval: allow\n'
      + '    harness_options:\n      permission_mode: plan\n');
    const detail = conflicts(await run(), 'R')[0].detail;
    expect(detail).toContain('permission_mode=plan');            // the native value
    expect(detail).toContain('permission_mode=bypassPermissions'); // the neutral translation
    expect(detail).toMatch(/harness_options\.permission_mode=plan wins/);
  });
});

describe('doctor install provenance', () => {
  let prefixes: string;
  let legacy: string;
  let current: string;
  beforeEach(() => {
    prefixes = mkdtempSync(join(tmpdir(), 'ours-fleet-doc-inst-'));
    legacy = installPrefix(prefixes, 'legacy');
    current = installPrefix(prefixes, 'current');
  });
  afterEach(() => rmSync(prefixes, { recursive: true, force: true }));

  const checks = async (scan: { path: string; argv1?: string }) =>
    (await doctorImpl({ installScan: scan }, execWith({}), 'linux', stubFetch())).checks
      .filter(c => c.name.startsWith('install'));

  it('names the build serving this process', async () => {
    const [summary, ...rest] = await checks({ path: join(current, 'bin'), argv1: cliPath(current) });
    expect(rest).toEqual([]);
    expect(summary.name).toBe('install');
    expect(summary.ok).toBe(true);
    expect(summary.detail).toContain('0.16.0+c0ffee123456');
    expect(summary.detail).toContain(pkgRoot(current));
  });

  it('gives a same-semver build conflict its own failing row', async () => {
    const rows = await checks({
      path: [join(legacy, 'bin'), join(current, 'bin')].join(delimiter),
      argv1: cliPath(current),
    });
    const conflict = rows.find(c => c.name === 'install: version-build-conflict');
    expect(conflict?.ok).toBe(false);
    expect(conflict?.detail).toContain('different builds');
    expect(conflict?.detail).toContain('monitor.interrupt.after_tool');
  });

  it('reports the running build even when nothing is on PATH', async () => {
    const [summary] = await checks({ path: join(prefixes, 'nowhere'), argv1: cliPath(current) });
    expect(summary.detail).toContain('0.16.0+c0ffee123456');
    expect(summary.detail).toContain('no ours-fleet on PATH');
  });

  it('notes a pre-provenance install without failing the report', async () => {
    const rows = await checks({ path: join(legacy, 'bin'), argv1: cliPath(legacy) });
    const note = rows.find(c => c.name === 'install: unknown-build-identity');
    expect(note?.ok).toBe(true);
    expect(note?.detail).toContain('predates build provenance');
    expect(rows.every(c => c.ok)).toBe(true);
  });
});

describe('doctor rooms-tasks checks (§5.3)', () => {
  const HEALTHY_HOST = {
    'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
    'ours version': { stdout: JSON.stringify({ name: '@ours.network/cli', version: '1.0.1' }), stderr: '', code: 0 },
    'ours daemon': { stdout: JSON.stringify({ state: 'running' }), stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
  };
  const CID_64 = 'a'.repeat(64);
  const run = (opts: Parameters<typeof doctor>[0] = {}) =>
    doctor(opts, execWith(HEALTHY_HOST), 'linux', stubFetch());
  const writeCfg = (yaml: string) => writeFileSync(join(dir, 'fleet.yaml'), yaml);

  const ROOMS_YAML = (cid = CID_64, extra = '') =>
    `roles:\n  Developer:\n    harness: fake\n` +
    `rooms:\n  provider: cowork\n  owner:\n    expected_cid: ${cid}\n${extra}`;

  it('runs owner CID shape check on valid config', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML());
    const rep = await run();
    const cid = rep.checks.find(c => c.name === 'rooms: owner CID')!;
    expect(cid).toBeTruthy();
    expect(cid.ok).toBe(true);
    expect(cid.detail).toContain('valid 64-hex CID');
  });

  it('checks invite presence (not configured)', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML());
    const rep = await run();
    const inv = rep.checks.find(c => c.name === 'rooms: owner invite')!;
    expect(inv).toBeTruthy();
    expect(inv.ok).toBe(false);
    expect(inv.detail).toContain('not configured');
    expect(inv.detail).not.toContain('SECRET');
  });

  it('checks invite presence when configured (shows fingerprint only)', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML(CID_64, '    public_invite: "ours://secret-invite-value"\n'));
    const rep = await run();
    const inv = rep.checks.find(c => c.name === 'rooms: owner invite')!;
    expect(inv.ok).toBe(true);
    expect(inv.detail).toContain('fingerprint:');
    expect(inv.detail).not.toContain('secret-invite-value');
  });

  it('cowork check is emitted when rooms config is present', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML());
    const rep = await run();
    const cw = rep.checks.find(c => c.name === 'cowork')!;
    expect(cw).toBeTruthy();
    expect(cw.detail).toMatch(/management socket/);
  });

  it('warns on template role_ref referencing unknown role', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML() + `room_templates:\n  my-team:\n    version: 1\n    description: test\n    members:\n      - slot: dev\n        role: Dev\n        count: 1\n        role_ref: NonExistentRole\n`);
    const rep = await run();
    const tpl = rep.checks.find(c => c.name?.startsWith('template:') && c.detail?.includes('NonExistentRole'))!;
    expect(tpl).toBeTruthy();
    expect(tpl.detail).toContain('not found in configured roles');
  });

  it('validates default template when configured', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML(CID_64, '  defaults:\n    template: nonexistent-template\n'));
    const rep = await run();
    const dt = rep.checks.find(c => c.name === 'rooms: default template')!;
    expect(dt).toBeTruthy();
    expect(dt.ok).toBe(false);
    expect(dt.detail).toContain('not found');
  });

  it('passes default template when it resolves to a builtin', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML(CID_64, '  defaults:\n    template: development-team\n'));
    const rep = await run();
    const dt = rep.checks.find(c => c.name === 'rooms: default template')!;
    expect(dt.ok).toBe(true);
    expect(dt.detail).toContain('development-team@1');
  });

  it('warns on stale task-room cross-references', async () => {
    registerAdapter(fakeAdapter);
    writeCfg(ROOMS_YAML());
    const { createTask } = await import('../src/rooms-tasks/task-state.js');
    createTask({
      title: 'orphaned', origin: { type: 'cli' },
      room_id: 'nonexistent-room-id',
    });
    const rep = await run();
    const stale = rep.checks.find(c => c.name === 'rooms: stale tasks');
    expect(stale).toBeTruthy();
    expect(stale!.detail).toContain('reference missing rooms');
  });

  it('skips rooms checks entirely when no rooms config is present', async () => {
    writeCfg('roles:\n  A:\n    harness: fake\n');
    registerAdapter(fakeAdapter);
    const rep = await run();
    expect(rep.checks.find(c => c.name === 'rooms: owner CID')).toBeUndefined();
    expect(rep.checks.find(c => c.name === 'cowork')).toBeUndefined();
  });
});

describe('doctor install scanning is not ambient', () => {
  it('ignores the host PATH so an unrelated install cannot change the report', async () => {
    const prefixes = mkdtempSync(join(tmpdir(), 'ours-fleet-doc-amb-'));
    const legacy = installPrefix(prefixes, 'legacy');
    const current = installPrefix(prefixes, 'current');
    const savedPath = process.env.PATH;
    process.env.PATH = [join(legacy, 'bin'), join(current, 'bin')].join(delimiter);
    try {
      const report = await doctor({}, execWith({}), 'linux', stubFetch());
      const install = report.checks.filter(c => c.name.startsWith('install'));
      expect(install.map(c => c.name)).toEqual(['install']);
      expect(install[0].detail).toContain('no ours-fleet on PATH');
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      rmSync(prefixes, { recursive: true, force: true });
    }
  });
});
