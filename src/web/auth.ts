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
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(
    private _origin: string,
    private _host: string,
    private readonly now: () => number = Date.now,
    private readonly devices = new TrustedDeviceStore(),
    private readonly access: WebAccessConfig = { version: 1, mode: 'pairing' },
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

  validateBoundary(request: FastifyRequest, requireOrigin: boolean): void {
    const host = request.headers.host;
    const hosts = this.allowedHosts.size ? this.allowedHosts : new Set([this.host]);
    const origins = this.allowedOrigins.size ? this.allowedOrigins : new Set([this.origin]);
    if (!host || !hosts.has(host)) throw new FleetError('forbidden',
      `This address is not configured for the fleet console. Open ${this.origin} or set --public-origin.`);
    if (requireOrigin && (!request.headers.origin || !origins.has(request.headers.origin)))
      throw new FleetError('forbidden', 'request Origin does not match the configured control-panel origin');
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(String(fetchSite)))
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
    this.validateBoundary(request, mutation);
    const id = parseCookies(request.headers.cookie ?? '').ofs_session;
    const session = id ? this.sessions.get(id) : undefined;
    const now = this.now();
    if (!session || now > session.absoluteExpiresAt || now - session.lastSeenAt > 30 * 60_000) {
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

  logout(request: FastifyRequest): void {
    const session = this.authenticate(request, true);
    const deviceId = this.sessionDevices.get(session.id);
    if (deviceId && deviceId !== 'unprotected') this.devices.revokeId(deviceId);
    this.removeSession(session.id);
  }

  mintTicket(
    request: FastifyRequest, purpose: Ticket['purpose'], roleId?: string,
  ): { ticket: string; expiresAt: string } {
    const session = this.authenticate(request, true);
    const value = token();
    const ticket: Ticket = {
      value, sessionId: session.id, purpose, roleId,
      expiresAt: this.now() + 30_000,
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
    if (!session) throw new FleetError('unauthorized', 'browser session expired');
    return session;
  }

  bindSocket(sessionId: string, socket: WebSocket): void {
    let sockets = this.sockets.get(sessionId);
    if (!sockets) { sockets = new Set(); this.sockets.set(sessionId, sockets); }
    sockets.add(socket);
    socket.once('close', () => sockets?.delete(socket));
  }

  clearSessions(): void {
    for (const sockets of this.sockets.values())
      for (const socket of sockets) socket.close(4401, 'authentication revoked');
    this.sockets.clear();
    this.sessions.clear();
    this.sessionDevices.clear();
    this.tickets.clear();
  }

  revokeAllTrustedDevices(): number {
    const count = this.devices.revokeAll();
    this.clearSessions();
    return count;
  }

  shutdown(): void { this.clearSessions(); }

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
