import { WorkspaceDeviceStore, WorkspaceDeviceAuthError, WorkspaceRefreshReuseError } from './workspace-devices.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { FleetError } from '../application/errors.js';
import { TrustedDeviceStore, type TrustedDeviceIssue } from './device-store.js';
import { verifyPassword, type WebAccessConfig } from './access.js';

export interface BrowserSession {
  id: string;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  /** A workspace access credential, which cannot create further device links. */
  rotating?: boolean;
}

export interface AuthResult {
  session: BrowserSession;
  device: TrustedDeviceIssue;
}

interface Ticket {
  value: string;
  sessionId: string;
  purpose: 'events' | 'conversation';
  roleId?: string;
  expiresAt: number;
  /** When the credential that minted this ticket stops authorizing; a socket opened with it ends then. */
  authorizedUntil: number;
}

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class WebAuth {
  private _bootstrapSecret = token(32);
  private bootstrapExpiresAt = Date.now() + 5 * 60_000;
  private bootstrapUsed = false;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly sessionDevices = new Map<string, string>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly rates = new Map<string, { count: number; resetAt: number }>();
  private readonly transports = new Map<string, Set<() => void>>();
  private readonly renewals = new Map<string, { sessionId: string; deadline: number }>();
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(
    private _origin: string,
    private _host: string,
    private readonly now: () => number = Date.now,
    private readonly devices = new TrustedDeviceStore(),
    private readonly access: WebAccessConfig = { version: 1, mode: 'pairing' },
    private readonly workspaceDevices?: WorkspaceDeviceStore,
    readonly appOrigin = 'https://app.ours.network',
  ) {}
  get bootstrapSecret(): string { return this._bootstrapSecret; }
  get origin(): string { return this._origin; }
  get host(): string { return this._host; }
  get mode(): WebAccessConfig['mode'] { return this.access.mode; }
  get secureCookies(): boolean { return this._origin.startsWith('https:'); }
  private allowedOrigins = new Set<string>();
  private allowedHosts = new Set<string>();
  setBoundary(origin: string, host: string, aliases: { origins?: string[]; hosts?: string[] } = {}): void {
    this._origin = origin;
    this._host = host;
    this.allowedOrigins = new Set([origin, ...(aliases.origins ?? [])]);
    this.allowedHosts = new Set([host, ...(aliases.hosts ?? [])]);
  }
  /** Mint a replacement for an operator-triggered reauthentication ceremony. */
  mintBootstrap(): string {
    this._bootstrapSecret = token(32);
    this.bootstrapExpiresAt = this.now() + 5 * 60_000;
    this.bootstrapUsed = false;
    return this._bootstrapSecret;
  }

  /** The configured account origin, when this request comes from it and workspace devices are enabled. */
  accountOrigin(request: Pick<FastifyRequest, 'headers'>): string | undefined {
    return this.workspaceDevices && request.headers.origin === this.appOrigin ? this.appOrigin : undefined;
  }

  validateBoundary(request: FastifyRequest, requireOrigin: boolean): void {
    const host = request.headers.host;
    const hosts = this.allowedHosts.size ? this.allowedHosts : new Set([this.host]);
    const origins = this.allowedOrigins.size ? this.allowedOrigins : new Set([this.origin]);
    if (!host || !hosts.has(host)) throw new FleetError('forbidden',
      `This address is not configured for the fleet console. Open ${this.origin} or set --public-origin.`);
    if(this.workspaceDevices && String(request.headers.authorization ?? '').startsWith('Bearer ') && request.headers.origin && request.headers.origin!==this.appOrigin && !origins.has(request.headers.origin))throw new FleetError('forbidden','workspace request Origin does not match configured account origin');
    const workspaceRequest = Boolean(this.workspaceDevices) && request.headers.origin === this.appOrigin
      && (String(request.headers.authorization ?? '').startsWith('Bearer ') || (request.url ?? '').split('?')[0] === '/api/v1/devices/enroll' || request.method === 'OPTIONS');
    if (requireOrigin && !workspaceRequest && (!request.headers.origin || !origins.has(request.headers.origin)))
      throw new FleetError('forbidden', 'request Origin does not match the configured control-panel origin');
    const fetchSite = request.headers['sec-fetch-site'];
    if (!workspaceRequest && fetchSite && !['same-origin', 'none'].includes(String(fetchSite)))
      throw new FleetError('forbidden', 'cross-site request rejected');
  }

  exchange(request: FastifyRequest): AuthResult {
    this.validateBoundary(request, true);
    if (this.access.mode !== 'pairing')
      throw new FleetError('forbidden', 'one-time pairing is disabled for this access mode');
    this.consumeRate('bootstrap', 10, 60_000);
    const authorization = request.headers.authorization ?? '';
    const supplied = authorization.startsWith('Bootstrap ') ? authorization.slice(10) : '';
    if (this.bootstrapUsed || this.now() > this.bootstrapExpiresAt || !same(this._bootstrapSecret, supplied))
      throw new FleetError('unauthorized', 'bootstrap credential is invalid or expired');
    this.bootstrapUsed = true;
    const device = this.devices.issue();
    return { session: this.createSession(device.id), device };
  }

  login(request: FastifyRequest, password: string): AuthResult {
    this.validateBoundary(request, true);
    this.consumeRate('password-login', 10, 60_000);
    if (!verifyPassword(this.access, password))
      throw new FleetError('unauthorized', 'invalid control-panel password');
    const device = this.devices.issue();
    return { session: this.createSession(device.id), device };
  }

  anonymous(request: FastifyRequest): BrowserSession {
    this.validateBoundary(request, true);
    if (this.access.mode !== 'none') throw new FleetError('forbidden', 'unprotected access is disabled');
    return this.createSession('unprotected');
  }

  resume(request: FastifyRequest): AuthResult {
    this.validateBoundary(request, true);
    if (this.access.mode === 'none') throw new FleetError('forbidden', 'trusted devices are disabled');
    this.consumeRate('device-resume', 30, 60_000);
    const current = parseCookies(request.headers.cookie ?? '').ofs_device;
    const device = current ? this.devices.rotate(current) : undefined;
    if (!device) throw new FleetError('unauthorized', 'trusted device is missing, expired, or revoked');
    return { session: this.createSession(device.id), device };
  }

  authenticate(request: FastifyRequest, mutation = false): BrowserSession {
    const authorization = String(request.headers.authorization ?? '');
    if (authorization.startsWith('Bearer ')) {
      this.validateBoundary(request, mutation);
      if(!this.workspaceDevices)throw new WorkspaceDeviceAuthError('workspace bearer credential is invalid');
      const device = this.requireWorkspaceDevices().authenticate(authorization.slice(7));
      const id = `workspace:${device.id}`;
      // A transport opened with this credential ends when this credential does, whatever replaces it.
      const session = { id, csrf: '', createdAt: device.createdAt, lastSeenAt: this.now(), absoluteExpiresAt: device.authorizedUntil, rotating: device.rotating };
      this.sessions.set(id,session); this.sessionDevices.set(id,id);
      if (mutation) this.consumeRate(`mutation:${id}`,120,60000);
      return session;
    }
    this.validateBoundary(request, mutation);
    if (request.headers.origin === this.appOrigin && !this.allowedOrigins.has(this.appOrigin)) throw new FleetError('unauthorized','workspace bearer credential required');
    const id = parseCookies(request.headers.cookie ?? '').ofs_session;
    const session = id ? this.sessions.get(id) : undefined;
    const now = this.now();
    if (!session || !this.sessionValid(session)) {
      if (id) this.removeSession(id);
      throw new FleetError('unauthorized', 'browser session is missing or expired');
    }
    if (mutation) {
      const supplied = String(request.headers['x-csrf-token'] ?? '');
      if (!same(session.csrf, supplied)) throw new FleetError('forbidden', 'invalid CSRF token');
      this.consumeRate(`mutation:${session.id}`, 120, 60_000);
    }
    session.lastSeenAt = now;
    return session;
  }

  /** Check a transport's opening lease without refreshing cookie idle activity. */
  sessionValid(session: Pick<BrowserSession, 'id' | 'absoluteExpiresAt'>): boolean {
    const current = this.sessions.get(session.id), now = this.now();
    if (!current || now >= session.absoluteExpiresAt) return false;
    if (session.id.startsWith('workspace:')) return Boolean(this.workspaceDevices?.valid(session.id.slice(10)));
    return now < current.absoluteExpiresAt && now - current.lastSeenAt < 30 * 60_000;
  }

  logout(request: FastifyRequest): void {
    const session = this.authenticate(request, true);
    const deviceId = this.sessionDevices.get(session.id);
    if (session.id.startsWith('workspace:')) this.workspaceDevices?.revoke(session.id.slice(10));
    else if (deviceId && deviceId !== 'unprotected') this.devices.revokeId(deviceId);
    this.removeSession(session.id);
  }

  mintTicket(
    request: FastifyRequest, purpose: Ticket['purpose'], roleId?: string,
  ): { ticket: string; expiresAt: string } {
    const session = this.authenticate(request, true);
    const value = token();
    const ticket: Ticket = {
      value, sessionId: session.id, purpose, roleId,
      expiresAt: Math.min(this.now() + 30_000, session.absoluteExpiresAt),
      authorizedUntil: session.absoluteExpiresAt,
    };
    this.tickets.set(value, ticket);
    return { ticket: value, expiresAt: new Date(ticket.expiresAt).toISOString() };
  }

  consumeTicket(
    request: FastifyRequest, value: string, purpose: Ticket['purpose'], roleId?: string,
  ): BrowserSession {
    this.validateBoundary(request, true);
    const ticket = this.tickets.get(value);
    this.tickets.delete(value);
    if (!ticket || ticket.expiresAt < this.now() || ticket.purpose !== purpose
        || ticket.roleId !== roleId)
      throw new FleetError('unauthorized', 'WebSocket ticket is invalid, expired, or already used');
    const session = this.sessions.get(ticket.sessionId);
    if (!session || (session.id.startsWith('workspace:') && !this.workspaceDevices?.valid(session.id.slice(10)))) throw new FleetError('unauthorized', 'browser session expired');
    if (!session.id.startsWith('workspace:')) return session;
    // A workspace device's session entry is replaced by each newer credential; the ticket carries
    // the deadline of the credential that minted it, and nothing newer extends it.
    if (ticket.authorizedUntil <= this.now()) throw new FleetError('unauthorized', 'WebSocket ticket is invalid, expired, or already used');
    return { ...session, absoluteExpiresAt: ticket.authorizedUntil };
  }

  /**
   * `session` is what authenticate() or consumeTicket() returned for this connection. A workspace
   * device shares one session id across credentials, so the socket ends at that credential's own
   * deadline; revocation still ends everything the device has open.
   */
  bindSocket(session: Pick<BrowserSession, 'id' | 'absoluteExpiresAt'>, socket: WebSocket): void {
    const sessionId = session.id, deadline = sessionId.startsWith('workspace:') ? session.absoluteExpiresAt : undefined;
    let sockets = this.sockets.get(sessionId);
    if (!sockets) { sockets = new Set(); this.sockets.set(sessionId, sockets); }
    sockets.add(socket);
    const expiry = setInterval(() => { const current=this.sessions.get(sessionId); if (!current || (deadline !== undefined ? !this.workspaceDevices?.valid(sessionId.slice(10)) : current.absoluteExpiresAt<=this.now())) this.removeSession(sessionId); else if (deadline !== undefined && deadline<=this.now()) { clearInterval(expiry); socket.close(4401, 'authentication expired'); } },1000);
    expiry.unref();
    socket.once('close', () => { clearInterval(expiry); sockets?.delete(socket); });
  }

  /** Raw service streams share the same logout/revocation boundary as native sockets. */
  bindTransport(session: Pick<BrowserSession, 'id' | 'absoluteExpiresAt'>, close: () => void, renewal?: string): () => void {
    const sessionId = session.id, workspace = sessionId.startsWith('workspace:');
    let transports = this.transports.get(sessionId);
    if (!transports) { transports = new Set(); this.transports.set(sessionId, transports); }
    transports.add(close);
    const lease = { sessionId, deadline: session.absoluteExpiresAt };
    if (workspace && renewal) this.renewals.set(renewal, lease);
    const expiry = setInterval(() => { const current=this.sessions.get(sessionId); if (!current || (workspace ? !this.workspaceDevices?.valid(sessionId.slice(10)) : current.absoluteExpiresAt<=this.now())) this.removeSession(sessionId); else if (workspace && lease.deadline<=this.now()) { clearInterval(expiry); transports.delete(close); if (renewal) this.renewals.delete(renewal); close(); } },1000);
    expiry.unref();
    return () => { clearInterval(expiry); transports.delete(close); if (renewal) this.renewals.delete(renewal); if (!transports.size) this.transports.delete(sessionId); };
  }

  /**
   * Keep one open transport past the credential that opened it. Only its own reader knows the
   * name it was given, and it must authenticate with a newer credential of the same device while
   * the transport is still open: a copied credential cannot renew after it has expired.
   */
  renewTransport(request: FastifyRequest, renewal: string): { authorizedUntil: number } {
    const session = this.authenticate(request, true), lease = this.renewals.get(renewal);
    if (!lease || lease.sessionId !== session.id || lease.deadline <= this.now()) throw new FleetError('resource_not_found', 'transport is not open');
    lease.deadline = Math.max(lease.deadline, session.absoluteExpiresAt);
    return { authorizedUntil: lease.deadline };
  }

  clearSessions(): void {
    for (const transports of this.transports.values()) for (const close of transports) close();
    this.transports.clear();
    this.renewals.clear();
    for (const sockets of this.sockets.values())
      for (const socket of sockets) socket.close(4401, 'authentication revoked');
    this.sockets.clear();
    this.sessions.clear();
    this.sessionDevices.clear();
    this.tickets.clear();
  }

  revokeAllTrustedDevices(): number {
    const count = this.devices.revokeAll();
    for (const device of this.workspaceDevices?.list() ?? []) this.workspaceDevices?.revoke(device.id);
    this.clearSessions();
    return count;
  }

  workspaceIdentity() { return {workspaceId:this.requireWorkspaceDevices().workspaceId}; }
  workspaceEnrollment(issuer: string | null = null) { return this.requireWorkspaceDevices().mint(issuer?.startsWith('workspace:') ? issuer.slice(10) : null); }
  enrollWorkspace(request: FastifyRequest, input: { enrollment: string; workspaceId: string; label: string; credential?: unknown }) {
    if (input.credential === 2) {
      this.machineOnly(request); this.consumeRate('workspace-enrollment',30,60000);
      return this.requireWorkspaceDevices().enroll(input.enrollment,input.workspaceId,input.label,true);
    }
    this.validateBoundary(request,true); this.consumeRate('workspace-enrollment',30,60000);
    return this.requireWorkspaceDevices().enroll(input.enrollment,input.workspaceId,input.label);
  }
  /**
   * Refresh credentials are exchanged between the account server and this host only. A browser
   * always states where a request comes from, so a request that does is refused: no page can be
   * handed refresh material, whichever origin it runs on.
   */
  private machineOnly(request: FastifyRequest): void {
    this.validateBoundary(request,false);
    if (request.headers.origin !== undefined || Object.keys(request.headers).some(name => name.startsWith('sec-fetch-')) || request.headers.cookie !== undefined)
      throw new FleetError('forbidden','this endpoint does not accept browser requests');
  }
  refreshWorkspace(request: FastifyRequest, refreshToken: string) {
    this.machineOnly(request); this.consumeRate('workspace-refresh',240,60000);
    try { return this.requireWorkspaceDevices().refresh(refreshToken); }
    catch (error) {
      if (error instanceof WorkspaceRefreshReuseError) for (const id of error.revoked) this.removeSession(`workspace:${id}`);
      throw error;
    }
  }
  exchangeWorkspace(request: FastifyRequest) {
    this.machineOnly(request); this.consumeRate('workspace-enrollment',30,60000);
    const authorization = String(request.headers.authorization ?? '');
    const issued = this.requireWorkspaceDevices().exchange(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    // Whatever the fixed bearer had open ends with it.
    this.removeSession(`workspace:${issued.device.id}`);
    return issued;
  }
  revokeWorkspaceRefresh(request: FastifyRequest, refreshHash: string): boolean {
    this.machineOnly(request); this.consumeRate('workspace-revoke',120,60000);
    const id = this.requireWorkspaceDevices().revokeByRefreshHash(refreshHash);
    if (id) this.removeSession(`workspace:${id}`);
    return Boolean(id);
  }
  /** A link code for another browser, for the issuing link's own current refresh credential, which it rotates. */
  linkWorkspaceDevice(request: FastifyRequest, refreshToken: string) {
    this.machineOnly(request); this.consumeRate('workspace-link',10,60000);
    try { return this.requireWorkspaceDevices().link(refreshToken); }
    catch (error) {
      if (error instanceof WorkspaceRefreshReuseError) for (const id of error.revoked) this.removeSession(`workspace:${id}`);
      throw error;
    }
  }
  listWorkspaceDevices() { return this.requireWorkspaceDevices().list(); }
  revokeWorkspaceDevice(id: string): void {
    this.requireWorkspaceDevices().revoke(id);
    this.removeSession(`workspace:${id}`);
  }
  private requireWorkspaceDevices(): WorkspaceDeviceStore {
    if (!this.workspaceDevices) throw new FleetError('capability_unavailable','workspace device access is not configured');
    return this.workspaceDevices;
  }
  shutdown(): void { this.clearSessions(); this.workspaceDevices?.close(); }

  private createSession(deviceId: string): BrowserSession {
    const now = this.now();
    const session = {
      id: token(), csrf: token(), createdAt: now, lastSeenAt: now,
      absoluteExpiresAt: now + 8 * 60 * 60_000,
    };
    this.sessions.set(session.id, session);
    this.sessionDevices.set(session.id, deviceId);
    return session;
  }

  private removeSession(id: string): void {
    for (const close of this.transports.get(id) ?? []) close();
    this.transports.delete(id);
    for (const [renewal, lease] of this.renewals) if (lease.sessionId === id) this.renewals.delete(renewal);
    this.sessions.delete(id);
    this.sessionDevices.delete(id);
    for (const [ticket, value] of this.tickets)
      if (value.sessionId === id) this.tickets.delete(ticket);
    for (const socket of this.sockets.get(id) ?? []) socket.close(4401, 'authentication revoked');
    this.sockets.delete(id);
  }

  private consumeRate(key: string, limit: number, windowMs: number): void {
    const now = this.now();
    let rate = this.rates.get(key);
    if (!rate || rate.resetAt <= now) {
      rate = { count: 0, resetAt: now + windowMs };
      this.rates.set(key, rate);
    }
    rate.count++;
    if (rate.count > limit)
      throw new FleetError('rate_limited', 'request rate limit exceeded', {
        retryable: true, details: { retryAfterMs: rate.resetAt - now },
      });
  }
}

export function parseCookies(cookie: string): Record<string, string> {
  return Object.fromEntries(cookie.split(';').flatMap(part => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}
