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
const capabilities = {
  protocolVersion: 2, inventory: true, status: true,
  output: { recent: true, stream: true, structured: true, replayCursor: true },
  input: { text: true, rawKeys: false, interrupt: true, steering: false },
  permissions: { observe: true, respond: true },
  terminal: { available: false, reason: 'wrong_backend', multiViewer: false, writerLease: false },
  lifecycle: { start: false, stop: true, restartResume: true, restartFresh: true, remove: false },
  logs: { tail: true, follow: false, cursor: false },
};
const actions = new Map();
const services = {
  query: {
    async list() { return [{ role, status: { ...status, observedAt: new Date().toISOString() }, capabilities }]; },
    async detail() { return { role, status: { ...status, observedAt: new Date().toISOString() }, capabilities }; },
  },
  repository: { async get() { return role; } },
  async session() {
    return {
      async describe() { return { backend: 'acp', protocolVersion: 2, features: [] }; },
      async snapshot() { return { backend: 'acp', alive: true, readiness: 'idle' }; },
      async recentOutput() {
        return {
          events: [{ version: 1, seq: 1, at: new Date().toISOString(), kind: 'agent_text', text: 'Fixture agent is ready.' }],
          firstSeq: 1, lastSeq: 1, truncated: false,
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
        harnesses: [{ id: 'codex', available: true, sessions: ['acp', 'tmux'], warnings: [] }],
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
