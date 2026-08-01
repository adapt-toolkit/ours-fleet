import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FleetQueryService } from '../../src/application/fleet-query-service.js';
import { roleCapabilities } from '../../src/application/capabilities.js';
import type { Problem, RoleRecord } from '../../src/application/types.js';
import type { SessionReadiness } from '../../src/session/types.js';
import type { SupervisorBackend } from '../../src/supervisor/types.js';

const supervisor: SupervisorBackend = {
  id: 'systemd',
  async init() { return []; },
  async install() { return { created: false, detail: 'existing' }; },
  async start() {}, async stop() {}, async restart() {},
  async status() { return 'inactive'; },
  async liveness() { return { state: 'stopped', detail: 'inactive dead' }; },
  async uninstall() { return { removed: false, detail: 'absent' }; },
  logsArgs() { return { cmd: 'journalctl', args: [] }; },
};

function role(problems: Problem[] = []): RoleRecord {
  return {
    id: 'DetachedAcp', lifetime: 'permanent', configured: true,
    stateRef: { lifetime: 'permanent' }, stateHealth: 'present',
    configuredBackend: 'acp', detectedBackend: 'acp',
    compatibility: { compatible: true }, problems,
  };
}

async function status(
  readiness: SessionReadiness, problems: Problem[] = [],
  watchdogFindings?: () => Map<string, { watchdog: string; status: string; reason: string }>,
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'fleet-query-live-acp-'));
  const repository = { stateDir: () => stateDir };
  const query = new FleetQueryService({
    repository: repository as never,
    supervisor,
    control: async () => ({
      ok: true,
      result: { backend: 'acp', alive: true, readiness, sessionId: 'live-session' },
    }) as never,
    watchdogFindings,
  });
  return query.status(role(problems));
}

describe('authoritative session liveness precedence', () => {
  it('reports stopped-service plus authoritative online/idle ACP as ready', async () => {
    const result = await status('idle');
    expect(result.overall).toBe('ready');
    expect(result.session).toMatchObject({
      reachability: 'online', readiness: 'idle', evidence: 'authoritative',
    });
    expect(result.problems).toContainEqual({
      code: 'session_supervisor_disagreement', severity: 'warning',
      detail: 'session is live while its permanent supervisor service is inactive',
    });
  });

  it.each(['running', 'awaiting_permission'] as const)(
    'reports stopped-service plus authoritative online/%s ACP as busy',
    async readiness => {
      expect((await status(readiness)).overall).toBe('busy');
    },
  );

  it('preserves attention precedence over a live idle session', async () => {
    const result = await status('idle', [{
      code: 'fixture_error', severity: 'error', detail: 'operator attention required',
    }]);
    expect(result.overall).toBe('attention');
  });

  it('flags overall attention and appends a source: watchdog problem when the injected map has this role', async () => {
    const result = await status('idle', [], () => new Map([
      ['DetachedAcp', { watchdog: 'nightwatch', status: 'blocked', reason: 'no heartbeat' }],
    ]));
    expect(result.overall).toBe('attention');
    expect(result.problems).toContainEqual({
      code: 'watchdog_finding', severity: 'warning',
      detail: 'nightwatch: blocked — no heartbeat', source: 'watchdog',
    });
  });

  it('leaves status unchanged when no watchdogFindings provider is injected', async () => {
    const result = await status('idle');
    expect(result.overall).toBe('ready');
    expect(result.problems.some(p => p.source === 'watchdog')).toBe(false);
  });

  it('leaves status unchanged when the injected map does not contain this role', async () => {
    const result = await status('idle', [], () => new Map());
    expect(result.overall).toBe('ready');
    expect(result.problems.some(p => p.source === 'watchdog')).toBe(false);
  });

  it('offers only start lifecycle control for an inactive permanent role', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-query-offline-acp-'));
    const query = new FleetQueryService({
      repository: { stateDir: () => stateDir } as never, supervisor,
      control: async () => ({
        ok: true, result: { backend: 'acp', alive: false, readiness: 'failed' },
      }) as never,
    });
    const stopped = await query.status(role());
    // Attention evidence retains precedence, but stopped + non-online is still
    // inactive for topology and lifecycle-control purposes.
    expect(stopped.overall).toBe('attention');
    expect(roleCapabilities(role(), stopped).lifecycle).toMatchObject({
      start: true, stop: false, restartResume: false, restartFresh: false,
    });
  });
});
