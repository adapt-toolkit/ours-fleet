import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveEndpoint, resolveApiToken, readDaemonConfig, filterEvents, formatNotificationLine,
  looksModal, createMonitor,
  type NotifyEvent, type MonitorDeps, type FetchResponse,
} from '../src/monitor.js';
import type { MonitorConfig } from '../src/config.js';

const CFG = (over: Partial<MonitorConfig> = {}): MonitorConfig => ({
  enabled: true,
  wake_sources: ['message_received', 'file_received', 'local_contact_request', 'pending_message'],
  batch_ms: 2000,
  inject: 'notification',
  ...over,
});

// A scripted fetch: each call shifts the next response off `script`. When the
// script is exhausted it returns an empty batch at the last cursor (a quiet
// long-poll). A response of {throw:'...'} rejects (transient); {status:401} 401s.
type Scripted = { cursor?: number; events?: NotifyEvent[]; throw?: string; status?: number };
function scriptedFetch(script: Scripted[], onCall?: (url: string, n: number) => void) {
  let n = 0;
  const calls: string[] = [];
  const fetch = async (url: string): Promise<FetchResponse> => {
    const i = n++;
    calls.push(url);
    onCall?.(url, i);
    const s = script[i] ?? { cursor: script.length ? undefined : 0, events: [] };
    if (s.throw) throw new Error(s.throw);
    return {
      status: s.status ?? 200,
      ok: (s.status ?? 200) < 400,
      json: async () => ({ cursor: s.cursor, events: s.events ?? [] }),
    };
  };
  return { fetch, calls: () => calls };
}

interface FakeTmux {
  has: MonitorDeps['tmux']['has'];
  capture: MonitorDeps['tmux']['capture'];
  sendText: MonitorDeps['tmux']['sendText'];
  sendKey: MonitorDeps['tmux']['sendKey'];
  sent: string[];
  enters: number;
}
function fakeTmux(opts: { has?: boolean; pane?: () => string } = {}): FakeTmux {
  const sent: string[] = [];
  let enters = 0;
  return {
    sent, get enters() { return enters; },
    has: async () => opts.has ?? true,
    capture: async () => (opts.pane ? opts.pane() : ''),
    sendText: async (_n: string, t: string) => { sent.push(t); },
    sendKey: async (_n: string, _k: string) => { enters++; },
  } as FakeTmux;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-mon-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeDeps(fetch: MonitorDeps['fetch'], tmux: FakeTmux, over: Partial<MonitorDeps> = {}): MonitorDeps {
  let clock = 0;
  return {
    fetch,
    tmux,
    isAlive: () => true,
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    log: () => {},
    env: {},
    timers: { set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => {} },
    ...over,
  };
}

// Hermetic base env: OURS_CONFIG points at a nonexistent path so no test ever
// reads the real ~/.ours/config.json, and OURS_STATE_DIR isolates daemon-token.
const NO_CONFIG = join(tmpdir(), 'ours-fleet-no-such-config-xyz.json');
const hermetic = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OURS_CONFIG: NO_CONFIG, OURS_STATE_DIR: join(tmpdir(), 'ours-fleet-no-such-state-xyz'), ...over,
});

describe('resolveEndpoint', () => {
  it('defaults to port 3050 and sends no token header when unset', () => {
    const ep = resolveEndpoint(hermetic());
    expect(ep.url('Alice')).toBe('http://127.0.0.1:3050/identities/Alice/notifications');
    expect(ep.headers).toEqual({});
  });
  it('honors OURS_PORT and sends the token header when set', () => {
    const ep = resolveEndpoint(hermetic({ OURS_PORT: '4000', OURS_API_TOKEN: 'sek' }));
    expect(ep.url('A')).toContain(':4000/');
    expect(ep.headers).toEqual({ 'x-ours-api-token': 'sek' });
  });
  it('url-encodes the identity name', () => {
    expect(resolveEndpoint(hermetic()).url('a b')).toContain('/identities/a%20b/');
  });
});

describe('token resolution (issue #17)', () => {
  // Precedence chain: env OURS_API_TOKEN (trimmed) > config apiToken (trimmed)
  // > <stateDir>/daemon-token. Config & daemon-token live under the temp `dir`.
  const cfgPath = () => join(dir, 'config.json');
  const writeCfg = (o: unknown) => writeFileSync(cfgPath(), JSON.stringify(o));
  const writeToken = (sd: string, t: string) => { mkdirSync(sd, { recursive: true }); writeFileSync(join(sd, 'daemon-token'), t); };
  const baseEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    ({ OURS_CONFIG: cfgPath(), OURS_STATE_DIR: join(dir, 'state'), ...over });
  const tokenOf = (env: NodeJS.ProcessEnv) =>
    resolveEndpoint(env).headers['x-ours-api-token'];

  it('env token present → header uses env token', () => {
    writeCfg({ apiToken: 'from-config' });
    writeToken(join(dir, 'state'), 'from-file');
    expect(tokenOf(baseEnv({ OURS_API_TOKEN: 'from-env' }))).toBe('from-env');
  });

  it('env token whitespace-only → falls through to config', () => {
    writeCfg({ apiToken: 'from-config' });
    expect(tokenOf(baseEnv({ OURS_API_TOKEN: '   ' }))).toBe('from-config');
  });

  it('env token trimmed of surrounding whitespace', () => {
    expect(tokenOf(baseEnv({ OURS_API_TOKEN: '  padded  ' }))).toBe('padded');
  });

  it('no env → config apiToken (trimmed) wins over daemon-token', () => {
    writeCfg({ apiToken: '  cfg-token  ' });
    writeToken(join(dir, 'state'), 'file-token');
    expect(tokenOf(baseEnv())).toBe('cfg-token');
  });

  it('config apiToken whitespace-only → ignored → falls through to daemon-token', () => {
    writeCfg({ apiToken: '   ' });
    writeToken(join(dir, 'state'), 'file-token');
    expect(tokenOf(baseEnv())).toBe('file-token');
  });

  it('no env, no config → reads <stateDir>/daemon-token (trimmed)', () => {
    writeToken(join(dir, 'state'), '  daemon-tok\n');
    expect(tokenOf(baseEnv())).toBe('daemon-tok');
  });

  it('malformed config JSON → treated as absent → daemon-token', () => {
    writeFileSync(cfgPath(), '{ this is not json ');
    writeToken(join(dir, 'state'), 'file-token');
    expect(tokenOf(baseEnv())).toBe('file-token');
  });

  it('nothing present anywhere → no token header', () => {
    expect(resolveEndpoint(baseEnv()).headers).toEqual({});
    expect(resolveApiToken(baseEnv())).toBeUndefined();
  });

  it('stateDir precedence: OURS_STATE_DIR wins over config.stateDir for daemon-token', () => {
    const envSd = join(dir, 'env-state');
    const cfgSd = join(dir, 'cfg-state');
    writeCfg({ stateDir: cfgSd });
    writeToken(envSd, 'from-env-statedir');
    writeToken(cfgSd, 'from-cfg-statedir');
    expect(tokenOf(baseEnv({ OURS_STATE_DIR: envSd }))).toBe('from-env-statedir');
  });

  it('stateDir precedence: config.stateDir used when OURS_STATE_DIR unset', () => {
    const cfgSd = join(dir, 'cfg-state2');
    writeCfg({ stateDir: cfgSd });
    writeToken(cfgSd, 'from-cfg-statedir');
    expect(tokenOf({ OURS_CONFIG: cfgPath() })).toBe('from-cfg-statedir');
  });

  it('port precedence: OURS_PORT > config.port > 3050', () => {
    writeCfg({ port: 4100 });
    expect(resolveEndpoint(baseEnv({ OURS_PORT: '4200' })).url('A')).toContain(':4200/');
    expect(resolveEndpoint(baseEnv()).url('A')).toContain(':4100/');
    writeCfg({});
    expect(resolveEndpoint(baseEnv()).url('A')).toContain(':3050/');
  });

  it('matches ours-mcp parseInt + nullish port semantics', () => {
    writeCfg({ port: 4100 });
    expect(resolveEndpoint(baseEnv({ OURS_PORT: '4200suffix' })).port).toBe(4200);
    expect(resolveEndpoint(baseEnv({ OURS_PORT: 'not-a-port' })).port).toBe(4100);
    writeCfg({ port: 0 });
    expect(resolveEndpoint(baseEnv()).port).toBe(0);
    expect(resolveEndpoint(baseEnv({ OURS_PORT: '0' })).port).toBe(0);
  });

  it('unreadable daemon-token (chmod 000) → no throw, no token', () => {
    const sd = join(dir, 'locked-state');
    writeToken(sd, 'secret');
    chmodSync(join(sd, 'daemon-token'), 0o000);
    try {
      expect(() => resolveApiToken(baseEnv({ OURS_STATE_DIR: sd }))).not.toThrow();
      // On most CI runners chmod 000 blocks the read → undefined; if root can still
      // read it, the token comes back — either way the call must not throw.
    } finally {
      chmodSync(join(sd, 'daemon-token'), 0o600);
    }
  });

  it('readDaemonConfig returns {} on a missing file', () => {
    expect(readDaemonConfig({ OURS_CONFIG: join(dir, 'nope.json') })).toEqual({});
  });
});

describe('filterEvents', () => {
  it('keeps only events whose type is in wake_sources', () => {
    const evs: NotifyEvent[] = [
      { event: 'message_received', from: 'X' },
      { event: 'sibling_contact_added', from: 'Y' },
      { event: 'file_received', from: 'Z' },
    ];
    expect(filterEvents(evs, ['message_received', 'file_received']).map(e => e.event))
      .toEqual(['message_received', 'file_received']);
  });
});

describe('formatNotificationLine', () => {
  it('summarizes messages + files with senders and ids', () => {
    const line = formatNotificationLine([
      { event: 'message_received', from: 'FleetCoordinator', msg_id: 41 },
      { event: 'message_received', from: 'FleetCoordinator', msg_id: 43 },
      { event: 'file_received', from: 'Verifier-1' },
    ]);
    expect(line).toBe(
      '[fleet-monitor] 2 new messages from FleetCoordinator (#41, #43), 1 file from Verifier-1 — run get_messages');
  });
  it('uses singular wording for one message', () => {
    expect(formatNotificationLine([{ event: 'message_received', from: 'A', msg_id: 1 }]))
      .toBe('[fleet-monitor] 1 new message from A (#1) — run get_messages');
  });
  it('summarizes introductions and pending messages', () => {
    const line = formatNotificationLine([
      { event: 'local_contact_request', from: 'New' },
      { event: 'pending_message', from: 'Q' },
    ]);
    expect(line).toContain('1 pending introduction from New');
    expect(line).toContain('1 queued message from Q');
  });
  it('length-caps a huge burst to compact counts', () => {
    const many: NotifyEvent[] = Array.from({ length: 60 }, (_, i) =>
      ({ event: 'message_received', from: `Sender-${i}`, msg_id: i }));
    const line = formatNotificationLine(many);
    expect(line.length).toBeLessThanOrEqual(260);
    expect(line).toContain('60 messages');
    expect(line.endsWith('— run get_messages')).toBe(true);
  });
});

describe('looksModal', () => {
  it('detects a "Do you want" trust/permission dialog', () => {
    expect(looksModal('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBe(true);
  });
  it('detects a numbered selection menu with a pointer', () => {
    expect(looksModal('Select an option:\n❯ 1. Alpha\n  2. Beta\n  3. Gamma')).toBe(true);
  });
  it('does not flag ordinary transcript text', () => {
    expect(looksModal('The agent replied with 3 ideas and a summary.\n> ')).toBe(false);
  });
});

describe('Monitor.prime', () => {
  it('primes at tip, records the cursor, and marks armed', async () => {
    const { fetch, calls } = scriptedFetch([{ cursor: 128, events: [] }]);
    const tmux = fakeTmux();
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch, tmux) });
    await mon.prime();
    expect(calls()[0]).toContain('since=tip');
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('128');
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/armed/);
  });

  it('marks failed and never injects on a 401', async () => {
    const { fetch } = scriptedFetch([{ status: 401 }]);
    const tmux = fakeTmux();
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch, tmux) });
    await mon.prime();
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/failed/);
    await mon.run(1);                       // must return immediately, no throw
    expect(tmux.sent).toEqual([]);
  });

  it('names the selected config and token-file paths on a 401 without exposing the token', async () => {
    const configPath = join(dir, 'selected-profile.json');
    const stateDir = join(dir, 'selected-state');
    writeFileSync(configPath, JSON.stringify({ apiToken: 'super-secret', stateDir }));
    const { fetch } = scriptedFetch([{ status: 401 }]);
    const deps = makeDeps(fetch, fakeTmux(), { env: { OURS_CONFIG: configPath } });
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps });
    await mon.prime();
    const status = readFileSync(join(dir, '.monitor-status'), 'utf8');
    expect(status).toContain(configPath);
    expect(status).toContain(join(stateDir, 'daemon-token'));
    expect(status).not.toContain('super-secret');
    expect(status).not.toContain('~/.ours/config.json');
  });

  it('degrades (does not throw) when the daemon is down at prime', async () => {
    const { fetch } = scriptedFetch([{ throw: 'ECONNREFUSED' }]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch, fakeTmux()) });
    await expect(mon.prime()).resolves.toBeUndefined();
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/degraded/);
  });
});

describe('Monitor.run — delivery', () => {
  it('injects one notification line for a filtered wake and advances the cursor', async () => {
    const tmux = fakeTmux();
    const { fetch } = scriptedFetch([
      { cursor: 10, events: [] },                                             // prime tip
      { cursor: 20, events: [                                                 // poll 1
        { event: 'message_received', from: 'Coord', msg_id: 7 },
        { event: 'sibling_contact_added', from: 'ignored' },                  // filtered out
      ] },
    ]);
    let stopped = false;
    const deps = makeDeps(fetch, tmux);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });
    // Stop the loop as soon as the line lands.
    const origSend = tmux.sendText;
    tmux.sendText = async (n, t) => { await origSend(n, t); if (!stopped) { stopped = true; mon.stop(); } };
    await mon.prime();
    await mon.run(1);
    expect(tmux.sent).toHaveLength(1);
    expect(tmux.sent[0]).toBe('[fleet-monitor] 1 new message from Coord (#7) — run get_messages');
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('20');
  });

  it('holds injection while a modal dialog is on screen, then delivers when it clears', async () => {
    let modal = true;
    const tmux = fakeTmux({ pane: () => (modal ? 'Do you want to proceed?\n❯ 1. Yes\n  2. No' : 'idle\n> ') });
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 1 }] },
    ]);
    const deps = makeDeps(fetch, tmux);
    let sleeps = 0;
    const mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }),
      deps: { ...deps, sleep: async (ms: number) => { await deps.sleep(ms); if (++sleeps === 3) modal = false; } },
    });
    const orig = tmux.sendText;
    tmux.sendText = async (n, t) => { await orig(n, t); mon.stop(); };
    await mon.prime();
    await mon.run(1);
    expect(modal).toBe(false);
    expect(tmux.sent).toHaveLength(1);
  });

  it('does not inject and degrades when the session is offline', async () => {
    const tmux = fakeTmux({ has: false });
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 1 }] },
    ]);
    const deps = makeDeps(fetch, tmux, { isAlive: () => false });
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });
    await mon.prime();
    // isAlive false ⇒ run() should return promptly without injecting.
    await mon.run(1);
    expect(tmux.sent).toEqual([]);
  });

  it('re-sends Enter when the line is still sitting in the composer', async () => {
    // pane keeps showing the injected text on the last line until the 2nd Enter.
    let entersSeen = 0;
    const line = '[fleet-monitor] 1 new message from C (#1) — run get_messages';
    const tmux = fakeTmux({ pane: () => (entersSeen >= 1 ? 'submitted\n> ' : `│ > ${line}`) });
    tmux.sendKey = async () => { entersSeen++; };
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 1 }] },
    ]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps: makeDeps(fetch, tmux) });
    const orig = tmux.sendText;
    tmux.sendText = async (n, t) => { await orig(n, t); mon.stop(); };
    await mon.prime();
    await mon.run(1);
    expect(tmux.sent).toHaveLength(1);
    expect(entersSeen).toBeGreaterThanOrEqual(1);   // re-sent Enter at least once
  });

  it('retries with backoff on a transient error, then delivers', async () => {
    const tmux = fakeTmux();
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },                                              // prime
      { throw: 'daemon bounce' },                                             // transient
      { cursor: 3, events: [{ event: 'message_received', from: 'C', msg_id: 9 }] },
    ]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps: makeDeps(fetch, tmux) });
    const orig = tmux.sendText;
    tmux.sendText = async (n, t) => { await orig(n, t); mon.stop(); };
    await mon.prime();
    await mon.run(1);
    expect(tmux.sent).toHaveLength(1);
    expect(tmux.sent[0]).toContain('#9');
  });

  it('is disabled short-circuit: run() with a fatal prime never polls the loop', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 401 }]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch, fakeTmux()) });
    await mon.prime();
    await mon.run(1);
    expect(calls()).toHaveLength(1);        // only the prime fetch happened
  });
});
