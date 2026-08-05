import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FleetConfig } from '../config.js';
import type { RoleRecord, RoleStatus } from '../application/types.js';

export type TopologyNodeKind = 'agent' | 'watchdog' | 'loop';
export type TopologyEdgeKind = 'oversees' | 'watches' | 'targets' | 'spawned';

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  label: string;
  status: string;
  lifetime?: string;
  href?: string;
  detail?: string;
}

export interface TopologyEdge {
  id: string;
  kind: TopologyEdgeKind;
  from: string;
  to: string;
  label: string;
}

export interface TopologySnapshot {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  unknownLineage: string[];
}

export interface RuntimeRoleItem { role: RoleRecord; status: RoleStatus }

/**
 * Whether a role is part of the fleet the graph draws.
 *
 * The role inventory is the union of `fleet.yaml` and every state directory
 * under the permanent and temporary roots, so it also carries every temporary
 * agent this host has ever started: each one leaves its directory behind, and a
 * graph that enumerated them would show a list of identities rather than a
 * fleet. A node is drawn when it is persistent fleet configuration — configured
 * but stopped still counts, or an agent would vanish the moment it was added —
 * or when it is genuinely active right now.
 *
 * The inventory keeps carrying the rest: they remain listed, removable and
 * inspectable under "Show past agents" in the role table. This decides what is
 * *drawn*, never what exists.
 */
export function isFleetMember(item: RuntimeRoleItem): boolean {
  return item.role.configured
    || item.status.session.reachability === 'online'
    || item.status.supervisor.liveness === 'running';
}

export function deriveTopology(config: FleetConfig, inventory: RuntimeRoleItem[]): TopologySnapshot {
  const roles = inventory.filter(isFleetMember);
  const nodes: TopologyNode[] = roles.map(({ role, status }) => ({
    id: `agent:${role.id}`, kind: 'agent', label: role.id, status: status.overall,
    lifetime: role.lifetime, href: `/roles/${encodeURIComponent(role.id)}`,
    detail: role.config?.mission,
  }));
  const edges: TopologyEdge[] = [];
  const agentIds = new Set(roles.map(item => item.role.id));
  const add = (kind: TopologyEdgeKind, from: string, to: string, label: string) =>
    edges.push({ id: `${kind}:${from}:${to}`, kind, from, to, label });

  // `oversee:` is passed through by the loader without a shape check, so a
  // hand-edited mapping or scalar reaches here. Drawing what can be read beats
  // throwing: a malformed entry must not take the whole graph down with it.
  for (const role of config.roles)
    for (const entry of Array.isArray(role.oversee) ? role.oversee : [])
      if (typeof entry?.role === 'string' && agentIds.has(role.name) && agentIds.has(entry.role))
        add('oversees', `agent:${role.name}`, `agent:${entry.role}`, `oversees · ${entry.interval}`);

  for (const watchdog of config.watchdogs) {
    const id = `watchdog:${watchdog.name}`;
    nodes.push({
      id, kind: 'watchdog', label: watchdog.name,
      status: watchdog.enabled ? 'active' : 'disabled', href: `/watchdogs/${encodeURIComponent(watchdog.name)}`,
      detail: `Every ${watchdog.intervalMs} ms`,
    });
    for (const role of watchdog.watch)
      if (agentIds.has(role)) add('watches', id, `agent:${role}`, 'watches');
  }

  for (const loop of config.loops) {
    const id = `loop:${loop.name}`;
    nodes.push({
      id, kind: 'loop', label: loop.name, status: loop.enabled ? 'active' : 'disabled',
      detail: `Every ${loop.intervalMs} ms`,
    });
    for (const role of loop.roleNames)
      if (agentIds.has(role)) add('targets', id, `agent:${role}`, 'delivers to');
  }

  const unknownLineage: string[] = [];
  for (const { role } of roles.filter(item => item.role.lifetime === 'temporary')) {
    const parent = role.lineage?.parentRole;
    if (parent && agentIds.has(parent)) add('spawned', `agent:${parent}`, `agent:${role.id}`, 'spawned');
    else unknownLineage.push(role.id);
  }
  return { nodes, edges, unknownLineage: unknownLineage.sort() };
}

export function readSpawnLineage(stateDir: string): RoleRecord['lineage'] {
  const path = join(stateDir, 'creation.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return value.version === 1 && value.lifetime === 'temporary'
      && typeof value.callerRole === 'string' && /^[A-Za-z0-9_-]+$/.test(value.callerRole)
      ? { parentRole: value.callerRole, source: 'creation-provenance' } : undefined;
  } catch { return undefined; }
}
