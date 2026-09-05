import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { CommonPermissions } from '../config.js';
import type { AcpMcpServer } from '../harness/types.js';
import { normalizeSessionUpdate } from './conversation-normalizer.js';
import { ConversationEventStore, IdempotencyConflictError } from './conversation-store.js';
import type {
  ConversationEventV1, ConversationSnapshot, ConversationSource, PromptOrigin, PromptReceipt,
  SubmitPromptCommand,
} from './conversation-types.js';
import { SessionEvents } from './events.js';
import { DEFAULT_STALL_TIMEOUT_MS, STALL_RECOVERY_PROMPT, StallWatchdog, StallToolHistory, hasStallRecoveryClaim,
  type StallObservation, type StallStatus } from './stall-watchdog.js';
import {
  ACP_CANCEL_DEADLINE_EXCEEDED, SessionControlError, classifyChildExit,
  sessionBackendCapabilities, turnResult,
} from './types.js';
import type {
  ConversationHandlePage, ExitRecord, InterruptOutcome, PermissionDecision, PromptDelivery,
  QueuedPrompt,
  SessionEvent,
  AgentSession, RuntimeSelectorMetadata, SessionSnapshot, SubmitPromptOptions,
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
const CANCEL_TERMINATE_GRACE_MS = 5_000;
/** A permission no human answered is eventually a decision nobody made. */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;
/** Wait 10–15 seconds before a vanished controller triggers the unattended policy. */
const CONTROLLER_GRACE_MS = 12_000;
/** Bound safe-boundary waiting without turning a hung tool into cancellation. */
export const AFTER_TOOL_BOUNDARY_TIMEOUT_MS = 120_000;
/**
 * How long a steering-started turn is presumed to still own the adapter after
 * its last update. Such a turn has no prompt id, so it never reports a
 * stopReason and there is no exact end to observe — silence is the only signal
 * available, and this is the bound that turns it into a decision.
 *
 * Sized from the fleet's own scheduled-run history: across 1513 completed
 * scheduled runs the longest silence WITHIN a working turn was 120.2 s (p99
 * 41.0 s; 5 runs above 60 s). A shorter grace would release the lease while the
 * adapter is still working and re-admit a prompt into a busy turn, which is the
 * FLEET-003 failure itself. The costs are deliberately asymmetric: holding too
 * long skips one best-effort maintenance tick, releasing too early SIGTERMs a
 * live role.
 */
export const STEERING_OCCUPANCY_IDLE_MS = 150_000;
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed']);

/** Consumed only by Fleet's authenticated bundled-Codex app-server proxy. */
export const CODEX_DISABLE_INHERITED_MCP_ENV = 'OURS_FLEET_CODEX_DISABLE_INHERITED_MCP';

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
 * recorded as digest/size placeholders.
 */
function conversationSource(origin: PromptOrigin | undefined): {
  source: ConversationSource; persistBody: boolean;
} {
  switch (origin?.kind) {
    case 'owner-admin-console': return { source: 'owner_admin_console', persistBody: true };
    case 'stall-watchdog': return { source: 'fleet_monitor', persistBody: false };
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

function reasoningFromModelId(modelId: unknown): RuntimeSelectorMetadata | undefined {
  if (typeof modelId !== 'string') return undefined;
  const match = modelId.match(/\[([^\]]+)\]$/u);
  return match?.[1] ? { value: match[1] } : undefined;
}

export interface AcpSessionOptions {
  /** Opt-in Fleet watchdog, owned by this ACP session, never a process restart. */
  stallRecovery?: { timeoutMs?: number; tickMs?: number; cancelWaitMs?: number };
  name: string;
  /** Harness identity used only for honest optional capability reporting. */
  harness?: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stateDir: string;
  mode: 'fresh' | 'resume';
  permissions: CommonPermissions;
  /** Native permission-mode id to request via session/set_mode; undefined keeps the agent default. */
  modeId?: string;
  /** Ordered explicit Brain choices that must be applied before readiness. */
  configSelections?: Array<{ configId: string; value: string }>;
  /** Adapter-resolved live permission policy; separate from ACP agent-specific session modes. */
  permissionMode?: NonNullable<SessionSnapshot['permissionMode']>;
  /** Adapter-authenticated request-metadata vocabulary; never inferred from ACP `_meta`. */
  permissionMetadataSource?: 'codex-acp';
  /** Fleet-managed ours proxies must never receive the obsolete presence-sensitive flag. */
  scrubObsoleteOursAutostart?: boolean;
  /**
   * MCP servers the ROLE declares, for every session/new, resume and load.
   * Omitted preserves inherited configuration (encoded as ACP's required `[]`);
   * an explicit empty array disables every inherited server through the
   * authenticated bundled-adapter compatibility path.
   */
  mcpServers?: AcpMcpServer[];
  /**
   * Adapter-supplied `_meta` for session/new — the only route by which a
   * capability the CLI takes as a flag reaches an agent that accepts none.
   * Per-agent vocabulary, so the ADAPTER decides whether there is anything to
   * send; this layer only forwards it. Never sent on resume or load: it carries
   * session-creation options the agent has already applied.
   */
  sessionMeta?: Record<string, unknown>;
  log(line: string): void;
  /** Test seam for the cancel-escalation grace period; production uses the default. */
  cancelGraceMs?: number;
  /** Test seam for SIGTERM -> SIGKILL escalation after an ignored cancellation. */
  cancelTerminateGraceMs?: number;
  /** How long a pending permission may wait for a human before it expires. */
  permissionTimeoutMs?: number;
  /** Grace after the last controller detaches before the unattended policy applies. */
  controllerGraceMs?: number;
  /** Test seam; production uses AFTER_TOOL_BOUNDARY_TIMEOUT_MS. */
  afterToolBoundaryTimeoutMs?: number;
  /** Test seam; production uses STEERING_OCCUPANCY_IDLE_MS. */
  steeringOccupancyIdleMs?: number;
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
export class AcpSession implements AgentSession {
  readonly backend = 'acp' as const;
  readonly capabilities;
  readonly pid: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events: SessionEvents;
  private readonly conversation: ConversationEventStore;
  /** Cursor before this runner generation began; older durable events stay off the live console. */
  private readonly conversationStartCursor?: string;
  /** New on every runner start; permission/turn IDs from prior generations are stale. */
  private readonly sessionGeneration = randomUUID();
  /** True while `session/load` replays history as ordinary updates. */
  private replaying = false;
  private readonly sessionFile: string;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private connection: acp.ClientConnection;
  private sessionId?: string;
  private readiness: SessionSnapshot['readiness'] = 'starting';
  /**
   * Last non-replayed session update from the agent. `readiness` cannot answer
   * "is this agent working" for a steered turn (FLEET-002), and this is the
   * evidence that can.
   */
  private lastUpdateAt?: string;
  private lastError?: string;
  private promptTail: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;
  private exit: ExitRecord | null = null;
  private steeringSupported = false;
  private agentCapabilities?: acp.AgentCapabilities;
  private runtimeModel?: RuntimeSelectorMetadata;
  private reasoningEffort?: RuntimeSelectorMetadata;
  private controllerCount = 0;
  private closing = false;
  /** Armed when the last controller detaches; unattended policy applies on fire. */
  private controllerGrace?: ReturnType<typeof setTimeout>;
  private cancelEscalation?: ReturnType<typeof setTimeout>;
  private cancelForceKill?: ReturnType<typeof setTimeout>;
  private cancelRecoveryReason?: string;
  /**
   * Held while a steering-started turn is believed to own the adapter. It is a
   * lease, not a latch: `steeringRelease` always fires, so the role can never be
   * stranded busy by a wake whose turn ended without telling anyone.
   */
  private steeringOccupied = false;
  private steeringRelease?: ReturnType<typeof setTimeout>;
  /**
   * Rejects the moment the adapter process is gone. Every in-flight ACP request
   * races it, so a dead adapter can never leave a turn — and therefore a
   * scheduled run's `activeRunId` or an admission claim — unsettled forever.
   */
  private readonly terminated: Promise<never>;
  private terminate!: (error: Error) => void;
  /** ACP-authenticated in-flight calls, including independently reserved permissions. */
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  private stallWatchdog?: StallWatchdog;
  private stallToolHistory?: StallToolHistory;
  private stallRecoveryClaimed = false;
  private managedTurnCount = 0;
  private steeringWasUsed = false;
  private steeringRequests = 0;
  private retryNativeTurnId?: string;
  private stallTimer?: ReturnType<typeof setInterval>;
  private stallAttempt?: {
    turnId: string; recoveryId: string; ready: Promise<boolean>;
    superseded: boolean; report(status: StallStatus): void;
    recoveryStartedAt?: number; resumed: boolean; blocked: boolean;
  };
  private readonly toolBoundaryWaiters = new Set<() => void>();
  private activeTurn?: {
    toolEvidence: Map<string, string>; planEvidence?: string;
    startedAt: number; toolIds: Set<string>; lastProgressAt: number; progressCount: number; transportFailures: number; boundaryUnknown: boolean;
    id: string; output: string; origin?: SubmitPromptOptions['origin'];
    cancellationSource?: TurnCancellationSource;
    cancellationWait?: Promise<void>;
    cancellationDeadlineExceeded?: boolean;
    settled: Promise<void>;
    settle(): void;
  };

  private constructor(
    private readonly options: AcpSessionOptions,
    child: ChildProcessWithoutNullStreams,
    connection: acp.ClientConnection,
  ) {
    this.child = child;
    this.connection = connection;
    this.pid = child.pid ?? -1;
    this.capabilities = sessionBackendCapabilities('acp', options.harness);
    this.events = new SessionEvents(join(options.stateDir, '.session-events.jsonl'));
    this.conversation = new ConversationEventStore(join(options.stateDir, '.conversation'), {
      roleId: options.name, log: line => options.log(`[${options.name}] ${line}`),
    });
    this.conversationStartCursor = this.conversation.lastCursor();
    this.sessionFile = join(options.stateDir, '.acp-session-id');
    this.terminated = new Promise<never>((_resolve, reject) => { this.terminate = reject; });
    // Nothing awaits this promise until a request races it; an unobserved
    // rejection here must never take the whole runner down.
    this.terminated.catch(() => undefined);
    child.stderr.on('data', chunk => options.log(`[${options.name}] acp: ${String(chunk).trimEnd()}`));
    child.once('exit', (code, signal) => {
      if (this.stallTimer) clearInterval(this.stallTimer);
      this.stallTimer = undefined;
      if (this.cancelForceKill) clearTimeout(this.cancelForceKill);
      this.cancelForceKill = undefined;
      this.releaseSteeringOccupancy('adapter exited');
      // Record the child's real exit code/signal while the truth is available.
      const classified = classifyChildExit(code, signal);
      this.exit = this.cancelRecoveryReason
        ? { ...classified, detail: `${this.cancelRecoveryReason}; ${classified.detail}` }
        : classified;
      options.log(`[${options.name}] acp: agent exited (${code ?? signal ?? 'unknown'})`);
      if (this.readiness !== 'failed') {
        this.readiness = 'failed';
        this.lastError = `ACP agent ${this.exit.detail}`;
      }
      // A request whose peer no longer exists will never answer. Fail it here
      // rather than trusting the transport to notice the closed stream.
      this.terminate(new SessionControlError('offline', `ACP agent ${this.exit.detail}`));
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
    const disableInheritedCodexMcp = options.permissionMetadataSource === 'codex-acp'
      && options.mcpServers !== undefined && options.mcpServers.length === 0;
    // Obsolete ours-mcp lifecycle flags are presence-sensitive. The shared
    // daemon remains operator-owned; managed ACP children are clients only.
    const childEnv = {
      ...process.env,
      ...options.env,
    };
    if (options.scrubObsoleteOursAutostart) delete childEnv.OURS_AUTOSTART;
    Object.assign(childEnv,
      // Write both states for the authenticated proxy: a stale ambient `1`
      // must never leak explicit-empty semantics into a later inherited role.
      options.permissionMetadataSource === 'codex-acp'
        ? { [CODEX_DISABLE_INHERITED_MCP_ENV]: disableInheritedCodexMcp ? '1' : '0' }
        : {});
    const child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    let instance: AcpSession | undefined;
    const app = acp.client({ name: 'ours-fleet' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (instance && (!instance.sessionId || params.sessionId === instance.sessionId))
          instance.recordUpdate(params.update);
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
      instance.startStallWatchdog();
      instance.recoverOpenPrompts();
      return instance;
    } catch (error) {
      instance.fail(error);
      await instance.close();
      throw error;
    }
  }

  /**
   * Honest restart recovery: a prompt that was admitted but never
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
    // child.killed only means kill() successfully SENT a signal. A process may
    // ignore SIGTERM and remain alive. exitCode or signalCode is the actual
    // terminal fact (signal exits deliberately leave exitCode null).
    return this.child.exitCode === null && (this.child.signalCode ?? null) === null;
  }

  /**
   * Take the occupancy lease for a turn the adapter started on its own behalf.
   * Refreshed by every adapter update, so it tracks work actually happening
   * rather than a fixed guess at how long a wake takes.
   */
  private holdSteeringOccupancy(): void {
    if (this.closing || !this.isAlive()) return;
    this.steeringOccupied = true;
    this.refreshSteeringOccupancy();
  }

  private refreshSteeringOccupancy(): void {
    if (!this.steeringOccupied) return;
    if (this.steeringRelease) clearTimeout(this.steeringRelease);
    this.steeringRelease = setTimeout(
      () => this.releaseSteeringOccupancy('adapter silent'),
      this.options.steeringOccupancyIdleMs ?? STEERING_OCCUPANCY_IDLE_MS);
    this.steeringRelease.unref?.();
  }

  /**
   * Every exit from occupancy comes through here, including the ones that are
   * not the timer: a real turn boundary, close, and adapter exit. A lease that
   * can leak is worse than the bug it fixes — it would leave the role reporting
   * `running` forever and starve scheduled admission permanently.
   */
  private releaseSteeringOccupancy(reason: string): void {
    if (this.steeringRelease) clearTimeout(this.steeringRelease);
    this.steeringRelease = undefined;
    if (!this.steeringOccupied) return;
    this.steeringOccupied = false;
    this.options.log(
      `[${this.options.name}] steering-started turn no longer holds the adapter (${reason})`);
  }

  snapshot(): SessionSnapshot {
    return {
      backend: 'acp',
      alive: this.isAlive(),
      // A steering-started turn is real work with no prompt id. Reporting the
      // session idle while it runs is what let the arbiter admit a scheduled
      // prompt into a busy adapter, whose `session/prompt` then never returned
      // a stopReason and ended in a cancellation deadline and a SIGTERM.
      readiness: this.readiness === 'idle' && this.steeringOccupied
        ? 'running' : this.readiness,
      sessionId: this.sessionId,
      lastError: this.lastError,
      pendingPermissionId: this.pendingPermissions.keys().next().value as string | undefined,
      runtimeModel: this.runtimeModel,
      reasoningEffort: this.reasoningEffort,
      permissionMode: this.options.permissionMode,
      activity: {
        activeToolCalls: this.activeToolCalls.size,
        ...(this.lastUpdateAt ? { lastUpdateAt: this.lastUpdateAt } : {}),
      },
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
    else if (this.activeTurn) this.activeTurn.boundaryUnknown = true;
  }

  private reservePermission(toolCallId: string | undefined, permissionId: string): void {
    if (toolCallId) this.toolCall(toolCallId).permissions.set(permissionId, 'pending');
    else if (this.activeTurn) this.activeTurn.boundaryUnknown = true;
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
   * Steering is an optional admission fast path, not the only safe way to
   * deliver a wake. Codex can reject `_session/steering` while a long-running
   * turn is between tools. Queue one ordinary, non-cancelling prompt in that
   * case and wait for its terminal result. This keeps the monitor's cursor
   * uncommitted until the wake really runs and, critically, keeps one rejected
   * steering response from becoming a tight replay loop.
   */
  private async steerOrQueueWake(
    text: string, options: SubmitPromptOptions,
  ): Promise<TurnResult> {
    if (this.stallRecoveryClaimed)
      return this.submitPrompt(text, { ...options, interrupt: false, steer: false });
    const steered = await this.steerPrompt(text);
    if (steered.accepted || steered.detail !== 'ACP steering failed'
        || this.closing || !this.isAlive()) return steered;
    const queued = await this.submitPrompt(text, { ...options, interrupt: false, steer: false });
    return {
      ...queued,
      detail: `steering rejected; queued delivery ${queued.detail ?? queued.outcome}`,
    };
  }

  /**
   * Monitor-only safe-boundary delivery. Steering is the preferred live
   * insertion and rejected steering is queued: this path never calls
   * session/cancel and never resolves a pending permission.
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
      const result = await this.steerOrQueueWake(text, options);
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
    const result = await this.steerOrQueueWake(text, options);
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
    if (this.stallRecoveryClaimed && options.origin?.kind === 'fleet-monitor')
      options = { ...options, interrupt: false, steer: false };
    if (this.cancelRecoveryReason)
      throw new SessionControlError(
        'control-unavailable',
        'ACP adapter restart is in progress after the cancellation deadline',
        ACP_CANCEL_DEADLINE_EXCEEDED,
      );
    if (this.closing || !this.sessionId || !this.isAlive())
      throw new SessionControlError('offline', this.lastError ?? 'ACP session is offline');
    const delivery = options.interrupt
      ? await this.prepareInterruptingDelivery(options.interruptSource ?? 'local-console')
      : undefined;
    // Interrupting delivery must still use steering when supported. With no
    // live turn, the extension starts one and acknowledges `startedNewTurn`
    // immediately; a normal session/prompt would keep the monitor blocked until
    // the entire wake-triggered turn terminated.
    if (options.steer && this.steeringSupported) {
      const promptId = randomUUID();
      return {
        promptId, queuedBehind: 0, completion: this.steerPrompt(text), origin: options.origin,
        ...(delivery ? { delivery } : {}),
      };
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
    return {
      promptId, queuedBehind, completion, origin: options.origin,
      delivery: delivery ?? (queuedBehind > 0 ? 'queued' : 'started'),
    };
  }

  /**
   * Prepare the session for a prompt that asked to pre-empt current work.
   *
   * The old behaviour was one unconditional `session/cancel` notification
   * followed immediately by `session/prompt`. That is what produced the owner's
   * "request failed before completion":
   *
   *  - `cancelActive` only awaits settlement when `this.activeTurn` is set, and
   *    a turn the ADAPTER started (steering's `startedNewTurn`) is never tracked
   *    here. So the cancel raced the adapter's own transcript repair and the new
   *    prompt landed while the last assistant message still held an unresolved
   *    `tool_use` — rejected with `stop_reason=tool_use`.
   *  - With nothing running at all, it still sent the cancel, and the prompt
   *    landed on a bare interrupted user message — rejected with
   *    `stop_reason=null`.
   *
   * So: never cancel across a tool boundary, and never cancel something whose
   * settlement cannot be awaited. Everything else is queued, which the ACP queue
   * already does correctly. The returned state is what the caller may claim to a
   * human — `interrupted` only when a turn really was cancelled.
   */
  private async prepareInterruptingDelivery(
    source: TurnCancellationSource,
  ): Promise<PromptDelivery> {
    if (!this.sessionId) return 'started';
    // No fleet-tracked turn to await. Either the session is idle — cancelling it
    // corrupts the transcript for no gain — or the adapter is running a turn
    // fleet never started, whose settlement nothing here can wait for. Queue in
    // both cases: the ACP queue already orders this correctly.
    if (!this.activeTurn) return this.activeToolCalls.size > 0 ? 'deferred' : 'started';
    // A tracked turn IS safe to cancel: cancelActive settles pending permissions
    // and awaits the turn's own settlement before this returns, so the prompt
    // below cannot race the adapter's transcript repair.
    await this.cancelActive(source);
    return 'interrupted';
  }

  /**
   * Durably record a prompt admission BEFORE acceptance is returned. Browser
   * admissions are transactional — a prompt the ledger cannot hold is refused,
   * because an acknowledged-then-lost prompt is worse than an error. Every
   * other source degrades to best-effort so the agent keeps working.
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

  /**
   * Explicit cancellation on behalf of a human or an operator. Forced recovery
   * is reported as an outcome, never as a thrown failure: by the time this
   * resolves the turn is over either way, and only the durable-ingress path
   * (`queuePrompt({ interrupt: true })`) needs the typed error, because only it
   * still owes an undelivered message a replay.
   */
  async interrupt(source: TurnCancellationSource = 'local-console'): Promise<InterruptOutcome> {
    try {
      await this.cancelActive(source);
      return { state: 'settled' };
    } catch (error) {
      if (error instanceof SessionControlError
          && error.reasonCode === ACP_CANCEL_DEADLINE_EXCEEDED)
        return { state: 'forced', reasonCode: ACP_CANCEL_DEADLINE_EXCEEDED };
      throw error;
    }
  }

  private async cancelActive(source: TurnCancellationSource): Promise<void> {
    if (this.stallAttempt && source !== 'stall-watchdog' && source !== 'fleet-monitor')
      this.stallAttempt.superseded = true;
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
    }
    for (const [permissionId, pending] of [...this.pendingPermissions])
      this.settlePendingAutomatically(permissionId, pending, 'cancelled', undefined,
        'the turn was cancelled while this request was pending');
    if (active && this.activeTurn === active) {
      active.cancellationWait ??= this.awaitCancellationSettlement(active);
      await active.cancellationWait;
    }
  }

  /**
   * Do not admit work behind a turn whose adapter may already require restart.
   * A cooperative adapter settles this promise immediately through runPrompt's
   * finally block. A stubborn adapter receives SIGTERM at the deadline and
   * SIGKILL after one more bounded grace; callers get a typed recovery error so
   * durable ingress can leave the next request replayable for the resumed run.
   */
  private awaitCancellationSettlement(active: NonNullable<AcpSession['activeTurn']>): Promise<void> {
    const settleMs = this.options.cancelGraceMs ?? CANCEL_SETTLE_GRACE_MS;
    const deadline = new Promise<void>((resolve, reject) => {
      this.cancelEscalation = setTimeout(() => {
        // Both bail-outs must SETTLE the race. Returning silently once left the
        // caller — and the arbiter's exclusive tail behind it — awaiting a
        // promise nothing would ever resolve.
        if (this.activeTurn !== active) { resolve(); return; }
        if (!this.isAlive()) { resolve(); return; }
        active.cancellationDeadlineExceeded = true;
        this.cancelRecoveryReason = ACP_CANCEL_DEADLINE_EXCEEDED;
        this.readiness = 'failed';
        this.lastError = `${ACP_CANCEL_DEADLINE_EXCEEDED}: ACP turn did not settle within ${settleMs}ms`;
        this.options.log(`[${this.options.name}] ${this.lastError}; restarting adapter with resume`);
        this.events.emit('error', {
          turnId: active.id, origin: active.origin, status: ACP_CANCEL_DEADLINE_EXCEEDED,
          text: this.lastError,
        });
        this.conversation.appendSafe({
          kind: 'session.state', sessionGeneration: this.sessionGeneration,
          acpSessionId: this.sessionId,
          promptId: active.id, turnId: active.id,
          payload: { status: 'failed', detail: this.lastError },
        });
        this.child.kill('SIGTERM');
        const terminateMs = this.options.cancelTerminateGraceMs ?? CANCEL_TERMINATE_GRACE_MS;
        this.cancelForceKill = setTimeout(() => {
          if (this.child.exitCode === null) {
            this.options.log(`[${this.options.name}] ${ACP_CANCEL_DEADLINE_EXCEEDED}: `
              + `adapter ignored SIGTERM for ${terminateMs}ms; sending SIGKILL`);
            this.child.kill('SIGKILL');
          }
        }, terminateMs);
        this.cancelForceKill.unref?.();
        reject(new SessionControlError(
          'control-unavailable',
          'ACP adapter restart is in progress after the cancellation deadline',
          ACP_CANCEL_DEADLINE_EXCEEDED,
        ));
      }, settleMs);
      this.cancelEscalation.unref?.();
    });
    return Promise.race([active.settled, deadline]);
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
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
    if (this.stallAttempt) this.stallAttempt.superseded = true;
    if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
    this.cancelEscalation = undefined;
    if (this.cancelForceKill) clearTimeout(this.cancelForceKill);
    this.cancelForceKill = undefined;
    if (this.controllerGrace) clearTimeout(this.controllerGrace);
    this.controllerGrace = undefined;
    this.releaseSteeringOccupancy('session closed');
    for (const [permissionId, pending] of [...this.pendingPermissions])
      this.settlePendingAutomatically(permissionId, pending, 'cancelled', undefined,
        'the session closed while this request was pending');
    this.releaseAllTools();
    if (this.sessionId && this.agentCapabilities?.sessionCapabilities?.close != null) {
      await this.connection.agent.request(
        acp.methods.agent.session.close, { sessionId: this.sessionId }).catch(() => undefined);
    }
    this.connection.close();
    if (this.isAlive()) this.child.kill('SIGTERM');
    // The transport is gone: nothing still awaiting an ACP answer can get one.
    this.terminate(new SessionControlError('offline', 'the ACP session was closed'));
    this.conversation.appendSafe({
      kind: 'session.state', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, payload: { status: 'offline' },
    });
    this.conversation.close();
  }

  /** ACP requires the field. Bundled agents treat [] as no client-added servers. */
  private declaredMcpServers(): AcpMcpServer[] {
    return this.options.mcpServers ?? [];
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
    this.agentCapabilities = initialized.agentCapabilities;
    const steering = initialized._meta?.steering;
    this.steeringSupported = steering !== null && typeof steering === 'object'
      && (steering as { supported?: unknown }).supported === true;

    const persisted = this.options.mode === 'resume' && existsSync(this.sessionFile)
      ? readFileSync(this.sessionFile, 'utf8').trim()
      : '';
    let advertisedConfigOptions: acp.SessionConfigOption[] | null | undefined;
    let advertisedModelId: string | undefined;
    if (persisted && this.agentCapabilities?.sessionCapabilities?.resume != null) {
      const resumed = await this.connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: persisted,
        cwd: this.options.cwd,
        mcpServers: this.declaredMcpServers(),
      });
      advertisedConfigOptions = resumed.configOptions;
      advertisedModelId = (resumed as { models?: { currentModelId?: string } }).models?.currentModelId;
      this.captureRuntimeMetadata(advertisedConfigOptions, advertisedModelId);
      this.sessionId = persisted;
    } else if (persisted && this.agentCapabilities?.loadSession) {
      // `session/load` replays prior history as ordinary updates before the
      // response; those records carry `agent_replay` provenance, never `agent`.
      this.replaying = true;
      try {
        const loaded = await this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: persisted,
          cwd: this.options.cwd,
          mcpServers: this.declaredMcpServers(),
        }) as { configOptions?: acp.SessionConfigOption[] | null };
        advertisedConfigOptions = loaded.configOptions;
        advertisedModelId = (loaded as { models?: { currentModelId?: string } }).models?.currentModelId;
        this.captureRuntimeMetadata(advertisedConfigOptions, advertisedModelId);
      } finally { this.replaying = false; }
      this.sessionId = persisted;
    } else {
      const created = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.options.cwd,
        mcpServers: this.declaredMcpServers(),
        ...(this.options.sessionMeta ? { _meta: this.options.sessionMeta } : {}),
      }) as { sessionId: string; configOptions?: acp.SessionConfigOption[] | null;
        models?: { currentModelId?: string } };
      this.sessionId = created.sessionId;
      advertisedConfigOptions = created.configOptions;
      advertisedModelId = created.models?.currentModelId;
      this.captureRuntimeMetadata(advertisedConfigOptions, advertisedModelId);
    }
    for (const selection of this.options.configSelections ?? []) {
      if (!advertisedConfigOptions?.some(option => option.id === selection.configId)) {
        if (selection.configId === 'reasoning_effort'
            && reasoningFromModelId(advertisedModelId)?.value === selection.value) continue;
        throw new Error(
          `ACP agent did not advertise required session config option '${selection.configId}'`);
      }
      let configured: { configOptions: acp.SessionConfigOption[] };
      try {
        configured = await this.connection.agent.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId: this.sessionId, configId: selection.configId, value: selection.value },
        ) as { configOptions: acp.SessionConfigOption[] };
      } catch (error) {
        throw new Error(
          `ACP agent refused required session config option '${selection.configId}' value '${selection.value}': `
          + (error instanceof Error ? error.message : String(error)));
      }
      advertisedConfigOptions = configured.configOptions;
      this.captureRuntimeMetadata(advertisedConfigOptions, advertisedModelId);
      const applied = advertisedConfigOptions.find(option => option.id === selection.configId);
      if (applied?.currentValue !== selection.value)
        throw new Error(
          `ACP agent did not apply required session config option '${selection.configId}' value '${selection.value}'`);
    }
    // Do not persist a session until every required Brain choice is live. A
    // failed startup closes the ACP session; persisting its id first would make
    // a later resume repeatedly target that invalid session.
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

  private captureRuntimeMetadata(
    options: acp.SessionConfigOption[] | null | undefined, modelId?: string,
  ): void {
    this.runtimeModel = runtimeSelector(options, 'model');
    this.reasoningEffort = runtimeSelector(options, 'thought_level') ?? reasoningFromModelId(modelId);
  }

  private startStallWatchdog(): void {
    if (!this.options.stallRecovery) return;
    const timeoutMs = this.options.stallRecovery.timeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.stallRecoveryClaimed = hasStallRecoveryClaim(this.options.stateDir, this.sessionId!);
    this.stallToolHistory = new StallToolHistory(this.options.stateDir, this.sessionId!, this.options.mode === 'resume');
    this.stallWatchdog = new StallWatchdog({
      stateDir: this.options.stateDir, timeoutMs, previouslyClaimed: this.stallRecoveryClaimed, now: () => Date.now(),
      observe: () => this.stallObservation(),
      recover: (observed, report) => this.recoverStall(observed, report),
      diagnostic: diagnostic => {
        if (['interrupt_requested', 'blocked_previous_attempt', 'blocked_persistence'].includes(diagnostic.status))
          this.stallRecoveryClaimed = true;
        this.events.emit('stall_recovery', { status: diagnostic.status, stallDiagnostic: diagnostic });
        this.options.log(`[${this.options.name}] ACP stall recovery: ${diagnostic.status}; `
          + 'inspect structured session events before continuing; never replay uncertain side effects');
      },
    });
    this.stallTimer = setInterval(() => this.checkStallWatchdog(),
      this.options.stallRecovery.tickMs ?? Math.min(10_000, timeoutMs));
    this.stallTimer.unref?.();
  }

  private checkStallWatchdog(): void {
    void this.stallWatchdog?.tick();
    const attempt = this.stallAttempt;
    if (attempt?.recoveryStartedAt === undefined || attempt.blocked || attempt.superseded) return;
    const observed = this.stallObservation();
    if (!observed?.safe || observed.turnId !== attempt.recoveryId) return;
    const last = observed.lastProgressAt || attempt.recoveryStartedAt;
    const timeoutMs = this.options.stallRecovery?.timeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    if (Date.now() - last >= timeoutMs * 2) {
      attempt.blocked = true;
      try { attempt.report('blocked_restall'); } catch { /* durable claim already prevents retry */ }
    }
  }

  private stallObservation(): StallObservation | undefined {
    const active = this.activeTurn;
    if (!active || !this.sessionId) return undefined;
    return {
      sessionId: this.sessionId, generation: this.sessionGeneration, turnId: active.id,
      startedAt: active.startedAt, lastProgressAt: active.lastProgressAt, progressCount: active.progressCount,
      transportFailures: active.transportFailures,
      boundaryEvidenceAvailable: this.stallToolHistory?.available() !== false,
      safe: this.isAlive() && !this.closing && this.readiness === 'running'
        && !active.cancellationSource && !active.boundaryUnknown && !this.steeringOccupied
        && this.steeringRequests === 0 && this.stallToolHistory?.available() !== false
        && this.activeToolCalls.size === 0 && this.pendingPermissions.size === 0,
    };
  }

  private async recoverStall(observed: StallObservation, report: (status: StallStatus) => void): Promise<void> {
    const current = this.stallObservation();
    if (!current?.safe || current.turnId !== observed.turnId
        || current.lastProgressAt !== observed.lastProgressAt || current.progressCount !== observed.progressCount) {
      report('superseded');
      return;
    }
    const active = this.activeTurn!;
    let resolveReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
    const attempt: NonNullable<AcpSession['stallAttempt']> = this.stallAttempt = {
      turnId: active.id, recoveryId: randomUUID(), ready, superseded: false,
      report, resumed: false, blocked: false,
    };
    active.cancellationSource = 'stall-watchdog';
    // This intentionally does not use cancelActive: automatic recovery may
    // never enter its SIGTERM/SIGKILL escalation or settle a permission.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        (async () => {
          await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId! });
          await active.settled;
          return true;
        })(),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), this.options.stallRecovery?.cancelWaitMs ?? CANCEL_SETTLE_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (!completed || attempt.superseded || this.closing || !this.isAlive()) {
        attempt.blocked = true;
        report(attempt.superseded || this.closing ? 'superseded' : 'blocked_cancel');
        resolveReady(false);
      } else resolveReady(true);
    } catch {
      attempt.blocked = true;
      try { report('blocked_cancel'); } finally { resolveReady(false); }
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Keep the original queue slot (including startup) until recovery finishes. */
  private async runPrompt(
    text: string, turnId: string = randomUUID(), origin?: SubmitPromptOptions['origin'],
  ): Promise<TurnResult> {
    const result = await this.runSinglePrompt(text, turnId, origin);
    const attempt = this.stallAttempt;
    if (!attempt || attempt.turnId !== turnId) return result;
    const ready = await attempt.ready;
    if (attempt.superseded || this.closing) return result;
    if (!ready || result.outcome !== 'cancelled' || result.cancellationSource !== 'stall-watchdog') {
      // An RPC error/refusal/ambiguous terminal answer to cancellation is not
      // permission to replay work or to fail startup and restart the process.
      if (!attempt.blocked) {
        attempt.blocked = true;
        try { attempt.report('blocked_cancel'); } catch { /* claim remains durable */ }
      }
      return turnResult(true, 'cancelled', 'diagnostic cancellation requires operator attention',
        undefined, 'stall-watchdog');
    }
    try {
      attempt.report('recovery_started');
      attempt.recoveryStartedAt = Date.now();
      const recoveryOrigin: PromptOrigin = origin?.kind === 'scheduled-loop'
        ? origin : { kind: 'stall-watchdog' };
      this.admitToLedger(attempt.recoveryId, STALL_RECOVERY_PROMPT, 0, { origin: recoveryOrigin });
      const recovered = await this.runSinglePrompt(STALL_RECOVERY_PROMPT, attempt.recoveryId, recoveryOrigin);
      attempt.report(attempt.superseded ? 'superseded'
        : recovered.succeeded && attempt.resumed ? 'recovery_completed' : 'blocked_recovery');
      // A failed diagnostic turn must not make startup tear down the session.
      return recovered.succeeded && attempt.resumed ? recovered : turnResult(true, 'cancelled',
        'diagnostic recovery requires operator attention', undefined, 'stall-watchdog');
    } catch {
      return turnResult(true, 'cancelled', 'diagnostic recovery requires operator attention',
        undefined, 'stall-watchdog');
    }
  }

  private async runSinglePrompt(
    text: string, turnId: string = randomUUID(), origin?: SubmitPromptOptions['origin'],
  ): Promise<TurnResult> {
    if (!this.sessionId || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is offline');
    this.readiness = 'running';
    this.managedTurnCount++;
    this.retryNativeTurnId = undefined;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.activeTurn = { toolEvidence: new Map(), startedAt: Date.now(), toolIds: new Set(), lastProgressAt: 0, progressCount: 0, transportFailures: 0, boundaryUnknown: false, id: turnId, output: '', origin, settled, settle };
    this.events.emit('state', { turnId, status: 'running', origin });
    this.conversation.appendSafe({
      kind: 'prompt.started', sessionGeneration: this.sessionGeneration,
      acpSessionId: this.sessionId, promptId: turnId, turnId,
      source: conversationSource(origin).source, payload: {},
    });
    try {
      const response = await Promise.race([
        this.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: this.sessionId,
          prompt: promptContentBlocks(text, origin),
        }),
        this.terminated,
      ]);
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
      const escalated = this.activeTurn?.id === turnId
        && this.activeTurn.cancellationDeadlineExceeded;
      const detail = escalated
        ? this.lastError ?? ACP_CANCEL_DEADLINE_EXCEEDED
        : (error as Error)?.message ?? String(error);
      this.lastError = origin?.kind === 'scheduled-loop' ? 'scheduled-loop turn failed' : detail;
      this.readiness = this.isAlive() ? 'idle' : 'failed';
      this.events.emit('error', {
        turnId, origin: this.activeTurn?.cancellationSource === 'stall-watchdog'
          ? { kind: 'stall-watchdog' } : origin,
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
      // A turn this client owned has ended, so the adapter has reported a
      // boundary: whatever a steering call started before it is over too. This
      // is the release path that does not depend on the silence timer.
      this.releaseSteeringOccupancy('turn boundary');
      if (this.activeTurn?.id === turnId) {
        this.activeTurn.settle();
        if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
        this.cancelEscalation = undefined;
        this.activeTurn = undefined;
      }
    }
  }

  private async steerPrompt(text: string): Promise<TurnResult> {
    this.steeringWasUsed = true;
    if (!this.sessionId || !this.isAlive())
      return turnResult(false, 'failed', this.lastError ?? 'ACP session is offline');
    this.steeringRequests++;
    try {
      const response = await Promise.race([
        this.connection.agent.request<SteeringResponse, {
          sessionId: string;
          prompt: Array<{ type: 'text'; text: string }>;
        }>('_session/steering', {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text }],
        }),
        this.terminated,
      ]);
      if (response.outcome === 'failed')
        return turnResult(false, 'failed', 'ACP steering failed');
      // `injected` joined a turn this client already owns and will settle.
      // `startedNewTurn` created one nobody owns: the adapter is working and
      // will never answer for it, so admission has to learn about it here or
      // not at all.
      if (response.outcome === 'startedNewTurn') this.holdSteeringOccupancy();
      return turnResult(true, 'inconclusive', response.outcome);
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.lastError = detail;
      this.events.emit('error', { text: detail });
      return turnResult(false, 'failed', detail);
    } finally { this.steeringRequests--; }
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
    if (this.isEffectiveCodexProtectedMcpApproval(params)) {
      // Protected MCP approval is already the tool's narrow gate. Never turn
      // this one decision into an adapter-wide standing grant.
      const option = choose(['allow_once']);
      const response = this.settleAutomatically(params, option, 'allowed',
        'permissionMode.fleetMode=allow',
        'the trusted Codex adapter authenticated a protected MCP approval request');
      if (option) this.allowPermission(toolCallId, permissionId);
      else this.releasePermission(toolCallId, permissionId);
      return Promise.resolve(response);
    }
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

  /**
   * Codex ACP 1.1.7 marks its protected MCP elicitation bridge on a locationless
   * execute request. The marker is meaningful only together with the runner's
   * independently supplied, adapter-authenticated metadata vocabulary and effective
   * mode: an arbitrary ACP process cannot gain this path by copying `_meta` alone.
   * Exact option ids/kinds bind recognition to the protected-MCP shape and keep
   * malformed requests on the ordinary fail-closed path.
   */
  private isEffectiveCodexProtectedMcpApproval(
    params: acp.RequestPermissionRequest,
  ): boolean {
    const locations = params.toolCall.locations ?? [];
    return this.options.permissionMetadataSource === 'codex-acp'
      && this.options.permissionMode?.fleetMode === 'allow'
      && params.toolCall.kind === 'execute'
      && params.toolCall.status === 'pending'
      && locations.length === 0
      && params._meta?.is_mcp_tool_approval === true
      && params.options.some(option =>
        option.optionId === 'allow_once' && option.kind === 'allow_once')
      && params.options.some(option =>
        option.optionId === 'decline' && option.kind === 'reject_once');
  }

  /** Pinned codex-acp 1.1.7 structured metadata, never stderr or assistant text. */
  private recordStallMetadata(update: acp.SessionUpdate): void {
    if (this.options.permissionMetadataSource !== 'codex-acp'
        || update.sessionUpdate !== 'session_info_update' || !this.activeTurn) return;
    const meta = update._meta?.codex;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
    const codex = meta as Record<string, unknown>;
    const status = codex.threadStatus;
    if (Object.prototype.hasOwnProperty.call(codex, 'threadStatus')) {
      const value = status && typeof status === 'object' && !Array.isArray(status)
        ? status as Record<string, unknown> : {};
      // Unknown or modal thread status is a permanent conservative fence for
      // this turn. A later delayed idle/active status must not clear it.
      if (value.type !== 'active' || !Array.isArray(value.activeFlags)
          || value.activeFlags.length > 0) this.activeTurn.boundaryUnknown = true;
    }
    const error = codex.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return;
    const value = error as Record<string, unknown>;
    const info = value.codexErrorInfo;
    if (value.willRetry !== true || typeof value.turnId !== 'string' || !value.turnId
        || !info || typeof info !== 'object' || Array.isArray(info)) return;
    if (!['responseStreamConnectionFailed', 'responseStreamDisconnected']
      .some(key => Object.prototype.hasOwnProperty.call(info, key))) return;
    // ACP 1.1.7 does not expose a native-turn-to-prompt mapping. Only the first
    // fresh managed turn with no steering can be correlated without guessing;
    // later/resumed turns retain the conservative generic no-progress path.
    if (this.options.mode !== 'fresh' || this.managedTurnCount !== 1 || this.steeringWasUsed) return;
    if (this.retryNativeTurnId && this.retryNativeTurnId !== value.turnId) {
      this.activeTurn.boundaryUnknown = true;
      return;
    }
    this.retryNativeTurnId = value.turnId;
    this.activeTurn.transportFailures++;
  }

  private recordUpdate(update: acp.SessionUpdate): void {
    // Replayed history is not current activity: `session/load` would otherwise
    // make a cold session look like it had just been working. The same reason
    // keeps it from extending the steering lease, which is evidence the adapter
    // is working right now — for a steering-started turn, the only evidence.
    if (!this.replaying) {
      this.lastUpdateAt = new Date().toISOString();
      this.refreshSteeringOccupancy();
    }
    if (!this.replaying && this.activeTurn) {
      this.recordStallMetadata(update);
      const active = this.activeTurn;
      const kind = update.sessionUpdate;
      if (this.options.stallRecovery && (kind === 'tool_call' || kind === 'tool_call_update')) {
        if (!update.toolCallId || active.toolIds.size >= 4096) active.boundaryUnknown = true;
        else active.toolIds.add(update.toolCallId);
        if (this.stallToolHistory?.observe(update.toolCallId, active.id) === false)
          active.boundaryUnknown = true;
      }
      let meaningful = ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
          && (update.content.type !== 'text' || update.content.text.length > 0))
        || kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan';
      if (this.options.stallRecovery && (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan')) {
        const fingerprint = createHash('sha256').update(JSON.stringify(update)).digest('hex');
        if (kind === 'plan') {
          meaningful = fingerprint !== active.planEvidence;
          active.planEvidence = fingerprint;
        } else if (active.toolEvidence.size < 4096 || active.toolEvidence.has(update.toolCallId)) {
          meaningful = fingerprint !== active.toolEvidence.get(update.toolCallId);
          active.toolEvidence.set(update.toolCallId, fingerprint);
        }
      }
      if (this.options.stallRecovery && ![
        'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan',
        'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update', 'usage_update',
      ].includes(kind)) active.boundaryUnknown = true;
      if (meaningful) {
        active.lastProgressAt = Date.now();
        active.progressCount++;
        active.transportFailures = 0;
        const attempt = this.stallAttempt;
        if (attempt?.recoveryId === active.id && !attempt.resumed) {
          attempt.resumed = true;
          try { attempt.report('progress_resumed'); } catch { attempt.blocked = true; }
        }
      }
    }
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
        else if (this.options.stallRecovery && this.activeTurn
            && !this.activeToolCalls.has(update.toolCallId)) this.activeTurn.boundaryUnknown = true;
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

  // ── conversation ledger access (AgentSession) ─────────────────────────────

  conversationPage(request: { after?: string; limit?: number } = {}): ConversationHandlePage {
    const floor = Number(this.conversationStartCursor ?? 0);
    const requested = Number(request.after ?? 0);
    let after = String(Math.max(
      Number.isSafeInteger(floor) ? floor : 0,
      Number.isSafeInteger(requested) ? requested : 0,
    ));
    const limit = Math.min(Math.max(request.limit ?? 200, 1), 1_000);
    let page = this.conversation.page({ after, limit });
    let visible = page.events.filter(event => this.isCurrentConversationEvent(event));
    // A resumed adapter may replay a page made entirely of prior session/load
    // history. Advance over it without exposing it or making the browser stop
    // before later current-session records.
    while (!visible.length && page.hasMore && page.nextCursor && page.nextCursor !== after) {
      after = page.nextCursor;
      page = this.conversation.page({ after, limit });
      visible = page.events.filter(event => this.isCurrentConversationEvent(event));
    }
    return {
      ...page,
      events: visible,
      snapshot: this.conversationSnapshot(),
    };
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
    return this.conversation.subscribe(event => {
      if (this.isCurrentConversationEvent(event)) listener(event);
    });
  }

  private isCurrentConversationEvent(event: ConversationEventV1): boolean {
    return event.sessionGeneration === this.sessionGeneration && event.source !== 'agent_replay';
  }

  private fail(error: unknown): void {
    this.lastError = (error as Error)?.message ?? String(error);
    this.readiness = 'failed';
    this.events.emit('error', { text: this.lastError });
  }
}
