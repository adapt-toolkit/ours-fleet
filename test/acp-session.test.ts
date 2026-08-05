import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import {
  RoleControlServer, controlRequest, controlSocketPath, controlTokenPath, livenessNote,
} from '../src/session/control.js';
import { SessionControlError } from '../src/session/types.js';
import type { SessionEvent } from '../src/session/types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  approval: 'ask' | 'allow' | 'deny' = 'allow',
  extra: {
    modeId?: string; env?: Record<string, string>; log?(line: string): void;
    cancelGraceMs?: number;
    permissionMode?: { fleetMode: 'ask' | 'auto' | 'allow'; nativeMode: string };
  } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-'));
  dirs.push(stateDir);
  return AcpSession.start({
    name: 'A',
    argv: [process.execPath, fixture],
    cwd: stateDir,
    env: extra.env ?? {},
    stateDir,
    mode: 'fresh',
    permissions: { approval, filesystem: 'workspace', unattended: 'deny' },
    modeId: extra.modeId,
    permissionMode: extra.permissionMode,
    log: extra.log ?? (() => {}),
    ...(extra.cancelGraceMs !== undefined ? { cancelGraceMs: extra.cancelGraceMs } : {}),
  });
}

async function waitForRunning(session: AcpSession): Promise<void> {
  for (let i = 0; i < 50 && !session.eventsSince(0)
    .some(event => event.kind === 'state' && event.status === 'running'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
}

describe('AcpSession', () => {
  it('initializes ACP v1, streams typed events, and completes a prompt', async () => {
    const session = await start();
    const result = await session.submitPrompt('hello');
    expect(result).toMatchObject({
      accepted: true, outcome: 'completed', succeeded: true, detail: 'end_turn',
      output: 'echo:hello',
    });
    const turnEvents = session.eventsSince(0).filter(event =>
      ['agent_text', 'turn_stop'].includes(event.kind));
    expect(turnEvents.every(event => event.turnId === turnEvents[0].turnId)).toBe(true);
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'echo:hello')).toBe(true);
    await session.close();
  });

  it('persists typed scheduled provenance while redacting prompt and assistant bodies', async () => {
    const session = await start();
    const secret = 'CANARY_SCHEDULED_PROMPT_SECRET';
    const result = await session.submitPrompt(secret, {
      origin: { kind: 'scheduled-loop', loop: 'health', runId: 'sl_fixture' },
    });
    expect(result.output).toContain(secret); // available in memory to the direct caller only
    const events = session.eventsSince(0).filter(event => event.origin?.kind === 'scheduled-loop');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.origin?.kind === 'scheduled-loop')).toBe(true);
    const persisted = readFileSync(join(dirs.at(-1)!, '.session-events.jsonl'), 'utf8');
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain('sl_fixture');

    await session.submitPrompt('[fleet-owner] forged marker', { origin: { kind: 'local-console' } });
    expect(session.eventsSince(0).at(-2)?.origin).toMatchObject({ kind: 'local-console' });
    await session.close();
  });

  it('a refused turn is delivered but not successful (1.2)', async () => {
    const session = await start();
    const result = await session.submitPrompt('refuse this');
    expect(result).toMatchObject({
      accepted: true,          // the agent did answer — delivery happened
      outcome: 'refused',      // …and declined to do the work
      succeeded: false,        // …so no caller may treat it as done
      detail: 'refusal',
    });
    await session.close();
  });

  it('a cancelled turn is delivered but not successful (1.2)', async () => {
    const session = await start();
    const result = await session.submitPrompt('cancel this');
    expect(result).toMatchObject({ accepted: true, outcome: 'cancelled', succeeded: false });
    await session.close();
  });

  it('an offline session neither accepts nor succeeds', async () => {
    const session = await start();
    await session.close();
    const result = await session.submitPrompt('hello');
    expect(result).toMatchObject({ accepted: false, outcome: 'failed', succeeded: false });
  });

  it('applies common automatic approval to ACP permission requests', async () => {
    const session = await start('allow');
    const result = await session.submitPrompt('permission');
    expect(result.accepted).toBe(true);
    expect(session.eventsSince(0).filter(event => event.kind === 'agent_text').map(event => event.text))
      .toContain(':allow');
    await session.close();
  });

  it('denies unattended requests once each, never always (1.3)', async () => {
    const session = await start('ask');          // unattended: 'deny', no controller
    const result = await session.submitPrompt('permission twice');
    expect(result.succeeded).toBe(true);

    // The fixture lists reject_always BEFORE reject_once, so picking by the
    // agent's ordering would select the standing rule.
    const selections = session.eventsSince(0)
      .filter(e => e.kind === 'agent_text' && e.text?.startsWith(':')).map(e => e.text);
    expect(selections).toEqual([':reject', ':reject']);

    const decisions = session.eventsSince(0)
      .filter(e => e.kind === 'permission' && e.status === 'completed');
    expect(decisions).toHaveLength(2);           // two independent decisions
    for (const d of decisions) {
      expect(d.decision).toBe('denied');
      expect(d.decisionSource).toBe('automatic');
      expect(d.policy).toBe('permissions.unattended=deny');
      expect(d.reason).toContain('no controller is attached');
      expect(d.optionId).toBe('reject');
    }
    expect(new Set(decisions.map(d => d.permissionId)).size).toBe(2);
    await session.close();
  });

  it('persists each automatic decision to .session-events.jsonl (1.3)', async () => {
    const session = await start('ask');
    await session.submitPrompt('permission twice');
    const stateDir = dirs.at(-1)!;
    const persisted = readFileSync(join(stateDir, '.session-events.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l) as SessionEvent)
      .filter(e => e.kind === 'permission');
    expect(persisted).toHaveLength(2);
    expect(persisted.every(e => e.decisionSource === 'automatic'
      && e.decision === 'denied'
      && e.policy === 'permissions.unattended=deny'
      && typeof e.reason === 'string' && e.reason.length > 0)).toBe(true);
    await session.close();
  });

  it('records a policy denial as approval=deny, not as an unattended one (1.3)', async () => {
    const session = await start('deny');
    session.setControllerAttached(true);         // attached, and still denied
    await session.submitPrompt('permission');
    const decision = session.eventsSince(0).find(e => e.kind === 'permission');
    expect(decision).toMatchObject({
      status: 'completed', decision: 'denied', decisionSource: 'automatic',
      policy: 'permissions.approval=deny', optionId: 'reject',
    });
    session.setControllerAttached(false);
    await session.close();
  });

  it('records an automatic allow with the policy that permitted it (1.3)', async () => {
    const session = await start('allow');
    await session.submitPrompt('permission');
    const decision = session.eventsSince(0).find(e => e.kind === 'permission');
    expect(decision).toMatchObject({
      status: 'completed', decision: 'allowed', decisionSource: 'automatic',
      policy: 'permissions.approval=allow', optionId: 'allow',
    });
    await session.close();
  });

  it('keeps ask-mode permission pending for an attached controller', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const prompt = session.submitPrompt('permission');
    let permission = session.eventsSince(0).find(event => event.kind === 'permission');
    for (let i = 0; i < 20 && !permission; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      permission = session.eventsSince(0).find(event => event.kind === 'permission');
    }
    expect(permission?.permissionId).toBeTruthy();
    expect(session.snapshot().readiness).toBe('awaiting_permission');
    expect(session.respondPermission(permission!.permissionId!, 'allow')).toBe(true);
    expect((await prompt).accepted).toBe(true);
    session.setControllerAttached(false);
    await session.close();
  });

  it('delivers the configured permission mode via session/set_mode after session/new', async () => {
    const session = await start('allow', { modeId: 'bypassPermissions' });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'mode:bypassPermissions')).toBe(true);
    await session.close();
  });

  it('reports adapter-resolved effective and native modes in the live snapshot', async () => {
    const permissionMode = { fleetMode: 'allow' as const, nativeMode: 'bypassPermissions' };
    const session = await start('allow', { permissionMode });
    expect(session.snapshot().permissionMode).toEqual(permissionMode);
    await session.close();
  });

  it('issues no session/set_mode when no mode is configured', async () => {
    const session = await start('allow');
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text?.startsWith('mode:'))).toBe(false);
    await session.close();
  });

  it('delivers the permission mode after loading a persisted session too', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-'));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, '.acp-session-id'), 'fixture-session\n');
    const session = await AcpSession.start({
      name: 'A',
      argv: [process.execPath, fixture],
      cwd: stateDir,
      env: { ACP_FIXTURE_LOAD_SESSION: '1' },
      stateDir,
      mode: 'resume',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      modeId: 'plan',
      log: () => {},
    });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'mode:plan')).toBe(true);
    await session.close();
  });

  it('a failed session/set_mode logs loudly but leaves the session usable', async () => {
    const logs: string[] = [];
    const session = await start('allow', {
      modeId: 'bypassPermissions',
      env: { ACP_FIXTURE_SET_MODE_FAIL: '1' },
      log: line => logs.push(line),
    });
    expect(logs.some(l => l.includes('set_mode') && l.includes('agent default'))).toBe(true);
    const result = await session.submitPrompt('hello');
    expect(result).toMatchObject({ succeeded: true, output: 'echo:hello' });
    await session.close();
  });

  it('queues a prompt behind a running turn instead of waiting for it (1.5)', async () => {
    const session = await start();
    const busy = session.submitPrompt('block 1500');        // a turn that runs for 1.5s
    await new Promise(r => setTimeout(r, 50));              // let it actually start

    const started = Date.now();
    const queued = await session.queuePrompt('second');
    const elapsed = Date.now() - started;

    expect(queued.promptId).toBeTruthy();
    expect(queued.queuedBehind).toBeGreaterThan(0);          // it can see the busy turn
    expect(elapsed).toBeLessThan(500);                       // …and did not wait for it
    expect(session.snapshot().alive).toBe(true);

    const busyResult = await busy;
    const queuedResult = await queued.completion;
    expect(busyResult).toMatchObject({ succeeded: true, output: 'echo:block 1500' });
    expect(queuedResult).toMatchObject({ succeeded: true, output: 'echo:second' });
    await session.close();
  });

  it('queuePrompt on a dead session is a typed offline error (1.5)', async () => {
    const session = await start();
    await session.close();
    const error = await session.queuePrompt('hi').then(() => null, e => e as SessionControlError);
    expect(error).toBeInstanceOf(SessionControlError);
    expect(error!.kind).toBe('offline');
  });

  it('exposes prompt submission and snapshots over the role control socket', async () => {
    const session = await start();
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    const snapshot = await controlRequest(stateDir, { command: 'snapshot' });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.result).toMatchObject({ backend: 'acp', alive: true });
    const prompt = await controlRequest(stateDir, { command: 'submit_prompt', text: 'control' });
    expect(prompt.ok).toBe(true);
    expect(prompt.result).toMatchObject({ state: 'queued' });
    await control.close();
    await session.close();
  });

  it('routes typed spawn requests only through the attached live role spawner', async () => {
    const session = await start();
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const unavailable = await controlRequest(stateDir, {
        command: 'fleet_spawn', spawn: { name: 'Worker' },
      });
      expect(unavailable).toMatchObject({ ok: false, kind: 'rejected' });

      const spawn = vi.fn(async options => ({
        caller: 'Coordinator', role: options.name, lifetime: 'temporary' as const,
        statePath: '/state/Worker', harness: 'codex', session: 'acp' as const,
        model: 'gpt-test', monitor: { mode: 'fleet' as const, interrupt: true },
        inherited: ['harness', 'session'], creationActionId: 'action-1',
      }));
      control.setFleetSpawner(spawn);
      const response = await controlRequest(stateDir, {
        command: 'fleet_spawn', spawn: { name: 'Worker', temp: true },
      });
      expect(response).toMatchObject({
        ok: true, result: { caller: 'Coordinator', role: 'Worker', lifetime: 'temporary' },
      });
      expect(spawn).toHaveBeenCalledWith({ name: 'Worker', temp: true });
    } finally {
      await control.close();
      await session.close();
    }
  });

  it('scopes owner-channel management to the authenticated role socket and attached live handle', async () => {
    const session = await start();
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const unavailable = await controlRequest(stateDir, {
        command: 'owner_channel_manage', ownerChannel: { action: 'owner_list' },
      });
      expect(unavailable).toMatchObject({ ok: false, kind: 'rejected' });
      expect(unavailable.error).toMatch(/disabled or unavailable/);

      const manage = vi.fn(async () => ({
        action: 'owner_list' as const, integrity: { ok: true },
        owners: [{ cid: 'A'.repeat(64), source: 'baseline' as const, effective: true }],
      }));
      control.setOwnerChannel({
        start: async () => {}, drain: async () => {}, close: async () => {}, manage,
      });
      const response = await controlRequest(stateDir, {
        command: 'owner_channel_manage', ownerChannel: { action: 'owner_list' },
      });
      expect(response.ok).toBe(true);
      expect(manage).toHaveBeenCalledWith({ action: 'owner_list' });

      const forged = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(controlSocketPath(stateDir));
        let body = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.on('data', chunk => { body += chunk; });
        socket.once('end', () => resolve(JSON.parse(body.trim()) as Record<string, unknown>));
        socket.once('connect', () => socket.end(JSON.stringify({
          version: 1, id: 'forged-task-open', token: 'wrong-token',
          command: 'owner_channel_manage',
          ownerChannel: { action: 'task_open', requestId: 'a'.repeat(64) },
        }) + '\n'));
      });
      expect(forged).toMatchObject({ ok: false, error: 'unauthorized' });
      expect(manage).toHaveBeenCalledTimes(1);

      control.setOwnerChannel(undefined);
      const draining = await controlRequest(stateDir, {
        command: 'owner_channel_manage', ownerChannel: { action: 'contact_list' },
      });
      expect(draining).toMatchObject({ ok: false, kind: 'rejected' });
    } finally {
      await control.close();
      await session.close();
    }
  });

  it('steers a live prompt instead of waiting behind it', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const active = session.submitPrompt('permission');
    for (let i = 0; i < 20 && session.snapshot().readiness !== 'awaiting_permission'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const steered = await session.submitPrompt('important message', { steer: true });
    expect(steered).toMatchObject({
      accepted: true, outcome: 'inconclusive', detail: 'injected',
    });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'steer:important message')).toBe(true);
    await session.interrupt();
    expect(await active).toMatchObject({ outcome: 'cancelled', cancellationSource: 'local-console' });
    session.setControllerAttached(false);
    await session.close();
  });

  it('cancels a live prompt before interrupting delivery starts a new turn', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const active = session.submitPrompt('permission');
    for (let i = 0; i < 20 && session.snapshot().readiness !== 'awaiting_permission'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const delivered = session.submitPrompt('wake', { interrupt: true, steer: true });
    expect((await active).outcome).toBe('cancelled');
    expect(await delivered).toMatchObject({
      accepted: true, outcome: 'inconclusive', detail: 'startedNewTurn',
    });
    session.setControllerAttached(false);
    await session.close();
  });

  it('escalates an ignored cancellation by restarting the adapter, failing the turn exactly once', async () => {
    const session = await start('allow', { cancelGraceMs: 200 });
    const queued = await session.queuePrompt('stubborn block 60000');
    await waitForRunning(session);
    await session.interrupt('owner');

    // The adapter never honors the cancel; after the grace period the session
    // must recover by force instead of leaving the turn (and its owner) hung.
    const result = await queued.completion;
    expect(result).toMatchObject({ succeeded: false, outcome: 'failed' });
    expect(session.isAlive()).toBe(false);
    // SIGTERM delivery is asynchronous; wait for the adapter's exit record.
    for (let i = 0; i < 100 && session.exitResult() === null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.exitResult()).not.toBeNull();

    const events = session.eventsSince(0);
    const escalations = events.filter(event =>
      event.kind === 'error' && event.text?.includes('ignored cancellation'));
    expect(escalations).toHaveLength(1);
    // The escalated turn terminates through the failure path only: no
    // turn_stop means no second, contradictory completion was produced.
    expect(events.filter(event => event.kind === 'turn_stop')).toHaveLength(0);
    await session.close();
  });

  it('never escalates a cancellation the adapter honors within the grace period', async () => {
    const session = await start('allow', { cancelGraceMs: 200 });
    const queued = await session.queuePrompt('block 60000');
    await waitForRunning(session);
    await session.interrupt('owner');
    expect(await queued.completion).toMatchObject({
      accepted: true, outcome: 'cancelled', succeeded: false, cancellationSource: 'owner',
    });

    // Well past the grace period the adapter must still be alive and undamaged.
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(session.isAlive()).toBe(true);
    expect(session.eventsSince(0).some(event =>
      event.kind === 'error' && event.text?.includes('ignored cancellation'))).toBe(false);
    // …and fully usable: the next turn completes normally.
    expect(await session.submitPrompt('hello')).toMatchObject({
      succeeded: true, output: 'echo:hello',
    });
    await session.close();
  });

  it('an escalation armed for one turn cannot fire into a later turn', async () => {
    const session = await start('allow', { cancelGraceMs: 200 });
    const first = await session.queuePrompt('block 60000');
    await waitForRunning(session);
    await session.interrupt('owner');
    expect((await first.completion).outcome).toBe('cancelled');

    // A new turn starts after the cancelled one; the old grace timer must not
    // kill the adapter out from under it.
    const second = session.submitPrompt('block 300');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(session.isAlive()).toBe(true);
    expect(await second).toMatchObject({ succeeded: true });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'error' && event.text?.includes('ignored cancellation'))).toBe(false);
    await session.close();
  });

  it('marks only a fleet-monitor interruption with internal provenance', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const active = session.submitPrompt('permission');
    for (let i = 0; i < 20 && session.snapshot().readiness !== 'awaiting_permission'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const delivered = session.submitPrompt('wake', {
      interrupt: true, steer: true, interruptSource: 'fleet-monitor',
    });
    expect(await active).toMatchObject({
      outcome: 'cancelled', cancellationSource: 'fleet-monitor',
    });
    expect(await delivered).toMatchObject({
      accepted: true, outcome: 'inconclusive', detail: 'startedNewTurn',
    });
    session.setControllerAttached(false);
    await session.close();
  });
});

describe('role control failures are typed (1.5)', () => {
  it('accepts a prompt into a busy session promptly, and says how deep the queue is', async () => {
    const session = await start();
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const busy = session.submitPrompt('block 1500');
      await new Promise(r => setTimeout(r, 50));

      const started = Date.now();
      const response = await controlRequest(
        stateDir, { command: 'submit_prompt', text: 'while busy' }, 1_000);
      expect(response.ok).toBe(true);                       // NOT an error, NOT a timeout
      expect(response.result).toMatchObject({ state: 'queued' });
      expect((response.result as { queuedBehind: number }).queuedBehind).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(500);       // returned promptly

      await busy;
    } finally {
      await control.close();
      await session.close();
    }
  });

  it('an absent control socket is control-unavailable, not offline', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-noctl-'));
    dirs.push(stateDir);
    const error = await controlRequest(stateDir, { command: 'status' })
      .then(() => null, e => e as SessionControlError);
    expect(error).toBeInstanceOf(SessionControlError);
    expect(error!.kind).toBe('control-unavailable');
  });

  /** A stand-in control plane, so a failing socket can be produced on demand. */
  async function stubControlPlane(onConnect: (socket: Socket) => void) {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-stub-'));
    dirs.push(stateDir);
    writeFileSync(controlTokenPath(stateDir), 'token\n');
    const live = new Set<Socket>();
    const server = createServer(socket => {
      live.add(socket);
      socket.on('close', () => live.delete(socket));
      onConnect(socket);
    });
    await new Promise<void>(r => { server.listen(controlSocketPath(stateDir), r); });
    return {
      stateDir,
      async close() {
        for (const socket of live) socket.destroy();
        await new Promise<void>(r => { server.close(() => r()); });
      },
    };
  }

  it('a server that never answers is a timeout, not a dead agent', async () => {
    const stub = await stubControlPlane(() => { /* accept, then say nothing */ });
    try {
      const error = await controlRequest(stub.stateDir, { command: 'status' }, 150)
        .then(() => null, e => e as SessionControlError);
      expect(error!.kind).toBe('timeout');
      expect(error!.message).toContain('did not answer');
    } finally {
      await stub.close();
    }
  });

  it('a malformed response is a backend failure', async () => {
    const stub = await stubControlPlane(socket => socket.write('not json at all\n'));
    try {
      const error = await controlRequest(stub.stateDir, { command: 'status' }, 2_000)
        .then(() => null, e => e as SessionControlError);
      expect(error!.kind).toBe('backend');
      expect(error!.message).toContain('malformed control response');
    } finally {
      await stub.close();
    }
  });

  it('an explicit refusal is rejected, and says the role is running', async () => {
    const session = await start();
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const response = await controlRequest(
        stateDir, { command: 'respond_permission', permissionId: 'stale', optionId: 'allow' });
      expect(response.ok).toBe(false);
      expect(response.kind).toBe('rejected');
      expect(livenessNote('rejected', 'A')).toContain('is running');
    } finally {
      await control.close();
      await session.close();
    }
  });

  it('only offline claims the agent is gone', () => {
    expect(livenessNote('offline', 'A')).toContain('confirmed offline');
    for (const kind of ['control-unavailable', 'timeout', 'backend'] as const)
      expect(livenessNote(kind, 'A')).not.toContain('confirmed offline');
    expect(livenessNote('timeout', 'A')).toContain('busy agent looks exactly like this');
  });
});
