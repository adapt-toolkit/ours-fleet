/**
 * Role-scoped agent names for task members.
 *
 *   <KEY>-<Stem>       first member of a stem (no `-1`)
 *   <KEY>-<Stem>-<n>   later members, n >= 2
 *
 * The stem comes from the explicitly selected named Role when one exists,
 * otherwise from a stable room label, participant key or slot. It is
 * PascalCase Latin alphanumerics, truncated with ordinal headroom so the full
 * name fits the 64-character Fleet role-name budget. The counter bucket is the
 * case-folded truncated stem, chosen before numbering, so labels that collapse
 * to the same stem share one counter and can never produce the same name.
 *
 * Allocations are durable on the task record and keyed by a stable allocation
 * key: provisioning, recovery and restart reuse them; additions and
 * replacements use new keys and consume the next ordinal. Names that existed
 * before mission keys are frozen exactly as launched.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import type { MemberNameAllocation, MemberNaming, TaskRecord } from './types.js';

export const AGENT_NAME_MAX = 64;
/** Ordinal suffix headroom: `-999`. */
export const MAX_ROLE_ORDINAL = 999;
const SUFFIX_HEADROOM = 1 + String(MAX_ROLE_ORDINAL).length;

export type LabelSource = NonNullable<MemberNameAllocation['label_source']>;
export interface LabelCandidate { label: string | undefined; source: LabelSource }

export class MemberNameError extends Error {
  constructor(readonly code: 'role_ordinal_exhausted' | 'agent_name_taken' | 'invalid_label', message: string) {
    super(message); this.name = 'MemberNameError';
  }
}

/** PascalCase join of Latin alphanumeric words; diacritics folded, other scripts dropped. */
export function labelStem(label: string): string {
  const words = label.normalize('NFKD').replace(/\p{M}/gu, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map(word => word[0].toUpperCase() + word.slice(1)).join('');
  // Fleet role names must start with an alphanumeric; a leading digit is allowed.
  return joined;
}

/** First candidate that survives normalization, else `Agent`. */
export function chooseStem(key: string, candidates: readonly LabelCandidate[]): { stem: string; source: LabelSource } {
  const budget = AGENT_NAME_MAX - key.length - 1 - SUFFIX_HEADROOM;
  if (budget < 1) throw new MemberNameError('invalid_label', `mission key ${key} leaves no room for a role name`);
  for (const candidate of candidates) {
    if (!candidate.label) continue;
    const stem = labelStem(candidate.label).slice(0, budget);
    if (stem) return { stem, source: candidate.source };
  }
  return { stem: 'Agent'.slice(0, budget), source: 'fallback' };
}

export const bucketOf = (stem: string): string => stem.toLowerCase();

/** Own-property read: buckets such as `constructor` must never hit Object.prototype. */
export const ownEntry = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;

export function formatMemberName(key: string, stem: string, ordinal: number): string {
  return ordinal === 1 ? `${key}-${stem}` : `${key}-${stem}-${ordinal}`;
}

/**
 * Pure allocation step: returns the existing allocation for `allocationKey`,
 * or a new one plus the updated naming. The caller persists under the task
 * lock and checks external name conflicts before launch.
 */
export function allocateName(
  naming: MemberNaming | undefined, key: string, allocationKey: string, candidates: readonly LabelCandidate[],
): { naming: MemberNaming; allocation: MemberNameAllocation; created: boolean } {
  const current: MemberNaming = naming
    ? { version: 2, counters: { ...naming.counters }, allocations: { ...naming.allocations } }
    : { version: 2, counters: {}, allocations: {} };
  const existing = ownEntry(current.allocations, allocationKey);
  if (existing) return { naming: naming ?? current, allocation: existing, created: false };
  const { stem, source } = chooseStem(key, candidates);
  const bucket = bucketOf(stem);
  const ordinal = (ownEntry(current.counters, bucket) ?? 0) + 1;
  if (ordinal > MAX_ROLE_ORDINAL)
    throw new MemberNameError('role_ordinal_exhausted', `mission ${key} has used every ${stem} ordinal`);
  const allocation: MemberNameAllocation = {
    name: formatMemberName(key, stem, ordinal), bucket, ordinal, label_source: source,
  };
  current.counters[bucket] = ordinal;
  current.allocations[allocationKey] = allocation;
  return { naming: current, allocation, created: true };
}

// ── Frozen historical names (one-time migration) ─────────────────────────

const LEGACY_TEMPLATE_NAME = /^[0-9a-z]{8}-([A-Za-z][A-Za-z0-9_-]*)-([1-9][0-9]*)$/;

interface LegacyMember { allocationKey: string; name: string; candidates: LabelCandidate[] }

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

type SnapshotMember = { slot: string; role: string; count: number; role_preset?: { id: string }; role_label?: string };
type SeatLike = { role_name: string; slot?: string; cowork_role?: string };

/** Every physical agent a historical task already launched or planned, from all durable sources. */
function legacyMembers(task: Pick<TaskRecord, 'task_id' | 'room_id' | 'layout' | 'execution_plan'>): LegacyMember[] {
  const id8 = task.task_id.slice(0, 8);
  const members: LegacyMember[] = [];
  const snapshot = (task.execution_plan?.snapshot.members ?? []) as SnapshotMember[];
  const bySlot = new Map(snapshot.map(member => [member.slot, member]));
  const candidatesFor = (slot: string, role?: string): LabelCandidate[] => {
    const sealed = bySlot.get(slot);
    return [
      { label: sealed?.role_preset?.id, source: 'role_override' },
      { label: sealed?.role_label, source: 'template_ref' },
      { label: role ?? sealed?.role, source: 'room_role' },
      { label: slot, source: 'slot' },
    ];
  };
  for (const member of snapshot)
    for (let i = 1; i <= member.count; i++)
      members.push({ allocationKey: `initial:${member.slot}:${i}`, name: `${id8}-${member.slot}-${i}`,
        candidates: candidatesFor(member.slot, member.role) });
  const additions = join(stateRoot(), 'member-additions', task.task_id);
  if (existsSync(additions))
    for (const file of readdirSync(additions).filter(name => name.endsWith('.json')).sort()) {
      const receipt = readJson<{ requestId?: string; roleId?: string }>(join(additions, file));
      if (!receipt?.roleId || !receipt.requestId) continue;
      const slot = LEGACY_TEMPLATE_NAME.exec(receipt.roleId)?.[1] ?? receipt.roleId;
      members.push({ allocationKey: `add:${receipt.requestId}`, name: receipt.roleId, candidates: candidatesFor(slot) });
    }
  if (task.room_id) {
    const room = readJson<{ member_seats?: SeatLike[] }>(join(stateRoot(), 'rooms', `${task.room_id}.json`));
    for (const seat of room?.member_seats ?? []) {
      const match = LEGACY_TEMPLATE_NAME.exec(seat.role_name);
      const slot = seat.slot ?? match?.[1] ?? seat.role_name;
      members.push({ allocationKey: match ? `initial:${match[1]}:${match[2]}` : `seat:${seat.role_name}`,
        name: seat.role_name, candidates: candidatesFor(slot, seat.cowork_role) });
    }
  }
  if (task.layout) {
    type Run = { definition?: { participants?: Record<string, { agent_template?: string }>; rooms?: Record<string, { members: string[]; roles?: Record<string, string> }> };
      participants?: Record<string, { instance?: { agent?: string }; owned?: boolean; participant?: string; room?: string }>;
      additional_members?: Record<string, { room: string; role: string }> };
    const run = readJson<Run>(join(stateRoot(), 'layouts', `${task.layout.run_id}.json`));
    for (const [instanceKey, participant] of Object.entries(run?.participants ?? {})) {
      const agent = participant.instance?.agent;
      if (!agent || participant.owned === false) continue;
      const key = participant.participant ?? instanceKey;
      const roles = Object.entries(run?.definition?.rooms ?? {})
        .filter(([room, spec]) => spec.members.includes(key) && (!participant.room || participant.room === room))
        .map(([, spec]) => spec.roles?.[key] ?? key);
      const added = run?.additional_members?.[key]?.role;
      const agreed = added ?? (new Set(roles).size === 1 ? roles[0] : undefined);
      members.push({ allocationKey: `layout:${task.layout.run_id}:${instanceKey}`, name: agent, candidates: [
        { label: agreed, source: 'room_role' }, { label: key, source: 'participant_key' }] });
    }
  }
  return members;
}

/**
 * Freeze every historical agent name and seed counters by the same label
 * precedence as new names. Deduplicated by physical agent name; counters merge
 * monotonically and existing allocations are never rewritten. Returns the
 * input object unchanged when there is nothing to add.
 */
export function freezeLegacyMemberNaming(
  task: Pick<TaskRecord, 'task_id' | 'room_id' | 'layout' | 'execution_plan' | 'member_naming'> & { key: string },
): MemberNaming | undefined {
  const legacy = legacyMembers(task);
  if (!legacy.length) return task.member_naming;
  const naming: MemberNaming = task.member_naming
    ? { version: 2, counters: { ...task.member_naming.counters }, allocations: { ...task.member_naming.allocations } }
    : { version: 2, counters: {}, allocations: {} };
  const known = new Set(Object.values(naming.allocations).map(allocation => allocation.name));
  const seeded: Record<string, number> = {};
  let changed = !task.member_naming;
  for (const member of legacy) {
    if (known.has(member.name)) continue;
    if (ownEntry(naming.allocations, member.allocationKey)) continue;
    known.add(member.name);
    const { stem } = chooseStem(task.key, member.candidates);
    const bucket = bucketOf(stem);
    seeded[bucket] = (ownEntry(seeded, bucket) ?? 0) + 1;
    naming.allocations[member.allocationKey] = { name: member.name, bucket, frozen: true };
    changed = true;
  }
  for (const [bucket, count] of Object.entries(seeded)) {
    const frozenInBucket = Object.values(naming.allocations).filter(a => a.frozen && a.bucket === bucket).length;
    naming.counters[bucket] = Math.max(ownEntry(naming.counters, bucket) ?? 0, frozenInBucket, count);
  }
  return changed ? naming : task.member_naming;
}
