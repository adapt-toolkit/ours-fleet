import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { replaceFileAtomically } from '../atomic-file.js';
import {
  lifecycleEventDigestBasis, validateFleetAuditPresentations,
  type FleetAuditPresentation,
} from '../fleet-command-audit.js';

type LifecycleDelivery = 'pending' | 'delivered' | 'uncertain';
interface LifecycleOutboxEntry {
  digest: string;
  presentation: FleetAuditPresentation;
  delivery: LifecycleDelivery;
}
interface LifecycleOutboxFile { version: 1; entries: LifecycleOutboxEntry[] }

const DIGEST = /^[a-f0-9]{64}$/u;
const LIMIT = 5_000;

/** Durable lifecycle acceptance queue; plaintext is limited to validated concise presentations. */
export class FleetLifecycleOutbox {
  private entries: LifecycleOutboxEntry[] = [];
  private corruptReason?: string;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LifecycleOutboxFile>;
      if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LIMIT)
        throw new Error('invalid lifecycle outbox');
      const digests = new Set<string>();
      for (const entry of value.entries) {
        validateFleetAuditPresentations([entry?.presentation]);
        if (!DIGEST.test(entry.digest)
            || !['pending', 'delivered', 'uncertain'].includes(entry.delivery)
            || digests.has(entry.digest)) throw new Error('invalid lifecycle outbox entry');
        digests.add(entry.digest);
      }
      this.entries = structuredClone(value.entries);
      chmodSync(path, 0o600);
    } catch {
      this.corruptReason = 'invalid persisted Fleet lifecycle outbox';
      this.entries = [];
      try { chmodSync(path, 0o600); } catch { /* remain fail-closed */ }
    }
  }

  integrity(): { ok: boolean; error?: string } {
    return this.corruptReason ? { ok: false, error: this.corruptReason } : { ok: true };
  }

  enqueue(presentations: FleetAuditPresentation[]): void {
    this.assertHealthy();
    validateFleetAuditPresentations(presentations);
    let changed = false;
    for (const presentation of presentations) {
      const digest = createHash('sha256').update(lifecycleEventDigestBasis(presentation)).digest('hex');
      if (this.entries.some(entry => entry.digest === digest)) continue;
      if (this.entries.length >= LIMIT) {
        const settled = this.entries.findIndex(entry => entry.delivery !== 'pending');
        if (settled < 0) throw new Error(`Fleet lifecycle outbox is limited to ${LIMIT} pending events`);
        this.entries.splice(settled, 1);
      }
      this.entries.push({ digest, presentation: structuredClone(presentation), delivery: 'pending' });
      changed = true;
    }
    if (changed) this.persist();
  }

  pending(): readonly LifecycleOutboxEntry[] {
    this.assertHealthy();
    return this.entries.filter(entry => entry.delivery === 'pending').map(entry => structuredClone(entry));
  }

  finish(digest: string, delivery: Exclude<LifecycleDelivery, 'pending'>): void {
    this.assertHealthy();
    const entry = this.entries.find(candidate => candidate.digest === digest);
    if (!entry) throw new Error('unknown Fleet lifecycle outbox entry');
    if (entry.delivery === delivery) return;
    if (entry.delivery !== 'pending') throw new Error('conflicting Fleet lifecycle delivery state');
    entry.delivery = delivery;
    this.persist();
  }

  private assertHealthy(): void {
    if (this.corruptReason) throw new Error(this.corruptReason);
  }

  private persist(): void {
    replaceFileAtomically(this.path,
      `${JSON.stringify({ version: 1, entries: this.entries } satisfies LifecycleOutboxFile)}\n`, 0o600);
  }
}
