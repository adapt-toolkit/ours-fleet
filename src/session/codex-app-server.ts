import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { CommonPermissions } from '../config.js';
import { ConversationEventStore } from './conversation-store.js';
import type {
  ConversationEventV1, ConversationSnapshot, ConversationSource, PromptOrigin, PromptReceipt,
  SubmitPromptCommand,
} from './conversation-types.js';
import { SessionEvents } from './events.js';
import { CodexAppServerTransport } from './codex-app-server-transport.js';
import type {
  CodexAppServerConnection, CodexAppServerTransportFactory,
} from './codex-app-server-transport.js';
import {
  CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED, SessionControlError,
  sessionBackendCapabilities, turnResult,
} from './types.js';
import type {
  AgentSession, ConversationHandlePage, ExitRecord, InterruptOutcome, PermissionDecision,
  PromptDelivery, QueuedPrompt, RuntimeSelectorMetadata, SessionEvent, SessionSnapshot,
  SubmitPromptOptions, TurnCancellationSource, TurnOutcome, TurnResult,
} from './types.js';

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

const PERMISSION_TIMEOUT_MS = 10 * 60_000;
const CONTROLLER_GRACE_MS = 12_000;
const INTERRUPT_SETTLE_MS = 15_000;
const INTERRUPT_TERMINATE_GRACE_MS = 5_000;
const TERMINAL_RECONCILE_QUIET_MS = 2_000;
const TERMINAL_RECONCILE_REQUEST_TIMEOUT_MS = 5_000;
const SCHEDULED_REDACTION = '[scheduled-loop content redacted]';
const COMMENTARY_REDACTION = '[assistant commentary redacted]';
const OWNER_ADMIN_CONTEXT_KEY =
  'ours-fleet://prompt-provenance?source=owner_admin_console';
const OWNER_CHANNEL_CONTEXT_KEY =
  'ours-fleet://prompt-provenance?source=owner_channel';

export interface CodexAppServerSessionOptions {
  name: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stateDir: string;
  mode: 'fresh' | 'resume';
  permissions: CommonPermissions;
  permissionMode: NonNullable<SessionSnapshot['permissionMode']>;
  model?: string | null;
  effort?: string;
  approvalPolicy: string;
  sandbox: string;
  config?: Record<string, unknown>;
  addDirs?: string[];
  log(line: string): void;
  permissionTimeoutMs?: number;
  controllerGraceMs?: number;
  interruptSettleMs?: number;
  interruptTerminateGraceMs?: number;
  terminalReconcileQuietMs?: number;
  terminalReconcileRequestTimeoutMs?: number;
}

interface PendingPermission {
  requestId: RequestId;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval'
    | 'item/permissions/requestApproval';
  toolCallId: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  requestedPermissions?: JsonObject;
  expiry?: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  promptId: string;
  nativeTurnId?: string;
  origin?: PromptOrigin;
  output: string;
  cancellationSource?: TurnCancellationSource;
  settled: Promise<TurnResult>;
  settle(result: TurnResult): void;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function sourceFor(origin: PromptOrigin | undefined): {
  source: ConversationSource; persistBody: boolean;
} {
  switch (origin?.kind) {
    case 'owner-admin-console': return { source: 'owner_admin_console', persistBody: true };
    case 'startup': return { source: 'startup', persistBody: true };
    case 'owner': return { source: 'owner_channel', persistBody: false };
    case 'fleet-monitor': return { source: 'fleet_monitor', persistBody: false };
    case 'scheduled-loop': return { source: 'scheduled_loop', persistBody: false };
    case 'local-console':
    default: return { source: 'local_console', persistBody: true };
  }
}

function textBlock(text: string, replacement?: string) {
  const original = text;
  const bytes = Buffer.byteLength(original);
  if (replacement !== undefined) return {
    type: 'text' as const, text: replacement, bytes, redacted: true as const,
    digest: createHash('sha256').update(original).digest('hex').slice(0, 24),
  };
  const max = 256 * 1024;
  if (bytes <= max) return { type: 'text' as const, text, bytes };
  const retained = Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/u, '');
  return {
    type: 'text' as const, text: retained, bytes, truncated: true as const,
    digest: createHash('sha256').update(original).digest('hex').slice(0, 24),
  };
}

function outcomeFor(status: unknown): TurnOutcome {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'inconclusive';
}

/** Server-generated application provenance for authenticated browser prompts only. */
export function nativePromptAdditionalContext(
  origin: PromptOrigin | undefined,
): JsonObject | undefined {
  if (origin?.kind === 'owner-admin-console') return {
    [OWNER_ADMIN_CONTEXT_KEY]: {
      kind: 'application',
      value: 'Direct owner admin console: server-authenticated paired console provenance; '
        + 'the accompanying user text is direct owner input.',
    },
  };
  if (origin?.kind === 'owner') return {
    [OWNER_CHANNEL_CONTEXT_KEY]: {
      kind: 'application',
      value: 'Authenticated Fleet owner channel: the supervisor authenticated the sender CID; '
        + 'the accompanying user text is a direct owner instruction.',
    },
  };
  return undefined;
}

function toolItem(item: JsonObject): { title: string; status?: string } | undefined {
  switch (item.type) {
    case 'commandExecution': return {
      title: string(item.command) ?? 'Command execution', status: string(item.status),
    };
    case 'fileChange': return { title: 'File changes', status: string(item.status) };
    case 'mcpToolCall': return {
      title: `${string(item.server) ?? 'MCP'} / ${string(item.tool) ?? 'tool'}`,
      status: string(item.status),
    };
    case 'dynamicToolCall': return {
      title: string(item.tool) ?? 'Dynamic tool', status: string(item.status),
    };
    case 'collabAgentToolCall': return {
      title: `Agent ${string(item.tool) ?? 'collaboration'}`, status: string(item.status),
    };
    case 'webSearch': return { title: 'Web search', status: string(item.status) };
    case 'imageView': return { title: 'View image', status: string(item.status) };
    case 'imageGeneration': return { title: 'Generate image', status: string(item.status) };
    default: return undefined;
  }
}

/** Native Codex session implementing Fleet's provider-neutral live-session contract. */
export class CodexAppServerSession implements AgentSession {
  readonly backend = 'codex-app-server' as const;
  readonly capabilities = sessionBackendCapabilities('codex-app-server');
  readonly pid: number;

  private readonly events: SessionEvents;
  private readonly conversation: ConversationEventStore;
  private readonly conversationStartCursor?: string;
  private readonly sessionGeneration = randomUUID();
  private readonly threadFile: string;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly activeTools = new Set<string>();
  private readonly activeItems = new Set<string>();
  private readonly itemPhases = new Map<string, 'commentary' | 'final_answer'>();
  private readonly itemText = new Map<string, string>();
  private transport: CodexAppServerConnection;
  private threadId?: string;
  private readiness: SessionSnapshot['readiness'] = 'starting';
  private runtimeModel?: RuntimeSelectorMetadata;
  private reasoningEffort?: RuntimeSelectorMetadata;
  private lastUpdateAt?: string;
  private lastError?: string;
  private exit: ExitRecord | null = null;
  private queueDepth = 0;
  private promptTail: Promise<unknown> = Promise.resolve();
  private activeTurn?: ActiveTurn;
  private controllerCount = 0;
  private controllerGrace?: ReturnType<typeof setTimeout>;
  private interruptForceKill?: ReturnType<typeof setTimeout>;
  private terminalReconcile?: ReturnType<typeof setTimeout>;
  private terminalReconcileInFlight = false;
  private finalAnswerObserved = false;
  private closing = false;

  private constructor(
    private readonly options: CodexAppServerSessionOptions,
    transport: CodexAppServerConnection,
  ) {
    this.transport = transport;
    this.pid = transport.pid;
    this.events = new SessionEvents(join(options.stateDir, '.session-events.jsonl'));
    this.conversation = new ConversationEventStore(join(options.stateDir, '.conversation'), {
      roleId: options.name, log: line => options.log(`[${options.name}] ${line}`),
    });
    this.conversationStartCursor = this.conversation.lastCursor();
    // Use Fleet's provider-neutral resume marker so runner recovery rotates the
    // exact native thread id after a poisoned fast resume.
    this.threadFile = join(options.stateDir, '.session-id');
  }

  static async start(
    options: CodexAppServerSessionOptions,
    transportFactory: CodexAppServerTransportFactory = CodexAppServerTransport.start,
  ): Promise<CodexAppServerSession> {
    let instance: CodexAppServerSession | undefined;
    const env = { ...options.env };
    delete env.OURS_AUTOSTART;
    const transport = await transportFactory({
      name: options.name, argv: options.argv, cwd: options.cwd, env, log: options.log,
      onNotification: (method, params) => instance?.notification(method, params),
      onRequest: (method, id, params) => instance?.serverRequest(method, id, params),
      onExit: exit => instance?.transportExited(exit),
    });
    instance = new CodexAppServerSession(options, transport);
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

  isAlive(): boolean { return !this.closing && this.transport.isAlive(); }

  snapshot(): SessionSnapshot {
    return {
      backend: this.backend,
      alive: this.isAlive(),
      readiness: this.readiness,
      sessionId: this.threadId,
      lastError: this.lastError,
      pendingPermissionId: this.pendingPermissions.keys().next().value as string | undefined,
      runtimeModel: this.runtimeModel,
      reasoningEffort: this.reasoningEffort,
      permissionMode: this.options.permissionMode,
      activity: {
        activeToolCalls: this.activeTools.size,
        ...(this.lastUpdateAt ? { lastUpdateAt: this.lastUpdateAt } : {}),
      },
    };
  }

  async queuePrompt(text: string, options: SubmitPromptOptions = {}): Promise<QueuedPrompt> {
    if (this.closing || !this.threadId || !this.transport.isAlive())
      throw new SessionControlError('offline', this.lastError ?? 'Codex app-server session is offline');

    let delivery: PromptDelivery | undefined;
    if (options.interrupt && this.activeTurn) {
      const interrupted = await this.interrupt(options.interruptSource ?? 'local-console');
      if (interrupted.state === 'forced')
        throw new SessionControlError(
          'control-unavailable',
          'Codex app-server restart is in progress after the cancellation deadline',
          interrupted.reasonCode ?? CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED,
        );
      delivery = 'interrupted';
    }
    if (options.steer && this.activeTurn?.nativeTurnId) {
      const promptId = randomUUID();
      const completion = this.steer(text, this.activeTurn.nativeTurnId, options.origin);
      return { promptId, queuedBehind: 0, completion, origin: options.origin, delivery: 'started' };
    }

    const promptId = randomUUID();
    const queuedBehind = this.queueDepth;
    this.admit(promptId, text, queuedBehind, options);
    this.queueDepth++;
    const run = this.promptTail.then(() => this.runPrompt(text, promptId, options.origin));
    this.promptTail = run.then(() => undefined, () => undefined);
    const completion = run.then(result => {
      this.queueDepth = Math.max(0, this.queueDepth - 1);
      return result;
    }, error => {
      this.queueDepth = Math.max(0, this.queueDepth - 1);
      return turnResult(false, 'failed', error instanceof Error ? error.message : String(error));
    });
    return {
      promptId, queuedBehind, completion, origin: options.origin,
      delivery: delivery ?? (queuedBehind ? 'queued' : 'started'),
    };
  }

  async submitPrompt(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
    try { return await (await this.queuePrompt(text, options)).completion; }
    catch (error) {
      if (error instanceof SessionControlError) return turnResult(false, 'failed', error.message);
      throw error;
    }
  }

  async interrupt(source: TurnCancellationSource = 'local-console'): Promise<InterruptOutcome> {
    const active = this.activeTurn;
    if (!active || !this.threadId || !active.nativeTurnId) return { state: 'settled' };
    active.cancellationSource ??= source;
    this.events.emit('state', { turnId: active.promptId, status: 'running', origin: active.origin });
    this.conversation.appendSafe({
      kind: 'prompt.interrupt_requested', sessionGeneration: this.sessionGeneration,
      promptId: active.promptId, turnId: active.promptId,
      payload: { cancellationSource: source },
    });
    try {
      await this.transport.request('turn/interrupt', {
        threadId: this.threadId, turnId: active.nativeTurnId,
      }, 2_000);
    } catch (error) {
      // A terminal notification can win the race with the interrupt response.
      if (this.activeTurn !== active) return { state: 'settled' };
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      active.settled.then(() => true),
      new Promise<false>(resolveTimeout => {
        timer = setTimeout(
          () => resolveTimeout(false), this.options.interruptSettleMs ?? INTERRUPT_SETTLE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (settled) return { state: 'settled' };
    this.lastError = CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED;
    this.transport.child.kill('SIGTERM');
    this.clearInterruptForceKill();
    this.interruptForceKill = setTimeout(() => {
      this.interruptForceKill = undefined;
      if (this.activeTurn !== active || !this.transport.isAlive()) return;
      this.options.log(`[${this.options.name}] ${CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED}: `
        + 'app-server ignored SIGTERM; sending SIGKILL');
      this.transport.child.kill('SIGKILL');
    }, this.options.interruptTerminateGraceMs ?? INTERRUPT_TERMINATE_GRACE_MS);
    this.interruptForceKill.unref?.();
    return { state: 'forced', reasonCode: CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED };
  }

  respondPermission(permissionId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending || !pending.options.some(option => option.optionId === optionId)) return false;
    this.pendingPermissions.delete(permissionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    const decision = optionId === 'allow_once' ? 'accept'
      : optionId === 'allow_session' ? 'acceptForSession'
        : optionId === 'cancel' ? 'cancel' : 'decline';
    this.transport.respond(pending.requestId, this.permissionResponse(pending, decision));
    this.resolvePermission(permissionId, pending, decision.startsWith('accept') ? 'allowed' : 'denied',
      'manual', optionId);
    return true;
  }

  respondPermissionV2(
    permissionId: string, optionId: string, sessionGeneration: string,
  ): 'accepted' | 'stale' {
    if (sessionGeneration !== this.sessionGeneration) return 'stale';
    return this.respondPermission(permissionId, optionId) ? 'accepted' : 'stale';
  }

  eventsSince(seq: number): SessionEvent[] { return this.events.since(seq); }
  subscribe(listener: (event: SessionEvent) => void): () => void { return this.events.subscribe(listener); }

  setControllerAttached(attached: boolean): void {
    const before = this.controllerCount;
    this.controllerCount = Math.max(0, this.controllerCount + (attached ? 1 : -1));
    if (attached) {
      if (this.controllerGrace) clearTimeout(this.controllerGrace);
      this.controllerGrace = undefined;
    } else if (before > 0 && this.controllerCount === 0 && this.pendingPermissions.size) {
      this.controllerGrace = setTimeout(() => {
        this.controllerGrace = undefined;
        if (this.controllerCount || this.options.permissions.unattended !== 'deny') return;
        for (const [id, pending] of [...this.pendingPermissions])
          this.autoResolvePermission(id, pending, 'permissions.unattended=deny',
            'the last attached controller disconnected and the grace period expired');
      }, this.options.controllerGraceMs ?? CONTROLLER_GRACE_MS);
      this.controllerGrace.unref?.();
    }
  }

  exitResult(): ExitRecord | null { return this.exit ?? this.transport.exitResult(); }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.controllerGrace) clearTimeout(this.controllerGrace);
    this.clearInterruptForceKill();
    this.cancelTerminalReconciliation();
    for (const [id, pending] of [...this.pendingPermissions])
      this.autoResolvePermission(id, pending, undefined, 'the session closed');
    if (this.activeTurn)
      this.finishTurn('failed', 'Codex app-server session closed');
    this.readiness = 'failed';
    this.conversation.appendSafe({
      kind: 'session.state', sessionGeneration: this.sessionGeneration,
      payload: { status: 'offline' },
    });
    this.conversation.close();
    await this.transport.close();
  }

  conversationPage(request: { after?: string; limit?: number } = {}): ConversationHandlePage {
    const floor = Number(this.conversationStartCursor ?? 0);
    const requested = Number(request.after ?? 0);
    let after = String(Math.max(Number.isSafeInteger(floor) ? floor : 0,
      Number.isSafeInteger(requested) ? requested : 0));
    const limit = Math.min(Math.max(request.limit ?? 200, 1), 1_000);
    let page = this.conversation.page({ after, limit });
    let visible = page.events.filter(event => this.currentEvent(event));
    while (!visible.length && page.hasMore && page.nextCursor && page.nextCursor !== after) {
      after = page.nextCursor;
      page = this.conversation.page({ after, limit });
      visible = page.events.filter(event => this.currentEvent(event));
    }
    return { ...page, events: visible, snapshot: this.conversationSnapshot() };
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

  subscribeConversation(listener: (event: ConversationEventV1) => void): () => void {
    return this.conversation.subscribe(event => { if (this.currentEvent(event)) listener(event); });
  }

  async submitPromptBrowser(command: SubmitPromptCommand): Promise<PromptReceipt> {
    const bodyDigest = ConversationEventStore.bodyDigest(command.text);
    const existing = this.conversation.receiptFor(command.commandId, bodyDigest);
    if (existing) return existing;
    const queued = await this.queuePrompt(command.text, {
      origin: { kind: 'owner-admin-console', commandId: command.commandId },
      actor: { browserSession: command.actorBrowserSession },
    });
    const receipt: PromptReceipt = {
      commandId: command.commandId, promptId: queued.promptId,
      state: queued.queuedBehind ? 'queued' : 'starting', queuedBehind: queued.queuedBehind,
      acceptedAt: new Date().toISOString(), eventCursor: this.conversation.lastCursor() ?? '0',
    };
    this.conversation.recordReceipt(command.commandId, receipt, bodyDigest);
    return receipt;
  }

  private async initialize(): Promise<void> {
    await this.transport.request('initialize', {
      clientInfo: { name: 'ours-fleet', title: 'ours-fleet', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.transport.notify('initialized');
    const persisted = this.options.mode === 'resume' && existsSync(this.threadFile)
      ? readFileSync(this.threadFile, 'utf8').trim() : '';
    const common: JsonObject = {
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandbox,
      model: this.options.model ?? null,
      config: this.options.config ?? {},
      runtimeWorkspaceRoots: [this.options.cwd, ...(this.options.addDirs ?? []).map(path =>
        isAbsolute(path) ? path : resolve(this.options.cwd, path))],
    };
    const response = persisted
      ? await this.transport.request<JsonObject>('thread/resume', {
          threadId: persisted, ...common, excludeTurns: true,
        })
      : await this.transport.request<JsonObject>('thread/start', {
          ...common, ephemeral: false, historyMode: 'paginated', threadSource: 'ours-fleet',
        });
    const thread = isObject(response.thread) ? response.thread : undefined;
    this.threadId = string(thread?.id);
    if (!this.threadId) throw new Error('Codex app-server did not return a thread id');
    writeFileSync(this.threadFile, this.threadId + '\n', { mode: 0o600 });
    const model = string(response.model) ?? this.options.model ?? undefined;
    if (model) this.runtimeModel = { value: model };
    const effort = string(response.reasoningEffort) ?? this.options.effort;
    if (effort) this.reasoningEffort = { value: effort };
    this.readiness = 'idle';
    this.events.emit('state', { status: 'idle', text: `Codex thread ${this.threadId}` });
    this.conversation.appendSafe({
      kind: 'session.state', sessionGeneration: this.sessionGeneration,
      payload: { status: 'idle' },
    });
  }

  private recoverOpenPrompts(): void {
    for (const open of this.conversation.openPrompts()) {
      if (open.sessionGeneration === this.sessionGeneration) continue;
      if (open.state === 'started' || open.text === undefined) {
        this.conversation.appendSafe({
          kind: 'turn.completed', sessionGeneration: this.sessionGeneration,
          promptId: open.promptId, turnId: open.promptId,
          payload: { outcome: open.state === 'started' ? 'unknown_after_restart' : 'failed',
            ...(open.text === undefined ? { stopReason: 'prompt-body-not-retained' } : {}) },
        });
        continue;
      }
      this.queueDepth++;
      const origin: PromptOrigin | undefined = open.commandId
        ? { kind: 'owner-admin-console', commandId: open.commandId }
        : undefined;
      const run = this.promptTail.then(() => this.runPrompt(open.text!, open.promptId, origin));
      this.promptTail = run.then(() => undefined, () => undefined);
      void run.finally(() => { this.queueDepth = Math.max(0, this.queueDepth - 1); });
    }
  }

  private admit(
    promptId: string, text: string, queuedBehind: number, options: SubmitPromptOptions,
  ): void {
    const { source, persistBody } = sourceFor(options.origin);
    const bytes = Buffer.byteLength(text);
    const draft = {
      kind: 'prompt.admitted' as const, sessionGeneration: this.sessionGeneration,
      promptId, turnId: promptId, source,
      ...(options.origin?.kind === 'owner-admin-console'
        ? { commandId: options.origin.commandId } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      payload: {
        queuedBehind,
        ...(options.origin?.kind === 'owner' && options.origin.displayText !== undefined
          ? { displayText: textBlock(options.origin.displayText) } : {}),
        ...(persistBody ? { text: textBlock(text) }
          : { external: { digest: ConversationEventStore.bodyDigest(text), bytes } }),
      },
    };
    if (source === 'owner_admin_console') {
      try { this.conversation.append(draft); }
      catch (error) {
        throw new SessionControlError('backend',
          `conversation store cannot record the prompt: ${(error as Error).message}`);
      }
    } else this.conversation.appendSafe(draft);
  }

  private async runPrompt(text: string, promptId: string, origin?: PromptOrigin): Promise<TurnResult> {
    if (!this.threadId || !this.transport.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'Codex app-server session is offline');
    let settle!: (result: TurnResult) => void;
    const settled = new Promise<TurnResult>(resolveResult => { settle = resolveResult; });
    const active: ActiveTurn = { promptId, origin, output: '', settled, settle };
    this.activeTurn = active;
    this.finalAnswerObserved = false;
    this.activeItems.clear();
    this.readiness = 'running';
    this.events.emit('state', { turnId: promptId, status: 'running', origin });
    this.conversation.appendSafe({
      kind: 'prompt.started', sessionGeneration: this.sessionGeneration,
      promptId, turnId: promptId, source: sourceFor(origin).source, payload: {},
    });
    try {
      const response = await this.transport.request<JsonObject>('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: this.options.approvalPolicy,
        model: this.options.model ?? null,
        effort: this.options.effort ?? null,
        ...(nativePromptAdditionalContext(origin)
          ? { additionalContext: nativePromptAdditionalContext(origin) } : {}),
      });
      const turn = isObject(response.turn) ? response.turn : undefined;
      active.nativeTurnId ??= string(turn?.id);
      if (!active.nativeTurnId) throw new Error('Codex app-server did not return a turn id');
      this.scheduleTerminalReconciliation();
      return await settled;
    } catch (error) {
      if (this.activeTurn === active)
        this.finishTurn('failed', error instanceof Error ? error.message : String(error));
      return await settled;
    }
  }

  private async steer(
    text: string, expectedTurnId: string, origin?: PromptOrigin,
  ): Promise<TurnResult> {
    if (!this.threadId) return turnResult(false, 'failed', 'Codex thread is unavailable');
    try {
      await this.transport.request('turn/steer', {
        threadId: this.threadId, expectedTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(nativePromptAdditionalContext(origin)
          ? { additionalContext: nativePromptAdditionalContext(origin) } : {}),
      });
      return turnResult(true, 'inconclusive', 'injected');
    } catch (error) {
      return turnResult(false, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  private notification(method: string, params: JsonObject): void {
    if (string(params.threadId) && this.threadId && params.threadId !== this.threadId) return;
    this.lastUpdateAt = new Date().toISOString();
    switch (method) {
      case 'turn/started': {
        const turn = isObject(params.turn) ? params.turn : undefined;
        if (this.activeTurn) this.activeTurn.nativeTurnId ??= string(turn?.id);
        break;
      }
      case 'turn/completed': {
        const turn = isObject(params.turn) ? params.turn : {};
        const turnId = string(turn.id);
        if (!this.activeTurn || (turnId && this.activeTurn.nativeTurnId
            && turnId !== this.activeTurn.nativeTurnId)) break;
        this.activeTurn.nativeTurnId ??= turnId;
        const error = isObject(turn.error) ? string(turn.error.message) : undefined;
        this.finishTurn(outcomeFor(turn.status), error ?? string(turn.status));
        break;
      }
      case 'item/started':
        if (this.isActiveNotification(params) && isObject(params.item)) this.itemStarted(params.item);
        break;
      case 'item/completed':
        if (this.isActiveNotification(params) && isObject(params.item)) this.itemCompleted(params.item);
        break;
      case 'item/agentMessage/delta':
        if (this.isActiveNotification(params)) this.messageDelta(params);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (this.isActiveNotification(params)) this.thoughtDelta(params);
        break;
      case 'turn/plan/updated':
        if (this.isActiveNotification(params)) this.planUpdated(params);
        break;
      case 'serverRequest/resolved':
        this.serverRequestResolved(params);
        break;
      case 'warning':
      case 'configWarning': {
        const message = string(params.message) ?? string(params.summary);
        if (message) this.options.log(`[${this.options.name}] codex app-server: ${message}`);
        break;
      }
      case 'error': {
        const error = isObject(params.error) ? string(params.error.message) : undefined;
        if (error) {
          this.lastError = error;
          this.events.emit('error', { turnId: this.activeTurn?.promptId, text: error });
          this.conversation.appendSafe({
            kind: 'error', sessionGeneration: this.sessionGeneration,
            promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId,
            payload: { message: error },
          });
        }
        break;
      }
      case 'thread/status/changed': {
        const status = isObject(params.status) ? string(params.status.type) : undefined;
        if (status === 'systemError') {
          this.lastError = 'Codex thread entered systemError';
          this.cancelTerminalReconciliation();
          if (this.activeTurn) this.finishTurn('failed', this.lastError, true);
          else {
            this.readiness = 'failed';
            this.events.emit('state', { status: 'failed', text: this.lastError });
          }
          this.terminateFailedTransport(this.lastError);
          break;
        }
        if (status === 'idle' && this.activeTurn) {
          this.scheduleTerminalReconciliation();
        }
        break;
      }
      default:
        break;
    }
  }

  private itemStarted(item: JsonObject): void {
    const id = string(item.id);
    if (!id) return;
    this.activeItems.add(id);
    if (item.type === 'agentMessage') {
      const phase = item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : undefined;
      if (phase) this.itemPhases.set(id, phase);
      if (phase !== 'final_answer') {
        this.finalAnswerObserved = false;
        this.cancelTerminalReconciliation();
      }
      return;
    }
    this.finalAnswerObserved = false;
    this.cancelTerminalReconciliation();
    const tool = toolItem(item);
    if (!tool) return;
    this.activeTools.add(id);
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    this.events.emit('tool_call', {
      turnId: this.activeTurn?.promptId, origin: this.activeTurn?.origin,
      toolCallId: scheduled ? 'scheduled-loop-tool' : id,
      title: scheduled ? 'scheduled-loop tool' : tool.title,
      status: tool.status ?? 'inProgress',
    });
    this.recordTool(item, true);
  }

  private itemCompleted(item: JsonObject): void {
    const id = string(item.id);
    if (!id) return;
    this.activeItems.delete(id);
    if (item.type === 'agentMessage') {
      const phase = item.phase === 'commentary' || item.phase === 'final_answer'
        ? item.phase : this.itemPhases.get(id);
      if (phase) this.itemPhases.set(id, phase);
      const complete = string(item.text) ?? '';
      const emitted = this.itemText.get(id) ?? '';
      if (complete.length > emitted.length && complete.startsWith(emitted))
        this.emitMessage(id, complete.slice(emitted.length), phase);
      if (phase === 'final_answer' && complete.length > 0) {
        this.finalAnswerObserved = true;
        this.scheduleTerminalReconciliation();
      }
      return;
    }
    const tool = toolItem(item);
    if (!tool) return;
    this.activeTools.delete(id);
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    this.events.emit('tool_update', {
      turnId: this.activeTurn?.promptId, origin: this.activeTurn?.origin,
      toolCallId: scheduled ? 'scheduled-loop-tool' : id,
      title: scheduled ? 'scheduled-loop tool' : tool.title,
      status: tool.status ?? 'completed',
    });
    this.recordTool(item, false);
    this.scheduleTerminalReconciliation();
  }

  private messageDelta(params: JsonObject): void {
    const id = string(params.itemId);
    const delta = string(params.delta);
    if (!id || delta === undefined) return;
    this.emitMessage(id, delta, this.itemPhases.get(id));
  }

  private emitMessage(
    id: string, delta: string, phase?: 'commentary' | 'final_answer',
  ): void {
    this.itemText.set(id, (this.itemText.get(id) ?? '') + delta);
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    if (this.activeTurn && phase !== 'commentary') this.activeTurn.output += delta;
    this.events.emit('agent_text', {
      turnId: this.activeTurn?.promptId, origin: this.activeTurn?.origin,
      text: scheduled ? SCHEDULED_REDACTION : delta,
      messageId: id, ...(phase ? { messagePhase: phase } : {}),
    });
    this.conversation.appendSafe({
      kind: 'message.chunk', sessionGeneration: this.sessionGeneration,
      promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId,
      messageId: id, source: 'agent',
      payload: {
        role: 'assistant', content: textBlock(delta,
          scheduled ? SCHEDULED_REDACTION : phase === 'commentary' ? COMMENTARY_REDACTION : undefined),
      },
    });
  }

  private thoughtDelta(params: JsonObject): void {
    const delta = string(params.delta);
    if (delta === undefined) return;
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    this.events.emit('thought', {
      turnId: this.activeTurn?.promptId, origin: this.activeTurn?.origin,
      text: scheduled ? SCHEDULED_REDACTION : delta,
    });
    this.conversation.appendSafe({
      kind: 'thought.chunk', sessionGeneration: this.sessionGeneration,
      promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId,
      messageId: string(params.itemId), source: 'agent',
      payload: { content: textBlock(delta, scheduled ? SCHEDULED_REDACTION : undefined) },
    });
  }

  private planUpdated(params: JsonObject): void {
    const plan = Array.isArray(params.plan) ? params.plan : [];
    this.conversation.appendSafe({
      kind: 'plan.replace', sessionGeneration: this.sessionGeneration,
      promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId, source: 'agent',
      payload: { entries: plan.filter(isObject).map(entry => ({
        content: textBlock(string(entry.step) ?? string(entry.content) ?? ''),
        priority: 'medium' as const,
        status: entry.status === 'completed' ? 'completed' as const
          : entry.status === 'inProgress' ? 'in_progress' as const : 'pending' as const,
      })) },
    });
  }

  private recordTool(item: JsonObject, snapshot: boolean): void {
    const id = string(item.id);
    const tool = toolItem(item);
    if (!id || !tool) return;
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    this.conversation.appendSafe({
      kind: 'tool.upsert', sessionGeneration: this.sessionGeneration,
      promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId,
      toolCallId: scheduled ? 'scheduled-loop-tool' : id, source: 'agent',
      payload: {
        toolCallId: scheduled ? 'scheduled-loop-tool' : id, snapshot,
        title: scheduled ? 'scheduled-loop tool' : tool.title, status: tool.status,
        kind: string(item.type),
      },
    });
  }

  private finishTurn(outcome: TurnOutcome, detail?: string, sessionFailed = false): void {
    const active = this.activeTurn;
    if (!active) return;
    this.cancelTerminalReconciliation();
    this.clearInterruptForceKill();
    this.activeTurn = undefined;
    this.readiness = !sessionFailed && this.transport.isAlive() && !this.closing ? 'idle' : 'failed';
    this.activeTools.clear();
    this.activeItems.clear();
    this.itemPhases.clear();
    this.itemText.clear();
    this.finalAnswerObserved = false;
    const result = turnResult(true, outcome, detail, active.output, active.cancellationSource);
    this.events.emit('turn_stop', {
      turnId: active.promptId, origin: active.origin, stopReason: detail ?? outcome,
      cancellationSource: active.cancellationSource,
    });
    this.events.emit('state', { status: this.readiness });
    this.conversation.appendSafe({
      kind: 'turn.completed', sessionGeneration: this.sessionGeneration,
      promptId: active.promptId, turnId: active.promptId,
      payload: {
        outcome, ...(detail ? { stopReason: detail } : {}),
        ...(active.cancellationSource ? { cancellationSource: active.cancellationSource } : {}),
      },
    });
    active.settle(result);
  }

  /**
   * Some supported Codex versions can persist a completed turn without
   * emitting `turn/completed`. Reconcile only an exact, quiescent final-answer
   * candidate against the app-server's authoritative thread snapshot.
   */
  private scheduleTerminalReconciliation(): void {
    this.cancelTerminalReconciliation();
    if (!this.terminalCandidate()) return;
    this.terminalReconcile = setTimeout(() => {
      this.terminalReconcile = undefined;
      void this.reconcileTerminal();
    }, this.options.terminalReconcileQuietMs ?? TERMINAL_RECONCILE_QUIET_MS);
    this.terminalReconcile.unref?.();
  }

  private terminalCandidate(): boolean {
    return Boolean(this.activeTurn?.nativeTurnId && this.finalAnswerObserved
      && this.activeItems.size === 0 && this.pendingPermissions.size === 0
      && !this.terminalReconcileInFlight && !this.closing && this.transport.isAlive());
  }

  private async reconcileTerminal(): Promise<void> {
    if (!this.terminalCandidate() || !this.threadId || !this.activeTurn?.nativeTurnId) return;
    const active = this.activeTurn;
    const turnId = active.nativeTurnId;
    this.terminalReconcileInFlight = true;
    try {
      const response = await this.transport.request<JsonObject>('thread/read', {
        threadId: this.threadId, includeTurns: true,
      }, this.options.terminalReconcileRequestTimeoutMs
        ?? TERMINAL_RECONCILE_REQUEST_TIMEOUT_MS);
      if (this.activeTurn !== active || !this.finalAnswerObserved) return;
      const thread = isObject(response.thread) ? response.thread : undefined;
      const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
      const turn = turns.find(candidate => isObject(candidate) && candidate.id === turnId);
      if (!isObject(turn)) return;
      const status = string(turn.status);
      const threadStatus = thread && isObject(thread.status) ? string(thread.status.type) : undefined;
      const terminal = status === 'completed' || status === 'failed' || status === 'interrupted';
      if (!terminal && threadStatus !== 'idle') return;
      const error = isObject(turn.error) ? string(turn.error.message) : undefined;
      const outcome = terminal ? outcomeFor(status) : 'completed';
      this.options.log(`[${this.options.name}] inferred missing turn/completed after `
        + `authoritative reconciliation (${this.threadId}/${turnId})`);
      this.finishTurn(outcome, error ?? (terminal ? status : 'inferred missing turn/completed'));
    } catch (error) {
      if (this.activeTurn === active && this.transport.isAlive())
        this.options.log(`[${this.options.name}] Codex terminal reconciliation failed: `
          + `${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.terminalReconcileInFlight = false;
      if (this.activeTurn === active) this.scheduleTerminalReconciliation();
    }
  }

  private cancelTerminalReconciliation(): void {
    if (this.terminalReconcile) clearTimeout(this.terminalReconcile);
    this.terminalReconcile = undefined;
  }

  private clearInterruptForceKill(): void {
    if (this.interruptForceKill) clearTimeout(this.interruptForceKill);
    this.interruptForceKill = undefined;
  }

  private terminateFailedTransport(reason: string): void {
    if (!this.transport.isAlive()) return;
    this.transport.child.kill('SIGTERM');
    if (!this.transport.isAlive()) return;
    this.clearInterruptForceKill();
    this.interruptForceKill = setTimeout(() => {
      this.interruptForceKill = undefined;
      if (!this.transport.isAlive()) return;
      this.options.log(`[${this.options.name}] ${reason}; app-server ignored SIGTERM; sending SIGKILL`);
      this.transport.child.kill('SIGKILL');
    }, this.options.interruptTerminateGraceMs ?? INTERRUPT_TERMINATE_GRACE_MS);
    this.interruptForceKill.unref?.();
  }

  private serverRequest(method: string, id: RequestId, params: JsonObject): void {
    if (string(params.threadId) && this.threadId && params.threadId !== this.threadId) {
      this.transport.respondError(id, -32602, 'request belongs to another thread');
      return;
    }
    if (method === 'item/commandExecution/requestApproval'
        || method === 'item/fileChange/requestApproval'
        || method === 'item/permissions/requestApproval') {
      this.requestPermission(method, id, params);
      return;
    }
    if (method === 'currentTime/read') {
      this.transport.respond(id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      this.options.log(`[${this.options.name}] codex app-server: requestUserInput has no interactive Fleet mapping; returning no answers`);
      this.transport.respond(id, { answers: {} });
      return;
    }
    this.transport.respondError(id, -32601, `unsupported Codex server request: ${method}`);
  }

  private requestPermission(
    method: PendingPermission['method'], requestId: RequestId, params: JsonObject,
  ): void {
    const permissionId = randomUUID();
    const toolCallId = string(params.itemId) ?? randomUUID();
    const available = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter(value => typeof value === 'string') as string[] : [];
    const options = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', native: 'accept' },
      { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always', native: 'acceptForSession' },
      { optionId: 'deny_once', name: 'Deny', kind: 'reject_once', native: 'decline' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once', native: 'cancel' },
    ].filter(option => method === 'item/fileChange/requestApproval'
      || method === 'item/permissions/requestApproval'
      || !available.length || available.includes(option.native))
      .map(({ native: _native, ...option }) => option);
    const pending: PendingPermission = {
      requestId, method, toolCallId, options,
      ...(method === 'item/permissions/requestApproval' && isObject(params.permissions)
        ? { requestedPermissions: params.permissions } : {}),
    };

    // A generic permissions request is an explicit sandbox expansion. Portable
    // `approval=allow` covers native operations inside the declared boundary;
    // it must never silently widen filesystem or network authority.
    if (this.options.permissions.approval === 'allow'
        && method !== 'item/permissions/requestApproval') {
      this.transport.respond(requestId, this.permissionResponse(pending, 'accept'));
      this.resolvePermission(permissionId, pending, 'allowed', 'automatic', 'allow_once',
        'permissions.approval=allow', 'the native request is inside the configured Codex boundary');
      return;
    }
    const unattended = this.controllerCount === 0 && !this.controllerGrace
      && this.options.permissions.unattended === 'deny';
    if (this.options.permissions.approval === 'deny' || unattended) {
      this.transport.respond(requestId, this.permissionResponse(pending, 'decline'));
      this.resolvePermission(permissionId, pending, 'denied', 'automatic', 'deny_once',
        unattended ? 'permissions.unattended=deny' : 'permissions.approval=deny',
        unattended ? 'no controller is attached' : 'the role denies permission requests');
      return;
    }

    this.pendingPermissions.set(permissionId, pending);
    this.readiness = 'awaiting_permission';
    const timeoutMs = this.options.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    const title = string(params.command) ?? string(params.reason)
      ?? (method === 'item/fileChange/requestApproval' ? 'Apply file changes'
        : method === 'item/permissions/requestApproval' ? 'Grant additional permissions'
          : 'Run command');
    this.events.emit('permission', {
      turnId: this.activeTurn?.promptId, origin: this.activeTurn?.origin,
      permissionId, toolCallId, title, status: 'pending', options,
    });
    this.conversation.appendSafe({
      kind: 'permission.requested', sessionGeneration: this.sessionGeneration,
      permissionId, promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId,
      toolCallId, payload: { toolCallId, title, options, expiresAt },
    });
    pending.expiry = setTimeout(() => {
      this.autoResolvePermission(permissionId, pending, undefined,
        `no decision arrived within ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    pending.expiry.unref?.();
  }

  private serverRequestResolved(params: JsonObject): void {
    const requestId = typeof params.requestId === 'string' || typeof params.requestId === 'number'
      ? params.requestId : undefined;
    if (requestId === undefined) return;
    const entry = [...this.pendingPermissions].find(([, pending]) =>
      pending.requestId === requestId);
    if (!entry) return;
    const [permissionId, pending] = entry;
    this.pendingPermissions.delete(permissionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    this.resolvePermission(permissionId, pending, 'cancelled', 'automatic', undefined, undefined,
      'Codex resolved the native server request externally');
  }

  private autoResolvePermission(
    permissionId: string, pending: PendingPermission, policy: string | undefined, reason: string,
  ): void {
    if (this.pendingPermissions.get(permissionId) === pending)
      this.pendingPermissions.delete(permissionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    if (this.transport.isAlive())
      this.transport.respond(pending.requestId, this.permissionResponse(pending, 'decline'));
    this.resolvePermission(permissionId, pending, 'denied', 'automatic', 'deny_once', policy, reason);
  }

  private resolvePermission(
    permissionId: string, pending: PendingPermission, decision: PermissionDecision,
    decisionSource: 'automatic' | 'manual', optionId?: string, policy?: string, reason?: string,
  ): void {
    this.events.emit('permission', {
      turnId: this.activeTurn?.promptId, origin: this.activeTurn?.origin,
      permissionId, toolCallId: pending.toolCallId, status: 'completed', decision,
      decisionSource, optionId, policy, reason,
    });
    this.conversation.appendSafe({
      kind: 'permission.resolved', sessionGeneration: this.sessionGeneration,
      permissionId, promptId: this.activeTurn?.promptId, turnId: this.activeTurn?.promptId,
      toolCallId: pending.toolCallId,
      payload: { decision, decisionSource, ...(optionId ? { optionId } : {}),
        ...(policy ? { policy } : {}), ...(reason ? { reason } : {}) },
    });
    if (!this.pendingPermissions.size && this.readiness === 'awaiting_permission')
      this.readiness = 'running';
    this.scheduleTerminalReconciliation();
  }

  private currentEvent(event: ConversationEventV1): boolean {
    return event.sessionGeneration === this.sessionGeneration && event.source !== 'agent_replay';
  }

  private isActiveNotification(params: JsonObject): boolean {
    if (!this.activeTurn) return false;
    const turnId = string(params.turnId);
    return !turnId || !this.activeTurn.nativeTurnId || turnId === this.activeTurn.nativeTurnId;
  }

  private permissionResponse(
    pending: PendingPermission, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): JsonObject {
    if (pending.method !== 'item/permissions/requestApproval') return { decision };
    const requested = pending.requestedPermissions ?? {};
    const permissions: JsonObject = {};
    if (isObject(requested.network)) permissions.network = requested.network;
    if (isObject(requested.fileSystem)) permissions.fileSystem = requested.fileSystem;
    return {
      permissions: decision.startsWith('accept') ? permissions : {},
      scope: decision === 'acceptForSession' ? 'session' : 'turn',
    };
  }

  private transportExited(exit: ExitRecord): void {
    this.clearInterruptForceKill();
    this.cancelTerminalReconciliation();
    this.exit = this.lastError === CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED
      ? { ...exit, detail: `${this.lastError}; ${exit.detail}` } : exit;
    if (!this.closing) {
      this.readiness = 'failed';
      this.lastError ??= `Codex app-server ${this.exit.detail}`;
      this.events.emit('state', { status: 'failed', text: this.lastError });
      this.conversation.appendSafe({
        kind: 'session.state', sessionGeneration: this.sessionGeneration,
        payload: { status: 'failed', detail: this.lastError },
      });
      if (this.activeTurn) this.finishTurn('failed', this.lastError);
    }
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.readiness = 'failed';
    this.events.emit('error', { text: this.lastError });
  }
}
