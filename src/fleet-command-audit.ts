import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from './atomic-file.js';
import { isSensitiveConfigKey } from './sensitive-config.js';

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
  | { kind: 'agent_started'; name: string; lifetime: 'permanent' | 'temporary'; brain: string;
      role: string; harness: string; session: 'acp'; model?: string; permissions?: string;
      parent: string; actionId: string; inherited: string[] }
  | { kind: 'task'; operation: string; id: string; title?: string; previousState?: string;
      newState: string; template?: string; roomId?: string;
      agents: Array<{ name: string; brain?: string; role: string }> }
  | { kind: 'room'; operation: string; id: string; previousState?: string; newState: string;
      template?: string; participants: Array<{ name: string; role: string }> };

let collection: { resourceIds: Record<string, string>; presentation?: FleetAuditPresentation;
  failure?: { class: FleetCommandOutcomeClass; effect: 'not_started' | 'completed' | 'unknown' } } | undefined;
export function beginFleetAuditCollection(): void { collection = { resourceIds: {} }; }
export function recordFleetAuditResource(kind: 'agent' | 'task' | 'room', id: string | undefined): void {
  if (id && collection) collection.resourceIds[kind] = id;
}
export function recordFleetAuditPresentation(value: FleetAuditPresentation): void {
  if (collection) collection.presentation = structuredClone(value);
}
export function recordFleetAuditFailure(
  failure: { class: FleetCommandOutcomeClass; effect: 'not_started' | 'completed' | 'unknown' },
): void { if (collection) collection.failure = failure; }
export function consumeFleetAuditCollection(): { resourceIds?: Record<string, string>;
  presentation?: FleetAuditPresentation; failure?: { class: FleetCommandOutcomeClass;
    effect: 'not_started' | 'completed' | 'unknown' } } {
  const current = collection; collection = undefined;
  return {
    ...(current && Object.keys(current.resourceIds).length ? { resourceIds: current.resourceIds } : {}),
    ...(current?.presentation ? { presentation: current.presentation } : {}),
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
    presentation?: FleetAuditPresentation;
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
  'watchdog-run', 'watchdog-report', 'rm', 'init', 'web',
]);
export const fleetProxyTopLevelInventory = Object.freeze({
  safeRead: [...SAFE_READ], agent: Object.keys(AGENT_SURFACES), denied: [...DENIED],
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
      return { command: `${command} ${sub}`, route: 'supervisor-proxy/unsupported', decision: 'unsupported' };
    return { command: sub.startsWith('-') ? command : `${command} ${sub}`,
      route: `supervisor-proxy/${command}`, decision: 'allow' };
  }
  if (DENIED.has(command))
    return { command, route: 'supervisor-proxy/permission-denied', decision: 'deny' };
  return { command, route: 'supervisor-proxy/unsupported', decision: 'unsupported' };
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
        ...(attempt.outcome.presentation ? { presentation: attempt.outcome.presentation } : {}) };
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
  presentation?: FleetAuditPresentation;
} {
  const input = value as Record<string, unknown> | undefined;
  const allowed = ['correlationId', 'class', 'exitCode', 'effect', 'resourceIds', 'presentation'];
  const resources = input?.resourceIds;
  if (!input || Object.keys(input).some(key => !allowed.includes(key))
      || typeof input.correlationId !== 'string' || !UUID.test(input.correlationId)
      || !OUTCOMES.has(input.class as FleetCommandOutcomeClass) || !EFFECTS.has(String(input.effect))
      || (input.exitCode !== undefined && (!Number.isSafeInteger(input.exitCode) || Number(input.exitCode) < 0 || Number(input.exitCode) > 255))
      || (resources !== undefined && (!resources || typeof resources !== 'object' || Array.isArray(resources)
        || Object.entries(resources).some(([key, id]) => !['agent', 'task', 'room'].includes(key)
          || typeof id !== 'string' || !SAFE_RESOURCE_ID.test(id))))
      || (input.presentation !== undefined && !validPresentation(input.presentation)))
    throw new Error('invalid fleet audit finish fields');
}

function validPresentation(value: unknown): value is FleetAuditPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const safe = (v: unknown) => typeof v === 'string' && SAFE_RESOURCE_ID.test(v);
  const text = (v: unknown) => typeof v === 'string' && v.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
  if (p.kind === 'agent_started') return safe(p.name) && ['permanent', 'temporary'].includes(String(p.lifetime))
    && text(p.brain) && text(p.role) && safe(p.harness) && p.session === 'acp' && safe(p.parent) && safe(p.actionId)
    && (p.model === undefined || text(p.model)) && (p.permissions === undefined || text(p.permissions))
    && Array.isArray(p.inherited) && p.inherited.every(text);
  if (p.kind === 'task') return safe(p.operation) && safe(p.id) && safe(p.newState)
    && (p.title === undefined || text(p.title)) && (p.previousState === undefined || safe(p.previousState))
    && (p.template === undefined || text(p.template)) && (p.roomId === undefined || safe(p.roomId))
    && Array.isArray(p.agents) && p.agents.length <= 64
    && p.agents.every(a => a && typeof a === 'object' && safe((a as Record<string, unknown>).name)
      && text((a as Record<string, unknown>).role)
      && ((a as Record<string, unknown>).brain === undefined || text((a as Record<string, unknown>).brain)));
  if (p.kind === 'room') return safe(p.operation) && safe(p.id) && safe(p.newState)
    && (p.previousState === undefined || safe(p.previousState))
    && (p.template === undefined || text(p.template))
    && Array.isArray(p.participants) && p.participants.length <= 64
    && p.participants.every(a => a && typeof a === 'object' && safe((a as Record<string, unknown>).name)
      && text((a as Record<string, unknown>).role));
  return false;
}

export function renderFleetAuditInvocation(attempt: FleetAuditAttempt): string {
  return ['🧾 Fleet command invoked', `Correlation: ${attempt.correlationId}`, `Agent: ${attempt.caller}`,
    `Route: ${attempt.classification.route}`, `Fleet action: ${attempt.classification.command}`,
    `Decision: ${attempt.classification.decision}`, `Invoked: ${attempt.invokedAt}`,
    `Raw argv (redacted): ${JSON.stringify(attempt.argv)}`].join('\n');
}

export function renderFleetAuditOutcome(attempt: FleetAuditAttempt): string {
  if (!attempt.outcome) throw new Error('fleet command audit outcome is absent');
  return ['🧾 Fleet command outcome', `Correlation: ${attempt.correlationId}`, `Agent: ${attempt.caller}`,
    `Route: ${attempt.classification.route}`, `Fleet action: ${attempt.classification.command}`,
    `Result: ${attempt.outcome.class}`, `Effect: ${attempt.outcome.effect}`,
    ...(attempt.outcome.exitCode === undefined ? [] : [`Exit: ${attempt.outcome.exitCode}`]),
    ...Object.entries(attempt.outcome.resourceIds ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, id]) => `${kind[0]?.toUpperCase()}${kind.slice(1)} ID: ${id}`),
    `Completed: ${attempt.outcome.completedAt}`, `Raw argv (redacted): ${JSON.stringify(attempt.argv)}`,
    ...renderPresentation(attempt.outcome.presentation)].join('\n');
}

function renderPresentation(value: FleetAuditPresentation | undefined): string[] {
  if (!value) return [];
  if (value.kind === 'agent_started') return ['Structured result: Agent started', `Agent: ${value.name}`,
    `Brain: ${value.brain}`, `Role: ${value.role}`,
    `Runtime: ${value.harness}/${value.session}${value.model ? ` model=${value.model}` : ''}`,
    ...(value.permissions ? [`Permissions: ${value.permissions}`] : []), `Parent: ${value.parent}`,
    `Agent action ID: ${value.actionId}`,
    `Inheritance: ${value.inherited.length ? value.inherited.join(', ') : 'none'}`];
  if (value.kind === 'task') return ['Structured result: Task', `Operation: ${value.operation}`,
    `Task: ${value.title ? `${value.title} (` : ''}${value.id}${value.title ? ')' : ''}`,
    `Status: ${value.previousState ?? 'unresolved'} -> ${value.newState}`,
    ...(value.template ? [`Template: ${value.template}`] : []), ...(value.roomId ? [`Room: ${value.roomId}`] : []),
    `Responsible Agents: ${value.agents.length ? value.agents.map(a => `${a.name} [Brain ${a.brain ?? 'unresolved'}; Role ${a.role}]`).join('; ') : 'none'}`];
  return ['Structured result: Room', `Operation: ${value.operation}`, `Room: ${value.id}`,
    `Status: ${value.previousState ?? 'unresolved'} -> ${value.newState}`,
    ...(value.template ? [`Template: ${value.template}`] : []),
    `Participants: ${value.participants.length ? value.participants.map(a => `${a.name} [Role ${a.role}]`).join('; ') : 'none'}`];
}
