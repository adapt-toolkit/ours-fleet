import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { canonicalCid } from '../config.js';

/** A send whose (dedupe-scoped) digest was already recorded: it must not repeat. */
export class DuplicateSendError extends Error {}

interface ChannelState { version: 1; handled: string[] }

/** Durable bounded dedupe containing wire IDs only — never message or reply plaintext. */
export class OwnerChannelState {
  private handled: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly path: string, private readonly limit = 5_000) {
    try {
      if (!existsSync(path)) return;
      const state = JSON.parse(readFileSync(path, 'utf8')) as Partial<ChannelState>;
      if (state.version !== 1 || !Array.isArray(state.handled)) return;
      this.handled = state.handled.filter(id => typeof id === 'string').slice(-limit);
      for (const id of this.handled) this.seen.add(id);
    } catch { /* a corrupt cache safely degrades to at-least-once delivery */ }
  }

  has(wireId: string): boolean { return this.seen.has(wireId); }

  remember(wireId: string): void {
    if (this.seen.has(wireId)) return;
    this.handled.push(wireId);
    this.seen.add(wireId);
    while (this.handled.length > this.limit) this.seen.delete(this.handled.shift()!);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, handled: this.handled }) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export type OwnerConversationRouteBasis = 'last-inbound' | 'sole-owner';

interface OwnerConversationRecord {
  contact: string;
  lastInboundAt: number;
  lastInboundWireId: string;
}

interface OwnerProactiveSend {
  id: string;
  contact: string;
  digest: string;
  at: number;
  status: 'sending' | 'delivered' | 'uncertain';
}

interface OwnerConversationFile {
  version: 1;
  conversations: OwnerConversationRecord[];
  sends: OwnerProactiveSend[];
}

const CONVERSATION_LIMIT = 64;
const PROACTIVE_SEND_LIMIT = 256;
const PROACTIVE_MIN_INTERVAL_MS = 30_000;
const HEX_64_LOWER = /^[a-f0-9]{64}$/;
const CID = /^[A-Fa-f0-9]{64}$/;

/**
 * Durable destination history for unscoped owner messages. It stores only
 * authenticated CIDs, wire IDs, timestamps and content digests; never bodies,
 * filenames or display names. A pre-send marker prevents blind replay after a
 * crash or transport ambiguity.
 */
export class OwnerConversationState {
  private conversations: OwnerConversationRecord[] = [];
  private sends: OwnerProactiveSend[] = [];
  private corruptReason?: string;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerConversationFile>;
      if (raw.version !== 1 || !Array.isArray(raw.conversations) || !Array.isArray(raw.sends)
          || raw.conversations.length > CONVERSATION_LIMIT
          || raw.sends.length > PROACTIVE_SEND_LIMIT
          || !raw.conversations.every(record => this.validConversation(record))
          || !raw.sends.every(send => this.validSend(send)))
        throw new Error('invalid or unbounded conversation state');
      if (new Set(raw.conversations.map(record => record.contact)).size !== raw.conversations.length
          || new Set(raw.sends.map(send => send.id)).size !== raw.sends.length)
        throw new Error('duplicate conversation state entry');
      this.conversations = raw.conversations.map(record => ({ ...record }));
      this.sends = raw.sends.map(send => ({ ...send }));
      let recovered = false;
      for (const send of this.sends) {
        if (send.status === 'sending') { send.status = 'uncertain'; recovered = true; }
      }
      chmodSync(path, 0o600);
      if (recovered) this.persist();
    } catch {
      this.corruptReason = 'invalid persisted owner conversation state';
      this.conversations = [];
      this.sends = [];
      try { chmodSync(path, 0o600); } catch { /* remain fail-closed */ }
    }
  }

  integrity(): { ok: boolean; error?: string } {
    return this.corruptReason ? { ok: false, error: this.corruptReason } : { ok: true };
  }

  recordInbound(contact: string, wireId: string, now = Date.now()): void {
    this.assertHealthy();
    if (!CID.test(contact) || !wireId || wireId.length > 1_024)
      throw new Error('owner conversation route is invalid');
    const current = this.conversations.find(record => record.contact === contact);
    const latest = this.conversations.reduce(
      (maximum, record) => Math.max(maximum, record.lastInboundAt), 0);
    // Date.now() can repeat (or move backwards). Preserve the actual accepted
    // inbound order so two devices messaging in the same millisecond still
    // produce one deterministic "last conversation" route.
    const acceptedAt = Math.max(now, latest + 1);
    this.mutate(() => {
      if (current) {
        current.lastInboundAt = acceptedAt;
        current.lastInboundWireId = wireId;
      } else {
        if (this.conversations.length >= CONVERSATION_LIMIT)
          throw new Error(`owner conversations are limited to ${CONVERSATION_LIMIT}`);
        this.conversations.push({ contact, lastInboundAt: acceptedAt, lastInboundWireId: wireId });
      }
    });
  }

  remove(contact: string): void {
    this.assertHealthy();
    const canonical = canonicalCid(contact);
    if (!this.conversations.some(record => canonicalCid(record.contact) === canonical)) return;
    this.mutate(() => {
      this.conversations = this.conversations.filter(
        record => canonicalCid(record.contact) !== canonical);
    });
  }

  route(effective: Set<string>): {
    contact: string; basis: OwnerConversationRouteBasis;
  } {
    this.assertHealthy();
    // Membership is decided canonically (hex case is not identity); the
    // returned contact keeps its stored form, which the daemon can route.
    const canonical = new Set([...effective].map(canonicalCid));
    const candidates = this.conversations
      .filter(record => canonical.has(canonicalCid(record.contact)))
      .sort((a, b) => b.lastInboundAt - a.lastInboundAt);
    if (candidates.length) {
      if (candidates[1]?.lastInboundAt === candidates[0].lastInboundAt)
        throw new Error('proactive owner route is ambiguous');
      return { contact: candidates[0].contact, basis: 'last-inbound' };
    }
    if (canonical.size === 1)
      return { contact: [...effective][0], basis: 'sole-owner' };
    throw new Error('no authenticated owner conversation route is available yet');
  }

  beginSend(
    contact: string, digest: string, now = Date.now(), minIntervalMs = PROACTIVE_MIN_INTERVAL_MS,
    dedupe: 'contact' | 'all' = 'contact',
  ): OwnerProactiveSend {
    this.assertHealthy();
    if (!CID.test(contact) || !HEX_64_LOWER.test(digest))
      throw new Error('proactive owner send metadata is invalid');
    const canonical = canonicalCid(contact);
    const recent = this.sends.filter(
      send => canonicalCid(send.contact) === canonical).slice(-128);
    // 'all' scope serves wire-keyed idempotency: a crash replay must not
    // deliver the same wire to a second owner after the route moved.
    const scope = dedupe === 'all' ? this.sends.slice(-128) : recent;
    if (scope.some(send => send.digest === digest))
      throw new DuplicateSendError('duplicate proactive owner message refused');
    const last = recent.at(-1);
    if (last && now - last.at < minIntervalMs)
      throw new Error(`proactive owner messages are rate-limited to one every ${minIntervalMs}ms`);
    const send: OwnerProactiveSend = {
      id: randomBytes(32).toString('hex'), contact, digest, at: now, status: 'sending',
    };
    this.mutate(() => {
      this.sends.push(send);
      this.sends = this.sends.slice(-PROACTIVE_SEND_LIMIT);
    });
    return { ...send };
  }

  finishSend(id: string, status: 'delivered' | 'uncertain'): void {
    this.assertHealthy();
    const send = this.sends.find(item => item.id === id);
    if (!send || send.status !== 'sending')
      throw new Error('proactive owner send state changed unexpectedly');
    this.mutate(() => { send.status = status; });
  }

  private mutate(change: () => void): void {
    const snapshot = JSON.stringify({ conversations: this.conversations, sends: this.sends });
    change();
    try { this.persist(); }
    catch (error) {
      const old = JSON.parse(snapshot) as {
        conversations: OwnerConversationRecord[]; sends: OwnerProactiveSend[];
      };
      this.conversations = old.conversations;
      this.sends = old.sends;
      throw error;
    }
  }

  private persist(): void {
    replaceFileAtomically(this.path, JSON.stringify({
      version: 1, conversations: this.conversations, sends: this.sends,
    } satisfies OwnerConversationFile) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }

  private assertHealthy(): void {
    if (this.corruptReason)
      throw new Error(`owner conversation state is corrupt; refusing operation: ${this.corruptReason}`);
  }

  private validConversation(value: unknown): value is OwnerConversationRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as OwnerConversationRecord;
    return CID.test(record.contact) && Number.isSafeInteger(record.lastInboundAt)
      && record.lastInboundAt >= 0 && typeof record.lastInboundWireId === 'string'
      && record.lastInboundWireId.length > 0 && record.lastInboundWireId.length <= 1_024;
  }

  private validSend(value: unknown): value is OwnerProactiveSend {
    if (!value || typeof value !== 'object') return false;
    const send = value as OwnerProactiveSend;
    return HEX_64_LOWER.test(send.id) && CID.test(send.contact) && HEX_64_LOWER.test(send.digest)
      && Number.isSafeInteger(send.at) && send.at >= 0
      && ['sending', 'delivered', 'uncertain'].includes(send.status);
  }
}

export type OwnerSource = 'baseline' | 'dynamic';
export interface OwnerEntry { cid: string; source: OwnerSource; effective: boolean }
interface OwnerAuditEntry { at: string; action: 'authorize' | 'revoke'; cid: string }
interface AuthorizationFile {
  version: 1;
  added: string[];
  revoked: string[];
  audit: OwnerAuditEntry[];
}

const MAX_OVERLAY_CIDS = 1_000;
const MAX_AUDIT_ENTRIES = 500;

/**
 * Configured owners remain the declared baseline. This durable overlay adds
 * owners or revokes either source without rewriting fleet.yaml. A corrupt
 * overlay authorizes nobody and refuses mutation until the operator repairs or
 * removes the bad file; silently falling back could resurrect a revoked owner.
 */
export class OwnerAuthorizationState {
  private readonly baseline: Set<string>;
  private added = new Set<string>();
  private revoked = new Set<string>();
  private audit: OwnerAuditEntry[] = [];
  private corruptReason?: string;

  constructor(private readonly path: string, baseline: string[]) {
    this.baseline = new Set(baseline);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AuthorizationFile>;
      if (raw.version !== 1 || !Array.isArray(raw.added) || !Array.isArray(raw.revoked)
          || !Array.isArray(raw.audit)) throw new Error('unsupported or incomplete state');
      const validCid = (cid: unknown): cid is string =>
        typeof cid === 'string' && /^[A-Fa-f0-9]{64}$/.test(cid);
      if (!raw.added.every(validCid) || !raw.revoked.every(validCid)
          || raw.added.length + raw.revoked.length > MAX_OVERLAY_CIDS
          || raw.audit.length > MAX_AUDIT_ENTRIES
          || raw.audit.some(entry => !entry || typeof entry !== 'object'
            || !validCid((entry as OwnerAuditEntry).cid)
            || !['authorize', 'revoke'].includes((entry as OwnerAuditEntry).action)
            || typeof (entry as OwnerAuditEntry).at !== 'string'))
        throw new Error('invalid or unbounded state');
      this.added = new Set(raw.added);
      this.revoked = new Set(raw.revoked);
      this.audit = raw.audit as OwnerAuditEntry[];
      if (new Set(raw.added.map(canonicalCid)).size !== raw.added.length
          || new Set(raw.revoked.map(canonicalCid)).size !== raw.revoked.length)
        throw new Error('duplicate overlay CID');
      const revokedCanonical = new Set([...this.revoked].map(canonicalCid));
      if ([...this.added].some(cid => revokedCanonical.has(canonicalCid(cid))))
        throw new Error('CID appears in both added and revoked overlays');
      chmodSync(path, 0o600);
    } catch {
      this.corruptReason = 'invalid persisted authorization overlay';
      this.added.clear();
      this.revoked.clear();
      this.audit = [];
      try { chmodSync(path, 0o600); } catch { /* still fail closed */ }
    }
  }

  integrity(): { ok: boolean; error?: string } {
    return this.corruptReason ? { ok: false, error: this.corruptReason } : { ok: true };
  }

  effective(): Set<string> {
    if (this.corruptReason) return new Set();
    // Stored forms stay verbatim (the daemon routes them case-exactly); the
    // revocation check is canonical so a casing change can never resurrect a
    // revoked owner.
    const revoked = new Set([...this.revoked].map(canonicalCid));
    const effective = new Set([...this.baseline, ...this.added]);
    for (const cid of [...effective])
      if (revoked.has(canonicalCid(cid))) effective.delete(cid);
    return effective;
  }

  entries(): OwnerEntry[] {
    const effective = new Set([...this.effective()].map(canonicalCid));
    const seen = new Set<string>();
    const all: string[] = [];
    for (const cid of [...this.baseline, ...this.added, ...this.revoked]) {
      if (seen.has(canonicalCid(cid))) continue;
      seen.add(canonicalCid(cid));
      all.push(cid);
    }
    return all.sort().map(cid => ({
      cid,
      source: this.inBaseline(cid) ? 'baseline' : 'dynamic',
      effective: effective.has(canonicalCid(cid)),
    }));
  }

  authorize(cid: string): OwnerEntry {
    this.assertHealthy();
    if (this.hasCanonical(this.effective(), cid))
      throw new Error(`owner '${cid}' is already authorized`);
    const rollback = this.snapshot();
    if (this.inBaseline(cid)) this.deleteCanonical(this.revoked, cid);
    else {
      if (this.added.size + this.revoked.size >= MAX_OVERLAY_CIDS)
        throw new Error(`owner authorization overlay is limited to ${MAX_OVERLAY_CIDS} CIDs`);
      this.added.add(cid);
      this.deleteCanonical(this.revoked, cid);
    }
    this.record('authorize', cid);
    try { this.persist(); } catch (error) { this.restore(rollback); throw error; }
    return { cid, source: this.inBaseline(cid) ? 'baseline' : 'dynamic', effective: true };
  }

  revoke(cid: string): OwnerEntry {
    this.assertHealthy();
    const effective = this.effective();
    if (!this.hasCanonical(effective, cid)) throw new Error(`owner '${cid}' is not authorized`);
    if (new Set([...effective].map(canonicalCid)).size === 1)
      throw new Error('refusing to revoke the last effective owner');
    const rollback = this.snapshot();
    if (this.inBaseline(cid)) this.revoked.add(cid);
    else this.deleteCanonical(this.added, cid);
    this.record('revoke', cid);
    try { this.persist(); } catch (error) { this.restore(rollback); throw error; }
    return { cid, source: this.inBaseline(cid) ? 'baseline' : 'dynamic', effective: false };
  }

  private inBaseline(cid: string): boolean {
    return this.hasCanonical(this.baseline, cid);
  }

  private hasCanonical(set: Set<string>, cid: string): boolean {
    const canonical = canonicalCid(cid);
    for (const member of set) if (canonicalCid(member) === canonical) return true;
    return false;
  }

  private deleteCanonical(set: Set<string>, cid: string): void {
    const canonical = canonicalCid(cid);
    for (const member of [...set]) if (canonicalCid(member) === canonical) set.delete(member);
  }

  private assertHealthy(): void {
    if (this.corruptReason)
      throw new Error(`owner authorization state is corrupt; refusing mutation: ${this.corruptReason}`);
  }

  private record(action: OwnerAuditEntry['action'], cid: string): void {
    this.audit.push({ at: new Date().toISOString(), action, cid });
    this.audit = this.audit.slice(-MAX_AUDIT_ENTRIES);
  }

  private snapshot(): { added: Set<string>; revoked: Set<string>; audit: OwnerAuditEntry[] } {
    return { added: new Set(this.added), revoked: new Set(this.revoked), audit: [...this.audit] };
  }

  private restore(snapshot: { added: Set<string>; revoked: Set<string>; audit: OwnerAuditEntry[] }): void {
    this.added = snapshot.added;
    this.revoked = snapshot.revoked;
    this.audit = snapshot.audit;
  }

  private persist(): void {
    const state: AuthorizationFile = {
      version: 1,
      added: [...this.added].sort(),
      revoked: [...this.revoked].sort(),
      audit: this.audit,
    };
    replaceFileAtomically(this.path, JSON.stringify(state) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }
}
