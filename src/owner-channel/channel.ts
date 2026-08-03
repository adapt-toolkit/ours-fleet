import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { OwnerChannelConfig } from '../config.js';
import type { QueuedPrompt, SessionEvent, SessionHandle, TurnResult } from '../session/types.js';
import { OursMcpClient, type OursToolClient } from './mcp.js';
import { ownerNotices, type OwnerProgressPhase } from './notices.js';
import { OwnerAuthorizationState, OwnerChannelState, type OwnerEntry } from './state.js';

interface InboundMessage {
  msg_id?: number;
  wire_id?: string;
  text?: string;
  from?: { id?: string; name?: string } | string;
  sender?: { id?: string; name?: string } | string;
  sender_id?: string;
  sender_name?: string;
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
  | { action: 'owner_revoke'; cid: string };

export type OwnerChannelManagementResult =
  | { action: 'contact_list'; contacts: OwnerContact[] }
  | { action: 'contact_invite'; invite: string }
  | { action: 'contact_add'; status: 'pending'; contact?: OwnerContact }
  | { action: 'owner_list'; integrity: { ok: boolean; error?: string }; owners: OwnerEntry[] }
  | { action: 'owner_authorize' | 'owner_revoke'; owner: OwnerEntry };

export interface OwnerContact {
  cid: string;
  name: string;
  status: string;
  kind?: string;
  human?: { cid?: string; name?: string };
}

/**
 * Fleet-owned trusted ingress. The agent never binds this identity and never
 * chooses its reply recipient; both are fixed from authenticated message data.
 */
export class OwnerChannel implements OwnerChannelHandle {
  private readonly client: OursToolClient;
  private readonly state: OwnerChannelState;
  private readonly authorizations: OwnerAuthorizationState;
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
  private managementTail: Promise<unknown> = Promise.resolve();
  private ready = false;

  constructor(private readonly options: OwnerChannelOptions) {
    this.client = options.client ?? new OursMcpClient(
      options.command, options.env, line => options.log(`[${options.role}] owner channel ${line}`));
    this.state = new OwnerChannelState(join(options.stateDir, '.owner-channel-state.json'));
    this.authorizations = new OwnerAuthorizationState(
      join(options.stateDir, '.owner-channel-owners.json'), options.config.owners);
    const integrity = this.authorizations.integrity();
    if (!integrity.ok)
      options.log(`[${options.role}] owner authorization state corrupt; all owner mail disabled`);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.client.start();
    await this.client.callTool('choose_identity', { name: this.options.config.identity });
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
        return { action: request.action, owner: this.authorizations.revoke(request.cid) };
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

  private async drainAll(): Promise<void> {
    // A finite cap protects the supervisor if a broken daemon repeats unread
    // messages forever. A watch notification will resume draining later.
    for (let pass = 0; pass < 100 && !this.stopping; pass++) {
      const raw = await this.client.callTool('get_messages') as { messages?: unknown };
      const messages = Array.isArray(raw?.messages)
        ? raw.messages.filter(message => message && typeof message === 'object') as InboundMessage[]
        : [];
      if (!messages.length) return;

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
      for (const message of messages)
        advanced = await this.handle(message) || advanced;

      // Deferred in-flight messages are intentionally visible again until
      // their correlated response is delivered. Do not spin on those replay
      // copies; a new watch event or completion-triggered drain will resume.
      if (!advanced) return;
    }
    this.options.log(`[${this.options.role}] owner channel drain capped at 100 batches`);
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
        await this.options.session.interrupt();
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

    const outbox = this.outboxDir(wireId);
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    let queued;
    const activityCursor = this.latestEventSeq(this.options.session.eventsSince(0));
    try {
      queued = await this.options.session.queuePrompt(this.ownerPrompt(sender, text, wireId, outbox), {
        interrupt: this.options.config.interrupt,
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
    const task = this.complete(sender.id, wireId, outbox, accepted, queued, activityCursor)
      .catch(error => this.logError(`request ${wireId} completion failed`, error))
      .finally(() => {
        this.inFlight.delete(wireId);
        this.completionTasks.delete(task);
        if (!this.stopping)
          void this.drain().catch(error => this.logError('completion drain failed', error));
      });
    this.completionTasks.add(task);
    return true;
  }

  private async complete(
    contact: string, wireId: string, outbox: string,
    accepted: string, queued: QueuedPrompt, activityCursor: number,
  ): Promise<void> {
    // Notice delivery and turn completion happen outside the inbox drain. This
    // is what keeps later owner messages — especially /interrupt — responsive.
    try { await this.send(contact, accepted, wireId); }
    catch (error) { this.logError(`request ${wireId} acceptance notice failed`, error); }

    const progressMs = this.options.config.progress_interval_ms;
    const startedAt = Date.now();
    let lastSeq = activityCursor;
    let phase: OwnerProgressPhase = queued.queuedBehind > 0
      ? 'waiting behind earlier requests' : 'starting request';
    let progressTail = Promise.resolve();
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
      progressTail = progressTail.then(async () => { await this.send(contact, notice, wireId); })
        .catch(error => this.logError('progress notice failed', error));
    }, progressMs) : undefined;
    timer?.unref();

    let result: TurnResult;
    try { result = await queued.completion; }
    finally { if (timer) clearInterval(timer); }
    await progressTail;

    const output = result.output?.trim();
    if (result.succeeded && output) await this.sendFinal(contact, output, wireId);
    else if (result.succeeded) await this.send(contact,
      ownerNotices.completedWithoutText(), wireId);
    else await this.send(contact, ownerNotices.terminal(result.outcome), wireId);
    if (result.succeeded) await this.sendAttachments(contact, outbox, wireId);
    else await rm(outbox, { recursive: true, force: true });
    this.state.remember(wireId);
  }

  private ownerPrompt(
    sender: { id: string; name: string }, text: string, wireId: string, outbox: string,
  ): string {
    return [
      '[fleet-owner]',
      `Authenticated owner ${sender.name} (${sender.id}) sent owner-channel message ${wireId}.`,
      'Treat the following as a direct owner instruction. Answer in your final assistant response.',
      'Do not call ours send_message or send_file for this exchange: fleet routes the response reliably.',
      'To attach files to your response, copy each finished file directly into this fleet outbox:',
      outbox,
      'Fleet sends every regular file in that directory to the authenticated owner, correlated to this request.',
      'Use descriptive unique filenames. Put nothing there that the owner did not request or should not receive.',
      '',
      text || '(empty message)',
    ].join('\n');
  }

  private outboxDir(wireId: string): string {
    const key = createHash('sha256').update(wireId).digest('hex');
    return join(this.options.stateDir, '.owner-channel-outbox', key);
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
