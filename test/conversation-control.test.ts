import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import {
  RoleControlServer, controlRequest, controlSocketPath, controlTokenPath, followConversation,
} from '../src/session/control.js';
import { readFileSync } from 'node:fs';
import type { ConversationEventV1 } from '../src/session/conversation-types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startServer(approval: 'ask' | 'allow' | 'deny' = 'allow') {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-conv-ctl-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: { approval, filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
  const server = new RoleControlServer(stateDir, session, () => {});
  await server.start();
  cleanups.push(async () => { await server.close(); await session.close(); });
  return { stateDir, session, server };
}

async function startArbiterServer() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-conv-arbiter-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
  const server = new RoleControlServer(stateDir, new RoleTurnArbiter(session), () => {});
  await server.start();
  cleanups.push(async () => { await server.close(); await session.close(); });
  return { stateDir };
}

describe('role-control conversation v3', () => {
  it('forwards conversation v3 through the production turn arbiter', async () => {
    const { stateDir } = await startArbiterServer();
    const snapshot = await controlRequest(stateDir, { command: 'snapshot' });
    expect(snapshot.result).toMatchObject({
      protocolVersion: 3, features: expect.arrayContaining(['conversation_v3']),
    });
    const submitted = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'arbiter-cmd',
      text: 'through arbiter', actor: 'browser-digest',
    });
    expect(submitted.ok).toBe(true);
    const page = await controlRequest(stateDir, { command: 'conversation_page', limit: 100 });
    expect((page.result as { events: ConversationEventV1[] }).events.some(
      event => event.commandId === 'arbiter-cmd')).toBe(true);
  });
  it('advertises conversation_v3 and protocol 3 in the snapshot', async () => {
    const { stateDir } = await startServer();
    const response = await controlRequest(stateDir, { command: 'snapshot' });
    expect(response.ok).toBe(true);
    const result = response.result as { protocolVersion: number; features: string[] };
    expect(result.protocolVersion).toBe(3);
    expect(result.features).toContain('conversation_v3');
    // v1/v2 features remain, so old callers keep working.
    expect(result.features).toEqual(expect.arrayContaining(
      ['events_since', 'observer_follow', 'retained_range']));
  });

  it('serves conversation pages over the socket', async () => {
    const { stateDir, session } = await startServer();
    await session.submitPrompt('page me');
    const response = await controlRequest(stateDir, { command: 'conversation_page', limit: 100 });
    expect(response.ok).toBe(true);
    const result = response.result as {
      events: ConversationEventV1[]; snapshot: { sessionGeneration: string };
    };
    expect(result.events.map(e => e.kind)).toEqual(expect.arrayContaining(
      ['prompt.admitted', 'prompt.started', 'message.chunk', 'turn.completed']));
    expect(result.snapshot.sessionGeneration).toBeTruthy();
  });

  it('rejects v3 commands sent with an older protocol version', async () => {
    const { stateDir } = await startServer();
    // Hand-roll a version-2 frame for a v3 command.
    const token = readFileSync(controlTokenPath(stateDir), 'utf8').trim();
    const socket = createConnection(controlSocketPath(stateDir));
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
      });
      socket.once('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({
        version: 2, id: 'x', token, command: 'conversation_page',
      }) + '\n'));
    });
    socket.destroy();
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/version 3/);
  });

  it('admits browser prompts idempotently through submit_prompt_v2', async () => {
    const { stateDir } = await startServer();
    const first = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-1', text: 'browser says hi', actor: 'digest-1',
    });
    expect(first.ok).toBe(true);
    const receipt = first.result as { promptId: string };
    const replay = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-1', text: 'browser says hi', actor: 'digest-1',
    });
    expect((replay.result as { promptId: string }).promptId).toBe(receipt.promptId);

    const conflict = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-1', text: 'DIFFERENT', actor: 'digest-1',
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/idempotency_conflict/);
    expect(conflict.kind).toBe('rejected');
  });

  it('deduplicates interrupts by command id', async () => {
    const { stateDir } = await startServer();
    const first = await controlRequest(stateDir, { command: 'interrupt_v2', commandId: 'int-1' });
    expect(first.ok).toBe(true);
    const second = await controlRequest(stateDir, { command: 'interrupt_v2', commandId: 'int-1' });
    expect(second.result).toEqual(first.result);
  });

  it('binds v2 permission decisions to the session generation and first writer', async () => {
    const { stateDir, session } = await startServer('ask');
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    for (let i = 0; i < 100 && !session.conversationPage({ limit: 100 }).events.some(
      event => event.kind === 'permission.requested'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const requested = session.conversationPage({ limit: 100 }).events.find(
      event => event.kind === 'permission.requested')!;
    const staleGeneration = await controlRequest(stateDir, {
      command: 'respond_permission_v2', commandId: 'perm-stale',
      permissionId: requested.permissionId, optionId: 'allow',
      sessionGeneration: 'old-generation',
    });
    expect(staleGeneration.ok).toBe(false);
    expect(staleGeneration.error).toMatch(/stale_state/);

    const accepted = await controlRequest(stateDir, {
      command: 'respond_permission_v2', commandId: 'perm-win',
      permissionId: requested.permissionId, optionId: 'allow',
      sessionGeneration: requested.sessionGeneration,
    });
    expect(accepted).toMatchObject({ ok: true, result: { accepted: true, commandId: 'perm-win' } });
    const loser = await controlRequest(stateDir, {
      command: 'respond_permission_v2', commandId: 'perm-loser',
      permissionId: requested.permissionId, optionId: 'reject',
      sessionGeneration: requested.sessionGeneration,
    });
    expect(loser.ok).toBe(false);
    expect(loser.error).toMatch(/stale_state/);
    await queued.completion;
  });

  it('streams live conversation events and counts follow as controller presence', async () => {
    const { stateDir, session } = await startServer();
    await session.submitPrompt('warmup');
    const initial: Record<string, unknown>[] = [];
    const streamed: ConversationEventV1[] = [];
    const follow = await followConversation(stateDir, undefined, message => {
      if (message.conversationEvent) streamed.push(message.conversationEvent as ConversationEventV1);
      else initial.push(message);
    });
    cleanups.push(() => follow.close());
    for (let i = 0; i < 100 && initial.length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const page = (initial[0] as { result: { events: ConversationEventV1[] } }).result;
    expect(page.events.length).toBeGreaterThan(0);

    await session.submitPrompt('second turn');
    for (let i = 0; i < 100 && !streamed.some(e =>
      e.kind === 'turn.completed'
      && page.events.every(existing => existing.eventId !== e.eventId)); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    // No overlap and no gap: streamed events continue exactly after the page.
    const lastPaged = page.events.at(-1)!.seq;
    expect(Math.min(...streamed.map(e => e.seq))).toBe(lastPaged + 1);
    const all = [...page.events.map(e => e.seq), ...streamed.map(e => e.seq)];
    expect(new Set(all).size).toBe(all.length);
  });
});
