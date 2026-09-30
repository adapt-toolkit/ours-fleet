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
}
export interface GatewayOptions {
  /** Backend mode is for a separate loopback machine-client listener; browsers are rejected. */
  auth: WebAuth | 'backend';
  fleetOrigin: string;
  services: ServiceTarget[];
}
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersFor(message: IncomingMessage): OutgoingHttpHeaders {
  const denied = new Set([...hopHeaders, ...(message.headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(message.headers).filter(([key]) => !denied.has(key)));
}

/** Raw transport deliberately runs outside Fastify's JSON parser and body limits. */
export function createPrefixGateway(options: GatewayOptions) {
  const auth = options.auth === 'backend' ? undefined : options.auth;
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
    return { service, page: !service && !fleet && !path.startsWith('/api/'), origin: service?.origin ?? options.fleetOrigin,
      path: service ? (service.upstreamPrefix || '')+(raw.slice(service.prefix.length) || '/').replace(/^\?/, '/?') : fleet ? raw.slice('/fleet'.length) : raw };
  };
  const prepare = (req: IncomingMessage, upgrade = false) => {
    const route = select(req);
    const request = { headers: req.headers, method: req.method, url: route.path } as FastifyRequest;
    if (!auth && (req.headers.origin || req.headers['sec-fetch-site'] || !route.service)) throw new Error('machine-client listener rejects browser requests');
    auth?.validateBoundary(request, upgrade, route.page);
    const session = route.service && auth ? auth.authenticate(request, !upgrade && !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) : undefined;
    const headers = headersFor(req);
    // Forward only the explicit browser context, never an attacker-selected forwarding chain.
    for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-') || key === 'forwarded') delete headers[key];
    if (route.service) {
      if (auth) for (const name of ['cookie', 'authorization', 'x-csrf-token', 'x-ours-api-token']) delete headers[name];
      if (route.service.stripBrowserContext) {
        for (const name of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) delete headers[name];
      }
      Object.assign(headers, route.service.headers);
      headers.host = new URL(route.origin).host;
    }
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return { ...route, headers, session };
  };
  const track = (req: IncomingMessage, session: { id: string } | undefined, close: () => void) => {
    if (!session) return () => {};
    const unbind = auth!.bindTransport(session.id, close);
    const timer = setInterval(() => { try { auth!.authenticate({ headers: req.headers } as FastifyRequest); } catch { close(); } }, 30_000);
    timer.unref();
    return () => { clearInterval(timer); unbind(); };
  };
  const server = createServer((req, res) => {
    let route: ReturnType<typeof prepare>;
    try { route = prepare(req); }
    catch (error) {
      const code = (error as { code?: string }).code;
      res.writeHead(code === 'unauthorized' ? 401 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: code ?? 'forbidden', message: (error as Error).message } }));
      return;
    }
    if (req.url === '/') { res.writeHead(302, { location: '/fleet' }); res.end(); return; }
    const upstream = (route.origin.startsWith('https:') ? httpsRequest : httpRequest)(route.origin, {
      method: req.method, path: route.path, headers: route.headers,
    }, response => {
      const headers = headersFor(response);
      if (route.service) delete headers['set-cookie'];
      res.writeHead(response.statusCode ?? 502, headers);
      response.on('error', () => res.destroy());
      response.on('aborted', () => res.destroy());
      response.on('close', () => { if (!response.complete) res.destroy(); });
      response.pipe(res);
      res.on('close', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'Service is unavailable' } }));
    });
    const untrack = track(req, route.session, () => { upstream.destroy(); res.destroy(); });
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
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(value => `${k}: ${value}\r\n`)).join('')}\r\n`);
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      const untrack = track(req, route.session, () => { peer.destroy(); socket.destroy(); });
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
