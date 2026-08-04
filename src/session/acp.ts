import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { CommonPermissions } from '../config.js';
import { normalizeSessionUpdate } from './conversation-normalizer.js';
import { ConversationEventStore, IdempotencyConflictError } from './conversation-store.js';
import type {
  ConversationSnapshot, ConversationSource, PromptOrigin, PromptReceipt, SubmitPromptCommand,
} from './conversation-types.js';
import { SessionEvents } from './events.js';
import { SessionControlError, classifyChildExit, turnResult } from './types.js';
import type {
  ConversationHandlePage, ExitRecord, PermissionDecision, QueuedPrompt, SessionEvent,
  SessionHandle, SessionSnapshot, SubmitPromptOptions, TurnCancellationSource, TurnOutcome,
  TurnResult,
} from './types.js';

interface PendingPermission {
  options: Array<{ optionId: string; kind: string }>;
  resolve(response: acp.RequestPermissionResponse): void;
}

interface SteeringResponse {
  outcome: 'injected' | 'startedNewTurn' | 'failed';
}

const CANCEL_SETTLE_GRACE_MS = 15_000;

const SCHEDULED_LOOP_REDACTION = '[scheduled-loop content redacted]';

const scheduledTurn = (turn: { origin?: PromptOrigin } | undefined): boolean =>
  turn?.origin?.kind === 'scheduled-loop';

/**
 * Map typed prompt provenance to the conversation ledger's source vocabulary.
 * Only operator-authored local sources may persist prompt bodies; external
 * E2E bodies (owner channel, monitor wakes) and scheduled-loop content are
 * recorded as digest/size placeholders (spec §8.3).
 */
function conversationSource(origin: PromptOrigin | undefined): {
  source: ConversationSource; persistBody: boolean;
} {
  switch (origin?.kind) {
    case 'browser': return { source: 'browser', persistBody: true };
    case 'startup': return { source: 'startup', persistBody: true };
    case 'owner': return { source: 'owner_channel', persistBody: false };
    case 'fleet-monitor': return { source: 'fleet_monitor', persistBody: false };
    case 'scheduled-loop': return { source: 'scheduled_loop', persistBody: false };
    case 'local-console':
    default:
      return { source: 'local_console', persistBody: true };
  }
}

export interface AcpSessionOptions {
  name: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stateDir: string;
  mode: 'fresh' | 'resume';
  permissions: CommonPermissions;
  /** Native permission-mode id to request via session/set_mode; undefined keeps the agent default. */
  modeId?: string;
  log(line: string): void;
  /** Test seam for the cancel-escalation grace period; production uses the default. */
  cancelGraceMs?: number;
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
  private readonly conversation: ConversationEventStore;
  /** New on every runner start; permission/turn IDs from prior generations are stale. */
  private readonly sessionGeneration = randomUUID();
  /** True while `session/load` replays history as ordinary updates. */
  private replaying = false;
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
    this.conversation = new ConversationEventStore(join(options.stateDir, '.conversation'), {
      roleId: options.name, log: line => options.log(`[${options.name}] ${line}`),
    });
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
      this.conversation.appendSafe({
        kind: 'session.state', sessionGeneration: this.sessionGeneration,
        acpSessionId: this.sessionId,
        payload: { status: 'failed', detail: this.lastError },
      });
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
      instance.recoverOpenPrompts();
      return instance;
    } catch (error) {
      instance.fail(error);
      await instance.close();
      throw error;
    }
  }

  /**
   * Honest restart recovery (spec §5.3): a prompt that was admitted but never
   * started is safe to dispatch again; a turn that had already started may
   * have caused side effects, so it is closed as `unknown_after_restart` —
   * never silently replayed.
   */
  private recoverOpenPrompts(): void {
    for (const open of this.conversation.openPrompts()) {
      if (open.sessionGeneration === this.sessionGeneration) continue;
      if (open.state === 'started') {
        this.conversation.appendSafe({
          kind: 'turn.completed', sessionGeneration: this.sessionGeneration,
          promptId: open.promptId, turnId: open.promptId,
          payload: { outcome: 'unknown_after_restart' },
        });
        continue;
      }
      if (open.text === undefined) {
        // Admitted, never started, and the body was deliberately not retained
        // (external E2E source): there is nothing faithful left to dispatch.
        this.conversation.appendSafe({
          kind: 'turn.completed', sessionGeneration: this.sessionGeneration,
          promptId: open.promptId, turnId: open.promptId,
          payload: { outcome: 'failed', stopReason: 'prompt-body-not-retained' },
        });
        continue;
      }
      const text = open.text;
      const promptId = open.promptId;
      this.queueDepth++;
      const run = this.promptTail.then(() => this.runPrompt(text, promptId));
      this.promptTail = run.then(() => undefined, () => undefined);
      void run.finally(() => { this.queueDepth = Math.max(0, this.queueDepth - 1); });
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
    const queuedBehind = this.queueDepth;
    this.admitToLedger(promptId, text, queuedBehind, options);
    this.queueDepth++;
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

  /**
   * Durably record a prompt admission BEFORE acceptance is returned. Browser
   * admissions are transactional — a prompt the ledger cannot hold is refused,
   * because an acknowledged-then-lost prompt is worse than an error. Every
   * other source degrades to best-effort so the agent keeps working (§5.3).
   */
  private admitToLedger(
    promptId: string, text: string, queuedBehind: number, options: SubmitPromptOptions,
  ): void {
    const { source, persistBody } = conversationSource(options.origin);
    const bytes = Buffer.byteLength(text);
    const draft = {
      kind: 'prompt.admitted' as const,
      sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId,
      promptId, turnId: promptId, source,
      ...(options.origin?.kind === 'browser' ? { commandId: options.origin.commandId } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      payload: {
        queuedBehind,
        ...(persistBody
          ? { text: { type: 'text' as const, text, bytes } }
          : { external: { digest: ConversationEventStore.bodyDigest(text), bytes } }),
      },
    };
    if (source === 'browser') {
      try { this.conversation.append(draft); }
      catch (error) {
        throw new SessionControlError('backend',
          `conversation store cannot record the prompt: ${(error as Error).message}`);
      }
    } else {
      this.conversation.appendSafe(draft);
    }
  }

  /** Idempotent browser prompt admission (control v3 `submit_prompt_v2`). */
  async submitPromptBrowser(command: SubmitPromptCommand): Promise<PromptReceipt> {
    const bodyDigest = ConversationEventStore.bodyDigest(command.text);
    const existing = this.conversation.receiptFor(command.commandId, bodyDigest);
    if (existing) return existing;
    const queued = await this.queuePrompt(command.text, {
      origin: { kind: 'browser', commandId: command.commandId },
      actor: { browserSession: command.actorBrowserSession },
    });
    const receipt: PromptReceipt = {
      commandId: command.commandId,
      promptId: queued.promptId,
      state: queued.queuedBehind > 0 ? 'queued' : 'starting',
      queuedBehind: queued.queuedBehind,
      acceptedAt: new Date().toISOString(),
      eventCursor: this.conversation.lastCursor() ?? '0',
    };
    this.conversation.recordReceipt(command.commandId, receipt, bodyDigest);
    return receipt;
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
      this.conversation.appendSafe({
        kind: 'prompt.interrupt_requested', sessionGeneration: this.sessionGeneration,
        acpSessionId: this.sessionId, promptId: active.id, turnId: active.id,
        payload: { cancellationSource: source },
      });
      if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
      const turnId = active.id;
      this.cancelEscalation = setTimeout(() => {
        if (this.activeTurn?.id !== turnId || !this.isAlive()) return;
        this.lastError = 'ACP turn ignored cancellation; restarting adapter';
        this.options.log(`[${this.options.name}] ${this.lastError}`);
        this.events.emit('error', { turnId, origin: active.origin, text: this.lastError });
        this.child.kill('SIGTERM');
      }, this.options.cancelGraceMs ?? CANCEL_SETTLE_GRACE_MS);
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
    const decision = chosen.kind.startsWith('reject') ? 'denied' : 'allowed';
    this.events.emit('permission', {
      turnId: this.activeTurn?.id,
      origin: this.activeTurn?.origin,
      permissionId,
      status: 'completed',
      decision,
      decisionSource: 'manual',
      reason: `answered from an attached controller (${chosen.kind})`,
      optionId,
    });
    this.conversation.appendSafe({
      kind: 'permission.resolved', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, permissionId,
      promptId: this.activeTurn?.id, turnId: this.activeTurn?.id,
      payload: { decision, decisionSource: 'manual', optionId },
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
    this.conversation.appendSafe({
      kind: 'session.state', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, payload: { status: 'offline' },
    });
    this.conversation.close();
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
      // `session/load` replays prior history as ordinary updates before the
      // response; those records carry `agent_replay` provenance, never `agent`.
      this.replaying = true;
      try {
        await this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: persisted,
          cwd: this.options.cwd,
          mcpServers: [],
        });
      } finally { this.replaying = false; }
      this.sessionId = persisted;
    } else {
      const created = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = created.sessionId;
    }
    writeFileSync(this.sessionFile, this.sessionId + '\n', { mode: 0o600 });
    // Deliver the configured permission mode whichever way the session came up
    // (new, resume or load) — the launch flag never reaches an ACP agent. A
    // refusal is loud but never fatal: the session then simply runs at the
    // agent's own default.
    if (this.options.modeId) {
      try {
        await this.connection.agent.request(acp.methods.agent.session.setMode, {
          sessionId: this.sessionId,
          modeId: this.options.modeId,
        });
      } catch (e) {
        this.options.log(
          `[${this.options.name}] acp: session/set_mode "${this.options.modeId}" failed ` +
          `(${e instanceof Error ? e.message : String(e)}) — session runs at the agent default permission mode`);
      }
    }
    this.readiness = 'idle';
    this.events.emit('state', { status: 'idle', text: `ACP session ${this.sessionId}` });
    this.conversation.appendSafe({
      kind: 'session.state', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, payload: { status: 'idle' },
    });
  }

  private async runPrompt(
    text: string, turnId: string = randomUUID(), origin?: SubmitPromptOptions['origin'],
  ): Promise<TurnResult> {
    if (!this.sessionId || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is offline');
    this.readiness = 'running';
    this.activeTurn = { id: turnId, output: '', origin };
    this.events.emit('state', { turnId, status: 'running', origin });
    this.conversation.appendSafe({
      kind: 'prompt.started', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, promptId: turnId, turnId,
      source: conversationSource(origin).source, payload: {},
    });
    try {
      const response = await this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      this.readiness = 'idle';
      const cancellationSource = this.activeTurn?.id === turnId
        ? this.activeTurn.cancellationSource : undefined;
      this.events.emit('turn_stop', {
        turnId, stopReason: response.stopReason, origin, cancellationSource,
      });
      this.events.emit('state', { status: 'idle' });
      this.conversation.appendSafe({
        kind: 'turn.completed', sessionGeneration: this.sessionGeneration,
        acpSessionId: this.sessionId, promptId: turnId, turnId,
        payload: {
          outcome: classifyStopReason(response.stopReason),
          stopReason: response.stopReason,
          ...(cancellationSource ? { cancellationSource } : {}),
        },
      });
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
      this.conversation.appendSafe({
        kind: 'turn.completed', sessionGeneration: this.sessionGeneration,
        acpSessionId: this.sessionId, promptId: turnId, turnId,
        payload: { outcome: 'failed', stopReason: this.lastError },
      });
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
    this.conversation.appendSafe({
      kind: 'permission.requested', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, permissionId,
      promptId: this.activeTurn?.id, turnId: this.activeTurn?.id,
      toolCallId: scheduledTurn(this.activeTurn) ? 'scheduled-loop-tool' : params.toolCall.toolCallId,
      payload: {
        toolCallId: scheduledTurn(this.activeTurn) ? 'scheduled-loop-tool' : params.toolCall.toolCallId,
        title: scheduledTurn(this.activeTurn)
          ? 'Scheduled-loop permission requested' : params.toolCall.title ?? 'Permission requested',
        options: params.options.map(option => ({
          optionId: option.optionId,
          name: scheduledTurn(this.activeTurn) ? option.kind : option.name,
          kind: option.kind,
        })),
      },
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
    this.conversation.appendSafe({
      kind: 'permission.resolved', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, permissionId: randomUUID(),
      promptId: this.activeTurn?.id, turnId: this.activeTurn?.id,
      toolCallId: scheduledTurn(this.activeTurn) ? 'scheduled-loop-tool' : params.toolCall.toolCallId,
      payload: {
        decision: settled,
        decisionSource: 'automatic', policy, reason,
        ...(option ? { optionId: option.optionId } : {}),
      },
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
    this.recordConversationUpdate(update, scheduled);
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

  /** Normalize every ACP update losslessly into the durable ledger. */
  private recordConversationUpdate(update: acp.SessionUpdate, scheduled: boolean): void {
    const normalized = normalizeSessionUpdate(update,
      scheduled ? { redactText: SCHEDULED_LOOP_REDACTION } : {});
    this.conversation.appendSafe({
      kind: normalized.kind,
      sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId,
      ...(this.activeTurn ? { promptId: this.activeTurn.id, turnId: this.activeTurn.id } : {}),
      ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
      ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
      source: this.replaying ? 'agent_replay' : 'agent',
      payload: normalized.payload,
      ...(normalized.adapterMeta ? { adapterMeta: normalized.adapterMeta } : {}),
    });
  }

  // ── conversation ledger access (SessionHandle) ─────────────────────────────

  conversationPage(request: { after?: string; limit?: number } = {}): ConversationHandlePage {
    return { ...this.conversation.page(request), snapshot: this.conversationSnapshot() };
  }

  conversationSnapshot(): ConversationSnapshot {
    return {
      sessionGeneration: this.sessionGeneration,
      readiness: this.isAlive() ? this.readiness : 'offline',
      queueDepth: this.queueDepth,
      pendingPermissionIds: [...this.pendingPermissions.keys()],
      ...(this.conversation.degraded ? { historyDegraded: true } : {}),
    };
  }

  subscribeConversation(listener: Parameters<ConversationEventStore['subscribe']>[0]): () => void {
    return this.conversation.subscribe(listener);
  }

  private fail(error: unknown): void {
    this.lastError = (error as Error)?.message ?? String(error);
    this.readiness = 'failed';
    this.events.emit('error', { text: this.lastError });
  }
}
