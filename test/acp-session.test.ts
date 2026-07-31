import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

async function start(approval: 'ask' | 'allow' | 'deny' = 'allow') {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-'));
  dirs.push(stateDir);
  return AcpSession.start({
    name: 'A',
    argv: [process.execPath, fixture],
    cwd: stateDir,
    env: {},
    stateDir,
    mode: 'fresh',
    permissions: { approval, filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
}

describe('AcpSession', () => {
  it('initializes ACP v1, streams typed events, and completes a prompt', async () => {
    const session = await start();
    const result = await session.submitPrompt('hello');
    expect(result).toMatchObject({
      accepted: true, outcome: 'completed', succeeded: true, detail: 'end_turn',
    });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'echo:hello')).toBe(true);
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

    expect((await busy).succeeded).toBe(true);
    expect((await queued.completion).succeeded).toBe(true);  // it does run, afterwards
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
