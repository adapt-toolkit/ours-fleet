import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  RuntimeSelectorMetadata, SessionHandle, SessionSnapshot, SubmitPromptOptions,
  TurnCancellationSource, TurnOutcome,
  TurnResult,
} from './types.js';

interface PendingPermission {
  options: Array<{ optionId: string; kind: string }>;
  resolve(response: acp.RequestPermissionResponse): void;
  /** Real ACP ID used only for lifecycle tracking; never emit this for scheduled loops. */
  toolCallId?: string;
  /** Public/ledger ID, redacted for scheduled loops. */
  eventToolCallId?: string;
  expiry?: ReturnType<typeof setTimeout>;
}

interface ActiveToolCall {
  /** An authenticated non-terminal tool update has been observed. */
  lifecycle: boolean;
  /** Permission request ID -> whether its selected outcome allows the tool to proceed. */
  permissions: Map<string, 'pending' | 'allowed'>;
}

interface SteeringResponse {
  outcome: 'injected' | 'startedNewTurn' | 'failed';
}

const CANCEL_SETTLE_GRACE_MS = 15_000;
/** A permission no human answered is eventually a decision nobody made. */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;
/** Spec §4.3: 10-15 s before a vanished controller triggers the unattended policy. */
const CONTROLLER_GRACE_MS = 12_000;
/** Bound safe-boundary waiting without turning a hung tool into cancellation. */
export const AFTER_TOOL_BOUNDARY_TIMEOUT_MS = 120_000;
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed']);

const SCHEDULED_LOOP_REDACTION = '[scheduled-loop content redacted]';
const OWNER_COMMENTARY_REDACTION = '[assistant commentary redacted]';
const MAX_CANONICAL_SYMLINK_DEPTH = 40;

const scheduledTurn = (turn: { origin?: PromptOrigin } | undefined): boolean =>
  turn?.origin?.kind === 'scheduled-loop';

/**
 * Two matching realpath observations narrow the opportunity for a concurrent
 * retarget, but are only an advisory consistency check: they do not lock the
 * path. A mutation after the completed check remains an unavoidable TOCTOU
 * window until ACP offers handle-based access.
 */
function stableRealpath(path: string): string | undefined {
  const first = realpathSync.native(path);
  const second = realpathSync.native(path);
  return first === second ? first : undefined;
}

type MissingPathInspection =
  | { kind: 'absent' }
  | { kind: 'symlink'; target: string }
  | { kind: 'unsafe' };

/** Distinguish an absent component from a dangling symlink at that component. */
function inspectMissingPath(path: string): MissingPathInspection {
  try {
    const stat = lstatSync(path);
    // realpath said ENOENT but lstat found a non-link: the path changed while
    // inspected, so there is no coherent canonical answer to trust.
    if (!stat.isSymbolicLink()) return { kind: 'unsafe' };
    try {
      return { kind: 'symlink', target: resolve(dirname(path), readlinkSync(path)) };
    } catch {
      return { kind: 'unsafe' };
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unsafe' };
  }
}

/**
 * Canonicalize an existing path, or a not-yet-created target through its
 * nearest existing ancestor. Dangling links are followed explicitly because
 * realpath reports their absent target as ENOENT. Only genuine absence is
 * recoverable; loops, permissions, races, and every other error fail closed.
 */
function canonicalTarget(path: string, symlinkDepth = 0): string | undefined {
  let probe = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      let canonical = stableRealpath(probe);
      if (!canonical) return undefined;
      // A component may have appeared while the ancestor search was in
      // progress. Re-walk the suffix so a newly-created symlink is resolved,
      // not treated as a lexical child of the old ancestor.
      let logical = probe;
      for (let i = 0; i < missing.length; i++) {
        logical = resolve(logical, missing[i]);
        try {
          const appeared = stableRealpath(logical);
          if (!appeared) return undefined;
          canonical = appeared;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
          const inspected = inspectMissingPath(logical);
          if (inspected.kind === 'unsafe') return undefined;
          if (inspected.kind === 'symlink') {
            if (symlinkDepth >= MAX_CANONICAL_SYMLINK_DEPTH) return undefined;
            return canonicalTarget(
              resolve(inspected.target, ...missing.slice(i + 1)), symlinkDepth + 1);
          }
          return resolve(canonical, ...missing.slice(i));
        }
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const inspected = inspectMissingPath(probe);
      if (inspected.kind === 'unsafe') return undefined;
      if (inspected.kind === 'symlink') {
        if (symlinkDepth >= MAX_CANONICAL_SYMLINK_DEPTH) return undefined;
        return canonicalTarget(resolve(inspected.target, ...missing), symlinkDepth + 1);
      }
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
}

function canonicallyWithin(root: string, candidates: string[]): boolean {
  if (candidates.length === 0) return false;
  try {
    const firstRoot = realpathSync.native(root);
    const paths = candidates.map(canonicalTarget);
    const secondRoot = realpathSync.native(root);
    if (firstRoot !== secondRoot || paths.some(path => path === undefined)) return false;
    return paths.every(candidate => {
      const rel = relative(firstRoot, candidate!);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  } catch {
    return false;
  }
}

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
    case 'owner-admin-console': return { source: 'owner_admin_console', persistBody: true };
    case 'startup': return { source: 'startup', persistBody: true };
    case 'owner': return { source: 'owner_channel', persistBody: false };
    case 'fleet-monitor': return { source: 'fleet_monitor', persistBody: false };
    case 'scheduled-loop': return { source: 'scheduled_loop', persistBody: false };
    case 'local-console':
    default:
      return { source: 'local_console', persistBody: true };
  }
}

/** Server-generated typed provenance followed by the exact human-authored body. */
export function promptContentBlocks(text: string, origin?: PromptOrigin): acp.ContentBlock[] {
  if (origin?.kind !== 'owner-admin-console') return [{ type: 'text', text }];
  return [{
    type: 'resource_link',
    uri: 'ours-fleet://prompt-provenance?source=owner_admin_console',
    name: 'Direct owner admin console',
    description: 'Server-authenticated paired console provenance; accompanying text is direct owner input.',
    mimeType: 'application/vnd.ours-fleet.prompt-provenance+json',
  }, { type: 'text', text }];
}

export function runtimeSelector(
  options: acp.SessionConfigOption[] | null | undefined, category: string,
): RuntimeSelectorMetadata | undefined {
  const option = options?.find(candidate => candidate.category === category);
  if (!option || typeof option.currentValue !== 'string') return undefined;
  const choices = Array.isArray(option.options) ? option.options.flatMap(choice =>
    'options' in choice ? choice.options : [choice]) : [];
  const selected = choices.find(choice => choice.value === option.currentValue);
  return { value: option.currentValue, ...(selected?.name ? { label: selected.name } : {}) };
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
  /** Adapter-resolved live permission policy; separate from ACP agent-specific session modes. */
  permissionMode?: NonNullable<SessionSnapshot['permissionMode']>;
  log(line: string): void;
  /** Test seam for the cancel-escalation grace period; production uses the default. */
  cancelGraceMs?: number;
  /** How long a pending permission may wait for a human before it expires. */
  permissionTimeoutMs?: number;
  /** Grace after the last controller detaches before the unattended policy applies. */
  controllerGraceMs?: number;
  /** Test seam; production uses AFTER_TOOL_BOUNDARY_TIMEOUT_MS. */
  afterToolBoundaryTimeoutMs?: number;
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
  private runtimeModel?: RuntimeSelectorMetadata;
  private reasoningEffort?: RuntimeSelectorMetadata;
  private controllerCount = 0;
  private closing = false;
  /** Armed when the last controller detaches; unattended policy applies on fire. */
  private controllerGrace?: ReturnType<typeof setTimeout>;
  private cancelEscalation?: ReturnType<typeof setTimeout>;
  /** ACP-authenticated in-flight calls, including independently reserved permissions. */
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  private readonly toolBoundaryWaiters = new Set<() => void>();
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
      runtimeModel: this.runtimeModel,
      reasoningEffort: this.reasoningEffort,
      permissionMode: this.options.permissionMode,
    };
  }

  private toolCall(toolCallId: string): ActiveToolCall {
    const existing = this.activeToolCalls.get(toolCallId);
    if (existing) return existing;
    const created: ActiveToolCall = { lifecycle: false, permissions: new Map() };
    this.activeToolCalls.set(toolCallId, created);
    return created;
  }

  private reserveTool(toolCallId: string | undefined): void {
    if (toolCallId) this.toolCall(toolCallId).lifecycle = true;
  }

  private reservePermission(toolCallId: string | undefined, permissionId: string): void {
    if (toolCallId) this.toolCall(toolCallId).permissions.set(permissionId, 'pending');
  }

  private allowPermission(toolCallId: string | undefined, permissionId: string): void {
    if (!toolCallId) return;
    const permission = this.activeToolCalls.get(toolCallId)?.permissions;
    if (permission?.has(permissionId)) permission.set(permissionId, 'allowed');
  }

  private releasePermission(toolCallId: string | undefined, permissionId: string): void {
    const call = toolCallId && this.activeToolCalls.get(toolCallId);
    if (!call || !call.permissions.delete(permissionId)) return;
    this.releaseToolIfIdle(toolCallId, call);
  }

  private releaseTool(toolCallId: string | undefined): void {
    const call = toolCallId && this.activeToolCalls.get(toolCallId);
    if (!call) return;
    call.lifecycle = false;
    // Terminal tool evidence consumes permissions already granted for this
    // call, but never a separate request that is still awaiting a decision.
    for (const [permissionId, state] of call.permissions)
      if (state === 'allowed') call.permissions.delete(permissionId);
    this.releaseToolIfIdle(toolCallId, call);
  }

  private releaseToolIfIdle(toolCallId: string, call: ActiveToolCall): void {
    if (call.lifecycle || call.permissions.size > 0) return;
    if (!this.activeToolCalls.delete(toolCallId) || this.activeToolCalls.size > 0) return;
    for (const notify of [...this.toolBoundaryWaiters]) notify();
  }

  private releaseAllTools(): void {
    if (this.activeToolCalls.size === 0) return;
    this.activeToolCalls.clear();
    for (const notify of [...this.toolBoundaryWaiters]) notify();
  }

  private waitForToolBoundary(timeoutMs: number): Promise<boolean> {
    if (this.activeToolCalls.size === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (atBoundary: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.toolBoundaryWaiters.delete(check);
        resolve(atBoundary);
      };
      const check = () => {
        if (this.activeToolCalls.size === 0 || !this.isAlive())
          finish(this.activeToolCalls.size === 0);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref?.();
      this.toolBoundaryWaiters.add(check);
      // Close the subscribe/check race without guessing about elapsed time.
      check();
    });
  }

  private recordAfterToolDelivery(
    state: 'deferred' | 'direct' | 'after_tool' | 'timeout' | 'unsupported',
    activeToolCount: number, waitedMs: number,
  ): void {
    this.events.emit('monitor_delivery', {
      status: state, monitorPolicy: 'after_tool', activeToolCount, waitedMs,
    });
    this.conversation.appendSafe({
      kind: 'monitor.delivery', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, source: 'fleet_monitor',
      payload: { policy: 'after_tool', state, activeToolCount, waitedMs },
    });
  }

  /**
   * Monitor-only safe-boundary delivery. Steering is the interruption: this
   * path never calls session/cancel and never resolves a pending permission.
   */
  async submitPromptAfterTool(
    text: string, options: SubmitPromptOptions = {},
  ): Promise<TurnResult> {
    if (this.closing || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is closing');
    const startedAt = Date.now();
    const initialToolCount = this.activeToolCalls.size;
    if (!this.steeringSupported) {
      this.recordAfterToolDelivery('unsupported', initialToolCount, 0);
      const result = await this.submitPrompt(text, { ...options, interrupt: false, steer: false });
      return {
        ...result,
        safeBoundary: { state: 'unsupported', waitedMs: 0, activeToolCount: initialToolCount },
      };
    }
    if (initialToolCount === 0) {
      this.recordAfterToolDelivery('direct', 0, 0);
      const result = await this.steerPrompt(text);
      return { ...result, safeBoundary: { state: 'direct', waitedMs: 0, activeToolCount: 0 } };
    }

    this.recordAfterToolDelivery('deferred', initialToolCount, 0);
    const timeoutMs = this.options.afterToolBoundaryTimeoutMs ?? AFTER_TOOL_BOUNDARY_TIMEOUT_MS;
    const deadline = startedAt + timeoutMs;
    let atBoundary = false;
    // Re-check after every wake: another authenticated tool event may have
    // arrived before this continuation ran. Only an empty tracked set is safe.
    while (this.activeToolCalls.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await this.waitForToolBoundary(remaining))) break;
    }
    atBoundary = this.activeToolCalls.size === 0;
    if (this.closing || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session closed during after_tool wait');
    const waitedMs = Math.max(0, Date.now() - startedAt);
    const state = atBoundary ? 'after_tool' : 'timeout';
    const remainingToolCount = this.activeToolCalls.size;
    this.recordAfterToolDelivery(state, remainingToolCount, waitedMs);
    const result = await this.steerPrompt(text);
    return {
      ...result,
      safeBoundary: { state, waitedMs, activeToolCount: remainingToolCount },
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
      ...(options.origin?.kind === 'owner-admin-console' ? { commandId: options.origin.commandId } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      payload: {
        queuedBehind,
        ...(options.origin?.kind === 'owner' && options.origin.displayText !== undefined
          ? { displayText: { type: 'text' as const, text: options.origin.displayText,
              bytes: Buffer.byteLength(options.origin.displayText) } }
          : {}),
        ...(persistBody
          ? { text: { type: 'text' as const, text, bytes } }
          : { external: { digest: ConversationEventStore.bodyDigest(text), bytes } }),
      },
    };
    if (source === 'owner_admin_console') {
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
      origin: { kind: 'owner-admin-console', commandId: command.commandId },
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
    for (const [permissionId, pending] of [...this.pendingPermissions])
      this.settlePendingAutomatically(permissionId, pending, 'cancelled', undefined,
        'the turn was cancelled while this request was pending');
  }

  respondPermission(permissionId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    const chosen = pending?.options.find(option => option.optionId === optionId);
    if (!pending || !chosen) return false;
    this.pendingPermissions.delete(permissionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    const decision = chosen.kind.startsWith('reject') ? 'denied' : 'allowed';
    if (decision === 'allowed') this.allowPermission(pending.toolCallId, permissionId);
    else this.releasePermission(pending.toolCallId, permissionId);
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
    this.readiness = this.pendingPermissions.size > 0 ? 'awaiting_permission' : 'running';
    return true;
  }

  /**
   * A v2 decision binds to the session generation it was shown under. A stale
   * generation, an already-settled request, or an unknown option are all the
   * same answer: someone else's decision (or a restart) got there first.
   */
  respondPermissionV2(
    permissionId: string, optionId: string, sessionGeneration: string,
  ): 'accepted' | 'stale' {
    if (sessionGeneration !== this.sessionGeneration) return 'stale';
    return this.respondPermission(permissionId, optionId) ? 'accepted' : 'stale';
  }

  eventsSince(seq: number): SessionEvent[] {
    return this.events.since(seq);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  setControllerAttached(attached: boolean): void {
    const before = this.controllerCount;
    this.controllerCount = Math.max(0, this.controllerCount + (attached ? 1 : -1));
    if (attached) {
      if (this.controllerGrace) clearTimeout(this.controllerGrace);
      this.controllerGrace = undefined;
      return;
    }
    // The LAST controller just walked away with permissions possibly pending.
    // Nothing is decided yet: a reconnect within the grace keeps everything
    // alive; only its expiry hands the pendings to the unattended policy.
    if (before > 0 && this.controllerCount === 0 && this.pendingPermissions.size > 0)
      this.armControllerGrace();
  }

  private armControllerGrace(): void {
    if (this.controllerGrace) clearTimeout(this.controllerGrace);
    this.controllerGrace = setTimeout(() => {
      this.controllerGrace = undefined;
      if (this.controllerCount > 0 || this.options.permissions.unattended !== 'deny') return;
      for (const [permissionId, pending] of [...this.pendingPermissions])
        this.settlePendingAutomatically(permissionId, pending, 'denied',
          'permissions.unattended=deny',
          'the last attached controller disconnected and the grace period expired');
    }, this.options.controllerGraceMs ?? CONTROLLER_GRACE_MS);
    this.controllerGrace.unref?.();
  }

  /**
   * Settle one pending request without a human decision — unattended policy,
   * expiry, or cancellation — and leave the same durable evidence a manual
   * decision would. A denial selects the agent's own one-shot reject option;
   * everything else resolves as cancelled toward the agent.
   */
  private settlePendingAutomatically(
    permissionId: string, pending: PendingPermission,
    decision: 'denied' | 'cancelled' | 'expired', policy: string | undefined, reason: string,
  ): void {
    if (!this.pendingPermissions.delete(permissionId)) return;
    if (pending.expiry) clearTimeout(pending.expiry);
    const rejectOption = decision === 'denied'
      ? pending.options.find(option => option.kind === 'reject_once')
        ?? pending.options.find(option => option.kind === 'reject_always')
      : undefined;
    pending.resolve(rejectOption
      ? { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
      : { outcome: { outcome: 'cancelled' } });
    const settled = decision === 'denied' && !rejectOption ? 'cancelled' : decision;
    this.releasePermission(pending.toolCallId, permissionId);
    this.events.emit('permission', {
      turnId: this.activeTurn?.id,
      origin: this.activeTurn?.origin,
      permissionId,
      toolCallId: pending.eventToolCallId,
      status: 'completed',
      decision: settled === 'expired' ? 'cancelled' : settled,
      decisionSource: 'automatic',
      policy,
      reason,
      optionId: rejectOption?.optionId,
    });
    this.conversation.appendSafe({
      kind: 'permission.resolved', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, permissionId,
      promptId: this.activeTurn?.id, turnId: this.activeTurn?.id,
      toolCallId: pending.eventToolCallId,
      payload: {
        decision: settled, decisionSource: 'automatic',
        ...(policy ? { policy } : {}), reason,
        ...(rejectOption ? { optionId: rejectOption.optionId } : {}),
      },
    });
    if (this.pendingPermissions.size === 0 && this.readiness === 'awaiting_permission')
      this.readiness = 'running';
  }

  exitResult(): ExitRecord | null {
    return this.exit;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
    this.cancelEscalation = undefined;
    if (this.controllerGrace) clearTimeout(this.controllerGrace);
    this.controllerGrace = undefined;
    for (const [permissionId, pending] of [...this.pendingPermissions])
      this.settlePendingAutomatically(permissionId, pending, 'cancelled', undefined,
        'the session closed while this request was pending');
    this.releaseAllTools();
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
      const resumed = await this.connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: persisted,
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.captureRuntimeMetadata(resumed.configOptions);
      this.sessionId = persisted;
    } else if (persisted && this.capabilities?.loadSession) {
      // `session/load` replays prior history as ordinary updates before the
      // response; those records carry `agent_replay` provenance, never `agent`.
      this.replaying = true;
      try {
        const loaded = await this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: persisted,
          cwd: this.options.cwd,
          mcpServers: [],
        });
        this.captureRuntimeMetadata(loaded.configOptions);
      } finally { this.replaying = false; }
      this.sessionId = persisted;
    } else {
      const created = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = created.sessionId;
      this.captureRuntimeMetadata(created.configOptions);
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

  private captureRuntimeMetadata(options: acp.SessionConfigOption[] | null | undefined): void {
    this.runtimeModel = runtimeSelector(options, 'model');
    this.reasoningEffort = runtimeSelector(options, 'thought_level');
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
        prompt: promptContentBlocks(text, origin),
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
      this.releaseAllTools();
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
    const toolCallId = params.toolCall.toolCallId;
    const permissionId = randomUUID();
    // Permission is part of the tool lifecycle. Reserve before any policy or
    // human decision so a monitor wake cannot slip between request and answer.
    this.reservePermission(toolCallId, permissionId);
    if (this.options.permissions.approval === 'allow' && this.withinAutomaticBoundary(params)) {
      const option = choose(['allow_always', 'allow_once']);
      const response = this.settleAutomatically(params, option, 'allowed',
        'permissions.approval=allow',
        `the request is inside the ${this.options.permissions.filesystem} boundary`);
      if (option) this.allowPermission(toolCallId, permissionId);
      else this.releasePermission(toolCallId, permissionId);
      return Promise.resolve(response);
    }
    // A live grace window still counts as attended: the controller may be
    // mid-reconnect, and denying instantly is exactly what the grace prevents.
    const unattended = this.controllerCount === 0 && !this.controllerGrace
      && this.options.permissions.unattended === 'deny';
    if (this.options.permissions.approval === 'deny' || unattended) {
      // reject_once FIRST: `reject_always` teaches the agent a standing rule from
      // a decision no human made, so one unattended denial would silently disable
      // the tool for the rest of the session.
      const option = choose(['reject_once', 'reject_always']);
      const response = this.settleAutomatically(params, option, 'denied',
        unattended ? 'permissions.unattended=deny' : 'permissions.approval=deny',
        unattended
          ? 'no controller is attached, so the request cannot be shown to anyone'
          : 'the role denies every permission request by policy');
      this.releasePermission(toolCallId, permissionId);
      return Promise.resolve(response);
    }

    const timeoutMs = this.options.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
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
        expiresAt,
      },
    });
    return new Promise(resolve => {
      const pending: PendingPermission = {
        options: params.options, resolve,
        toolCallId,
        eventToolCallId: scheduledTurn(this.activeTurn) ? 'scheduled-loop-tool' : toolCallId,
      };
      pending.expiry = setTimeout(() => {
        this.settlePendingAutomatically(permissionId, pending, 'expired', undefined,
          `no decision arrived within ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);
      pending.expiry.unref?.();
      this.pendingPermissions.set(permissionId, pending);
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
    return canonicallyWithin(cwd, locations.map(location => resolve(location.path)));
  }

  private recordUpdate(update: acp.SessionUpdate): void {
    const scheduled = this.activeTurn?.origin?.kind === 'scheduled-loop';
    const messagePhase = update.sessionUpdate === 'agent_message_chunk'
      ? this.codexMessagePhase(update) : undefined;
    this.recordConversationUpdate(update, scheduled, messagePhase === 'commentary');
    if (update.sessionUpdate === 'config_option_update')
      this.captureRuntimeMetadata(update.configOptions);
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const phase = messagePhase;
        if (this.activeTurn && update.content.type === 'text'
            && phase !== 'commentary' && phase !== 'ambiguous')
          this.activeTurn.output += update.content.text;
        this.events.emit('agent_text', {
          turnId: this.activeTurn?.id,
          origin: this.activeTurn?.origin,
          text: scheduled ? '[scheduled-loop output redacted]'
            : update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
          ...(phase === 'commentary' || phase === 'final_answer'
            ? { messagePhase: phase } : {}),
          ...(typeof update.messageId === 'string' ? { messageId: update.messageId } : {}),
          ...(this.replaying ? { replayed: true } : {}),
        });
        break;
      }
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
        if (TERMINAL_TOOL_STATUSES.has(update.status ?? '')) this.releaseTool(update.toolCallId);
        else this.reserveTool(update.toolCallId);
        break;
      case 'tool_call_update':
        this.events.emit('tool_update', {
          turnId: this.activeTurn?.id,
          origin: this.activeTurn?.origin,
          toolCallId: scheduled ? 'scheduled-loop-tool' : update.toolCallId,
          title: scheduled ? 'scheduled-loop tool' : update.title ?? undefined,
          status: update.status ?? undefined,
        });
        if (TERMINAL_TOOL_STATUSES.has(update.status ?? '')) this.releaseTool(update.toolCallId);
        else if (update.status !== undefined) this.reserveTool(update.toolCallId);
        break;
      default:
        break;
    }
  }

  /**
   * Codex ACP's phase extension is the only currently supported visibility
   * signal. Never infer commentary from text, message order, or unknown meta.
   */
  private codexMessagePhase(
    update: acp.SessionUpdate,
  ): 'commentary' | 'final_answer' | 'ambiguous' | undefined {
    const meta = (update as unknown as { _meta?: unknown })._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    const codex = (meta as Record<string, unknown>).codex;
    if (!codex || typeof codex !== 'object' || Array.isArray(codex)) return undefined;
    const phase = (codex as Record<string, unknown>).phase;
    if (phase === undefined) return undefined;
    return phase === 'commentary' || phase === 'final_answer' ? phase : 'ambiguous';
  }

  /** Normalize every ACP update losslessly into the durable ledger. */
  private recordConversationUpdate(
    update: acp.SessionUpdate, scheduled: boolean, commentary = false,
  ): void {
    const normalized = normalizeSessionUpdate(update,
      scheduled ? {
        redactText: SCHEDULED_LOOP_REDACTION,
        redactToolCallId: 'scheduled-loop-tool',
      }
        : commentary ? { redactText: OWNER_COMMENTARY_REDACTION } : {});
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
