import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpSession, createInjectedAcpSession } from '../src/session/acp.js';
import * as acpSessionModule from '../src/session/acp.js';
import { AgentConversationRelay } from '../src/agent-conversation-control.js';
import type { AcpBodyBrainProvider } from '../src/session/acp-body-brain-transport.js';
import {
  RoleControlServer, controlRequest, controlSocketPath, controlTokenPath, livenessNote,
} from '../src/session/control.js';
import { ACP_CANCEL_DEADLINE_EXCEEDED, SessionControlError } from '../src/session/types.js';
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
    cancelTerminateGraceMs?: number;
    afterToolBoundaryTimeoutMs?: number;
    unattended?: 'deny' | 'wait';
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
    permissions: {
      approval, filesystem: 'workspace', unattended: extra.unattended ?? 'deny',
    },
    modeId: extra.modeId,
    permissionMode: extra.permissionMode,
    log: extra.log ?? (() => {}),
    ...(extra.cancelGraceMs !== undefined ? { cancelGraceMs: extra.cancelGraceMs } : {}),
    ...(extra.cancelTerminateGraceMs !== undefined
      ? { cancelTerminateGraceMs: extra.cancelTerminateGraceMs } : {}),
    ...(extra.afterToolBoundaryTimeoutMs !== undefined
      ? { afterToolBoundaryTimeoutMs: extra.afterToolBoundaryTimeoutMs } : {}),
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

  it('promotes exact Codex phases and keeps commentary out of the final output', async () => {
    const session = await start();
    const result = await session.submitPrompt('phased response', {
      origin: { kind: 'owner', requestId: 'request-1' },
    });
    expect(result.output).toBe('Implementation is ready.');
    const text = session.eventsSince(0).filter(event => event.kind === 'agent_text');
    expect(text).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'Checking the implementation.\n', messagePhase: 'commentary',
        messageId: 'commentary-1', origin: { kind: 'owner', requestId: 'request-1' },
      }),
      expect.objectContaining({
        text: 'Implementation is ready.', messagePhase: 'final_answer', messageId: 'final-1',
      }),
    ]));
    await session.close();
  });

  it('fails closed when an adapter supplies an unknown assistant phase', async () => {
    const session = await start();
    const result = await session.submitPrompt('ambiguous phase');
    expect(result.output).toBe('');
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'agent_text', text: 'Unclassified adapter output', messageId: 'ambiguous-1',
    }));
    expect(session.eventsSince(0).find(event => event.messageId === 'ambiguous-1')?.messagePhase)
      .toBeUndefined();
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

  it('a refused turn is delivered but not successful', async () => {
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

  it('a cancelled turn is delivered but not successful', async () => {
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

  it('auto-allows a nonexistent edit target through its canonical in-workspace ancestor', async () => {
    const session = await start('allow');
    await session.submitPrompt('permission location missing');
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'permission', status: 'completed', decision: 'allowed',
    }));
    await session.close();
  });

  it('does not auto-allow a nonexistent target through a symlink escaping the workspace', async () => {
    const session = await start('allow', { unattended: 'wait' });
    const outside = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-outside-'));
    dirs.push(outside);
    symlinkSync(outside, join(dirs.at(-2)!, 'escape'));
    const queued = await session.queuePrompt('permission location escape');
    for (let i = 0; i < 50 && !session.snapshot().pendingPermissionId; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'permission', status: 'pending', title: 'Fixture edit',
    }));
    expect(session.respondPermission(session.snapshot().pendingPermissionId!, 'reject')).toBe(true);
    await queued.completion;
    await session.close();
  });

  it('does not auto-allow an in-workspace dangling symlink to an absent outside target', async () => {
    const session = await start('allow', { unattended: 'wait' });
    const workspace = dirs.at(-1)!;
    const outside = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-dangling-outside-'));
    dirs.push(outside);
    symlinkSync(join(outside, 'created.txt'), join(workspace, 'dangling.txt'));

    const queued = await session.queuePrompt('permission location dangling');
    for (let i = 0; i < 50 && !session.snapshot().pendingPermissionId; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'permission', status: 'pending', title: 'Fixture edit',
    }));
    expect(session.respondPermission(session.snapshot().pendingPermissionId!, 'reject')).toBe(true);
    await queued.completion;
    await session.close();
  });

  it('auto-allows a dangling symlink whose absent target remains in the workspace', async () => {
    const session = await start('allow');
    const workspace = dirs.at(-1)!;
    symlinkSync(join(workspace, 'not-created-yet.txt'), join(workspace, 'dangling.txt'));

    await session.submitPrompt('permission location dangling');
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'permission', status: 'completed', decision: 'allowed',
    }));
    await session.close();
  });

  it('evaluates each request against the symlink target current for that request', async () => {
    const session = await start('allow', { unattended: 'wait' });
    const workspace = dirs.at(-1)!;
    const inside = join(workspace, 'inside');
    mkdirSync(inside);
    symlinkSync(inside, join(workspace, 'swap'));
    await session.submitPrompt('permission location swap');
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'permission', status: 'completed', decision: 'allowed',
    }));

    rmSync(join(workspace, 'swap'));
    const outside = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-swap-'));
    dirs.push(outside);
    symlinkSync(outside, join(workspace, 'swap'));
    const queued = await session.queuePrompt('permission location swap');
    for (let i = 0; i < 50 && !session.snapshot().pendingPermissionId; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.snapshot().pendingPermissionId).toBeTruthy();
    expect(session.respondPermission(session.snapshot().pendingPermissionId!, 'reject')).toBe(true);
    await queued.completion;
    await session.close();
  });

  it('fails closed on a symlink loop while canonicalizing a location', async () => {
    const session = await start('allow', { unattended: 'wait' });
    symlinkSync('loop', join(dirs.at(-1)!, 'loop'));
    const queued = await session.queuePrompt('permission location loop');
    for (let i = 0; i < 50 && !session.snapshot().pendingPermissionId; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.snapshot().pendingPermissionId).toBeTruthy();
    expect(session.respondPermission(session.snapshot().pendingPermissionId!, 'reject')).toBe(true);
    await queued.completion;
    await session.close();
  });

  it('denies unattended requests once each, never always', async () => {
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

  it('persists each automatic decision to .session-events.jsonl', async () => {
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

  it('records a policy denial as approval=deny, not as an unattended one', async () => {
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

  it('records an automatic allow with the policy that permitted it', async () => {
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

  it('queues a prompt behind a running turn instead of waiting for it', async () => {
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

  it('queuePrompt on a dead session is a typed offline error', async () => {
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

  it('defers an after_tool wake until terminal ACP tool evidence, then steers without cancellation', async () => {
    const session = await start();
    const active = session.submitPrompt('toolwait 120');
    for (let i = 0; i < 50 && !session.eventsSince(0)
      .some(event => event.kind === 'tool_call' && event.status === 'in_progress'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));

    const delivered = await session.submitPromptAfterTool('safe wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    expect(delivered).toMatchObject({
      accepted: true, detail: 'injected',
      safeBoundary: { state: 'after_tool', activeToolCount: 0 },
    });
    expect(session.eventsSince(0).filter(event => event.kind === 'monitor_delivery')
      .map(event => event.status)).toEqual(['deferred', 'after_tool']);
    expect(session.eventsSince(0).some(event =>
      event.kind === 'turn_stop' && event.cancellationSource === 'fleet-monitor')).toBe(false);
    expect(await active).toMatchObject({ outcome: 'completed' });

    const ledger = readFileSync(join(dirs.at(-1)!, '.conversation', 'events-000001.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const toolCompleted = ledger.findIndex(event =>
      event.kind === 'tool.upsert' && event.payload?.status === 'completed');
    const boundary = ledger.findIndex(event =>
      event.kind === 'monitor.delivery' && event.payload?.state === 'after_tool');
    expect(toolCompleted).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeGreaterThan(toolCompleted);
    expect(JSON.stringify(ledger.filter(event => event.kind === 'monitor.delivery')))
      .not.toContain('safe wake');
    await session.close();
  });

  it('steers an after_tool wake directly when no tool or permission is active', async () => {
    const session = await start();
    const result = await session.submitPromptAfterTool('idle wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    expect(result).toMatchObject({
      accepted: true, detail: 'startedNewTurn',
      safeBoundary: { state: 'direct', waitedMs: 0, activeToolCount: 0 },
    });
    expect(session.eventsSince(0).some(event => event.kind === 'monitor_delivery'
      && event.status === 'direct')).toBe(true);
    await session.close();
  });

  it('never settles a pending permission for after_tool and waits through its reserved tool', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const active = session.submitPrompt('permission');
    for (let i = 0; i < 50 && session.snapshot().readiness !== 'awaiting_permission'; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const permission = session.eventsSince(0).find(event =>
      event.kind === 'permission' && event.status === 'pending')!;
    let delivered = false;
    const wake = session.submitPromptAfterTool('permission-safe wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    }).then(result => { delivered = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(delivered).toBe(false);
    expect(session.eventsSince(0).filter(event =>
      event.kind === 'permission' && event.status === 'completed')).toHaveLength(0);
    const allow = permission.options!.find(option => option.kind.startsWith('allow'))!;
    expect(session.respondPermission(permission.permissionId!, allow.optionId)).toBe(true);
    expect(await active).toMatchObject({ outcome: 'completed' });
    expect(await wake).toMatchObject({ safeBoundary: { state: 'after_tool' } });
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'permission', status: 'completed', decision: 'allowed', decisionSource: 'manual',
    }));
    session.setControllerAttached(false);
    await session.close();
  });

  it('releases a denied permission reservation and steers without adding an automatic decision', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const active = session.submitPrompt('permission');
    for (let i = 0; i < 50 && session.snapshot().readiness !== 'awaiting_permission'; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const permission = session.eventsSince(0).find(event =>
      event.kind === 'permission' && event.status === 'pending')!;
    const wake = session.submitPromptAfterTool('denied-permission wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    const reject = permission.options!.find(option => option.kind.startsWith('reject'))!;
    expect(session.respondPermission(permission.permissionId!, reject.optionId)).toBe(true);
    expect(await active).toMatchObject({ outcome: 'completed' });
    expect(await wake).toMatchObject({ safeBoundary: { state: 'after_tool' } });
    const settled = session.eventsSince(0).filter(event =>
      event.kind === 'permission' && event.status === 'completed');
    expect(settled).toEqual([expect.objectContaining({
      decision: 'denied', decisionSource: 'manual',
    })]);
    session.setControllerAttached(false);
    await session.close();
  });

  it('keeps after_tool deferred until every duplicate permission reservation settles', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const active = session.submitPrompt('permission twice');
    for (let i = 0; i < 50 && session.eventsSince(0)
      .filter(event => event.kind === 'permission' && event.status === 'pending').length < 2; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const permissions = session.eventsSince(0).filter(event =>
      event.kind === 'permission' && event.status === 'pending');
    expect(permissions).toHaveLength(2);

    let delivered = false;
    const wake = session.submitPromptAfterTool('duplicate-permission-safe wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    }).then(result => { delivered = true; return result; });
    const firstReject = permissions[0].options!.find(option => option.kind === 'reject_once')!;
    expect(session.respondPermission(permissions[0].permissionId!, firstReject.optionId)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 40));
    const deliveredAfterFirst = delivered;
    const snapshotAfterFirst = session.snapshot();

    const secondReject = permissions[1].options!.find(option => option.kind === 'reject_once')!;
    expect(session.respondPermission(permissions[1].permissionId!, secondReject.optionId)).toBe(true);
    const wakeResult = await wake;
    const activeResult = await active;

    expect(deliveredAfterFirst).toBe(false);
    expect(snapshotAfterFirst).toMatchObject({
      readiness: 'awaiting_permission', pendingPermissionId: permissions[1].permissionId,
    });
    expect(wakeResult).toMatchObject({
      safeBoundary: { state: 'after_tool', activeToolCount: 0 },
    });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'steer:duplicate-permission-safe wake')).toBe(true);
    expect(session.eventsSince(0).some(event => event.cancellationSource === 'fleet-monitor')).toBe(false);
    expect(activeResult).toMatchObject({ outcome: 'completed' });
    session.setControllerAttached(false);
    await session.close();
  });

  it('uses real scheduled-loop reservation IDs internally while emitting only redacted IDs', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    let activeCompleted = false;
    const active = session.submitPrompt('permission linger 150', {
      origin: { kind: 'scheduled-loop', loop: 'health', runId: 'scheduled_permission' },
    }).then(result => { activeCompleted = true; return result; });
    for (let i = 0; i < 50 && session.snapshot().readiness !== 'awaiting_permission'; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const permission = session.eventsSince(0).find(event =>
      event.kind === 'permission' && event.status === 'pending')!;
    expect(permission).toMatchObject({
      toolCallId: 'scheduled-loop-tool', title: 'Scheduled-loop permission requested',
    });

    const wake = session.submitPromptAfterTool('scheduled permission wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    const reject = permission.options!.find(option => option.kind === 'reject_once')!;
    expect(session.respondPermission(permission.permissionId!, reject.optionId)).toBe(true);
    expect(await wake).toMatchObject({ safeBoundary: { state: 'after_tool', activeToolCount: 0 } });
    expect(activeCompleted).toBe(false);

    const sessionEvents = readFileSync(join(dirs.at(-1)!, '.session-events.jsonl'), 'utf8');
    const conversationEvents = readFileSync(
      join(dirs.at(-1)!, '.conversation', 'events-000001.jsonl'), 'utf8');
    expect(sessionEvents).toContain('scheduled-loop-tool');
    expect(conversationEvents).toContain('scheduled-loop-tool');
    expect(sessionEvents).not.toContain('fixture-tool');
    expect(conversationEvents).not.toContain('fixture-tool');

    expect(await active).toMatchObject({ outcome: 'completed' });
    session.setControllerAttached(false);
    await session.close();
  });

  it('redacts real scheduled-loop lifecycle IDs from events and the durable conversation', async () => {
    const session = await start();
    await session.submitPrompt('rich scheduled lifecycle', {
      origin: { kind: 'scheduled-loop', loop: 'health', runId: 'scheduled_rich' },
    });

    const rawSessionEvents = readFileSync(join(dirs.at(-1)!, '.session-events.jsonl'), 'utf8');
    const rawConversationEvents = readFileSync(
      join(dirs.at(-1)!, '.conversation', 'events-000001.jsonl'), 'utf8');
    const sessionToolEvents = rawSessionEvents.trim().split('\n').map(line => JSON.parse(line))
      .filter(event => event.kind === 'tool_call' || event.kind === 'tool_update');
    const conversationToolEvents = rawConversationEvents.trim().split('\n').map(line => JSON.parse(line))
      .filter(event => event.kind === 'tool.upsert');

    expect(sessionToolEvents).toHaveLength(2);
    expect(sessionToolEvents.map(event => event.toolCallId)).toEqual([
      'scheduled-loop-tool', 'scheduled-loop-tool',
    ]);
    expect(conversationToolEvents).toHaveLength(2);
    expect(conversationToolEvents.map(event => event.toolCallId)).toEqual([
      'scheduled-loop-tool', 'scheduled-loop-tool',
    ]);
    expect(conversationToolEvents.map(event => event.payload.toolCallId)).toEqual([
      'scheduled-loop-tool', 'scheduled-loop-tool',
    ]);
    expect(rawSessionEvents).toContain('scheduled-loop-tool');
    expect(rawConversationEvents).toContain('scheduled-loop-tool');
    expect(rawSessionEvents).not.toContain('rich-tool');
    expect(rawConversationEvents).not.toContain('rich-tool');

    await session.close();
  });

  it('queues multiple after_tool wakes on one tool boundary without cancellation', async () => {
    const session = await start();
    const active = session.submitPrompt('toolwait 100');
    for (let i = 0; i < 50 && !session.eventsSince(0)
      .some(event => event.kind === 'tool_call' && event.status === 'in_progress'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const first = session.submitPromptAfterTool('first safe wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    const second = session.submitPromptAfterTool('second safe wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ safeBoundary: expect.objectContaining({ state: 'after_tool' }) }),
      expect.objectContaining({ safeBoundary: expect.objectContaining({ state: 'after_tool' }) }),
    ]);
    expect(session.eventsSince(0).filter(event => event.kind === 'agent_text'
      && event.text?.startsWith('steer:')).map(event => event.text)).toEqual([
      'steer:first safe wake', 'steer:second safe wake',
    ]);
    expect(session.eventsSince(0).some(event => event.cancellationSource === 'fleet-monitor')).toBe(false);
    await active;
    await session.close();
  });

  it('uses visible non-cancelling steering when an active tool exceeds the after_tool bound', async () => {
    const session = await start('allow', { afterToolBoundaryTimeoutMs: 40 });
    const active = session.submitPrompt('late');
    for (let i = 0; i < 50 && !session.eventsSince(0)
      .some(event => event.kind === 'tool_call' && event.status === 'in_progress'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const wake = await session.submitPromptAfterTool('timeout wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    expect(wake).toMatchObject({
      accepted: true, detail: 'injected',
      safeBoundary: { state: 'timeout', activeToolCount: 1 },
    });
    expect(session.eventsSince(0)).toContainEqual(expect.objectContaining({
      kind: 'monitor_delivery', status: 'timeout', activeToolCount: 1,
    }));
    expect(session.eventsSince(0).some(event => event.kind === 'permission'
      && event.decisionSource === 'automatic')).toBe(false);
    await session.interrupt('owner');
    expect(await active).toMatchObject({ outcome: 'cancelled', cancellationSource: 'owner' });
    await session.close();
  });

  it('lets an explicit human interrupt bypass an after_tool wait immediately', async () => {
    const session = await start('allow', { afterToolBoundaryTimeoutMs: 2_000 });
    const active = session.submitPrompt('late');
    for (let i = 0; i < 50 && !session.eventsSince(0)
      .some(event => event.kind === 'tool_call' && event.status === 'in_progress'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const wake = session.submitPromptAfterTool('wake after owner interrupt', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    await session.interrupt('local-console');
    expect(await active).toMatchObject({ outcome: 'cancelled', cancellationSource: 'local-console' });
    expect(await wake).toMatchObject({ safeBoundary: { state: 'after_tool' } });
    expect(session.eventsSince(0).filter(event => event.kind === 'turn_stop'
      && event.cancellationSource === 'fleet-monitor')).toHaveLength(0);
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
    // An explicit interrupt that had to force recovery still SUCCEEDED: the
    // turn is over. Only the outcome says how, so no consumer reports a failure.
    await expect(session.interrupt('owner')).resolves.toEqual({
      state: 'forced', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED,
    });

    // The adapter never honors the cancel; after the grace period the session
    // must recover by force instead of leaving the turn (and its owner) hung.
    const result = await queued.completion;
    expect(result).toMatchObject({ succeeded: false, outcome: 'failed' });
    // SIGTERM delivery is asynchronous; wait for the adapter's exit record.
    for (let i = 0; i < 100 && session.exitResult() === null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.isAlive()).toBe(false);
    expect(session.exitResult()).not.toBeNull();
    expect(session.exitResult()?.detail).toContain(ACP_CANCEL_DEADLINE_EXCEEDED);
    await expect(session.queuePrompt('owner turn arriving during restart')).rejects.toMatchObject({
      kind: 'control-unavailable', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED,
    });

    const events = session.eventsSince(0);
    const escalations = events.filter(event =>
      event.kind === 'error' && event.status === ACP_CANCEL_DEADLINE_EXCEEDED);
    expect(escalations).toHaveLength(1);
    // The escalated turn terminates through the failure path only: no
    // turn_stop means no second, contradictory completion was produced.
    expect(events.filter(event => event.kind === 'turn_stop')).toHaveLength(0);
    await session.close();
  });

  it('hard-kills an adapter that ignores both cancellation and SIGTERM within a second bound', async () => {
    const startedAt = Date.now();
    const session = await start('allow', {
      cancelGraceMs: 50, cancelTerminateGraceMs: 75,
      env: { ACP_FIXTURE_IGNORE_SIGTERM: '1' },
    });
    const queued = await session.queuePrompt('stubborn block 60000');
    await waitForRunning(session);
    await expect(session.interrupt('owner')).resolves.toMatchObject({
      state: 'forced', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED,
    });
    expect(session.isAlive()).toBe(true);
    for (let i = 0; i < 100 && session.isAlive(); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(session.isAlive()).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((await queued.completion).detail).toContain(ACP_CANCEL_DEADLINE_EXCEEDED);
    expect(session.exitResult()).toMatchObject({ signal: 'SIGKILL' });
    await session.close();
  });

  it('settles an in-flight turn when the adapter dies without ever answering', async () => {
    const session = await start('allow');
    const queued = await session.queuePrompt('block 60000');
    await waitForRunning(session);

    // The adapter is gone mid-turn. Nothing will ever answer that request, so
    // the turn must terminate here: a completion that never settles is what
    // held a scheduled run `active` — and every later tick skipped_busy —
    // for the rest of the process's life.
    process.kill(session.pid, 'SIGKILL');
    const result = await Promise.race([
      queued.completion,
      new Promise(resolve => setTimeout(() => resolve('NEVER_SETTLED'), 3_000)),
    ]);
    expect(result).toMatchObject({ succeeded: false, outcome: 'failed' });
    for (let i = 0; i < 100 && session.exitResult() === null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.isAlive()).toBe(false);
    await session.close();
  });

  it('does not leave a cancellation waiting when the adapter dies inside the grace', async () => {
    const session = await start('allow', { cancelGraceMs: 2_000 });
    const queued = await session.queuePrompt('stubborn block 60000');
    await waitForRunning(session);

    const interrupted = session.interrupt('owner');
    // Killed by something else entirely while the cancel was still in grace.
    setTimeout(() => process.kill(session.pid, 'SIGKILL'), 50);
    const outcome = await Promise.race([
      interrupted,
      new Promise(resolve => setTimeout(() => resolve('NEVER_SETTLED'), 3_000)),
    ]);
    expect(outcome).toEqual({ state: 'settled' });
    expect((await queued.completion).succeeded).toBe(false);
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

describe('role control failures are typed', () => {
  it('reports a forced cancellation to the control plane as accepted, not failed', async () => {
    const session = await start('allow', { cancelGraceMs: 120 });
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const queued = await session.queuePrompt('stubborn block 60000');
      await waitForRunning(session);

      // The adapter ignores the cancel, so recovery is forced. The turn IS
      // cancelled, so `interrupt` must not reach the operator as an error —
      // that is what made commands, control and web report a failed stop.
      const response = await controlRequest(stateDir, { command: 'interrupt' }, 5_000);
      expect(response.ok).toBe(true);
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({
        state: 'forced', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED,
      });

      expect((await queued.completion).succeeded).toBe(false);
    } finally {
      await control.close();
      await session.close();
    }
  });

  it('carries the forced outcome into an idempotent interrupt_v2 receipt', async () => {
    const session = await start('allow', { cancelGraceMs: 120 });
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const queued = await session.queuePrompt('stubborn block 60000');
      await waitForRunning(session);
      const receipt = await controlRequest(
        stateDir, { command: 'interrupt_v2', version: 3, commandId: 'cmd-forced' }, 5_000);
      expect(receipt.ok).toBe(true);
      expect(receipt.result).toMatchObject({
        accepted: true, commandId: 'cmd-forced',
        state: 'forced', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED,
      });
      // A replay of the same command id returns the recorded receipt verbatim
      // rather than re-cancelling a session that is already being reclaimed.
      const replay = await controlRequest(
        stateDir, { command: 'interrupt_v2', version: 3, commandId: 'cmd-forced' }, 5_000);
      expect(replay.result).toEqual(receipt.result);
      expect((await queued.completion).succeeded).toBe(false);
    } finally {
      await control.close();
      await session.close();
    }
  });

  it('reports a cooperative cancellation as settled', async () => {
    const session = await start('allow', { cancelGraceMs: 2_000 });
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const queued = await session.queuePrompt('block 60000');
      await waitForRunning(session);
      const response = await controlRequest(stateDir, { command: 'interrupt' }, 5_000);
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ state: 'settled' });
      expect((await queued.completion).outcome).toBe('cancelled');
    } finally {
      await control.close();
      await session.close();
    }
  });

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

// ── defect 3: what a role declares has to reach session/new ─────────────────
//
// `mcpServers` was hard-coded to `[]` on new, resume and load, and `_meta` was
// never sent at all — so a role's own MCP servers had no route to an ACP session,
// and the `--settings` overlay that carries `harness_options.plugins` had none
// either (buildAcpLaunch cannot carry `prep.argv`). These assert the wire, not
// the adapter: the fixture echoes back the params it was actually given.
describe('session/new carries the role\'s declared servers and agent options', () => {
  const params = async (over: Partial<Parameters<typeof AcpSession.start>[0]> = {}) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-'));
    dirs.push(stateDir);
    const session = await AcpSession.start({
      name: 'A',
      argv: [process.execPath, fixture],
      cwd: stateDir,
      env: { ACP_FIXTURE_ECHO_SESSION_PARAMS: '1' },
      stateDir,
      mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      permissionMetadataSource: 'codex-acp',
      scrubObsoleteOursAutostart: true,
      log: () => {},
      ...over,
    });
    const echoed = session.eventsSince(0)
      .find(e => e.kind === 'agent_text' && e.text?.startsWith('new-params:'));
    await session.close();
    return JSON.parse((echoed as { text: string }).text.slice('new-params:'.length));
  };

  it('sends the declared servers and the agent _meta options', async () => {
    expect(await params({
      mcpServers: [{ name: 'ours', command: 'ours-mcp', args: ['proxy'], env: [] }],
      sessionMeta: { claudeCode: { options: { strictMcpConfig: true } } },
    })).toEqual({
      mcpServers: [{ name: 'ours', command: 'ours-mcp', args: ['proxy'], env: [] }],
      _meta: { claudeCode: { options: { strictMcpConfig: true } } },
      oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'],
      disableInheritedMcp: '0',
    });
  });

  it('sends protocol-required [] when the role declared nothing', async () => {
    expect(await params()).toEqual({
      mcpServers: [], _meta: null, oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'], disableInheritedMcp: '0',
    });
  });

  it('clears a stale explicit-empty signal for an inherited role', async () => {
    expect(await params({ env: {
      ACP_FIXTURE_ECHO_SESSION_PARAMS: '1',
      OURS_FLEET_CODEX_DISABLE_INHERITED_MCP: '1',
    } })).toEqual({
      mcpServers: [], _meta: null, oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'],
      disableInheritedMcp: '0',
    });
  });

  it.each(['', '0', '1'])('actively scrubs managed OURS_AUTOSTART=%j and exposes ours tools',
    async value => {
      expect(await params({ env: {
        ACP_FIXTURE_ECHO_SESSION_PARAMS: '1', OURS_AUTOSTART: value,
      } })).toMatchObject({
        oursAutostart: null, oursMcpTools: ['choose_identity', 'get_messages'],
      });
    });

  it('does not scrub an arbitrary non-managed ACP child', async () => {
    expect(await params({
      env: { ACP_FIXTURE_ECHO_SESSION_PARAMS: '1', OURS_AUTOSTART: 'custom' },
      scrubObsoleteOursAutostart: false,
    })).toMatchObject({ oursAutostart: 'custom', oursMcpTools: [] });
  });

  it('isolates opposite MCP intents across concurrent role processes', async () => {
    const [inherited, disabled] = await Promise.all([
      params(),
      params({ mcpServers: [] }),
    ]);
    expect(inherited).toEqual({
      mcpServers: [], _meta: null, oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'], disableInheritedMcp: '0',
    });
    expect(disabled).toEqual({
      mcpServers: [], _meta: null, oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'], disableInheritedMcp: '1',
    });
  });

  it('sends an explicit empty list to disable every inherited MCP server', async () => {
    expect(await params({
      mcpServers: [], permissionMetadataSource: 'codex-acp',
    })).toEqual({
      mcpServers: [], _meta: null, oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'], disableInheritedMcp: '1',
    });
  });

  it('never marks an explicit empty list for an unauthenticated/custom ACP agent', async () => {
    expect(await params({ mcpServers: [], permissionMetadataSource: undefined })).toEqual({
      mcpServers: [], _meta: null, oursAutostart: null,
      oursMcpTools: ['choose_identity', 'get_messages'], disableInheritedMcp: null,
    });
  });

  it('starts a temporary Codex-role contract before its first turn with required mcpServers', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-temp-codex-'));
    dirs.push(stateDir);
    const session = await AcpSession.start({
      name: 'tmp-contract-role', argv: [process.execPath, fixture], cwd: stateDir,
      env: { ACP_FIXTURE_REQUIRE_MCP_SERVERS: '1' }, stateDir, mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      permissionMetadataSource: 'codex-acp', scrubObsoleteOursAutostart: true, log: () => {},
    });
    expect(await session.submitPrompt('first turn')).toMatchObject({
      succeeded: true, output: 'echo:first turn',
    });
    await session.close();
  });
});

describe.each(['resume', 'load'] as const)('session/%s carries required MCP state', method => {
  it.each([
    ['absent', undefined, '0'],
    ['explicit empty', [], '1'],
    ['one server', [{ name: 'ours', command: 'ours-mcp', args: ['proxy'], env: [] }], '0'],
  ] as const)('%s', async (_label, mcpServers, disableInheritedMcp) => {
    const stateDir = mkdtempSync(join(tmpdir(), `ours-fleet-acp-${method}-`));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, '.acp-session-id'), 'fixture-session\n');
    const session = await AcpSession.start({
      name: 'A', argv: [process.execPath, fixture], cwd: stateDir,
      env: {
        ACP_FIXTURE_ECHO_SESSION_PARAMS: '1',
        ACP_FIXTURE_REQUIRE_MCP_SERVERS: '1',
        ...(method === 'resume'
          ? { ACP_FIXTURE_RESUME_SESSION: '1' }
          : { ACP_FIXTURE_LOAD_SESSION: '1' }),
      },
      stateDir, mode: 'resume',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      permissionMetadataSource: 'codex-acp',
      scrubObsoleteOursAutostart: true,
      ...(mcpServers === undefined ? {} : { mcpServers: [...mcpServers] }),
      log: () => {},
    });
    const prefix = `${method}-params:`;
    const echoed = session.eventsSince(0)
      .find(event => event.kind === 'agent_text' && event.text?.startsWith(prefix));
    expect(JSON.parse((echoed as { text: string }).text.slice(prefix.length))).toEqual({
      mcpServers: mcpServers ?? [], disableInheritedMcp,
    });
    await session.close();
  });
});

describe('injected durable BodyBrain construction', () => {
  it('does not compose a second AcpSession owner or alias restore to a fresh launch', () => {
    expect('createAcpSessionBodyBrainDriver' in acpSessionModule).toBe(false);
  });

  it('reuses AcpSession queue, ledger, event and terminal-result semantics after validated relay claim', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-injected-acp-')); dirs.push(stateDir);
    let listener: ((value: unknown) => void) | undefined; let seq = 0;
    const provider: AcpBodyBrainProvider = {
      subscribe: next => { listener = next; return () => { listener = undefined; }; },
      start: async () => ({ state: 'accepted', sessionMetadata: { schemaVersion: 1,
        token: 'injected-session', digest: `sha256:${'a'.repeat(64)}` } }), restore: vi.fn(),
      submit: vi.fn(async request => { queueMicrotask(() => listener?.({ protocolVersion: 1,
        generation: request.generation, transportSeq: ++seq, notificationId: `n${seq}`,
        kind: 'completed', promptId: request.promptId, outcome: 'completed' }));
        return { state: 'accepted' }; }),
      respondPermission: vi.fn(async () => ({ state: 'accepted' })),
      cancel: vi.fn(async () => ({ state: 'accepted' })),
      forceTerminate: vi.fn(async () => ({ state: 'accepted' })),
      close: vi.fn(async () => ({ state: 'accepted' })), retire: vi.fn(async () => ({ state: 'accepted' })),
      cleanup: vi.fn(async () => undefined),
    };
    const relay = new AgentConversationRelay({ agentId: 'A', generation: 1,
      runtimeInstanceKey: 'runtime', providerRuntimeId: 'injected-session' }, 'codex-acp', provider);
    await relay.start({ protocolVersion: 1, generation: 'g1', planDigest: `sha256:${'b'.repeat(64)}` });
    const session = await createInjectedAcpSession({ name: 'A', cwd: stateDir, stateDir, mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }, log: () => {} },
    relay, relay.issue());
    expect(session.pid).toBe(2_147_483_647); expect(session.pid).not.toBe(process.pid);
    listener?.({ protocolVersion: 1, generation: 'g1', transportSeq: ++seq, notificationId: `n${seq}`,
      kind: 'session_update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1',
        content: { type: 'text', text: 'streamed' } } });
    expect(session.eventsSince(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'agent_text', text: 'streamed', messageId: 'm1' }),
    ]));
    for (const update of [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
      { sessionUpdate: 'plan', entries: [{ content: 'work', priority: 'high', status: 'completed' }] },
      { sessionUpdate: 'usage_update', used: 1, size: 2 },
      { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
      { sessionUpdate: 'session_info_update', title: 'title' },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'config_option_update', configOptions: [] },
    ]) expect(() => listener?.({ protocolVersion: 1, generation: 'g1', transportSeq: ++seq,
      notificationId: `n${seq}`, kind: 'session_update', update })).not.toThrow();
    await expect(session.submitPrompt('hello', { origin: { kind: 'startup' } }))
      .resolves.toMatchObject({ accepted: true, succeeded: true, outcome: 'completed' });
    expect(session.eventsSince(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'state', status: 'running' }),
      expect.objectContaining({ kind: 'turn_stop', stopReason: 'end_turn' }),
    ]));
    expect(readFileSync(join(stateDir, '.conversation', 'events-000001.jsonl'), 'utf8')).toContain('turn.completed');
    const osKill = vi.spyOn(process, 'kill'); await session.close();
    expect(provider.close).toHaveBeenCalledOnce(); expect(provider.forceTerminate).toHaveBeenCalledOnce();
    expect(osKill).not.toHaveBeenCalled(); osKill.mockRestore();
  });
});
