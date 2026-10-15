import type { ConversationRoleObservation, ConversationRoleState, ObserveConversationRole } from './conversation-role-observer.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {conversationTailPage,resumedConversationPage,type ConversationTailPage} from './conversation-history.js';
import type { AgentHistoryQuery } from '../agent-ours/correspondence.js';
import { controlRequest, followConversation } from '../session/control.js';
import type {
  ConversationEventV1, ConversationSnapshot, ConversationObservationState, PromptReceipt,
} from '../session/conversation-types.js';
import type { SessionEvent, SessionSnapshot } from '../session/types.js';
import type { PassiveConversationFollowRequest, ConversationReplayPage, ConversationReplayReady } from '../session/conversation-replay.js';
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

export interface LegacyConversationFollowRequest {
  after?: string;
  onPage(page: ConversationPageView): void;
  onEvent(event: ConversationEventV1): void;
  onClose(reason?: string): void;
}
export interface PassiveConversationFollow extends PassiveConversationFollowRequest {
  /** Reports role updates from the owned or borrowed observer; never attaches a controller. */
  onRole?(state: ConversationRoleState): void;
  /** Application-only borrowed owner; never sent over the private wire. */
  roleObservation?: ConversationRoleObservation;
  onReplay(page: ConversationReplayPage): void;
  onReady(ready: ConversationReplayReady): void;
  onEvent(event: ConversationEventV1): void;
  onState(state: ConversationObservationState): void;
  onClose(reason?: string): void;
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
  /** Standalone owner for role-only observation; dispose with that connection. */
  observeRole?: ObserveConversationRole;
  agentContacts?():Promise<unknown>;
  agentHistory?(request:AgentHistoryQuery):Promise<unknown>;
  describe(roleObservation?: ConversationRoleObservation): Promise<SessionDescriptor>;
  snapshot(): Promise<SessionSnapshot>;
  recentOutput(request?: { since?: number; limit?: number }): Promise<OutputPage>;
  sendText(text: string): Promise<SendReceipt>;
  interrupt?(): Promise<InterruptReceipt>;
  respondPermission?(request: { permissionId: string; optionId: string }): Promise<{ accepted: true }>;
  // ── conversation v3 (managed sessions that persist a ledger) ───────────────
  conversationPage?(request: { after?: string; limit?: number }): Promise<ConversationPageView>;
  /** The newest visible events (or those before `before`), read backwards from the ledger. */
  conversationTail?(request: { before?: string; limit?: number }): Promise<ConversationTailPage>;
  submitPromptV2?(request: {
    commandId: string; text: string; actorBrowserSession: string; expectedSessionGeneration?: string; requireIdle?: boolean;
    source: 'owner_admin_console';
  }): Promise<PromptReceipt>;
  interruptPromptV2?(request: { commandId: string; expectedSessionGeneration: string; promptId: string }): Promise<InterruptReceipt>;
  interruptV2?(commandId: string): Promise<InterruptReceipt & { commandId: string }>;
  respondPermissionV2?(request: {
    commandId: string; permissionId: string; optionId: string; sessionGeneration: string;
  }): Promise<{ accepted: true; commandId: string }>;
  /**
   * Open a live follow on the role's ledger. `onPage` receives the initial
   * replay page; `onEvent` every subsequent durable event; `onClose` fires
   * exactly once when the underlying control stream ends.
   */
  followConversation?(request: LegacyConversationFollowRequest | PassiveConversationFollow): Promise<ConversationFollowHandle>;
}

const visibleEvents = (events: SessionEvent[]) => events.filter(event => event.kind !== 'thought');

export class RoleSessionControlAdapter implements RoleSessionControl {
  private controlHealthy = true;
  constructor(
    private readonly stateDir: string,
    private readonly request: typeof controlRequest = controlRequest,
    private readonly openFollow: typeof followConversation = followConversation,
    readonly observeRole?: ObserveConversationRole,
  ) {}

  async agentContacts():Promise<unknown> {await this.requireCorrespondence();return this.call('agent_contacts');}
  async agentHistory(request:AgentHistoryQuery):Promise<unknown> {await this.requireCorrespondence();return this.call('agent_history',{agentHistory:request});}
  private async requireCorrespondence(){if(!(await this.describe()).features.includes('agent_correspondence'))throw new FleetError('capability_unavailable','This session needs an updated supervisor to show contacts and history.');}

  async describe(roleObservation?: ConversationRoleObservation): Promise<SessionDescriptor> {
    // A describe probe owns and always disposes its temporary watcher. Follow uses
    // a separate connection-owned observer and publishes updates via onRole.
    const role = roleObservation ?? this.observeRole?.(() => {});
    try {
      const response = await this.call('snapshot');
      const result = response as SessionSnapshot & { protocolVersion?: number; features?: string[] };
      const features = (result.features ?? []).filter(feature => feature !== 'conversation_live_complete');
      if (this.controlHealthy && role?.snapshot().health === 'healthy' && role.snapshot().availability === 'available'
          && features.includes('conversation_observation') && features.includes('control_heartbeat')) features.push('conversation_live_complete');
      return { backend: result.backend, protocolVersion: result.protocolVersion ?? 1, features, snapshot: result };
    } finally { if (!roleObservation) role?.dispose(); }
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
    const live = await this.call('conversation_page', {
      after: request.after, limit: request.limit,
    }) as ConversationPageView;
    const snapshot = await this.snapshot();
    if(snapshot.backend!=='acp'||!snapshot.sessionId)return live;
    try{
      const history=await resumedConversationPage(this.stateDir,request,live,snapshot.sessionId);
      const check=await this.call('conversation_page',{limit:1}) as ConversationPageView;
      return check.snapshot.sessionGeneration===live.snapshot.sessionGeneration?history:await this.call('conversation_page',request) as ConversationPageView;
    }catch{return live;}
  }

  async conversationTail(request: { before?: string; limit?: number } = {}): Promise<ConversationTailPage> {
    // A replacement while reading disk invalidates both the tail and its snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const live = await this.call('conversation_page', { limit: 1 }) as ConversationPageView;
      const snapshot = await this.snapshot();
      let resumed: string | undefined;
      if (snapshot.backend === 'acp' && snapshot.sessionId) {
        try {
          if ((await readFile(join(this.stateDir, '.acp-session-id'), 'utf8')).trim() === snapshot.sessionId) resumed = snapshot.sessionId;
        } catch { /* no resumed history: live generation only */ }
      }
      let page: ConversationTailPage;
      try { page = await conversationTailPage(this.stateDir, request, live.snapshot, resumed); }
      catch (error) { throw new FleetError('invalid_request', (error as Error).message); }
      const check = await this.call('conversation_page', { limit: 1 }) as ConversationPageView;
      if (check.snapshot.sessionGeneration === live.snapshot.sessionGeneration) return page;
    }
    throw new FleetError('stale_state', 'Session generation changed during conversation baseline; explicit recovery required.');
  }

  async submitPromptV2(request: {
    commandId: string; text: string; actorBrowserSession: string; expectedSessionGeneration?: string; requireIdle?: boolean;
    source: 'owner_admin_console';
  }): Promise<PromptReceipt> {
    if (!request.text.trim()) throw new FleetError('invalid_request', 'text is required');
    if (Buffer.byteLength(request.text) > 32 * 1024)
      throw new FleetError('invalid_request', 'text exceeds 32 KiB');
    // A prompt bound to a session generation (voice or attachments) is checked atomically by supervisors that
    // support it. Older supervisors do not know that command and never answer, so check the generation here
    // and submit an ordinary prompt; its command id keeps retries idempotent either way.
    const features = request.requireIdle ? (await this.describe()).features : undefined;
    if (request.requireIdle && (!request.expectedSessionGeneration || !features?.includes('idle_bound_prompts')))
      throw new FleetError('capability_unavailable', 'Live voice requires an updated supervisor.');
    let command: 'submit_voice_prompt' | 'submit_prompt_v2' = 'submit_prompt_v2';
    if (request.expectedSessionGeneration) {
      if ((await this.describe()).features.includes('generation_bound_prompts')) command = 'submit_voice_prompt';
      else {
        const live = await this.call('conversation_page', { limit: 1 }) as ConversationPageView;
        if (live.snapshot?.sessionGeneration !== request.expectedSessionGeneration)
          throw new FleetError('stale_state', 'Agent session changed. Record a new voice message.');
      }
    }
    try {
      return await this.call(command, {
        commandId: request.commandId, text: request.text, actor: request.actorBrowserSession,
        source: request.source, expectedSessionGeneration: request.expectedSessionGeneration, requireIdle: request.requireIdle,
      }) as PromptReceipt;
    } catch (error) {
      const fleetError = normalizeError(error);
      if (fleetError.message.includes('session_changed:'))
        throw new FleetError('stale_state', 'Agent session changed. Record a new voice message.');
      if (fleetError.message.includes('voice_busy:')) throw new FleetError('conflict', 'Agent is already working. Wait for the current turn.');
      if (fleetError.message.includes('idempotency_conflict'))
        throw new FleetError('idempotency_conflict',
          'this command id was already used with a different prompt body');
      throw fleetError;
    }
  }

  async interruptPromptV2(request: { commandId: string; expectedSessionGeneration: string; promptId: string }): Promise<InterruptReceipt> {
    if (!(await this.describe()).features.includes('targeted_voice_interrupt'))
      throw new FleetError('capability_unavailable', 'Live voice requires an updated supervisor.');
    try { return await this.call('interrupt_voice_v2', request) as InterruptReceipt; }
    catch (error) {
      const failure = normalizeError(error);
      if (failure.message.includes('session_changed:')) throw new FleetError('stale_state', 'Agent session changed.');
      throw failure;
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

  async followConversation(request: LegacyConversationFollowRequest | PassiveConversationFollow): Promise<ConversationFollowHandle> {
    const passive = 'controller' in request ? request : undefined;
    let sawPage = false;
    let closed = false;
    let role: ConversationRoleObservation | undefined;
    let unsubscribeRole: (() => void) | undefined;
    let lifetime: string | undefined;
    let roleRevision = -1;
    let silence: ReturnType<typeof setTimeout> | undefined;
    let lastControlHeartbeat = Date.now();
    const armSilence = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => {
        // Liveness only: no role/session snapshots, regardless of web traffic.
        if (Date.now() - lastControlHeartbeat >= 6_000) {
          this.controlHealthy = false; finish('control-silent');
        } else armSilence();
      }, Math.max(1, 6_000 - (Date.now() - lastControlHeartbeat)));
      silence.unref?.();
    };
    let follow: Awaited<ReturnType<typeof followConversation>> | undefined;
    const finish = (reason?: string) => {
      if (closed) return;
      closed = true;
      passive?.signal?.removeEventListener('abort', aborted);
      if (silence) clearTimeout(silence);
      unsubscribeRole?.();
      if (!passive?.roleObservation) role?.dispose();
      follow?.close();
      request.onClose(reason);
    };
    const aborted = () => finish('conversation follow aborted');
    passive?.signal?.addEventListener('abort', aborted, {once:true});
    if (passive?.signal?.aborted) aborted();
    if (closed) return {close:()=>{}};
    try {
      if (passive) {
        const changed = (state: ConversationRoleState) => {
          if (closed || state.roleRevision <= roleRevision) return;
          roleRevision = state.roleRevision;
          passive.onRole?.(state);
          if (state.health !== 'healthy') { this.controlHealthy = false; finish(state.failure ?? 'role-observation-unavailable'); }
          else if (lifetime !== undefined && (state.roleLifetime !== lifetime || state.availability !== 'available' || state.stateDir !== this.stateDir)) finish('role-replaced');
          lifetime = state.roleLifetime;
        };
        role = passive.roleObservation ?? this.observeRole?.(() => {});
        if (role) {
          const registration = role.subscribe(changed);
          unsubscribeRole = registration.unsubscribe;
          const initial = registration.snapshot;
          changed(initial);
          if (initial.availability !== 'available' || initial.stateDir !== this.stateDir) finish('role-unavailable');
          if (closed) return { close: () => {} };
        }
        armSilence();
      }
      follow = await this.openFollow(this.stateDir, passive ? { controller: false, expectedGeneration: passive.expectedGeneration, after: passive.after, signal: passive.signal } : (request as LegacyConversationFollowRequest).after, message => {
        if (closed) return;
        if (passive && message.controlHeartbeat === true) { lastControlHeartbeat = Date.now(); this.controlHealthy = true; armSilence(); return; }
        if (message.ok === false) { finish(String(message.error ?? 'conversation follow refused')); return; }
        if (message.conversationEvent) { request.onEvent(message.conversationEvent as ConversationEventV1); return; }
        if (passive) {
          if (message.conversationReplay) passive.onReplay(message.conversationReplay as ConversationReplayPage);
          else if (message.conversationReady) passive.onReady(message.conversationReady as ConversationReplayReady);
          else if (message.conversationState) passive.onState(message.conversationState as ConversationObservationState);
        } else if (!sawPage) {
          sawPage = true;
          (request as LegacyConversationFollowRequest).onPage(message.result as ConversationPageView);
        }
      });
      // Abort may win while the connector is still creating its handle.
      if (closed || passive?.signal?.aborted) { follow.close(); finish('conversation follow aborted'); }
      else {
        follow.socket.once('close', () => finish());
        follow.socket.once('error', error => finish((error as Error).message));
        if (follow.socket.destroyed) finish();
      }
      return { close: () => finish() };
    } catch (error) { finish((error as Error).message); throw error; }
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

/** @deprecated Compatibility name; control is provider-neutral. */
export { RoleSessionControlAdapter as AcpRoleSessionAdapter };
