import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StallWatchdog, StallToolHistory, hasStallRecoveryClaim, type StallDiagnostic, type StallObservation } from '../src/session/stall-watchdog.js';
import { resolveMonitorConfig, validateMonitorConfig } from '../src/config.js';
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'fleet-stall-test-')); dirs.push(stateDir);
  let now = 1_000;
  let observation: StallObservation | undefined = { sessionId: 'SECRET session', generation: 'generation',
    turnId: 'SECRET turn', startedAt: 0, lastProgressAt: 0, progressCount: 1, transportFailures: 2, safe: true };
  const events: StallDiagnostic[] = [];
  const recover = vi.fn(async (_: StallObservation, report: (status: 'recovery_completed') => void) => { report('recovery_completed'); });
  const options = { stateDir, timeoutMs: 1_000, now: () => now, observe: () => observation, recover,
    diagnostic: (event: StallDiagnostic) => events.push(event) };
  return { options, events, recover, stateDir, watchdog: new StallWatchdog(options),
    setNow(value: number) { now = value; }, observation: () => observation!, clear() { observation = undefined; } };
}
describe('bounded durable ACP stall watchdog', () => {
  it('claims once before recovery, including concurrent ticks and supervisor restart', async () => {
    const f = setup(); const second = new StallWatchdog(f.options);
    await Promise.all([f.watchdog.tick(), f.watchdog.tick(), second.tick()]);
    expect(f.recover).toHaveBeenCalledTimes(1);
    await new StallWatchdog(f.options).tick();
    expect(f.recover).toHaveBeenCalledTimes(1);
    expect(f.events.some(e => e.status === 'blocked_previous_attempt')).toBe(true);
  });
  it('requires progress evidence, boundary safety, and the full silence window', async () => {
    const f = setup(); f.observation().safe = false; await f.watchdog.tick();
    f.observation().safe = true; f.observation().progressCount = 0; await f.watchdog.tick();
    f.observation().progressCount = 1; f.setNow(999); await f.watchdog.tick();
    expect(f.recover).not.toHaveBeenCalled();
    f.setNow(1_000); await f.watchdog.tick(); expect(f.recover).toHaveBeenCalledOnce();
  });
  it('continuous progress and delayed tool completion reset the timeout', async () => {
    const f = setup(); f.observation().lastProgressAt = 900;
    await f.watchdog.tick(); expect(f.recover).not.toHaveBeenCalled();
    f.setNow(1_899); await f.watchdog.tick(); expect(f.recover).not.toHaveBeenCalled();
    f.setNow(1_900); await f.watchdog.tick(); expect(f.recover).toHaveBeenCalledOnce();
  });
  it('reports absent startup evidence once without using turn age to interrupt', async () => {
    const f = setup(); f.observation().progressCount = 0; f.setNow(2_000);
    await f.watchdog.tick(); await f.watchdog.tick();
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.events.map(e => e.status)).toEqual(['blocked_evidence']);
    expect(readdirSync(join(f.stateDir, '.stall-recovery'))).toEqual(['audit.jsonl']);
  });
  it('missing boundary history emits evidence-unavailable without claiming or cancelling', async () => {
    const f = setup(); f.observation().safe = false; f.observation().boundaryEvidenceAvailable = false; f.setNow(2_000);
    await f.watchdog.tick(); expect(f.recover).not.toHaveBeenCalled();
    expect(f.events.map(e => e.status)).toEqual(['blocked_evidence']);
  });
  it('generic silence requires two windows; negative clock movement fails conservatively', async () => {
    const f = setup(); f.observation().transportFailures = 0;
    await f.watchdog.tick(); f.setNow(-1); await f.watchdog.tick();
    expect(f.recover).not.toHaveBeenCalled();
    f.setNow(2_000); await f.watchdog.tick(); expect(f.recover).toHaveBeenCalledOnce();
  });
  it('session completion before the tick does nothing', async () => {
    const f = setup(); f.clear(); await f.watchdog.tick(); expect(f.recover).not.toHaveBeenCalled();
  });
  it('claim/audit failure prevents interrupt and does not expose exception text', async () => {
    const f = setup(); writeFileSync(join(f.stateDir, '.stall-recovery'), 'SECRET');
    await f.watchdog.tick(); await f.watchdog.tick();
    expect(f.recover).not.toHaveBeenCalled(); expect(f.events[0].status).toBe('blocked_persistence');
    expect(JSON.stringify(f.events)).not.toContain('SECRET');
  });
  it('diagnostics and claims contain no raw identifiers, tool output, or prompt bodies', async () => {
    const f = setup(); await f.watchdog.tick();
    const contents = readdirSync(join(f.stateDir, '.stall-recovery'))
      .map(name => readFileSync(join(f.stateDir, '.stall-recovery', name), 'utf8')).join('');
    expect(contents).not.toContain('SECRET'); expect(contents).not.toContain('This is a diagnostic');
    expect(f.events.map(e => e.status)).toEqual(['interrupt_requested', 'recovery_completed']);
  });
});
describe('stall configuration compatibility', () => {
  it('leaves old resolved defaults unchanged and supports opt-in overrides', () => {
    expect(resolveMonitorConfig({})).not.toHaveProperty('stall_recovery');
    expect(resolveMonitorConfig({ stall_recovery: true, stall_timeout_ms: 900_000 }, { stall_recovery: false }))
      .toMatchObject({ stall_recovery: false, stall_timeout_ms: 900_000 });
  });
  it.each([null, '900000', 0, 59999, 1.5, Infinity, 86_400_001])('rejects invalid timeout %s', value => {
    expect(validateMonitorConfig({ stall_timeout_ms: value }).length).toBeGreaterThan(0);
  });
  it('validates enabled and default threshold', () => {
    expect(validateMonitorConfig({ stall_recovery: 'yes' }).length).toBeGreaterThan(0);
    expect(validateMonitorConfig({ stall_recovery: true, stall_timeout_ms: 900_000 })).toEqual([]);
  });
});

describe('durable boundary and claim restoration', () => {
  it('fences reused tool IDs across turns and process generations without storing IDs', () => {
    const f = setup(); const history = new StallToolHistory(f.stateDir, 'session', false);
    expect(history.observe('SECRET tool', 'turn1')).toBe(true);
    expect(history.observe('SECRET tool', 'turn1')).toBe(true);
    expect(history.observe('SECRET tool', 'turn2')).toBe(false);
    const resumed = new StallToolHistory(f.stateDir, 'session', true);
    expect(resumed.observe('SECRET tool', 'turn3')).toBe(false);
    expect(resumed.observe('new-tool', 'turn3')).toBe(true);
    const text = readdirSync(join(f.stateDir, '.stall-recovery'))
      .map(name => readFileSync(join(f.stateDir, '.stall-recovery', name), 'utf8')).join('');
    expect(text).not.toContain('SECRET'); expect(text).not.toContain('turn1');
  });
  it('missing resumed boundary history fails closed', () => {
    const f = setup(); const history = new StallToolHistory(f.stateDir, 'session', true);
    expect(history.available()).toBe(false); expect(history.observe('new', 'turn')).toBe(false);
  });
  it('an incomplete claim still restores conservative admission policy', async () => {
    const f = setup(); await f.watchdog.tick();
    const claim = readdirSync(join(f.stateDir, '.stall-recovery')).find(name => name.endsWith('.claim'))!;
    writeFileSync(join(f.stateDir, '.stall-recovery', claim), '');
    expect(hasStallRecoveryClaim(f.stateDir, f.observation().sessionId)).toBe(true);
  });
});
