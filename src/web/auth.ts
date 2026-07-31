import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { FleetError } from '../application/errors.js';

export interface BrowserSession {
  id: string;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}

interface Ticket {
  value: string;
  sessionId: string;
  purpose: 'events' | 'terminal';
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
  private readonly tickets = new Map<string, Ticket>();
  private readonly rates = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private _origin: string,
    private _host: string,
    private readonly now: () => number = Date.now,
  ) {}
  get bootstrapSecret(): string { return this._bootstrapSecret; }
  get origin(): string { return this._origin; }
  get host(): string { return this._host; }
  setBoundary(origin: string, host: string): void {
    this._origin = origin;
    this._host = host;
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
    if (host !== this.host) throw new FleetError('forbidden', 'invalid Host header');
    if (requireOrigin && request.headers.origin !== this.origin)
      throw new FleetError('forbidden', 'invalid Origin header');
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(String(fetchSite)))
      throw new FleetError('forbidden', 'cross-site request rejected');
  }

  exchange(request: FastifyRequest): BrowserSession {
    this.validateBoundary(request, true);
    this.consumeRate('bootstrap', 10, 60_000);
    const authorization = request.headers.authorization ?? '';
    const supplied = authorization.startsWith('Bootstrap ') ? authorization.slice(10) : '';
    if (this.bootstrapUsed || this.now() > this.bootstrapExpiresAt || !same(this._bootstrapSecret, supplied))
      throw new FleetError('unauthorized', 'bootstrap credential is invalid or expired');
    this.bootstrapUsed = true;
    const now = this.now();
    const session: BrowserSession = {
      id: token(), csrf: token(), createdAt: now, lastSeenAt: now,
      absoluteExpiresAt: now + 8 * 60 * 60_000,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  authenticate(request: FastifyRequest, mutation = false): BrowserSession {
    this.validateBoundary(request, mutation);
    const id = parseCookies(request.headers.cookie ?? '').ofs_session;
    const session = id ? this.sessions.get(id) : undefined;
    const now = this.now();
    if (!session || now > session.absoluteExpiresAt || now - session.lastSeenAt > 30 * 60_000) {
      if (id) this.sessions.delete(id);
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
    this.sessions.delete(session.id);
    for (const [ticket, value] of this.tickets)
      if (value.sessionId === session.id) this.tickets.delete(ticket);
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

  revokeAll(): void {
    this.sessions.clear();
    this.tickets.clear();
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
