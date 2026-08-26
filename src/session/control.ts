import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { SessionControlError } from './types.js';
import type { ControlFailureKind, SessionEvent, SessionHandle, SessionSnapshot } from './types.js';
import type {
  OwnerChannelHandle, OwnerChannelManagementRequest,
} from '../owner-channel/channel.js';
import type { ScheduledLoopManagerHandle } from '../loops/manager.js';
import type { SpawnOpts } from '../spawn.js';
import type { ManagedFleetSpawnResult } from '../fleet-proxy.js';
import {
  interruptSession, queueSessionPrompt, respondSessionPermission, respondSessionPermissionV2,
} from '../application/session-mutations.js';

const MAX_LINE_BYTES = 64 * 1024;

export interface ControlRequest {
  version: 1 | 2 | 3;
  id: string;
  token: string;
  command: 'status' | 'snapshot' | 'submit_prompt' | 'respond_permission' | 'interrupt' | 'follow' | 'events_since' | 'owner_channel_manage'
    | 'loop_status' | 'loop_run_now' | 'loop_disable' | 'loop_enable' | 'reload_config'
    | 'conversation_page' | 'conversation_follow' | 'submit_prompt_v2' | 'interrupt_v2'
    | 'respond_permission_v2' | 'fleet_spawn';
  text?: string;
  permissionId?: string;
  optionId?: string;
  since?: number;
  /** Existing clients omit this and remain interactive controllers. */
  controller?: boolean;
  ownerChannel?: OwnerChannelManagementRequest;
  loop?: string;
  // ── conversation v3 fields ──────────────────────────────────────────────────
  /** Conversation cursor: replay strictly after this durable seq. */
  after?: string;
  limit?: number;
  /** Idempotency key for v3 mutations. */
  commandId?: string;
  /** Browser-session digest recorded as the acting principal. */
  actor?: string;
  /** Server-stamped provenance. User-controlled text cannot set this field. */
  source?: 'owner_admin_console';
  /** Runner generation shown with a permission card. */
  sessionGeneration?: string;
  /** Typed managed-spawn request accepted only over the authenticated role control plane. */
  spawn?: SpawnOpts;
}

/** Commands that require protocol version 3. */
const V3_COMMANDS = new Set<ControlRequest['command']>([
  'conversation_page', 'conversation_follow', 'submit_prompt_v2', 'interrupt_v2',
  'respond_permission_v2',
]);

export interface ControlResponse {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Why it failed, so the caller does not have to guess from the text. */
  kind?: ControlFailureKind;
}

export interface RetainedEventPage {
  events: SessionEvent[];
  snapshot: SessionSnapshot;
  firstSeq: number;
  lastSeq: number;
  truncated: boolean;
}

/** The one retained-range projection shared by polling and live-follow admission. */
export function retainedEventPage(session: SessionHandle, since: number): RetainedEventPage {
  const events = session.eventsSince(since);
  const all = session.eventsSince(0);
  return {
    events,
    snapshot: session.snapshot(),
    firstSeq: all[0]?.seq ?? 0,
    lastSeq: all.at(-1)?.seq ?? 0,
    truncated: Boolean(all[0] && since > 0 && since < all[0].seq - 1),
  };
}

/**
 * One line saying what a control failure does — and does not — prove about the
 * agent. Only `offline` is evidence that it is gone; every other kind used to
 * be rendered as "is not running", which is how a busy agent got restarted.
 */
export function livenessNote(kind: ControlFailureKind, name: string): string {
  switch (kind) {
    case 'offline':
      return `'${name}' is confirmed offline.`;
    case 'control-unavailable':
      return `this says nothing about whether '${name}' is alive — its control plane did not answer; ` +
        `check: ours-fleet status ${name}`;
    case 'timeout':
      return `'${name}' did not answer in time; a busy agent looks exactly like this. ` +
        `Check: ours-fleet status ${name}`;
    case 'rejected':
      return `'${name}' is running and refused the request.`;
    case 'backend':
      return `this is a transport failure, not evidence that '${name}' is gone; ` +
        `check: ours-fleet status ${name}`;
  }
}

/**
 * The result taxonomy an overseer judges a role by.
 *
 * One console command is not a liveness verdict. `peek` and `send` can fail for
 * five distinct reasons and succeed for one, and only ONE of the six says the
 * agent is gone — collapsing them into "not running" is how busy agents got
 * restarted. This is the single definition of that vocabulary: the generated
 * briefing renders it, and the shipped oversee-agents skills quote it. The
 * per-result wording comes from `livenessNote` rather than being restated, so
 * the words an overseer reads in its instructions are the words the CLI prints.
 */
export interface OversightResult {
  /** What the command reported: the one success, or the failure kind. */
  result: 'queued' | ControlFailureKind;
  /** What it proves about the agent. */
  meaning: string;
  /** What the overseer does next. */
  action: string;
  /**
   * Whether this result ALONE justifies restarting the role. True for exactly
   * one result. Every other one requires corroboration before touching a role
   * that may simply be working.
   */
  restartJustified: boolean;
}

/** The taxonomy, in the order generated guidance presents it. */
export function oversightTaxonomy(name = '<Name>'): OversightResult[] {
  return [
    {
      result: 'queued',
      meaning: `the session accepted the prompt for '${name}'; a turn already running is not a failure.`,
      action: 'Nothing. Do not resend, and do not read the absence of a reply as a stall — '
        + `check progress with: ours-fleet peek ${name}`,
      restartJustified: false,
    },
    {
      result: 'timeout',
      meaning: livenessNote('timeout', name),
      action: 'Treat delivery as UNCERTAIN — the request may already have been acted on, so do not '
        + 'resend it blindly.',
      restartJustified: false,
    },
    {
      result: 'rejected',
      meaning: livenessNote('rejected', name),
      action: 'Fix the request, not the agent. A refusal is proof of life.',
      restartJustified: false,
    },
    {
      result: 'control-unavailable',
      meaning: livenessNote('control-unavailable', name),
      action: 'Read the role logs as well. The control plane and the agent are separate things, '
        + 'and one being unreachable is not evidence about the other.',
      restartJustified: false,
    },
    {
      result: 'backend',
      meaning: livenessNote('backend', name),
      action: 'Investigate the transport, not the agent.',
      restartJustified: false,
    },
    {
      result: 'offline',
      meaning: livenessNote('offline', name),
      action: `This is the ONLY result that justifies a restart on its own: ours-fleet restart ${name} `
        + 'for a permanent role. Read the logs first.',
      restartJustified: true,
    },
  ];
}

/**
 * The taxonomy as guidance lines, for a briefing or any generated document.
 * The shipped oversee-agents skills carry these same lines, and a test holds
 * them to it — so an overseer reading its briefing and an overseer reading the
 * skill cannot be given different rules.
 */
export function oversightTaxonomyLines(name = '<Name>'): string[] {
  return oversightTaxonomy(name).map(r => `- **${r.result}** — ${r.meaning} → ${r.action}`);
}

export const controlSocketPath = (stateDir: string) => join(stateDir, '.control.sock');
export const controlTokenPath = (stateDir: string) => join(stateDir, '.control-token');

function sameToken(actual: string, supplied: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Private, versioned JSONL control plane for CLI and future console frontends. */
export class RoleControlServer {
  private readonly server: Server;
  private readonly socketPath: string;
  private readonly token: string;
  private readonly sockets = new Set<Socket>();
  /** Interrupt idempotency: same command id returns the first receipt. */
  private readonly interruptCommands = new Map<string, unknown>();
  private ownerChannel?: OwnerChannelHandle;
  private loopManager?: ScheduledLoopManagerHandle;
  private reloadConfig?: () => Promise<unknown>;
  private fleetSpawner?: (options: SpawnOpts) => Promise<ManagedFleetSpawnResult>;

  constructor(
    stateDir: string,
    private readonly session: SessionHandle,
    private readonly log: (line: string) => void,
  ) {
    this.socketPath = controlSocketPath(stateDir);
    const tokenPath = controlTokenPath(stateDir);
    this.token = existsSync(tokenPath)
      ? readFileSync(tokenPath, 'utf8').trim()
      : randomBytes(32).toString('hex');
    writeFileSync(tokenPath, this.token + '\n', { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    rmSync(this.socketPath, { force: true });
    this.server = createServer(socket => this.accept(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        try { chmodSync(this.socketPath, 0o600); } catch { /* platform dependent */ }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    rmSync(this.socketPath, { force: true });
  }

  /** Attach only the already-started supervisor-owned channel client. */
  setOwnerChannel(ownerChannel: OwnerChannelHandle | undefined): void {
    this.ownerChannel = ownerChannel;
  }

  setLoopManager(loopManager: ScheduledLoopManagerHandle | undefined): void {
    this.loopManager = loopManager;
  }

  setConfigReloader(reloadConfig: (() => Promise<unknown>) | undefined): void {
    this.reloadConfig = reloadConfig;
  }

  setFleetSpawner(
    fleetSpawner: ((options: SpawnOpts) => Promise<ManagedFleetSpawnResult>) | undefined,
  ): void {
    this.fleetSpawner = fleetSpawner;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let unsubscribe: (() => void) | undefined;
    let controllerAttached = false;
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        socket.destroy(new Error('control request too large'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void this.handle(line, socket).then(follow => {
          if (follow) {
            if (unsubscribe) {
              unsubscribe();
              if (controllerAttached) this.session.setControllerAttached(false);
            }
            unsubscribe = follow.stop;
            controllerAttached = follow.controller;
          }
        });
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (unsubscribe) {
        unsubscribe();
        if (controllerAttached) this.session.setControllerAttached(false);
      }
    });
    socket.on('error', error => this.log(`control socket: ${error.message}`));
  }

  private async handle(
    line: string, socket: Socket,
  ): Promise<{ stop: () => void; controller: boolean } | undefined> {
    let request: ControlRequest;
    try { request = JSON.parse(line) as ControlRequest; }
    catch {
      this.write(socket, { version: 1, id: '?', ok: false, error: 'invalid JSON' });
      return;
    }
    if (![1, 2, 3].includes(request.version) || typeof request.id !== 'string'
        || !sameToken(this.token, request.token ?? '')) {
      this.write(socket, { version: 1, id: request.id ?? '?', ok: false, error: 'unauthorized' });
      return;
    }
    try {
      switch (request.command) {
        case 'status':
        case 'snapshot':
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: {
              ...this.session.snapshot(),
              protocolVersion: this.session.conversationPage ? 3 : 2,
              features: [
                'events_since', 'observer_follow', 'retained_range',
                ...(this.session.conversationPage ? ['conversation_v3'] : []),
              ],
            },
          });
          return;
        case 'submit_prompt': {
          if (!request.text?.trim())
            throw new SessionControlError('rejected', 'text is required');
          // Answer on QUEUE ACCEPTANCE, not on turn completion. A turn can run
          // for minutes; blocking here made every `send` into a busy agent time
          // out, and the timeout was then reported as a dead agent.
          const queued = await queueSessionPrompt(this.session, request.text, {
            origin: { kind: 'local-console' },
          });
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: {
              state: 'queued', promptId: queued.promptId, queuedBehind: queued.queuedBehind,
            },
          });
          return;
        }
        case 'respond_permission': {
          if (!request.permissionId || !request.optionId)
            throw new SessionControlError('rejected', 'permissionId and optionId are required');
          const accepted = respondSessionPermission(
            this.session, request.permissionId, request.optionId);
          this.write(socket, {
            version: 1, id: request.id, ok: accepted,
            result: { accepted },
            error: accepted ? undefined : 'stale or invalid permission response',
            kind: accepted ? undefined : 'rejected',
          });
          return;
        }
        case 'interrupt': {
          // Forced recovery cancelled the turn just as surely as a cooperative
          // stop did. Report HOW, never as a failed operation.
          const outcome = await interruptSession(this.session, 'local-console');
          this.write(socket, { version: 1, id: request.id, ok: true, result: outcome });
          return;
        }
        case 'loop_status': {
          if (!this.loopManager)
            throw new SessionControlError('rejected', 'scheduled loops are unavailable for this role');
          this.write(socket, { version: 1, id: request.id, ok: true, result: this.loopManager.status() });
          return;
        }
        case 'loop_run_now':
        case 'loop_disable':
        case 'loop_enable': {
          if (request.version !== 2 || !request.loop)
            throw new SessionControlError('rejected', 'version 2 and loop name are required');
          if (!this.loopManager)
            throw new SessionControlError('rejected', 'scheduled loops are unavailable for this role');
          const result = request.command === 'loop_run_now'
            ? await this.loopManager.runNow(request.loop)
            : request.command === 'loop_disable'
              ? this.loopManager.disable(request.loop)
              : this.loopManager.enable(request.loop);
          this.write(socket, { version: 1, id: request.id, ok: true, result });
          return;
        }
        case 'reload_config': {
          if (request.version !== 2 || !this.reloadConfig)
            throw new SessionControlError('rejected', 'config reload is unavailable for this role');
          this.write(socket, {
            version: 1, id: request.id, ok: true, result: await this.reloadConfig(),
          });
          return;
        }
        case 'fleet_spawn': {
          if (request.version !== 2 || !request.spawn || typeof request.spawn.name !== 'string')
            throw new SessionControlError('rejected', 'version 2 and typed spawn options are required');
          if (!this.fleetSpawner)
            throw new SessionControlError('rejected', 'managed fleet spawning is unavailable for this role');
          const result = await this.fleetSpawner(request.spawn);
          this.write(socket, { version: 1, id: request.id, ok: true, result });
          return;
        }
        case 'owner_channel_manage': {
          if (!request.ownerChannel || typeof request.ownerChannel.action !== 'string')
            throw new SessionControlError('rejected', 'owner-channel management action is required');
          if (!this.ownerChannel)
            throw new SessionControlError('rejected', 'owner channel is disabled or unavailable for this role');
          const result = await this.ownerChannel.manage(request.ownerChannel);
          this.write(socket, { version: 1, id: request.id, ok: true, result });
          return;
        }
        case 'events_since': {
          const since = Number.isFinite(request.since) ? Number(request.since) : 0;
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: retainedEventPage(this.session, since),
          });
          return;
        }
        case 'follow': {
          const since = Number.isFinite(request.since) ? Number(request.since) : 0;
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: retainedEventPage(this.session, since),
          });
          const controller = request.controller !== false;
          if (controller) this.session.setControllerAttached(true);
          return { controller, stop: this.session.subscribe(event => {
            if (!socket.destroyed) socket.write(JSON.stringify({ version: 1, event }) + '\n');
          }) };
        }
        case 'conversation_page': {
          this.requireConversation(request);
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: this.session.conversationPage!({
              after: request.after, limit: request.limit,
            }),
          });
          return;
        }
        case 'conversation_follow': {
          this.requireConversation(request);
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: this.session.conversationPage!({
              after: request.after, limit: request.limit,
            }),
          });
          // A live conversation view is an attached controller: permission
          // requests must reach it instead of the unattended policy.
          const controller = request.controller !== false;
          if (controller) this.session.setControllerAttached(true);
          return { controller, stop: this.session.subscribeConversation!(event => {
            if (!socket.destroyed)
              socket.write(JSON.stringify({ version: 1, conversationEvent: event }) + '\n');
          }) };
        }
        case 'submit_prompt_v2': {
          this.requireConversation(request);
          if (!request.commandId?.trim() || !request.text?.trim() || !request.actor?.trim()
              || request.source !== 'owner_admin_console')
            throw new SessionControlError('rejected',
              'commandId, text, actor and authenticated source are required');
          if (!this.session.submitPromptBrowser)
            throw new SessionControlError('rejected', 'browser prompt admission is unavailable for this role');
          try {
            const receipt = await this.session.submitPromptBrowser({
              commandId: request.commandId, text: request.text,
              source: 'owner_admin_console', actorBrowserSession: request.actor,
            });
            this.write(socket, { version: 1, id: request.id, ok: true, result: receipt });
          } catch (error) {
            if ((error as Error).name === 'IdempotencyConflictError')
              throw new SessionControlError('rejected',
                'idempotency_conflict: this command id was used with a different prompt body');
            throw error;
          }
          return;
        }
        case 'interrupt_v2': {
          this.requireConversation(request);
          if (!request.commandId?.trim())
            throw new SessionControlError('rejected', 'commandId is required');
          const existing = this.interruptCommands.get(request.commandId);
          if (existing) {
            this.write(socket, { version: 1, id: request.id, ok: true, result: existing });
            return;
          }
          const outcome = await interruptSession(this.session, 'local-console');
          const receipt = {
            accepted: true, commandId: request.commandId, at: new Date().toISOString(),
            ...outcome,
          };
          this.interruptCommands.set(request.commandId, receipt);
          if (this.interruptCommands.size > 200) {
            const oldest = this.interruptCommands.keys().next().value as string;
            this.interruptCommands.delete(oldest);
          }
          this.write(socket, { version: 1, id: request.id, ok: true, result: receipt });
          return;
        }
        case 'respond_permission_v2': {
          this.requireConversation(request);
          if (!request.commandId?.trim() || !request.permissionId?.trim()
              || !request.optionId?.trim() || !request.sessionGeneration?.trim())
            throw new SessionControlError('rejected',
              'commandId, permissionId, optionId and sessionGeneration are required');
          const result = respondSessionPermissionV2(
            this.session,
            request.permissionId, request.optionId, request.sessionGeneration);
          if (result === 'unavailable')
            throw new SessionControlError('rejected',
              'generation-bound permission responses are unavailable for this role');
          if (result === 'stale')
            throw new SessionControlError('rejected',
              'stale_state: permission is settled, expired, invalid, or belongs to another session generation');
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: { accepted: true, commandId: request.commandId },
          });
          return;
        }
      }
    } catch (error) {
      // Carry the session's own classification to the caller. Losing it here is
      // what forced the CLI to invent one.
      this.write(socket, {
        version: 1,
        id: request.id,
        ok: false,
        error: (error as Error)?.message ?? String(error),
        kind: error instanceof SessionControlError ? error.kind : 'backend',
      });
    }
  }

  /** Version and capability gate shared by every conversation v3 command. */
  private requireConversation(request: ControlRequest): void {
    if (request.version !== 3)
      throw new SessionControlError('rejected', 'protocol version 3 is required for conversation commands');
    if (!this.session.conversationPage || !this.session.subscribeConversation)
      throw new SessionControlError('rejected', 'this role has no conversation ledger');
  }

  private write(socket: Socket, response: ControlResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
  }
}

/**
 * Send one control request. Every failure mode is classified: a missing token
 * or socket is `control-unavailable`, a silent server is `timeout`, and a
 * response that is not parseable JSON is `backend`. The caller never has to
 * infer liveness from an exception message.
 */
export async function controlRequest(
  stateDir: string,
  request: Omit<ControlRequest, 'version' | 'id' | 'token'>,
  timeoutMs = 120_000,
): Promise<ControlResponse> {
  let token: string;
  try { token = readFileSync(controlTokenPath(stateDir), 'utf8').trim(); }
  catch (error) {
    throw new SessionControlError('control-unavailable',
      `cannot read the role control token: ${(error as Error)?.message ?? String(error)}`);
  }
  const id = randomUUID();
  const socket = createConnection(controlSocketPath(stateDir));
  socket.setEncoding('utf8');
  return new Promise<ControlResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SessionControlError('timeout',
        `the role control plane did not answer '${request.command}' within ${timeoutMs}ms`));
    }, timeoutMs);
    let buffer = '';
    socket.once('error', error => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(new SessionControlError(
        code === 'ENOENT' || code === 'ECONNREFUSED' ? 'control-unavailable' : 'backend',
        `role control socket: ${error.message}`));
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse); }
      catch (error) {
        reject(new SessionControlError('backend',
          `malformed control response: ${(error as Error)?.message ?? String(error)}`));
      }
      socket.end();
    });
    socket.once('connect', () => socket.write(JSON.stringify({
      version: V3_COMMANDS.has(request.command) ? 3 : 2, id, token, ...request,
    }) + '\n'));
  });
}

export async function followControl(
  stateDir: string,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<{ socket: Socket; send(request: Omit<ControlRequest, 'version' | 'id' | 'token'>): void }> {
  const token = readFileSync(controlTokenPath(stateDir), 'utf8').trim();
  const socket = createConnection(controlSocketPath(stateDir));
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const send = (request: Omit<ControlRequest, 'version' | 'id' | 'token'>) =>
    socket.write(JSON.stringify({
      version: V3_COMMANDS.has(request.command) ? 3 : 1, id: randomUUID(), token, ...request,
    }) + '\n');
  send({ command: 'follow', since: 0 });
  return { socket, send };
}

/**
 * Open a live conversation follow on the role's private control socket. The
 * first message is the initial page + snapshot; every subsequent message is
 * `{ version, conversationEvent }`. Closing the socket detaches the
 * controller-presence this connection contributed.
 */
export async function followConversation(
  stateDir: string,
  after: string | undefined,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<{ socket: Socket; close(): void }> {
  const token = readFileSync(controlTokenPath(stateDir), 'utf8').trim();
  const socket = createConnection(controlSocketPath(stateDir));
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line) as Record<string, unknown>); }
      catch { /* a torn frame ends this stream; the client resyncs over HTTP */ }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(JSON.stringify({
    version: 3, id: randomUUID(), token, command: 'conversation_follow', after,
  }) + '\n');
  return { socket, close: () => socket.destroy() };
}
