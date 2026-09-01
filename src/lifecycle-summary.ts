import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  AgentSelection, ApprovalMode, FilesystemMode, FleetPermissionMode, MonitorInterrupt,
  MonitorMode, ResolvedRole, SessionBackendId, UnattendedMode,
} from './config.js';
import type { IsolationBackendId, NetworkMode, OnUnavailable } from './isolation/types.js';
import { canonicalJson } from './canonical-json.js';
import { effectiveRoleModel } from './model-env.js';
import { markdownCode, markdownProse } from './rooms-tasks/markdown.js';

/**
 * Operator-facing launch configuration captured at the launch boundary from
 * the exact ResolvedRole that was spawned. It is the single source for every
 * Fleet lifecycle/report surface (CLI and owner-channel/Messenger).
 *
 * Security boundary: this object is a strict whitelist. It must never carry
 * env, cwd or any local path, harness_options, session_options, owner_channel,
 * or auth_proxy content. Hashes are secondary provenance only, never the
 * primary description.
 */
export interface AgentLaunchConfiguration {
  version: 1;
  /** Agent template / launch definition label when one was selected. */
  template?: string;
  role: SelectionOrigin;
  brain: SelectionOrigin;
  harness: string;
  session: SessionBackendId;
  /**
   * Model observed effective at launch. `null` reports runtime behavior — the
   * harness ran its own default — not whether the author wrote `model: null`
   * or omitted the field; effectiveRoleModel cannot distinguish those.
   */
  model: string | null;
  effort?: string;
  /** Concise first-line mission label (or Cowork-role fallback), never the full mission. */
  mission?: string;
  approval: ApprovalMode;
  filesystem: FilesystemMode;
  unattended: UnattendedMode;
  /** Portable policy plus the exact native runtime mode after harness_options. */
  permissionMode: { fleetMode: FleetPermissionMode; nativeMode: string };
  monitor: { mode: MonitorMode; interrupt: MonitorInterrupt };
  /** Requested isolation policy only — never resolved runtime facts or host paths. */
  isolation?: {
    requested: IsolationBackendId;
    on_unavailable?: OnUnavailable;
    network?: NetworkMode;
    read_mounts?: number;
    write_mounts?: number;
  };
}

/** Where a Brain/Role selection came from; labels are human, hashes secondary. */
export type SelectionOrigin =
  | { kind: 'named'; ref: string }
  | { kind: 'inline'; fingerprint?: string }
  | { kind: 'unknown' };

const FINGERPRINT_HEX = 12;
export const MISSION_LABEL_MAX = 80;

/**
 * `precomputed` must be a full or prefixed lowercase sha256 hex (>= 12 chars)
 * of the canonical inline body; anything else is ignored and the fingerprint
 * is recomputed here so provenance can never be an arbitrary caller string.
 */
export function selectionOrigin(
  selection: AgentSelection | undefined, precomputed?: string,
): SelectionOrigin {
  if (!selection) return { kind: 'unknown' };
  if ('ref' in selection) return { kind: 'named', ref: selection.ref };
  const fingerprint = precomputed && /^[a-f0-9]{12,64}$/.test(precomputed)
    ? precomputed
    : createHash('sha256').update(canonicalJson(selection.inline)).digest('hex');
  return { kind: 'inline', fingerprint: fingerprint.slice(0, FINGERPRINT_HEX) };
}

export function missionLabel(mission: string | undefined): string | undefined {
  const line = mission?.trim().split('\n', 1)[0]?.trim();
  if (!line) return undefined;
  const points = Array.from(line);
  return points.length > MISSION_LABEL_MAX
    ? `${points.slice(0, MISSION_LABEL_MAX - 1).join('')}…` : line;
}

/**
 * Build the presentation from the exact resolved launch state. `origins`
 * carries the authoring-time selections and template label because a merged
 * ResolvedRole no longer distinguishes preset references from inline bodies.
 * `permissionMode` is required at capture time: every supported harness
 * adapter reports it, and the managed-spawn receiver gets it over the wire
 * and must never re-resolve mutable configuration.
 */
export function summarizeResolvedLaunch(role: ResolvedRole, origins: {
  role: SelectionOrigin; brain: SelectionOrigin; template?: string;
  permissionMode: { fleetMode: FleetPermissionMode; nativeMode: string };
  /** Shown when the resolved role has no mission text (e.g. Cowork role name). */
  missionFallback?: string;
}): AgentLaunchConfiguration {
  const mission = missionLabel(role.mission) ?? missionLabel(origins.missionFallback);
  const fs = role.isolation?.fs;
  return {
    version: 1,
    ...(origins.template ? { template: origins.template } : {}),
    role: origins.role,
    brain: origins.brain,
    harness: role.harness,
    session: role.session,
    model: effectiveRoleModel(role) ?? null,
    ...(role.effort ? { effort: role.effort } : {}),
    ...(mission ? { mission } : {}),
    approval: role.permissions.approval,
    filesystem: role.permissions.filesystem,
    unattended: role.permissions.unattended,
    permissionMode: origins.permissionMode,
    monitor: { mode: role.monitor.mode, interrupt: role.monitor.interrupt },
    ...(role.isolation?.backend ? { isolation: {
      requested: role.isolation.backend,
      ...(role.isolation.on_unavailable ? { on_unavailable: role.isolation.on_unavailable } : {}),
      ...(role.isolation.network ? { network: role.isolation.network } : {}),
      ...(fs?.read?.length ? { read_mounts: fs.read.length } : {}),
      ...(fs?.write?.length ? { write_mounts: fs.write.length } : {}),
    } } : {}),
  };
}

/**
 * Component budget for one rendered agent line. The mandatory components are
 * bounded by the markdown.ts field caps and always fit the shared
 * 3,500-code-point / 12,000-byte message bounds on their own; optional
 * components are dropped whole (with a visible `…` marker) past this budget.
 */
export const AGENT_LINE_MAX_CODE_POINTS = 1_500;
export const AGENT_LINE_MAX_BYTES = 5_000;

const codePoints = (value: string): number => Array.from(value).length;
const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * Render one agent's configuration as a single escaped Markdown line segment.
 * This is the only escaping boundary: callers pass raw values and must not
 * escape the result again (it is safe as a markdownItems entry and inside
 * owner-channel lifecycle messages).
 */
export function renderAgentConfiguration(
  configuration: AgentLaunchConfiguration | undefined,
  fallback?: { role?: string; brain?: string; permissions?: string },
): string {
  if (!configuration) {
    const labels = [
      fallback?.role ? `Role ${markdownProse(fallback.role)}` : undefined,
      fallback?.brain ? `Brain ${markdownProse(fallback.brain)}` : undefined,
      fallback?.permissions ? `permissions ${markdownProse(fallback.permissions)}` : undefined,
    ].filter(Boolean).join('; ');
    return `legacy launch; resolved details unavailable${labels ? ` (${labels})` : ''}`;
  }
  const origin = (kind: 'Role' | 'Brain', value: SelectionOrigin): string => {
    if (value.kind === 'named') return `${kind} preset ${markdownCode(value.ref)}`;
    if (value.kind === 'inline')
      return `inline ${kind}${value.fingerprint ? ` (def ${markdownCode(value.fingerprint)})` : ''}`;
    return `${kind} unknown`;
  };
  const mandatory = [
    configuration.template ? `template ${markdownCode(configuration.template)}` : undefined,
    origin('Role', configuration.role),
    configuration.mission ? `mission “${markdownProse(configuration.mission)}”` : undefined,
    origin('Brain', configuration.brain),
    `harness ${markdownCode(configuration.harness)}`,
    `model ${configuration.model === null ? 'harness-default' : markdownCode(configuration.model)}`,
    configuration.effort ? `effort ${markdownProse(configuration.effort)}` : undefined,
    `approval=${configuration.approval}, filesystem=${configuration.filesystem}, `
      + `unattended=${configuration.unattended}`,
    `mode ${configuration.permissionMode.fleetMode}/${markdownProse(configuration.permissionMode.nativeMode)}`,
  ].filter((part): part is string => Boolean(part));
  const optional = [
    `monitor ${configuration.monitor.mode}/${String(configuration.monitor.interrupt)}`,
    configuration.isolation
      ? `isolation requested ${configuration.isolation.requested}`
        + `${configuration.isolation.network ? `, net ${configuration.isolation.network}` : ''}`
        + `${configuration.isolation.on_unavailable ? `, on-unavailable ${configuration.isolation.on_unavailable}` : ''}`
        + `${configuration.isolation.read_mounts || configuration.isolation.write_mounts
          ? `, mounts +${configuration.isolation.read_mounts ?? 0}ro/+${configuration.isolation.write_mounts ?? 0}rw` : ''}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  let line = mandatory.join('; ');
  let omitted = false;
  for (const part of optional) {
    const next = `${line}; ${part}`;
    if (codePoints(next) > AGENT_LINE_MAX_CODE_POINTS || utf8(next) > AGENT_LINE_MAX_BYTES) {
      omitted = true; continue;
    }
    line = next;
  }
  return omitted ? `${line}; …` : line;
}
