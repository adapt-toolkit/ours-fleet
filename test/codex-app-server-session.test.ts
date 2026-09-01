import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAppServerSession } from '../src/session/codex-app-server.js';
import type {
  CodexAppServerConnection, CodexAppServerTransportFactory, CodexAppServerTransportOptions,
} from '../src/session/codex-app-server-transport.js';

class FakeAppServer implements CodexAppServerConnection {
  readonly pid = 4242;
  readonly child = { kill: () => { this.alive = false; return true; } };
  private alive = true;
  private turn = 0;
  private approvalTurn?: { requestId: number; turnId: string; kind: 'operation' | 'permissions' };
  constructor(private readonly options: CodexAppServerTransportOptions) {}

  isAlive() { return this.alive; }
  exitResult() { return null; }
  notify() {}
  respondError() {}
  async close() { this.alive = false; }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'initialize') return { userAgent: 'fixture' } as T;
    if (method === 'thread/start' || method === 'thread/resume') return {
      thread: { id: method === 'thread/resume' ? params.threadId : 'thread-native-1' },
      model: params.model ?? 'fixture-model', reasoningEffort: 'medium', cwd: params.cwd,
    } as T;
    if (method === 'turn/start') {
      const turnId = `turn-${++this.turn}`;
      const input = params.input as Array<{ text?: string }>;
      queueMicrotask(() => {
        this.options.onNotification?.('turn/started', {
          threadId: 'thread-native-1', turn: { id: turnId, status: 'inProgress' },
        });
        if (input[0]?.text?.includes('additional permission')) {
          const requestId = 900 + this.turn;
          this.approvalTurn = { requestId, turnId, kind: 'permissions' };
          this.options.onRequest?.('item/permissions/requestApproval', requestId, {
            threadId: 'thread-native-1', turnId, itemId: `permissions-${turnId}`,
            reason: 'network access', permissions: {
              network: { enabled: true }, fileSystem: null,
            },
          });
        } else if (input[0]?.text?.includes('permission')) {
          const requestId = 900 + this.turn;
          this.approvalTurn = { requestId, turnId, kind: 'operation' };
          this.options.onRequest?.('item/commandExecution/requestApproval', requestId, {
            threadId: 'thread-native-1', turnId, itemId: `command-${turnId}`,
            command: 'echo approved', availableDecisions: ['accept', 'decline', 'cancel'],
          });
        } else this.complete(turnId, 'native final');
      });
      return { turn: { id: turnId, status: 'inProgress' } } as T;
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId } as T;
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.options.onNotification?.('turn/completed', {
        threadId: 'thread-native-1', turn: { id: params.turnId, status: 'interrupted', error: null },
      }));
      return {} as T;
    }
    throw new Error(`unexpected method ${method}`);
  }

  respond(id: string | number, result: unknown) {
    if (!this.approvalTurn || this.approvalTurn.requestId !== id) return;
    const { turnId, kind } = this.approvalTurn;
    const decision = kind === 'permissions'
      ? `scope:${(result as { scope?: string }).scope ?? 'unknown'}`
      : (result as { decision?: string }).decision ?? 'unknown';
    this.approvalTurn = undefined;
    queueMicrotask(() => this.complete(turnId, `permission:${decision}`));
  }

  private complete(turnId: string, text: string) {
    const item = { type: 'agentMessage', id: `message-${turnId}`, text,
      phase: 'final_answer', memoryCitation: null, delivery: null };
    this.options.onNotification?.('item/started', {
      threadId: 'thread-native-1', turnId, item: { ...item, text: '' },
    });
    this.options.onNotification?.('item/agentMessage/delta', {
      threadId: 'thread-native-1', turnId, itemId: item.id, delta: text,
    });
    this.options.onNotification?.('item/completed', {
      threadId: 'thread-native-1', turnId, item,
    });
    this.options.onNotification?.('turn/completed', {
      threadId: 'thread-native-1', turn: { id: turnId, status: 'completed', error: null },
    });
  }
}

const fakeTransport: CodexAppServerTransportFactory = async options => new FakeAppServer(options);

const start = (stateDir: string, mode: 'fresh' | 'resume' = 'fresh', approval: 'ask' | 'allow' = 'allow') =>
  CodexAppServerSession.start({
    name: 'NativeCodex', argv: ['codex', 'app-server'], cwd: stateDir, env: {}, stateDir, mode,
    permissions: { approval, filesystem: 'workspace', unattended: 'wait' },
    permissionMode: { fleetMode: approval, nativeMode: approval === 'allow' ? 'never' : 'untrusted' },
    model: 'gpt-fixture', effort: 'medium',
    approvalPolicy: approval === 'allow' ? 'never' : 'untrusted', sandbox: 'workspace-write',
    log: () => {},
  }, fakeTransport);

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
};

describe('CodexAppServerSession', () => {
  it('runs a native turn, preserves final phase, and persists its thread id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-native-'));
    try {
      const session = await start(dir);
      const result = await session.submitPrompt('hello native');
      expect(result).toMatchObject({ accepted: true, outcome: 'completed', output: 'native final' });
      expect(session.backend).toBe('codex-app-server');
      expect(session.capabilities).toMatchObject({ steering: true, messagePhases: true });
      expect(session.eventsSince(0).find(event => event.kind === 'agent_text'))
        .toMatchObject({ text: 'native final', messagePhase: 'final_answer' });
      expect(session.conversationPage({ limit: 100 }).events.map(event => event.kind))
        .toEqual(expect.arrayContaining(['prompt.admitted', 'prompt.started', 'message.chunk', 'turn.completed']));
      expect(readFileSync(join(dir, '.session-id'), 'utf8').trim())
        .toBe('thread-native-1');
      await session.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resumes the persisted native thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-resume-'));
    try {
      const fresh = await start(dir);
      await fresh.close();
      const resumed = await start(dir, 'resume');
      expect(resumed.snapshot().sessionId).toBe('thread-native-1');
      expect((await resumed.submitPrompt('after resume')).succeeded).toBe(true);
      await resumed.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('maps native approval requests into the neutral permission lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-permission-'));
    try {
      const session = await start(dir, 'fresh', 'ask');
      session.setControllerAttached(true);
      const queued = await session.queuePrompt('please request permission');
      await waitFor(() => session.eventsSince(0).some(event =>
        event.kind === 'permission' && event.status === 'pending'));
      const pending = session.eventsSince(0).find(event =>
        event.kind === 'permission' && event.status === 'pending')!;
      expect(session.snapshot().readiness).toBe('awaiting_permission');
      expect(session.respondPermission(pending.permissionId!, 'allow_once')).toBe(true);
      expect(await queued.completion).toMatchObject({
        succeeded: true, output: 'permission:accept',
      });
      expect(session.eventsSince(0).find(event =>
        event.kind === 'permission' && event.status === 'completed'))
        .toMatchObject({ decision: 'allowed', decisionSource: 'manual' });
      await session.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never auto-expands the native sandbox and maps explicit grants safely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-extra-permission-'));
    try {
      const session = await start(dir, 'fresh', 'allow');
      session.setControllerAttached(true);
      const queued = await session.queuePrompt('please request additional permission');
      await waitFor(() => session.eventsSince(0).some(event =>
        event.kind === 'permission' && event.status === 'pending'));
      const pending = session.eventsSince(0).find(event =>
        event.kind === 'permission' && event.status === 'pending')!;
      expect(session.respondPermission(pending.permissionId!, 'allow_once')).toBe(true);
      expect(await queued.completion).toMatchObject({
        succeeded: true, output: 'permission:scope:turn',
      });
      await session.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
