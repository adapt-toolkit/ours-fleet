import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpSession } from '../../src/session/acp.js';
import { RoleControlServer } from '../../src/session/control.js';
import { AcpRoleSessionAdapter } from '../../src/application/session-control.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { WebAuth } from '../../src/web/auth.js';
import { buildWebServer } from '../../src/web/server.js';
import type { ConversationEventV1 } from '../../src/session/conversation-types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'acp-agent.mjs');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * The full Phase-1 stack, no stubs: browser HTTP/WS -> web service ->
 * AcpRoleSessionAdapter -> private control socket -> AcpSession -> fixture
 * adapter, with the durable ledger in between.
 */
async function startStack() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-conv-real-'));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const session = await AcpSession.start({
    name: 'Alpha', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
  cleanups.push(() => session.close());
  const control = new RoleControlServer(stateDir, session, () => {});
  await control.start();
  cleanups.push(() => control.close());

  const role = {
    id: 'Alpha', lifetime: 'permanent', configured: true, stateHealth: 'present',
    configuredBackend: 'acp', detectedBackend: 'acp',
    compatibility: { compatible: true }, problems: [],
  };
  const webDir = mkdtempSync(join(tmpdir(), 'ours-conv-real-web-'));
  cleanups.push(() => rmSync(webDir, { recursive: true, force: true }));
  const auth = new WebAuth('http://placeholder', 'placeholder', Date.now, new TrustedDeviceStore(webDir));
  const server = await buildWebServer({
    query: {
      async list() { return []; },
      async detail() { return { role, status: {}, capabilities: {} }; },
    },
    repository: { async get() { return role; } },
    async session() { return new AcpRoleSessionAdapter(stateDir); },
    logs: { source: () => ({ tail: async () => ({ records: [], truncated: false }) }) },
    commands: { async execute() { return {}; }, get() { return undefined; } },
    creation: {
      async capabilities() { return {}; },
      async preview() { return {}; },
      async create() { return {}; },
      get() { return undefined; },
    },
    audit: new AuditSink(join(webDir, 'audit')),
  } as never, { origin: 'http://placeholder', host: 'placeholder' }, { auth });
  cleanups.push(() => server.close());
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const port = new URL(address).port;
  const origin = `http://127.0.0.1:${port}`;
  auth.setBoundary(origin, `127.0.0.1:${port}`);

  const exchange = await fetch(`${origin}/api/v1/auth/exchange`, {
    method: 'POST',
    headers: { origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` },
  });
  expect(exchange.ok).toBe(true);
  const cookie = (exchange.headers.getSetCookie?.() ?? [])
    .map(value => value.split(';')[0]).join('; ');
  const csrf = (await exchange.json() as { csrfToken: string }).csrfToken;
  const jsonHeaders = { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  return { origin, cookie, csrf, jsonHeaders, session };
}

interface StreamMessage { type: string; [key: string]: unknown }

function connectStream(
  origin: string, cookie: string, ticket: string, after?: string,
): Promise<{ socket: WebSocket; messages: StreamMessage[]; waitFor(test: () => boolean): Promise<void> }> {
  const url = origin.replace('http', 'ws') + '/api/v1/roles/Alpha/conversation-stream';
  const socket = new WebSocket(url, 'ours-fleet-conversation.v1', {
    origin, headers: { cookie },
  });
  const messages: StreamMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(String(data)) as StreamMessage));
  const waitFor = async (test: () => boolean) => {
    for (let i = 0; i < 300 && !test(); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(test()).toBe(true);
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'hello', ticket, ...(after ? { after } : {}) }));
      resolve({ socket, messages, waitFor });
    });
    socket.once('error', reject);
  });
}

const streamedEvents = (messages: StreamMessage[]): ConversationEventV1[] =>
  messages.filter(m => m.type === 'events')
    .flatMap(m => m.events as ConversationEventV1[]);

describe('conversation stream over the real stack', () => {
  it('replays, streams live turns, and resumes without duplicates', async () => {
    const { origin, cookie, jsonHeaders } = await startStack();

    // Admit a prompt over idempotent HTTP and let the turn complete.
    const submitted = await fetch(`${origin}/api/v1/roles/Alpha/input`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ text: 'rich first prompt', commandId: 'cmd-real-1' }),
    });
    expect(submitted.status).toBe(202);
    const receipt = await submitted.json() as { promptId: string };

    // History over HTTP shows the durable admission with persisted text.
    let history: { events: ConversationEventV1[] } = { events: [] };
    for (let i = 0; i < 300; i++) {
      const page = await fetch(`${origin}/api/v1/roles/Alpha/conversation?limit=200`,
        { headers: { origin, cookie } });
      expect(page.status).toBe(200);
      history = await page.json() as { events: ConversationEventV1[] };
      if (history.events.some(e => e.kind === 'turn.completed' && e.promptId === receipt.promptId)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const admitted = history.events.find(e => e.kind === 'prompt.admitted')!;
    expect(admitted.commandId).toBe('cmd-real-1');
    expect(admitted.source).toBe('owner_admin_console');
    expect(history.events.map(event => event.kind)).toEqual(expect.arrayContaining([
      'plan.replace', 'tool.upsert', 'usage.updated',
    ]));
    const richTool = history.events.find(event => event.kind === 'tool.upsert'
      && event.toolCallId === 'rich-tool');
    expect(richTool?.payload).toMatchObject({
      title: 'Apply fixture edit', kind: 'edit',
      locations: [{ path: expect.stringContaining('a.txt'), line: 3 }],
      rawInput: { json: { path: 'a.txt' } },
    });

    // Open the live stream: ready + full replay, then a live second turn.
    const mint = await fetch(`${origin}/api/v1/ws-tickets`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ purpose: 'conversation', roleId: 'Alpha' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    const stream = await connectStream(origin, cookie, ticket);
    await stream.waitFor(() => stream.messages.some(m => m.type === 'ready'));
    await stream.waitFor(() =>
      streamedEvents(stream.messages).some(e => e.kind === 'turn.completed'));
    const replayed = streamedEvents(stream.messages);
    expect(replayed.map(e => e.seq)).toEqual(history.events.map(e => e.seq));

    await fetch(`${origin}/api/v1/roles/Alpha/input`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ text: 'second prompt', commandId: 'cmd-real-2' }),
    });
    await stream.waitFor(() => streamedEvents(stream.messages)
      .filter(e => e.kind === 'turn.completed').length >= 2);
    const all = streamedEvents(stream.messages);
    // Ordered, gapless, duplicate-free: the browser dedupe key holds.
    expect(new Set(all.map(e => e.eventId)).size).toBe(all.length);
    expect(all.map(e => e.seq)).toEqual([...all.map(e => e.seq)].sort((a, b) => a - b));
    stream.socket.close();

    // Reconnect from the last applied cursor: only genuinely new events arrive.
    const lastSeq = all.at(-1)!.seq;
    const mint2 = await fetch(`${origin}/api/v1/ws-tickets`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ purpose: 'conversation', roleId: 'Alpha' }),
    });
    const { ticket: ticket2 } = await mint2.json() as { ticket: string };
    const resumed = await connectStream(origin, cookie, ticket2, String(lastSeq));
    await resumed.waitFor(() => resumed.messages.some(m => m.type === 'ready'));
    await fetch(`${origin}/api/v1/roles/Alpha/input`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ text: 'third prompt', commandId: 'cmd-real-3' }),
    });
    await resumed.waitFor(() => streamedEvents(resumed.messages)
      .some(e => e.kind === 'turn.completed' && e.seq > lastSeq));
    expect(streamedEvents(resumed.messages).every(e => e.seq > lastSeq)).toBe(true);
    resumed.socket.close();
  }, 30_000);

  it('refuses a conversation stream without a valid role-bound ticket', async () => {
    const { origin, cookie } = await startStack();
    const url = origin.replace('http', 'ws') + '/api/v1/roles/Alpha/conversation-stream';
    const socket = new WebSocket(url, 'ours-fleet-conversation.v1', {
      origin, headers: { cookie },
    });
    const closed = await new Promise<{ code: number }>(resolve => {
      socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', ticket: 'forged' })));
      socket.once('close', code => resolve({ code }));
    });
    expect(closed.code).toBe(4403);
  }, 15_000);
});
