import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeSessionUpdate } from '../src/session/conversation-normalizer.js';
import type { MessageChunkPayload, ToolUpsertPayload } from '../src/session/conversation-types.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentFixture = join(here, 'fixtures', 'acp-agent.mjs');
const traceDir = join(here, 'fixtures', 'conversation');

const loadTrace = (name: string): Record<string, unknown>[] =>
  readFileSync(join(traceDir, name), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);

describe('adapter golden traces', () => {
  for (const trace of ['codex-updates.ndjson', 'claude-updates.ndjson']) {
    it(`normalizes every ${trace} update without loss of kind`, () => {
      const updates = loadTrace(trace);
      expect(updates.length).toBeGreaterThan(10);
      const kinds = updates.map(update => normalizeSessionUpdate(update as never).kind);
      // Nothing an adapter emits today may land in the unsupported bucket.
      expect(kinds).not.toContain('unsupported');
      expect(kinds).toContain('message.chunk');
      expect(kinds).toContain('thought.chunk');
      expect(kinds).toContain('plan.replace');
      expect(kinds).toContain('tool.upsert');
      expect(kinds).toContain('usage.updated');
      expect(kinds).toContain('capabilities.updated');
      expect(kinds).toContain('session.info');
      expect(kinds).toContain('session.state');
    });

    it(`keeps ${trace} adapter _meta quarantined by namespace`, () => {
      for (const update of loadTrace(trace)) {
        const result = normalizeSessionUpdate(update as never);
        for (const meta of result.adapterMeta ?? [])
          expect(['codex', 'claudeCode', 'fixture']).toContain(meta.namespace);
      }
    });
  }
});

/**
 * Drive the fixture agent over raw ACP JSON-RPC (stdio), the way AcpSession
 * does, and feed every streamed update through the normalizer. This proves the
 * fixture's new repertoire and the normalizer agree end to end.
 */
class FixtureDriver {
  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();
  readonly updates: Record<string, unknown>[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number' && 'result' in message) {
        this.pending.get(message.id)?.(message.result);
        this.pending.delete(message.id);
      } else if (message.method === 'session/update') {
        this.updates.push((message.params as { update: Record<string, unknown> }).update);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise(resolve => this.pending.set(id, resolve));
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async waitForUpdates(count: number): Promise<void> {
    for (let i = 0; i < 100 && this.updates.length < count; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGTERM'); });

function startFixture(env: Record<string, string> = {}): FixtureDriver {
  const child = spawn(process.execPath, [agentFixture], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  children.push(child);
  return new FixtureDriver(child);
}

describe('fixture agent conversation repertoire', () => {
  it('emits the full standard-update repertoire for a rich prompt', async () => {
    const driver = startFixture();
    await driver.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await driver.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    const result = await driver.request('session/prompt', {
      sessionId: 'fixture-session', prompt: [{ type: 'text', text: 'rich demo' }],
    }) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    const normalized = driver.updates.map(update => normalizeSessionUpdate(update as never));
    const kinds = new Set(normalized.map(n => n.kind));
    for (const kind of ['message.chunk', 'thought.chunk', 'plan.replace', 'tool.upsert',
      'usage.updated', 'session.info', 'session.state', 'capabilities.updated'])
      expect(kinds).toContain(kind);
    expect(kinds).not.toContain('unsupported');

    const userChunks = normalized.filter(n =>
      n.kind === 'message.chunk' && (n.payload as MessageChunkPayload).role === 'user');
    expect(userChunks).toHaveLength(1);
    expect(userChunks[0].messageId).toBe('user-1');

    // messageId grouping evidence: two chunks share msg-1, one is msg-2.
    const assistantIds = normalized
      .filter(n => n.kind === 'message.chunk' && (n.payload as MessageChunkPayload).role === 'assistant')
      .map(n => n.messageId);
    expect(assistantIds.filter(id => id === 'msg-1')).toHaveLength(2);
    expect(assistantIds.filter(id => id === 'msg-2')).toHaveLength(1);

    const toolPatch = normalized.find(n =>
      n.kind === 'tool.upsert' && !(n.payload as ToolUpsertPayload).snapshot);
    expect((toolPatch?.payload as ToolUpsertPayload).content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'diff' }),
      expect.objectContaining({ type: 'terminal', terminalId: 'rich-term' }),
    ]));
  });

  it('emits valid late updates between session/cancel and the cancelled response', async () => {
    const driver = startFixture();
    await driver.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await driver.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    const outcome = driver.request('session/prompt', {
      sessionId: 'fixture-session', prompt: [{ type: 'text', text: 'late tool run' }],
    }) as Promise<{ stopReason: string }>;
    await driver.waitForUpdates(1);   // the in-progress late-tool call
    driver.notify('session/cancel', { sessionId: 'fixture-session' });
    expect((await outcome).stopReason).toBe('cancelled');

    // After the fixture's echo chunk: the late tool completion and message
    // tail arrived BEFORE the cancelled response.
    const kinds = driver.updates.map(update => normalizeSessionUpdate(update as never).kind);
    expect(kinds).toEqual(['message.chunk', 'tool.upsert', 'tool.upsert', 'message.chunk']);
    expect(driver.updates.at(-1)).toMatchObject({ messageId: 'late-msg-1' });
  });

  it('replays history as updates during session/load', async () => {
    const driver = startFixture({ ACP_FIXTURE_LOAD_SESSION: '1', ACP_FIXTURE_REPLAY: '1' });
    await driver.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await driver.request('session/load', {
      sessionId: 'fixture-session', cwd: process.cwd(), mcpServers: [],
    });
    await driver.waitForUpdates(2);
    const normalized = driver.updates.map(update => normalizeSessionUpdate(update as never));
    expect(normalized.map(n => n.kind)).toEqual(['message.chunk', 'message.chunk']);
    expect((normalized[0].payload as MessageChunkPayload).role).toBe('user');
    expect(normalized[0].messageId).toBe('replay-user-1');
    expect((normalized[1].payload as MessageChunkPayload).role).toBe('assistant');
  });
});
