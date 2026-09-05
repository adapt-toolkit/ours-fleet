import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebServer } from '../../../dist/web/server.js';
import { WebAuth } from '../../../dist/web/auth.js';
import { TrustedDeviceStore } from '../../../dist/web/device-store.js';
import { AuditSink } from '../../../dist/web/audit.js';
import { passwordAccess } from '../../../dist/web/access.js';
import { FleetConfigService } from '../../../dist/web/fleet-config-service.js';
import { TopologyDraftStore } from '../../../dist/web/topology-draft-store.js';
import { TopologyPromoteService } from '../../../dist/web/topology-promote.js';
import { mergeTopology } from '../../../dist/web/topology-model.js';
import { loadConfig } from '../../../dist/config.js';

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
  ...role, id: 'Terminal',
  config: { ...role.config, name: 'Terminal', identity: 'Terminal',
    mission: 'Verify a second structured agent workspace', model: undefined },
};
const inactiveRole = {
  ...role, id: 'Dormant',
  config: { ...role.config, name: 'Dormant', identity: 'Dormant', mission: 'Stopped historical role' },
};
const capabilities = {
  protocolVersion: 2, inventory: true, status: true,
  output: { recent: true, stream: true, structured: true, replayCursor: true },
  input: { text: true, interrupt: true, steering: false },
  permissions: { observe: true, respond: true },
  lifecycle: { start: false, stop: true, restartResume: true, restartFresh: true, remove: false },
  logs: { tail: true, follow: false, cursor: false },
};
const terminalCapabilities = capabilities;
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
// Three stored runs for the 'nightwatch' watchdog, newest first: the current
// run with one blocked finding (reason, evidence, and a matching alerts[]
// entry, so the detail view's evidence <details> and alert-note derivation
// both have something real to render), an older all-healthy run (so
// run-switching has a distinguishable target — no blocked text, no evidence,
// no alert note), and the oldest run which failed outright (status 'error',
// so the error+tail rendering branch has fixture coverage too).
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
    {
      runId: '20260731T100000Z', status: 'error',
      startedAt: '2026-07-31T10:00:00Z', finishedAt: '2026-07-31T10:00:05Z',
      summary: { checked: 0, healthy: 0, idle: 0, anomalies: 0 }, error: 'timeout',
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
    '20260731T100000Z': {
      schema_version: 1, watchdog: 'nightwatch', run_id: '20260731T100000Z',
      started_at: '2026-07-31T10:00:00Z', finished_at: '2026-07-31T10:00:05Z', status: 'error',
      summary: { checked: 0, healthy: 0, idle: 0, anomalies: 0 },
      roles: [], alerts: [], error: 'timeout',
      tail: 'connecting to Alice...\nconnection refused\n',
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
let outputCalls = 0;
const conversationAt = new Date().toISOString();
const conversationEvents = [
  { schemaVersion: 1, roleId: 'Alpha', eventId: 'conv-1', seq: 1, at: conversationAt,
    sessionGeneration: 'fixture-generation', kind: 'prompt.admitted', promptId: 'fixture-turn',
    commandId: 'fixture-command', source: 'owner_admin_console',
    payload: { text: { type: 'text', text: 'Inspect the fixture', bytes: 19 }, queuedBehind: 0 } },
  { schemaVersion: 1, roleId: 'Alpha', eventId: 'conv-2', seq: 2, at: conversationAt,
    sessionGeneration: 'fixture-generation', kind: 'plan.replace', promptId: 'fixture-turn',
    payload: { entries: [
      { content: { text: 'Inspect input', bytes: 13 }, priority: 'high', status: 'completed' },
      { content: { text: 'Render result', bytes: 13 }, priority: 'medium', status: 'in_progress' },
    ] } },
  { schemaVersion: 1, roleId: 'Alpha', eventId: 'conv-3', seq: 3, at: conversationAt,
    sessionGeneration: 'fixture-generation', kind: 'tool.upsert', promptId: 'fixture-turn',
    toolCallId: 'fixture-tool', payload: {
      toolCallId: 'fixture-tool', snapshot: true, title: 'Edit fixture.ts', kind: 'edit',
      status: 'completed', locations: [{ path: '/workspace/fixture.ts', line: 7 }],
      rawInput: { json: { path: 'fixture.ts' }, bytes: 21 },
      content: [{ type: 'diff', path: '/workspace/fixture.ts',
        oldText: { text: 'old value', bytes: 9 }, newText: { text: 'new value', bytes: 9 } }],
    } },
  { schemaVersion: 1, roleId: 'Alpha', eventId: 'conv-4', seq: 4, at: conversationAt,
    sessionGeneration: 'fixture-generation', kind: 'message.chunk', promptId: 'fixture-turn',
    messageId: 'fixture-message', source: 'agent',
    payload: { role: 'assistant', content: { type: 'text', text: 'Fixture result ready.', bytes: 21 } } },
  { schemaVersion: 1, roleId: 'Alpha', eventId: 'conv-5', seq: 5, at: conversationAt,
    sessionGeneration: 'fixture-generation', kind: 'usage.updated', promptId: 'fixture-turn',
    payload: { used: 42000, size: 100000, cost: { amount: 0.01, currency: 'USD' } } },
  { schemaVersion: 1, roleId: 'Alpha', eventId: 'conv-6', seq: 6, at: conversationAt,
    sessionGeneration: 'fixture-generation', kind: 'turn.completed', promptId: 'fixture-turn',
    payload: { outcome: 'completed', stopReason: 'end_turn' } },
];
const conversationPage = after => ({
  events: conversationEvents.filter(event => event.seq > Number(after ?? 0)),
  firstAvailableCursor: '1', nextCursor: '6', hasMore: false,
  snapshot: { sessionGeneration: 'fixture-generation', readiness: 'idle',
    queueDepth: 0, pendingPermissionIds: [] },
});
const services = {
  configuration: {
    read() {
      return {
        path: 'fleet.yaml', exists: true, firstRun: false, revision: 'fixture-revision',
        model: { defaults: { harness: 'codex', session: 'acp' }, roles: { Alpha: { mission: role.config.mission }, Terminal: {}, Dormant: {} } },
        redactions: [],
      };
    },
    async preview(revision, model) {
      return {
        valid: true, revision, normalizedModel: model, diff: '--- fleet.yaml (current)\n+++ fleet.yaml (proposed)\n', redactions: [],
        impact: { required: false, roles: [], watchdogScheduler: false, scheduledLoops: false, summary: 'No running process needs a restart.' },
        preflight: { ok: true, checks: [{ name: 'config', ok: true, detail: 'valid' }] },
      };
    },
    async write(revision, model) {
      const preview = await this.preview(revision, model);
      return { ...preview, saved: true, newRevision: 'fixture-revision-2', backup: 'fleet.yaml.backup-fixture' };
    },
  },
  async topology() {
    return {
      nodes: [
        { id: 'agent:Alpha', kind: 'agent', label: 'Alpha', status: 'ready', lifetime: 'permanent', detail: role.config.mission },
        { id: 'agent:Terminal', kind: 'agent', label: 'Terminal', status: 'ready', lifetime: 'permanent' },
        { id: 'agent:Dormant', kind: 'agent', label: 'Dormant', status: 'offline', lifetime: 'permanent' },
        { id: 'watchdog:nightwatch', kind: 'watchdog', label: 'nightwatch', status: 'active' },
      ],
      edges: [{ id: 'watch', kind: 'watches', from: 'watchdog:nightwatch', to: 'agent:Alpha', label: 'watches' }],
      unknownLineage: [],
    };
  },
  watchdogs: watchdogsService,
  query: {
    async list() { return [
      { role, status: { ...status, observedAt: new Date().toISOString() }, capabilities },
      { role: terminalRole, status: { ...status, roleId: 'Terminal', observedAt: new Date().toISOString() },
        capabilities: terminalCapabilities },
      { role: inactiveRole, status: { ...inactiveStatus, observedAt: new Date().toISOString() },
        capabilities: inactiveCapabilities },
    ]; },
    async detail(id) {
      const terminal = id === 'Terminal';
      const inactive = id === 'Dormant';
      return {
        role: inactive ? inactiveRole : terminal ? terminalRole : role,
        status: inactive ? { ...inactiveStatus, observedAt: new Date().toISOString() }
          : { ...status, roleId: terminal ? 'Terminal' : 'Alpha', observedAt: new Date().toISOString() },
        capabilities: inactive ? inactiveCapabilities : terminal ? terminalCapabilities : capabilities,
      };
    },
  },
  repository: { async get(id) { return id === 'Dormant' ? inactiveRole : id === 'Terminal' ? terminalRole : role; } },
  async session() {
    return {
      async describe() { return { backend: 'acp', protocolVersion: 3, features: ['conversation_v3'] }; },
      async snapshot() { return { backend: 'acp', alive: true, readiness: 'idle' }; },
      async recentOutput(request = {}) {
        outputCalls++;
        const events = [
            { version: 1, seq: 1, at: new Date().toISOString(), kind: 'agent_text', text: 'Fixture' },
            { version: 1, seq: 2, at: new Date().toISOString(), kind: 'agent_text', text: ' agent' },
            { version: 1, seq: 3, at: new Date().toISOString(), kind: 'agent_text', text: ' is ready.' },
            { version: 1, seq: 4, at: new Date().toISOString(), kind: 'tool_update', status: 'streaming' },
            { version: 1, seq: 5, at: new Date().toISOString(), kind: 'tool_update', status: 'complete' },
            ...(outputCalls >= 2 ? [{ version: 1, seq: 6, at: new Date().toISOString(),
              kind: 'agent_text', text: 'Live refresh arrived.' }] : []),
          ];
        const page = events.filter(event => event.seq > (request.since ?? 0));
        return { events: page, firstSeq: page[0]?.seq, lastSeq: events.at(-1)?.seq,
          nextCursor: String(events.at(-1)?.seq ?? 0), truncated: false };
      },
      async sendText() {
        return { accepted: true, promptId: 'fixture-prompt', queuedBehind: 0, terminalOutcomeKnown: false, detail: 'accepted; turn may still be running' };
      },
      async interrupt() { return { accepted: true }; },
      async respondPermission() { return { accepted: true }; },
      async conversationPage(request = {}) { return conversationPage(request.after); },
      async submitPromptV2(request) {
        return { commandId: request.commandId, promptId: 'fixture-prompt-v2', state: 'starting',
          queuedBehind: 0, acceptedAt: new Date().toISOString(), eventCursor: '6' };
      },
      async interruptV2(commandId) { return { accepted: true, commandId }; },
      async respondPermissionV2(request) { return { accepted: true, commandId: request.commandId }; },
      async followConversation(request) {
        request.onPage(conversationPage(request.after));
        return { close() {} };
      },
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
          { id: 'codex', available: true, sessions: ['acp'], models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
            modelOptions: [
              { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'low', source: 'codex-runtime-catalog' },
              { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', source: 'codex-runtime-catalog' },
            ], catalogSource: 'codex-runtime-catalog', customModelAllowed: true, warnings: [] },
          { id: 'claude-code', available: true, sessions: ['acp'], models: ['claude-fable-5', 'claude-opus-5'],
            modelOptions: [
              { id: 'claude-fable-5', label: 'Claude Fable 5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'claude-adapter-2.1' },
              { id: 'claude-opus-5', label: 'Claude Opus 5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'claude-adapter-2.1' },
            ], catalogSource: 'claude-adapter-2.1', customModelAllowed: true, warnings: [] },
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
  removal: {
    previewWeb(role) {
      return { role, configured: true, lifetime: 'permanent', confirmation: 'typed-role-name',
        coordinatorProtection: false, selfProtected: false,
        effects: [`Stop and uninstall the exact backend registration for '${role}'.`, `/fixture/state/${role}`],
        recovery: { available: true, detail: 'Fixture recovery archive is available.' } };
    },
    async removeWeb(input) { return { ...this.previewWeb(input.role), removed: true, recoveryPath: `/fixture/recovery/${input.role}` }; },
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
server.app.get('/__test/metrics', async () => ({ outputCalls }));
await server.app.listen({ host: '127.0.0.1', port: 49371 });
const noneBoundary = { origin: 'http://127.0.0.1:49372', host: '127.0.0.1:49372' };
const noneDir = mkdtempSync(join(tmpdir(), 'ours-fleet-e2e-none-'));
const noneServer = await buildWebServer({ ...services, audit: new AuditSink(join(noneDir, 'audit')) }, noneBoundary, {
  auth: new WebAuth(noneBoundary.origin, noneBoundary.host, Date.now,
    new TrustedDeviceStore(noneDir), { version: 1, mode: 'none' }),
});
await noneServer.app.listen({ host: '127.0.0.1', port: 49372 });
const passwordBoundary = { origin: 'http://127.0.0.1:49373', host: '127.0.0.1:49373' };
const passwordDir = mkdtempSync(join(tmpdir(), 'ours-fleet-e2e-password-'));
const passwordServer = await buildWebServer({ ...services, audit: new AuditSink(join(passwordDir, 'audit')) }, passwordBoundary, {
  auth: new WebAuth(passwordBoundary.origin, passwordBoundary.host, Date.now,
    new TrustedDeviceStore(passwordDir), passwordAccess('correct horse battery staple')),
});
await passwordServer.app.listen({ host: '127.0.0.1', port: 49373 });
/*
 * A fourth console on the REAL topology stack over an empty fleet: real
 * FleetConfigService, real draft sidecar, real merged model, real promotion.
 * The sketch -> connect -> add-to-fleet journey has to be exercised against the
 * services that actually write configuration, not against a stub.
 */
const editorBoundary = { origin: 'http://127.0.0.1:49374', host: '127.0.0.1:49374' };
const editorDir = mkdtempSync(join(tmpdir(), 'ours-fleet-e2e-editor-'));
const editorConfigPath = join(editorDir, 'fleet.yaml');
writeFileSync(editorConfigPath, '# operator header — must survive every console write\n', { mode: 0o600 });
const editorConfiguration = new FleetConfigService({ configPath: editorConfigPath });
const editorDrafts = new TopologyDraftStore({ dir: editorDir });
const editorTopology = async () => mergeTopology(
  loadConfig(editorConfigPath),
  loadConfig(editorConfigPath).roles.map(configured => ({
    role: {
      id: configured.name, lifetime: 'permanent', configured: true, stateHealth: 'present',
      configuredBackend: configured.session, detectedBackend: configured.session,
      compatibility: { compatible: true }, problems: [], config: { mission: configured.mission },
    },
    status: {
      roleId: configured.name, observedAt: new Date().toISOString(), overall: 'stopped',
      supervisor: { backend: 'none', liveness: 'stopped', detail: 'not started' },
      session: { backend: configured.session, reachability: 'offline', readiness: 'unknown', evidence: 'inferred' },
      restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
      monitor: { mode: 'fleet', health: 'unknown', stale: true },
      isolation: { degraded: false }, problems: [],
    },
    capabilities: {},
  })),
  editorDrafts.read());
const editorServer = await buildWebServer({
  ...services,
  audit: new AuditSink(join(editorDir, 'audit')),
  configuration: editorConfiguration,
  topology: editorTopology,
  topologyDrafts: editorDrafts,
  topologyPromote: new TopologyPromoteService({
    drafts: editorDrafts, configuration: editorConfiguration, topology: editorTopology,
  }),
  query: { async list() { return (await editorTopology()).nodes
    .filter(node => node.kind === 'agent' && node.origin === 'config')
    .map(node => ({
      role: { id: node.label, lifetime: 'permanent', configured: true, stateHealth: 'present',
        configuredBackend: 'acp', detectedBackend: 'acp', compatibility: { compatible: true }, problems: [] },
      status: { roleId: node.label, observedAt: new Date().toISOString(), overall: 'stopped',
        supervisor: { backend: 'none', liveness: 'stopped', detail: 'not started' },
        session: { backend: 'acp', reachability: 'offline', readiness: 'unknown', evidence: 'inferred' },
        restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
        monitor: { mode: 'fleet', health: 'unknown', stale: true },
        isolation: { degraded: false }, problems: [] },
      capabilities: {},
    })); } },
}, editorBoundary, {
  auth: new WebAuth(editorBoundary.origin, editorBoundary.host, Date.now, new TrustedDeviceStore(editorDir)),
});
editorServer.app.post('/__test/bootstrap', async () => ({
  url: `http://127.0.0.1:49374/#bootstrap=${editorServer.auth.mintBootstrap()}`,
}));
editorServer.app.get('/__test/fleet-yaml', async () => ({
  text: readFileSync(editorConfigPath, 'utf8'),
}));
// The fixture process is shared by every browser project, so the journey test
// resets the fleet and the sketch pad before it runs.
editorServer.app.post('/__test/reset', async () => {
  writeFileSync(editorConfigPath, '# operator header — must survive every console write\n', { mode: 0o600 });
  rmSync(editorDrafts.path, { force: true });
  return { ok: true };
});
await editorServer.app.listen({ host: '127.0.0.1', port: 49374 });

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await Promise.all([server.close(), noneServer.close(), passwordServer.close(), editorServer.close()]);
  process.exit(0);
});
