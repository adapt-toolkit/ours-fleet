import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { createHmac, randomBytes } from 'node:crypto';
import { FleetError, normalizeError } from '../application/errors.js';
import type { FleetQueryService } from '../application/fleet-query-service.js';
import type { RoleRepository } from '../application/role-repository.js';
import type { RoleSessionControl } from '../application/session-control.js';
import type { StructuredLogService } from '../application/log-service.js';
import type { RoleCommandService } from '../application/role-command-service.js';
import type { LifecycleAction } from '../application/role-command-service.js';
import type {
  CreateRoleSessionRequest, RoleCreationService,
} from '../application/role-creation-service.js';
import { VERSION } from '../version.js';
import type { WatchdogQueryService } from '../watchdog/query.js';
import { AuditSink } from './audit.js';
import { WebAuth } from './auth.js';
import { FleetEventBus } from './events.js';

export interface WebServices {
  query: FleetQueryService;
  repository: RoleRepository;
  session(roleId: string): Promise<RoleSessionControl>;
  logs: StructuredLogService;
  commands: RoleCommandService;
  creation: RoleCreationService;
  audit?: AuditSink;
  events?: FleetEventBus;
  watchdogs?: WatchdogQueryService;
  terminalUpgrade?: (
    socket: WebSocket, request: FastifyRequest, roleId: string,
    ticket: string, hello: Record<string, unknown>,
  ) => Promise<void>;
}

export interface WebServer {
  app: FastifyInstance;
  auth: WebAuth;
  audit: AuditSink;
  events: FleetEventBus;
  close(): Promise<void>;
}

const statusFor = (code: string): number => ({
  role_not_found: 404, unauthorized: 401, forbidden: 403, conflict: 409,
  idempotency_conflict: 409, stale_state: 409, rate_limited: 429,
  invalid_request: 400, capability_unavailable: 409, prerequisite_unavailable: 503,
}[code] ?? 500);

export async function buildWebServer(
  services: WebServices,
  boundary: { origin: string; host: string },
  options: { auth?: WebAuth } = {},
): Promise<WebServer> {
  const app = Fastify({
    trustProxy: false, bodyLimit: 64 * 1024, logger: false,
    requestIdHeader: false, genReqId: () => cryptoRandomId(),
  });
  const auth = options.auth ?? new WebAuth(boundary.origin, boundary.host);
  const audit = services.audit ?? new AuditSink();
  const events = services.events ?? new FleetEventBus();
  const digestKey = randomBytes(32);

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; ` +
      `connect-src 'self' ${auth.secureCookies ? 'wss' : 'ws'}://${auth.host}; object-src 'none'; base-uri 'none'; ` +
      `frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self'`);
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    try { auth.validateBoundary(request, false); }
    catch (error) {
      if (request.url.startsWith('/api/')) throw error;
      const message = normalizeError(error).message;
      return reply.code(421).type('text/html').send(`<!doctype html><html><head><title>Fleet console address</title></head><body><main><h1>This fleet-console address is not configured</h1><p>${escapeHtml(message)}</p><p>For nginx or VPS access, configure an explicit public origin. The console does not guess proxy hosts.</p></main></body></html>`);
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const fleetError = normalizeError(error, request.id);
    await audit.record({
      requestId: request.id, action: `${request.method} ${request.routeOptions.url ?? request.url}`,
      result: 'rejected', errorCode: fleetError.code,
    });
    reply.code(statusFor(fleetError.code)).send({ error: fleetError.toJSON() });
  });

  app.post('/api/v1/auth/exchange', async (request, reply) => {
    const { session, device } = auth.exchange(request);
    setAuthCookies(reply, session.id, device.token, auth.secureCookies);
    await audit.record({ requestId: request.id, browser: session.id, action: 'auth.exchange', result: 'succeeded' });
    return { csrfToken: session.csrf, expiresAt: new Date(session.absoluteExpiresAt).toISOString() };
  });

  app.get('/api/v1/auth/mode', async () => ({
    mode: auth.mode,
    warning: auth.mode === 'none'
      ? 'Unprotected mode: anyone who can reach this address can control the fleet.' : undefined,
  }));

  app.post('/api/v1/auth/login', async (request, reply) => {
    const { session, device } = auth.login(request, String((request.body as { password?: unknown })?.password ?? ''));
    setAuthCookies(reply, session.id, device.token, auth.secureCookies);
    await audit.record({ requestId: request.id, browser: session.id, action: 'auth.password', result: 'succeeded' });
    return { csrfToken: session.csrf, expiresAt: new Date(session.absoluteExpiresAt).toISOString() };
  });

  app.post('/api/v1/auth/anonymous', async (request, reply) => {
    const session = auth.anonymous(request);
    setSessionCookie(reply, session.id, auth.secureCookies);
    return { csrfToken: session.csrf, expiresAt: new Date(session.absoluteExpiresAt).toISOString() };
  });

  app.post('/api/v1/auth/resume', async (request, reply) => {
    const { session, device } = auth.resume(request);
    setAuthCookies(reply, session.id, device.token, auth.secureCookies);
    await audit.record({ requestId: request.id, browser: session.id, action: 'auth.resume', result: 'succeeded' });
    return { csrfToken: session.csrf, expiresAt: new Date(session.absoluteExpiresAt).toISOString() };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    auth.logout(request);
    clearAuthCookies(reply);
    await audit.record({ requestId: request.id, action: 'auth.logout', result: 'succeeded' });
    return { ok: true };
  });

  app.get('/api/v1/auth/session', async request => {
    const session = auth.authenticate(request);
    return { csrfToken: session.csrf, expiresAt: new Date(session.absoluteExpiresAt).toISOString() };
  });

  app.get('/api/v1/meta', async request => {
    auth.authenticate(request);
    return {
      version: VERSION, api: { major: 1, minor: 0 },
      websocketProtocols: [
        'ours-fleet-events.v1', 'ours-fleet-terminal.v1', 'ours-fleet-conversation.v1',
      ],
      auditDegraded: audit.degraded,
    };
  });

  app.get('/api/v1/creation-capabilities', async request => {
    auth.authenticate(request);
    return services.creation.capabilities();
  });

  app.post('/api/v1/roles/preview', async request => {
    auth.authenticate(request, true);
    return services.creation.preview(request.body as CreateRoleSessionRequest);
  });

  app.post('/api/v1/roles', async (request, reply) => {
    const session = auth.authenticate(request, true);
    const body = request.body as { request?: CreateRoleSessionRequest; previewHash?: string };
    const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
    if (!body?.request || !body.previewHash)
      throw new FleetError('invalid_request', 'request and previewHash are required');
    const action = await services.creation.create(
      body.request, body.previewHash, idempotencyKey, session.id);
    events.publish('creation.changed', action, action.roleId);
    reply.header('Location', `/api/v1/creation-actions/${encodeURIComponent(action.actionId)}`);
    reply.code(202);
    return action;
  });

  app.get('/api/v1/roles', async request => {
    auth.authenticate(request);
    return { roles: await services.query.list() };
  });

  app.get<{ Params: { id: string } }>('/api/v1/roles/:id', async request => {
    auth.authenticate(request);
    return services.query.detail(request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>(
    '/api/v1/roles/:id/output', async request => {
      auth.authenticate(request);
      const control = await services.session(request.params.id);
      return control.recentOutput({
        since: request.query.since ? Number(request.query.since) : undefined,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });
    });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    '/api/v1/roles/:id/conversation', async request => {
      auth.authenticate(request);
      const control = await services.session(request.params.id);
      if (!control.conversationPage)
        throw new FleetError('capability_unavailable', 'this role has no conversation ledger');
      return control.conversationPage({
        after: request.query.after,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });
    });

  app.post<{ Params: { id: string } }>('/api/v1/roles/:id/input', async (request, reply) => {
    const session = auth.authenticate(request, true);
    const body = request.body as { text?: unknown; commandId?: unknown };
    const text = String(body?.text ?? '');
    const commandId = typeof body?.commandId === 'string' && body.commandId.trim()
      ? body.commandId : undefined;
    const control = await services.session(request.params.id);
    // The idempotent, durably admitted path — used whenever the caller sends a
    // command id and the role has a conversation ledger. The legacy path stays
    // for old clients and tmux roles.
    if (commandId && control.submitPromptV2) {
      const receipt = await control.submitPromptV2({
        commandId, text,
        actorBrowserSession: createHmac('sha256', digestKey).update(session.id).digest('hex').slice(0, 24),
      });
      await audit.record({
        requestId: request.id, browser: session.id, roleId: request.params.id,
        action: 'session.submit_prompt', result: receipt.state,
        bytes: Buffer.byteLength(text),
        digest: createHmac('sha256', digestKey).update(text).digest('hex').slice(0, 24),
      });
      reply.code(202);
      return receipt;
    }
    const receipt = await control.sendText(text);
    await audit.record({
      requestId: request.id, browser: session.id, roleId: request.params.id,
      action: 'session.send_text', result: receipt.accepted ? 'accepted' : 'failed',
      bytes: Buffer.byteLength(text),
      digest: createHmac('sha256', digestKey).update(text).digest('hex').slice(0, 24),
    });
    return receipt;
  });

  app.post<{ Params: { id: string } }>('/api/v1/roles/:id/interrupt', async (request, reply) => {
    const session = auth.authenticate(request, true);
    const body = request.body as { commandId?: unknown } | undefined;
    const commandId = typeof body?.commandId === 'string' && body.commandId.trim()
      ? body.commandId : undefined;
    const control = await services.session(request.params.id);
    if (commandId && control.interruptV2) {
      const receipt = await control.interruptV2(commandId);
      await audit.record({
        requestId: request.id, browser: session.id, roleId: request.params.id,
        action: 'session.interrupt', result: 'accepted',
      });
      reply.code(202);
      return receipt;
    }
    if (!control.interrupt) throw new FleetError('capability_unavailable', 'interrupt is unavailable');
    return control.interrupt();
  });

  app.post<{ Params: { id: string; permissionId: string } }>(
    '/api/v1/roles/:id/permissions/:permissionId', async request => {
      auth.authenticate(request, true);
      const control = await services.session(request.params.id);
      if (!control.respondPermission)
        throw new FleetError('capability_unavailable', 'permission response is unavailable');
      return control.respondPermission({
        permissionId: request.params.permissionId,
        optionId: String((request.body as { optionId?: unknown })?.optionId ?? ''),
      });
    });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/api/v1/roles/:id/logs', async request => {
      auth.authenticate(request);
      return services.logs.source(request.params.id)
        .tail(Number(request.query.limit ?? 200), request.query.cursor);
    });

  app.post<{ Params: { id: string } }>('/api/v1/roles/:id/actions', async (request, reply) => {
    auth.authenticate(request, true);
    const body = request.body as { action?: LifecycleAction; actionId?: string; confirmation?: string };
    if (!body.action || !['start', 'stop', 'restart_resume', 'restart_fresh'].includes(body.action))
      throw new FleetError('invalid_request', 'invalid lifecycle action');
    const receipt = await services.commands.execute({
      roleId: request.params.id, action: body.action!,
      actionId: body.actionId, confirmation: body.confirmation,
    });
    events.publish('action.changed', receipt, request.params.id);
    reply.code(202);
    return receipt;
  });

  app.get<{ Params: { actionId: string } }>('/api/v1/actions/:actionId', async request => {
    auth.authenticate(request);
    const receipt = services.commands.get(request.params.actionId);
    if (!receipt) throw new FleetError('role_not_found', 'action not found');
    return receipt;
  });

  app.get<{ Params: { actionId: string } }>('/api/v1/creation-actions/:actionId', async request => {
    auth.authenticate(request);
    const action = services.creation.get(request.params.actionId);
    if (!action) throw new FleetError('role_not_found', 'creation action not found');
    return action;
  });

  app.post('/api/v1/ws-tickets', async request => {
    const body = request.body as {
      purpose?: 'events' | 'terminal' | 'conversation'; roleId?: string;
    };
    if (!body?.purpose || !['events', 'terminal', 'conversation'].includes(body.purpose))
      throw new FleetError('invalid_request', 'ticket purpose is required');
    if (body.purpose === 'conversation' && !body.roleId)
      throw new FleetError('invalid_request', 'a conversation ticket must be bound to a role');
    return auth.mintTicket(request, body.purpose, body.roleId);
  });

  app.get('/api/v1/audit', async request => {
    auth.authenticate(request);
    return { records: audit.list() };
  });

  app.get('/api/v1/watchdogs', async request => {
    auth.authenticate(request);
    if (!services.watchdogs) throw new FleetError('capability_unavailable', 'watchdogs are unavailable');
    return services.watchdogs.list();
  });

  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/api/v1/watchdogs/:name/reports', async request => {
      auth.authenticate(request);
      if (!services.watchdogs) throw new FleetError('capability_unavailable', 'watchdogs are unavailable');
      return services.watchdogs.reports(
        request.params.name, request.query.limit ? Number(request.query.limit) : undefined);
    });

  app.get<{ Params: { name: string; runId: string } }>(
    '/api/v1/watchdogs/:name/reports/:runId', async request => {
      auth.authenticate(request);
      if (!services.watchdogs) throw new FleetError('capability_unavailable', 'watchdogs are unavailable');
      return services.watchdogs.report(request.params.name, request.params.runId);
    });

  app.get('/api/v1/events', { websocket: true }, (socket, request) => {
    requireSubprotocol(request, 'ours-fleet-events.v1');
    authorizeSocket(socket, request, async hello => {
      const session = auth.consumeTicket(request, String(hello.ticket ?? ''), 'events');
      auth.bindSocket(session.id, socket);
      const detach = events.attach(socket, typeof hello.lastEventId === 'string' ? hello.lastEventId : undefined);
      socket.on('close', detach);
      socket.send(JSON.stringify({ kind: 'ready', at: new Date().toISOString() }));
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/roles/:id/conversation-stream', { websocket: true }, (socket, request) => {
      requireSubprotocol(request, 'ours-fleet-conversation.v1');
      authorizeSocket(socket, request, async hello => {
        const session = auth.consumeTicket(
          request, String(hello.ticket ?? ''), 'conversation', request.params.id);
        auth.bindSocket(session.id, socket);
        const control = await services.session(request.params.id);
        if (!control.followConversation)
          throw new FleetError('capability_unavailable', 'this role has no conversation ledger');
        const after = typeof hello.after === 'string' && hello.after ? hello.after : undefined;

        // Backpressure discipline (spec §5.5): a browser that cannot keep up
        // gets an explicit resync signal, then a close — durable events are
        // never dropped silently, the store remains the recovery source.
        let resyncSent = false;
        const guardedSend = (payload: unknown): void => {
          if (socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > 4 * 1024 * 1024) {
            socket.close(4408, 'slow consumer');
            return;
          }
          if (socket.bufferedAmount > 1 * 1024 * 1024) {
            if (!resyncSent) {
              resyncSent = true;
              socket.send(JSON.stringify({ type: 'resync.required' }));
            }
            return;
          }
          socket.send(JSON.stringify(payload));
        };

        const follow = await control.followConversation({
          after,
          onPage: page => {
            guardedSend({
              type: 'ready',
              snapshot: page.snapshot,
              firstAvailableCursor: page.firstAvailableCursor,
              lastCursor: page.nextCursor ?? after,
            });
            if (page.events.length) guardedSend({ type: 'events', events: page.events });
            if (page.hasMore) guardedSend({ type: 'resync.required' });
          },
          onEvent: event => guardedSend({ type: 'events', events: [event] }),
          onClose: reason => {
            if (socket.readyState === socket.OPEN)
              socket.close(4409, (reason ?? 'conversation stream ended').slice(0, 120));
          },
        });
        const heartbeat = setInterval(() => {
          if (socket.readyState === socket.OPEN) socket.ping();
        }, 30_000);
        socket.on('close', () => { clearInterval(heartbeat); follow.close(); });
      });
    });

  app.get<{ Params: { id: string } }>(
    '/api/v1/roles/:id/terminal', { websocket: true }, (socket, request) => {
      requireSubprotocol(request, 'ours-fleet-terminal.v1');
      authorizeSocket(socket, request, async hello => {
        const ticket = String(hello.ticket ?? '');
        const session = auth.consumeTicket(request, ticket, 'terminal', request.params.id);
        auth.bindSocket(session.id, socket);
        if (!services.terminalUpgrade)
          throw new FleetError('capability_unavailable', 'terminal PTY support is unavailable');
        await services.terminalUpgrade(socket, request, request.params.id, ticket, hello);
      });
    });

  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web-app');
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return {
    app, auth, audit, events,
    async close() {
      auth.shutdown();
      events.close();
      await app.close();
    },
  };
}

function setAuthCookies(reply: { header(name: string, value: string | string[]): unknown }, session: string, device: string, secure = false): void {
  const suffix = secure ? '; Secure' : '';
  reply.header('Set-Cookie', [
    `ofs_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${suffix}`,
    `ofs_device=${encodeURIComponent(device)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=2592000${suffix}`,
  ]);
}

function setSessionCookie(reply: { header(name: string, value: string | string[]): unknown }, session: string, secure = false): void {
  reply.header('Set-Cookie', `ofs_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${secure ? '; Secure' : ''}`);
}

function clearAuthCookies(reply: { header(name: string, value: string | string[]): unknown }): void {
  reply.header('Set-Cookie', [
    'ofs_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0',
    'ofs_device=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0',
  ]);
}

function cryptoRandomId(): string { return randomBytes(12).toString('hex'); }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function requireSubprotocol(request: FastifyRequest, expected: string): void {
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',').map(value => value.trim());
  if (!protocols.includes(expected)) throw new FleetError('forbidden', `required subprotocol ${expected}`);
}

function authorizeSocket(
  socket: WebSocket, request: FastifyRequest,
  authorize: (hello: Record<string, unknown>) => Promise<void>,
): void {
  const timer = setTimeout(() => socket.close(4401, 'authorization timeout'), 5_000);
  socket.once('message', data => {
    clearTimeout(timer);
    void (async () => {
      try {
        const hello = JSON.parse(data.toString()) as Record<string, unknown>;
        await authorize(hello);
      } catch (error) {
        socket.close(4403, normalizeError(error).message.slice(0, 120));
      }
    })();
  });
}
