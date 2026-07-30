import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { CommonPermissions } from '../config.js';
import { SessionEvents } from './events.js';
import { turnResult } from './types.js';
import type {
  PermissionDecision, SessionEvent, SessionHandle, SessionSnapshot, TurnOutcome, TurnResult,
} from './types.js';

interface PendingPermission {
  options: Array<{ optionId: string; kind: string }>;
  resolve(response: acp.RequestPermissionResponse): void;
}

export interface AcpSessionOptions {
  name: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stateDir: string;
  mode: 'fresh' | 'resume';
  permissions: CommonPermissions;
  log(line: string): void;
}

/**
 * Classify an ACP `stopReason` into a terminal outcome. A refusal and a
 * cancellation are the two ways a delivered prompt ends without being carried
 * out; every other stop reason ran the turn to an end the agent chose.
 */
export function classifyStopReason(stopReason: string | undefined): TurnOutcome {
  switch (stopReason) {
    case 'refusal': return 'refused';
    case 'cancelled': return 'cancelled';
    default: return 'completed';
  }
}

/**
 * Persistent ACP v1 client. It is the sole owner of the agent's stdio; all
 * human/automation attachment happens through the fleet role-control protocol.
 */
export class AcpSession implements SessionHandle {
  readonly backend = 'acp' as const;
  readonly pid: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events: SessionEvents;
  private readonly sessionFile: string;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private connection: acp.ClientConnection;
  private sessionId?: string;
  private readiness: SessionSnapshot['readiness'] = 'starting';
  private lastError?: string;
  private promptTail: Promise<unknown> = Promise.resolve();
  private capabilities?: acp.AgentCapabilities;
  private controllerCount = 0;

  private constructor(
    private readonly options: AcpSessionOptions,
    child: ChildProcessWithoutNullStreams,
    connection: acp.ClientConnection,
  ) {
    this.child = child;
    this.connection = connection;
    this.pid = child.pid ?? -1;
    this.events = new SessionEvents(join(options.stateDir, '.session-events.jsonl'));
    this.sessionFile = join(options.stateDir, '.acp-session-id');
    child.stderr.on('data', chunk => options.log(`[${options.name}] acp: ${String(chunk).trimEnd()}`));
    child.once('exit', (code, signal) => {
      if (this.readiness !== 'failed') {
        this.readiness = 'failed';
        this.lastError = `ACP agent exited (${code ?? signal ?? 'unknown'})`;
      }
      this.events.emit('state', { status: 'failed', text: this.lastError });
    });
  }

  static async start(options: AcpSessionOptions): Promise<AcpSession> {
    if (!options.argv.length) throw new Error('ACP agent command is empty');
    const child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    let instance: AcpSession | undefined;
    const app = acp.client({ name: 'ours-fleet' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        instance?.recordUpdate(params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        if (!instance) return { outcome: { outcome: 'cancelled' as const } };
        return instance.requestPermission(params);
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    instance = new AcpSession(options, child, connection);
    try {
      await instance.initialize();
      return instance;
    } catch (error) {
      instance.fail(error);
      await instance.close();
      throw error;
    }
  }

  isAlive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  snapshot(): SessionSnapshot {
    return {
      backend: 'acp',
      alive: this.isAlive(),
      readiness: this.readiness,
      sessionId: this.sessionId,
      lastError: this.lastError,
      pendingPermissionId: this.pendingPermissions.keys().next().value as string | undefined,
    };
  }

  submitPrompt(text: string): Promise<TurnResult> {
    const operation = this.promptTail.then(() => this.runPrompt(text));
    this.promptTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId) return;
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  respondPermission(permissionId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    const chosen = pending?.options.find(option => option.optionId === optionId);
    if (!pending || !chosen) return false;
    this.pendingPermissions.delete(permissionId);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    this.events.emit('permission', {
      permissionId,
      status: 'completed',
      decision: chosen.kind.startsWith('reject') ? 'denied' : 'allowed',
      decisionSource: 'manual',
      reason: `answered from an attached controller (${chosen.kind})`,
      optionId,
    });
    this.readiness = 'running';
    return true;
  }

  eventsSince(seq: number): SessionEvent[] {
    return this.events.since(seq);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  setControllerAttached(attached: boolean): void {
    this.controllerCount = Math.max(0, this.controllerCount + (attached ? 1 : -1));
  }

  async close(): Promise<void> {
    for (const pending of this.pendingPermissions.values())
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermissions.clear();
    if (this.sessionId && this.capabilities?.sessionCapabilities?.close != null) {
      await this.connection.agent.request(
        acp.methods.agent.session.close, { sessionId: this.sessionId }).catch(() => undefined);
    }
    this.connection.close();
    if (this.isAlive()) this.child.kill('SIGTERM');
  }

  private async initialize(): Promise<void> {
    const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'ours-fleet', version: '1' },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new Error(
        `ACP protocol mismatch: agent selected ${initialized.protocolVersion}, client supports ${acp.PROTOCOL_VERSION}`);
    this.capabilities = initialized.agentCapabilities;

    const persisted = this.options.mode === 'resume' && existsSync(this.sessionFile)
      ? readFileSync(this.sessionFile, 'utf8').trim()
      : '';
    if (persisted && this.capabilities?.sessionCapabilities?.resume != null) {
      await this.connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: persisted,
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = persisted;
    } else if (persisted && this.capabilities?.loadSession) {
      await this.connection.agent.request(acp.methods.agent.session.load, {
        sessionId: persisted,
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = persisted;
    } else {
      const created = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = created.sessionId;
    }
    writeFileSync(this.sessionFile, this.sessionId + '\n', { mode: 0o600 });
    this.readiness = 'idle';
    this.events.emit('state', { status: 'idle', text: `ACP session ${this.sessionId}` });
  }

  private async runPrompt(text: string): Promise<TurnResult> {
    if (!this.sessionId || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is offline');
    this.readiness = 'running';
    const turnId = randomUUID();
    this.events.emit('state', { turnId, status: 'running' });
    try {
      const response = await this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      this.readiness = 'idle';
      this.events.emit('turn_stop', { turnId, stopReason: response.stopReason });
      this.events.emit('state', { status: 'idle' });
      // The prompt was accepted either way — the agent answered. Whether the
      // turn SUCCEEDED is a separate question, and only `stopReason` answers it.
      return turnResult(true, classifyStopReason(response.stopReason), response.stopReason);
    } catch (error) {
      this.lastError = (error as Error)?.message ?? String(error);
      this.readiness = this.isAlive() ? 'idle' : 'failed';
      this.events.emit('error', { turnId, text: this.lastError });
      if (this.isAlive()) this.events.emit('state', { status: 'idle' });
      return turnResult(false, 'failed', this.lastError);
    }
  }

  private requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    // `kinds` is a PRIORITY order. Scanning the agent's option array instead
    // (`options.find(o => kinds.includes(o.kind))`) hands the choice to whatever
    // order the agent happened to list, which is exactly how an automatic denial
    // could land on `reject_always`.
    const choose = (kinds: string[]) => {
      for (const kind of kinds) {
        const option = params.options.find(o => o.kind === kind);
        if (option) return option;
      }
      return undefined;
    };
    if (this.options.permissions.approval === 'allow' && this.withinAutomaticBoundary(params)) {
      const option = choose(['allow_always', 'allow_once']);
      return Promise.resolve(this.settleAutomatically(params, option, 'allowed',
        'permissions.approval=allow',
        `the request is inside the ${this.options.permissions.filesystem} boundary`));
    }
    const unattended = this.controllerCount === 0 && this.options.permissions.unattended === 'deny';
    if (this.options.permissions.approval === 'deny' || unattended) {
      // reject_once FIRST: `reject_always` teaches the agent a standing rule from
      // a decision no human made, so one unattended denial would silently disable
      // the tool for the rest of the session.
      const option = choose(['reject_once', 'reject_always']);
      return Promise.resolve(this.settleAutomatically(params, option, 'denied',
        unattended ? 'permissions.unattended=deny' : 'permissions.approval=deny',
        unattended
          ? 'no controller is attached, so the request cannot be shown to anyone'
          : 'the role denies every permission request by policy'));
    }

    const permissionId = randomUUID();
    this.readiness = 'awaiting_permission';
    this.events.emit('permission', {
      permissionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? 'Permission requested',
      status: 'pending',
      options: params.options.map(option => ({
        optionId: option.optionId, name: option.name, kind: option.kind,
      })),
    });
    return new Promise(resolve => {
      this.pendingPermissions.set(permissionId, { options: params.options, resolve });
    });
  }

  /**
   * Resolve a permission request from policy alone and leave a record of it.
   * Nothing else in the system can observe an automatic decision, so an
   * unrecorded one is indistinguishable from a request that was never made.
   */
  private settleAutomatically(
    params: acp.RequestPermissionRequest,
    option: { optionId: string; name: string; kind: string } | undefined,
    decision: PermissionDecision,
    policy: string,
    reason: string,
  ): acp.RequestPermissionResponse {
    const settled: PermissionDecision = option ? decision : 'cancelled';
    this.events.emit('permission', {
      permissionId: randomUUID(),
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? 'Permission requested',
      status: 'completed',
      decision: settled,
      decisionSource: 'automatic',
      policy,
      reason: option ? reason : `${reason}, but the agent offered no matching option`,
      optionId: option?.optionId,
      options: params.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    });
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  private withinAutomaticBoundary(params: acp.RequestPermissionRequest): boolean {
    const filesystem = this.options.permissions.filesystem;
    if (filesystem === 'unrestricted') return true;
    if (filesystem === 'read-only' && params.toolCall.kind !== 'read') return false;
    const locations = params.toolCall.locations ?? [];
    if (locations.length === 0) return false;
    const cwd = resolve(this.options.cwd);
    return locations.every(location => {
      const path = resolve(location.path);
      const rel = relative(cwd, path);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  }

  private recordUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.events.emit('agent_text', {
          text: update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
        });
        break;
      case 'agent_thought_chunk':
        this.events.emit('thought', {
          text: update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
        });
        break;
      case 'tool_call':
        this.events.emit('tool_call', {
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
        });
        break;
      case 'tool_call_update':
        this.events.emit('tool_update', {
          toolCallId: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? undefined,
        });
        break;
      default:
        break;
    }
  }

  private fail(error: unknown): void {
    this.lastError = (error as Error)?.message ?? String(error);
    this.readiness = 'failed';
    this.events.emit('error', { text: this.lastError });
  }
}
