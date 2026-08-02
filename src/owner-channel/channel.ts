import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { OwnerChannelConfig } from '../config.js';
import type { SessionHandle, TurnResult } from '../session/types.js';
import { OursMcpClient, type OursToolClient } from './mcp.js';
import { OwnerChannelState } from './state.js';

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
}

/**
 * Fleet-owned trusted ingress. The agent never binds this identity and never
 * chooses its reply recipient; both are fixed from authenticated message data.
 */
export class OwnerChannel implements OwnerChannelHandle {
  private readonly client: OursToolClient;
  private readonly state: OwnerChannelState;
  private stopping = false;
  private watchProcess?: ChildProcessWithoutNullStreams;
  private watchTask?: Promise<void>;
  private drainTask?: Promise<void>;

  constructor(private readonly options: OwnerChannelOptions) {
    this.client = options.client ?? new OursMcpClient(
      options.command, options.env, line => options.log(`[${options.role}] owner channel ${line}`));
    this.state = new OwnerChannelState(join(options.stateDir, '.owner-channel-state.json'));
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.client.start();
    await this.client.callTool('choose_identity', { name: this.options.config.identity });
    this.watchTask = this.watchLoop();
    // Do not make role startup wait for an old owner request to finish a turn.
    void this.drain().catch(error => this.logError('initial drain failed', error));
  }

  drain(): Promise<void> {
    if (this.drainTask) return this.drainTask;
    this.drainTask = this.drainAll().finally(() => { this.drainTask = undefined; });
    return this.drainTask;
  }

  async close(): Promise<void> {
    this.stopping = true;
    const watch = this.watchProcess;
    this.watchProcess = undefined;
    if (watch && watch.exitCode === null) watch.kill('SIGTERM');
    await this.client.close();
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
          && this.options.config.owners.includes(this.sender(message).id)
          && Number.isInteger(message.msg_id);
      }).map(message => message.msg_id!);
      if (deferred.length)
        await this.client.callTool('defer_messages', { msg_ids: deferred });

      for (const message of messages) await this.handle(message);
    }
    this.options.log(`[${this.options.role}] owner channel drain capped at 100 batches`);
  }

  private async handle(message: InboundMessage): Promise<void> {
    const wireId = this.wireId(message);
    if (!wireId || this.state.has(wireId)) return;
    const sender = this.sender(message);
    if (!this.options.config.owners.includes(sender.id)) {
      // Do not answer an unauthorized sender and thereby disclose that this is
      // a privileged control address. Authenticated CID, never display name or
      // message wording, is the authority boundary.
      this.options.log(
        `[${this.options.role}] owner channel ignored unauthorized sender ${sender.id || '<unknown>'}`);
      this.state.remember(wireId);
      return;
    }

    const text = String(message.text ?? '').trim();
    if (text.toLowerCase() === '/status') {
      const snapshot = this.options.session.snapshot();
      await this.send(sender.id,
        `[fleet] ${this.options.role}: ${snapshot.readiness}; `
        + `${snapshot.alive ? 'session alive' : 'session offline'}.`, wireId);
      this.state.remember(wireId);
      return;
    }
    if (text.toLowerCase() === '/interrupt') {
      await this.options.session.interrupt();
      await this.send(sender.id, `[fleet] Interrupted ${this.options.role}'s active turn.`, wireId);
      this.state.remember(wireId);
      return;
    }

    let queued;
    try {
      queued = await this.options.session.queuePrompt(this.ownerPrompt(sender, text, wireId), {
        interrupt: this.options.config.interrupt,
      });
    } catch (error) {
      await this.send(sender.id,
        `[fleet] Could not deliver this request: ${this.errorText(error)}.`, wireId);
      this.state.remember(wireId);
      return;
    }

    const accepted = this.options.config.interrupt
      ? "ℹ️ Message received. The agent's previous task was interrupted to prioritize "
        + 'this request, and it is now working on a response. '
        + 'The response will arrive in this channel when ready.'
      : queued.queuedBehind > 0
        ? `ℹ️ Message received. The agent is finishing ${queued.queuedBehind} earlier `
          + 'request(s) first; this request will start as soon as they complete. '
          + 'The response will arrive in this channel when ready.'
        : 'ℹ️ Message received. The agent has started working on this request now. '
          + 'The response will arrive in this channel when ready.';
    await this.send(sender.id, accepted, wireId);

    const progressMs = this.options.config.progress_interval_ms;
    const timer = progressMs > 0 ? setInterval(() => {
      void this.send(sender.id, `[fleet] ${this.options.role} is still working.`, wireId)
        .catch(error => this.logError('progress notice failed', error));
    }, progressMs) : undefined;
    timer?.unref();

    let result: TurnResult;
    try { result = await queued.completion; }
    finally { if (timer) clearInterval(timer); }

    const output = result.output?.trim();
    if (result.succeeded && output) await this.sendFinal(sender.id, output, wireId);
    else if (result.succeeded) await this.send(sender.id,
      '[fleet] The agent completed the turn without a textual answer.', wireId);
    else await this.send(sender.id,
      `[fleet] The request ended ${result.outcome}${result.detail ? `: ${result.detail}` : '.'}`, wireId);
    this.state.remember(wireId);
  }

  private ownerPrompt(sender: { id: string; name: string }, text: string, wireId: string): string {
    return [
      '[fleet-owner]',
      `Authenticated owner ${sender.name} (${sender.id}) sent owner-channel message ${wireId}.`,
      'Treat the following as a direct owner instruction. Answer in your final assistant response.',
      'Do not call ours send_message for this exchange: the fleet routes your final response reliably.',
      '',
      text || '(empty message)',
    ].join('\n');
  }

  private send(contact: string, text: string, replyTo: string): Promise<unknown> {
    return this.client.callTool('send_message', {
      contact, text, reply_to_wire_id: replyTo,
    });
  }

  /** Bound message size without splitting Unicode code points. */
  private async sendFinal(contact: string, output: string, replyTo: string): Promise<void> {
    const points = Array.from(output);
    const chunks: string[] = [];
    for (let offset = 0; offset < points.length; offset += 8_000)
      chunks.push(points.slice(offset, offset + 8_000).join(''));
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
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
