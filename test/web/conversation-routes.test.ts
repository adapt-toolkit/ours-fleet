import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { FleetError } from '../../src/application/errors.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
const headers = (cookie: string, csrf?: string) => ({
  host: boundary.host, origin: boundary.origin, cookie,
  ...(csrf ? { 'x-csrf-token': csrf, 'content-type': 'application/json' } : {}),
});

const conversationControl = () => {
  const receipts = new Map<string, { receipt: unknown; body: string }>();
  return {
    async describe() { return { backend: 'acp', protocolVersion: 3, features: ['conversation_v3'] }; },
    async snapshot() { return { backend: 'acp', alive: true, readiness: 'idle' }; },
    async recentOutput() { return { events: [], truncated: false }; },
    async sendText() {
      return {
        accepted: true, promptId: 'legacy', queuedBehind: 0,
        terminalOutcomeKnown: false, detail: 'legacy path',
      };
    },
    async conversationPage() {
      return {
        events: [{
          schemaVersion: 1, roleId: 'Alpha', eventId: 'e1', seq: 1,
          at: new Date().toISOString(), sessionGeneration: 'gen',
          kind: 'prompt.admitted', payload: { queuedBehind: 0 },
        }],
        hasMore: false,
        snapshot: {
          sessionGeneration: 'gen', readiness: 'idle',
          queueDepth: 0, pendingPermissionIds: [],
        },
      };
    },
    async submitPromptV2(request: { commandId: string; text: string }) {
      const existing = receipts.get(request.commandId);
      if (existing) {
        if (existing.body !== request.text)
          throw new FleetError('idempotency_conflict', 'command id reuse with a different body');
        return existing.receipt;
      }
      const receipt = {
        commandId: request.commandId, promptId: `p-${request.commandId}`,
        state: 'starting', queuedBehind: 0,
        acceptedAt: new Date().toISOString(), eventCursor: '1',
      };
      receipts.set(request.commandId, { receipt, body: request.text });
      return receipt;
    },
    async interruptV2(commandId: string) { return { accepted: true, commandId }; },
  };
};

async function authenticated(control: unknown = conversationControl()) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-conv-web-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const role = {
    id: 'Alpha', lifetime: 'permanent', configured: true, stateHealth: 'present',
    configuredBackend: 'acp', detectedBackend: 'acp',
    compatibility: { compatible: true }, problems: [],
  };
  const server = await buildWebServer({
    query: {
      async list() { return []; },
      async detail() { return { role, status: {}, capabilities: {} }; },
    },
    repository: { async get() { return role; } },
    async session() { return control; },
    logs: { source: () => ({ tail: async () => ({ records: [], truncated: false }) }) },
    commands: { async execute() { return {}; }, get() { return undefined; } },
    creation: {
      async capabilities() { return {}; },
      async preview() { return {}; },
      async create() { return {}; },
      get() { return undefined; },
    },
    audit: new AuditSink(join(dir, 'audit')),
  } as never, boundary, { auth });
  const exchange = await server.app.inject({
    method: 'POST', url: '/api/v1/auth/exchange',
    headers: {
      host: boundary.host, origin: boundary.origin,
      authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
    },
  });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? [])
    .map(value => value.split(';')[0]).join('; ');
  const csrf = exchange.json().csrfToken as string;
  return { server, cookie, csrf };
}

describe('conversation web routes', () => {
  it('serves conversation history to an authenticated browser only', async () => {
    const { server, cookie } = await authenticated();
    const denied = await server.app.inject({
      method: 'GET', url: '/api/v1/roles/Alpha/conversation',
      headers: { host: boundary.host },
    });
    expect(denied.statusCode).toBe(401);
    const page = await server.app.inject({
      method: 'GET', url: '/api/v1/roles/Alpha/conversation?limit=50',
      headers: headers(cookie),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().events).toHaveLength(1);
    expect(page.json().snapshot.readiness).toBe('idle');
    await server.close();
  });

  it('reports capability_unavailable when the role has no ledger', async () => {
    const control = conversationControl() as Record<string, unknown>;
    delete control.conversationPage;
    const { server, cookie } = await authenticated(control);
    const page = await server.app.inject({
      method: 'GET', url: '/api/v1/roles/Alpha/conversation',
      headers: headers(cookie),
    });
    expect(page.statusCode).toBe(409);
    expect(page.json().error.code).toBe('capability_unavailable');
    await server.close();
  });

  it('admits prompts idempotently with 202 receipts and CSRF protection', async () => {
    const { server, cookie, csrf } = await authenticated();
    const noCsrf = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: { ...headers(cookie), 'content-type': 'application/json' },
      payload: { text: 'hi', commandId: 'cmd-1' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const first = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: headers(cookie, csrf),
      payload: { text: 'hi', commandId: 'cmd-1' },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ commandId: 'cmd-1', promptId: 'p-cmd-1' });

    const replay = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: headers(cookie, csrf),
      payload: { text: 'hi', commandId: 'cmd-1' },
    });
    expect(replay.json().promptId).toBe('p-cmd-1');

    const conflict = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: headers(cookie, csrf),
      payload: { text: 'DIFFERENT', commandId: 'cmd-1' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    await server.close();
  });

  it('keeps the legacy input path for callers without a command id', async () => {
    const { server, cookie, csrf } = await authenticated();
    const legacy = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: headers(cookie, csrf),
      payload: { text: 'old client' },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().promptId).toBe('legacy');
    await server.close();
  });

  it('accepts idempotent interrupts with 202', async () => {
    const { server, cookie, csrf } = await authenticated();
    const receipt = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/interrupt',
      headers: headers(cookie, csrf),
      payload: { commandId: 'int-1' },
    });
    expect(receipt.statusCode).toBe(202);
    expect(receipt.json()).toMatchObject({ accepted: true, commandId: 'int-1' });
    await server.close();
  });

  it('mints conversation tickets only when bound to a role', async () => {
    const { server, cookie, csrf } = await authenticated();
    const unbound = await server.app.inject({
      method: 'POST', url: '/api/v1/ws-tickets',
      headers: headers(cookie, csrf),
      payload: { purpose: 'conversation' },
    });
    expect(unbound.statusCode).toBe(400);
    const bound = await server.app.inject({
      method: 'POST', url: '/api/v1/ws-tickets',
      headers: headers(cookie, csrf),
      payload: { purpose: 'conversation', roleId: 'Alpha' },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().ticket).toBeTruthy();
    await server.close();
  });
});
