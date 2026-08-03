import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import {
  DEFAULT_OWNER_ATTACHMENT_MIME, type OwnerAttachmentConfig, type OwnerChannelConfig,
} from '../config.js';
import type { QueuedPrompt, SessionEvent, SessionHandle, TurnResult } from '../session/types.js';
import { OursMcpClient, type OursToolClient } from './mcp.js';
import { ownerNotices, type OwnerProgressPhase, type OwnerUpdatePhase } from './notices.js';
import { OwnerAuthorizationState, OwnerChannelState, type OwnerEntry } from './state.js';
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

/**
 * Fleet-owned trusted ingress. The agent never binds this identity and never
 * chooses its reply recipient; both are fixed from authenticated message data.
 */
export class OwnerChannel implements OwnerChannelHandle {
  private readonly client: OursToolClient;
  private readonly state: OwnerChannelState;
  private readonly authorizations: OwnerAuthorizationState;
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
    this.tasks = new OwnerTaskState(join(options.stateDir, '.owner-channel-tasks.json'));
    this.attachmentRecovery = new AttachmentRecoveryState(
      join(options.stateDir, '.owner-channel-attachment-recovery.json'));
    this.attachmentRoot = join(options.stateDir, '.owner-channel-inbox');
    this.attachmentConfig = options.config.attachments ?? {
      enabled: true, max_files_per_request: 4, max_file_bytes: 10 * 1024 * 1024,
      max_request_bytes: 20 * 1024 * 1024, retention_ms: 24 * 60 * 60 * 1_000,
      allowed_mime: [...DEFAULT_OWNER_ATTACHMENT_MIME],
    };
    const integrity = this.authorizations.integrity();
    if (!integrity.ok)
      options.log(`[${options.role}] owner authorization state corrupt; all owner mail disabled`);
    if (!this.tasks.integrity().ok)
      options.log(`[${options.role}] owner task state corrupt; proactive reports disabled`);
    if (!this.attachmentRecovery.integrity())
      options.log(`[${options.role}] owner attachment recovery state corrupt; attachments disabled`);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.client.start();
    await this.client.callTool('choose_identity', { name: this.options.config.identity });
    if (this.authorizations.integrity().ok && this.tasks.integrity().ok)
      this.tasks.cleanup(Date.now(), this.authorizations.effective());
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
          action: request.action, integrity: this.authorizations.integrity(),
          owners: this.authorizations.entries(),
        };
      case 'owner_authorize': {
        this.assertCid(request.cid);
        if (this.authorizations.effective().has(request.cid))
          throw new Error(`owner '${request.cid}' is already authorized`);
        const contacts = await this.contacts();
        if (!contacts.some(contact => contact.cid === request.cid
          && ['established', 'active', 'connected'].includes(contact.status.toLowerCase())))
          throw new Error(`cannot authorize unknown or pending contact CID '${request.cid}'`);
        return { action: request.action, owner: this.authorizations.authorize(request.cid) };
      }
      case 'owner_revoke':
        this.assertCid(request.cid);
        {
          const owner = this.authorizations.revoke(request.cid);
          let revokedTasks = 0;
          try { revokedTasks = this.tasks.revoke(request.cid); }
          catch (error) { this.logError('owner task revocation cleanup failed', error); }
          if (revokedTasks)
            this.options.log(`[${this.options.role}] owner tasks revoked count=${revokedTasks}`);
          return { action: request.action, owner };
        }
      case 'request_update':
        return this.sendOwnerUpdate(request);
      case 'task_open':
        return this.openOwnerTask(request.requestId);
      case 'task_report':
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
          && this.authorizations.effective().has(this.sender(message).id)
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
    if (group.files.some(file => file.senderId !== sender.id)
        || !this.authorizations.effective().has(sender.id)) {
      this.options.log(
        `[${this.options.role}] owner channel ignored unauthorized attachment sender ${sender.id}`);
      for (const wire of handledWireIds) this.state.remember(wire);
      if (group.recovery) try { this.attachmentRecovery.remove(group.recovery.id); } catch {}
      return true;
    }
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
    if (!this.authorizations.effective().has(sender.id)) {
      // Do not answer an unauthorized sender and thereby disclose that this is
      // a privileged control address. Authenticated CID, never display name or
      // message wording, is the authority boundary.
      this.options.log(
        `[${this.options.role}] owner channel ignored unauthorized sender ${sender.id || '<unknown>'}`);
      this.state.remember(wireId);
      return true;
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
    const outbox = this.outboxDir(wireId);
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    let queued;
    const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
    try {
      queued = await this.options.session.queuePrompt(
        this.ownerPrompt(sender, text, wireId, requestId, outbox), {
        interrupt: this.options.config.interrupt,
        ...(this.options.config.interrupt ? { interruptSource: 'owner' as const } : {}),
        origin: { kind: 'owner', requestId },
      });
    } catch (error) {
      await rm(outbox, { recursive: true, force: true });
      this.logError('request delivery failed', error);
      await this.send(sender.id, ownerNotices.deliveryFailed(this.options.role), wireId);
      this.state.remember(wireId);
      return true;
    }

    const accepted = this.options.config.interrupt
      ? ownerNotices.receivedInterrupting()
      : queued.queuedBehind > 0
        ? ownerNotices.receivedQueued(queued.queuedBehind)
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

  private async complete(
    active: ActiveOwnerRequest, outbox: string, queued: QueuedPrompt, activityCursor: number,
  ): Promise<void> {
    const progressMs = this.options.config.progress_interval_ms;
    const startedAt = Date.now();
    let lastSeq = activityCursor;
    let phase: OwnerProgressPhase = queued.queuedBehind > 0
      ? 'waiting behind earlier requests' : 'starting request';
    const timer = progressMs > 0 ? setInterval(() => {
      const events = this.options.session.eventsSince(lastSeq);
      lastSeq = Math.max(lastSeq, this.latestEventSeq(events));
      const activity = events.filter(event => event.turnId === queued.promptId);
      phase = this.progressPhase(activity) ?? phase;
      const started = activity.filter(event => event.kind === 'tool_call').length;
      const completed = activity.filter(event =>
        event.kind === 'tool_update' && event.status === 'completed').length;
      const activityUpdates = activity.filter(event => event.kind !== 'tool_call'
        && !(event.kind === 'tool_update' && event.status === 'completed')
        && event.kind !== 'turn_stop').length;
      const notice = ownerNotices.progress(
        Date.now() - startedAt, phase, started, completed, activityUpdates);
      // Preserve wire ordering if a progress send overlaps turn completion.
      active.outboundTail = active.outboundTail
        .then(async () => { await this.send(active.contact, notice, active.wireId); })
        .catch(error => this.logError('progress notice failed', error));
    }, progressMs) : undefined;
    timer?.unref();

    let result: TurnResult;
    try { result = await queued.completion; }
    finally { if (timer) clearInterval(timer); }
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
    requestId: string, outbox: string,
  ): string {
    return [
      '[fleet-owner]',
      `Authenticated owner ${sender.name} (${sender.id}) sent owner-channel message ${wireId}.`,
      'Treat the following as a direct owner instruction. Answer in your final assistant response.',
      'Do not call ours send_message or send_file for this exchange: fleet routes the response reliably.',
      'You may send a concise, high-level intermediate update through the bounded local primitive:',
      `ours-fleet owner-channel update ${this.options.role} ${requestId} --phase <working|approval|blocked> --message-stdin`,
      'Write only the update body to stdin. Use one plain-text sentence; never include reasoning, secrets, logs, commands, or raw tool output.',
      'Distinct updates are allowed at most once every 5 seconds. Fleet preserves receipt/update/final ordering and chooses the authenticated recipient.',
      'If you delegate work that will finish after this turn, register it before finalizing:',
      `ours-fleet owner-channel task open ${this.options.role} ${requestId}`,
      'Keep the returned opaque task ID. Finalize normally; do not hold this turn open or poll.',
      'After a later fleet-mail wake, verify the result and report through:',
      `ours-fleet owner-channel task report ${this.options.role} <task-id> --phase <progress|done|blocked> --message-stdin`,
      'Fleet routes that proactive follow-up only to this authenticated owner and closes done/blocked tasks.',
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

  private send(contact: string, text: string, replyTo: string): Promise<unknown> {
    return this.client.callTool('send_message', {
      contact, text, reply_to_wire_id: replyTo,
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
    return String(message.wire_id ?? message.msg_id ?? '');
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
