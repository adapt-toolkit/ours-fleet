import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebServer } from '../../../dist/web/server.js';
import { WebAuth } from '../../../dist/web/auth.js';
import { TrustedDeviceStore } from '../../../dist/web/device-store.js';
import { AuditSink } from '../../../dist/web/audit.js';

const status = {
  roleId: 'Alpha', observedAt: new Date().toISOString(), overall: 'ready',
  supervisor: { backend: 'systemd', liveness: 'stopped', detail: 'inactive' },
  session: { backend: 'acp', reachability: 'online', readiness: 'idle', evidence: 'authoritative' },
  restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
  monitor: { mode: 'fleet', health: 'armed', stale: false },
  isolation: { degraded: false }, problems: [],
};
const role = {
  id: 'Alpha', lifetime: 'permanent', configured: true, stateHealth: 'present',
  configuredBackend: 'acp', detectedBackend: 'acp', compatibility: { compatible: true },
  problems: [], config: {
    name: 'Alpha', harness: 'codex', session: 'acp', identity: 'Alpha',
    mission: 'Validate the secure console with an intentionally long mission that wraps across compact role-list lines without making the table materially taller', model: 'fixture-model',
    permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
  },
};
const terminalRole = {
  ...role, id: 'Terminal', configuredBackend: 'tmux', detectedBackend: 'tmux',
  config: { ...role.config, name: 'Terminal', identity: 'Terminal', session: 'tmux',
    mission: 'Verify ANSI and Unicode terminal fidelity', model: undefined },
};
const inactiveRole = {
  ...role, id: 'Dormant',
  config: { ...role.config, name: 'Dormant', identity: 'Dormant', mission: 'Stopped historical role' },
};
const capabilities = {
  protocolVersion: 2, inventory: true, status: true,
  output: { recent: true, stream: true, structured: true, replayCursor: true },
  input: { text: true, rawKeys: false, interrupt: true, steering: false },
  permissions: { observe: true, respond: true },
  terminal: { available: false, reason: 'wrong_backend', multiViewer: false, writerLease: false },
  lifecycle: { start: false, stop: true, restartResume: true, restartFresh: true, remove: false },
  logs: { tail: true, follow: false, cursor: false },
};
const terminalCapabilities = {
  ...capabilities,
  terminal: { available: true, multiViewer: true, writerLease: true },
  input: { text: false, rawKeys: true, interrupt: false, steering: false },
};
const inactiveCapabilities = {
  ...capabilities,
  lifecycle: { start: true, stop: true, restartResume: true, restartFresh: true, remove: false },
};
const inactiveStatus = {
  ...status, roleId: 'Dormant', overall: 'offline', supervisor: {
    backend: 'systemd', liveness: 'stopped', detail: 'inactive (dead)',
  }, session: {
    backend: 'acp', reachability: 'offline', readiness: 'failed', evidence: 'authoritative',
  },
};
// Two stored runs for the 'nightwatch' watchdog: an older healthy run and the
// current (newest) run with one blocked finding — reason, evidence, and a
// matching alerts[] entry, so the detail view's evidence <details> and
// alert-note derivation both have something real to render.
const watchdogRuns = {
  nightwatch: [
    {
      runId: '20260731T120000Z', status: 'anomalies',
      startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:01:12Z',
      summary: { checked: 2, healthy: 1, idle: 0, anomalies: 1 }, error: null,
    },
    {
      runId: '20260731T110000Z', status: 'ok',
      startedAt: '2026-07-31T11:00:00Z', finishedAt: '2026-07-31T11:00:45Z',
      summary: { checked: 2, healthy: 2, idle: 0, anomalies: 0 }, error: null,
    },
  ],
};
const watchdogReports = {
  nightwatch: {
    '20260731T120000Z': {
      schema_version: 1, watchdog: 'nightwatch', run_id: '20260731T120000Z',
      started_at: '2026-07-31T12:00:00Z', finished_at: '2026-07-31T12:01:12Z', status: 'anomalies',
      summary: { checked: 2, healthy: 1, idle: 0, anomalies: 1 },
      roles: [
        {
          role: 'Alice', status: 'blocked', reason: 'Waiting on a trust dialog.',
          evidence: [{ source: 'status', detail: 'readiness=awaiting_permission', observed_at: '2026-07-31T12:00:31Z' }],
          alerted: true,
        },
        { role: 'Docs', status: 'healthy' },
      ],
      alerts: [{ role: 'Alice', code: 'blocked', coordinator: 'FleetCoordinator', sent_at: '2026-07-31T12:01:10Z' }],
      error: null,
    },
    '20260731T110000Z': {
      schema_version: 1, watchdog: 'nightwatch', run_id: '20260731T110000Z',
      started_at: '2026-07-31T11:00:00Z', finished_at: '2026-07-31T11:00:45Z', status: 'ok',
      summary: { checked: 2, healthy: 2, idle: 0, anomalies: 0 },
      roles: [{ role: 'Alice', status: 'healthy' }, { role: 'Docs', status: 'healthy' }],
      alerts: [], error: null,
    },
  },
};
const watchdogsService = {
  async list() {
    return {
      watchdogs: [{
        name: 'nightwatch', enabled: true, heldDown: false, heldSince: null,
        intervalMs: 600_000, coordinator: 'FleetCoordinator', watch: ['Alice', 'Docs'],
        lastRunAt: '2026-07-31T12:00:00Z', nextRunAt: '2026-07-31T12:10:00Z',
        latest: {
          runId: '20260731T120000Z', status: 'anomalies',
          startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:01:12Z',
          summary: { checked: 2, healthy: 1, idle: 0, anomalies: 1 }, error: null,
        },
      }],
    };
  },
  async reports(name) { return { runs: watchdogRuns[name] ?? [] }; },
  async report(name, runId) { return watchdogReports[name]?.[runId]; },
};
const actions = new Map();
const services = {
  watchdogs: watchdogsService,
  query: {
    async list() { return [
      { role, status: { ...status, observedAt: new Date().toISOString() }, capabilities },
      { role: terminalRole, status: { ...status, roleId: 'Terminal', observedAt: new Date().toISOString(),
        session: { ...status.session, backend: 'tmux' } }, capabilities: terminalCapabilities },
      { role: inactiveRole, status: { ...inactiveStatus, observedAt: new Date().toISOString() },
        capabilities: inactiveCapabilities },
    ]; },
    async detail(id) {
      const terminal = id === 'Terminal';
      const inactive = id === 'Dormant';
      return {
        role: inactive ? inactiveRole : terminal ? terminalRole : role,
        status: inactive ? { ...inactiveStatus, observedAt: new Date().toISOString() }
          : { ...status, roleId: terminal ? 'Terminal' : 'Alpha', observedAt: new Date().toISOString(),
            session: terminal ? { ...status.session, backend: 'tmux' } : status.session },
        capabilities: inactive ? inactiveCapabilities : terminal ? terminalCapabilities : capabilities,
      };
    },
  },
  repository: { async get(id) { return id === 'Dormant' ? inactiveRole : id === 'Terminal' ? terminalRole : role; } },
  async session() {
    return {
      async describe() { return { backend: 'acp', protocolVersion: 2, features: [] }; },
      async snapshot() { return { backend: 'acp', alive: true, readiness: 'idle' }; },
      async recentOutput() {
        return {
          events: [
            { version: 1, seq: 1, at: new Date().toISOString(), kind: 'agent_text', text: 'Fixture' },
            { version: 1, seq: 2, at: new Date().toISOString(), kind: 'agent_text', text: ' agent' },
            { version: 1, seq: 3, at: new Date().toISOString(), kind: 'agent_text', text: ' is ready.' },
            { version: 1, seq: 4, at: new Date().toISOString(), kind: 'tool_update', status: 'streaming' },
            { version: 1, seq: 5, at: new Date().toISOString(), kind: 'tool_update', status: 'complete' },
          ],
          firstSeq: 1, lastSeq: 5, truncated: false,
        };
      },
      async sendText() {
        return { accepted: true, promptId: 'fixture-prompt', queuedBehind: 0, terminalOutcomeKnown: false, detail: 'accepted; turn may still be running' };
      },
      async interrupt() { return { accepted: true }; },
      async respondPermission() { return { accepted: true }; },
    };
  },
  logs: {
    source: () => ({ tail: async () => ({
      records: [{ at: new Date().toISOString(), text: 'fixture log line', redactionApplied: false }],
      truncated: false,
    }) }),
  },
  commands: {
    async execute(input) {
      const receipt = { actionId: input.actionId, roleId: input.roleId, action: input.action, acceptedAt: new Date().toISOString(), state: 'accepted' };
      actions.set(receipt.actionId, receipt); return receipt;
    },
    get(id) { return actions.get(id); },
  },
  creation: {
    async capabilities() {
      return {
        available: true, reasons: [],
        harnesses: [
          { id: 'codex', available: true, sessions: ['acp', 'tmux'], models: ['gpt-5.6', 'gpt-5.4'], warnings: [] },
          { id: 'claude-code', available: true, sessions: ['acp', 'tmux'], models: ['sonnet', 'opus', 'haiku'], warnings: [] },
        ],
        lifetimes: ['permanent', 'temporary'],
        identityBootstrap: {
          mode: 'current-fleet-first-boot', existingIdentity: 'missing',
          bindingEvidence: 'not-structured', warnings: [],
        },
        safePermissionSchemaVersion: 1,
      };
    },
    async preview(request) {
      return {
        request, effective: {
          ...request, identity: request.name,
          permissions: request.permissions,
        },
        identityBootstrap: {
          existingIdentity: 'missing', derivedIdentity: request.name,
          mode: 'current-fleet-first-boot', bindingEvidence: 'not-structured',
        },
        provenance: {}, warnings: [], prerequisites: [], previewHash: 'fixture-preview',
      };
    },
    async create(request) {
      const action = {
        actionId: 'fixture-creation', requestHash: 'fixture', roleId: request.name,
        session: request.session, lifetime: request.lifetime, state: 'session_reachable',
        stages: [
          { stage: 'validating', at: new Date().toISOString() },
          { stage: 'identity_bootstrap_pending', at: new Date().toISOString() },
          { stage: 'session_reachable', at: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        identityCheck: 'missing', identityBindingEvidence: 'not-structured',
        openPath: `/roles/${request.name}/activity`,
      };
      actions.set(action.actionId, action); return action;
    },
    get(id) { return actions.get(id); },
  },
  async terminalUpgrade(socket) {
    socket.send(JSON.stringify({
      type: 'snapshot', bridgeId: 'fixture-terminal', seq: '1',
      data: '\u001b[1;38;2;123;216;143mANSI BOLD\u001b[0m \u001b[3;4mITALIC UNDERLINE\u001b[0m ┌─ █ ',
    }));
    socket.send(JSON.stringify({ type: 'ready', mode: 'viewer', bridgeId: 'fixture-terminal' }));
  },
};

const boundary = { origin: 'http://127.0.0.1:49371', host: '127.0.0.1:49371' };
const deviceDir = mkdtempSync(join(tmpdir(), 'ours-fleet-e2e-device-'));
services.audit = new AuditSink(join(deviceDir, 'audit'));
const auth = new WebAuth(
  boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(deviceDir),
);
const server = await buildWebServer(services, boundary, { auth });
server.app.post('/__test/bootstrap', async () => ({
  url: `http://127.0.0.1:49371/#bootstrap=${server.auth.mintBootstrap()}`,
}));
server.app.post('/__test/restart-auth', async () => {
  server.auth.clearSessions();
  return { ok: true };
});
await server.app.listen({ host: '127.0.0.1', port: 49371 });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.close(); process.exit(0);
});
