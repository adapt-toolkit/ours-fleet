import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import { ACP_CANCEL_DEADLINE_EXCEEDED } from '../src/session/types.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import { RoleControlServer, controlRequest } from '../src/session/control.js';
import type { ConversationObservationState } from '../src/session/conversation-types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The browser's Stop path: `interrupt_v2` through the role control server to
 * the arbiter, against an adapter whose steering starts a turn when idle and
 * keeps working for a minute unless cancelled.
 */
async function role() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-stop-wake-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A',
    argv: [process.execPath, fixture],
    cwd: stateDir,
    env: { ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '60000' },
    stateDir,
    mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
    cancelGraceMs: 2_000,
  });
  const arbiter = new RoleTurnArbiter(session);
  const control = new RoleControlServer(stateDir, arbiter, () => {});
  await control.start();
  const states: ConversationObservationState[] = [];
  const observation = arbiter.observeConversation(state => states.push(state));
  closers.push(async () => { observation.unsubscribe(); await control.close(); await session.close(); });
  const request = (command: Record<string, unknown>) =>
    controlRequest(stateDir, { version: 3, ...command } as never, 5_000);
  const stop = (commandId: string) => request({ command: 'interrupt_v2', commandId });
  const events = () => session.conversationPage({ limit: 500 }).events;
  const latest = () => states.at(-1) ?? observation.snapshot;
  const wake = (text: string) =>
    arbiter.submitPromptAfterTool(text, { origin: { kind: 'fleet-monitor' }, steer: true });
  return { session, arbiter, request, stop, events, latest, wake };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

describe('Stop on a mail wake turn', () => {
  it('cancels an idle wake as a turn Fleet owns, settles it and publishes idle', async () => {
    const r = await role();
    expect(await r.wake('[fleet-monitor] new mail block 60000'))
      .toMatchObject({ accepted: true, detail: 'startedNewTurn' });
    await until(() => r.latest().readiness === 'running' && r.latest().activePromptIds.length === 1);
    const promptId = r.latest().activePromptIds[0]!;

    const started = Date.now();
    const receipt = await r.stop('stop-1');
    expect(receipt).toMatchObject({ ok: true, result: { accepted: true, commandId: 'stop-1', state: 'settled' } });
    expect(Date.now() - started).toBeLessThan(1_500);

    // The interrupt resolves only after the provider's own cancelled stopReason.
    expect(r.events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'prompt.interrupt_requested', promptId }),
      expect.objectContaining({ kind: 'turn.completed', promptId, payload: expect.objectContaining({ outcome: 'cancelled' }) }),
    ]));
    expect(r.latest()).toMatchObject({ readiness: 'idle', queueDepth: 0, activePromptIds: [] });
    expect(r.session.snapshot().readiness).toBe('idle');

    // A fresh turn runs to completion afterwards.
    const fresh = await r.request({
      command: 'submit_prompt_v2', commandId: 'fresh', text: 'hello', actor: 'browser', source: 'owner_admin_console',
    });
    const freshId = (fresh.result as { promptId: string }).promptId;
    await until(() => r.events().some(event => event.kind === 'turn.completed' && event.promptId === freshId));
    expect(r.events().find(event => event.kind === 'turn.completed' && event.promptId === freshId)?.payload)
      .toMatchObject({ outcome: 'completed' });
    expect(r.latest().readiness).toBe('idle');
  });

  it('settles repeated Stop once and never cancels the next turn', async () => {
    const r = await role();
    await r.wake('[fleet-monitor] new mail block 60000');
    await until(() => r.latest().readiness === 'running');

    const [first, second] = await Promise.all([r.stop('stop-a'), r.stop('stop-b')]);
    expect(first).toMatchObject({ ok: true, result: { state: 'settled' } });
    expect(second).toMatchObject({ ok: true, result: { state: 'settled' } });
    expect(r.events().filter(event => event.kind === 'turn.completed')).toHaveLength(1);

    const next = await r.request({
      command: 'submit_prompt_v2', commandId: 'next', text: 'block 300', actor: 'browser', source: 'owner_admin_console',
    });
    const nextId = (next.result as { promptId: string }).promptId;
    await until(() => r.latest().activePromptIds.includes(nextId));
    // A retried Stop command replays its receipt rather than cancelling the new turn.
    expect(await r.stop('stop-a')).toMatchObject({ ok: true, result: first.result });
    await until(() => r.events().some(event => event.kind === 'turn.completed' && event.promptId === nextId));
    expect(r.events().find(event => event.kind === 'turn.completed' && event.promptId === nextId)?.payload)
      .toMatchObject({ outcome: 'completed' });
  });

  it('keeps late provider updates from reviving a stopped wake', async () => {
    const r = await role();
    await r.wake('[fleet-monitor] new mail late');
    await until(() => r.latest().readiness === 'running');

    expect(await r.stop('stop-late')).toMatchObject({ ok: true, result: { state: 'settled' } });
    expect(r.events().some(event => event.kind === 'message.chunk' && event.payload?.content?.text === 'late tail'))
      .toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(r.latest()).toMatchObject({ readiness: 'idle', queueDepth: 0 });
    expect(r.session.snapshot().readiness).toBe('idle');
  });

  it('reports a cancel that never reached the adapter as failed and keeps the turn running', async () => {
    const r = await role();
    await r.wake('[fleet-monitor] new mail block 60000');
    await until(() => r.latest().readiness === 'running');
    const agent = (r.session as unknown as { connection: { agent: { notify: (...args: unknown[]) => Promise<void> } } })
      .connection.agent;
    const notify = vi.spyOn(agent, 'notify').mockRejectedValueOnce(new Error('adapter pipe closed'));

    const failed = await r.stop('stop-lost');
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('adapter pipe closed');
    expect(r.latest().readiness).toBe('running');
    expect(r.events().some(event => event.kind === 'turn.completed')).toBe(false);

    notify.mockRestore();
    expect(await r.stop('stop-retry')).toMatchObject({ ok: true, result: { state: 'settled' } });
    expect(r.latest().readiness).toBe('idle');
  });

  it('joins a concurrent duplicate Stop instead of cancelling the queued next turn', async () => {
    const r = await role();
    await r.wake('[fleet-monitor] new mail block 60000');
    await until(() => r.latest().readiness === 'running');
    const next = await r.request({
      command: 'submit_prompt_v2', commandId: 'queued', text: 'block 300', actor: 'browser', source: 'owner_admin_console',
    });
    const nextId = (next.result as { promptId: string }).promptId;
    expect(r.latest().queueDepth).toBe(2);

    // Hold the provider cancel until the retried command has also arrived.
    const agent = (r.session as unknown as { connection: { agent: { notify: (...args: any[]) => Promise<void> } } })
      .connection.agent;
    const notify = agent.notify.bind(agent);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const gate = vi.spyOn(agent, 'notify').mockImplementationOnce(async (...args) => { await held; return notify(...args); });
    const first = r.stop('stop-dup');
    await until(() => gate.mock.calls.length === 1);
    const retry = r.stop('stop-dup');
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const [firstReceipt, retryReceipt] = await Promise.all([first, retry]);
    expect(retryReceipt).toMatchObject({ ok: true, result: firstReceipt.result });
    await until(() => r.events().some(event => event.kind === 'turn.completed' && event.promptId === nextId));
    const completed = r.events().filter(event => event.kind === 'turn.completed');
    expect(completed.map(event => event.payload?.outcome)).toEqual(['cancelled', 'completed']);
    expect(r.events().filter(event => event.kind === 'prompt.interrupt_requested')).toHaveLength(1);
  });

  it('reports Stop of a turn only the adapter owns as forced recovery, never settled', async () => {
    const r = await role();
    // Steering that races the end of an owned turn starts a turn Fleet cannot address.
    const steered = await (r.session as unknown as { steerPrompt(text: string): Promise<{ detail?: string }> })
      .steerPrompt('[fleet-monitor] new mail');
    expect(steered.detail).toBe('startedNewTurn');
    await until(() => r.latest().readiness === 'running');

    expect(await r.stop('stop-orphan')).toMatchObject({
      ok: true, result: { accepted: true, state: 'forced', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED },
    });
    expect(r.latest().readiness).not.toBe('running');
    await until(() => !r.session.isAlive());
    expect(r.session.snapshot().readiness).not.toBe('running');
  });

  it('still steers further mail into the running wake turn', async () => {
    const r = await role();
    await r.wake('[fleet-monitor] new mail block 60000');
    await until(() => r.latest().readiness === 'running');

    expect(await r.wake('[fleet-monitor] more mail')).toMatchObject({ accepted: true, detail: 'injected' });
    expect(r.latest().queueDepth).toBe(1);
    expect(await r.stop('stop-steered')).toMatchObject({ ok: true, result: { state: 'settled' } });
    expect(r.latest()).toMatchObject({ readiness: 'idle', queueDepth: 0 });
  });
});
