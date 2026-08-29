import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FleetConfig } from '../config.js';
import type { RoleRecord, RoleStatus } from '../application/types.js';
import type { ConfigResourceSnapshot } from '../config-resource-loader.js';

export type TopologyNodeKind = 'role' | 'brain' | 'agent' | 'watchdog' | 'loop';
export type TopologyEdgeKind = 'performs' | 'uses' | 'oversees' | 'watches' | 'targets' | 'spawned';

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

export function deriveTopology(config: FleetConfig, roles: RuntimeRoleItem[], resources?: ConfigResourceSnapshot): TopologySnapshot {
  const nodes: TopologyNode[] = roles.map(({ role, status }) => ({
    id: `agent:${role.id}`, kind: 'agent', label: role.id, status: status.overall,
    lifetime: role.lifetime, href: `/roles/${encodeURIComponent(role.id)}`,
    detail: role.config?.mission,
  }));
  const edges: TopologyEdge[] = [];
  const agentIds = new Set(roles.map(item => item.role.id));
  const add = (kind: TopologyEdgeKind, from: string, to: string, label: string) =>
    edges.push({ id: `${kind}:${from}:${to}`, kind, from, to, label });

  for (const resource of resources?.sources ?? []) {
    const typed = resource.resource;
    if (typed.kind === 'Role') nodes.push({ id: `role:${typed.id}`, kind: 'role', label: typed.id,
      status: 'configured', detail: typed.spec.mission });
    if (typed.kind === 'Brain') nodes.push({ id: `brain:${typed.id}`, kind: 'brain', label: typed.id,
      status: 'configured', detail: `${typed.spec.harness} · ${typed.spec.model}` });
    if (typed.kind === 'Agent') {
      if (!nodes.some(node => node.id === `agent:${resource.id}`))
        nodes.push({ id: `agent:${resource.id}`, kind: 'agent', label: resource.id, status: 'configured' });
      add('performs', `agent:${typed.id}`, `role:${typed.spec.role}`, 'performs role');
      if ('template' in typed.spec.brain)
        add('uses', `agent:${typed.id}`, `brain:${typed.spec.brain.template}`, 'uses brain');
    }
  }

  for (const role of config.roles) for (const entry of role.oversee ?? [])
    if (agentIds.has(role.name) && agentIds.has(entry.role))
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
