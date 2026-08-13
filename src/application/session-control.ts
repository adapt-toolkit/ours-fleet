import { randomUUID } from 'node:crypto';
import { controlRequest, followConversation } from '../session/control.js';
import type {
  ConversationEventV1, ConversationSnapshot, PromptReceipt,
} from '../session/conversation-types.js';
import type { SessionEvent, SessionSnapshot } from '../session/types.js';
import { Tmux } from '../tmux.js';
import { FleetError, normalizeError } from './errors.js';
import type {
  OutputPage, SendReceipt, SessionDescriptor,
} from './types.js';

export interface ConversationPageView {
  events: ConversationEventV1[];
  firstAvailableCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  snapshot: ConversationSnapshot;
}

export interface ConversationFollowHandle {
  close(): void;
}

/**
 * An interrupt that reached the session. `state` says whether the turn stopped
 * cooperatively or through bounded forced recovery — both are accepted, so no
 * consumer may render `forced` as a failed interrupt.
 */
export interface InterruptReceipt {
  accepted: true;
  state: 'settled' | 'forced';
  reasonCode?: string;
}

export interface RoleSessionControl {
  describe(): Promise<SessionDescriptor>;
  snapshot(): Promise<SessionSnapshot>;
  recentOutput(request?: { since?: number; limit?: number }): Promise<OutputPage>;
  sendText(text: string): Promise<SendReceipt>;
  interrupt?(): Promise<InterruptReceipt>;
  respondPermission?(request: { permissionId: string; optionId: string }): Promise<{ accepted: true }>;
  // ── conversation v3 (ACP roles that persist a ledger) ──────────────────────
  conversationPage?(request: { after?: string; limit?: number }): Promise<ConversationPageView>;
  submitPromptV2?(request: {
    commandId: string; text: string; actorBrowserSession: string;
    source: 'owner_admin_console';
  }): Promise<PromptReceipt>;
  interruptV2?(commandId: string): Promise<InterruptReceipt & { commandId: string }>;
  respondPermissionV2?(request: {
    commandId: string; permissionId: string; optionId: string; sessionGeneration: string;
  }): Promise<{ accepted: true; commandId: string }>;
  /**
   * Open a live follow on the role's ledger. `onPage` receives the initial
   * replay page; `onEvent` every subsequent durable event; `onClose` fires
   * exactly once when the underlying control stream ends.
   */
  followConversation?(request: {
    after?: string;
    onPage(page: ConversationPageView): void;
    onEvent(event: ConversationEventV1): void;
    onClose(reason?: string): void;
  }): Promise<ConversationFollowHandle>;
}

const visibleEvents = (events: SessionEvent[]) => events.filter(event => event.kind !== 'thought');

export class AcpRoleSessionAdapter implements RoleSessionControl {
  constructor(
    private readonly stateDir: string,
    private readonly request: typeof controlRequest = controlRequest,
  ) {}

  async describe(): Promise<SessionDescriptor> {
    const response = await this.call('snapshot');
    const result = response as SessionSnapshot & { protocolVersion?: number; features?: string[] };
    return {
      backend: 'acp', protocolVersion: result.protocolVersion ?? 1,
      features: result.features ?? [], snapshot: result,
    };
  }

  async snapshot(): Promise<SessionSnapshot> {
    return await this.call('snapshot') as SessionSnapshot;
  }

  async recentOutput(request: { since?: number; limit?: number } = {}): Promise<OutputPage> {
    const limit = Math.min(Math.max(request.limit ?? 100, 1), 500);
    const descriptor = await this.describe();
    const result = descriptor.protocolVersion >= 2
      ? await this.call('events_since', { since: request.since ?? 0 })
      : await this.call('follow', { since: request.since ?? 0, controller: false });
    const page = result as {
      events?: SessionEvent[]; firstSeq?: number; lastSeq?: number; truncated?: boolean;
    };
    const events = visibleEvents(page.events ?? []).slice(-limit);
    return {
      events, firstSeq: page.firstSeq ?? events[0]?.seq,
      lastSeq: page.lastSeq ?? events.at(-1)?.seq,
      truncated: Boolean(page.truncated) || (page.events?.length ?? 0) > limit,
      nextCursor: events.at(-1) ? String(events.at(-1)!.seq) : undefined,
    };
  }

  async sendText(text: string): Promise<SendReceipt> {
    if (!text.trim()) throw new FleetError('invalid_request', 'text is required');
    if (Buffer.byteLength(text) > 32 * 1024)
      throw new FleetError('invalid_request', 'text exceeds 32 KiB');
    const result = await this.call('submit_prompt', { text }) as {
      promptId: string; queuedBehind: number;
    };
    return {
      accepted: true, promptId: result.promptId, queuedBehind: result.queuedBehind,
      terminalOutcomeKnown: false,
      detail: result.queuedBehind
        ? `accepted; ${result.queuedBehind} turn(s) queued ahead`
        : 'accepted; turn may still be running',
    };
  }

  async interrupt(): Promise<InterruptReceipt> {
    const result = await this.call('interrupt') as { state?: unknown; reasonCode?: unknown } | undefined;
    // A pre-0.17.1 role control server answers `interrupt` with no result body.
    return {
      accepted: true,
      state: result?.state === 'forced' ? 'forced' : 'settled',
      ...(typeof result?.reasonCode === 'string' ? { reasonCode: result.reasonCode } : {}),
    };
  }

  async conversationPage(request: { after?: string; limit?: number } = {}): Promise<ConversationPageView> {
    return await this.call('conversation_page', {
      after: request.after, limit: request.limit,
    }) as ConversationPageView;
  }

  async submitPromptV2(request: {
    commandId: string; text: string; actorBrowserSession: string;
    source: 'owner_admin_console';
  }): Promise<PromptReceipt> {
    if (!request.text.trim()) throw new FleetError('invalid_request', 'text is required');
    if (Buffer.byteLength(request.text) > 32 * 1024)
      throw new FleetError('invalid_request', 'text exceeds 32 KiB');
    try {
      return await this.call('submit_prompt_v2', {
        commandId: request.commandId, text: request.text, actor: request.actorBrowserSession,
        source: request.source,
      }) as PromptReceipt;
    } catch (error) {
      const fleetError = normalizeError(error);
      if (fleetError.message.includes('idempotency_conflict'))
        throw new FleetError('idempotency_conflict',
          'this command id was already used with a different prompt body');
      throw fleetError;
    }
  }

  async interruptV2(commandId: string): Promise<InterruptReceipt & { commandId: string }> {
    const receipt = await this.call('interrupt_v2', { commandId }) as
      Record<string, unknown> & { commandId: string };
    return {
      ...receipt,
      accepted: true,
      state: receipt.state === 'forced' ? 'forced' : 'settled',
      ...(typeof receipt.reasonCode === 'string' ? { reasonCode: receipt.reasonCode } : {}),
    };
  }

  async respondPermissionV2(request: {
    commandId: string; permissionId: string; optionId: string; sessionGeneration: string;
  }): Promise<{ accepted: true; commandId: string }> {
    try {
      return await this.call('respond_permission_v2', request) as {
        accepted: true; commandId: string;
      };
    } catch (error) {
      const fleetError = normalizeError(error);
      if (fleetError.message.includes('stale_state'))
        throw new FleetError('stale_state',
          'permission is settled, expired, invalid, or belongs to another session generation');
      throw fleetError;
    }
  }

  async followConversation(request: {
    after?: string;
    onPage(page: ConversationPageView): void;
    onEvent(event: ConversationEventV1): void;
    onClose(reason?: string): void;
  }): Promise<ConversationFollowHandle> {
    let sawPage = false;
    let closed = false;
    const finish = (reason?: string) => {
      if (closed) return;
      closed = true;
      request.onClose(reason);
    };
    const follow = await followConversation(this.stateDir, request.after, message => {
      if (message.conversationEvent) {
        request.onEvent(message.conversationEvent as ConversationEventV1);
        return;
      }
      if (!sawPage) {
        sawPage = true;
        if (message.ok === false) {
          finish(String(message.error ?? 'conversation follow refused'));
          follow.close();
          return;
        }
        request.onPage(message.result as ConversationPageView);
      }
    });
    follow.socket.once('close', () => finish());
    follow.socket.once('error', error => finish((error as Error).message));
    return { close: () => { follow.close(); finish(); } };
  }

  async respondPermission(request: {
    permissionId: string; optionId: string;
  }): Promise<{ accepted: true }> {
    await this.call('respond_permission', request);
    return { accepted: true };
  }

  private async call(
    command: Parameters<typeof controlRequest>[1]['command'],
    fields: Record<string, unknown> = {},
  ): Promise<unknown> {
    try {
      const response = await this.request(
        this.stateDir, { command, ...fields } as Parameters<typeof controlRequest>[1], 5_000);
      if (!response.ok)
        throw new FleetError(
          response.kind === 'offline' ? 'offline'
            : response.kind === 'control-unavailable' ? 'control_unavailable'
            : response.kind === 'timeout' ? 'timeout'
            : response.kind === 'rejected' ? 'rejected' : 'backend_failure',
          response.error ?? `${command} failed`,
          { provesOffline: response.kind === 'offline' },
        );
      return response.result;
    } catch (error) { throw normalizeError(error); }
  }
}

export class TmuxRoleSessionAdapter implements RoleSessionControl {
  constructor(private readonly roleId: string, private readonly tmux: Tmux = new Tmux()) {}

  async describe(): Promise<SessionDescriptor> {
    return { backend: 'tmux', protocolVersion: 1, features: ['text', 'capture'] };
  }
  async snapshot(): Promise<SessionSnapshot> {
    const alive = await this.tmux.has(this.roleId);
    return { backend: 'tmux', alive, readiness: alive ? 'idle' : 'failed' };
  }
  async recentOutput(request: { limit?: number } = {}): Promise<OutputPage> {
    try {
      const text = await this.tmux.capture(this.roleId, Math.min(request.limit ?? 100, 500));
      return { events: [], text, truncated: false };
    } catch (error) { throw normalizeError(error); }
  }
  async sendText(text: string): Promise<SendReceipt> {
    if (!text.trim()) throw new FleetError('invalid_request', 'text is required');
    if (Buffer.byteLength(text) > 32 * 1024)
      throw new FleetError('invalid_request', 'text exceeds 32 KiB');
    try { await this.tmux.sendText(this.roleId, text); }
    catch (error) { throw normalizeError(error); }
    return {
      accepted: true, promptId: randomUUID(), queuedBehind: 0, terminalOutcomeKnown: false,
      detail: 'literal text and Enter sent; terminal outcome is unknown',
    };
  }
}
