import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveEndpoint, resolveApiToken, readDaemonConfig, filterEvents, formatNotificationLine,
  looksModal, looksApiError, looksRunning, createMonitor, probeIdentityPresence,
  type NotifyEvent, type MonitorDeps, type FetchResponse,
} from '../src/monitor.js';
import type { MonitorConfig } from '../src/config.js';
import { readClientProfile } from '../src/client-profile.js';

const CFG = (over: Partial<MonitorConfig> = {}): MonitorConfig => ({
  mode: 'fleet',
  enabled: true,
  wake_sources: ['message_received', 'file_received', 'local_contact_request', 'pending_message'],
  batch_ms: 2000,
  inject: 'notification',
  interrupt: false,
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

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-mon-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeDeps(fetch: MonitorDeps['fetch'], over: Partial<MonitorDeps> = {}): MonitorDeps {
  let clock = 0;
  return {
    fetch,
    isAlive: () => true,
    // Virtual clock, but yield to the macrotask queue so a runaway loop in the
    // monitor surfaces as a vitest timeout instead of starving timers and hanging
    // the worker (a microtask-only sleep never lets the test timeout fire).
    sleep: async (ms: number) => { clock += ms; await new Promise(r => setImmediate(r)); },
    now: () => clock,
    log: () => {},
    env: {},
    timers: { set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => {} },
    ...over,
  };
}

// Hermetic legacy config: an explicitly named missing config now fails closed,
// so use a real empty legacy object while isolating daemon-token resolution.
const hermetic = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const configPath = join(dir, 'legacy-config.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });
  return {
    OURS_CONFIG: configPath, OURS_STATE_DIR: join(dir, 'legacy-state'), ...over,
  };
};

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

describe('explicit client profile', () => {
  it('selects the managed default, preserves overrides and rejects broken managed selection', () => {
    const managedDir = join(dir, '.ours-client');
    mkdirSync(managedDir, { mode: 0o700 });
    const path = join(managedDir, 'profile.json');
    const tuple = { endpoint: 'http://127.0.0.1:43118', expectedInstanceId: '1b8c7fce-f39d-4a78-b72c-e0a772889988', credentialPath: join(dir, 'credential') };
    writeFileSync(path, JSON.stringify(tuple), { mode: 0o600 });
    expect(readClientProfile({ HOME: dir })).toEqual({ ...tuple, configPath: path });
    const explicit = join(dir, 'explicit.json');
    writeFileSync(explicit, '{}', { mode: 0o600 });
    expect(readClientProfile({ HOME: dir, OURS_CONFIG: explicit })).toBeUndefined();
    for (const invalid of ['{}', '{broken', JSON.stringify({ composeFile: '/not-a-fallback' })]) {
      writeFileSync(path, invalid);
      expect(() => readClientProfile({ HOME: dir })).toThrow(/client profile/);
    }
    writeFileSync(path, JSON.stringify(tuple));
    chmodSync(path, 0);
    expect(() => readClientProfile({ HOME: dir })).toThrow(/could not be read/);
    chmodSync(path, 0o600);
    chmodSync(managedDir, 0);
    try { expect(() => readClientProfile({ HOME: dir })).toThrow(/could not be read/); }
    finally { chmodSync(managedDir, 0o700); }
    rmSync(path);
    expect(readClientProfile({ HOME: dir })).toBeUndefined();
  });

  it('fails closed for partial, malformed, or legacy-conflicted explicit selection', () => {
    const path = join(dir, 'client-profile.json');
    const credentialPath = join(dir, 'daemon-token');
    const endpoint = 'http://127.0.0.1:43118';
    const expectedInstanceId = '1b8c7fce-f39d-4a78-b72c-e0a772889988';
    const selected = (value: unknown) => {
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
      chmodSync(path, 0o600);
      return () => readClientProfile({ OURS_CONFIG: path });
    };

    expect(selected({ endpoint })).toThrow(/invalid or missing expectedInstanceId/);
    expect(() => readClientProfile({ OURS_CONFIG: join(dir, 'missing-profile.json') }))
      .toThrow(/could not be read/);
    expect(selected('{broken')).toThrow(/not valid JSON/);
    expect(selected({ endpoint, expectedInstanceId: expectedInstanceId.toUpperCase(), credentialPath }))
      .toThrow(/lowercase UUID/);
    expect(selected({ endpoint, expectedInstanceId, credentialPath, apiToken: 'must-not-be-read' }))
      .toThrow(/cannot combine apiToken/);
    selected({ endpoint, expectedInstanceId, credentialPath });
    expect(() => readClientProfile({ OURS_CONFIG: path, OURS_PORT: '43118' }))
      .toThrow(/cannot combine OURS_PORT/);
  });
});

describe('probeIdentityPresence', () => {
  it('reads identity presence from the explicitly selected SDK client', async () => {
    const profilePath = join(dir, 'client-profile.json');
    const credentialPath = join(dir, 'daemon-token');
    const expectedInstanceId = '80947c72-c514-46e8-94e9-c2847bf6e971';
    writeFileSync(profilePath, JSON.stringify({
      endpoint: 'http://127.0.0.1:43117', expectedInstanceId, credentialPath,
    }), { mode: 0o600 });
    const attached: Array<Record<string, unknown>> = [];
    const result = await probeIdentityPresence(
      'Temp', async () => { throw new Error('legacy/default probe must not run'); },
      { OURS_CONFIG: profilePath },
      { attachClient: async options => {
        attached.push(options);
        return {
          identities: async () => [{ name: 'Temp', temporary: true, stale: false }],
          close: async () => undefined,
        };
      } },
    );

    expect(result).toEqual({ state: 'present', temporary: true, stale: false });
    expect(attached).toEqual([{
      endpoint: 'http://127.0.0.1:43117', expectedInstanceId, credentialPath,
      sessionMode: 'external', leaseToken: expect.any(String), env: {},
    }]);
  });

  it('distinguishes an authoritative present identity from an authoritative absence', async () => {
    const present = await probeIdentityPresence('Temp', async () => ({
      status: 200, ok: true,
      json: async () => ({ identities: [{ name: 'Temp', temporary: true, stale: false }] }),
    }), hermetic());
    const absent = await probeIdentityPresence('Gone', async () => ({
      status: 200, ok: true,
      json: async () => ({ identities: [{ name: 'Other' }] }),
    }), hermetic());

    expect(present).toEqual({ state: 'present', temporary: true, stale: false });
    expect(absent).toEqual({ state: 'absent' });
  });

  it('accepts the daemon string-index form and treats an empty restart index as ambiguous', async () => {
    const present = await probeIdentityPresence('Temp', async () => ({
      status: 200, ok: true, json: async () => ({ identities: ['Temp'] }),
    }), hermetic());
    const empty = await probeIdentityPresence('Temp', async () => ({
      status: 200, ok: true, json: async () => ({ identities: [] }),
    }), hermetic());

    expect(present).toEqual({ state: 'present', temporary: false, stale: false });
    expect(empty).toEqual({ state: 'unknown', detail: 'identity index is temporarily empty' });
  });

  it('fails open on transport, auth, and malformed-index errors', async () => {
    const transport = await probeIdentityPresence('Temp', async () => {
      throw new Error('daemon restart');
    }, hermetic());
    const auth = await probeIdentityPresence('Temp', async () => ({
      status: 401, ok: false, json: async () => ({}),
    }), hermetic());
    const malformed = await probeIdentityPresence('Temp', async () => ({
      status: 200, ok: true, json: async () => ({ cursor: 0 }),
    }), hermetic());

    expect(transport.state).toBe('unknown');
    expect(auth.state).toBe('unknown');
    expect(malformed.state).toBe('unknown');
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

  it('matches the daemon parseInt + nullish port semantics', () => {
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
  // The composer Claude Code renders when it is idle and injectable. `❯` is its
  // ordinary prompt glyph, so it is present in essentially every pane capture —
  // it must never on its own make a pane read as modal.
  const COMPOSER = [
    '╭──────────────────────────────────────────────────────────╮',
    '│ ❯                                                        │',
    '╰──────────────────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n');

  it('detects a "Do you want" trust/permission dialog', () => {
    expect(looksModal('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBe(true);
  });
  it('detects a numbered selection menu with a pointer', () => {
    expect(looksModal('Select an option:\n❯ 1. Alpha\n  2. Beta\n  3. Gamma')).toBe(true);
  });
  it('does not flag ordinary transcript text', () => {
    expect(looksModal('The agent replied with 3 ideas and a summary.\n> ')).toBe(false);
  });

  // ── true positives: real dialogs must keep reading as modal ────────────────
  // The guard exists so the monitor never presses Enter into a live dialog;
  // narrowing it must not neuter it.

  it('detects a boxed permission dialog (pointer on a numbered option)', () => {
    expect(looksModal([
      '⏺ Update(src/monitor.ts)',
      '╭─────────────────────────────────────────────────────────╮',
      '│ Do you want to make this edit to monitor.ts?             │',
      '│ ❯ 1. Yes                                                │',
      "│   2. Yes, and don't ask again this session               │",
      '│   3. No, and tell Claude what to do differently (esc)   │',
      '╰─────────────────────────────────────────────────────────╯',
    ].join('\n'))).toBe(true);
  });

  it('detects the MCP-server dialog, which carries no "Do you want" text', () => {
    // Verbatim shape of a dialog this monitor really halted on.
    expect(looksModal([
      'New MCP server found in this project: shakhmatov',
      '',
      '❯ 1. Use this MCP server',
      '  2. Use this MCP server and add to project settings',
      '  3. Continue without using this MCP server',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'))).toBe(true);
  });

  it('detects a dialog captured mid-redraw, with no pointer row on screen', () => {
    // The pane can be captured between frames, before the `❯` row is painted.
    // The dialog's own markers plus its numbered options still identify it.
    expect(looksModal([
      'New MCP server found in this project: shakhmatov',
      '',
      '  1. Use this MCP server',
      '  2. Use this MCP server and add to project settings',
      '  3. Continue without using this MCP server',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'))).toBe(true);
  });

  // ── false positives: a numbered list is not a dialog ───────────────────────
  // `❯` sits in the composer on every capture, so requiring it "somewhere in the
  // pane" plus "a numbered list somewhere in the pane" flags ordinary output.

  it('does not flag a prose numbered list with the composer prompt on screen', () => {
    expect(looksModal([
      '⏺ Three sessions are running:',
      '  1) ГРАФИК  2) WATCHTOWER  3) OURS-FLEET',
      '',
      COMPOSER,
    ].join('\n'))).toBe(false);
  });

  it('does not flag markdown numbered steps with the composer prompt on screen', () => {
    expect(looksModal([
      '⏺ To set it up:',
      '',
      '  1. Install the thing',
      '  2. Run the thing',
      '  3. Profit',
      '',
      COMPOSER,
    ].join('\n'))).toBe(false);
  });

  it('does not flag a numbered list sitting directly above the composer', () => {
    // Adjacency alone is not the signal: a transcript list can end one line above
    // the composer's `❯`. The pointer must sit ON a numbered option.
    expect(looksModal('  1. Install the thing\n  2. Run the thing\n❯ ')).toBe(false);
  });

  it('does not flag tabular output that merely starts with a number', () => {
    expect(looksModal(`  1 | 20260626_initial | 1\n  2 | 20260701_wakes | 1\n${COMPOSER}`)).toBe(false);
  });

  it('does not flag the assistant merely asking "do you want …" in prose', () => {
    // Claude Code's own closing question. No numbered options ⇒ not a dialog, so
    // it must not hold the wake hostage.
    expect(looksModal(`⏺ Tests pass. Do you want me to open the PR?\n\n${COMPOSER}`)).toBe(false);
  });
});

describe('looksApiError / looksRunning (issue #19 turn-outcome heuristics)', () => {
  it('flags a turn whose tail is an API Error line', () => {
    expect(looksApiError('running get_messages…\n⎿  API Error: Claude Code is unable to respond (usage policy)\n')).toBe(true);
    expect(looksApiError('API Error: 400 invalid_request_error')).toBe(true);
  });
  it('does not flag a clean completed turn', () => {
    expect(looksApiError('assistant: replied to Coord and drained the mail.\n> ')).toBe(false);
  });
  it('detects a running turn from the "esc to interrupt" footer or elapsed meter', () => {
    expect(looksRunning('✻ Cerebrating… (esc to interrupt)')).toBe(true);
    expect(looksRunning('· Working… (12s · ↓ 1.2k tokens)')).toBe(true);
  });
  it('treats a quiet idle / errored pane as not running', () => {
    expect(looksRunning('assistant: done.\n> ')).toBe(false);
    expect(looksRunning('⎿  API Error: usage policy\n> ')).toBe(false);
  });
});

describe('Monitor.prime', () => {
  it('retries an explicit profile after transient credential replacement auth failure', async () => {
    const profilePath = join(dir, 'client-profile.json');
    const credentialPath = join(dir, 'daemon-token');
    writeFileSync(profilePath, JSON.stringify({
      endpoint: 'http://127.0.0.1:43116',
      expectedInstanceId: '7f970f0d-0d93-49c7-b6b5-b6cd94415187', credentialPath,
    }), { mode: 0o600 });
    let pageCalls = 0;
    let attachments = 0;
    let mon: ReturnType<typeof createMonitor>;
    const deps = makeDeps(async () => { throw new Error('legacy/default probe must not run'); }, {
      env: { OURS_CONFIG: profilePath },
      attachClient: async () => {
        attachments++;
        return {
          readNotificationPage: async () => {
            if (++pageCalls === 1) throw new Error('readNotificationPage: HTTP 401');
            mon.stop();
            return { cursor: 19, events: [] };
          },
          close: async () => undefined,
        };
      },
    });
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });

    await mon.prime();
    await mon.run(1);

    expect(pageCalls).toBe(2);
    expect(attachments).toBe(1);
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/^armed at /);
  });

  it('keeps one file-backed SDK page client across credential replacement', async () => {
    const profilePath = join(dir, 'client-profile.json');
    const credentialPath = join(dir, 'daemon-token');
    const expectedInstanceId = '1b8c7fce-f39d-4a78-b72c-e0a772889988';
    writeFileSync(profilePath, JSON.stringify({
      endpoint: 'http://127.0.0.1:43119', expectedInstanceId, credentialPath,
    }), { mode: 0o600 });
    writeFileSync(credentialPath, 'first-credential\n', { mode: 0o600 });

    const attached: Array<Record<string, unknown>> = [];
    const pages: Array<{ identity: string; since: number | 'tip'; credential: string }> = [];
    const delivered: string[] = [];
    let mon: ReturnType<typeof createMonitor>;
    const deps = makeDeps(async () => {
      mon.stop();
      return { status: 200, ok: true, json: async () => ({ cursor: 0, events: [] }) };
    }, {
      env: { OURS_CONFIG: profilePath },
      attachClient: async options => {
        attached.push(options);
        return {
          readNotificationPage: async (identity, options = {}) => {
            const credential = readFileSync(credentialPath, 'utf8').trim();
            const since = options.since ?? 'tip';
            pages.push({ identity, since, credential });
            if (since === 'tip') return { cursor: 41, events: [] };
            mon.stop();
            return {
              cursor: 72,
              events: [{ event: 'message_received', from: 'Peer', msg_id: 9 }],
            };
          },
          close: async () => undefined,
        };
      },
      delivery: {
        submit: async text => {
          delivered.push(text);
          return { succeeded: true, outcome: 'completed' };
        },
      },
    });
    mon = createMonitor({
      name: 'Reviewer', identity: 'ProfileIdentity', agentDir: dir,
      cfg: CFG({ batch_ms: 0 }), deps,
    });

    await mon.prime();
    writeFileSync(credentialPath, 'rotated-credential\n', { mode: 0o600 });
    await mon.run(1);

    expect(attached).toEqual([{
      endpoint: 'http://127.0.0.1:43119', expectedInstanceId, credentialPath,
      sessionMode: 'external', leaseToken: expect.stringMatching(/^ours-fleet-monitor-/), env: {},
    }]);
    expect(pages).toEqual([
      { identity: 'ProfileIdentity', since: 'tip', credential: 'first-credential' },
      { identity: 'ProfileIdentity', since: 41, credential: 'rotated-credential' },
    ]);
    expect(delivered).toEqual([
      '[fleet-monitor] 1 new message from Peer (#9) — run get_messages',
    ]);
  });

  it('reports its stall detector explicitly instead of mislabeling its own abort', async () => {
    let timeout: (() => void) | undefined;
    const fetch: MonitorDeps['fetch'] = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
    });
    const deps = makeDeps(fetch, {
      timers: {
        set: callback => { timeout = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
        clear: () => undefined,
      },
    });
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps });
    const priming = mon.prime();
    timeout?.();
    await priming;
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8'))
      .toContain('prime failed (notification stream stalled for 120s)');
  });

  it('primes at tip, records the cursor, and marks armed', async () => {
    const { fetch, calls } = scriptedFetch([{ cursor: 128, events: [] }]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch) });
    await mon.prime();
    expect(calls()[0]).toContain('since=tip');
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('128');
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/armed/);
  });

  it('resumes the last delivered cursor instead of jumping to tip after restart', async () => {
    writeFileSync(join(dir, '.monitor-state.json'), JSON.stringify({
      version: 1,
      identity: 'A',
      observedCursor: 20,
      deliveredCursor: 10,
      pending: { count: 1, eventTypes: ['message_received'], attempts: 1 },
    }));
    const { fetch, calls } = scriptedFetch([]);
    const mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch),
    });
    await mon.prime();
    expect(calls()).toEqual([]);
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/^armed at \S+\n$/);
  });

  it('re-primes at tip when ownership returns from a native monitor', async () => {
    writeFileSync(join(dir, '.monitor-state.json'), JSON.stringify({
      version: 1,
      identity: 'A',
      observedCursor: 20,
      deliveredCursor: 10,
      pending: { count: 1, eventTypes: ['message_received'], attempts: 1 },
    }));
    const { fetch, calls } = scriptedFetch([{ cursor: 128, events: [] }]);
    const mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch),
    });
    await mon.prime({ resetCursor: true });
    expect(calls()[0]).toContain('since=tip');
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('128');
    expect(JSON.parse(readFileSync(join(dir, '.monitor-state.json'), 'utf8')))
      .toMatchObject({ observedCursor: 128, deliveredCursor: 128, pending: null });
  });

  it('marks failed and never injects on a 401', async () => {
    const { fetch } = scriptedFetch([{ status: 401 }]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch) });
    await mon.prime();
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/failed/);
    await mon.run(1);                       // must return immediately, no throw
  });

  it('names the selected config and token-file paths on a 401 without exposing the token', async () => {
    const configPath = join(dir, 'selected-profile.json');
    const stateDir = join(dir, 'selected-state');
    writeFileSync(configPath, JSON.stringify({ apiToken: 'super-secret', stateDir }));
    const { fetch } = scriptedFetch([{ status: 401 }]);
    const deps = makeDeps(fetch, { env: { OURS_CONFIG: configPath } });
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
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch) });
    await expect(mon.prime()).resolves.toBeUndefined();
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/degraded/);
  });
});

describe('Monitor.run — delivery', () => {
  it('routes notifications by configured identity, not role name', async () => {
    const { fetch, calls } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [] },
    ], (_url, i) => { if (i === 1) mon.stop(); });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({
      name: 'Reviewer', identity: 'Alice', agentDir: dir, cfg: CFG({ batch_ms: 0 }),
      deps: makeDeps(fetch),
    });
    await mon.prime();
    await mon.run(1);
    expect(calls().every(url => url.includes('/identities/Alice/notifications'))).toBe(true);
    expect(calls().some(url => url.includes('/identities/Reviewer/'))).toBe(false);
  });

  it('uses structured prompt delivery for the agent session', async () => {
    const delivered: string[] = [];
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 9 }] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async text => {
          delivered.push(text);
          mon.stop();
          return { succeeded: true, outcome: 'completed' };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });
    await mon.prime();
    await mon.run(1);
    expect(delivered).toEqual(['[fleet-monitor] 1 new message from C (#9) — run get_messages']);
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('2');
  });

  it('a refused ACP wake keeps the cursor, degrades with the reason, and replays', async () => {
    const submitted: string[] = [];
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },                                                  // prime tip
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 9 }] },
      { cursor: 2, events: [] },                                                  // replay poll
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async text => {
          submitted.push(text);
          if (submitted.length >= 2) mon.stop();
          // First wake is refused by the agent; the retry completes.
          return submitted.length === 1
            ? { succeeded: false, outcome: 'refused', detail: 'refusal' }
            : { succeeded: true, outcome: 'completed' };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });
    await mon.prime();
    await mon.run(1);

    expect(submitted).toHaveLength(2);                      // the wake was retried
    expect(submitted[0]).toBe(submitted[1]);                // …with the same batch
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('2');
  });

  it('a refusal that never recovers leaves the durable cursor behind and says why', async () => {
    let submits = 0;
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 9 }] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async () => {
          submits++;
          mon.stop();
          return { succeeded: false, outcome: 'refused', detail: 'refusal' };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });
    await mon.prime();
    await mon.run(1);

    expect(submits).toBe(1);
    // Prior durable cursor is intact, so the daemon replays event 2 next time.
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('1');
    const status = readFileSync(join(dir, '.monitor-status'), 'utf8');
    expect(status).toContain('degraded');
    expect(status).toContain('refused');
    expect(status).not.toMatch(/^armed/);
    // The undelivered batch survives a restart as pending state.
    const state = JSON.parse(readFileSync(join(dir, '.monitor-state.json'), 'utf8'));
    expect(state).toMatchObject({ deliveredCursor: 1, pending: { count: 1 } });
  });

  it('a cancelled wake is likewise not a delivery', async () => {
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 9 }] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async () => { mon.stop(); return { succeeded: false, outcome: 'cancelled' }; },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps });
    await mon.prime();
    await mon.run(1);
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('1');
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toContain('cancelled');
  });

  it('requests ACP interruption before delivering when monitor.interrupt is enabled', async () => {
    const delivered: Array<{ text: string; interrupt?: boolean }> = [];
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 10 }] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async (text, options) => {
          delivered.push({ text, interrupt: options?.interrupt });
          mon.stop();
          return { accepted: true };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0, interrupt: true }), deps,
    });
    await mon.prime();
    await mon.run(1);
    expect(delivered).toEqual([{
      text: '[fleet-monitor] 1 new message from C (#10) — run get_messages',
      interrupt: true,
    }]);
  });

  it('passes after_tool through ACP and commits the cursor only after safe delivery completes', async () => {
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 12 }] },
    ]);
    let completed = false;
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async (_text, options) => {
          expect(options?.interrupt).toBe('after_tool');
          expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('1');
          completed = true;
          mon.stop();
          return {
            succeeded: true, outcome: 'injected',
            detail: 'after_tool delivery after 25ms', safeBoundary: 'after_tool',
          };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0, interrupt: 'after_tool' }), deps,
    });
    await mon.prime();
    await mon.run(1);
    expect(completed).toBe(true);
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('2');
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8')).toMatch(/^armed/);
  });

  it('keeps timeout fallback visible after accepting the non-cancelling wake', async () => {
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'C', msg_id: 13 }] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async () => {
          mon.stop();
          return {
            succeeded: true, outcome: 'injected',
            detail: 'after_tool timed out after 120000ms; steered without cancellation',
            safeBoundary: 'timeout',
          };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0, interrupt: 'after_tool' }), deps,
    });
    await mon.prime();
    await mon.run(1);
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('2');
    expect(readFileSync(join(dir, '.monitor-status'), 'utf8'))
      .toContain('degraded: safe-boundary');
  });

  it('interrupts for second-and-later ACP wakes while earlier wake work is active', async () => {
    const submitted: Array<{ text: string; interrupt?: boolean }> = [];
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [{ event: 'message_received', from: 'Architect', msg_id: 10 }] },
      { cursor: 3, events: [{ event: 'message_received', from: 'Verifier', msg_id: 11 }] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        // ACP steering acknowledges immediately while the triggered agent turn
        // continues, so the second poll represents mail arriving during work.
        submit: async (text, options) => {
          submitted.push({ text, interrupt: options?.interrupt });
          if (submitted.length === 2) mon.stop();
          return { succeeded: true, outcome: 'startedNewTurn', detail: 'startedNewTurn' };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({
      name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0, interrupt: true }), deps,
    });

    await mon.prime();
    await mon.run(1);

    expect(submitted).toEqual([
      {
        text: '[fleet-monitor] 1 new message from Architect (#10) — run get_messages',
        interrupt: true,
      },
      {
        text: '[fleet-monitor] 1 new message from Verifier (#11) — run get_messages',
        interrupt: true,
      },
    ]);
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('3');
  });

  it('coalesces a multi-sender burst without repeating an overlapping notification ID', async () => {
    const delivered: string[] = [];
    const duplicate = { event: 'message_received', from: 'Architect', msg_id: 20 };
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },
      { cursor: 2, events: [duplicate] },
      { cursor: 3, events: [
        duplicate,
        { event: 'message_received', from: 'Developer', msg_id: 21 },
      ] },
    ]);
    const deps = makeDeps(fetch, {
      delivery: {
        submit: async text => {
          delivered.push(text);
          mon.stop();
          return { succeeded: true, outcome: 'completed' };
        },
      },
    });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 1 }), deps });

    await mon.prime();
    await mon.run(1);

    expect(delivered).toEqual([
      '[fleet-monitor] 2 new messages from Architect, Developer (#20, #21) — run get_messages',
    ]);
    expect(readFileSync(join(dir, '.notify-cursor'), 'utf8').trim()).toBe('3');
  });

});

describe('Monitor status is typed, timestamped, and self-heals per cause', () => {
  const statusLines = () =>
    readFileSync(join(dir, '.monitor-status'), 'utf8').trim().split('\n');
  const status = () => statusLines().join('\n');
  const API_ERROR_PANE = 'ran get_messages\n⎿  API Error: Claude Code is unable to respond (usage policy)\n';
  const COMPLETED_PANE = 'assistant: replied and drained the mail.\n> ';
  const wake = (k: number) => ({
    cursor: 10 + k,
    events: [{ event: 'message_received', from: 'Coord', msg_id: k }] as NotifyEvent[],
  });

  it('every status line carries a parseable ISO timestamp', async () => {
    const { fetch } = scriptedFetch([{ cursor: 5, events: [] }]);
    const mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG(), deps: makeDeps(fetch) });
    await mon.prime();
    for (const line of statusLines()) {
      const stamp = /\bat (\S+)/.exec(line)?.[1];
      expect(stamp, line).toBeTruthy();
      expect(Number.isNaN(Date.parse(stamp!)), line).toBe(false);
    }
  });

  it('a hiccup then a successful EMPTY poll self-clears the connection degradation', async () => {
    const { fetch } = scriptedFetch([
      { cursor: 1, events: [] },              // prime
      { throw: 'ECONNREFUSED' },              // hiccup
      { cursor: 1, events: [] },              // recovery: a quiet poll
    ], (_url, i) => { if (i === 3) mon.stop(); });
    let mon: ReturnType<typeof createMonitor>;
    mon = createMonitor({ name: 'A', agentDir: dir, cfg: CFG({ batch_ms: 0 }), deps: makeDeps(fetch) });
    await mon.prime();
    await mon.run(1);
    expect(status()).toMatch(/^armed at /);
  });

});
