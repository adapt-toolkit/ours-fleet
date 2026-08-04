import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import {
  DEFAULT_OWNER_ATTACHMENT_MIME, type OwnerAttachmentConfig, type OwnerChannelConfig,
} from '../config.js';
import type { QueuedPrompt, SessionEvent, SessionHandle, TurnResult } from '../session/types.js';
import { OursMcpClient, type OursToolClient } from './mcp.js';
import { ownerNotices, type OwnerProgressPhase, type OwnerUpdatePhase } from './notices.js';
import {
  OwnerAuthorizationState, OwnerChannelState, OwnerConversationState,
  type OwnerEntry,
} from './state.js';
import {
  OwnerTaskState, ownerTaskAuditId, ownerTaskDigest, type OwnerTaskPhase,
} from './tasks.js';
import {
  AttachmentRecoveryState, admitAttachments, cleanupAttachmentRoot,
  parseIncomingAttachments, parseRetrievedAttachments, prepareAttachmentDirectory,
  recoveredAttachment, removeRequestDirectory, safeField, validateAttachmentSelection,
  type AdmittedAttachment, type IncomingAttachment, type PendingAttachmentRequest,
} from './attachments.js';

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
  config: OwnerChannelConfig;
  session: SessionHandle;
  stateDir: string;
  env?: Record<string, string>;
  command?: string;
  log(line: string): void;
  client?: OursToolClient;
  /** Test seam; production uses `ours-mcp watch <identity>`. */
  watch?: (identity: string) => ChildProcessWithoutNullStreams;
}

export interface OwnerChannelHandle {
  start(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
  manage(request: OwnerChannelManagementRequest): Promise<OwnerChannelManagementResult>;
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
  | { action: 'task_report'; taskId: string; phase: OwnerTaskPhase; message: string };

export type OwnerChannelManagementResult =
  | { action: 'contact_list'; contacts: OwnerContact[] }
  | { action: 'contact_invite'; invite: string }
  | { action: 'contact_add'; status: 'pending'; contact?: OwnerContact }
  | { action: 'owner_list'; integrity: { ok: boolean; error?: string }; owners: OwnerEntry[] }
  | { action: 'owner_authorize' | 'owner_revoke'; owner: OwnerEntry }
  | { action: 'request_update'; requestId: string; sequence: number }
  | { action: 'task_open'; taskId: string; expiresAt: string }
  | { action: 'task_report'; taskId: string; phase: OwnerTaskPhase; sequence: number; state: 'open' | 'closed' };

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
}

const OWNER_UPDATE_MIN_INTERVAL_MS = 5_000;
const OWNER_UPDATE_MAX_COUNT = 20;
const OWNER_UPDATE_MAX_CHARS = 280;
const OWNER_UPDATE_MAX_BYTES = 1_024;
const PROACTIVE_MESSAGE_MAX_CHARS = 4_000;
const PROACTIVE_MESSAGE_MAX_BYTES = 16_384;

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
  private stopping = false;
  private watchProcess?: ChildProcessWithoutNullStreams;
  private watchTask?: Promise<void>;
  private drainTask?: Promise<void>;
  private drainRequested = false;
  private readonly completionTasks = new Set<Promise<void>>();
  private readonly activeRequests = new Map<string, ActiveOwnerRequest>();
  private managementTail: Promise<unknown> = Promise.resolve();
  private ready = false;

  constructor(private readonly options: OwnerChannelOptions) {
    this.client = options.client ?? new OursMcpClient(
      options.command, options.env, line => options.log(`[${options.role}] owner channel ${line}`));
    this.state = new OwnerChannelState(join(options.stateDir, '.owner-channel-state.json'));
    this.authorizations = new OwnerAuthorizationState(
      join(options.stateDir, '.owner-channel-owners.json'), options.config.owners);
    this.conversations = new OwnerConversationState(
      join(options.stateDir, '.owner-channel-conversations.json'));
    this.tasks = new OwnerTaskState(join(options.stateDir, '.owner-channel-tasks.json'));
    this.attachmentRecovery = new AttachmentRecoveryState(
      join(options.stateDir, '.owner-channel-attachment-recovery.json'));
    this.attachmentRoot = join(options.stateDir, '.owner-channel-inbox');
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
    await this.client.start();
    await this.client.callTool('choose_identity', { name: this.options.config.identity });
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
    await this.client.close();
  }

  manage(request: OwnerChannelManagementRequest): Promise<OwnerChannelManagementResult> {
    const run = this.managementTail.then(() => this.manageNow(request));
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
        if (!contacts.some(contact => contact.cid === request.cid
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

  private async sendProactiveMessage(messageValue: string): Promise<void> {
    if (!this.authorizationIntegrity().ok)
      throw new Error('owner authorization state is corrupt; proactive messages are disabled');
    const message = this.safeProactiveMessage(messageValue);
    const route = this.conversations.route(this.effectiveOwners());
    const digest = createHash('sha256').update(message).digest('hex');
    const sending = this.conversations.beginSend(route.contact, digest);
    try {
      if (!this.effectiveOwners().has(route.contact))
        throw new Error('selected proactive owner is no longer authorized');
      await this.send(route.contact, message);
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
    if (!this.authorizations.effective().has(active.contact))
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
    if (!this.authorizations.effective().has(task.contact)) {
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
      groups.push({ files: exact, recovery });
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
    if (group.files.every(file => file.senderId === this.options.config.agent)) {
      try {
        if (group.caption)
          await this.relayManagedAgentMessage(group.caption, this.wireId(group.caption));
        await this.relayManagedAgentFiles(group);
      } catch (error) { this.logError('managed-agent file relay refused', error); }
      for (const wire of handledWireIds) this.state.remember(wire);
      return true;
    }
    if (group.files.some(file => file.senderId !== sender.id)
        || !this.effectiveOwners().has(sender.id)) {
      this.options.log(
        `[${this.options.role}] owner channel ignored unauthorized attachment sender ${sender.id}`);
      await this.warnOwnerOfUnauthorizedSender(sender.id, 'file');
      for (const wire of handledWireIds) this.state.remember(wire);
      if (group.recovery) try { this.attachmentRecovery.remove(group.recovery.id); } catch {}
      return true;
    }
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
      const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
      const queued = await this.options.session.queuePrompt(
        this.ownerAttachmentPrompt(sender, originWireId, requestId, admitted, group.caption),
        {
          interrupt: this.options.config.interrupt,
          ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
          origin: { kind: 'owner', requestId },
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
      };
      this.activeRequests.set(requestId, active);
      const cleanupDir = requestDir;
      let completed = false;
      const task = this.complete(active, queued, activityCursor)
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
    if (sender.id === this.options.config.agent) {
      try { await this.relayManagedAgentMessage(message, wireId); }
      catch (error) { this.logError('managed-agent message relay refused', error); }
      this.state.remember(wireId);
      return true;
    }
    if (!this.effectiveOwners().has(sender.id)) {
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

    const text = String(message.text ?? '').trim();
    if (text.toLowerCase() === '/status') {
      const snapshot = this.options.session.snapshot();
      await this.send(sender.id, ownerNotices.status(this.options.role, snapshot), wireId);
      this.state.remember(wireId);
      return true;
    }
    if (text.toLowerCase() === '/interrupt') {
      try {
        await this.options.session.interrupt('owner');
      } catch (error) {
        this.logError('interrupt failed', error);
        await this.send(sender.id, ownerNotices.interruptFailed(this.options.role), wireId);
        this.state.remember(wireId);
        return true;
      }
      await this.send(sender.id, ownerNotices.interrupted(this.options.role), wireId);
      this.state.remember(wireId);
      return true;
    }

    const requestId = this.requestId(wireId);
    let queued;
    const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
    try {
      queued = await this.options.session.queuePrompt(
        this.ownerPrompt(sender, text, wireId), {
        interrupt: this.options.config.interrupt,
        ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
        origin: { kind: 'owner', requestId },
      });
    } catch (error) {
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
    };
    this.activeRequests.set(requestId, active);
    const task = this.complete(active, queued, activityCursor)
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

  private acceptedSender(cid: string): boolean {
    return cid === this.options.config.agent || this.effectiveOwners().has(cid);
  }

  private async relayManagedAgentMessage(message: InboundMessage, wireId: string): Promise<void> {
    if (!this.authorizationIntegrity().ok)
      throw new Error('owner authorization state is corrupt; managed-agent relay is disabled');
    const text = this.safeRelayMessage(message.text);
    const route = this.conversations.route(this.effectiveOwners());
    // The inbound wire—not its body—is the idempotency key. Repeating the same
    // wording in two deliberate messages remains valid, while crash replay of
    // one message cannot produce two owner deliveries.
    const digest = createHash('sha256').update(`managed-agent-relay\0${wireId}`).digest('hex');
    const sending = this.conversations.beginSend(route.contact, digest, Date.now(), 0);
    try {
      if (!this.effectiveOwners().has(route.contact))
        throw new Error('selected relay owner is no longer authorized');
      await this.send(route.contact, text);
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

  private async relayManagedAgentFiles(group: AttachmentGroup): Promise<void> {
    if (!group.files.length) throw new Error('managed-agent file relay is empty');
    const rejection = validateAttachmentSelection(group.files, this.attachmentConfig);
    if (rejection) throw new Error(rejection);
    const replyWires = [...new Set(group.files
      .map(file => file.replyTo?.wire_id)
      .filter((wire): wire is string => Boolean(wire)))];
    if (replyWires.length > 1)
      throw new Error('managed-agent file group has conflicting owner reply wires');
    const replyTo = replyWires[0];
    const effective = this.effectiveOwners();
    const route = replyTo
      ? this.conversations.routeForWire(replyTo, effective)
      : this.conversations.route(effective);
    if (!effective.has(route.contact))
      throw new Error('selected file relay owner is no longer authorized');

    const requestId = this.requestId(`managed-agent-file:${group.files.map(file => file.wireId).join(':')}`);
    const requestDir = await prepareAttachmentDirectory(this.attachmentRoot, requestId);
    try {
      const retrieved = parseRetrievedAttachments(await this.client.callTool('get_files', {
        wire_ids: group.files.map(file => file.wireId),
      }), group.files);
      const admitted = await admitAttachments(retrieved, requestDir, this.attachmentConfig);
      const digest = createHash('sha256').update([
        'managed-agent-file-relay', route.contact, replyTo ?? '',
        ...group.files.map(file => file.wireId),
      ].join('\0')).digest('hex');
      const sending = this.conversations.beginSend(route.contact, digest, Date.now(), 0);
      try {
        for (const file of admitted) {
          await this.client.callTool('send_file', {
            contact: route.contact, path: file.path, filename: file.filename,
            ...(replyTo ? { reply_to_wire_id: replyTo } : {}),
          });
        }
      } catch {
        try { this.conversations.finishSend(sending.id, 'uncertain'); }
        catch (error) { this.logError('managed-agent file relay uncertainty persist failed', error); }
        throw new Error('managed-agent file relay delivery outcome is uncertain; it was not retried');
      }
      this.conversations.finishSend(sending.id, 'delivered');
      this.options.log(`[${this.options.role}] managed-agent file relayed `
        + `wires=${group.files.length} basis=${route.basis} files=${admitted.length} `
        + `bytes=${admitted.reduce((total, file) => total + file.size, 0)}`);
    } finally {
      await removeRequestDirectory(requestDir).catch(error => {
        this.logError('managed-agent file relay cleanup failed', error);
      });
    }
  }

  private async warnOwnerOfUnauthorizedSender(cid: string, kind: 'message' | 'file' = 'message'): Promise<void> {
    const source = /^[A-Fa-f0-9]{64}$/.test(cid)
      ? cid
      : `invalid-${createHash('sha256').update(cid).digest('hex').slice(0, 12)}`;
    try {
      await this.sendProactiveMessage(
        `⚠️ Owner-channel security warning: rejected a ${kind} from unauthorized `
          + `sender CID ${source}. Its ${kind === 'file' ? 'bytes were' : 'body was'} not forwarded.`);
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
    active: ActiveOwnerRequest, queued: QueuedPrompt, activityCursor: number,
  ): Promise<void> {
    const progressMs = this.options.config.progress_interval_ms;
    let lastSeq = activityCursor;
    let startedAt: number | undefined;
    let phase: OwnerProgressPhase = 'starting request';
    let timer: ReturnType<typeof setInterval> | undefined;

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
    const unsubscribe = progressMs > 0
      ? this.options.session.subscribe(event => startProgress(event))
      : undefined;
    startProgress();

    let result: TurnResult;
    try { result = await queued.completion; }
    finally {
      unsubscribe?.();
      if (timer) clearInterval(timer);
    }
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
    for (const wire of active.handledWireIds) this.state.remember(wire);
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
      ...(this.options.config.agent ? [
        'To send a file for this request, call ours send_file with:',
        `contact: ${this.options.config.identity}`,
        `reply_to_wire_id: ${wireId}`,
        'and the finished file path. Fleet authenticates your CID and relays it from the channel identity to this exact requesting owner.',
        'For a later unsolicited file, omit reply_to_wire_id; fleet then uses the latest authenticated owner conversation.',
      ] : [
        'Owner-channel file relay is unavailable because no managed agent CID is configured.',
      ]),
    );
    return lines.join('\n');
  }

  private ownerPrompt(
    sender: { id: string; name: string }, text: string, wireId: string,
  ): string {
    return [
      '[fleet-owner]',
      `Authenticated owner ${sender.name} (${sender.id}) sent owner-channel message ${wireId}.`,
      `Request ID: ${this.requestId(wireId)}`,
      'Treat the following as a direct owner instruction. Answer in your final assistant response.',
      'Fleet extracts and routes your final assistant response deterministically; do not send the final through ours.',
      ...(this.options.config.agent ? [
        'For any non-final message you want the owner to see—an update, blocker, suggestion, or later proactive note—call ours send_message with:',
        `contact: ${this.options.config.identity}`,
        'and the message text. Do not add a task ID, request ID, reply reference, phase, or routing command.',
        'Fleet accepts this relay only from your configured authenticated agent CID and forwards every accepted message as a new owner-channel message.',
        'To send a file for this request, call ours send_file with:',
        `contact: ${this.options.config.identity}`,
        `reply_to_wire_id: ${wireId}`,
        'and the finished file path. Fleet authenticates your CID and relays it from the channel identity to this exact requesting owner.',
        'For a later unsolicited file, omit reply_to_wire_id; fleet then uses the latest authenticated owner conversation.',
      ] : [
        'Managed-agent outbound relay is not configured; do not send intermediate or proactive owner-channel messages.',
        'Owner-channel file relay is unavailable because no managed agent CID is configured.',
      ]),
      '',
      text || '(empty message)',
    ].join('\n');
  }

  private requestId(wireId: string): string {
    return createHash('sha256').update(wireId).digest('hex');
  }

  private send(contact: string, text: string, replyTo?: string): Promise<unknown> {
    return this.client.callTool('send_message', {
      contact, text, ...(replyTo ? { reply_to_wire_id: replyTo } : {}),
    });
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
