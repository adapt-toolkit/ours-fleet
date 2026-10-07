import { randomUUID } from 'node:crypto';
import { WorkspaceDeviceAuthError } from './workspace-devices.js';
import type { AuditSink } from './audit.js';
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { WebAuth } from './auth.js';

/** Each entry exposes one dedicated backend listener. Endpoint dispatch stays upstream. */
export interface ServiceTarget {
  prefix: string;
  origin: string;
  upstreamPrefix?: string;
  /** Server-side service credentials; never taken from browser headers. */
  headers?: Record<string, string>;
  /** Dedicated credential-authenticated services reject direct browser context. */
  stripBrowserContext?: boolean;
  /**
   * Service paths (below the prefix) where the account App may open a WebSocket with its device
   * credential. A browser cannot set Authorization on a WebSocket, so only there it is accepted
   * as a subprotocol.
   */
  deviceSocketPaths?: string[];
}
export interface GatewayOptions {
  /** Backend mode is for a separate loopback machine-client listener; browsers are rejected. */
  auth: WebAuth | 'backend';
  fleetOrigin: string;
  services: ServiceTarget[];
  /** Bounded unauthorized-response diagnostics: fixed service/action enums only. */
  audit?: Pick<AuditSink, 'record'>;
}
/** The App offers exactly these two subprotocols; only the marker is ever answered or forwarded. */
const DEVICE_SOCKET_PROTOCOL = 'ours.workspace.v1';
const DEVICE_SOCKET_BEARER = 'ours.workspace.bearer.';
/** The device credential a WebSocket offered as a subprotocol; undefined when it offered none of ours. */
function deviceSocketCredential(req: IncomingMessage): string | undefined {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!offered.some(value => value === DEVICE_SOCKET_PROTOCOL || value.startsWith(DEVICE_SOCKET_BEARER))) return undefined;
  const credentials = offered.filter(value => value.startsWith(DEVICE_SOCKET_BEARER));
  const token = credentials[0]?.slice(DEVICE_SOCKET_BEARER.length) ?? '';
  if (offered.length !== 2 || credentials.length !== 1 || !offered.includes(DEVICE_SOCKET_PROTOCOL) || !/^[A-Za-z0-9_.-]{16,256}$/.test(token))
    throw new Error('invalid workspace socket subprotocol');
  return token;
}
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersFor(message: IncomingMessage): OutgoingHttpHeaders {
  const denied = new Set([...hopHeaders, ...(message.headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(message.headers).filter(([key]) => !denied.has(key)));
}

/** Raw transport deliberately runs outside Fastify's JSON parser and body limits. */
export function createPrefixGateway(options: GatewayOptions) {
  const auth = options.auth === 'backend' ? undefined : options.auth;
  let auditWindow = Date.now(), auditCount = 0;
  const rejected = (requestId: string, prefix: string, result: 'device_rejected' | 'gateway_rejected' | 'upstream_401') => {
    if (Date.now() - auditWindow >= 60_000) { auditWindow = Date.now(); auditCount = 0; }
    if (auditCount++ >= 60) return;
    void options.audit?.record({ requestId, action: 'gateway' + prefix.replaceAll('/', '.'), result, errorCode: 'unauthorized' }).catch(() => {});
  };
  const services = options.services.map(target => {
    if (!/^\/[a-z][a-z0-9-]*$/.test(target.prefix) || target.prefix === '/fleet') throw new Error('invalid service prefix');
    const origin = new URL(target.origin);
    if(target.upstreamPrefix && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(target.upstreamPrefix))throw new Error('invalid upstream service prefix');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('service target must be an HTTP origin');
    return { ...target, origin: origin.origin };
  });
  if (new Set(services.map(x => x.prefix)).size !== services.length) throw new Error('duplicate service prefix');
  const select = (req: IncomingMessage) => {
    const raw = req.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//')) throw new Error('invalid request target');
    const path = raw.split('?')[0];
    const service = services.find(x => path === x.prefix || path.startsWith(x.prefix + '/'));
    const fleet = path === '/fleet/api' || path.startsWith('/fleet/api/');
    return { service, origin: service?.origin ?? options.fleetOrigin,
      path: service ? (service.upstreamPrefix || '')+(raw.slice(service.prefix.length) || '/').replace(/^\?/, '/?') : fleet ? raw.slice('/fleet'.length) : raw };
  };
  const prepare = (req: IncomingMessage, upgrade = false) => {
    const route = select(req);
    // The device credential of an App WebSocket: accepted only on an upgrade, from the exact
    // account origin, on a path the service declares, and never beside another credential.
    const socketCredential = upgrade && auth ? deviceSocketCredential(req) : undefined;
    if (socketCredential !== undefined) {
      const path = route.service ? (req.url ?? '/').split('?')[0].slice(route.service.prefix.length) : undefined;
      if (!route.service?.deviceSocketPaths?.includes(path ?? '') || req.headers.authorization !== undefined || req.headers.cookie !== undefined
          || !req.headers.origin || auth!.accountOrigin(req as unknown as FastifyRequest) !== req.headers.origin)
        throw new Error('workspace socket credential is not accepted here');
    }
    // Authentication sees the credential as the bearer it is; the request's own headers are untouched.
    const authHeaders = socketCredential !== undefined ? { ...req.headers, authorization: `Bearer ${socketCredential}` } : req.headers;
    const request = { headers: authHeaders, method: req.method, url: route.path } as FastifyRequest;
    if (!auth && (req.headers.origin || req.headers['sec-fetch-site'] || !route.service)) throw new Error('machine-client listener rejects browser requests');
    auth?.validateBoundary(request, upgrade);
    const session = route.service && auth ? auth.authenticate(request, !upgrade && !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) : undefined;
    const headers = headersFor(req);
    // Forward only the explicit browser context, never an attacker-selected forwarding chain.
    for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-') || key === 'forwarded') delete headers[key];
    delete headers['x-ours-workspace-auth'];
    delete headers['x-ours-request-id'];
    if (route.service) {
      if (auth) for (const name of ['cookie', 'authorization', 'x-csrf-token', 'x-ours-api-token']) delete headers[name];
      // The server gateway lets this header choose a producer credential; only machine producers send it directly there.
      delete headers['x-ours-notifications-producer'];
      if (route.service.stripBrowserContext) {
        for (const name of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) delete headers[name];
      }
      Object.assign(headers, route.service.headers);
      headers.host = new URL(route.origin).host;
    }
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    // The credential subprotocol ends here: the service is not offered it, on any request.
    if (socketCredential !== undefined || String(headers['sec-websocket-protocol'] ?? '').includes(DEVICE_SOCKET_BEARER)) delete headers['sec-websocket-protocol'];
    return { ...route, headers, session, authHeaders, deviceSocket: socketCredential !== undefined };
  };
  const track = (authHeaders: IncomingMessage['headers'], session: { id: string } | undefined, close: () => void) => {
    if (!session) return () => {};
    const unbind = auth!.bindTransport(session.id, close);
    const timer = setInterval(() => { try { auth!.authenticate({ headers: authHeaders } as FastifyRequest); } catch { close(); } }, 30_000);
    timer.unref();
    return () => { clearInterval(timer); unbind(); };
  };
  // The account App calls workspace services directly from its own origin with a device
  // credential. Only that exact configured origin is answered; the reply grants nothing by
  // itself, every request is still authenticated below.
  const accountCors = (req: IncomingMessage): Record<string, string> => {
    const origin = auth?.accountOrigin(req as unknown as FastifyRequest);
    return origin ? { 'access-control-allow-origin': origin, vary: 'Origin',
      'access-control-expose-headers': 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range, Content-Type, ETag, X-Ours-Workspace-Auth, X-Ours-Request-Id' } : {};
  };
  const server = createServer((req, res) => {
    const cors = accountCors(req);
    const requestId = randomUUID();
    let route: ReturnType<typeof prepare>;
    try {
      if (req.method === 'OPTIONS' && cors.vary && req.headers['access-control-request-method'] && select(req).service) {
        auth!.validateBoundary({ headers: req.headers, method: req.method, url: req.url } as FastifyRequest, false);
        res.writeHead(204, { ...cors, 'cache-control': 'no-store', 'access-control-max-age': '600',
          'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key, If-None-Match, Range, X-CSRF-Token, X-Ours-Messenger-CSRF, X-Voice-Duration' });
        res.end(); return;
      }
      route = prepare(req);
    }
    catch (error) {
      const code = (error as { code?: string }).code;
      const deviceRejected = error instanceof WorkspaceDeviceAuthError;
      if (code === 'unauthorized') rejected(requestId, '/auth', deviceRejected ? 'device_rejected' : 'gateway_rejected');
      res.writeHead(code === 'unauthorized' ? 401 : 403, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store',
        ...(code === 'unauthorized' ? { 'x-ours-request-id': requestId } : {}),
        ...(deviceRejected ? { 'x-ours-workspace-auth': 'rejected' } : {}) });
      res.end(JSON.stringify({ error: { code: code ?? 'forbidden', message: (error as Error).message } }));
      return;
    }
    const upstream = (route.origin.startsWith('https:') ? httpsRequest : httpRequest)(route.origin, {
      method: req.method, path: route.path, headers: route.headers,
    }, response => {
      const headers = headersFor(response);
      if (route.service) {
        delete headers['set-cookie'];
        // Only Fleet may assert device rejection; never trust a service's marker or correlation id.
        delete headers['x-ours-workspace-auth'];
        delete headers['x-ours-request-id'];
        if (response.statusCode === 401) {
          headers['x-ours-request-id'] = requestId;
          headers['x-ours-workspace-auth'] = 'service';
          rejected(requestId, route.service.prefix, 'upstream_401');
        }
        for (const key of Object.keys(headers)) if (key.startsWith('access-control-')) delete headers[key];
        Object.assign(headers, cors);
      }
      res.writeHead(response.statusCode ?? 502, headers);
      // Streaming headers, including exact-origin CORS and upstream errors,
      // must reach the client before the first event or body byte arrives.
      res.flushHeaders();
      response.on('error', () => res.destroy());
      response.on('aborted', () => res.destroy());
      response.on('close', () => { if (!response.complete) res.destroy(); });
      response.pipe(res);
      res.on('close', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { ...(route.service ? cors : {}), 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'Service is unavailable' } }));
    });
    const untrack = track(route.authHeaders, route.session, () => { upstream.destroy(); res.destroy(); });
    res.on('close', untrack);
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    let route: ReturnType<typeof prepare>;
    try { route = prepare(req, true); }
    catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const upstream = (route.origin.startsWith('https:') ? httpsRequest : httpRequest)(route.origin, {
      method: req.method, path: route.path, headers: route.headers,
    });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      const headers = headersFor(response);
      headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
      delete headers['set-cookie'];
      // A browser that offered subprotocols needs one answered; only the marker, never the credential.
      if (route.deviceSocket) headers['sec-websocket-protocol'] = DEVICE_SOCKET_PROTOCOL;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(value => `${k}: ${value}\r\n`)).join('')}\r\n`);
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      const untrack = track(route.authHeaders, route.session, () => { peer.destroy(); socket.destroy(); });
      socket.on('close', untrack);
      peer.pipe(socket); socket.pipe(peer);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
    });
    upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`); response.destroy(); });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return { server, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
