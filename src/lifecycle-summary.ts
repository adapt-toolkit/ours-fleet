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
  /** Present only for temporary agents; prompt bodies are never presented. */
  loops?: {
    source: 'agent-template' | 'cli' | 'omitted';
    policy: 'skip-if-busy';
    entries: Array<{
      name: string; enabled: boolean; intervalMs: number; initialDelayMs: number; jitterMs: number;
      prompt: { bytes: number; sha256: string };
    }>;
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
 * The inline fingerprint is always computed here from the canonical inline
 * body; provenance can never be an arbitrary caller string.
 */
export function selectionOrigin(selection: AgentSelection | undefined): SelectionOrigin {
  if (!selection) return { kind: 'unknown' };
  if ('ref' in selection) return { kind: 'named', ref: selection.ref };
  const fingerprint = createHash('sha256').update(canonicalJson(selection.inline)).digest('hex');
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
  const configuration: AgentLaunchConfiguration = {
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
    ...(role.temporaryLoopSource ? { loops: {
      source: role.temporaryLoopSource,
      policy: 'skip-if-busy' as const,
      entries: (role.temporaryLoops ?? role.loops ?? []).map(loop => ({
        name: loop.name, enabled: loop.enabled, intervalMs: loop.intervalMs,
        initialDelayMs: loop.initialDelayMs, jitterMs: loop.jitterMs,
        prompt: { bytes: loop.promptBytes, sha256: loop.promptHash },
      })),
    } } : {}),
  };
  // A configuration whose complete mandatory rendering cannot fit must never
  // be produced; real resolved values sit far below the budget, so this is a
  // capture defect, not an expected path.
  if (!mandatoryConfigurationFits(configuration))
    throw new Error('agent launch presentation exceeds the mandatory rendering budget');
  return configuration;
}

/**
 * Component budget for one rendered agent line. The complete mandatory
 * rendering must always fit — that is a validity condition of a current-v1
 * configuration, enforced by mandatoryConfigurationFits at the builder AND
 * the wire boundary — while optional components (monitor, isolation) are
 * dropped whole with a visible `…` marker past this budget.
 */
export const AGENT_LINE_MAX_CODE_POINTS = 1_500;
export const AGENT_LINE_MAX_BYTES = 5_000;

const codePoints = (value: string): number => Array.from(value).length;
const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');
const OPTIONAL_OMISSION_SUFFIX = '; …';

function selectionComponent(kind: 'Role' | 'Brain', value: SelectionOrigin): string {
  if (value.kind === 'named') return `${kind} preset ${markdownCode(value.ref)}`;
  if (value.kind === 'inline')
    return `inline ${kind}${value.fingerprint ? ` (def ${markdownCode(value.fingerprint)})` : ''}`;
  return `${kind} unknown`;
}

/**
 * The complete mandatory rendering: template, origins, mission, harness,
 * model, effort, portable policy triple, and fleet/native permission mode.
 * These must never be omitted from an operator-facing line.
 */
function mandatoryComponents(configuration: AgentLaunchConfiguration): string[] {
  return [
    configuration.template ? `template ${markdownCode(configuration.template)}` : undefined,
    selectionComponent('Role', configuration.role),
    configuration.mission ? `mission “${markdownProse(configuration.mission)}”` : undefined,
    selectionComponent('Brain', configuration.brain),
    `harness ${markdownCode(configuration.harness)}`,
    `model ${configuration.model === null ? 'harness-default' : markdownCode(configuration.model)}`,
    configuration.effort ? `effort ${markdownProse(configuration.effort)}` : undefined,
    `approval=${configuration.approval}, filesystem=${configuration.filesystem}, `
      + `unattended=${configuration.unattended}`,
    `mode ${configuration.permissionMode.fleetMode}/${markdownProse(configuration.permissionMode.nativeMode)}`,
  ].filter((part): part is string => Boolean(part));
}

function optionalComponents(configuration: AgentLaunchConfiguration): string[] {
  return [
    `monitor ${configuration.monitor.mode}/${String(configuration.monitor.interrupt)}`,
    configuration.isolation
      ? `isolation requested ${configuration.isolation.requested}`
        + `${configuration.isolation.network ? `, net ${configuration.isolation.network}` : ''}`
        + `${configuration.isolation.on_unavailable ? `, on-unavailable ${configuration.isolation.on_unavailable}` : ''}`
        + `${configuration.isolation.read_mounts || configuration.isolation.write_mounts
          ? `, mounts +${configuration.isolation.read_mounts ?? 0}ro/+${configuration.isolation.write_mounts ?? 0}rw` : ''}`
      : undefined,
    configuration.loops
      ? configuration.loops.source === 'omitted'
        ? 'temporary loops omitted (legacy behavior)'
        : configuration.loops.entries.length === 0
          ? `temporary loops disabled (source ${configuration.loops.source})`
          : `temporary loops ${configuration.loops.entries.map(loop => `${loop.name}:${loop.enabled ? 'enabled' : 'disabled'}`
            + ` interval=${loop.intervalMs}ms delay=${loop.initialDelayMs}ms jitter=${loop.jitterMs}ms`
            + ` prompt=${loop.prompt.bytes}B/${loop.prompt.sha256.slice(0, 12)}`).join(', ')}; policy skip-if-busy; source ${configuration.loops.source}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
}

/**
 * Validity condition of a current-v1 configuration: its complete mandatory
 * rendering fits the per-line budget with the optional-omission suffix
 * reserved. Escaping and code-fence growth (a value made of backticks can
 * more than triple its code span) make this depend on rendered size, not raw
 * field lengths, so both summarizeResolvedLaunch and the wire validator call
 * this instead of trusting per-field caps.
 */
export function mandatoryConfigurationFits(configuration: AgentLaunchConfiguration): boolean {
  const reserved = `${mandatoryComponents(configuration).join('; ')}${OPTIONAL_OMISSION_SUFFIX}`;
  return codePoints(reserved) <= AGENT_LINE_MAX_CODE_POINTS && utf8(reserved) <= AGENT_LINE_MAX_BYTES;
}

/**
 * Render one agent's configuration as a single escaped Markdown line segment.
 * This is the only escaping boundary: callers pass raw values and must not
 * escape the result again (it is safe as a markdownItems entry and inside
 * owner-channel lifecycle messages). Every mandatory component always
 * renders — mandatoryConfigurationFits guarantees the fit for every produced
 * or wire-accepted configuration; only optional components may be dropped,
 * whole (never splitting a Markdown span), with a visible `…`.
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
  let line = mandatoryComponents(configuration).join('; ');
  let omitted = false;
  for (const part of optionalComponents(configuration)) {
    const next = `${line}; ${part}`;
    if (codePoints(`${next}${OPTIONAL_OMISSION_SUFFIX}`) > AGENT_LINE_MAX_CODE_POINTS
        || utf8(`${next}${OPTIONAL_OMISSION_SUFFIX}`) > AGENT_LINE_MAX_BYTES) { omitted = true; continue; }
    line = next;
  }
  return omitted ? `${line}${OPTIONAL_OMISSION_SUFFIX}` : line;
}
