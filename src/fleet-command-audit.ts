import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { replaceFileAtomically } from './atomic-file.js';
import { isSensitiveConfigKey } from './sensitive-config.js';
import {
  mandatoryConfigurationFits, renderAgentConfiguration, type AgentLaunchConfiguration,
} from './lifecycle-summary.js';
import {
  MARKDOWN_MAX_BYTES, MARKDOWN_MAX_CODE_POINTS, markdownCode, markdownProse,
} from './rooms-tasks/markdown.js';

export type FleetCommandDecision = 'allow' | 'deny' | 'unsupported';
export type FleetCommandOutcomeClass =
  | 'success' | 'validation' | 'denied' | 'runtime' | 'timeout' | 'proxy' | 'delivery';

export class FleetCliExit extends Error {
  constructor(readonly exitCode: number, readonly outcomeClass: FleetCommandOutcomeClass = 'runtime',
    readonly effect: 'not_started' | 'completed' | 'unknown' = 'unknown') {
    super(`fleet CLI exited ${exitCode}`);
  }
}

export type FleetAuditPresentation =
  | { kind: 'agent_started'; eventId: string; id: string; name: string; lifetime: 'permanent' | 'temporary'; brain: string;
      role: string; harness: string; session: 'acp'; model?: string; permissions?: string;
      parent: string; actionId: string; inherited: string[];
      configuration?: AgentLaunchConfiguration }
  | { kind: 'task'; operation: 'create' | 'start' | 'work' | 'block' | 'unblock' | 'review'
      | 'done' | 'cancel' | 'finish' | 'delete' | 'settling'; eventId: string; id: string; title?: string; previousState?: string;
      newState: string; template?: string; roomId?: string;
      revision?: string; list?: string;
      agents: Array<{ name: string; brain?: string; role: string; permissions?: string;
        configuration?: AgentLaunchConfiguration }> }
  | { kind: 'room'; operation: 'create' | 'activate' | 'close' | 'delete';
      eventId: string; id: string; previousState?: string; newState: string;
      revision?: string; name?: string; template?: string; taskId?: string;
      participants: Array<{ name: string; id?: string; brain?: string; role: string; permissions?: string;
        configuration?: AgentLaunchConfiguration }> }
  | { kind: 'lifecycle_failure'; eventId: string; resource: 'Agent' | 'Task' | 'Room'; id: string; state: string;
      category: 'provision_failed' | 'provision_pending' | 'readiness_failed' | 'settlement_failed' | 'settlement_pending'
        | 'cleanup_failed' | 'cleanup_pending' };

/** Commands are Owner-silent unless they record one of these semantic lifecycle kinds. */
export const FLEET_LIFECYCLE_EVENT_KINDS = Object.freeze([
  'agent_started', 'task', 'room', 'lifecycle_failure',
] as const);

/** Stable semantic dedupe basis: resource kind + stable resource ID + transition/action ID. */
export function lifecycleEventDigestBasis(value: FleetAuditPresentation): string {
  const resourceKind = value.kind === 'lifecycle_failure' ? value.resource : value.kind;
  return `${resourceKind}\0${value.id}\0${value.eventId}`;
}

let collection: { resourceIds: Record<string, string>; presentations: FleetAuditPresentation[];
  failure?: { class: FleetCommandOutcomeClass; effect: 'not_started' | 'completed' | 'unknown' } } | undefined;
export function beginFleetAuditCollection(): void { collection = { resourceIds: {}, presentations: [] }; }
export function recordFleetAuditResource(kind: 'agent' | 'task' | 'room', id: string | undefined): void {
  if (id && collection) collection.resourceIds[kind] = id;
}
type FleetAuditPresentationInput = FleetAuditPresentation extends infer T
  ? T extends FleetAuditPresentation ? Omit<T, 'eventId'> & { eventId?: string } : never : never;
export function recordFleetAuditPresentation(value: FleetAuditPresentationInput): void {
  if (collection && (FLEET_LIFECYCLE_EVENT_KINDS as readonly string[]).includes(value.kind)) {
    const basis = value.eventId ?? (value.kind === 'agent_started' ? value.actionId
      : value.kind === 'task' || value.kind === 'room'
        ? `${value.operation}:${value.revision ?? `${value.previousState ?? 'none'}:${value.newState}`}`
        : `${value.category}:${value.state}`);
    collection.presentations.push(structuredClone({ ...value, eventId: basis }));
    if (value.kind === 'task') collection.resourceIds.task = value.id;
    if (value.kind === 'room') collection.resourceIds.room = value.id;
    if (value.kind === 'agent_started') collection.resourceIds.agent = value.id;
  }
}
export function recordFleetAuditFailure(
  failure: { class: FleetCommandOutcomeClass; effect: 'not_started' | 'completed' | 'unknown' },
): void { if (collection) collection.failure = failure; }
export function consumeFleetAuditCollection(): { resourceIds?: Record<string, string>;
  presentations?: FleetAuditPresentation[]; failure?: { class: FleetCommandOutcomeClass;
    effect: 'not_started' | 'completed' | 'unknown' } } {
  const current = collection; collection = undefined;
  return {
    ...(current && Object.keys(current.resourceIds).length ? { resourceIds: current.resourceIds } : {}),
    ...(current?.presentations.length ? { presentations: current.presentations } : {}),
    ...(current?.failure ? { failure: current.failure } : {}),
  };
}

export interface FleetCommandClassification {
  command: string;
  route: string;
  decision: FleetCommandDecision;
}

export interface FleetAuditAttempt {
  version: 1;
  correlationId: string;
  requestId: string;
  caller: string;
  invokedAt: string;
  classification: FleetCommandClassification;
  argv: string[];
  invocation: 'sending' | 'delivered' | 'uncertain';
  outcome?: {
    completedAt: string;
    class: FleetCommandOutcomeClass;
    exitCode?: number;
    effect: 'not_started' | 'completed' | 'unknown';
    delivery: 'sending' | 'delivered' | 'uncertain';
    resourceIds?: Record<string, string>;
    presentations?: FleetAuditPresentation[];
  };
}

const SAFE_READ = new Set(['docs', 'version', 'config', 'ls', 'peek', 'logs', 'status', 'doctor']);
const AGENT_SURFACES: Record<string, ReadonlySet<string>> = {
  spawn: new Set(['<none>']),
  template: new Set(['list', 'show', 'validate']),
  task: new Set(['create', 'list', 'lists', 'list-create', 'list-rename', 'list-delete', 'move',
    'show', 'start', 'block', 'unblock', 'review', 'done', 'cancel', 'delete', 'recover', 'work', 'finish']),
  room: new Set(['create', 'list', 'show', 'open', 'members', 'delete', 'close', 'recover']),
};
export const fleetProxyCommandInventory = Object.freeze(Object.fromEntries(
  Object.entries(AGENT_SURFACES).map(([surface, commands]) => [surface, [...commands]])));
const DENIED = new Set([
  'up', 'down', 'restart', 'force-restart', 'attach', 'send', 'loops', 'owner-channel',
  'watchdog-run', 'watchdog-report', 'rm', 'init', 'migrate-agent-templates', 'migrate-role-defaults', 'web',
]);
export const fleetProxyTopLevelInventory = Object.freeze({
  safeRead: [...SAFE_READ], agent: Object.keys(AGENT_SURFACES), public: [
    'up', 'down', 'restart', 'force-restart', 'attach', 'send', 'loops', 'owner-channel',
    'watchdog-run', 'watchdog-report', 'rm', 'init', 'web',
  ], denied: [...DENIED],
  hidden: ['_run', '_run-temp', '_run-watchdog', '_run-watchdogs'], aliases: ['man'],
});

const globalValueOptions = new Set(['-c', '--configuration']);

/** Classify before Commander parsing. Unknown and internal paths fail closed. */
export function classifyFleetArgv(argv: readonly string[]): FleetCommandClassification {
  let command = '';
  let commandIndex = -1;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') { command = argv[index + 1] ?? ''; commandIndex = index + 1; break; }
    if (globalValueOptions.has(arg)) { index++; continue; }
    if (arg.startsWith('--configuration=') || arg.startsWith('-c=')) continue;
    if (arg.startsWith('-c') && arg.length > 2) continue;
    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V')
      return { command: arg, route: 'supervisor-proxy/read-only', decision: 'allow' };
    if (!arg.startsWith('-')) { command = arg; commandIndex = index; break; }
  }
  if (!command)
    return { command: '<none>', route: 'supervisor-proxy/unsupported', decision: 'unsupported' };
  if (command.startsWith('_'))
    return { command, route: 'supervisor-proxy/internal', decision: 'deny' };
  if (SAFE_READ.has(command) || command === 'man')
    return { command, route: 'supervisor-proxy/read-only', decision: 'allow' };
  if (AGENT_SURFACES[command]) {
    const sub = argv[commandIndex + 1] ?? '<none>';
    if (sub === '--help' || sub === '-h')
      return { command: `${command} ${sub}`, route: 'supervisor-proxy/read-only', decision: 'allow' };
    if (sub.startsWith('_'))
      return { command: `${command} ${sub}`, route: 'supervisor-proxy/internal', decision: 'deny' };
    if (command !== 'spawn' && !AGENT_SURFACES[command]!.has(sub))
      return { command: `${command} ${sub}`, route: `supervisor-proxy/${command}`, decision: 'allow' };
    return { command: sub.startsWith('-') ? command : `${command} ${sub}`,
      route: `supervisor-proxy/${command}`, decision: 'allow' };
  }
  // The proxy is attribution and routing, not a product permission boundary.
  // Commander validates every public command. Hidden process entry points above
  // remain guarded because recursively invoking them breaks the supervisor protocol.
  return { command, route: 'supervisor-proxy/public', decision: 'allow' };
}

const marker = (value: string): string => value === '' ? '[REDACTED:empty]' : '[REDACTED:value]';
const sensitiveValueFlags = new Set([
  '--identity', '--invite', '--token', '--api-token', '--password', '--password-file',
  '--env', '--brief', '--brief-file', '--bio-file', '--persona-file', '--isolation-file',
  '--configuration', '-c', '--public-invite', '--public-invite-file', '--invite-file',
  '--summary-file', '--text', '--message', '--summary', '--reason', '--goal', '--cwd',
  '--identity-cid', '--owner-cid', '--contact-cid', '--codex-config', '--add-dir',
]);

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    if (url.username || url.password) { url.username = 'REDACTED'; url.password = 'REDACTED'; changed = true; }
    for (const key of [...url.searchParams.keys()])
      if (isSensitiveConfigKey(key)) { url.searchParams.set(key, marker(url.searchParams.get(key) ?? '')); changed = true; }
    return changed ? url.toString() : value;
  } catch { return value; }
}

function redactInline(value: string): string {
  if (!value.startsWith('inline:')) return redactUrl(value);
  const source = value.slice('inline:'.length);
  try {
    const parsed = JSON.parse(source) as unknown;
    const walk = (node: unknown, key?: string): unknown => {
      if (key && isSensitiveConfigKey(key)) return typeof node === 'string' ? marker(node) : '[REDACTED:value]';
      if (Array.isArray(node)) return node.map(child => walk(child));
      if (node && typeof node === 'object') return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([childKey, child]) =>
          [childKey, walk(child, childKey)]));
      return typeof node === 'string' ? redactUrl(node) : node;
    };
    return `inline:${JSON.stringify(walk(parsed))}`;
  } catch { return 'inline:[REDACTED:invalid-definition]'; }
}

/** Faithful ordered argv with deterministic structural redaction. */
export function redactFleetArgv(argv: readonly string[]): string[] {
  const result = [...argv];
  for (let index = 0; index < result.length; index++) {
    const arg = result[index]!;
    if (arg.startsWith('-c=') || (arg.startsWith('-c') && arg.length > 2 && !arg.startsWith('--')) ) {
      const prefix = arg.startsWith('-c=') ? '-c=' : '-c';
      result[index] = `${prefix}${marker(arg.slice(prefix.length))}`; continue;
    }
    const equal = /^(--[^=]+)=(.*)$/su.exec(arg);
    if (equal && sensitiveValueFlags.has(equal[1]!)) { result[index] = `${equal[1]}=${marker(equal[2]!)}`; continue; }
    if (sensitiveValueFlags.has(arg) && index + 1 < result.length) {
      result[index + 1] = marker(result[index + 1]!); index++; continue;
    }
    result[index] = redactInline(arg);
  }
  // `send <role> <text...>` has positional content. Locate it using the same
  // global-option scan as classification, never absolute argv offsets.
  let commandIndex = -1;
  for (let index = 0; index < result.length; index++) {
    const arg = result[index]!;
    if (globalValueOptions.has(arg)) { index++; continue; }
    if (arg.startsWith('--configuration=') || arg.startsWith('-c=') || (arg.startsWith('-c') && arg.length > 2)) continue;
    if (!arg.startsWith('-')) { commandIndex = index; break; }
  }
  if (result[commandIndex] === 'send')
    for (let index = commandIndex + 2; index < result.length; index++) result[index] = marker(result[index]!);
  return result;
}

interface AuditFile { version: 1; attempts: FleetAuditAttempt[] }

/** Durable write-once attempt ledger; contains redacted argv only. */
export class FleetCommandAuditStore {
  private attempts: FleetAuditAttempt[] = [];
  constructor(private readonly path: string, private readonly deps: {
    now(): Date; uuid(): string;
  } = { now: () => new Date(), uuid: () => randomUUID() }) {
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AuditFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.attempts)) throw new Error('invalid fleet command audit ledger');
    this.attempts = parsed.attempts;
    let recovered = false;
    for (const attempt of this.attempts) {
      if (attempt.invocation === 'sending') { attempt.invocation = 'uncertain'; recovered = true; }
      if (attempt.outcome?.delivery === 'sending') { attempt.outcome.delivery = 'uncertain'; recovered = true; }
    }
    if (recovered) this.persist();
  }
  list(): readonly FleetAuditAttempt[] { return this.attempts.map(item => structuredClone(item)); }
  begin(requestId: string, caller: string, argv: readonly string[]): FleetAuditAttempt {
    const existing = this.attempts.find(item => item.caller === caller && item.requestId === requestId);
    if (existing) {
      if (JSON.stringify(existing.argv) !== JSON.stringify(redactFleetArgv(argv)))
        throw new Error('fleet command request ID was reused with different argv');
      return structuredClone(existing);
    }
    const attempt: FleetAuditAttempt = { version: 1, correlationId: this.deps.uuid(), requestId,
      caller, invokedAt: this.deps.now().toISOString(), classification: classifyFleetArgv(argv),
      argv: redactFleetArgv(argv), invocation: 'sending' };
    this.attempts.push(attempt); this.persist(); return structuredClone(attempt);
  }
  invocation(correlationId: string, caller: string, delivery: 'delivered' | 'uncertain'): FleetAuditAttempt {
    const attempt = this.owned(correlationId, caller);
    if (attempt.invocation !== 'sending' && attempt.invocation !== delivery)
      throw new Error('conflicting fleet command invocation delivery state');
    attempt.invocation = delivery; this.persist();
    return structuredClone(attempt);
  }
  finish(correlationId: string, caller: string, outcome: Omit<NonNullable<FleetAuditAttempt['outcome']>, 'completedAt' | 'delivery'>): FleetAuditAttempt {
    const attempt = this.owned(correlationId, caller);
    if (!attempt.outcome) attempt.outcome = { ...outcome, completedAt: this.deps.now().toISOString(), delivery: 'sending' };
    else {
      const prior = { class: attempt.outcome.class, effect: attempt.outcome.effect,
        ...(attempt.outcome.exitCode === undefined ? {} : { exitCode: attempt.outcome.exitCode }),
        ...(attempt.outcome.resourceIds ? { resourceIds: attempt.outcome.resourceIds } : {}),
        ...(attempt.outcome.presentations ? { presentations: attempt.outcome.presentations } : {}) };
      if (JSON.stringify(prior) !== JSON.stringify(outcome))
        throw new Error('conflicting fleet command outcome for existing correlation');
    }
    this.persist(); return structuredClone(attempt);
  }
  outcome(correlationId: string, caller: string, delivery: 'delivered' | 'uncertain'): FleetAuditAttempt {
    const attempt = this.owned(correlationId, caller);
    if (!attempt.outcome) throw new Error('fleet command audit outcome was not recorded');
    if (attempt.outcome.delivery !== 'sending' && attempt.outcome.delivery !== delivery)
      throw new Error('conflicting fleet command outcome delivery state');
    attempt.outcome.delivery = delivery; this.persist(); return structuredClone(attempt);
  }
  private owned(correlationId: string, caller: string): FleetAuditAttempt {
    const attempt = this.attempts.find(item => item.correlationId === correlationId);
    if (!attempt || attempt.caller !== caller) throw new Error('unknown or cross-role fleet command correlation');
    return attempt;
  }
  private persist(): void {
    replaceFileAtomically(this.path, `${JSON.stringify({ version: 1, attempts: this.attempts } satisfies AuditFile)}\n`, 0o600);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_RESOURCE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:@-]{0,159}$/u;
const OUTCOMES = new Set<FleetCommandOutcomeClass>(
  ['success', 'validation', 'denied', 'runtime', 'timeout', 'proxy', 'delivery']);
const EFFECTS = new Set(['not_started', 'completed', 'unknown']);
export function validateFleetAuditBegin(value: unknown): asserts value is { requestId: string; argv: string[] } {
  const input = value as { requestId?: unknown; argv?: unknown } | undefined;
  if (!input || Object.keys(input).some(key => !['requestId', 'argv'].includes(key))
      || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
      || !Array.isArray(input.argv) || input.argv.length > 256
      || !input.argv.every(arg => typeof arg === 'string' && Buffer.byteLength(arg) <= 16_384)
      || Buffer.byteLength(JSON.stringify(input.argv)) > 48 * 1024)
    throw new Error('invalid fleet audit begin fields');
}
export function validateFleetAuditFinish(value: unknown): asserts value is {
  correlationId: string; class: FleetCommandOutcomeClass; exitCode?: number;
  effect: 'not_started' | 'completed' | 'unknown'; resourceIds?: Record<string, string>;
  presentations?: FleetAuditPresentation[];
} {
  const input = value as Record<string, unknown> | undefined;
  const allowed = ['correlationId', 'class', 'exitCode', 'effect', 'resourceIds', 'presentations'];
  const resources = input?.resourceIds;
  if (!input || Object.keys(input).some(key => !allowed.includes(key))
      || typeof input.correlationId !== 'string' || !UUID.test(input.correlationId)
      || !OUTCOMES.has(input.class as FleetCommandOutcomeClass) || !EFFECTS.has(String(input.effect))
      || (input.exitCode !== undefined && (!Number.isSafeInteger(input.exitCode) || Number(input.exitCode) < 0 || Number(input.exitCode) > 255))
      || (resources !== undefined && (!resources || typeof resources !== 'object' || Array.isArray(resources)
        || Object.entries(resources).some(([key, id]) => !['agent', 'task', 'room'].includes(key)
          || typeof id !== 'string' || !SAFE_RESOURCE_ID.test(id))))
      || (input.presentations !== undefined && (!Array.isArray(input.presentations)
        || input.presentations.length > 128 || !input.presentations.every(validPresentation))))
    throw new Error('invalid fleet audit finish fields');
}

const APPROVAL_MODES = new Set(['ask', 'auto', 'allow', 'deny']);
const FILESYSTEM_MODES = new Set(['read-only', 'workspace', 'unrestricted']);
const UNATTENDED_MODES = new Set(['deny', 'wait']);
const FLEET_PERMISSION_MODES = new Set(['ask', 'auto', 'allow']);
const PRESENTATION_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Exact-key validation of a current-version launch configuration. A partial
 * v1 configuration is rejected; a legacy presentation simply omits the field.
 */
function validConfiguration(value: unknown): value is AgentLaunchConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const text = (v: unknown, max = 256) => typeof v === 'string' && v.length <= max
    && !PRESENTATION_TEXT.test(v);
  const exact = (record: Record<string, unknown>, keys: string[]) =>
    Object.keys(record).every(key => keys.includes(key));
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const origin = (v: unknown): boolean => {
    if (!record(v)) return false;
    if (v.kind === 'named') return exact(v, ['kind', 'ref']) && text(v.ref, 160);
    if (v.kind === 'inline') return exact(v, ['kind', 'fingerprint'])
      && (v.fingerprint === undefined || (typeof v.fingerprint === 'string' && /^[a-f0-9]{12}$/.test(v.fingerprint)));
    return v.kind === 'unknown' && exact(v, ['kind']);
  };
  const count = (v: unknown) => v === undefined
    || (Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 4_096);
  return exact(c, ['version', 'template', 'role', 'brain', 'harness', 'session', 'model',
    'effort', 'mission', 'approval', 'filesystem', 'unattended', 'permissionMode', 'monitor', 'isolation'])
    && c.version === 1 && origin(c.role) && origin(c.brain)
    && text(c.harness, 64) && c.session === 'acp'
    && (c.model === null || text(c.model, 160))
    && (c.template === undefined || text(c.template, 160))
    && (c.effort === undefined || text(c.effort, 32))
    // The builder caps the mission label at 80 code points; enforce the same
    // invariant here so the per-line budget proof holds for wire input too.
    && (c.mission === undefined || (text(c.mission) && Array.from(String(c.mission)).length <= 80))
    && APPROVAL_MODES.has(String(c.approval))
    && FILESYSTEM_MODES.has(String(c.filesystem))
    && UNATTENDED_MODES.has(String(c.unattended))
    && record(c.permissionMode)
    && exact(c.permissionMode, ['fleetMode', 'nativeMode'])
    && FLEET_PERMISSION_MODES.has(String(c.permissionMode.fleetMode))
    && text(c.permissionMode.nativeMode, 160)
    && record(c.monitor) && exact(c.monitor, ['mode', 'interrupt'])
    && ['fleet', 'native'].includes(String(c.monitor.mode))
    && (typeof c.monitor.interrupt === 'boolean' || c.monitor.interrupt === 'after_tool')
    && (c.isolation === undefined || (record(c.isolation)
      && exact(c.isolation, ['requested', 'on_unavailable', 'network', 'read_mounts', 'write_mounts'])
      && ['auto', 'bubblewrap', 'podman', 'none'].includes(String(c.isolation.requested))
      && (c.isolation.on_unavailable === undefined || ['warn', 'strict'].includes(String(c.isolation.on_unavailable)))
      && (c.isolation.network === undefined || ['broker', 'deny', 'allow', 'allowlist'].includes(String(c.isolation.network)))
      && count(c.isolation.read_mounts) && count(c.isolation.write_mounts)))
    // Escaping and code-fence growth can push a per-field-valid configuration
    // past the line budget; a v1 configuration whose complete mandatory
    // rendering cannot fit is invalid, never silently trimmed.
    && mandatoryConfigurationFits(c as unknown as AgentLaunchConfiguration);
}

function validPresentation(value: unknown): value is FleetAuditPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const configured = (record: Record<string, unknown>) =>
    record.configuration === undefined || validConfiguration(record.configuration);
  const safe = (v: unknown) => typeof v === 'string' && SAFE_RESOURCE_ID.test(v);
  const text = (v: unknown) => typeof v === 'string' && v.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
  const exact = (record: Record<string, unknown>, keys: string[]) =>
    Object.keys(record).every(key => keys.includes(key));
  const transition = (allowed: Record<string, readonly string[]>) =>
    typeof p.operation === 'string' && typeof p.newState === 'string'
      && allowed[p.operation]?.includes(`${String(p.previousState ?? 'none')}→${p.newState}`);
  if (p.kind === 'agent_started') return exact(p, ['kind', 'eventId', 'id', 'name', 'lifetime', 'brain', 'role',
    'harness', 'session', 'model', 'permissions', 'parent', 'actionId', 'inherited', 'configuration'])
    && safe(p.eventId) && safe(p.id) && safe(p.name) && ['permanent', 'temporary'].includes(String(p.lifetime))
    && text(p.brain) && text(p.role) && safe(p.harness) && p.session === 'acp' && safe(p.parent) && safe(p.actionId)
    && (p.model === undefined || text(p.model)) && (p.permissions === undefined || text(p.permissions))
    && Array.isArray(p.inherited) && p.inherited.every(text) && configured(p);
  if (p.kind === 'task') return exact(p, ['kind', 'operation', 'eventId', 'id', 'title', 'previousState',
    'newState', 'template', 'roomId', 'revision', 'list', 'agents'])
    && ['create', 'start', 'work', 'block', 'unblock', 'review', 'done',
      'cancel', 'finish', 'delete', 'settling'].includes(String(p.operation)) && safe(p.eventId) && safe(p.id) && safe(p.newState)
    && transition({ create: ['none→backlog', 'none→provisioning', 'none→active'],
      start: ['backlog→provisioning'], work: ['provisioning→active'],
      block: ['backlog→backlog', 'provisioning→provisioning', 'active→active', 'review→review'],
      unblock: ['backlog→backlog', 'provisioning→provisioning', 'active→active', 'review→review'],
      review: ['active→review'], done: ['review→done'], finish: ['active→done', 'review→done'],
      cancel: ['backlog→cancelled', 'provisioning→cancelled', 'active→cancelled', 'review→cancelled'],
      delete: [
        'backlog→deleting', 'provisioning→deleting', 'active→deleting', 'review→deleting',
        'done→deleting', 'cancelled→deleting', 'failed→deleting',
        'backlog→deleted', 'provisioning→deleted', 'active→deleted', 'review→deleted',
        'done→deleted', 'cancelled→deleted', 'failed→deleted',
      ], settling: ['active→active', 'review→review', 'backlog→backlog',
        'provisioning→provisioning'] })
    && (p.title === undefined || text(p.title)) && (p.previousState === undefined || safe(p.previousState))
    && (p.template === undefined || text(p.template)) && (p.roomId === undefined || safe(p.roomId))
    && (p.list === undefined || text(p.list)) && (p.revision === undefined || text(p.revision))
    && Array.isArray(p.agents) && p.agents.length <= 64
    && p.agents.every(a => a && typeof a === 'object'
      && exact(a as Record<string, unknown>, ['name', 'brain', 'role', 'permissions', 'configuration'])
      && safe((a as Record<string, unknown>).name)
      && text((a as Record<string, unknown>).role)
      && ((a as Record<string, unknown>).brain === undefined || text((a as Record<string, unknown>).brain))
      && ((a as Record<string, unknown>).permissions === undefined || text((a as Record<string, unknown>).permissions))
      && configured(a as Record<string, unknown>));
  if (p.kind === 'room') return exact(p, ['kind', 'operation', 'eventId', 'id', 'previousState', 'newState',
    'revision', 'name', 'template', 'taskId', 'participants'])
    && ['create', 'activate', 'close', 'delete'].includes(String(p.operation))
    && safe(p.eventId) && safe(p.id) && safe(p.newState)
    && transition({ create: ['none→provisioning'], activate: ['provisioning→active'],
      close: ['active→closing', 'provisioning→closing'],
      delete: ['closing→deleted'] })
    && (p.previousState === undefined || safe(p.previousState))
    && (p.name === undefined || text(p.name)) && (p.template === undefined || text(p.template))
    && (p.taskId === undefined || safe(p.taskId)) && (p.revision === undefined || text(p.revision))
    && Array.isArray(p.participants) && p.participants.length <= 64
    && p.participants.every(a => a && typeof a === 'object'
      && exact(a as Record<string, unknown>, ['name', 'id', 'brain', 'role', 'permissions', 'configuration'])
      && safe((a as Record<string, unknown>).name)
      && text((a as Record<string, unknown>).role)
      && ((a as Record<string, unknown>).id === undefined || safe((a as Record<string, unknown>).id))
      && ((a as Record<string, unknown>).brain === undefined || text((a as Record<string, unknown>).brain))
      && ((a as Record<string, unknown>).permissions === undefined || text((a as Record<string, unknown>).permissions))
      && configured(a as Record<string, unknown>));
  if (p.kind === 'lifecycle_failure') return exact(p, ['kind', 'eventId', 'resource', 'id', 'state', 'category'])
    && ['Agent', 'Task', 'Room'].includes(String(p.resource))
    && safe(p.eventId) && safe(p.id) && safe(p.state) && ['provision_failed', 'provision_pending', 'readiness_failed', 'settlement_failed',
      'settlement_pending', 'cleanup_failed', 'cleanup_pending'].includes(String(p.category));
  return false;
}

const messageCodePoints = (value: string): number => Array.from(value).length;
const messageBytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const withinMessageBounds = (value: string): boolean =>
  messageCodePoints(value) <= MARKDOWN_MAX_CODE_POINTS && messageBytes(value) <= MARKDOWN_MAX_BYTES;

/**
 * Append per-agent lines to a bounded message. Lines are admitted whole, in
 * the given (deterministic) order; once the shared Markdown bounds would be
 * exceeded the remaining agents collapse into an accurate omission note. The
 * first line is admitted whenever it fits the absolute bounds so an oversized
 * roster still shows at least one complete agent summary.
 */
function appendAgentLines(header: string, heading: string, lines: string[]): string {
  if (!lines.length) return header;
  let message = `${header}\n${heading}:`;
  const note = (count: number): string => `\n…and ${count} more agent${count === 1 ? '' : 's'} omitted.`;
  for (const [index, line] of lines.entries()) {
    const candidate = `${message}\n- ${line}`;
    const remaining = lines.length - index - 1;
    // A candidate is admitted only when it fits together with the note for
    // every agent still pending, so each stop-return below re-states a bound
    // that was verified when the current message was admitted.
    if (!withinMessageBounds(remaining ? `${candidate}${note(remaining)}` : candidate)) {
      const stopped = `${message}${note(lines.length - index)}`;
      return withinMessageBounds(stopped) ? stopped : `${header}${note(lines.length)}`;
    }
    message = candidate;
  }
  return message;
}

/** Compact Owner presentation. It intentionally has no command, argv, environment, or correlation data. */
export function renderFleetLifecycleEvent(value: FleetAuditPresentation): string {
  if (value.kind === 'lifecycle_failure') {
    const actions = {
      provision_failed: 'Inspect Fleet service logs, correct configuration, then recover the resource.',
      provision_pending: 'Run Task or Room recover after checking member readiness.',
      readiness_failed: 'Inspect the Agent log, correct its configuration, then retry creation.',
      settlement_failed: 'Inspect Fleet service logs, then run Task recover.',
      settlement_pending: 'Run Task recover to continue settlement.',
      cleanup_failed: 'Inspect Fleet service logs, then run Room recover.',
      cleanup_pending: 'Run Room recover to continue cleanup.',
    } as const;
    const lifecycle = value.category.endsWith('_pending') ? 'lifecycle pending' : 'lifecycle failure';
    return `⚠️ ${value.resource} ${value.id} ${lifecycle} (${value.category}); `
      + `state ${value.state}. Action: ${actions[value.category]}`;
  }
  if (value.kind === 'agent_started') {
    const summary = renderAgentConfiguration(value.configuration, {
      role: value.role, brain: value.brain, permissions: value.permissions,
    });
    return `🧑‍💻 ${value.parent} spawned ${value.lifetime} Agent ${value.name} (${value.id}) — ready. `
      + `${summary}.`;
  }
  if (value.kind === 'task') {
    const title = value.title ? ` “${markdownProse(value.title)}”` : '';
    const context = [value.list ? `List ${markdownCode(value.list)}` : undefined,
      value.template ? `template ${markdownCode(value.template)}` : undefined,
      value.roomId ? `Room ${value.roomId}` : undefined].filter(Boolean).join('; ');
    const header = `📋 Task${title} (${value.id}) ${value.operation}: `
      + `${value.previousState ?? 'none'} → ${value.newState}.${context ? ` ${context}.` : ''}`;
    return appendAgentLines(header, 'Agents', value.agents.map(agent =>
      `${markdownCode(agent.name)}: ${renderAgentConfiguration(agent.configuration, {
        role: agent.role, brain: agent.brain, permissions: agent.permissions,
      })}`));
  }
  const context = [value.template ? `template ${markdownCode(value.template)}` : undefined,
    value.taskId ? `Task ${value.taskId}` : undefined].filter(Boolean).join('; ');
  const header = `🏠 Room${value.name ? ` “${markdownProse(value.name)}”` : ''} (${value.id}) ${value.operation}: `
    + `${value.previousState ?? 'none'} → ${value.newState}.${context ? ` ${context}.` : ''}`;
  return appendAgentLines(header, 'Participants', value.participants.map(participant =>
    `${markdownCode(participant.name)}${participant.id ? ` (${participant.id})` : ''}: `
      + renderAgentConfiguration(participant.configuration, {
        role: participant.role, brain: participant.brain, permissions: participant.permissions,
      })));
}
