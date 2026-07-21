import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/doctor.js';
import { registerAdapter } from '../src/harness/registry.js';
import { fakeAdapter } from './registry.test.js';
import type { Exec, ExecResult } from '../src/exec.js';
import type { FetchLike } from '../src/monitor.js';

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

const execWith = (table: Record<string, ExecResult>): Exec =>
  async (cmd, args) => table[[cmd, args[0] ?? ''].join(' ')] ?? { stdout: '', stderr: '', code: 0 };

describe('doctor', () => {
  it('flags missing tmux with an install hint', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: '', stderr: '', code: 127 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const t = rep.checks.find(c => c.name === 'tmux')!;
    expect(t.ok).toBe(false);
    expect(t.detail).toContain('apt install tmux');
    expect(rep.ok).toBe(false);
  });

  it('flags a stopped ours-mcp daemon', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: '', stderr: 'stopped', code: 1 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const d = rep.checks.find(c => c.name === 'ours-mcp daemon')!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain('ours-mcp start');
  });

  it('reports linger only on linux and passes when all green', async () => {
    const green = execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
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
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
    }), 'darwin');
    const h = rep.checks.find(c => c.name === 'nope')!;
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('unknown harness');
  });
});

describe('doctor isolation reporting', () => {
  const green = (over: Record<string, ExecResult> = {}): Exec => execWith({
    'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
    'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
    'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
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
    'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
    'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    ...over,
  });
  const withRole = (monitorYaml: string) => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'), `roles:\n  A:\n    harness: fake\n${monitorYaml}`);
  };

  it('reports the daemon API reachable + authorized for a supervised role', async () => {
    withRole('');   // monitor.enabled defaults true
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
    expect(m.detail).toMatch(/ours-mcp start/);
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
    withRole('    monitor:\n      enabled: false\n');
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
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const bus = rep.checks.find(c => c.name === 'user bus');
    expect(bus?.ok).toBe(true);
    expect(bus?.detail).toContain('/run/user/424242');
  });

  it('is a linux-only check', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: 'tmux 3.4', stderr: '', code: 0 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
    }), 'darwin');
    expect(rep.checks.find(c => c.name === 'user bus')).toBeUndefined();
  });
});
