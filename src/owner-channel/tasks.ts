import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';

import { replaceFileAtomically } from '../atomic-file.js';
import { canonicalCid } from '../config.js';

export type OwnerTaskPhase = 'progress' | 'done' | 'blocked';
export type OwnerTaskTerminalState = 'closed' | 'expired' | 'revoked';

export interface OwnerTaskRoute {
  requestId: string;
  contact: string;
  wireId: string;
}

interface PendingReport {
  digest: string;
  phase: OwnerTaskPhase;
  chars: number;
  bytes: number;
}

export interface OwnerTaskRecord extends OwnerTaskRoute {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: 'open' | 'sending' | 'uncertain';
  sequence: number;
  reportCount: number;
  lastReportAt?: number;
  digests: string[];
  pending?: PendingReport;
}

interface OwnerTaskTombstone {
  id: string;
  state: OwnerTaskTerminalState;
  at: number;
}

interface OwnerTaskFile {
  version: 1;
  tasks: OwnerTaskRecord[];
  tombstones: OwnerTaskTombstone[];
}

export const OWNER_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const OWNER_TASK_MAX_OPEN = 32;
export const OWNER_TASK_MAX_PER_OWNER = 8;
export const OWNER_TASK_MAX_REPORTS = 20;
export const OWNER_TASK_REPORT_MIN_INTERVAL_MS = 5_000;
const MAX_TOMBSTONES = 256;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const HEX_64 = /^[a-f0-9]{64}$/;
const CID = /^[A-Fa-f0-9]{64}$/;

/**
 * Durable proactive-task routing. It deliberately stores no report body: only
 * the authenticated route, bounded hashes/counters, and delivery state.
 */
export class OwnerTaskState {
  private tasks: OwnerTaskRecord[] = [];
  private tombstones: OwnerTaskTombstone[] = [];
  private corruptReason?: string;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerTaskFile>;
      if (raw.version !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.tombstones)
          || raw.tasks.length > OWNER_TASK_MAX_OPEN || raw.tombstones.length > MAX_TOMBSTONES
          || !raw.tasks.every(task => this.validTask(task))
          || !raw.tombstones.every(tombstone => this.validTombstone(tombstone)))
        throw new Error('invalid or unbounded task state');
      const ids = [...raw.tasks.map(task => task.id), ...raw.tombstones.map(item => item.id)];
      if (new Set(ids).size !== ids.length) throw new Error('duplicate task ID');
      this.tasks = raw.tasks.map(task => ({ ...task, digests: [...task.digests] }));
      this.tombstones = raw.tombstones.map(item => ({ ...item }));
      // A crash or lost response after the durable pre-send marker makes the
      // result unknowable. Never resend it automatically and risk duplication.
      let recovered = false;
      for (const task of this.tasks) {
        if (task.status === 'sending') { task.status = 'uncertain'; recovered = true; }
      }
      chmodSync(path, 0o600);
      if (recovered) this.persist();
    } catch {
      this.tasks = [];
      this.tombstones = [];
      this.corruptReason = 'invalid persisted owner task state';
      try { chmodSync(path, 0o600); } catch { /* remain fail-closed */ }
    }
  }

  integrity(): { ok: boolean; error?: string } {
    return this.corruptReason ? { ok: false, error: this.corruptReason } : { ok: true };
  }

  open(route: OwnerTaskRoute, now = Date.now()): OwnerTaskRecord {
    this.assertHealthy();
    if (!HEX_64.test(route.requestId) || !CID.test(route.contact)
        || typeof route.wireId !== 'string' || route.wireId.length < 1 || route.wireId.length > 1_024)
      throw new Error('owner task route is invalid or exceeds its bounds');
    this.cleanup(now);
    if (this.tasks.length >= OWNER_TASK_MAX_OPEN)
      throw new Error(`owner channel is limited to ${OWNER_TASK_MAX_OPEN} open tasks`);
    if (this.tasks.filter(task => canonicalCid(task.contact) === canonicalCid(route.contact))
      .length >= OWNER_TASK_MAX_PER_OWNER)
      throw new Error(`an owner is limited to ${OWNER_TASK_MAX_PER_OWNER} open tasks per role`);
    let id: string;
    do { id = randomBytes(32).toString('hex'); }
    while (this.tasks.some(task => task.id === id) || this.tombstones.some(item => item.id === id));
    const task: OwnerTaskRecord = {
      id, ...route, createdAt: now, expiresAt: now + OWNER_TASK_TTL_MS,
      status: 'open', sequence: 0, reportCount: 0, digests: [],
    };
    this.mutate(() => { this.tasks.push(task); });
    return { ...task, digests: [] };
  }

  route(taskId: string, now = Date.now()): OwnerTaskRecord {
    this.assertHealthy();
    this.cleanup(now);
    const task = this.findOpen(taskId);
    return {
      ...task, digests: [...task.digests],
      ...(task.pending ? { pending: { ...task.pending } } : {}),
    };
  }

  beginReport(
    taskId: string, phase: OwnerTaskPhase, digest: string, chars: number, bytes: number,
    now = Date.now(),
  ): OwnerTaskRecord {
    this.assertHealthy();
    this.cleanup(now);
    const task = this.findOpen(taskId);
    if (task.status === 'uncertain')
      throw new Error('task report delivery outcome is uncertain; refusing to resend or reorder reports');
    if (task.status !== 'open') throw new Error('task report is already being delivered');
    if (task.digests.includes(digest)) throw new Error('duplicate task report refused');
    if (task.reportCount >= OWNER_TASK_MAX_REPORTS)
      throw new Error(`owner task is limited to ${OWNER_TASK_MAX_REPORTS} reports`);
    if (task.lastReportAt !== undefined && now - task.lastReportAt < OWNER_TASK_REPORT_MIN_INTERVAL_MS)
      throw new Error(`owner task reports are rate-limited to one every ${OWNER_TASK_REPORT_MIN_INTERVAL_MS}ms`);
    this.mutate(() => {
      task.status = 'sending';
      task.pending = { digest, phase, chars, bytes };
    });
    return { ...task, digests: [...task.digests], pending: { ...task.pending! } };
  }

  delivered(taskId: string, digest: string, terminal: boolean, now = Date.now()): number {
    this.assertHealthy();
    const task = this.tasks.find(item => item.id === taskId);
    if (!task || task.status !== 'sending' || task.pending?.digest !== digest)
      throw new Error('task report delivery state changed unexpectedly');
    const sequence = task.sequence + 1;
    this.mutate(() => {
      task.sequence = sequence;
      task.reportCount++;
      task.lastReportAt = now;
      task.digests.push(digest);
      task.pending = undefined;
      if (terminal) this.remove(task, 'closed', now);
      else task.status = 'open';
    });
    return sequence;
  }

  uncertain(taskId: string, digest: string): void {
    this.assertHealthy();
    const task = this.tasks.find(item => item.id === taskId);
    if (!task || task.pending?.digest !== digest) return;
    this.mutate(() => { task.status = 'uncertain'; });
  }

  revoke(contact: string, now = Date.now()): number {
    this.assertHealthy();
    const revoked = this.tasks.filter(
      task => canonicalCid(task.contact) === canonicalCid(contact));
    if (!revoked.length) return 0;
    this.mutate(() => { for (const task of revoked) this.remove(task, 'revoked', now); });
    return revoked.length;
  }

  cleanup(now = Date.now(), effectiveOwners?: Set<string>): number {
    this.assertHealthy();
    const expired = this.tasks.filter(task => task.expiresAt <= now);
    const canonicalOwners = effectiveOwners && new Set([...effectiveOwners].map(canonicalCid));
    const revoked = canonicalOwners
      ? this.tasks.filter(task =>
        !canonicalOwners.has(canonicalCid(task.contact)) && !expired.includes(task)) : [];
    const oldTombstones = this.tombstones.filter(item => now - item.at > TOMBSTONE_TTL_MS);
    if (!expired.length && !revoked.length && !oldTombstones.length) return 0;
    this.mutate(() => {
      for (const task of expired) this.remove(task, 'expired', now);
      for (const task of revoked) this.remove(task, 'revoked', now);
      this.tombstones = this.tombstones
        .filter(item => now - item.at <= TOMBSTONE_TTL_MS).slice(-MAX_TOMBSTONES);
    });
    return expired.length + revoked.length;
  }

  private findOpen(taskId: string): OwnerTaskRecord {
    if (!HEX_64.test(taskId)) throw new Error('owner task ID must be exactly 64 lowercase hexadecimal characters');
    const task = this.tasks.find(item => item.id === taskId);
    if (task) return task;
    const tombstone = this.tombstones.find(item => item.id === taskId);
    if (tombstone) throw new Error(`owner task is ${tombstone.state}`);
    throw new Error('unknown owner task ID');
  }

  private remove(task: OwnerTaskRecord, state: OwnerTaskTerminalState, now: number): void {
    this.tasks = this.tasks.filter(item => item !== task);
    this.tombstones.push({ id: task.id, state, at: now });
    this.tombstones = this.tombstones.slice(-MAX_TOMBSTONES);
  }

  private mutate(change: () => void): void {
    const snapshot = JSON.stringify({ tasks: this.tasks, tombstones: this.tombstones });
    change();
    try { this.persist(); }
    catch (error) {
      const old = JSON.parse(snapshot) as { tasks: OwnerTaskRecord[]; tombstones: OwnerTaskTombstone[] };
      this.tasks = old.tasks;
      this.tombstones = old.tombstones;
      throw error;
    }
  }

  private persist(): void {
    replaceFileAtomically(this.path, JSON.stringify({
      version: 1, tasks: this.tasks, tombstones: this.tombstones,
    } satisfies OwnerTaskFile) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }

  private assertHealthy(): void {
    if (this.corruptReason)
      throw new Error(`owner task state is corrupt; refusing operation: ${this.corruptReason}`);
  }

  private validTask(value: unknown): value is OwnerTaskRecord {
    if (!value || typeof value !== 'object') return false;
    const task = value as OwnerTaskRecord;
    return HEX_64.test(task.id) && HEX_64.test(task.requestId) && CID.test(task.contact)
      && typeof task.wireId === 'string' && task.wireId.length > 0 && task.wireId.length <= 1_024
      && Number.isSafeInteger(task.createdAt) && task.createdAt >= 0
      && Number.isSafeInteger(task.expiresAt) && task.expiresAt - task.createdAt === OWNER_TASK_TTL_MS
      && ['open', 'sending', 'uncertain'].includes(task.status)
      && Number.isSafeInteger(task.sequence) && task.sequence >= 0
      && Number.isSafeInteger(task.reportCount) && task.reportCount >= 0
      && task.reportCount <= OWNER_TASK_MAX_REPORTS
      && Array.isArray(task.digests) && task.digests.length <= OWNER_TASK_MAX_REPORTS
      && task.digests.every(digest => HEX_64.test(digest))
      && new Set(task.digests).size === task.digests.length
      && task.sequence === task.reportCount && task.reportCount === task.digests.length
      && (task.reportCount === 0
        ? task.lastReportAt === undefined
        : Number.isSafeInteger(task.lastReportAt) && task.lastReportAt! >= task.createdAt)
      && (task.pending === undefined || this.validPending(task.pending))
      && (task.pending === undefined || !task.digests.includes(task.pending.digest))
      && (task.status === 'open' ? task.pending === undefined : task.pending !== undefined);
  }

  private validPending(value: unknown): value is PendingReport {
    if (!value || typeof value !== 'object') return false;
    const pending = value as PendingReport;
    return HEX_64.test(pending.digest) && ['progress', 'done', 'blocked'].includes(pending.phase)
      && Number.isSafeInteger(pending.chars) && pending.chars >= 1 && pending.chars <= 280
      && Number.isSafeInteger(pending.bytes) && pending.bytes >= 1 && pending.bytes <= 1_024;
  }

  private validTombstone(value: unknown): value is OwnerTaskTombstone {
    if (!value || typeof value !== 'object') return false;
    const item = value as OwnerTaskTombstone;
    return HEX_64.test(item.id) && ['closed', 'expired', 'revoked'].includes(item.state)
      && Number.isSafeInteger(item.at);
  }
}

export const ownerTaskDigest = (phase: OwnerTaskPhase, message: string): string =>
  createHash('sha256').update(`${phase}\0${message}`).digest('hex');

export const ownerTaskAuditId = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);
