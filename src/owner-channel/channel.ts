import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_OWNER_ATTACHMENT_MIME, canonicalCid,
  type OwnerAttachmentConfig, type OwnerChannelConfig,
} from '../config.js';
import { replaceFileAtomically } from '../atomic-file.js';
import { TaskRoomApplicationService } from '../application/task-room-service.js';
import { RoleLifecycleService } from '../application/role-command-service.js';
import { RoleRepository } from '../application/role-repository.js';
import { FleetQueryService } from '../application/fleet-query-service.js';
import { interruptSession, queueSessionPrompt } from '../application/session-mutations.js';
import { pickBackend } from '../supervisor/index.js';
import {
  ACP_CANCEL_DEADLINE_EXCEEDED, SessionControlError,
  type QueuedPrompt, type SessionEvent, type SessionHandle, type TurnResult,
} from '../session/types.js';
import { VERSION } from '../version.js';
import {
  renderMarkdownFailure, renderMarkdownResult, roomStatus, taskStatus,
} from '../rooms-tasks/markdown.js';
import {
  dispatchOwnerCommand, fleetCliOps, isOwnerCommandText,
  type OwnerCommandContext, type OwnerFleetOps,
} from './commands.js';
import type { ManagedFleetSpawnResult } from '../fleet-proxy.js';
import {
  OURS_BOUND_ELSEWHERE, OursSdkClient, oursErrorCode,
  type OursContactsView, type OursHistoryFile, type OursHistoryMessage,
  type OursInboundMessage, type OursIncomingMessage, type OursOps,
} from './ours-client.js';
import {
  ownerNotices,
  type OwnerCommentsState, type OwnerProgressPhase, type OwnerUpdatePhase,
} from './notices.js';
import {
  DuplicateSendError, OwnerAuthorizationState, OwnerChannelState, OwnerConversationState,
  type OwnerEntry,
} from './state.js';
import {
  OwnerTaskState, ownerTaskAuditId, ownerTaskDigest, type OwnerTaskPhase,
} from './tasks.js';
import {
  AttachmentRecoveryState, admitAttachments, cleanupAttachmentRoot,
  parseIncomingAttachments, parseRetrievedAttachments, prepareAttachmentDirectory,
  recoveredAttachment, removeRequestDirectory, safeField, validateAttachmentSelection,
  validateAttachmentRelaySelection, writeRecoveredAttachment,
  type AdmittedAttachment, type IncomingAttachment, type PendingAttachmentRequest,
} from './attachments.js';
import {
  acquireOwnerBinderLease, OWNER_BIND_HANDOFF_TIMEOUT_MS,
  type OwnerBinderDeps, type OwnerBinderLease,
} from './binder.js';
import { MessageRecoveryState, type PendingMessageClaim } from './message-recovery.js';

/**
 * The daemon's own inbound message shape. It used to be a hand-written union of
 * every field name the legacy connector might have rendered, because the
 * transport returned whatever text the tool produced; the typed client removes
 * the guesswork.
 */
type InboundMessage = OursInboundMessage;

interface AttachmentGroup {
  files: IncomingAttachment[];
  caption?: InboundMessage;
  recovery?: PendingAttachmentRequest;
}

export interface OwnerChannelOptions {
  role: string;
  /** Harness id of the role (e.g. 'claude-code', 'codex'); gates which slash commands may be forwarded. */
  harness: string;
  config: OwnerChannelConfig;
  session: SessionHandle;
  stateDir: string;
  env?: Record<string, string>;
  log(line: string): void;
  client?: OursOps;
  /** Test seam; production uses the detached ours-fleet CLI (`fleetCliOps`). */
  fleet?: OwnerFleetOps;
  /** Read-only restart validation; production uses the shared lifecycle service. */
  prepareRestart?: (role: string, mode: 'keep' | 'fresh') => Promise<void>;
  /** Forwarded to fleet CLI invocations spawned for owner commands. */
  configPath?: string;
  /** Deterministic clock/process seams for binder handoff tests. */
  binderDeps?: OwnerBinderDeps;
  /** Pre-acquired by the runner so the predecessor control socket remains reachable while waiting. */
  binderLease?: OwnerBinderLease;
}

export interface OwnerChannelHandle {
  start(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
  manage(request: OwnerChannelManagementRequest): Promise<OwnerChannelManagementResult>;
  /** Fleet-owned deterministic lifecycle notice; absent on legacy test doubles. */
  notifyFleetSpawn?(event: ManagedFleetSpawnResult): Promise<void>;
}

export type OwnerChannelManagementRequest =
  | { action: 'contact_list' }
  | { action: 'contact_invite'; name?: string }
  | { action: 'contact_add'; invite: string; name?: string }
  | { action: 'owner_list' }
  | { action: 'owner_authorize'; cid: string }
  | { action: 'owner_revoke'; cid: string }
  | { action: 'request_update'; requestId: string; phase: OwnerUpdatePhase; message: string }
  | { action: 'task_open'; requestId: string }
  | { action: 'task_report'; taskId: string; phase: OwnerTaskPhase; message: string }
  | { action: 'startup_failure' };

export type OwnerChannelManagementResult =
  | { action: 'contact_list'; contacts: OwnerContact[] }
  | { action: 'contact_invite'; invite: string }
  | { action: 'contact_add'; status: 'pending'; contact?: OwnerContact }
  | { action: 'owner_list'; integrity: { ok: boolean; error?: string }; owners: OwnerEntry[] }
  | { action: 'owner_authorize' | 'owner_revoke'; owner: OwnerEntry }
  | { action: 'request_update'; requestId: string; sequence: number }
  | { action: 'task_open'; taskId: string; expiresAt: string }
  | { action: 'task_report'; taskId: string; phase: OwnerTaskPhase; sequence: number; state: 'open' | 'closed' }
  | { action: 'startup_failure'; status: 'delivered' | 'duplicate' };

export type { OwnerUpdatePhase } from './notices.js';

export interface OwnerContact {
  cid: string;
  name: string;
  /** Structural, from which daemon collection the row came: established or pending. */
  status: string;
  /**
   * Retained for the `ours-fleet owner contact list` column. The daemon's typed
   * contact view has no such field, so it is always absent; it is not inferred
   * from anything a contact controls.
   */
  kind?: string;
  human?: { cid?: string; name?: string };
}

interface ActiveOwnerRequest {
  contact: string;
  wireId: string;
  requestId: string;
  outboundTail: Promise<void>;
  finalizing: boolean;
  lastUpdateAt?: number;
  updateCount: number;
  updateDigests: Set<string>;
  handledWireIds: string[];
  commentaryBuffer: string;
  commentaryCount: number;
  commentaryKeys: Set<string>;
  commentaryTimer?: ReturnType<typeof setTimeout>;
  commentaryDisabled: boolean;
}

const OWNER_UPDATE_MIN_INTERVAL_MS = 5_000;
const OWNER_UPDATE_MAX_COUNT = 20;
const OWNER_UPDATE_MAX_CHARS = 280;
const OWNER_UPDATE_MAX_BYTES = 1_024;
const PROACTIVE_MESSAGE_MAX_CHARS = 4_000;
const PROACTIVE_MESSAGE_MAX_BYTES = 16_384;
const RELAY_NACK_MEMORY = 512;
const COMMENTARY_FLUSH_MS = 750;
const COMMENTARY_MAX_CHARS = 1_600;
const COMMENTARY_MAX_BYTES = 6_400;
const COMMENTARY_MAX_UPDATES = 32;
const COMMENTARY_DEDUPE_LIMIT = 512;
const OWNER_WATCH_BACKOFF_MAX_MS = 30_000;
const OWNER_MESSAGE_BATCH_LIMIT = 200;
type OwnerWatchReason = 'OWNER_WATCH_CONNECTING' | 'OWNER_WATCH_CONNECTED'
  | 'OWNER_WATCH_STREAM_ERROR' | 'OWNER_WATCH_STATE_RECOVERED';

interface OwnerWatchState {
  version: 2;
  reconnects: number;
  consecutiveFailures: number;
  reason: OwnerWatchReason;
  updatedAt: string;
}

/** A relay attempt that failed only because no owner route exists yet. */
class RelayUnroutableError extends Error {}

/**
 * Fleet-owned trusted ingress. The agent never binds this identity and never
 * chooses its reply recipient; both are fixed from authenticated message data.
 */
export class OwnerChannel implements OwnerChannelHandle {
  private readonly client: OursOps;
  private readonly state: OwnerChannelState;
  private readonly authorizations: OwnerAuthorizationState;
  private readonly conversations: OwnerConversationState;
  private readonly tasks: OwnerTaskState;
  private readonly messageRecovery: MessageRecoveryState;
  private readonly attachmentRecovery: AttachmentRecoveryState;
  private readonly attachmentConfig: OwnerAttachmentConfig;
  private readonly attachmentRoot: string;
  /**
   * Wire IDs whose turn is still running. They stay OUT of the durable state
   * (a crash must replay them) but must not be queued twice while live.
   */
  private readonly inFlight = new Set<string>();
  /** Wires already NACKed to the managed agent, so a history replay stays quiet. */
  private readonly relayNacks = new Set<string>();
  /**
   * fleet.yaml declares the restart baseline; `/comments on|off` changes only
   * this process's effective value. The override is deliberately memory-only: a
   * restart must return to the reviewed, checked-in configuration rather than to
   * an unreviewable file that could silently keep an owner's channel quiet.
   */
  private readonly commentsBaseline: boolean;
  private commentsEnabled: boolean;
  private stopping = false;
  private watchTask?: Promise<void>;
  private watchAbort?: AbortController;
  private drainTask?: Promise<void>;
  private drainRequested = false;
  private readonly completionTasks = new Set<Promise<void>>();
  private readonly activeRequests = new Map<string, ActiveOwnerRequest>();
  private managementTail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private binder?: OwnerBinderLease;
  private binderOwnedInternally = false;

  private readonly fleetOps: OwnerFleetOps;
  private readonly prepareRestart: (role: string, mode: 'keep' | 'fresh') => Promise<void>;

  constructor(private readonly options: OwnerChannelOptions) {
    this.client = options.client ?? new OursSdkClient(
      options.env, line => options.log(`[${options.role}] owner channel ${line}`));
    this.fleetOps = options.fleet ?? fleetCliOps(options.role, options.configPath);
    this.prepareRestart = options.prepareRestart ?? (async (role, mode) => {
      const backend = pickBackend();
      const repository = new RoleRepository({ configPath: options.configPath });
      const query = new FleetQueryService({ repository, supervisor: backend });
      const lifecycle = new RoleLifecycleService({ repository,
        ops: { backend, binPath: process.argv[1], log: options.log },
        configPath: options.configPath,
        status: async roleId => (await query.detail(roleId)).status });
      await lifecycle.prepareRestart({ roleIds: [role], mode });
    });
    this.state = new OwnerChannelState(join(options.stateDir, '.owner-channel-state.json'));
    this.authorizations = new OwnerAuthorizationState(
      join(options.stateDir, '.owner-channel-owners.json'), options.config.owners);
    this.conversations = new OwnerConversationState(
      join(options.stateDir, '.owner-channel-conversations.json'));
    this.tasks = new OwnerTaskState(join(options.stateDir, '.owner-channel-tasks.json'));
    this.messageRecovery = new MessageRecoveryState(
      join(options.stateDir, '.owner-channel-message-recovery.json'));
    this.attachmentRecovery = new AttachmentRecoveryState(
      join(options.stateDir, '.owner-channel-attachment-recovery.json'));
    this.attachmentRoot = join(options.stateDir, '.owner-channel-inbox');
    // An absent key is a pre-`comments` configuration, which relayed live
    // commentary; only an explicit `false` turns it off.
    this.commentsBaseline = options.config.comments !== false;
    this.commentsEnabled = this.commentsBaseline;
    this.attachmentConfig = options.config.attachments ?? {
      enabled: true, max_files_per_request: 4, max_file_bytes: 10 * 1024 * 1024,
      max_request_bytes: 20 * 1024 * 1024, retention_ms: 24 * 60 * 60 * 1_000,
      allowed_mime: [...DEFAULT_OWNER_ATTACHMENT_MIME],
    };
    const integrity = this.authorizationIntegrity();
    if (!integrity.ok)
      options.log(`[${options.role}] owner authorization state corrupt; all owner mail disabled`);
    if (!this.conversations.integrity().ok)
      options.log(`[${options.role}] owner conversation state corrupt; proactive messages disabled`);
    if (!this.tasks.integrity().ok)
      options.log(`[${options.role}] owner task state corrupt; proactive reports disabled`);
    if (!this.messageRecovery.integrity())
      options.log(`[${options.role}] owner message recovery state corrupt; message intake disabled`);
    if (!this.attachmentRecovery.integrity())
      options.log(`[${options.role}] owner attachment recovery state corrupt; attachments disabled`);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.binderOwnedInternally = !this.options.binderLease;
    this.binder = this.options.binderLease ?? await acquireOwnerBinderLease(
      this.options.stateDir, this.options.role, this.options.config.identity, this.options.binderDeps);
    try {
      await this.client.start();
      const now = this.options.binderDeps?.now ?? (() => Date.now());
      const sleep = this.options.binderDeps?.sleep
        ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
      const bindStartedAt = now();
      for (;;) {
        try {
          await this.client.bindIdentity(this.options.config.identity);
          break;
        } catch (error) {
          // The predecessor's lease may still be in flight. Only the daemon's
          // own typed verdict may extend the handoff window: matching the
          // wording of an error message would let any other failure whose text
          // happens to say "bound to another live session" — including one
          // relayed from a peer — spin here for the whole timeout.
          const liveConflict = oursErrorCode(error) === OURS_BOUND_ELSEWHERE;
          if (!this.binder.inherited || !liveConflict
              || now() - bindStartedAt >= OWNER_BIND_HANDOFF_TIMEOUT_MS)
            throw error;
          await sleep(Math.min(50, Math.max(
            1, OWNER_BIND_HANDOFF_TIMEOUT_MS - (now() - bindStartedAt))));
        }
      }
    } catch (error) {
      await this.client.close().catch(closeError => this.logError('startup client close failed', closeError));
      if (this.binderOwnedInternally) this.binder.release();
      this.binder = undefined;
      throw error;
    }
    if (this.authorizationIntegrity().ok && this.tasks.integrity().ok)
      this.tasks.cleanup(Date.now(), this.effectiveOwners());
    if (this.attachmentRecovery.integrity()) {
      this.attachmentRecovery.cleanup(Date.now(), this.attachmentConfig.retention_ms);
      void cleanupAttachmentRoot(
        this.attachmentRoot, Date.now(), this.attachmentConfig.retention_ms,
      ).catch(error => this.logError('attachment crash cleanup failed', error));
    }
    this.ready = true;
    // Do not make role startup wait for an old owner request to finish a turn.
    // watchLoop itself drains before every establishment, including this first
    // one, so there is no drain-to-tip race.
    this.watchTask = this.watchLoop();
  }

  drain(): Promise<void> {
    this.drainRequested = true;
    if (this.drainTask) return this.drainTask;
    this.drainTask = (async () => {
      while (this.drainRequested && !this.stopping) {
        this.drainRequested = false;
        await this.drainAll();
      }
    })().finally(() => { this.drainTask = undefined; });
    return this.drainTask;
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.watchAbort?.abort();
    await this.watchTask?.catch(error => this.logError('watch shutdown failed', error));
    this.watchTask = undefined;
    await this.managementTail;
    try { await this.client.close(); }
    finally {
      if (this.binderOwnedInternally) this.binder?.release();
      this.binder = undefined;
    }
  }

  manage(request: OwnerChannelManagementRequest): Promise<OwnerChannelManagementResult> {
    const run = this.managementTail.then(() => this.manageNow(request));
    this.managementTail = run.then(() => undefined, () => undefined);
    return run;
  }

  notifyFleetSpawn(event: ManagedFleetSpawnResult): Promise<void> {
    const run = this.managementTail.then(async () => {
      if (!this.ready || this.stopping) throw new Error('owner-channel MCP client is unavailable');
      const model = event.model ? `, model ${event.model}` : '';
      const monitorPolicy = event.monitor.interrupt === true
        ? ' with interruption'
        : event.monitor.interrupt === 'after_tool' ? ' with after-tool steering' : '';
      const monitor = `${event.monitor.mode} monitor${monitorPolicy}`;
      const permission = event.permissionMode
        ? `; permission ${event.permissionMode.fleetMode}, native ${event.permissionMode.nativeMode}`
        : '';
      const inherited = event.inherited.length
        ? ` Supervisor inherited omitted defaults: ${event.inherited.join(', ')}.` : '';
      await this.sendProactiveMessage(
        `🧑‍💻 ${event.caller} spawned ${event.lifetime} agent ${event.role} `
          + `(${event.harness}/${event.session}${model}; ${monitor}${permission}).${inherited}`,
        `fleet-spawn\0${event.creationActionId}`, 0);
    });
    this.managementTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async manageNow(
    request: OwnerChannelManagementRequest,
  ): Promise<OwnerChannelManagementResult> {
    if (!this.ready || this.stopping) throw new Error('owner-channel MCP client is unavailable');
    switch (request.action) {
      case 'contact_list':
        return { action: request.action, contacts: await this.contacts() };
      case 'contact_invite': {
        this.assertLabel(request.name);
        // The invite is the blob field, not a sentence containing it. The MCP
        // surface answered with "One-time invite for X created (invite_id …).
        // Share this blob out-of-band …:\n<blob>" and the whole sentence was
        // handed out as the invite, so any rewording changed the payload.
        const { blob } = await this.client.generateInvite(request.name);
        if (typeof blob !== 'string' || !blob)
          throw new Error('the ours daemon returned no invite blob');
        return { action: request.action, invite: blob };
      }
      case 'contact_add': {
        if (typeof request.invite !== 'string' || !request.invite)
          throw new Error('invite is required');
        if (Buffer.byteLength(request.invite) > 48 * 1024)
          throw new Error('invite exceeds 49152 bytes');
        this.assertLabel(request.name);
        let added: { display: string; cid: string };
        try {
          added = await this.client.addContact({
            invite: request.invite, ...(request.name ? { name: request.name } : {}),
          });
        } catch {
          // Daemon errors are not allowed to reflect invite material through
          // the control response, CLI stderr, or supervisor logs.
          throw new Error('the ours daemon could not accept the contact invite');
        }
        const contact = this.contact(added.cid, added.display, 'pending');
        return { action: request.action, status: 'pending', ...(contact ? { contact } : {}) };
      }
      case 'owner_list':
        return {
          action: request.action, integrity: this.authorizationIntegrity(),
          owners: this.options.config.agent
            ? this.options.config.owners.map(cid => ({ cid, source: 'baseline', effective: true }))
            : this.authorizations.entries(),
        };
      case 'owner_authorize': {
        if (this.options.config.agent)
          throw new Error('live owner authorization is disabled when managed-agent CID gating is configured; edit fleet configuration instead');
        this.assertCid(request.cid);
        if (request.cid === this.options.config.agent)
          throw new Error('managed agent CID cannot also be authorized as an owner');
        if (this.authorizations.effective().has(request.cid))
          throw new Error(`owner '${request.cid}' is already authorized`);
        const contacts = await this.contacts();
        if (!contacts.some(contact => canonicalCid(contact.cid) === canonicalCid(request.cid)
          && ['established', 'active', 'connected'].includes(contact.status.toLowerCase())))
          throw new Error(`cannot authorize unknown or pending contact CID '${request.cid}'`);
        return { action: request.action, owner: this.authorizations.authorize(request.cid) };
      }
      case 'owner_revoke':
        if (this.options.config.agent)
          throw new Error('live owner revocation is disabled when managed-agent CID gating is configured; edit fleet configuration instead');
        this.assertCid(request.cid);
        {
          const owner = this.authorizations.revoke(request.cid);
          try { this.conversations.remove(request.cid); }
          catch (error) { this.logError('owner conversation revocation cleanup failed', error); }
          let revokedTasks = 0;
          try { revokedTasks = this.tasks.revoke(request.cid); }
          catch (error) { this.logError('owner task revocation cleanup failed', error); }
          if (revokedTasks)
            this.options.log(`[${this.options.role}] owner tasks revoked count=${revokedTasks}`);
          return { action: request.action, owner };
        }
      case 'request_update':
        if (this.options.config.agent)
          throw new Error('direct owner updates are disabled; the managed agent must message its owner-channel identity');
        return this.sendOwnerUpdate(request);
      case 'task_open':
        if (this.options.config.agent)
          throw new Error('owner task routes are disabled; the managed agent must message its owner-channel identity');
        return this.openOwnerTask(request.requestId);
      case 'task_report':
        if (this.options.config.agent)
          throw new Error('direct task reports are disabled; the managed agent must message its owner-channel identity');
        return this.sendOwnerTaskReport(request);
      case 'startup_failure': {
        const message = ownerNotices.startupHandoffFailed(
          this.options.role, this.options.config.identity);
        try { await this.sendProactiveMessage(message); }
        catch (error) {
          if (error instanceof DuplicateSendError)
            return { action: request.action, status: 'duplicate' };
          throw error;
        }
        return { action: request.action, status: 'delivered' };
      }
      default:
        throw new Error('unknown owner-channel management action');
    }
  }

  /**
   * The daemon reports established contacts and pending introductions as two
   * separate collections, so the status is structural rather than a word parsed
   * out of a rendered line. Nothing here can be spoofed by a contact's own
   * display name.
   */
  private async contacts(): Promise<OwnerContact[]> {
    const view = await this.client.listContacts();
    const rows = [
      ...(Array.isArray(view?.contacts) ? view.contacts : [])
        .map(row => this.contact(row?.container_id, row?.name, 'established', view)),
      ...(Array.isArray(view?.pending) ? view.pending : [])
        .map(row => this.contact(row?.container_id, row?.name, 'pending', view)),
    ];
    return rows.filter((row): row is OwnerContact => Boolean(row))
      .sort((a, b) => a.cid.localeCompare(b.cid));
  }

  private contact(
    cidValue: unknown, nameValue: unknown, status: 'established' | 'pending',
    view?: OursContactsView,
  ): OwnerContact | undefined {
    const cid = String(cidValue ?? '');
    if (!/^[A-Fa-f0-9]{64}$/.test(cid)) return undefined;
    const root = view?.roots?.[cid];
    const rootCid = String(root?.root_cid ?? '');
    return {
      cid,
      name: this.safeMetadata(nameValue ?? cid),
      status,
      ...(root ? { human: {
        ...(/^[A-Fa-f0-9]{64}$/.test(rootCid) ? { cid: rootCid } : {}),
        ...(root.root_name ? { name: this.safeMetadata(root.root_name) } : {}),
      } } : {}),
    };
  }

  private assertCid(cid: string): void {
    if (typeof cid !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(cid))
      throw new Error('contact CID must be exactly 64 hexadecimal characters');
  }

  private assertLabel(label: string | undefined): void {
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 200
      || /[\u0000-\u001f\u007f]/.test(label)))
      throw new Error('contact label must be 1-200 characters without control characters');
  }

  private safeMetadata(value: unknown): string {
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  }

  private async sendOwnerUpdate(
    request: Extract<OwnerChannelManagementRequest, { action: 'request_update' }>,
  ): Promise<OwnerChannelManagementResult> {
    if (!/^[a-f0-9]{64}$/.test(request.requestId))
      throw new Error('owner update request ID must be exactly 64 lowercase hexadecimal characters');
    if (!['working', 'approval', 'blocked'].includes(request.phase))
      throw new Error('owner update phase must be working, approval, or blocked');
    const active = this.activeRequests.get(request.requestId);
    if (!active || active.finalizing)
      throw new Error('owner request is not active or is already finalizing');
    const message = this.safeOwnerUpdate(request.message);
    const digest = createHash('sha256').update(`${request.phase}\0${message}`).digest('hex');
    if (active.updateDigests.has(digest)) throw new Error('duplicate owner update refused');
    if (active.updateCount >= OWNER_UPDATE_MAX_COUNT)
      throw new Error(`owner request is limited to ${OWNER_UPDATE_MAX_COUNT} authored updates`);
    const now = Date.now();
    if (active.lastUpdateAt !== undefined && now - active.lastUpdateAt < OWNER_UPDATE_MIN_INTERVAL_MS)
      throw new Error(`owner updates are rate-limited to one every ${OWNER_UPDATE_MIN_INTERVAL_MS}ms`);

    active.updateDigests.add(digest);
    active.updateCount++;
    active.lastUpdateAt = now;
    const sequence = active.updateCount;
    const notice = ownerNotices.authoredUpdate(request.phase, message);
    const send = active.outboundTail.then(async () => {
      await this.send(active.contact, notice, active.wireId);
      this.options.log(`[${this.options.role}] owner update ${active.requestId.slice(0, 12)} `
        + `phase=${request.phase} chars=${Array.from(message).length} sequence=${sequence} sent`);
    });
    active.outboundTail = send.catch(error => {
      this.logError(`owner update ${active.requestId.slice(0, 12)} delivery failed`, error);
    });
    await send;
    return { action: request.action, requestId: request.requestId, sequence };
  }

  private async sendProactiveMessage(
    messageValue: string, digestValue = messageValue, minIntervalMs?: number,
  ): Promise<void> {
    if (!this.authorizationIntegrity().ok)
      throw new Error('owner authorization state is corrupt; proactive messages are disabled');
    const message = this.safeProactiveMessage(messageValue);
    const route = this.conversations.route(this.effectiveOwners());
    const digest = createHash('sha256').update(digestValue).digest('hex');
    const sending = minIntervalMs === undefined
      ? this.conversations.beginSend(route.contact, digest)
      : this.conversations.beginSend(route.contact, digest, Date.now(), minIntervalMs);
    try {
      if (!this.isEffectiveOwner(route.contact))
        throw new Error('selected proactive owner is no longer authorized');
      await this.send(await this.routableContact(route), message);
    } catch {
      try { this.conversations.finishSend(sending.id, 'uncertain'); }
      catch (error) { this.logError('proactive owner uncertainty persist failed', error); }
      throw new Error('proactive owner message delivery outcome is uncertain; it was not retried');
    }
    this.conversations.finishSend(sending.id, 'delivered');
    this.options.log(`[${this.options.role}] proactive owner message `
      + `${createHash('sha256').update(sending.id).digest('hex').slice(0, 12)} `
      + `basis=${route.basis} chars=${Array.from(message).length} bytes=${Buffer.byteLength(message)} delivered`);
  }

  private openOwnerTask(requestId: string): OwnerChannelManagementResult {
    if (!/^[a-f0-9]{64}$/.test(requestId))
      throw new Error('owner task request ID must be exactly 64 lowercase hexadecimal characters');
    const active = this.activeRequests.get(requestId);
    if (!active || active.finalizing)
      throw new Error('owner task can be opened only for a currently active owner request');
    if (!this.isEffectiveOwner(active.contact))
      throw new Error('originating owner is no longer authorized');
    const task = this.tasks.open({
      requestId, contact: active.contact, wireId: active.wireId,
    });
    this.options.log(`[${this.options.role}] owner task ${ownerTaskAuditId(task.id)} opened `
      + `request=${ownerTaskAuditId(requestId)} expires=${new Date(task.expiresAt).toISOString()}`);
    return { action: 'task_open', taskId: task.id, expiresAt: new Date(task.expiresAt).toISOString() };
  }

  private async sendOwnerTaskReport(
    request: Extract<OwnerChannelManagementRequest, { action: 'task_report' }>,
  ): Promise<OwnerChannelManagementResult> {
    if (!['progress', 'done', 'blocked'].includes(request.phase))
      throw new Error('owner task report phase must be progress, done, or blocked');
    const message = this.safeTaskReport(request.message);
    const now = Date.now();
    const task = this.tasks.route(request.taskId, now);
    if (this.activeRequests.has(task.requestId))
      throw new Error('owner task reports are allowed only after the originating request has finalized');
    if (!this.authorizations.integrity().ok)
      throw new Error('owner authorization state is corrupt; proactive reports are disabled');
    if (!this.isEffectiveOwner(task.contact)) {
      this.tasks.revoke(task.contact, now);
      throw new Error('originating owner is no longer authorized; task revoked');
    }
    const chars = Array.from(message).length;
    const bytes = Buffer.byteLength(message);
    const digest = ownerTaskDigest(request.phase, message);
    const sending = this.tasks.beginReport(
      request.taskId, request.phase, digest, chars, bytes, now);
    const taskAudit = ownerTaskAuditId(request.taskId);
    const sequence = sending.sequence + 1;
    this.options.log(`[${this.options.role}] owner task ${taskAudit} report phase=${request.phase} `
      + `chars=${chars} bytes=${bytes} sequence=${sequence} sending`);
    try {
      await this.send(task.contact, ownerNotices.taskReport(request.phase, message), task.wireId);
    } catch {
      try { this.tasks.uncertain(request.taskId, digest); }
      catch (stateError) { this.logError(`owner task ${taskAudit} uncertainty persist failed`, stateError); }
      this.options.log(`[${this.options.role}] owner task ${taskAudit} report phase=${request.phase} `
        + `chars=${chars} bytes=${bytes} sequence=${sequence} result=uncertain`);
      throw new Error('owner task report delivery outcome is uncertain; it was not retried');
    }
    const terminal = request.phase !== 'progress';
    let deliveredSequence: number;
    try { deliveredSequence = this.tasks.delivered(request.taskId, digest, terminal, Date.now()); }
    catch (error) {
      this.logError(`owner task ${taskAudit} delivery commit failed`, error);
      throw new Error('owner task report was sent but its durable delivery result is uncertain; do not retry');
    }
    this.options.log(`[${this.options.role}] owner task ${taskAudit} report phase=${request.phase} `
      + `chars=${chars} bytes=${bytes} sequence=${deliveredSequence} result=delivered`);
    return {
      action: 'task_report', taskId: request.taskId, phase: request.phase,
      sequence: deliveredSequence, state: terminal ? 'closed' : 'open',
    };
  }

  private safeOwnerUpdate(value: unknown): string {
    if (typeof value !== 'string') throw new Error('owner update message must be text');
    const message = value.trim().normalize('NFC');
    if (!message) throw new Error('owner update message is empty');
    if (Array.from(message).length > OWNER_UPDATE_MAX_CHARS
        || Buffer.byteLength(message) > OWNER_UPDATE_MAX_BYTES)
      throw new Error(`owner update exceeds ${OWNER_UPDATE_MAX_CHARS} characters or ${OWNER_UPDATE_MAX_BYTES} bytes`);
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(message))
      throw new Error('owner update must be one line without control or direction-override characters');
    if (/```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=]|(?:chain of thought|private reasoning|internal reasoning)|^(?:stdout|stderr|tool (?:output|result)|command):/iu.test(message))
      throw new Error('owner update appears to contain unsafe reasoning, secret, or raw tool content');
    return message;
  }

  private safeTaskReport(value: unknown): string {
    const message = this.safeOwnerUpdate(value);
    if (/[.!?](?:["')\]]*)\s+\S/u.test(message))
      throw new Error('owner task report must contain exactly one plain-text sentence');
    return message;
  }

  private safeProactiveMessage(value: unknown): string {
    if (typeof value !== 'string') throw new Error('proactive owner message must be text');
    const message = value.trim().normalize('NFC');
    if (!message) throw new Error('proactive owner message must not be empty');
    if (Array.from(message).length > PROACTIVE_MESSAGE_MAX_CHARS
        || Buffer.byteLength(message) > PROACTIVE_MESSAGE_MAX_BYTES)
      throw new Error(`proactive owner message exceeds ${PROACTIVE_MESSAGE_MAX_CHARS} characters or `
        + `${PROACTIVE_MESSAGE_MAX_BYTES} bytes`);
    if (/\u0000|[\u202a-\u202e\u2066-\u2069]/u.test(message))
      throw new Error('proactive owner message contains unsafe control characters');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=]|(?:chain of thought|private reasoning|internal reasoning)|^(?:stdout|stderr|tool (?:output|result)|command):/imu.test(message))
      throw new Error('proactive owner message appears to contain unsafe reasoning, secret, or raw tool content');
    return message;
  }

  private async drainAll(): Promise<void> {
    // A finite cap protects the supervisor if a broken daemon never advances
    // its oldest-first unread batch. A watch hint will resume draining later.
    for (let pass = 0; pass < 100 && !this.stopping; pass++) {
      const [claimed, fileResult] = await Promise.all([
        this.claimMessages(),
        this.client.listIncomingFiles()
          .catch(error => {
            this.logError('attachment metadata inspection unavailable', error);
            return undefined;
          }),
      ]);
      const pending = this.attachmentRecovery.integrity() ? this.attachmentRecovery.list() : [];
      let files = await this.attachmentMetadata(fileResult, pending);
      const pendingWires = new Set(pending.flatMap(item => item.fileWireIds));
      files = files.filter(file => (file.status === 'unread' || pendingWires.has(file.wireId))
        && !this.state.has(file.wireId));
      if (!claimed.messages.length && !files.length && claimed.remaining === 0) return;

      let advanced = false;
      const consumedMessages = new Set<InboundMessage>();
      const groups = this.attachmentGroups(files, claimed.messages, pending, consumedMessages);
      for (const group of groups)
        advanced = await this.handleAttachmentGroup(group) || advanced;
      for (const message of claimed.messages) {
        if (!consumedMessages.has(message)) advanced = await this.handle(message) || advanced;
      }
      this.messageRecovery.pruneHandled(wireId => this.state.has(wireId));

      // Journaled in-flight messages remain history-recoverable until their
      // correlated response is delivered. Do not spin on those copies once the
      // unread SQLite queue itself is empty; completion triggers another drain.
      if (!advanced && claimed.remaining === 0) return;
    }
    this.options.log(`[${this.options.role}] owner channel drain capped at 100 batches`);
  }

  /**
   * Claim the exact oldest unread SQLite batch before marking it read.
   * The journal contains only wire IDs and sequence numbers; bodies remain in
   * the daemon's persistent history and are recovered with getHistoryItem.
   */
  private async claimMessages(): Promise<{
    messages: InboundMessage[];
    remaining: number;
  }> {
    if (!this.messageRecovery.integrity())
      throw new Error('message recovery state is corrupt; refusing owner message intake');
    this.messageRecovery.pruneHandled(wireId => this.state.has(wireId));

    const recovered: InboundMessage[] = [];
    for (const claim of this.messageRecovery.list()) {
      const item = await this.client.getHistoryItem(claim.wireId);
      if (!item)
        throw new Error(`journaled owner message ${claim.wireId} is missing from persistent history`);
      recovered.push(this.historyMessage(item, claim));
    }

    const listed = await this.client.listIncomingMessages();
    if (!Array.isArray(listed)) throw new Error('the ours daemon returned invalid unread message metadata');
    const preflight = listed.slice(0, OWNER_MESSAGE_BATCH_LIMIT);
    const now = Date.now();
    const claims = preflight.map(item => this.messageClaim(item, now));
    const claimKeys = new Set(claims.map(item => `${item.seq}\0${item.wireId}`));
    if (claimKeys.size !== claims.length)
      throw new Error('the ours daemon returned duplicate unread message metadata');
    this.messageRecovery.claim(claims);

    let fresh: InboundMessage[] = [];
    let remaining = 0;
    // SDK batchLimit rejects zero. An empty preflight is a read-only drain.
    if (claims.length) {
      const payload = await this.client.getMessages(claims.length);
      if (!payload || !Array.isArray(payload.messages)
          || !Number.isSafeInteger(payload.remaining) || payload.remaining < 0)
        throw new Error('the ours daemon returned an invalid claimed message batch');
      fresh = payload.messages.map(message => this.historyMessage(message));
      remaining = payload.remaining;
      const expected = claimKeys;
      const actual = new Set(fresh.map(item => `${item.seq}\0${item.wire_id}`));
      if (fresh.length !== claims.length || actual.size !== fresh.length
          || actual.size !== expected.size
          || [...expected].some(item => !actual.has(item)))
        throw new Error('the ours daemon claimed a different message batch than fleet journaled');
    }

    const merged = new Map<string, InboundMessage>();
    for (const message of [...recovered, ...fresh]) {
      const wireId = this.wireId(message);
      const previous = merged.get(wireId);
      if (previous && previous.seq !== message.seq)
        throw new Error('persistent message history changed sequence during recovery');
      merged.set(wireId, message);
    }
    return {
      messages: [...merged.values()].sort((a, b) => a.seq - b.seq),
      remaining,
    };
  }

  private messageClaim(message: OursIncomingMessage, claimedAt: number): PendingMessageClaim {
    const value = message as unknown as Record<string, unknown>;
    const wireId = String(value.wire_id ?? '').trim();
    const seq = Number(value.seq);
    if (!wireId || !Number.isSafeInteger(seq) || seq < 1
        || value.status !== 'unread' || value.inbox_state !== 'unread')
      throw new Error('the ours daemon returned malformed unread message metadata');
    return { wireId, seq, claimedAt };
  }

  private historyMessage(
    message: OursHistoryMessage | OursInboundMessage,
    claim?: PendingMessageClaim,
  ): InboundMessage {
    const value = message as unknown as Record<string, unknown>;
    const wireId = String(value.wire_id ?? '').trim();
    const seq = Number(value.seq);
    const direction = String(value.direction ?? '');
    if (!wireId || !Number.isSafeInteger(seq) || seq < 1 || direction !== 'in'
        || (claim && (claim.wireId !== wireId || claim.seq !== seq)))
      throw new Error('persistent owner message metadata mismatched its recovery claim');
    return message as InboundMessage;
  }

  private async attachmentMetadata(
    unread: OursHistoryFile[] | undefined,
    pending: PendingAttachmentRequest[],
  ): Promise<IncomingAttachment[]> {
    const raw: OursHistoryFile[] = Array.isArray(unread) ? [...unread] : [];
    const present = new Set(raw.map(file => String(file.wire_id ?? '')));
    for (const recovery of pending) {
      for (const wireId of recovery.fileWireIds) {
        if (present.has(wireId)) continue;
        const item = await this.client.getFileInfo(wireId);
        if (!item)
          throw new Error(`journaled owner file ${wireId} is missing from persistent history`);
        if (item.wire_id !== wireId || item.direction !== 'in'
            || item.inbox_state !== 'read' || item.status !== 'read')
          throw new Error(`journaled owner file ${wireId} mismatched persistent history`);
        raw.push(item);
        present.add(wireId);
      }
    }
    const files = parseIncomingAttachments(raw);
    const byWire = new Map(files.map(file => [file.wireId, file]));
    for (const recovery of pending) {
      for (const wireId of recovery.fileWireIds) {
        const file = byWire.get(wireId);
        if (!file || file.senderId !== recovery.contact)
          throw new Error(`journaled owner file ${wireId} failed recovery provenance validation`);
      }
    }
    return files;
  }

  private attachmentGroups(
    files: IncomingAttachment[], messages: InboundMessage[], pending: PendingAttachmentRequest[],
    consumed: Set<InboundMessage>,
  ): AttachmentGroup[] {
    const groups: AttachmentGroup[] = [];
    const used = new Set<string>();
    const byWire = new Map(files.map(file => [file.wireId, file]));
    const messageByWire = new Map(messages.map(message => [this.wireId(message), message]));
    for (const recovery of pending) {
      if (this.state.has(recovery.originWireId)) {
        try { this.attachmentRecovery.remove(recovery.id); } catch {}
        continue;
      }
      const recovered = recovery.fileWireIds.map(wire => byWire.get(wire));
      if (recovered.some(file => !file)) continue;
      const exact = recovered as IncomingAttachment[];
      if (exact.some(file => file.senderId !== recovery.contact)) continue;
      exact.forEach(file => used.add(file.wireId));
      const caption = recovery.originWireId === recovery.fileWireIds[0]
        ? undefined : messageByWire.get(recovery.originWireId);
      if (caption && this.sender(caption).id !== recovery.contact) continue;
      // A managed-agent caption is claimed before its inbox row becomes read.
      // If recovery sees a read file before that body is recovered from history,
      // keep the file reserved by the journal until both halves are present.
      if (!caption && !recovery.fileWireIds.includes(recovery.originWireId)) continue;
      if (caption) consumed.add(caption);
      groups.push({ files: exact, recovery, ...(caption ? { caption } : {}) });
    }
    for (const file of files) {
      if (used.has(file.wireId)) continue;
      let caption: InboundMessage | undefined;
      const replyTarget = file.replyTo?.wire_id;
      if (replyTarget) {
        const candidate = messageByWire.get(replyTarget);
        if (candidate && this.sender(candidate).id === file.senderId) caption = candidate;
      }
      caption ??= messages.find(message =>
        this.sender(message).id === file.senderId && message.reply_to?.wire_id === file.wireId);
      const related = files.filter(other => !used.has(other.wireId)
        && other.senderId === file.senderId
        && ((caption && other.replyTo?.wire_id === this.wireId(caption))
          || other.replyTo?.wire_id === file.wireId || file.replyTo?.wire_id === other.wireId));
      const selected = related.length ? related : [file];
      selected.forEach(item => used.add(item.wireId));
      if (caption) consumed.add(caption);
      groups.push({ files: selected, ...(caption ? { caption } : {}) });
    }
    return groups;
  }

  private async handleAttachmentGroup(group: AttachmentGroup): Promise<boolean> {
    if (!group.files.length) return false;
    const originWireId = group.recovery?.originWireId ?? group.files[0].wireId;
    const handledWireIds = [...new Set([
      ...group.files.map(file => file.wireId),
      ...(group.caption ? [this.wireId(group.caption)] : []),
    ].filter(Boolean))];
    if (handledWireIds.some(wire => this.inFlight.has(wire))) return false;
    const sender = { id: group.files[0].senderId, name: group.files[0].senderName };
    if (group.files.every(file => this.isAgentSender(file.senderId))
        && (!group.caption || this.isAgentSender(this.sender(group.caption).id)))
      return this.handleManagedAgentAttachmentGroup(group, handledWireIds, sender.id);
    if (group.files.some(file => file.senderId !== sender.id)
        || !this.isEffectiveOwner(sender.id)) {
      this.options.log(
        `[${this.options.role}] owner channel ignored unauthorized attachment sender ${sender.id}`);
      for (const wire of handledWireIds) this.state.remember(wire);
      if (group.recovery) try { this.attachmentRecovery.remove(group.recovery.id); } catch {}
      return true;
    }
    // Owner files are requests too: retain their authenticated source wire so
    // a later managed-agent attachment reply cannot drift to a newer owner.
    try { this.conversations.recordInbound(sender.id, originWireId); }
    catch (error) { this.logError('owner attachment route update failed', error); }
    const rejection = !this.attachmentRecovery.integrity()
      ? 'attachment recovery state is unavailable'
      : validateAttachmentSelection(group.files, this.attachmentConfig);
    if (rejection) {
      await this.send(sender.id, ownerNotices.attachmentRejected(rejection), originWireId);
      for (const wire of handledWireIds) this.state.remember(wire);
      return true;
    }

    const requestId = this.requestId(originWireId);
    const recovery = group.recovery ?? {
      id: requestId, contact: sender.id, originWireId,
      fileWireIds: group.files.map(file => file.wireId), createdAt: Date.now(),
    };
    let requestDir: string | undefined;
    let outbox: string | undefined;
    try {
      if (!group.recovery) this.attachmentRecovery.add(recovery);
      requestDir = await prepareAttachmentDirectory(this.attachmentRoot, requestId);
      const unread = group.files.filter(file => file.status === 'unread');
      const historyRecovered = group.files.filter(file => file.status !== 'unread');
      const retrieved = unread.length
        ? parseRetrievedAttachments(
          await this.client.getFiles(unread.map(file => file.wireId)), unread)
        : [];
      for (const file of historyRecovered) {
        if (!group.recovery) throw new Error('unexpected read attachment without recovery route');
        const recoveryPath = await writeRecoveredAttachment(
          requestDir, file.wireId, await this.client.fetchFile(file.wireId));
        retrieved.push(await recoveredAttachment(file, recoveryPath));
      }
      const order = new Map(group.files.map((file, index) => [file.wireId, index]));
      retrieved.sort((a, b) => order.get(a.wireId)! - order.get(b.wireId)!);
      const admitted = await admitAttachments(retrieved, requestDir, this.attachmentConfig);
      outbox = this.outboxDir(originWireId);
      await mkdir(outbox, { recursive: true, mode: 0o700 });
      const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
      const queued = await queueSessionPrompt(this.options.session,
        this.ownerAttachmentPrompt(sender, originWireId, requestId, admitted, group.caption),
        {
          interrupt: this.options.config.interrupt,
          ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
          origin: { kind: 'owner', requestId,
            ...(group.caption ? { displayText: String(group.caption.text ?? '') } : {}) },
        });
      const accepted = this.acceptanceNotice(queued);
      handledWireIds.forEach(wire => this.inFlight.add(wire));
      const receipt = this.send(sender.id, accepted, originWireId).then(() => undefined).catch(error => {
        this.logError(`attachment request ${requestId.slice(0, 12)} acceptance notice failed`, error);
      });
      const active: ActiveOwnerRequest = {
        contact: sender.id, wireId: originWireId, requestId, outboundTail: receipt,
        finalizing: false, updateCount: 0, updateDigests: new Set(), handledWireIds,
        commentaryBuffer: '', commentaryCount: 0, commentaryKeys: new Set(),
        commentaryDisabled: false,
      };
      this.activeRequests.set(requestId, active);
      const cleanupDir = requestDir;
      let completed = false;
      const task = this.complete(active, outbox, queued, activityCursor)
        .then(() => { completed = true; })
        .catch(error => this.logError(`attachment request ${requestId.slice(0, 12)} completion failed`, error))
        .finally(async () => {
          try { await removeRequestDirectory(cleanupDir); }
          catch (error) { this.logError(`attachment request ${requestId.slice(0, 12)} cleanup failed`, error); }
          if (completed) {
            try { this.attachmentRecovery.remove(recovery.id); }
            catch (error) { this.logError('attachment recovery completion failed', error); }
          }
          handledWireIds.forEach(wire => this.inFlight.delete(wire));
          this.activeRequests.delete(requestId);
          this.completionTasks.delete(task);
          if (!this.stopping)
            void this.drain().catch(error => this.logError('completion drain failed', error));
        });
      this.completionTasks.add(task);
      return true;
    } catch (error) {
      if (requestDir) await removeRequestDirectory(requestDir).catch(() => undefined);
      if (outbox) await rm(outbox, { recursive: true, force: true }).catch(() => undefined);
      try { this.attachmentRecovery.remove(recovery.id); } catch {}
      this.logError(`attachment request ${requestId.slice(0, 12)} admission failed`, error);
      await this.send(sender.id, ownerNotices.attachmentFailed(), originWireId);
      for (const wire of handledWireIds) this.state.remember(wire);
      return true;
    }
  }

  private async handle(message: InboundMessage): Promise<boolean> {
    const wireId = this.wireId(message);
    if (!wireId || this.state.has(wireId) || this.inFlight.has(wireId)) return false;
    const sender = this.sender(message);
    if (this.isAgentSender(sender.id)) {
      try {
        await this.relayManagedAgentMessage(message, wireId);
      } catch (error) {
        if (error instanceof DuplicateSendError) {
          // A crash replay of a wire that already reached an owner. Consuming
          // it silently IS the correct outcome; delivering again is the bug.
          this.options.log(`[${this.options.role}] managed-agent relay replay of a delivered wire consumed`);
        } else if (error instanceof RelayUnroutableError) {
          // No owner route exists yet. Leave the wire journaled and unconsumed
          // so persistent history replays it after the first owner contact, and
          // tell the authenticated agent once so the wait is never silent.
          this.options.log(`[${this.options.role}] owner channel managed-agent relay has no owner `
            + `route yet; message stays queued: ${this.errorText(error)}`);
          await this.nackManagedAgent(
            sender.id, message.wire_id ? wireId : undefined, wireId, ownerNotices.relayQueued());
          return false;
        } else {
          this.logError('managed-agent message relay refused', error);
          await this.nackManagedAgent(sender.id, message.wire_id ? wireId : undefined, wireId,
            ownerNotices.relayRefused(this.errorText(error)));
        }
      }
      this.state.remember(wireId);
      return true;
    }
    if (!this.isEffectiveOwner(sender.id)) {
      // Never answer the sender or reflect its body. Notify an owner through the
      // bounded proactive route, then consume the attempt so it cannot replay.
      this.options.log(
        `[${this.options.role}] owner channel ignored unauthorized sender ${sender.id || '<unknown>'}`);
      await this.warnOwnerOfUnauthorizedSender(sender.id);
      this.state.remember(wireId);
      return true;
    }

    // Accepted authenticated inbound traffic selects the destination for the
    // next unscoped proactive message. Distinct devices/identities naturally
    // hand off this route by being the most recent sender.
    try {
      this.conversations.recordInbound(sender.id, wireId);
    } catch (error) {
      // Proactive routing state is auxiliary. A corrupt/unwritable route file must
      // never prevent an authenticated owner from using the ordinary channel.
      this.logError('owner conversation route update failed', error);
    }

    const text = String(message.text ?? '');
    if (isOwnerCommandText(text.trim())) {
      await this.handleCommand(sender, text.trim(), wireId);
      return true;
    }

    const requestId = this.requestId(wireId);
    const outbox = this.outboxDir(wireId);
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    let queued;
    const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
    try {
      queued = await queueSessionPrompt(this.options.session,
        this.ownerPrompt(sender, text, wireId), {
        interrupt: this.options.config.interrupt,
        ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
        origin: { kind: 'owner', requestId, displayText: text },
      });
    } catch (error) {
      await rm(outbox, { recursive: true, force: true });
      if (error instanceof SessionControlError
          && error.reasonCode === ACP_CANCEL_DEADLINE_EXCEEDED) {
        // drainAll journaled this authenticated message before delivery. The
        // adapter generation is terminating, so leave the wire unhandled and
        // body-free: the resumed owner channel recovers it exactly once.
        this.options.log(`[${this.options.role}] owner request ${requestId.slice(0, 12)} `
          + `held for adapter resume reason=${ACP_CANCEL_DEADLINE_EXCEEDED}`);
        return false;
      }
      this.logError('request delivery failed', error);
      await this.send(sender.id, ownerNotices.deliveryFailed(this.options.role), wireId);
      this.state.remember(wireId);
      return true;
    }

    const accepted = this.acceptanceNotice(queued);
    this.inFlight.add(wireId);
    const receipt = this.send(sender.id, accepted, wireId).then(() => undefined).catch(error => {
      this.logError(`request ${requestId.slice(0, 12)} acceptance notice failed`, error);
    });
    const active: ActiveOwnerRequest = {
      contact: sender.id, wireId, requestId, outboundTail: receipt, finalizing: false,
      updateCount: 0, updateDigests: new Set(), handledWireIds: [wireId],
      commentaryBuffer: '', commentaryCount: 0, commentaryKeys: new Set(),
      commentaryDisabled: false,
    };
    this.activeRequests.set(requestId, active);
    const task = this.complete(active, outbox, queued, activityCursor)
      .catch(error => this.logError(`request ${wireId} completion failed`, error))
      .finally(() => {
        this.inFlight.delete(wireId);
        this.activeRequests.delete(requestId);
        this.completionTasks.delete(task);
        if (!this.stopping)
          void this.drain().catch(error => this.logError('completion drain failed', error));
      });
    this.completionTasks.add(task);
    return true;
  }

  /**
   * Deterministic command path: the message never becomes an agent prompt.
   * Authorization already happened — the managed-agent relay branch and the
   * owner-CID check in handle() both run before dispatch, so only an
   * authenticated owner reaches this: neither ordinary peers nor the managed
   * agent itself can execute /force-restart, /model, or any other command.
   */
  private async handleCommand(
    sender: { id: string; name: string }, text: string, wireId: string,
  ): Promise<void> {
    const ctx: OwnerCommandContext = {
      role: this.options.role,
      harness: this.options.harness,
      version: VERSION,
      snapshot: () => this.options.session.snapshot(),
      interrupt: () => interruptSession(this.options.session, 'owner'),
      runHarnessCommand: command => this.runHarnessCommand(sender, command, wireId),
      restart: mode => this.restartSelf(sender, mode, wireId),
      comments: () => this.commentsState(),
      setComments: enabled => {
        this.commentsEnabled = enabled;
        this.options.log(`[${this.options.role}] owner channel live comments `
          + `${enabled ? 'enabled' : 'disabled'} by owner command `
          + `(fleet.yaml baseline ${this.commentsBaseline ? 'on' : 'off'})`);
        return this.commentsState();
      },
      fleetList: () => this.fleetOps.list(),
      closeRoom: roomId => this.closeRoomFromOwner(sender, roomId, wireId),
      recoverRoom: roomId => this.recoverRoomFromOwner(sender, roomId, wireId),
      terminalTask: (taskId, kind, outcome) =>
        this.terminalTaskFromOwner(sender, taskId, kind, outcome, wireId),
      recoverTask: taskId => this.recoverTaskFromOwner(sender, taskId, wireId),
      createTask: input => new TaskRoomApplicationService(this.options.configPath).createTask({
        ...input,
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id },
      }),
      startTask: taskId => new TaskRoomApplicationService(this.options.configPath).startTask({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, taskId,
      }),
      listTasks: filter => new TaskRoomApplicationService(this.options.configPath).listTasks(filter),
      groupedTasks: filter => new TaskRoomApplicationService(this.options.configPath).groupedTasks(filter),
      listTaskLists: () => new TaskRoomApplicationService(this.options.configPath).listTaskLists(),
      createTaskList: name => new TaskRoomApplicationService(this.options.configPath).createTaskList({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, name,
      }),
      renameTaskList: (name, newName) => new TaskRoomApplicationService(this.options.configPath).renameTaskList({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, name, newName,
      }),
      deleteTaskList: (name, destination) => new TaskRoomApplicationService(this.options.configPath).deleteTaskList({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, name, destination,
      }),
      moveTask: (taskId, list) => new TaskRoomApplicationService(this.options.configPath).moveTask({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, taskId, list,
      }),
      getTask: taskId => new TaskRoomApplicationService(this.options.configPath).getTask(taskId),
      blockTask: (taskId, reason) => new TaskRoomApplicationService(this.options.configPath).blockTask({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, taskId, reason,
      }),
      unblockTask: taskId => new TaskRoomApplicationService(this.options.configPath).unblockTask({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, taskId,
      }),
      reviewTask: taskId => new TaskRoomApplicationService(this.options.configPath).reviewTask({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, taskId,
      }),
      deleteTask: taskId => new TaskRoomApplicationService(this.options.configPath).deleteTask({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id }, taskId,
      }),
      listRoomQueries: filter => new TaskRoomApplicationService(this.options.configPath).listRooms(filter),
      getRoomQuery: id => new TaskRoomApplicationService(this.options.configPath).getRoomDetail(id),
      listTemplateQueries: () => new TaskRoomApplicationService(this.options.configPath).listTemplates(),
      getTemplateQuery: name => new TaskRoomApplicationService(this.options.configPath).getTemplate(name),
      createRoom: input => new TaskRoomApplicationService(this.options.configPath).createRoom({
        ...input, actor: { kind: 'authenticated_owner', surface: 'messenger', cid: sender.id },
      }),
      recentEvents: limit => this.options.session.eventsSince(0).slice(-limit),
      readWorklogTail: maxChars => this.readWorklogTail(maxChars),
      reply: async replyText => { await this.send(sender.id, replyText, wireId); },
    };
    try {
      await dispatchOwnerCommand(text, ctx);
    } catch (error) {
      this.logError(`owner command failed (${text.split(/\s+/, 1)[0]})`, error);
    }
    // Harness commands own their wire until the queued turn settles; everything
    // else is complete now and must never replay.
    if (!this.inFlight.has(wireId)) this.state.remember(wireId);
  }

  /** Queue raw slash text to the harness and report the turn's outcome. */
  private async runHarnessCommand(
    sender: { id: string; name: string }, command: string, wireId: string,
  ): Promise<void> {
    const requestId = this.requestId(wireId);
    const queued = await queueSessionPrompt(this.options.session, command, {
      origin: { kind: 'owner', requestId },
    });
    this.inFlight.add(wireId);
    const receipt = this.send(sender.id, ownerNotices.commandStarted(command), wireId)
      .then(() => undefined)
      .catch(error => this.logError(`command ${command} acceptance notice failed`, error));
    const task = queued.completion.then(async result => {
      await receipt;
      const output = result.succeeded ? this.commandOutput(result.output) : undefined;
      await this.send(sender.id,
        ownerNotices.commandOutcome(command, result.outcome, output), wireId);
      this.state.remember(wireId);
    }).catch(error => this.logError(`command ${command} completion failed`, error))
      .finally(() => {
        this.inFlight.delete(wireId);
        this.completionTasks.delete(task);
        if (!this.stopping)
          void this.drain().catch(error => this.logError('completion drain failed', error));
      });
    this.completionTasks.add(task);
  }

  /**
   * Confirmation and the durable wire record must both land BEFORE the fleet
   * CLI is asked to bounce this very process; neither can happen afterwards.
   */
  private async restartSelf(
    sender: { id: string; name: string }, mode: 'keep' | 'fresh', wireId: string,
  ): Promise<void> {
    const command = mode === 'fresh' ? '/force-restart' : '/restart';
    await this.prepareRestart(this.options.role, mode);
    await this.send(sender.id,
      ownerNotices.restarting(this.options.role, command, mode), wireId);
    this.state.remember(wireId);
    this.options.log(`[${this.options.role}] owner requested ${command}`);
    await this.fleetOps.restart(mode);
  }

  /**
   * The caller may itself be a room member. Persist and acknowledge acceptance
   * before an external worker starts a saga that can retire this process.
   */
  private async closeRoomFromOwner(
    sender: { id: string; name: string }, roomId: string, wireId: string,
  ): Promise<void> {
    const app = new TaskRoomApplicationService(this.options.configPath);
    const actor = { kind: 'authenticated_owner' as const, surface: 'messenger' as const, cid: sender.id };
    await app.requestRoomDeletion({ actor, roomId });
    await this.send(sender.id, renderMarkdownFailure({
      kind: 'pending', subject: `/room delete ${roomId} ${roomId}`,
      detail: 'The deletion request was accepted and is still being settled.',
      action: `Run /room recover ${roomId} if deletion remains pending.`,
    }), wireId);
    this.state.remember(wireId);
    try {
      await this.fleetOps.closeRoom(roomId);
    } catch (error) {
      await app.recordRoomSettlementError({ actor, roomId,
        error: error instanceof Error ? error.message : String(error),
        recoveryHint: `External delete worker failed to start. Retry /room delete ${roomId} ${roomId}.` });
      throw error;
    }
  }

  private async recoverRoomFromOwner(
    sender: { id: string; name: string }, roomId: string, wireId: string,
  ): Promise<void> {
    const app = new TaskRoomApplicationService(this.options.configPath);
    const actor = { kind: 'authenticated_owner' as const, surface: 'messenger' as const, cid: sender.id };
    const result = await app.recoverRoom({ actor, roomId });
    if (result.kind === 'deletion_worker_required') {
      await this.send(sender.id, renderMarkdownFailure({ kind: 'pending',
        subject: `/room recover ${roomId}`,
        detail: 'The deletion recovery is still being settled.',
        action: `Run /room recover ${roomId} if deletion remains pending.` }), wireId);
      this.state.remember(wireId);
      try { await this.fleetOps.closeRoom(roomId); }
      catch (error) {
        await app.recordRoomSettlementError({ actor, roomId,
          error: error instanceof Error ? error.message : String(error),
          recoveryHint: `External delete worker failed to start. Retry /room delete ${roomId} ${roomId}.` });
        throw error;
      }
      return;
    }
    const r = result.orchestration;
    await this.send(sender.id, renderMarkdownResult({ icon: '🛟', title: 'Room recovery',
      fields: [{ label: 'Room', value: result.room.room_id, kind: 'code' },
        { label: 'Status', value: roomStatus(result.room.state), kind: 'markdown' },
        ...(r ? [{ label: 'Saga', value: r.saga.phase, kind: 'code' as const }] : [])],
      sections: result.issues.length ? [{ heading: 'Next steps', items: result.issues }]
        : [{ heading: 'Result', items: ['No recovery action is needed.'] }] }), wireId);
    this.state.remember(wireId);
  }

  /** Carry a task terminal request through a worker that survives this role. */
  private async recoverTaskFromOwner(
    sender: { id: string; name: string }, taskId: string, wireId: string,
  ): Promise<void> {
    const app = new TaskRoomApplicationService(this.options.configPath);
    const actor = { kind: 'authenticated_owner' as const, surface: 'messenger' as const, cid: sender.id };
    const begin = await app.beginTaskRecovery({ actor, taskId });
    if (begin.kind === 'terminal_worker_required') {
      await this.send(sender.id, renderMarkdownFailure({
        kind: 'pending', subject: `/task recover ${taskId}`,
        detail: 'The recovery request was accepted and is still being settled.',
        action: `Run /task recover ${taskId} if it remains pending.`,
      }), wireId);
      this.state.remember(wireId);
      try { await this.fleetOps.recoverTask(taskId); }
      catch (error) {
        await app.recordSettlementError({ actor, taskId,
          error: error instanceof Error ? error.message : String(error),
          recoveryHint: `External settle worker failed to start. Retry /task recover ${taskId}.` });
        throw error;
      }
      return;
    }
    const { task, room, issues } = begin.result;
    const hints = issues.map(issue => issue.code === 'waiting_cowork' ? 'Cowork socket unreachable'
      : issue.code === 'waiting_owner_invite' ? 'Owner invite missing or invalid'
      : issue.code === 'owner_cid_mismatch' ? 'Owner CID mismatch'
      : issue.code === 'member_failed' ? `Member failed at step ${issue.stepIndex}`
      : issue.code === 'resume_failed' ? `Resume failed: ${issue.error}`
      : issue.code === 'provisioning_resumed' ? 'Provisioning resumed successfully'
      : issue.code);
    await this.send(sender.id, renderMarkdownResult({
      icon: '🛟', title: 'Task recovery',
      fields: [{ label: 'Task', value: task.task_id, kind: 'code' },
        { label: 'Status', value: taskStatus(task.state), kind: 'markdown' },
        ...(room ? [{ label: 'Room', value: room.room_id, kind: 'code' as const },
          { label: 'Room status', value: roomStatus(room.state), kind: 'markdown' as const },
          { label: 'Saga', value: room.saga.phase, kind: 'code' as const }] : [])],
      sections: hints.length ? [{ heading: 'Next steps', items: hints }]
        : [{ heading: 'Result', items: ['No automated recovery action is available.'] }],
    }), wireId);
    this.state.remember(wireId);
  }

  private async terminalTaskFromOwner(
    sender: { id: string; name: string },
    taskId: string,
    kind: import('../rooms-tasks/types.js').TaskTerminalIntent['kind'],
    outcome: import('../rooms-tasks/types.js').TaskOutcome | undefined,
    wireId: string,
  ): Promise<void> {
    const app = new TaskRoomApplicationService(this.options.configPath);
    const actor = { kind: 'authenticated_owner' as const, surface: 'messenger' as const, cid: sender.id };
    const plan = kind === 'done'
      ? await app.completeTask({ actor, taskId, outcome })
      : await app.cancelTask({ actor, taskId });
    if (!plan.settlementRequired) {
      await this.send(sender.id, renderMarkdownResult({
        icon: '📋', title: 'Task terminal action complete',
        fields: [
          { label: 'ID', value: taskId, kind: 'code' },
          { label: 'Status', value: taskStatus(plan.task.state), kind: 'markdown' },
        ],
      }), wireId);
      this.state.remember(wireId);
      return;
    }
    await this.send(sender.id, renderMarkdownFailure({
      kind: 'pending', subject: `/task ${kind === 'done' ? 'done' : 'cancel'} ${taskId}`,
      detail: 'The terminal request was accepted and is still being settled.',
      action: `Run /task recover ${taskId} if it remains pending.`,
    }), wireId);
    this.state.remember(wireId);
    try {
      await this.fleetOps.settleTask(taskId);
    } catch (error) {
      await app.recordSettlementError({
        actor, taskId, error: error instanceof Error ? error.message : String(error),
        recoveryHint: `External settle worker failed to start. Retry the identical task command or run task recover ${taskId}.`,
      });
      throw error;
    }
  }

  /** Code-point-safe tail of the worklog, or undefined when there is none. */
  private async readWorklogTail(maxChars: number): Promise<string | undefined> {
    try {
      const content = (await readFile(
        join(this.options.stateDir, 'WORKLOG.md'), 'utf8')).trim();
      if (!content) return undefined;
      const points = Array.from(content);
      return points.length <= maxChars ? content : `…${points.slice(-maxChars).join('')}`;
    } catch {
      return undefined;
    }
  }

  /** Bound harness-command output to a single outbound message. */
  private commandOutput(output: string | undefined): string | undefined {
    const trimmed = output?.trim();
    if (!trimmed) return undefined;
    const points = Array.from(trimmed);
    return points.length <= 7_000 ? trimmed : `${points.slice(0, 7_000).join('')}…`;
  }

  private acceptedSender(cid: string): boolean {
    return this.isAgentSender(cid) || this.isEffectiveOwner(cid);
  }

  private isAgentSender(cid: string): boolean {
    const agent = this.options.config.agent;
    return agent !== undefined && cid !== '' && canonicalCid(cid) === canonicalCid(agent);
  }

  private isEffectiveOwner(cid: string): boolean {
    const canonical = canonicalCid(cid);
    for (const owner of this.effectiveOwners())
      if (canonicalCid(owner) === canonical) return true;
    return false;
  }

  private async relayManagedAgentMessage(message: InboundMessage, wireId: string): Promise<void> {
    if (!this.authorizationIntegrity().ok)
      throw new Error('owner authorization state is corrupt; managed-agent relay is disabled');
    const text = this.safeRelayMessage(message.text);
    let route: { contact: string; basis: string };
    try {
      route = this.conversations.route(this.effectiveOwners());
    } catch (error) {
      throw new RelayUnroutableError(this.errorText(error));
    }
    // The inbound wire—not its body—is the idempotency key. Repeating the same
    // wording in two deliberate messages remains valid, while crash replay of
    // one message cannot produce two owner deliveries — to ANY owner, which is
    // why the wire digest is checked across every recorded send.
    const digest = createHash('sha256').update(`managed-agent-relay\0${wireId}`).digest('hex');
    const sending = this.conversations.beginSend(route.contact, digest, Date.now(), 0, 'all');
    try {
      if (!this.isEffectiveOwner(route.contact))
        throw new Error('selected relay owner is no longer authorized');
      await this.send(await this.routableContact(route), text);
    } catch {
      try { this.conversations.finishSend(sending.id, 'uncertain'); }
      catch (error) { this.logError('managed-agent relay uncertainty persist failed', error); }
      throw new Error('managed-agent relay delivery outcome is uncertain; it was not retried');
    }
    this.conversations.finishSend(sending.id, 'delivered');
    this.options.log(`[${this.options.role}] managed-agent message relayed `
      + `wire=${createHash('sha256').update(wireId).digest('hex').slice(0, 12)} `
      + `basis=${route.basis} chars=${Array.from(text).length} bytes=${Buffer.byteLength(text)}`);
  }

  /**
   * Caption and files are admitted as one relay transaction. The authenticated
   * route and optional source wire are fixed before bytes are retrieved, and no
   * outbound part is emitted until every file passes admission. A transport
   * failure after emission starts is durably uncertain and never blind-retried;
   * the managed agent receives one bounded NACK for the whole transaction.
   */
  private async handleManagedAgentAttachmentGroup(
    group: AttachmentGroup, handledWireIds: string[], agent: string,
  ): Promise<boolean> {
    const captionWire = group.caption ? this.wireId(group.caption) : undefined;
    const nackWire = captionWire ?? group.files[0].wireId;
    // A caption whose own wire id is synthetic (msg_id only) must not be echoed
    // back as a reply reference; a file wire always is a real one.
    const nackReplyTo = (group.caption ? group.caption.wire_id : nackWire) ? nackWire : undefined;
    let requestDir: string | undefined;
    let recovery: PendingAttachmentRequest | undefined;
    try {
      if (!this.authorizationIntegrity().ok)
        throw new Error('owner authorization state is corrupt; managed-agent relay is disabled');
      const caption = group.caption ? this.safeRelayMessage(group.caption.text) : undefined;
      const replyTo = this.managedAttachmentReplyWire(group, captionWire);
      let route: { contact: string; basis: string };
      try {
        route = replyTo
          ? this.conversations.routeForWire(replyTo, this.effectiveOwners())
          : this.conversations.route(this.effectiveOwners());
      } catch (error) {
        throw new RelayUnroutableError(this.errorText(error));
      }
      if (!this.isEffectiveOwner(route.contact))
        throw new Error('selected attachment relay owner is no longer authorized');
      const contact = await this.routableContact(route);
      const rejection = !this.attachmentRecovery.integrity()
        ? 'attachment recovery state is unavailable'
        : validateAttachmentRelaySelection(group.files, this.attachmentConfig);
      if (rejection) throw new Error(rejection);

      const transactionId = this.requestId(
        `managed-agent-attachment:${handledWireIds.slice().sort().join(':')}`);
      recovery = group.recovery ?? {
        id: transactionId, contact: agent, originWireId: captionWire ?? group.files[0].wireId,
        fileWireIds: group.files.map(file => file.wireId), createdAt: Date.now(),
      };
      if (!group.recovery) this.attachmentRecovery.add(recovery);
      requestDir = await prepareAttachmentDirectory(this.attachmentRoot, transactionId);
      const unread = group.files.filter(file => file.status === 'unread');
      const historyRecovered = group.files.filter(file => file.status !== 'unread');
      const retrieved = unread.length
        ? parseRetrievedAttachments(
          await this.client.getFiles(unread.map(file => file.wireId)), unread)
        : [];
      for (const file of historyRecovered) {
        if (!group.recovery) throw new Error('unexpected read attachment without recovery route');
        const recoveryPath = await writeRecoveredAttachment(
          requestDir, file.wireId, await this.client.fetchFile(file.wireId));
        retrieved.push(await recoveredAttachment(file, recoveryPath));
      }
      const order = new Map(group.files.map((file, index) => [file.wireId, index]));
      retrieved.sort((a, b) => order.get(a.wireId)! - order.get(b.wireId)!);
      const admitted = await admitAttachments(
        retrieved, requestDir, this.attachmentConfig, { mimePolicy: 'report-only' });

      const digest = createHash('sha256').update(
        `managed-agent-attachment\0${handledWireIds.slice().sort().join('\0')}`,
      ).digest('hex');
      const sending = this.conversations.beginSend(route.contact, digest, Date.now(), 0, 'all');
      try {
        if (caption) await this.send(contact, caption, replyTo);
        for (const file of admitted) {
          await this.client.sendFile({
            contact, path: file.path, filename: file.filename,
            ...(replyTo ? { replyToWireId: replyTo } : {}),
          });
        }
      } catch {
        try { this.conversations.finishSend(sending.id, 'uncertain'); }
        catch (error) { this.logError('managed-agent attachment uncertainty persist failed', error); }
        throw new Error('caption/file relay delivery outcome is uncertain; it was not retried');
      }
      this.conversations.finishSend(sending.id, 'delivered');
      for (const wire of handledWireIds) this.state.remember(wire);
      this.attachmentRecovery.remove(recovery.id);
      this.options.log(`[${this.options.role}] managed-agent attachment transaction relayed `
        + `wires=${handledWireIds.length} basis=${route.basis} files=${admitted.length} `
        + `bytes=${admitted.reduce((total, file) => total + file.size, 0)}`);
      return true;
    } catch (error) {
      if (error instanceof DuplicateSendError) {
        this.options.log(`[${this.options.role}] managed-agent attachment replay consumed`);
        for (const wire of handledWireIds) this.state.remember(wire);
        if (recovery) try { this.attachmentRecovery.remove(recovery.id); } catch {}
        return true;
      }
      if (error instanceof RelayUnroutableError) {
        this.options.log(`[${this.options.role}] managed-agent attachment has no owner route; `
          + `transaction stays queued: ${this.errorText(error)}`);
        await this.nackManagedAgent(agent, nackReplyTo, nackWire, ownerNotices.relayQueued());
        return false;
      }
      this.logError('managed-agent caption/file relay refused', error);
      await this.nackManagedAgent(
        agent, nackReplyTo, nackWire, ownerNotices.relayRefused(this.errorText(error)));
      // Rejection/admission failure and uncertain transport are terminal and
      // visible. Consuming every correlated wire prevents a later partial replay.
      for (const wire of handledWireIds) this.state.remember(wire);
      if (recovery) try { this.attachmentRecovery.remove(recovery.id); } catch {}
      return true;
    } finally {
      if (requestDir) await removeRequestDirectory(requestDir).catch(error => {
        this.logError('managed-agent attachment cleanup failed', error);
      });
    }
  }

  private managedAttachmentReplyWire(
    group: AttachmentGroup, captionWire: string | undefined,
  ): string | undefined {
    const captionReply = group.caption?.reply_to?.wire_id;
    const candidates = new Set<string>();
    if (captionReply) candidates.add(captionReply);
    for (const file of group.files) {
      const wire = file.replyTo?.wire_id;
      if (!wire || wire === captionWire) continue;
      candidates.add(wire);
    }
    if (candidates.size > 1)
      throw new Error('managed-agent caption/file group has conflicting owner reply wires');
    return candidates.values().next().value;
  }

  /**
   * One bounded NACK per wire: an unroutable or refused relay must be visible
   * to the authenticated agent, while its history replays stay quiet. NACK
   * delivery is best-effort — it must never make the failure worse.
   */
  private async nackManagedAgent(
    contact: string, replyTo: string | undefined, wireId: string, notice: string,
  ): Promise<void> {
    if (this.relayNacks.has(wireId)) return;
    this.relayNacks.add(wireId);
    if (this.relayNacks.size > RELAY_NACK_MEMORY)
      this.relayNacks.delete(this.relayNacks.values().next().value as string);
    try {
      await this.send(contact, notice, replyTo);
    } catch (error) {
      this.logError('managed-agent relay NACK delivery failed', error);
    }
  }

  /**
   * Daemon contact resolution is case-exact, so a canonical config CID picked
   * by the sole-owner fallback is translated to the daemon-known contact form
   * when one exists. Last-inbound routes already carry the daemon form.
   */
  private async routableContact(route: { contact: string; basis: string }): Promise<string> {
    if (route.basis !== 'sole-owner') return route.contact;
    try {
      const canonical = canonicalCid(route.contact);
      const match = (await this.contacts()).find(entry => canonicalCid(entry.cid) === canonical);
      return match?.cid ?? route.contact;
    } catch {
      return route.contact;
    }
  }

  private safeRelayMessage(value: unknown): string {
    if (typeof value !== 'string') throw new Error('managed-agent relay must be text');
    const message = value.normalize('NFC');
    if (!message.trim()) throw new Error('managed-agent relay must not be empty');
    if (Array.from(message).length > PROACTIVE_MESSAGE_MAX_CHARS
        || Buffer.byteLength(message) > PROACTIVE_MESSAGE_MAX_BYTES)
      throw new Error(`managed-agent relay exceeds ${PROACTIVE_MESSAGE_MAX_CHARS} characters or `
        + `${PROACTIVE_MESSAGE_MAX_BYTES} bytes`);
    if (/\u0000|[\u202a-\u202e\u2066-\u2069]/u.test(message))
      throw new Error('managed-agent relay contains unsafe control characters');
    return message;
  }

  private async warnOwnerOfUnauthorizedSender(cid: string): Promise<void> {
    const source = /^[A-Fa-f0-9]{64}$/.test(cid)
      ? cid
      : `invalid-${createHash('sha256').update(cid).digest('hex').slice(0, 12)}`;
    try {
      await this.sendProactiveMessage(
        `⚠️ Owner-channel security warning: rejected a message from unauthorized `
          + `sender CID ${source}. Its body was not forwarded.`);
    } catch (error) {
      // Warning delivery must not make hostile input replayable or disclose
      // anything to its sender. Rate/dedupe/no-route failures remain local.
      this.logError('unauthorized sender warning suppressed', error);
    }
  }

  private effectiveOwners(): Set<string> {
    // In managed-agent mode the checked-in fleet configuration is the complete
    // authority boundary. Ignore any legacy dynamic overlay left on disk.
    return this.options.config.agent
      ? new Set(this.options.config.owners)
      : this.authorizations.effective();
  }

  private authorizationIntegrity(): { ok: boolean; error?: string } {
    return this.options.config.agent ? { ok: true } : this.authorizations.integrity();
  }

  /**
   * Report what the session actually did with the prompt, not what the config
   * asked for. `interrupt: true` used to be reported as "your request
   * interrupted the previous task" unconditionally; the session now answers
   * whether anything was cancelled, whether the request is queued behind
   * earlier prompts, or whether it is held until the current task reaches a
   * safe stopping point. Backends that report no delivery state keep the old
   * queuedBehind-based wording.
   */
  private acceptanceNotice(queued: QueuedPrompt): string {
    switch (queued.delivery) {
      case 'interrupted': return ownerNotices.receivedInterrupting();
      case 'deferred': return ownerNotices.receivedDeferred();
      case 'queued': return ownerNotices.receivedQueued(Math.max(1, queued.queuedBehind));
      case 'started': return ownerNotices.receivedStarted();
      default:
        // Interrupting the live turn does not remove prompts which were already
        // accepted into the ACP queue. Never claim this request is running while
        // the session itself says earlier work remains ahead of it.
        return queued.queuedBehind > 0
          ? ownerNotices.receivedQueued(queued.queuedBehind)
          : this.options.config.interrupt
            ? ownerNotices.receivedInterrupting()
            : ownerNotices.receivedStarted();
    }
  }

  private async complete(
    active: ActiveOwnerRequest, outbox: string, queued: QueuedPrompt, activityCursor: number,
  ): Promise<void> {
    const progressMs = this.options.config.progress_interval_ms;
    let lastSeq = activityCursor;
    let startedAt: number | undefined;
    let phase: OwnerProgressPhase = 'starting request';
    let timer: ReturnType<typeof setInterval> | undefined;

    const flushCommentary = () => {
      if (active.commentaryTimer) clearTimeout(active.commentaryTimer);
      active.commentaryTimer = undefined;
      const text = active.commentaryBuffer.trim();
      active.commentaryBuffer = '';
      // Re-checked at flush time so `/comments off` mid-turn also discards a
      // batch that was buffered while relaying was still on.
      if (!text || !this.commentsEnabled || active.commentaryDisabled || active.finalizing) return;
      if (active.commentaryCount >= COMMENTARY_MAX_UPDATES) {
        active.commentaryDisabled = true;
        return;
      }
      let safe: string;
      try { safe = this.safeCommentary(text); }
      catch (error) {
        active.commentaryDisabled = true;
        this.logError('ACP commentary forwarding disabled for unsafe content', error);
        return;
      }
      const digest = createHash('sha256')
        .update(`owner-commentary\0${active.wireId}\0${safe}`).digest('hex');
      let sending: { id: string };
      try {
        sending = this.conversations.beginSend(active.contact, digest, Date.now(), 0, 'all');
      } catch (error) {
        if (error instanceof DuplicateSendError) return;
        active.commentaryDisabled = true;
        this.logError('ACP commentary forwarding disabled by dedupe state', error);
        return;
      }
      active.commentaryCount++;
      active.outboundTail = active.outboundTail
        .then(async () => {
          try {
            if (!this.isEffectiveOwner(active.contact))
              throw new Error('initiating owner is no longer authorized');
            await this.send(active.contact, ownerNotices.comment(safe), active.wireId);
          } catch {
            this.conversations.finishSend(sending.id, 'uncertain');
            throw new Error('ACP commentary delivery outcome is uncertain');
          }
          this.conversations.finishSend(sending.id, 'delivered');
        })
        .catch(error => this.logError('ACP commentary delivery failed', error));
    };

    const acceptCommentary = (event: SessionEvent) => {
      if (!this.commentsEnabled
          || active.commentaryDisabled || active.finalizing || event.turnId !== queued.promptId
          || event.kind !== 'agent_text' || event.messagePhase !== 'commentary'
          || event.replayed || event.origin?.kind !== 'owner'
          || event.origin.requestId !== active.requestId
          || typeof event.messageId !== 'string' || !event.messageId
          || typeof event.text !== 'string' || !event.text) return;
      const key = createHash('sha256')
        .update(`${event.messageId}\0${event.text}`).digest('hex');
      if (active.commentaryKeys.has(key)) return;
      active.commentaryKeys.add(key);
      if (active.commentaryKeys.size > COMMENTARY_DEDUPE_LIMIT)
        active.commentaryKeys.delete(active.commentaryKeys.values().next().value as string);
      let chars = Array.from(active.commentaryBuffer).length;
      let bytes = Buffer.byteLength(active.commentaryBuffer);
      for (const point of event.text) {
        const pointBytes = Buffer.byteLength(point);
        if (chars >= COMMENTARY_MAX_CHARS || bytes + pointBytes > COMMENTARY_MAX_BYTES) {
          flushCommentary();
          if (active.commentaryDisabled) return;
          chars = 0;
          bytes = 0;
        }
        active.commentaryBuffer += point;
        chars++;
        bytes += pointBytes;
      }
      if (/\n\s*\n$/u.test(active.commentaryBuffer)) {
        flushCommentary();
        return;
      }
      if (!active.commentaryTimer) {
        active.commentaryTimer = setTimeout(flushCommentary, COMMENTARY_FLUSH_MS);
        active.commentaryTimer.unref?.();
      }
    };

    const reportProgress = () => {
      const events = this.options.session.eventsSince(lastSeq);
      lastSeq = Math.max(lastSeq, this.latestEventSeq(events));
      const activity = events.filter(event => event.turnId === queued.promptId);
      if (!activity.length) return;
      startedAt ??= Date.parse(activity[0].at) || Date.now();
      phase = this.progressPhase(activity) ?? phase;
      const started = activity.filter(event => event.kind === 'tool_call').length;
      const completed = activity.filter(event =>
        event.kind === 'tool_update' && event.status === 'completed').length;
      // Token/thought chunks are transport activity, not evidence of progress.
      // Permission transitions and errors are material even without a tool.
      const activityUpdates = activity.filter(event =>
        event.kind === 'permission' || event.kind === 'error').length;
      if (!started && !completed && !activityUpdates) return;
      const notice = ownerNotices.progress(
        Date.now() - startedAt, phase, started, completed, activityUpdates);
      // Preserve wire ordering if a progress send overlaps turn completion.
      active.outboundTail = active.outboundTail
        .then(async () => { await this.send(active.contact, notice, active.wireId); })
        .catch(error => this.logError('progress notice failed', error));
    };

    // A queued request used to create its 30-second interval immediately. A
    // backlog of three requests therefore produced three permanent notice
    // streams saying "waiting behind earlier requests" without any work. Arm
    // the interval only after this exact prompt emits its first session event.
    const startProgress = (event?: SessionEvent) => {
      if (timer || progressMs <= 0) return;
      if (event && event.turnId !== queued.promptId) return;
      const observed = event ? [event] : this.options.session.eventsSince(activityCursor)
        .filter(item => item.turnId === queued.promptId);
      if (!observed.length) return;
      startedAt = Date.parse(observed[0].at) || Date.now();
      timer = setInterval(reportProgress, progressMs);
      timer.unref();
    };
    const unsubscribe = typeof this.options.session.subscribe === 'function'
      ? this.options.session.subscribe(event => {
        startProgress(event);
        // Automatic commentary is an ACP phase extension. Other backends and
        // older adapters retain their established final-only behavior.
        if (this.options.session.backend === 'acp') acceptCommentary(event);
      })
      : () => undefined;
    startProgress();

    let result: TurnResult;
    try { result = await queued.completion; }
    finally {
      unsubscribe();
      if (timer) clearInterval(timer);
      if (active.commentaryTimer) clearTimeout(active.commentaryTimer);
    }
    flushCommentary();
    active.finalizing = true;
    await active.outboundTail;

    const output = result.output?.trim();
    if (result.succeeded && output) await this.sendFinal(active.contact, output, active.wireId);
    else if (result.succeeded) await this.send(active.contact,
      ownerNotices.completedWithoutText(), active.wireId);
    else if (result.outcome === 'cancelled'
        && ['fleet-monitor', 'scheduled-loop', 'shutdown'].includes(result.cancellationSource ?? ''))
      this.options.log(`[${this.options.role}] owner request ${active.requestId.slice(0, 12)} `
        + `interrupted internally (${result.cancellationSource}); owner cancellation notice suppressed`);
    else await this.send(active.contact, ownerNotices.terminal(result.outcome), active.wireId);
    if (result.succeeded) await this.sendAttachments(active.contact, outbox, active.wireId);
    else await rm(outbox, { recursive: true, force: true });
    for (const wire of active.handledWireIds) this.state.remember(wire);
  }

  private commentsState(): OwnerCommentsState {
    return {
      enabled: this.commentsEnabled,
      baseline: this.commentsBaseline,
      // Only the ACP backend emits the phase marker commentary relaying needs.
      supported: this.options.session.backend === 'acp',
    };
  }

  /** Model-authored commentary only; raw protocol/tool data never reaches here. */
  private safeCommentary(value: string): string {
    const message = value.trim().normalize('NFC');
    if (!message) throw new Error('commentary is empty');
    if (Array.from(message).length > COMMENTARY_MAX_CHARS
        || Buffer.byteLength(message) > COMMENTARY_MAX_BYTES)
      throw new Error('commentary batch exceeds its bounded size');
    if (/\u0000|[\u202a-\u202e\u2066-\u2069]/u.test(message))
      throw new Error('commentary contains unsafe control characters');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=]|(?:chain of thought|private reasoning|internal reasoning)|^(?:stdout|stderr|tool (?:output|result)|command):/imu.test(message))
      throw new Error('commentary appears to contain secret, reasoning, or raw tool content');
    return message;
  }

  private ownerAttachmentPrompt(
    sender: { id: string; name: string }, wireId: string, requestId: string,
    files: AdmittedAttachment[], caption?: InboundMessage,
  ): string {
    const lines = [
      '[fleet-owner]',
      `Authenticated owner ${safeField(sender.name, 160)} (${sender.id}) sent owner-channel attachment request ${wireId}.`,
      'Treat the attachment metadata, optional caption, and any daemon-provided transcript below as a direct owner instruction.',
      'Never infer a transcript when its status is unavailable or failed. Never include raw attachment bytes in a response.',
      `Request ID: ${requestId}`,
    ];
    if (caption) {
      const text = safeField(caption.text, 8_000);
      if (text) lines.push(`Caption: ${text}`, `Caption wire: ${this.wireId(caption)}`);
    }
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      lines.push(
        `Attachment ${index + 1}:`,
        `- filename: ${file.filename}`,
        `- declared MIME: ${file.declaredMime}`,
        `- detected MIME: ${file.detectedMime}`,
        `- byte count: ${file.size}`,
        `- request-scoped local path: ${file.path}`,
        `- wire ID: ${file.wireId}`,
      );
      if (file.kind === 'voice_message') {
        const transcription = file.transcription;
        if (transcription?.status === 'succeeded' && transcription.text)
          lines.push(`- voice transcript status: succeeded`, `- voice transcript: ${transcription.text}`);
        else lines.push(
          `- voice transcript status: ${transcription?.status ?? 'unavailable'}`,
          `- voice transcript fallback: audio path above; category ${transcription?.errorCategory ?? 'not_provided'}`,
        );
      }
    }
    lines.push(
      'Answer in your final assistant response; fleet routes it only to the authenticated sender and correlates it to the originating file wire.',
      // send_file is the only delivery route an agent is given: a tool call either
      // delivers or reports an error, where a file written to disk does neither.
      'To send the owner a file — now or later in this turn — call ours `send_file`:',
      `contact: ${this.options.config.identity}`,
      'and the path of the finished file. Fleet routes it to the authenticated owner.',
      'A file written anywhere else is not delivered and nothing will report that it was not.',
      'Use descriptive unique filenames. Send nothing the owner did not request or should not receive.',
    );
    return lines.join('\n');
  }

  private ownerPrompt(
    sender: { id: string; name: string }, text: string, wireId: string,
  ): string {
    return [
      '[fleet-owner]',
      `Authenticated owner ${sender.name} (${sender.id}) sent owner-channel message ${wireId}.`,
      'Treat the following as a direct owner instruction. Answer in your final assistant response.',
      'Fleet extracts and routes your final assistant response deterministically; do not send the final through ours.',
      ...(this.options.config.agent ? [
        'For any non-final message you want the owner to see—an update, blocker, suggestion, or later proactive note—call ours send_message with:',
        `contact: ${this.options.config.identity}`,
        'and the message text. Do not add a task ID, request ID, reply reference, phase, or routing command.',
        'Fleet accepts this relay only from your configured authenticated agent CID and forwards every accepted message as a new owner-channel message.',
      ] : [
        'Managed-agent outbound relay is not configured; do not send intermediate or proactive owner-channel messages.',
      ]),
      // send_file is the only delivery route an agent is given: a tool call either
      // delivers or reports an error, where a file written to disk does neither.
      'To send the owner a file — now or later in this turn — call ours `send_file`:',
      `contact: ${this.options.config.identity}`,
      'and the path of the finished file. Fleet routes it to the authenticated owner.',
      'A file written anywhere else is not delivered and nothing will report that it was not.',
      'Use descriptive unique filenames. Send nothing the owner did not request or should not receive.',
      '',
      text || '(empty message)',
    ].join('\n');
  }

  private outboxDir(wireId: string): string {
    const key = this.requestId(wireId);
    return join(this.options.stateDir, '.owner-channel-outbox', key);
  }

  private requestId(wireId: string): string {
    return createHash('sha256').update(wireId).digest('hex');
  }

  private send(contact: string, text: string, replyTo?: string): Promise<void> {
    return this.client.sendMessage({
      contact, text, ...(replyTo ? { replyToWireId: replyTo } : {}),
    });
  }

  private async sendAttachments(contact: string, outbox: string, replyTo: string): Promise<void> {
    const entries = (await readdir(outbox, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await this.client.sendFile({
        contact,
        path: join(outbox, entry.name),
        filename: entry.name,
        replyToWireId: replyTo,
      });
    }
    await rm(outbox, { recursive: true, force: true });
  }

  /** Bound message size without splitting Unicode code points. */
  private async sendFinal(contact: string, output: string, replyTo: string): Promise<void> {
    const points = Array.from(output);
    const chunks: string[] = [];
    for (let offset = 0; offset < points.length; offset += 8_000)
      chunks.push(points.slice(offset, offset + 8_000).join(''));
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? ownerNotices.chunk(i + 1, chunks.length) : '';
      await this.send(contact, prefix + chunks[i], replyTo);
    }
  }

  private wireId(message: InboundMessage): string {
    const wire = String(message.wire_id ?? '').trim();
    if (wire) return wire;
    return Number.isInteger(message.msg_id) ? `msg:${message.msg_id}` : '';
  }

  private sender(message: InboundMessage): { id: string; name: string } {
    // Authenticated routing data, straight from the daemon's typed envelope.
    // The id still goes through the CID checks in acceptedSender/isEffectiveOwner.
    const source = message.from as { id?: unknown; name?: unknown } | undefined;
    const id = String(source?.id ?? '');
    return { id, name: String(source?.name ?? id) };
  }

  private latestEventSeq(events: SessionEvent[]): number {
    return events.reduce((latest, event) => Math.max(latest, event.seq), 0);
  }

  /** Map only event shape and allowlisted status to owner-safe phase text. */
  private progressPhase(events: SessionEvent[]): OwnerProgressPhase | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      switch (event.kind) {
        case 'tool_call': return 'using tools';
        case 'tool_update':
          return event.status === 'completed' ? 'reviewing tool results' : 'using tools';
        case 'permission':
          return event.status === 'pending'
            ? 'waiting for approval' : 'resuming after permission decision';
        case 'agent_text': return 'drafting response';
        case 'thought': return 'planning next step';
        case 'error': return 'recovering from session error';
        case 'state':
          if (event.status === 'running') return 'working on request';
          break;
        case 'turn_stop': break;
      }
    }
    return undefined;
  }

  private async watchLoop(): Promise<void> {
    const sleep = this.options.binderDeps?.sleep
      ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const restored = this.readWatchState();
    let state = restored.state;
    if (restored.recovered)
      state = this.writeWatchState(state, 'OWNER_WATCH_STATE_RECOVERED');
    let delayMs = 1_000;
    let attempts = 0;
    while (!this.stopping) {
      const ctrl = new AbortController();
      this.watchAbort = ctrl;
      try {
        // This drain is unconditional at EVERY establishment. Starting the SDK
        // stream at 0 then replays notification hints instead of tip-priming,
        // so mail arriving after the drain but before the first request cannot
        // fall into a gap. Persistent history plus fleet's body-free claim
        // journal is authoritative; durable wire-ID dedupe makes hints harmless.
        await this.drain();
        if (this.stopping) return;
        state = this.writeWatchState(
          state, 'OWNER_WATCH_CONNECTING', { reconnected: attempts > 0 });
        attempts++;
        for await (const _event of this.client.watchNotifications(
          this.options.config.identity, { since: 0, signal: ctrl.signal },
        )) {
          if (this.stopping) return;
          state = this.writeWatchState(
            state, 'OWNER_WATCH_CONNECTED', { resetFailures: true });
          delayMs = 1_000;
          // Notification events contain no bodies and are only wake hints.
          // Draining is idempotent at the turn boundary because wire IDs are
          // recorded before a managed request is dispatched.
          await this.drain();
        }
        if (!this.stopping) throw new Error('ours SDK notification stream ended');
      } catch (error) {
        if (this.stopping) return;
        // SDK 2 deliberately hides transport status behind its typed stream.
        // Do not parse error prose to rediscover it: every failure follows the
        // same capped retry path forever, and the pre-establishment drain makes
        // that retry correctness-preserving.
        state = this.writeWatchState(
          state, 'OWNER_WATCH_STREAM_ERROR', { failed: true });
        this.options.log(`[${this.options.role}] owner watch reconnect `
          + `reason=OWNER_WATCH_STREAM_ERROR delay_ms=${delayMs} `
          + `failures=${state.consecutiveFailures}: ${this.errorText(error)}`);
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, OWNER_WATCH_BACKOFF_MAX_MS);
      } finally {
        if (this.watchAbort === ctrl) this.watchAbort = undefined;
      }
    }
  }

  /**
   * `recovered` distinguishes a first-ever start from unreadable persisted
   * diagnostics. Notification correctness does not depend on this state: every
   * establishment drains and then replays SDK hints from offset zero.
   */
  private readWatchState(): { state?: OwnerWatchState; recovered: boolean } {
    const path = join(this.options.stateDir, '.owner-channel-watch.json');
    if (!existsSync(path)) return { recovered: false };
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number;
        reconnects?: number;
        consecutiveFailures?: number;
        reason?: string;
        updatedAt?: string;
      };
      if ((value.version !== 1 && value.version !== 2)
          || !Number.isSafeInteger(value.reconnects) || value.reconnects! < 0
          || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures! < 0)
        throw new Error('invalid owner watch state');
      const reasons = new Set<OwnerWatchReason>([
        'OWNER_WATCH_CONNECTING', 'OWNER_WATCH_CONNECTED',
        'OWNER_WATCH_STREAM_ERROR', 'OWNER_WATCH_STATE_RECOVERED',
      ]);
      return { state: {
        version: 2,
        reconnects: value.reconnects!,
        consecutiveFailures: value.consecutiveFailures!,
        reason: reasons.has(value.reason as OwnerWatchReason)
          ? value.reason as OwnerWatchReason : 'OWNER_WATCH_CONNECTING',
        updatedAt: typeof value.updatedAt === 'string'
          ? value.updatedAt : new Date(this.options.binderDeps?.now?.() ?? Date.now()).toISOString(),
      }, recovered: false };
    } catch {
      this.options.log(`[${this.options.role}] owner watch `
        + 'reason=OWNER_WATCH_STATE_RECOVERED invalid persisted counters; restarting safely');
      return { recovered: true };
    }
  }

  private writeWatchState(
    previous: OwnerWatchState | undefined, reason: OwnerWatchReason,
    options: { failed?: boolean; resetFailures?: boolean; reconnected?: boolean } = {},
  ): OwnerWatchState {
    const state: OwnerWatchState = {
      version: 2,
      reconnects: (previous?.reconnects ?? 0) + (options.reconnected ? 1 : 0),
      consecutiveFailures: options.failed
        ? (previous?.consecutiveFailures ?? 0) + 1
        : options.resetFailures ? 0 : previous?.consecutiveFailures ?? 0,
      reason,
      updatedAt: new Date(this.options.binderDeps?.now?.() ?? Date.now()).toISOString(),
    };
    replaceFileAtomically(
      join(this.options.stateDir, '.owner-channel-watch.json'), `${JSON.stringify(state)}\n`, 0o600);
    return state;
  }

  private errorText(error: unknown): string {
    return (error as Error)?.message ?? String(error);
  }

  private logError(context: string, error: unknown): void {
    this.options.log(`[${this.options.role}] owner channel ${context}: ${this.errorText(error)}`);
  }
}
