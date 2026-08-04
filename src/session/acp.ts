import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { CommonPermissions } from '../config.js';
import { SessionEvents } from './events.js';
import { SessionControlError, classifyChildExit, turnResult } from './types.js';
import type {
  ExitRecord, PermissionDecision, QueuedPrompt, SessionEvent, SessionHandle, SessionSnapshot,
  SubmitPromptOptions, TurnCancellationSource, TurnOutcome, TurnResult,
} from './types.js';

interface PendingPermission {
  options: Array<{ optionId: string; kind: string }>;
  resolve(response: acp.RequestPermissionResponse): void;
}

interface SteeringResponse {
  outcome: 'injected' | 'startedNewTurn' | 'failed';
}

const CANCEL_SETTLE_GRACE_MS = 15_000;

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
  private queueDepth = 0;
  private exit: ExitRecord | null = null;
  private steeringSupported = false;
  private capabilities?: acp.AgentCapabilities;
  private controllerCount = 0;
  private cancelEscalation?: ReturnType<typeof setTimeout>;
  private activeTurn?: {
    id: string; output: string; origin?: SubmitPromptOptions['origin'];
    cancellationSource?: TurnCancellationSource;
  };

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
      // Record the child's real exit code/signal. The tmux path can only see a
      // shell's `$?`; here the truth is available, so keep it.
      this.exit = classifyChildExit(code, signal);
      options.log(`[${options.name}] acp: agent exited (${code ?? signal ?? 'unknown'})`);
      if (this.readiness !== 'failed') {
        this.readiness = 'failed';
        this.lastError = `ACP agent ${this.exit.detail}`;
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

  /**
   * Accept responsibility for a prompt, then return. The turn itself may run
   * for minutes behind other queued turns; making an interactive caller wait
   * for it is what turned a busy agent into a timeout and then into "dead".
   */
  async queuePrompt(text: string, options: SubmitPromptOptions = {}): Promise<QueuedPrompt> {
    if (!this.sessionId || !this.isAlive())
      throw new SessionControlError('offline', this.lastError ?? 'ACP session is offline');
    if (options.interrupt) await this.cancelActive(options.interruptSource ?? 'local-console');
    // Interrupting delivery must still use steering when supported. With no
    // live turn, the extension starts one and acknowledges `startedNewTurn`
    // immediately; a normal session/prompt would keep the monitor blocked until
    // the entire wake-triggered turn terminated.
    if (options.steer && this.steeringSupported) {
      const promptId = randomUUID();
      return { promptId, queuedBehind: 0, completion: this.steerPrompt(text), origin: options.origin };
    }
    const promptId = randomUUID();
    const queuedBehind = this.queueDepth++;
    const run = this.promptTail.then(() => this.runPrompt(text, promptId, options.origin));
    this.promptTail = run.then(() => undefined, () => undefined);
    const completion = run.then(
      result => { this.queueDepth = Math.max(0, this.queueDepth - 1); return result; },
      error => {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
        return turnResult(false, 'failed', (error as Error)?.message ?? String(error));
      },
    );
    return { promptId, queuedBehind, completion, origin: options.origin };
  }

  async submitPrompt(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
    try {
      return await (await this.queuePrompt(text, options)).completion;
    } catch (error) {
      if (error instanceof SessionControlError) return turnResult(false, 'failed', error.message);
      throw error;
    }
  }

  async interrupt(source: TurnCancellationSource = 'local-console'): Promise<void> {
    await this.cancelActive(source);
  }

  private async cancelActive(source: TurnCancellationSource): Promise<void> {
    if (!this.sessionId) return;
    const active = this.activeTurn;
    const previousSource = active?.cancellationSource;
    if (active && (source === 'owner' || source === 'local-console' || !previousSource))
      active.cancellationSource = source;
    try {
      await this.connection.agent.notify(
        acp.methods.agent.session.cancel, { sessionId: this.sessionId });
    } catch (error) {
      if (this.activeTurn === active && active?.cancellationSource === source)
        active.cancellationSource = previousSource;
      throw error;
    }
    if (active) {
      if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
      const turnId = active.id;
      this.cancelEscalation = setTimeout(() => {
        if (this.activeTurn?.id !== turnId || !this.isAlive()) return;
        this.lastError = 'ACP turn ignored cancellation; restarting adapter';
        this.options.log(`[${this.options.name}] ${this.lastError}`);
        this.events.emit('error', { turnId, origin: active.origin, text: this.lastError });
        this.child.kill('SIGTERM');
      }, CANCEL_SETTLE_GRACE_MS);
      this.cancelEscalation.unref?.();
    }
    for (const pending of this.pendingPermissions.values())
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermissions.clear();
  }

  respondPermission(permissionId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    const chosen = pending?.options.find(option => option.optionId === optionId);
    if (!pending || !chosen) return false;
    this.pendingPermissions.delete(permissionId);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    this.events.emit('permission', {
      turnId: this.activeTurn?.id,
      origin: this.activeTurn?.origin,
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

  exitResult(): ExitRecord | null {
    return this.exit;
  }

  async close(): Promise<void> {
    if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
    this.cancelEscalation = undefined;
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
    const steering = initialized._meta?.steering;
    this.steeringSupported = steering !== null && typeof steering === 'object'
      && (steering as { supported?: unknown }).supported === true;

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

  private async runPrompt(
    text: string, turnId: string = randomUUID(), origin?: SubmitPromptOptions['origin'],
  ): Promise<TurnResult> {
    if (!this.sessionId || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is offline');
    this.readiness = 'running';
    this.activeTurn = { id: turnId, output: '', origin };
    this.events.emit('state', { turnId, status: 'running', origin });
    try {
      const response = await this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      this.readiness = 'idle';
      this.events.emit('turn_stop', {
        turnId, stopReason: response.stopReason, origin,
        cancellationSource: this.activeTurn?.id === turnId
          ? this.activeTurn.cancellationSource : undefined,
      });
      this.events.emit('state', { status: 'idle' });
      // The prompt was accepted either way — the agent answered. Whether the
      // turn SUCCEEDED is a separate question, and only `stopReason` answers it.
      return turnResult(
        true, classifyStopReason(response.stopReason), response.stopReason,
        this.activeTurn?.id === turnId ? this.activeTurn.output : undefined,
        this.activeTurn?.id === turnId ? this.activeTurn.cancellationSource : undefined);
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.lastError = origin?.kind === 'scheduled-loop' ? 'scheduled-loop turn failed' : detail;
      this.readiness = this.isAlive() ? 'idle' : 'failed';
      this.events.emit('error', {
        turnId, origin,
        text: origin?.kind === 'scheduled-loop' ? 'scheduled-loop turn failed' : this.lastError,
      });
      if (this.isAlive()) this.events.emit('state', { status: 'idle' });
      return turnResult(
        false, 'failed', this.lastError,
        this.activeTurn?.id === turnId ? this.activeTurn.output : undefined);
    } finally {
      if (this.activeTurn?.id === turnId) {
        if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
        this.cancelEscalation = undefined;
        this.activeTurn = undefined;
      }
    }
  }

  private async steerPrompt(text: string): Promise<TurnResult> {
    if (!this.sessionId || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is offline');
    try {
      const response = await this.connection.agent.request<SteeringResponse, {
        sessionId: string;
        prompt: Array<{ type: 'text'; text: string }>;
      }>('_session/steering', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      if (response.outcome === 'failed')
        return turnResult(false, 'failed', 'ACP steering failed');
      return turnResult(true, 'inconclusive', response.outcome);
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.lastError = detail;
      this.events.emit('error', { text: detail });
      return turnResult(false, 'failed', detail);
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
      turnId: this.activeTurn?.id,
      origin: this.activeTurn?.origin,
      permissionId,
      toolCallId: this.activeTurn?.origin?.kind === 'scheduled-loop'
        ? 'scheduled-loop-tool' : params.toolCall.toolCallId,
      title: this.activeTurn?.origin?.kind === 'scheduled-loop'
        ? 'Scheduled-loop permission requested' : params.toolCall.title ?? 'Permission requested',
      status: 'pending',
      options: params.options.map(option => ({
        optionId: option.optionId,
        name: this.activeTurn?.origin?.kind === 'scheduled-loop' ? option.kind : option.name,
        kind: option.kind,
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
      turnId: this.activeTurn?.id,
      origin: this.activeTurn?.origin,
      permissionId: randomUUID(),
      toolCallId: this.activeTurn?.origin?.kind === 'scheduled-loop'
        ? 'scheduled-loop-tool' : params.toolCall.toolCallId,
      status: 'completed',
      decision: settled,
      decisionSource: 'automatic',
      policy,
      reason: option ? reason : `${reason}, but the agent offered no matching option`,
      optionId: option?.optionId,
      title: this.activeTurn?.origin?.kind === 'scheduled-loop'
        ? 'Scheduled-loop permission requested' : params.toolCall.title ?? 'Permission requested',
      options: params.options.map(o => ({
        optionId: o.optionId,
        name: this.activeTurn?.origin?.kind === 'scheduled-loop' ? o.kind : o.name,
        kind: o.kind,
      })),
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
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (this.activeTurn && update.content.type === 'text')
          this.activeTurn.output += update.content.text;
        this.events.emit('agent_text', {
          turnId: this.activeTurn?.id,
          origin: this.activeTurn?.origin,
          text: scheduled ? '[scheduled-loop output redacted]'
            : update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
        });
        break;
      case 'agent_thought_chunk':
        this.events.emit('thought', {
          turnId: this.activeTurn?.id,
          origin: this.activeTurn?.origin,
          text: scheduled ? '[scheduled-loop thought redacted]'
            : update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
        });
        break;
      case 'tool_call':
        this.events.emit('tool_call', {
          turnId: this.activeTurn?.id,
          origin: this.activeTurn?.origin,
          toolCallId: scheduled ? 'scheduled-loop-tool' : update.toolCallId,
          title: scheduled ? 'scheduled-loop tool' : update.title,
          status: update.status,
        });
        break;
      case 'tool_call_update':
        this.events.emit('tool_update', {
          turnId: this.activeTurn?.id,
          origin: this.activeTurn?.origin,
          toolCallId: scheduled ? 'scheduled-loop-tool' : update.toolCallId,
          title: scheduled ? 'scheduled-loop tool' : update.title ?? undefined,
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
