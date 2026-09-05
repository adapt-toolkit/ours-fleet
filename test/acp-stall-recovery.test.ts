import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpSession } from '../src/session/acp.js';
import type { StallObservation, StallWatchdog } from '../src/session/stall-watchdog.js';
import type { TurnResult } from '../src/session/types.js';
const sessions: AcpSession[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
type Internal = { stallWatchdog?: StallWatchdog; stallObservation(): StallObservation | undefined;
  checkStallWatchdog(): void; recordUpdate(update: unknown): void; stallAttempt?: { recoveryStartedAt?: number }; };
const internal = (session: AcpSession) => session as unknown as Internal;
async function fixture(mode = 'normal', enabled = true, source = true, stateDir?: string) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), 'fleet-acp-stall-'));
  if (!stateDir) dirs.push(dir);
  const log: string[] = [];
  const session = await AcpSession.start({ name: 'test-agent',
    argv: [process.execPath, join(import.meta.dirname, 'fixtures/stall-acp-agent.mjs')],
    stateDir: dir, cwd: dir, env: { STALL_FIXTURE_MODE: mode }, mode: stateDir ? 'resume' : 'fresh',
    permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
    ...(source ? { permissionMetadataSource: 'codex-acp' as const } : {}),
    ...(enabled ? { stallRecovery: { timeoutMs: 500, tickMs: 60_000, cancelWaitMs: mode === 'ignore-cancel' ? 40 : 1_000 } } : {}),
    log: line => log.push(line),
  });
  sessions.push(session);
  return { session, dir, log };
}
async function running(session: AcpSession) {
  await vi.waitFor(() => expect(internal(session).stallObservation()?.progressCount).toBeGreaterThan(0));
  // A final fixture marker means the tool and status updates were processed too.
  await vi.waitFor(() => expect(session.conversationPage({ limit: 100 }).events
    .some(e => JSON.stringify(e).includes('willRetry'))).toBe(true));
}
function clock(session: AcpSession, idle = 1_001) {
  const now = internal(session).stallObservation()!.lastProgressAt + idle;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  return now;
}
const statuses = (session: AcpSession) => session.eventsSince(0)
  .filter(e => e.kind === 'stall_recovery').map(e => e.status);

describe('ACP-local stall recovery', () => {
  it('recovers a websocket stall inside the startup queue slot without replaying the original prompt', async () => {
    const { session, dir, log } = await fixture();
    const pid = session.pid;
    const original = session.submitPrompt('startup SECRET mutation', { origin: { kind: 'startup' } });
    await running(session);
    const wake = session.submitPromptAfterTool('wake', { origin: { kind: 'fleet-monitor' } });
    clock(session, 501);
    await Promise.all([internal(session).stallWatchdog!.tick(), internal(session).stallWatchdog!.tick()]);
    expect((await original).succeeded).toBe(true);
    expect((await wake).succeeded).toBe(true);
    expect(session.pid).toBe(pid); expect(session.isAlive()).toBe(true);
    expect(statuses(session)).toEqual(['interrupt_requested', 'recovery_started', 'progress_resumed', 'recovery_completed']);
    expect(session.eventsSince(0).filter(e => e.kind === 'state' && e.status === 'running')).toHaveLength(3);
    const audit = readFileSync(join(dir, '.stall-recovery/audit.jsonl'), 'utf8');
    expect(audit).toContain('adapter_transport');
    expect(audit + log.filter(l => l.includes('stall recovery')).join('')).not.toMatch(/SECRET|private\/workspace|mutation|This is a diagnostic/);
  });
  it.each(['tool', 'permission', 'modal'])('does not cancel protected %s operations', async mode => {
    const { session } = await fixture(mode);
    const original = session.submitPrompt('original'); await running(session);
    if (mode === 'permission') await vi.waitFor(() => expect(session.snapshot().readiness).toBe('awaiting_permission'));
    clock(session, 1_000_000); await internal(session).stallWatchdog!.tick();
    expect(statuses(session)).toEqual([]); expect(session.isAlive()).toBe(true);
    await session.close(); await original;
  });
  it('resets the clock for reasoning and delayed tool-terminal events', async () => {
    const { session } = await fixture('tool'); const original = session.submitPrompt('original');
    await running(session); const now = clock(session, 100_000);
    internal(session).recordUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'mutation', status: 'completed' });
    await internal(session).stallWatchdog!.tick(); expect(statuses(session)).toEqual([]);
    vi.spyOn(Date, 'now').mockReturnValue(now + 800);
    internal(session).recordUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Still working SECRET' } });
    await internal(session).stallWatchdog!.tick(); expect(statuses(session)).toEqual([]);
    await session.close(); await original;
  });
  it('uses generic silence when metadata lacks pinned adapter provenance', async () => {
    const { session } = await fixture('normal', true, false); const original = session.submitPrompt('original');
    await running(session); clock(session, 501); await internal(session).stallWatchdog!.tick();
    expect(statuses(session)).toEqual([]);
    clock(session, 1_001); await internal(session).stallWatchdog!.tick(); expect((await original).succeeded).toBe(true);
  });
  it('does not restart or retry if the adapter ignores cancellation', async () => {
    const { session } = await fixture('ignore-cancel'); const original = session.submitPrompt('original');
    await running(session); clock(session); await internal(session).stallWatchdog!.tick();
    expect(statuses(session)).toEqual(['interrupt_requested', 'blocked_cancel']);
    expect(session.isAlive()).toBe(true);
    await internal(session).stallWatchdog!.tick(); expect(statuses(session)).toHaveLength(2);
    await session.close(); await original;
  });
  it('failed recovery is actionable and returns a typed startup-safe cancellation', async () => {
    const { session } = await fixture('recovery-refused'); const original = session.submitPrompt('original', { origin: { kind: 'startup' } });
    await running(session); clock(session); await internal(session).stallWatchdog!.tick();
    expect(await original).toMatchObject({ succeeded: false, cancellationSource: 'stall-watchdog' });
    expect(statuses(session)).toContain('blocked_recovery'); expect(session.isAlive()).toBe(true);
  });
  it.each(['recovery-stall', 'recovery-silent'])('reports %s once without another interrupt', async mode => {
    const { session } = await fixture(mode); const original = session.submitPrompt('original');
    await running(session); clock(session); await internal(session).stallWatchdog!.tick();
    await vi.waitFor(() => expect(internal(session).stallAttempt?.recoveryStartedAt).toBeDefined());
    if (mode === 'recovery-stall') await vi.waitFor(() => expect(statuses(session)).toContain('progress_resumed'));
    vi.spyOn(Date, 'now').mockReturnValue(Math.max(internal(session).stallObservation()!.lastProgressAt,
      internal(session).stallAttempt!.recoveryStartedAt!) + 1_001);
    internal(session).checkStallWatchdog();
    expect(statuses(session)).toContain('blocked_restall');
    expect(statuses(session).filter(s => s === 'interrupt_requested')).toHaveLength(1);
    expect(session.isAlive()).toBe(true); await session.close(); await original;
  });
  it('downgrades an immediate monitor wake during recovery to queued delivery', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original'); await running(session);
    clock(session); const recovering = internal(session).stallWatchdog!.tick();
    const wake = session.submitPrompt('wake', { interrupt: true, steer: true, interruptSource: 'fleet-monitor', origin: { kind: 'fleet-monitor' } });
    await recovering; expect((await original).succeeded).toBe(true); expect((await wake).succeeded).toBe(true);
    expect(session.eventsSince(0).filter(e => e.kind === 'turn_stop' && e.cancellationSource === 'fleet-monitor')).toHaveLength(0);
  });
  it('human interrupt during the recovery claim supersedes diagnostic continuation', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original'); await running(session);
    clock(session); const recovering = internal(session).stallWatchdog!.tick();
    await session.interrupt('owner'); await recovering; await original;
    expect(statuses(session)).toContain('superseded'); expect(statuses(session)).not.toContain('recovery_started');
  });
  it('already interrupted/completed turns do not trigger watchdog cancellation', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original'); await running(session);
    await session.interrupt('local-console'); await original;
    await internal(session).stallWatchdog!.tick(); expect(statuses(session)).toEqual([]);
  });
  it('a resumed supervisor never repeats a prior claim for the same ACP session', async () => {
    const first = await fixture(); const original = first.session.submitPrompt('original'); await running(first.session);
    clock(first.session); await internal(first.session).stallWatchdog!.tick(); await original;
    await first.session.close(); vi.restoreAllMocks();
    const next = await fixture('normal', true, true, first.dir); const resumed = next.session.submitPrompt('original'); await running(next.session);
    clock(next.session); await internal(next.session).stallWatchdog!.tick();
    expect(statuses(next.session)).toContain('blocked_previous_attempt');
    expect(statuses(next.session).filter(s => s === 'interrupt_requested')).toHaveLength(1); // durable old evidence only
    await next.session.close(); await resumed;
  });
  it('delayed original terminal events cannot make a reused replacement tool safe', async () => {
    const { session } = await fixture('recovery-stall'); const original = session.submitPrompt('original');
    await running(session); clock(session); await internal(session).stallWatchdog!.tick();
    await vi.waitFor(() => expect(statuses(session)).toContain('progress_resumed'));
    internal(session).recordUpdate({ sessionUpdate: 'tool_call', toolCallId: 'mutation', status: 'in_progress', title: 'new protected operation' });
    internal(session).recordUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'mutation', status: 'completed' });
    expect(internal(session).stallObservation()?.safe).toBe(false);
    await session.close(); await original;
  });
  it('replayed reasoning and tool events never reset the meaningful-progress clock', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original'); await running(session);
    const before = internal(session).stallObservation()!;
    const replay = session as unknown as { replaying: boolean };
    replay.replaying = true;
    clock(session);
    internal(session).recordUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'old history' } });
    replay.replaying = false;
    expect(internal(session).stallObservation()?.lastProgressAt).toBe(before.lastProgressAt);
    await session.close(); await original;
  });
  it('a human interrupt on the durable-claim event wins the final boundary recheck', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original'); await running(session);
    let human: Promise<unknown> | undefined;
    session.subscribe(event => { if (event.kind === 'stall_recovery' && event.status === 'interrupt_requested') human = session.interrupt('owner'); });
    clock(session); await internal(session).stallWatchdog!.tick(); await human; await original;
    expect(statuses(session)).toEqual(['interrupt_requested', 'superseded']);
    expect(session.eventsSince(0).filter(e => e.kind === 'turn_stop')[0].cancellationSource).toBe('owner');
  });
  it('diagnostic continuation does not impersonate direct Owner console input', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original', {
      origin: { kind: 'owner-admin-console', commandId: 'owner-command' },
    });
    await running(session); clock(session); await internal(session).stallWatchdog!.tick(); await original;
    const starts = session.eventsSince(0).filter(e => e.kind === 'state' && e.status === 'running');
    expect(starts.at(-1)?.origin).toEqual({ kind: 'stall-watchdog' });
  });
  it('surfaces silent startup as missing evidence without any automatic cancel', async () => {
    const { session } = await fixture('silent'); const original = session.submitPrompt('original', { origin: { kind: 'startup' } });
    await vi.waitFor(() => expect(internal(session).stallObservation()).toBeDefined());
    vi.spyOn(Date, 'now').mockReturnValue(internal(session).stallObservation()!.startedAt + 1_001);
    await internal(session).stallWatchdog!.tick(); await internal(session).stallWatchdog!.tick();
    expect(statuses(session)).toEqual(['blocked_evidence']); expect(session.isAlive()).toBe(true);
    await session.close(); await original;
  });
  it('duplicate plan/tool snapshots are not new progress and unknown boundaries block cancellation', async () => {
    const { session } = await fixture(); const original = session.submitPrompt('original'); await running(session);
    const update = { sessionUpdate: 'plan', entries: [{ content: 'Working', priority: 'medium', status: 'in_progress' }] };
    internal(session).recordUpdate(update);
    const previous = internal(session).stallObservation()!.lastProgressAt;
    clock(session);
    internal(session).recordUpdate(update);
    expect(internal(session).stallObservation()!.lastProgressAt).toBe(previous);
    internal(session).recordUpdate({ sessionUpdate: 'future_modal_operation' });
    expect(internal(session).stallObservation()!.safe).toBe(false);
    await internal(session).stallWatchdog!.tick(); expect(statuses(session)).toEqual([]);
    await session.close(); await original;
  });
  it('after_tool cannot steer past recovery even when steering is supported', async () => {
    const { session } = await fixture('steering'); const original = session.submitPrompt('original'); await running(session);
    clock(session); const recovering = internal(session).stallWatchdog!.tick();
    const wake = session.submitPromptAfterTool('wake', { origin: { kind: 'fleet-monitor' } });
    await recovering; expect((await original).succeeded).toBe(true); expect((await wake).succeeded).toBe(true);
    expect((session as unknown as { steeringWasUsed: boolean }).steeringWasUsed).toBe(false);
  });
  it('disabled feature creates no watchdog and preserves ordinary explicit interrupts', async () => {
    const { session } = await fixture('normal', false); const original = session.submitPrompt('original'); await running(session);
    expect(internal(session).stallWatchdog).toBeUndefined();
    await session.interrupt('owner'); expect(await original).toMatchObject({ cancellationSource: 'owner' });
    expect(statuses(session)).toEqual([]);
  });
});
