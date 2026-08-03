import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';

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
      if (this.added.size !== raw.added.length || this.revoked.size !== raw.revoked.length)
        throw new Error('duplicate overlay CID');
      if ([...this.added].some(cid => this.revoked.has(cid)))
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
    const effective = new Set([...this.baseline, ...this.added]);
    for (const cid of this.revoked) effective.delete(cid);
    return effective;
  }

  entries(): OwnerEntry[] {
    const effective = this.effective();
    return [...new Set([...this.baseline, ...this.added, ...this.revoked])]
      .sort().map(cid => ({
        cid,
        source: this.baseline.has(cid) ? 'baseline' : 'dynamic',
        effective: effective.has(cid),
      }));
  }

  authorize(cid: string): OwnerEntry {
    this.assertHealthy();
    if (this.effective().has(cid)) throw new Error(`owner '${cid}' is already authorized`);
    const rollback = this.snapshot();
    if (this.baseline.has(cid)) this.revoked.delete(cid);
    else {
      if (this.added.size + this.revoked.size >= MAX_OVERLAY_CIDS)
        throw new Error(`owner authorization overlay is limited to ${MAX_OVERLAY_CIDS} CIDs`);
      this.added.add(cid);
      this.revoked.delete(cid);
    }
    this.record('authorize', cid);
    try { this.persist(); } catch (error) { this.restore(rollback); throw error; }
    return { cid, source: this.baseline.has(cid) ? 'baseline' : 'dynamic', effective: true };
  }

  revoke(cid: string): OwnerEntry {
    this.assertHealthy();
    const effective = this.effective();
    if (!effective.has(cid)) throw new Error(`owner '${cid}' is not authorized`);
    if (effective.size === 1) throw new Error('refusing to revoke the last effective owner');
    const rollback = this.snapshot();
    if (this.baseline.has(cid)) this.revoked.add(cid);
    else this.added.delete(cid);
    this.record('revoke', cid);
    try { this.persist(); } catch (error) { this.restore(rollback); throw error; }
    return { cid, source: this.baseline.has(cid) ? 'baseline' : 'dynamic', effective: false };
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
