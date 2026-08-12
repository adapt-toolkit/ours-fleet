import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import {
  DEFAULT_OWNER_ATTACHMENT_MIME, canonicalCid,
  type OwnerAttachmentConfig, type OwnerChannelConfig,
} from '../config.js';
import type { QueuedPrompt, SessionEvent, SessionHandle, TurnResult } from '../session/types.js';
import { VERSION } from '../version.js';
import {
  dispatchOwnerCommand, fleetCliOps, isOwnerCommandText,
  type OwnerCommandContext, type OwnerFleetOps,
} from './commands.js';
import type { ManagedFleetSpawnResult } from '../fleet-proxy.js';
import { OursMcpClient, type OursToolClient } from './mcp.js';
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
  validateAttachmentRelaySelection,
  type AdmittedAttachment, type IncomingAttachment, type PendingAttachmentRequest,
} from './attachments.js';
import {
  acquireOwnerBinderLease, OWNER_BIND_HANDOFF_TIMEOUT_MS,
  type OwnerBinderDeps, type OwnerBinderLease,
} from './binder.js';

interface InboundMessage {
  msg_id?: number;
  wire_id?: string;
  text?: string;
  from?: { id?: string; name?: string } | string;
  sender?: { id?: string; name?: string } | string;
  sender_id?: string;
  sender_name?: string;
  reply_to?: { wire_id?: string; sentence?: number } | null;
}

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
  command?: string;
  log(line: string): void;
  client?: OursToolClient;
  /** Test seam; production uses `ours-mcp watch <identity>`. */
  watch?: (identity: string) => ChildProcessWithoutNullStreams;
  /** Test seam; production uses the detached ours-fleet CLI (`fleetCliOps`). */
  fleet?: OwnerFleetOps;
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
  status: string;
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

/** A relay attempt that failed only because no owner route exists yet. */
class RelayUnroutableError extends Error {}

/**
 * Fleet-owned trusted ingress. The agent never binds this identity and never
 * chooses its reply recipient; both are fixed from authenticated message data.
 */
export class OwnerChannel implements OwnerChannelHandle {
  private readonly client: OursToolClient;
  private readonly state: OwnerChannelState;
  private readonly authorizations: OwnerAuthorizationState;
  private readonly conversations: OwnerConversationState;
  private readonly tasks: OwnerTaskState;
  private readonly attachmentRecovery: AttachmentRecoveryState;
  private readonly attachmentConfig: OwnerAttachmentConfig;
  private readonly attachmentRoot: string;
  /**
   * Wire IDs whose turn is still running. They stay OUT of the durable state
   * (a crash must replay them) but must not be queued twice while live.
   */
  private readonly inFlight = new Set<string>();
  /** Wires already NACKed to the managed agent, so a deferred replay stays quiet. */
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
  private watchProcess?: ChildProcessWithoutNullStreams;
  private watchTask?: Promise<void>;
  private drainTask?: Promise<void>;
  private drainRequested = false;
  private readonly completionTasks = new Set<Promise<void>>();
  private readonly activeRequests = new Map<string, ActiveOwnerRequest>();
  private managementTail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private binder?: OwnerBinderLease;
  private binderOwnedInternally = false;

  private readonly fleetOps: OwnerFleetOps;

  constructor(private readonly options: OwnerChannelOptions) {
    this.client = options.client ?? new OursMcpClient(
      options.command, options.env, line => options.log(`[${options.role}] owner channel ${line}`));
    this.fleetOps = options.fleet ?? fleetCliOps(options.role, options.configPath);
    this.state = new OwnerChannelState(join(options.stateDir, '.owner-channel-state.json'));
    this.authorizations = new OwnerAuthorizationState(
      join(options.stateDir, '.owner-channel-owners.json'), options.config.owners);
    this.conversations = new OwnerConversationState(
      join(options.stateDir, '.owner-channel-conversations.json'));
    this.tasks = new OwnerTaskState(join(options.stateDir, '.owner-channel-tasks.json'));
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
          await this.client.callTool('choose_identity', { name: this.options.config.identity });
          break;
        } catch (error) {
          const message = (error as Error)?.message ?? String(error);
          const liveConflict = /currently bound to another live session/i.test(message);
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
    this.watchTask = this.watchLoop();
    // Do not make role startup wait for an old owner request to finish a turn.
    void this.drain().catch(error => this.logError('initial drain failed', error));
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
    const watch = this.watchProcess;
    this.watchProcess = undefined;
    if (watch && watch.exitCode === null) watch.kill('SIGTERM');
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
      const inherited = event.inherited.length
        ? ` Supervisor inherited omitted defaults: ${event.inherited.join(', ')}.` : '';
      await this.sendProactiveMessage(
        `🧑‍💻 ${event.caller} spawned ${event.lifetime} agent ${event.role} `
          + `(${event.harness}/${event.session}${model}; ${monitor}).${inherited}`,
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
        const raw = await this.client.callTool('generate_invite', request.name ? { name: request.name } : {});
        const invite = typeof raw === 'string' ? raw : String((raw as { invite?: unknown })?.invite ?? '');
        if (!invite) throw new Error('ours-mcp returned no invite');
        return { action: request.action, invite };
      }
      case 'contact_add': {
        if (typeof request.invite !== 'string' || !request.invite)
          throw new Error('invite is required');
        if (Buffer.byteLength(request.invite) > 48 * 1024)
          throw new Error('invite exceeds 49152 bytes');
        this.assertLabel(request.name);
        let raw: unknown;
        try {
          raw = await this.client.callTool('add_contact', {
            invite: request.invite, ...(request.name ? { name: request.name } : {}),
          });
        } catch {
          // Daemon errors are not allowed to reflect invite material through
          // the control response, CLI stderr, or supervisor logs.
          throw new Error('ours-mcp could not accept the contact invite');
        }
        return { action: request.action, status: 'pending', contact: this.contact(raw) };
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

  private async contacts(): Promise<OwnerContact[]> {
    const raw = await this.client.callTool('list_contacts');
    const values = Array.isArray(raw) ? raw : (raw as { contacts?: unknown })?.contacts;
    if (!Array.isArray(values)) return [];
    return values.map(value => this.contact(value)).filter((v): v is OwnerContact => Boolean(v))
      .sort((a, b) => a.cid.localeCompare(b.cid));
  }

  private contact(raw: unknown): OwnerContact | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as Record<string, unknown>;
    const cid = String(value.cid ?? value.id ?? value.container_id ?? value.containerId ?? '');
    if (!/^[A-Fa-f0-9]{64}$/.test(cid)) return undefined;
    const humanRaw = value.human ?? value.root;
    const human = humanRaw && typeof humanRaw === 'object' ? humanRaw as Record<string, unknown> : undefined;
    return {
      cid,
      name: this.safeMetadata(value.name ?? value.display_name ?? cid),
      status: this.safeMetadata(value.status ?? 'established'),
      ...(typeof value.kind === 'string' ? { kind: this.safeMetadata(value.kind) } : {}),
      ...(human ? { human: {
        ...(typeof (human.cid ?? human.id) === 'string'
          && /^[A-Fa-f0-9]{64}$/.test(String(human.cid ?? human.id))
          ? { cid: String(human.cid ?? human.id) } : {}),
        ...(human.name ? { name: this.safeMetadata(human.name) } : {}),
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
    // A finite cap protects the supervisor if a broken daemon repeats unread
    // messages forever. A watch notification will resume draining later.
    for (let pass = 0; pass < 100 && !this.stopping; pass++) {
      const [raw, fileResult] = await Promise.all([
        this.client.callTool('get_messages') as Promise<{ messages?: unknown }>,
        this.client.callTool('list_incoming_files')
          .catch(error => {
            this.logError('attachment metadata inspection unavailable', error);
            return undefined;
          }),
      ]);
      const messages = Array.isArray(raw?.messages)
        ? raw.messages.filter(message => message && typeof message === 'object') as InboundMessage[]
        : [];
      let files: IncomingAttachment[] = [];
      try { files = parseIncomingAttachments(fileResult); }
      catch (error) { this.logError('attachment metadata inspection unavailable', error); }
      const pending = this.attachmentRecovery.integrity() ? this.attachmentRecovery.list() : [];
      const pendingWires = new Set(pending.flatMap(item => item.fileWireIds));
      files = files.filter(file => (file.status === 'unread' || pendingWires.has(file.wireId))
        && !this.state.has(file.wireId));
      if (!messages.length && !files.length) return;

      // get_messages marks the batch processed. Requeue allowed, unhandled
      // inputs before executing them so a mid-turn process crash can replay.
      const deferred = messages.filter(message => {
        const wireId = this.wireId(message);
        return wireId && !this.state.has(wireId)
          && this.acceptedSender(this.sender(message).id)
          && Number.isInteger(message.msg_id);
      }).map(message => message.msg_id!);
      if (deferred.length)
        await this.client.callTool('defer_messages', { msg_ids: deferred });

      let advanced = false;
      const consumedMessages = new Set<InboundMessage>();
      const groups = this.attachmentGroups(files, messages, pending, consumedMessages);
      for (const group of groups)
        advanced = await this.handleAttachmentGroup(group) || advanced;
      for (const message of messages) {
        if (!consumedMessages.has(message)) advanced = await this.handle(message) || advanced;
      }

      // Deferred in-flight messages are intentionally visible again until
      // their correlated response is delivered. Do not spin on those replay
      // copies; a new watch event or completion-triggered drain will resume.
      if (!advanced) return;
    }
    this.options.log(`[${this.options.role}] owner channel drain capped at 100 batches`);
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
      // A managed-agent caption is deferred before retrieval. If recovery sees
      // the processed file before that body is replayed, keep the file reserved
      // by the journal until both halves are present again.
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
      const processed = group.files.filter(file => file.status !== 'unread');
      const retrieved = unread.length
        ? parseRetrievedAttachments(await this.client.callTool('get_files', {
          wire_ids: unread.map(file => file.wireId),
        }), unread)
        : [];
      for (const file of processed) {
        if (!group.recovery) throw new Error('unexpected processed attachment without recovery route');
        const recoveryPath = join(requestDir, `.recovered-${file.wireId}-${randomUUID()}`);
        await this.client.callTool('save_file', { wire_id: file.wireId, dest_path: recoveryPath });
        retrieved.push(await recoveredAttachment(file, recoveryPath));
      }
      const order = new Map(group.files.map((file, index) => [file.wireId, index]));
      retrieved.sort((a, b) => order.get(a.wireId)! - order.get(b.wireId)!);
      const admitted = await admitAttachments(retrieved, requestDir, this.attachmentConfig);
      outbox = this.outboxDir(originWireId);
      await mkdir(outbox, { recursive: true, mode: 0o700 });
      const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
      const queued = await this.options.session.queuePrompt(
        this.ownerAttachmentPrompt(sender, originWireId, requestId, outbox, admitted, group.caption),
        {
          interrupt: this.options.config.interrupt,
          ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
          origin: { kind: 'owner', requestId,
            ...(group.caption ? { displayText: String(group.caption.text ?? '') } : {}) },
        });
      const accepted = this.options.config.interrupt
        ? ownerNotices.receivedInterrupting()
        : queued.queuedBehind > 0
          ? ownerNotices.receivedQueued(queued.queuedBehind)
          : ownerNotices.receivedStarted();
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
          // No owner route exists yet. Leave the wire deferred and unconsumed
          // so the daemon replays it after the first owner contact, and tell
          // the authenticated agent once so the wait is never silent.
          this.options.log(`[${this.options.role}] owner channel managed-agent relay has no owner `
            + `route yet; message stays queued: ${this.errorText(error)}`);
          await this.nackManagedAgent(sender.id, message, wireId, ownerNotices.relayQueued());
          return false;
        } else {
          this.logError('managed-agent message relay refused', error);
          await this.nackManagedAgent(
            sender.id, message, wireId, ownerNotices.relayRefused(this.errorText(error)));
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
      queued = await this.options.session.queuePrompt(
        this.ownerPrompt(sender, text, wireId, outbox), {
        interrupt: this.options.config.interrupt,
        ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
        origin: { kind: 'owner', requestId, displayText: text },
      });
    } catch (error) {
      await rm(outbox, { recursive: true, force: true });
      this.logError('request delivery failed', error);
      await this.send(sender.id, ownerNotices.deliveryFailed(this.options.role), wireId);
      this.state.remember(wireId);
      return true;
    }

    // Interrupting the live turn does not remove prompts which were already
    // accepted into the ACP queue. Never claim this request is running while
    // the session itself says earlier work remains ahead of it.
    const accepted = queued.queuedBehind > 0
      ? ownerNotices.receivedQueued(queued.queuedBehind)
      : this.options.config.interrupt
        ? ownerNotices.receivedInterrupting()
        : ownerNotices.receivedStarted();
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
      interrupt: () => this.options.session.interrupt('owner'),
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
    const queued = await this.options.session.queuePrompt(command, {
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
    await this.send(sender.id,
      ownerNotices.restarting(this.options.role, command, mode), wireId);
    this.state.remember(wireId);
    this.options.log(`[${this.options.role}] owner requested ${command}`);
    await this.fleetOps.restart(mode);
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
    const nackMessage = group.caption ?? { wire_id: nackWire };
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
      const processed = group.files.filter(file => file.status !== 'unread');
      const retrieved = unread.length
        ? parseRetrievedAttachments(await this.client.callTool('get_files', {
          wire_ids: unread.map(file => file.wireId),
        }), unread)
        : [];
      for (const file of processed) {
        if (!group.recovery) throw new Error('unexpected processed attachment without recovery route');
        const recoveryPath = join(requestDir, `.recovered-${file.wireId}-${randomUUID()}`);
        await this.client.callTool('save_file', { wire_id: file.wireId, dest_path: recoveryPath });
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
          await this.client.callTool('send_file', {
            contact, path: file.path, filename: file.filename,
            ...(replyTo ? { reply_to_wire_id: replyTo } : {}),
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
        await this.nackManagedAgent(agent, nackMessage, nackWire, ownerNotices.relayQueued());
        return false;
      }
      this.logError('managed-agent caption/file relay refused', error);
      await this.nackManagedAgent(
        agent, nackMessage, nackWire, ownerNotices.relayRefused(this.errorText(error)));
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
   * to the authenticated agent, while its deferred replays stay quiet. NACK
   * delivery is best-effort — it must never make the failure worse.
   */
  private async nackManagedAgent(
    contact: string, message: InboundMessage, wireId: string, notice: string,
  ): Promise<void> {
    if (this.relayNacks.has(wireId)) return;
    this.relayNacks.add(wireId);
    if (this.relayNacks.size > RELAY_NACK_MEMORY)
      this.relayNacks.delete(this.relayNacks.values().next().value as string);
    try {
      await this.send(contact, notice, message.wire_id ? wireId : undefined);
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
    outbox: string, files: AdmittedAttachment[], caption?: InboundMessage,
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
      `To attach response files, write regular files only to: ${outbox}`,
    );
    return lines.join('\n');
  }

  private ownerPrompt(
    sender: { id: string; name: string }, text: string, wireId: string,
    outbox: string,
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
      'To attach files to your response, copy each finished file directly into this fleet outbox:',
      outbox,
      'Fleet sends every regular file in that directory to the authenticated owner, correlated to this request.',
      'Use descriptive unique filenames. Put nothing there that the owner did not request or should not receive.',
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

  private send(contact: string, text: string, replyTo?: string): Promise<unknown> {
    return this.client.callTool('send_message', {
      contact, text, ...(replyTo ? { reply_to_wire_id: replyTo } : {}),
    });
  }

  private async sendAttachments(contact: string, outbox: string, replyTo: string): Promise<void> {
    const entries = (await readdir(outbox, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await this.client.callTool('send_file', {
        contact,
        path: join(outbox, entry.name),
        filename: entry.name,
        reply_to_wire_id: replyTo,
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
    const source = message.from ?? message.sender;
    if (typeof source === 'string') return { id: source, name: source };
    const id = String(source?.id ?? message.sender_id ?? '');
    return { id, name: String(source?.name ?? message.sender_name ?? id) };
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
    let delayMs = 1_000;
    while (!this.stopping) {
      try {
        const child = this.options.watch?.(this.options.config.identity) ?? spawn(
          this.options.command ?? 'ours-mcp', ['watch', this.options.config.identity], {
            env: { ...process.env, ...(this.options.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'],
          });
        this.watchProcess = child;
        await new Promise<void>((resolve, reject) => {
          if (child.pid) { resolve(); return; }
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        createInterface({ input: child.stderr }).on('line', line =>
          this.options.log(`[${this.options.role}] owner watch: ${line}`));
        delayMs = 1_000;
        // Drain at every (re)attachment, not only after a future notification:
        // a failed send/turn leaves the input deferred and may not emit another
        // watch line by itself.
        await this.drain();
        for await (const _line of createInterface({ input: child.stdout })) {
          if (this.stopping) break;
          await this.drain();
        }
        if (!this.stopping) throw new Error('watch exited');
      } catch (error) {
        if (!this.stopping) {
          this.logError('watch failed; retrying', error);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          delayMs = Math.min(delayMs * 2, 30_000);
        }
      } finally {
        const child = this.watchProcess;
        this.watchProcess = undefined;
        if (child && child.exitCode === null) child.kill('SIGTERM');
      }
    }
  }

  private errorText(error: unknown): string {
    return (error as Error)?.message ?? String(error);
  }

  private logError(context: string, error: unknown): void {
    this.options.log(`[${this.options.role}] owner channel ${context}: ${this.errorText(error)}`);
  }
}
