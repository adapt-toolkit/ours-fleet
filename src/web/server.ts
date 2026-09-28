import { readChatIdle } from '../temp-idle.js';
import { agentDir } from '../paths.js';
import { SupervisorOursTools, type SupervisorToolRequest } from '../application/supervisor-ours-tools.js';
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
import type { FleetConfigService } from './fleet-config-service.js';
import type { MergedTopology } from './topology-model.js';
import type { TopologyDraftStore } from './topology-draft-store.js';
import type { TopologyPromoteService } from './topology-promote.js';
import type { RoleRemovalService } from '../application/role-removal-service.js';
import { ROLE_NAME_RE } from '../config.js';
import type { TaskRoomApplicationService } from '../application/task-room-service.js';
import { TaskListError } from '../rooms-tasks/task-lists.js';
import { TaskStateError } from '../rooms-tasks/task-state.js';

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
  configuration?: FleetConfigService;
  topology?: () => Promise<MergedTopology>;
  topologyDrafts?: TopologyDraftStore;
  topologyPromote?: TopologyPromoteService;
  removal?: RoleRemovalService;
  taskRooms?: TaskRoomApplicationService;
  oursTools?: Pick<SupervisorOursTools, 'list' | 'call'>;
}

export interface WebServer {
  app: FastifyInstance;
  auth: WebAuth;
  audit: AuditSink;
  events: FleetEventBus;
  close(): Promise<void>;
}

const statusFor = (code: string): number => ({
  role_not_found: 404, resource_not_found: 404, unauthorized: 401, forbidden: 403, conflict: 409,
  idempotency_conflict: 409, stale_state: 409, rate_limited: 429,
  invalid_request: 400, capability_unavailable: 409, prerequisite_unavailable: 503,
}[code] ?? 500);

export async function buildWebServer(
  services: WebServices,
  boundary: { origin: string; host: string },
  options: { auth?: WebAuth; staticRoot?: string } = {},
): Promise<WebServer> {
  const app = Fastify({
    trustProxy: false, bodyLimit: 512 * 1024, logger: false,
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
    reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; ` +
      `connect-src 'self' ${auth.secureCookies ? 'wss' : 'ws'}://${auth.host}; object-src 'none'; base-uri 'none'; ` +
      `frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self'`);
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    try { auth.validateBoundary(request, false, !request.url.startsWith('/api/')); }
    catch (error) {
      if (request.url.startsWith('/api/')) throw error;
      const message = normalizeError(error).message;
      return reply.code(421).type('text/html').send(`<!doctype html><html><head><title>Fleet console address</title></head><body><main><h1>This fleet-console address is not configured</h1><p>${escapeHtml(message)}</p><p>For nginx or VPS access, configure an explicit public origin. The console does not guess proxy hosts.</p></main></body></html>`);
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const privateToolParseError = request.routeOptions.url === '/api/v1/roles/:id/ours/call'
      && error instanceof Error && 'code' in error
      && typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP_');
    const fleetError = normalizeError(privateToolParseError
      ? new FleetError('invalid_request', 'expected a valid JSON tool request') : error, request.id);
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
        'ours-fleet-events.v1', 'ours-fleet-conversation.v1',
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
    const query = request.query as { includeTemporary?: string };
    return { roles: await services.query.list(query.includeTemporary === 'true') };
  });

  const taskApi = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (error) {
      if (error instanceof TaskListError) {
        const code = error.code === 'list_not_found' ? 'resource_not_found'
          : ['duplicate_name', 'destination_required', 'same_destination', 'default_immutable'].includes(error.code)
            ? 'conflict' : 'invalid_request';
        throw new FleetError(code, error.message);
      }
      if (error instanceof TaskStateError && 'accepted' in error && error.accepted === false) return Promise.reject(Object.assign(new FleetError('invalid_request',error.message),{memberNotAccepted:true}));
      if (error instanceof TaskStateError) {
        throw new FleetError(error.message.startsWith('task not found:') ? 'resource_not_found' : 'conflict', error.message);
      }
      throw error;
    }
  };
  const requireTaskRooms = (): TaskRoomApplicationService => {
    if (!services.taskRooms) throw new FleetError('capability_unavailable', 'task operations are unavailable');
    return services.taskRooms;
  };

  app.get('/api/v1/task-lists', async request => {
    auth.authenticate(request);
    return { lists: requireTaskRooms().listTaskLists() };
  });
  app.post('/api/v1/task-lists', async (request, reply) => {
    auth.authenticate(request, true);
    const name = String((request.body as { name?: unknown })?.name ?? '');
    const list = await taskApi(() => requireTaskRooms().createTaskList({ actor: { kind: 'local_control', surface: 'web' }, name }));
    reply.code(201); return { list };
  });
  app.patch('/api/v1/task-lists/:name', async request => {
    auth.authenticate(request, true);
    const name = (request.params as { name: string }).name;
    const newName = String((request.body as { name?: unknown })?.name ?? '');
    return { list: await taskApi(() => requireTaskRooms().renameTaskList({ actor: { kind: 'local_control', surface: 'web' }, name, newName })) };
  });
  app.delete('/api/v1/task-lists/:name', async request => {
    auth.authenticate(request, true);
    const name = (request.params as { name: string }).name;
    const destination = (request.query as { destination?: string }).destination;
    return taskApi(() => requireTaskRooms().deleteTaskList({ actor: { kind: 'local_control', surface: 'web' }, name, destination }));
  });
  app.get('/api/v1/tasks', async request => {
    auth.authenticate(request);
    const query = request.query as {
      state?: string; list?: string; groupByList?: string; includeDeleting?: string;
    };
    const states = ['backlog', 'provisioning', 'active', 'review', 'done', 'cancelled', 'failed'];
    if (query.state && query.state !== 'all' && !states.includes(query.state))
      throw new FleetError('invalid_request', 'invalid task state filter');
    if (query.groupByList !== undefined && !['true', 'false'].includes(query.groupByList))
      throw new FleetError('invalid_request', 'groupByList must be true or false');
    if (query.includeDeleting !== undefined && !['true', 'false'].includes(query.includeDeleting))
      throw new FleetError('invalid_request', 'includeDeleting must be true or false');
    const state = query.state && query.state !== 'all' ? query.state as import('../rooms-tasks/types.js').TaskState : undefined;
    const filter = { ...(state ? { state } : {}), ...(query.list ? { list: query.list } : {}),
      ...(query.includeDeleting === 'true' ? { includeDeleting: true } : {}) };
    return taskApi(() => query.groupByList === 'true'
      ? { groups: requireTaskRooms().groupedTasks(filter) }
      : { tasks: requireTaskRooms().listTasks(filter) });
  });
  app.delete('/api/v1/tasks/:id', async (request, reply) => {
    auth.authenticate(request, true);
    const taskId = (request.params as { id: string }).id;
    const confirm = (request.query as { confirm?: string }).confirm;
    // Exact-ID-twice confirmation is validated before existence or idempotency.
    if (confirm !== taskId)
      throw new FleetError('invalid_request', 'confirm must exactly repeat the task id');
    const accepted = await taskApi(() => requireTaskRooms().requestTaskDeletion({
      actor: { kind: 'local_control', surface: 'web' }, taskId,
    }));
    if (accepted.status === 'already_absent')
      return { task_id: taskId, deleted: false, already_absent: true };
    // Cleanup runs in an external worker outside the request lifecycle; the
    // request waits boundedly and reports pending — never fabricated success.
    const outcome = await requireTaskRooms().launchTaskDeletionWorker({ taskId, waitMs: 5_000 });
    if (outcome.deleted) return { task_id: taskId, deleted: true };
    reply.code(202);
    return {
      task_id: taskId, accepted: true, deletion: 'pending',
      ...(outcome.error ? { error: outcome.error } : {}),
      recovery: `Repeat DELETE /api/v1/tasks/${taskId}?confirm=${taskId}.`,
    };
  });
  app.post('/api/v1/tasks', async (request, reply) => {
    auth.authenticate(request, true);
    const body = request.body as Record<string, unknown>;
    if (typeof body?.title !== 'string' || !body.title)
      throw new FleetError('invalid_request', 'title is required');
    const task = await taskApi(() => requireTaskRooms().createTask({
      actor: { kind: 'local_control', surface: 'web' }, title: body.title as string,
      brief: typeof body.brief === 'string' ? body.brief : undefined,
      template: typeof body.template === 'string' ? body.template : undefined,
      backlog: body.backlog === true, noRoom: body.noRoom === true,
      list: typeof body.list === 'string' ? body.list : undefined,
      idempotencyKey: typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key'] : undefined,
      origin: { type: 'web' },
    }));
    const provisioning = task.room_id
      ? await taskApi(() => requireTaskRooms().launchTaskProvisioning(task.task_id)) : undefined;
    reply.code(201); return { task, ...(provisioning ? { provisioning } : {}) };
  });
  app.patch('/api/v1/tasks/:id/list', async request => {
    auth.authenticate(request, true);
    const taskId = (request.params as { id: string }).id;
    const list = String((request.body as { list?: unknown })?.list ?? '');
    return { task: await taskApi(() => requireTaskRooms().moveTask({ actor: { kind: 'local_control', surface: 'web' }, taskId, list })) };
  });

  app.patch('/api/v1/tasks/:id/description', async request => {
    auth.authenticate(request, true);
    const body = request.body as { brief?: unknown; expectedBrief?: unknown };
    if (typeof body?.brief !== 'string' || typeof body.expectedBrief !== 'string' || body.brief.length > 100_000)
      throw new FleetError('invalid_request', 'brief and expectedBrief must be strings; brief maximum is 100000 characters');
    return { task: await taskApi(() => requireTaskRooms().editTaskDescription({
      actor: { kind: 'local_control', surface: 'web' }, taskId: (request.params as { id: string }).id,
      brief: body.brief as string, expectedBrief: body.expectedBrief as string,
    })) };
  });

  app.get('/api/v1/tasks/:id', async request => {
    auth.authenticate(request);
    return taskApi(() => requireTaskRooms().getTask((request.params as { id: string }).id));
  });
  app.post('/api/v1/tasks/:id/members', async (request, reply) => {
    auth.authenticate(request, true);
    const body=request.body as import('../rooms-tasks/add-member.js').AddMemberRequest;
    try {
      const result=await taskApi(()=>requireTaskRooms().addMember((request.params as {id:string}).id,body));
      reply.code(result.state==='running'?202:200);return result;
    } catch(error) {
      if(error instanceof Error && 'memberNotAccepted' in error) return reply.code(409).send({error:{code:'member_not_accepted',message:error.message},accepted:false});
      throw error;
    }
  });
  app.get('/api/v1/tasks/:id/member-additions/:requestId', async request => {
    auth.authenticate(request);
    const {id,requestId}=request.params as {id:string;requestId:string};
    return taskApi(()=>requireTaskRooms().memberAddition(id,requestId));
  });
  app.get('/api/v1/task-templates', async request => {
    auth.authenticate(request); return { templates: requireTaskRooms().listTemplates() };
  });
  for (const action of ['start', 'block', 'unblock', 'review', 'finish', 'cancel'] as const) {
    app.post(`/api/v1/tasks/:id/${action}`, async (request, reply) => {
      auth.authenticate(request, true);
      const taskId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { reason?: string; template?: string };
      const input = { actor: { kind: 'local_control' as const, surface: 'web' as const }, taskId };
      const api = requireTaskRooms();
      return taskApi(async () => {
        switch (action) {
          case 'start': {
            const task = await api.startTask({ ...input, template: body.template });
            const provisioning = await api.launchTaskProvisioning(taskId);
            if (provisioning.kind !== 'ready') reply.code(202);
            return { task, provisioning };
          }
          case 'block':
            if (typeof body.reason !== 'string' || !body.reason.trim()) throw new FleetError('invalid_request', 'reason is required');
            return { task: api.blockTask({ ...input, reason: body.reason }) };
          case 'unblock': return { task: api.unblockTask(input) };
          case 'review': return { task: api.reviewTask(input) };
          case 'finish':
          case 'cancel': {
            const plan = action === 'finish' ? await api.finishTask(input) : await api.cancelTask(input);
            const task = plan.settlementRequired ? await api.launchTaskSettlement(taskId) : plan.task;
            const pending = task.terminal_intent?.status === 'pending';
            if (pending) reply.code(202);
            return { task, pending };
          }
        }
      });
    });
  }

  app.get('/api/v1/configuration', async request => {
    auth.authenticate(request);
    if (!services.configuration)
      throw new FleetError('capability_unavailable', 'fleet configuration editing is unavailable');
    return services.configuration.read((request.query as { includeDefinitions?: string }).includeDefinitions === 'true');
  });

  app.post('/api/v1/configuration/preview', async request => {
    auth.authenticate(request, true);
    if (!services.configuration)
      throw new FleetError('capability_unavailable', 'fleet configuration editing is unavailable');
    const body = request.body as { revision?: unknown; model?: unknown };
    return services.configuration.preview(String(body?.revision ?? ''), body?.model);
  });

  app.post('/api/v1/configuration/save', async request => {
    const session = auth.authenticate(request, true);
    if (!services.configuration)
      throw new FleetError('capability_unavailable', 'fleet configuration editing is unavailable');
    const body = request.body as { revision?: unknown; model?: unknown };
    const result = await services.configuration.write(String(body?.revision ?? ''), body?.model);
    events.publish('configuration.changed', { revision: result.newRevision });
    await audit.record({
      requestId: request.id, browser: session.id, action: 'configuration.save', result: 'succeeded',
    });
    return result;
  });

  app.get('/api/v1/topology', async request => {
    auth.authenticate(request);
    if (!services.topology)
      throw new FleetError('capability_unavailable', 'fleet topology is unavailable');
    return services.topology();
  });

  const drafts = () => {
    if (!services.topologyDrafts)
      throw new FleetError('capability_unavailable', 'topology sketching is unavailable');
    return services.topologyDrafts;
  };

  app.get('/api/v1/topology/draft', async request => {
    auth.authenticate(request);
    return drafts().read();
  });

  app.put('/api/v1/topology/draft', async request => {
    const session = auth.authenticate(request, true);
    const body = request.body as { revision?: unknown; draft?: unknown };
    const result = await drafts().write(String(body?.revision ?? ''), body?.draft);
    events.publish('topology.draft.changed', { revision: result.revision });
    await audit.record({
      requestId: request.id, browser: session.id, action: 'topology.draft.save', result: 'succeeded',
    });
    return result;
  });

  const promotion = () => {
    if (!services.topologyPromote)
      throw new FleetError('capability_unavailable', 'adding sketches to the fleet is unavailable');
    return services.topologyPromote;
  };

  app.post('/api/v1/topology/promote/preview', async request => {
    auth.authenticate(request, true);
    return promotion().preview(promoteRequest(request.body));
  });

  // Writes configuration only. Nothing here starts a process: `Launch` is a
  // separate, explicit action, so adding to the fleet can never launch by surprise.
  app.post('/api/v1/topology/promote', async request => {
    const session = auth.authenticate(request, true);
    const result = await promotion().promote(promoteRequest(request.body));
    events.publish('configuration.changed', { revision: result.newRevision });
    events.publish('topology.draft.changed', { revision: result.draftRevision });
    await audit.record({
      requestId: request.id, browser: session.id, action: 'topology.promote', result: 'succeeded',
    });
    return result;
  });

  const oursTools = services.oursTools ?? new SupervisorOursTools();
  app.get<{Params:{id:string}}>('/api/v1/roles/:id/contacts',async request=>{
    auth.authenticate(request);const control=await services.session(request.params.id);
    if(!control.agentContacts)throw new FleetError('capability_unavailable','Supervisor contacts API is unavailable');
    return control.agentContacts();
  });
  app.get<{Params:{id:string};Querystring:{peer_cid:string;limit?:string;before_seq?:string}}>('/api/v1/roles/:id/messages',async request=>{
    auth.authenticate(request);const control=await services.session(request.params.id);
    if(!control.agentHistory)throw new FleetError('capability_unavailable','Supervisor history API is unavailable');
    return control.agentHistory({peer_cid:request.query.peer_cid,...(request.query.limit!==undefined?{limit:Number(request.query.limit)}:{}),...(request.query.before_seq!==undefined?{before_seq:Number(request.query.before_seq)}:{})});
  });

  app.get<{ Params: { id: string } }>('/api/v1/roles/:id/ours/tools', async request => {
    auth.authenticate(request);
    return oursTools.list(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: SupervisorToolRequest }>('/api/v1/roles/:id/ours/call', async request => {
    const session = auth.authenticate(request, true);
    const result = await oursTools.call(request.params.id, request.body);
    await audit.record({ requestId: request.id, browser: session.id,
      action: 'ours.call', result: result.result.isError === true ? 'tool_error' : 'succeeded' });
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/v1/roles/:id', async request => {
    auth.authenticate(request);
    const detail=await services.query.detail(request.params.id);
    return {...detail, chatIdle: detail.role.lifetime==='temporary' ? readChatIdle(agentDir(request.params.id,true)) ?? null : null};
  });

  app.get<{ Params: { id: string } }>('/api/v1/roles/:id/removal-preview', async request => {
    auth.authenticate(request);
    if (!ROLE_NAME_RE.test(request.params.id)) throw new FleetError('invalid_request', 'invalid role name');
    if (!services.removal) throw new FleetError('capability_unavailable', 'role removal is unavailable');
    return services.removal.previewWeb(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/v1/roles/:id/remove', async request => {
    const session = auth.authenticate(request, true);
    if (!ROLE_NAME_RE.test(request.params.id)) throw new FleetError('invalid_request', 'invalid role name');
    if (!services.removal) throw new FleetError('capability_unavailable', 'role removal is unavailable');
    const body = request.body as { confirmation?: string; confirmed?: boolean; coordinatorAcknowledged?: boolean };
    const result = await services.removal.removeWeb({ role: request.params.id, ...body });
    events.publish('role.removed', { role: result.role }, result.role);
    await audit.record({ requestId: request.id, browser: session.id, roleId: result.role, action: 'role.remove', result: 'succeeded' });
    return result;
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
    const body = request.body as { text?: unknown; commandId?: unknown; expectedSessionGeneration?: unknown };
    if (body?.expectedSessionGeneration !== undefined && (typeof body.expectedSessionGeneration !== 'string' || !body.expectedSessionGeneration.trim()))
      throw new FleetError('invalid_request', 'expectedSessionGeneration must be a nonempty string');
    const text = String(body?.text ?? '');
    const commandId = typeof body?.commandId === 'string' && body.commandId.trim()
      ? body.commandId : undefined;
    const control = await services.session(request.params.id);
    // The idempotent, durably admitted path — used whenever the caller sends a
    // command id and the role has a conversation ledger. The legacy path stays
    // for old clients.
    if (control.submitPromptV2) {
      const admittedCommandId = commandId ?? randomBytes(16).toString('hex');
      const receipt = await control.submitPromptV2({
        commandId: admittedCommandId, text, source: 'owner_admin_console',
        expectedSessionGeneration: body.expectedSessionGeneration as string | undefined,
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
    if (body.expectedSessionGeneration !== undefined)
      throw new FleetError('capability_unavailable', 'session-bound voice input is unavailable for this role');
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
      const session = auth.authenticate(request, true);
      const control = await services.session(request.params.id);
      const body = request.body as {
        optionId?: unknown; commandId?: unknown; sessionGeneration?: unknown;
      };
      const commandId = typeof body?.commandId === 'string' ? body.commandId.trim() : '';
      const sessionGeneration = typeof body?.sessionGeneration === 'string'
        ? body.sessionGeneration.trim() : '';
      const optionId = String(body?.optionId ?? '');
      if (control.respondPermissionV2) {
        if (!commandId || !sessionGeneration || !optionId)
          throw new FleetError('invalid_request',
            'commandId, sessionGeneration and optionId are required');
        const receipt = await control.respondPermissionV2({
          commandId, permissionId: request.params.permissionId, optionId, sessionGeneration,
        });
        await audit.record({
          requestId: request.id, browser: session.id, roleId: request.params.id,
          action: 'session.respond_permission', result: 'accepted',
        });
        return receipt;
      }
      if (!control.respondPermission)
        throw new FleetError('capability_unavailable', 'permission response is unavailable');
      return control.respondPermission({
        permissionId: request.params.permissionId,
        optionId,
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
    let receipt;
    try {
      receipt = await services.commands.execute({
        roleId: request.params.id, action: body.action!,
        actionId: body.actionId, confirmation: body.confirmation,
      });
    } catch (error) {
      // An existing receipt always wins: a conflicting/repeated action is not a
      // proof that the original operation was never admitted.
      if (typeof body.actionId === 'string' && !services.commands.get(body.actionId)) {
        const normalized = normalizeError(error);
        return reply.code(409).send({error:{code:'action_not_accepted',message:normalized.message},accepted:false});
      }
      throw error;
    }
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
      purpose?: 'events' | 'conversation'; roleId?: string;
    };
    if (!body?.purpose || !['events', 'conversation'].includes(body.purpose))
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

        // Backpressure discipline: a browser that cannot keep up
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

  const staticRoot = options.staticRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'web-app');
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
    `ofs_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${suffix}`,
    `ofs_device=${encodeURIComponent(device)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${suffix}`,
  ]);
}

function setSessionCookie(reply: { header(name: string, value: string | string[]): unknown }, session: string, secure = false): void {
  reply.header('Set-Cookie', `ofs_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
}

function clearAuthCookies(reply: { header(name: string, value: string | string[]): unknown }): void {
  reply.header('Set-Cookie', [
    'ofs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    'ofs_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
  ]);
}

function promoteRequest(body: unknown): { ids: string[]; configRevision: string; draftRevision?: string } {
  const value = (body ?? {}) as { ids?: unknown; configRevision?: unknown; draftRevision?: unknown };
  if (!Array.isArray(value.ids) || value.ids.some(id => typeof id !== 'string'))
    throw new FleetError('invalid_request', 'ids must be a list of sketch ids');
  return {
    ids: value.ids as string[],
    configRevision: String(value.configRevision ?? ''),
    draftRevision: typeof value.draftRevision === 'string' ? value.draftRevision : undefined,
  };
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
