import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveEndpoint, filterEvents, formatNotificationLine, looksModal, createMonitor,
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

describe('resolveEndpoint', () => {
  it('defaults to port 3050 and sends no token header when unset', () => {
    const ep = resolveEndpoint({});
    expect(ep.url('Alice')).toBe('http://127.0.0.1:3050/identities/Alice/notifications');
    expect(ep.headers).toEqual({});
  });
  it('honors OURS_PORT and sends the token header when set', () => {
    const ep = resolveEndpoint({ OURS_PORT: '4000', OURS_API_TOKEN: 'sek' });
    expect(ep.url('A')).toContain(':4000/');
    expect(ep.headers).toEqual({ 'x-ours-api-token': 'sek' });
  });
  it('url-encodes the identity name', () => {
    expect(resolveEndpoint({}).url('a b')).toContain('/identities/a%20b/');
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
