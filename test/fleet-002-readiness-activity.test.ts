import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import { ACTIVITY_WINDOW_MS, classifyActivity, describeSessionState } from '../src/session/activity.js';
import { FleetQueryService } from '../src/application/fleet-query-service.js';
import type { RoleRecord } from '../src/application/types.js';
import type { SessionActivity, SessionReadiness } from '../src/session/types.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';

/**
 * FLEET-002. `readiness` is turn occupancy, and `arbiter` depends on it, so it
 * keeps its meaning and its values here. What these tests pin down is that no
 * human-facing surface reports turn occupancy as activity: a mail wake
 * delivered by ACP steering runs an entire turn that produces no turn evidence
 * for fleet at all, so only observed activity can answer "is this role idle".
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function startSession(): Promise<AcpSession> {
  const dir = stateDir('fleet-002-acp-');
  return AcpSession.start({
    name: 'A',
    argv: [process.execPath, fixture],
    cwd: dir,
    env: {},
    stateDir: dir,
    mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
}

const supervisor: SupervisorBackend = {
  id: 'systemd',
  async init() { return []; },
  async install() { return { created: false, detail: 'existing' }; },
  async start() {}, async stop() {}, async restart() {},
  async status() { return 'active'; },
  async liveness() { return { state: 'running', detail: 'active running' }; },
  async uninstall() { return { removed: false, detail: 'absent' }; },
  logsArgs() { return { cmd: 'journalctl', args: [] }; },
};

const role: RoleRecord = {
  id: 'SteeredRole', lifetime: 'permanent', configured: true,
  stateRef: { lifetime: 'permanent' }, stateHealth: 'present',
  configuredBackend: 'acp', detectedBackend: 'acp',
  compatibility: { compatible: true }, problems: [],
};

function statusFor(readiness: SessionReadiness, activity?: SessionActivity) {
  const dir = stateDir('fleet-002-query-');
  const query = new FleetQueryService({
    repository: { stateDir: () => dir } as never,
    supervisor,
    control: async () => ({
      ok: true,
      result: { backend: 'acp', alive: true, readiness, sessionId: 'live-session', activity },
    }) as never,
  });
  return query.status(role);
}

describe('FLEET-002 — a steered wake turn produces no turn evidence', () => {
  it('surfaces a steered turn as observed activity, and reports it busy rather than ready', async () => {
    const session = await startSession();
    // Startup turn finishes first: this is the exact live shape — turn_stop,
    // readiness idle, and only then the wake.
    expect(await session.submitPrompt('hello')).toMatchObject({ outcome: 'completed' });
    expect(session.snapshot().readiness).toBe('idle');

    const wake = await session.submitPromptAfterTool(
      '[fleet-monitor] 1 new message — steer tool', { origin: { kind: 'fleet-monitor' }, steer: true },
    );
    expect(wake).toMatchObject({ accepted: true, detail: 'startedNewTurn' });
    for (let i = 0; i < 50 && (session.snapshot().activity?.activeToolCalls ?? 0) === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    const snapshot = session.snapshot();
    // A steered turn carries no turn evidence for fleet — no `state: running`
    // for the wake origin — which is exactly why a reporting surface may not
    // read `readiness` as activity. Whether `readiness` itself learns to track
    // steered turns is FLEET-003's call; this regression deliberately asserts
    // only the activity evidence, so it holds either way.
    expect(session.eventsSince(0).some(event =>
      event.kind === 'state' && event.status === 'running'
      && event.origin?.kind === 'fleet-monitor')).toBe(false);
    expect(snapshot.activity?.activeToolCalls).toBe(1);
    expect(Date.parse(snapshot.activity?.lastUpdateAt ?? '')).toBeLessThanOrEqual(Date.now());
    // The same snapshot, through the surface a human reads: never `ready`.
    expect(classifyActivity(snapshot.activity).state).toBe('active');
    expect((await statusFor(snapshot.readiness, snapshot.activity)).overall).toBe('busy');
    await session.close();
  });
});

describe('FLEET-002 — reporting surfaces corroborate before calling a role idle', () => {
  it('reports an idle-readiness role with tools in flight as busy, not ready', async () => {
    const status = await statusFor('idle', { activeToolCalls: 2 });
    expect(status.session).toMatchObject({ readiness: 'idle' });
    expect(status.session.activity).toMatchObject({ state: 'active', activeToolCalls: 2 });
    expect(status.overall).toBe('busy');
  });

  it('reports an idle-readiness role with a recent agent update as busy', async () => {
    const status = await statusFor('idle', {
      activeToolCalls: 0, lastUpdateAt: new Date(Date.now() - 5_000).toISOString(),
    });
    expect(status.overall).toBe('busy');
    expect(status.session.activity.state).toBe('active');
  });

  it('still reports a genuinely quiet idle role as ready', async () => {
    const status = await statusFor('idle', {
      activeToolCalls: 0,
      lastUpdateAt: new Date(Date.now() - (ACTIVITY_WINDOW_MS + 60_000)).toISOString(),
    });
    expect(status.overall).toBe('ready');
    expect(status.session.activity.state).toBe('quiet');
  });

  it('never turns missing evidence into an idle claim', async () => {
    const status = await statusFor('idle', undefined);
    expect(status.session.activity.state).toBe('unobservable');
    expect(status.overall).toBe('ready');
    expect(describeSessionState('idle', undefined))
      .toContain('activity: unobservable (no agent-side evidence on this backend)');
  });

  it('labels readiness as turn occupancy in the operator line', () => {
    const line = describeSessionState('idle', {
      activeToolCalls: 3, lastUpdateAt: new Date().toISOString(),
    });
    expect(line).toContain('turn: idle (turn occupancy only)');
    expect(line).toContain('activity: active');
    expect(line).toContain('3 tool calls in flight');
  });

  it('classifies a stale last update outside the window as quiet, not active', () => {
    const now = Date.now();
    const observed = classifyActivity(
      { activeToolCalls: 0, lastUpdateAt: new Date(now - ACTIVITY_WINDOW_MS - 1).toISOString() }, now,
    );
    expect(observed.state).toBe('quiet');
  });
});
