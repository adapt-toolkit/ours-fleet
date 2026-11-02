import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Who Channels reads (perspective sources) and which CIDs are never channels
 * (the internal-exclusion set). Both come from local records only: a peer's
 * claimed root never makes it internal, because root claims are not proven.
 */
export interface PerspectiveSource {
  kind: 'owner' | 'agent';
  /** Daemon identity name. */
  name: string;
  cid: string;
  /** Fleet role id for agent sources (the "Open chat with agent" target). */
  roleId?: string;
  /** Released/retired/removed: kept as metadata only, never read again. */
  ended: boolean;
}
export interface ChannelSources {
  ownerCid: string;
  rootCid?: string;
  sources: PerspectiveSource[];
  internal: Set<string>;
}
export interface DaemonIdentityRow { name: string; cid?: string; kind?: string }
export interface AgentRecord { name: string; cid: string; phase: string }

const CID = /^[0-9a-f]{64}$/i;
const ENDED_PHASES = new Set(['TERMINAL_INTENT', 'CLEANUP_PENDING', 'RELEASED', 'FAILED']);
export const norm = (cid: string) => cid.toUpperCase();

/**
 * Retained supervisor journals (`private-ours/<binder>/state.json` and archived
 * `retired-<instance>/state.json`). They exist for stopped agents too, so a
 * stopped agent stays a perspective source; retired generations mark ended.
 */
export function readAgentRecords(privateRoot: string): AgentRecord[] {
  if (!existsSync(privateRoot)) return [];
  const records: AgentRecord[] = [];
  const read = (path: string, retired: boolean) => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; cid?: unknown; phase?: unknown };
      if (typeof value.name !== 'string' || typeof value.cid !== 'string' || !CID.test(value.cid)) return;
      records.push({ name: value.name, cid: norm(value.cid), phase: retired ? 'RELEASED' : String(value.phase ?? '') });
    } catch { /* missing or corrupt journal: not a source */ }
  };
  for (const entry of readdirSync(privateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(privateRoot, entry.name);
    read(join(dir, 'state.json'), false);
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.startsWith('retired-')) read(join(dir, child.name, 'state.json'), true);
    }
  }
  return records;
}

export function resolveSources(input: {
  ownerCid: string;
  identities: DaemonIdentityRow[];
  agents: AgentRecord[];
  /** Fleet role id by daemon identity name, for roles this workspace defines. */
  roleByIdentity: Map<string, string>;
  roomCids: string[];
}): ChannelSources {
  const ownerCid = norm(input.ownerCid);
  const live = new Map(input.identities.filter(row => row.cid && CID.test(row.cid)).map(row => [norm(row.cid!), row]));
  const rootRow = input.identities.find(row => row.kind === 'root' && row.cid && CID.test(row.cid));
  const rootCid = rootRow ? norm(rootRow.cid!) : undefined;
  const internal = new Set<string>([ownerCid]);
  if (rootCid) internal.add(rootCid);
  for (const cid of input.roomCids) if (CID.test(cid)) internal.add(norm(cid));
  const sources: PerspectiveSource[] = [];
  const ownerRow = live.get(ownerCid);
  if (ownerRow) sources.push({ kind: 'owner', name: ownerRow.name, cid: ownerCid, ended: false });
  // One source per agent CID: a live journal wins over retired generations.
  const byCid = new Map<string, AgentRecord>();
  for (const record of input.agents) {
    internal.add(record.cid);
    const prior = byCid.get(record.cid);
    if (!prior || (ENDED_PHASES.has(prior.phase) && !ENDED_PHASES.has(record.phase))) byCid.set(record.cid, record);
  }
  for (const record of byCid.values()) {
    const roleId = input.roleByIdentity.get(record.name);
    if (roleId === undefined || record.cid === ownerCid) continue; // not a workspace role: excluded, not a perspective
    const row = live.get(record.cid);
    sources.push({ kind: 'agent', name: record.name, cid: record.cid, roleId,
      ended: ENDED_PHASES.has(record.phase) || !row || row.name !== record.name });
  }
  return { ownerCid, ...(rootCid ? { rootCid } : {}), sources, internal };
}
