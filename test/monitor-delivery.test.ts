import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableMonitorDelivery } from '../src/monitor-delivery.js';
import { turnResult, type AgentSession, type SessionEvent } from '../src/session/types.js';

let dir: string;
const opened: DurableMonitorDelivery[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-wake-journal-')); });
afterEach(() => { for (const q of opened.splice(0)) q.close(); rmSync(dir, { recursive: true, force: true }); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function world() {
  let busy = true;
  const calls: Array<{ text: string; options: unknown }> = [];
  const listeners = new Set<(event: SessionEvent) => void>();
  let finish!: (result: ReturnType<typeof turnResult>) => void;
  const session = {
    snapshot: () => ({ alive: true, readiness: busy ? 'running' : 'idle', activity: { activeToolCalls: 0 } }),
    subscribe: (fn: (event: SessionEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    submitPrompt: async (text: string, options: unknown) => {
      calls.push({ text, options }); busy = true;
      const result = await new Promise<ReturnType<typeof turnResult>>(resolve => { finish = resolve; });
      busy = false; return result;
    },
  } as unknown as AgentSession;
  return { session, calls, finish: (r = turnResult(true, 'completed')) => finish(r),
    idle: () => { busy = false; for (const fn of listeners) fn({ kind: 'state' } as SessionEvent); } };
}
function queue(w: ReturnType<typeof world>) {
  const q = new DurableMonitorDelivery({ stateDir: dir, session: w.session, log: () => {} });
  opened.push(q); q.start('daemon-profile/role-creation-1'); return q;
}
const batch = (...ids: number[]) => ({ scope: 'daemon-profile/role-creation-1', events: ids.map(id => ({
  key: `message_received:peer:${id}`, event: { event: 'message_received', from: 'peer', msg_id: id },
})) });
const saved = () => JSON.parse(readFileSync(join(dir, '.monitor-ingress.json'), 'utf8'));

describe('durable monitor responsibility transfer', () => {
  it('commits admission while busy, then drains FIFO without cancel or new mail', async () => {
    const w = world(), q = queue(w);
    expect(await q.admit(batch(1))).toMatchObject({ admitted: true, outcome: 'queued' });
    await q.admit(batch(2));
    expect(saved().rows.map((r: { state: string }) => r.state)).toEqual(['queued', 'queued']);
    expect(w.calls).toHaveLength(0);
    w.idle(); await tick();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ options: { interrupt: false, steer: false, origin: { kind: 'fleet-monitor' } } });
    w.finish(); await tick(); await tick();
    expect(w.calls).toHaveLength(2); w.finish(); await tick();
    expect(saved().rows.map((r: { state: string }) => r.state)).toEqual(['terminal', 'terminal']);
  });
  it('deduplicates changed coalescing after admission committed but cursor did not', async () => {
    const w = world(), q = queue(w);
    await q.admit(batch(1)); await q.admit(batch(1, 2));
    expect(saved().rows).toHaveLength(2);
    expect(saved().rows[1].keys).toEqual(['message_received:peer:2']);
    expect(await q.admit(batch(1, 2))).toMatchObject({ admitted: true, outcome: 'duplicate' });
  });
  it('recovers the admitted stream watermark before the monitor cursor is committed', async () => {
    const w = world(), q = queue(w);
    await q.admit({ ...batch(1), cursor: 200 }); q.close();
    const next = world(), recovered = queue(next);
    expect(recovered.admittedCursor('daemon-profile/role-creation-1')).toBe(200);
    expect(recovered.admittedCursor('another-source')).toBeUndefined();
    await recovered.admit({ ...batch(1), cursor: 220 });
    expect(recovered.admittedCursor('daemon-profile/role-creation-1')).toBe(220);
    expect(saved().rows).toHaveLength(1);
  });

  it('records cancelled execution separately and never replays it', async () => {
    const w = world(), q = queue(w); w.idle();
    await q.admit(batch(1)); await tick(); w.finish(turnResult(true, 'cancelled')); await tick();
    expect(saved().rows[0]).toMatchObject({ state: 'terminal', outcome: 'cancelled' });
    await q.admit(batch(1)); await tick(); expect(w.calls).toHaveLength(1);
  });
  it('resumes never dispatched hints after restart without another notification', async () => {
    const w = world(), q = queue(w); await q.admit(batch(1)); q.close();
    const next = world(); next.idle(); queue(next); await tick();
    expect(next.calls).toHaveLength(1); next.finish(); await tick();
  });
  it('fences uncertain dispatch and ignores late callbacks from retired instance', async () => {
    const w = world(), q = queue(w); w.idle(); await q.admit(batch(1)); await tick();
    await q.admit(batch(2)); q.close();
    const next = world(); next.idle(); queue(next); await tick();
    expect(saved().rows[0]).toMatchObject({ state: 'unknown', outcome: 'unknown_after_restart' });
    expect(next.calls).toHaveLength(1); expect(next.calls[0].text).toContain('#2');
    w.finish(); await tick();
    expect(saved().rows[0].state).toBe('unknown');
    next.finish(); await tick();
  });
  it('preserves proven not-dispatched work until a synchronized next generation', async () => {
    const w = world(), q = queue(w); w.idle();
    await q.admit(batch(1)); await tick();
    w.finish(turnResult(false, 'failed', 'ACP_PROMPT_NOT_DISPATCHED: ACP_SESSION_RECOVERY_REQUIRED'));
    await tick(); await tick();
    expect(saved().rows[0].state).toBe('queued'); expect(w.calls).toHaveLength(1);
    q.close(); const next = world(); next.idle(); queue(next); await tick();
    expect(next.calls).toHaveLength(1); next.finish(); await tick();
  });
  it('records a sent RPC failure as uncertain instead of completed failure', async () => {
    const w = world(), q = queue(w); w.idle(); await q.admit(batch(1)); await tick();
    w.finish(turnResult(false, 'failed', 'ACP_SESSION_RECOVERY_REQUIRED: RPC failed (code -32603)'));
    await tick(); expect(saved().rows[0].state).toBe('unknown');
  });
  it('archives old-source queued work before starting a replacement identity', async () => {
    const w = world(), q = queue(w); await q.admit(batch(1)); q.close();
    const next = world(); next.idle();
    const replacement = new DurableMonitorDelivery({ stateDir: dir, session: next.session, log: () => {} });
    opened.push(replacement); replacement.start('replacement-identity-epoch');
    await tick(); expect(next.calls).toHaveLength(0);
    expect(saved().rows[0]).toMatchObject({ state: 'unknown', outcome: 'source_scope_changed' });
    await replacement.admit({ ...batch(1), scope: 'replacement-identity-epoch' });
    await tick(); expect(next.calls).toHaveLength(1); next.finish(); await tick();
  });

  it('fails closed when the source is replaced after startup and before a later drain', async () => {
    const w = world(); let scope = 'daemon-profile/role-creation-1';
    const q = new DurableMonitorDelivery({ stateDir: dir, session: w.session, log: () => {}, currentScope: () => scope });
    opened.push(q); q.start(scope); await q.admit(batch(1));
    scope = 'replacement'; w.idle(); await tick();
    expect(w.calls).toHaveLength(0); expect(saved().rows[0].state).toBe('queued');
    await expect(q.admit(batch(2))).rejects.toThrow();
  });
  it('fails closed when source stat becomes unavailable before dispatch', async () => {
    const w = world(); let available = true;
    const q = new DurableMonitorDelivery({ stateDir: dir, session: w.session, log: () => {},
      currentScope: () => { if (!available) throw new Error('ENOENT'); return 'daemon-profile/role-creation-1'; } });
    opened.push(q); q.start('daemon-profile/role-creation-1'); await q.admit(batch(1));
    available = false; w.idle(); await tick();
    expect(w.calls).toHaveLength(0); expect(saved().rows[0].state).toBe('queued');
  });

  it('does not acknowledge or execute admission when durable commit fails', async () => {
    const w = world(), q = queue(w); w.idle();
    rmSync(join(dir, '.monitor-ingress.json'));
    mkdirSync(join(dir, '.monitor-ingress.json'));
    await expect(q.admit(batch(1))).rejects.toThrow(); await tick();
    expect(w.calls).toHaveLength(0);
  });
  it('rejects scope changes instead of reusing another identity stream', async () => {
    const w = world(), q = queue(w); await q.admit(batch(1));
    await expect(q.admit({ ...batch(2), scope: 'other-identity' })).rejects.toThrow(/scope/);
    expect(saved().rows).toHaveLength(1);
  });
});
