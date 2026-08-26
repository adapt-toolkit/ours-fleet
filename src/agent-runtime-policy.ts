/** Shared pure validation for portable Agent runtime policy input. */

export interface OwnerAttachmentPolicyInput {
  enabled?: boolean;
  max_files_per_request?: number;
  max_file_bytes?: number;
  max_request_bytes?: number;
  retention_ms?: number;
  allowed_mime?: string[];
}

export interface OwnerChannelPolicyInput {
  identity?: string;
  owners?: string[];
  agent?: string;
  interrupt?: boolean;
  progress_interval_ms?: number;
  comments?: boolean;
  attachments?: OwnerAttachmentPolicyInput;
}

export interface WorklogPolicyFields {
  max_kb?: number;
  keep_tail_kb?: number;
  max_archives?: number;
}

export class AgentPolicyValidationError extends Error {
  constructor(readonly fieldPath: string, readonly detail: string) {
    super(`${fieldPath}: ${detail}`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const PORTABLE_MONITOR_KEYS = [
  'mode', 'enabled', 'wake_sources', 'batch_ms', 'inject', 'interrupt', 'turn_fail_threshold',
] as const;

export const PORTABLE_NOTIFY_EVENT_TYPES = [
  'message_received', 'file_received', 'sibling_contact_added', 'local_contact_request',
  'pending_message', 'contact_restored', 'inbound_error', 'state_import_failed',
] as const;

export interface PolicyValidationProblem { fieldPath: string; message: string }
export interface MonitorValidationOptions {
  minimumBatchMs?: number;
  capabilityCheck?: { capabilities: readonly string[]; required: string; buildLabel: string };
}

/** Validate partial monitor input without merging or filling defaults. */
export function validateMonitorPolicyProblems(
  raw: unknown, options: MonitorValidationOptions = {}, path = 'monitor',
): PolicyValidationProblem[] {
  if (!isObject(raw)) return [{ fieldPath: path, message: 'must be a mapping' }];
  const problems: PolicyValidationProblem[] = [];
  const add = (fieldPath: string, message: string): void => { problems.push({ fieldPath, message }); };
  const bad = Object.keys(raw).filter(key => !PORTABLE_MONITOR_KEYS.includes(
    key as (typeof PORTABLE_MONITOR_KEYS)[number]));
  if (bad.length)
    add(path, `unknown key(s) ${bad.join(', ')}; allowed: ${PORTABLE_MONITOR_KEYS.join(', ')}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
    add(`${path}.enabled`, 'must be true or false');
  if (raw.mode !== undefined && raw.mode !== 'fleet' && raw.mode !== 'native')
    add(`${path}.mode`, `invalid value '${raw.mode}'; allowed: fleet, native`);
  if (raw.mode !== undefined && typeof raw.enabled === 'boolean'
      && raw.enabled !== (raw.mode === 'fleet'))
    add(`${path}.mode`, `'${raw.mode}' conflicts with legacy monitor.enabled ${raw.enabled}`);
  const minimumBatchMs = options.minimumBatchMs ?? 0;
  if (raw.batch_ms !== undefined && (typeof raw.batch_ms !== 'number'
      || !Number.isFinite(raw.batch_ms) || raw.batch_ms < minimumBatchMs))
    add(`${path}.batch_ms`, minimumBatchMs === 0
      ? 'must be a non-negative number'
      : `must be at least ${minimumBatchMs}`);
  if (raw.inject !== undefined && raw.inject !== 'notification' && raw.inject !== 'full')
    add(`${path}.inject`, `invalid value '${raw.inject}'; allowed: notification, full`);
  if (raw.interrupt !== undefined
      && typeof raw.interrupt !== 'boolean' && raw.interrupt !== 'after_tool')
    add(`${path}.interrupt`, "must be true, false, or 'after_tool'");
  else if (raw.interrupt === 'after_tool'
      && options.capabilityCheck
      && !options.capabilityCheck.capabilities.includes(options.capabilityCheck.required))
    add(`${path}.interrupt`,
      `'after_tool' needs capability ${options.capabilityCheck.required}, `
      + `which the build validating this config (${options.capabilityCheck.buildLabel}) does not declare. `
      + 'Another install on this host may accept the same file — run `ours-fleet doctor` '
      + 'to see which artifact serves which path.');
  if (raw.turn_fail_threshold !== undefined
      && (typeof raw.turn_fail_threshold !== 'number'
        || !Number.isSafeInteger(raw.turn_fail_threshold) || raw.turn_fail_threshold < 1))
    add(`${path}.turn_fail_threshold`, 'must be a positive integer');
  if (raw.wake_sources !== undefined) {
    if (!Array.isArray(raw.wake_sources)) add(`${path}.wake_sources`, 'must be a list');
    else {
      const unknown = raw.wake_sources.filter(source =>
        !PORTABLE_NOTIFY_EVENT_TYPES.includes(source as (typeof PORTABLE_NOTIFY_EVENT_TYPES)[number]));
      if (unknown.length)
        add(`${path}.wake_sources`,
          `unknown source(s) ${unknown.join(', ')}; `
          + `allowed: ${PORTABLE_NOTIFY_EVENT_TYPES.join(', ')}`);
    }
  }
  return problems;
}

export function validateMonitorPolicyInput(
  raw: unknown, options: MonitorValidationOptions = {},
): string[] {
  return validateMonitorPolicyProblems(raw, options)
    .map(problem => problem.message.startsWith("'") && problem.message.includes(' conflicts ')
      ? `${problem.fieldPath} ${problem.message}`
      : `${problem.fieldPath}: ${problem.message}`);
}

const exactKeys = (
  value: Record<string, unknown>, allowed: readonly string[], path: string,
): void => {
  const bad = Object.keys(value).filter(key => !allowed.includes(key));
  if (bad.length) throw new AgentPolicyValidationError(path, `unknown key(s) ${bad.join(', ')}`);
};

/** Authorization CIDs use lowercase; non-CID legacy contact IDs remain case-exact. */
export const canonicalPolicyCid = (value: string): string =>
  /^[A-Fa-f0-9]{64}$/u.test(value) ? value.toLowerCase() : value;

/**
 * Validate and normalize one already-merged owner-channel input. No runtime or
 * Brain compatibility is checked here, and no resolved defaults are introduced.
 */
export function validateOwnerChannelPolicyInput(
  input: unknown, path = 'owner_channel', requireAuthority = true,
): OwnerChannelPolicyInput {
  if (!isObject(input)) throw new AgentPolicyValidationError(path, 'must be a map');
  exactKeys(input, [
    'identity', 'owners', 'agent', 'interrupt', 'progress_interval_ms', 'comments', 'attachments',
  ], path);
  if (requireAuthority && (typeof input.identity !== 'string' || !input.identity.trim()))
    throw new AgentPolicyValidationError(`${path}.identity`, 'must be a non-blank string');
  if (input.identity !== undefined && (typeof input.identity !== 'string' || !input.identity.trim()))
    throw new AgentPolicyValidationError(`${path}.identity`, 'must be a non-blank string');
  if (requireAuthority && (!Array.isArray(input.owners) || input.owners.length === 0))
    throw new AgentPolicyValidationError(`${path}.owners`, 'must be a non-empty list of contact IDs');
  if (input.owners !== undefined && (!Array.isArray(input.owners) || input.owners.length === 0
      || input.owners.some(owner => typeof owner !== 'string' || !owner.trim())))
    throw new AgentPolicyValidationError(`${path}.owners`, 'must be a non-empty list of contact IDs');
  const owners = input.owners === undefined ? undefined
    : (input.owners as string[]).map(owner => canonicalPolicyCid(owner.trim()));
  if (owners && new Set(owners).size !== owners.length)
    throw new AgentPolicyValidationError(`${path}.owners`, 'must not contain duplicates');
  if (input.agent !== undefined
      && (typeof input.agent !== 'string' || !/^[A-Fa-f0-9]{64}$/u.test(input.agent)))
    throw new AgentPolicyValidationError(`${path}.agent`, 'must be exactly 64 hexadecimal characters');
  const agent = input.agent === undefined ? undefined : canonicalPolicyCid(input.agent);
  if (agent && owners?.includes(agent))
    throw new AgentPolicyValidationError(`${path}.agent`, 'must not also be an owner CID');
  if (agent && owners?.some(owner => !/^[a-f0-9]{64}$/u.test(owner)))
    throw new AgentPolicyValidationError(
      `${path}.owners`, 'must contain exact 64-hex CIDs when agent relay is configured');
  if (input.interrupt !== undefined && typeof input.interrupt !== 'boolean')
    throw new AgentPolicyValidationError(`${path}.interrupt`, 'must be true or false');
  if (input.progress_interval_ms !== undefined
      && (typeof input.progress_interval_ms !== 'number'
        || !Number.isSafeInteger(input.progress_interval_ms) || input.progress_interval_ms < 0))
    throw new AgentPolicyValidationError(
      `${path}.progress_interval_ms`, 'must be a non-negative safe integer');
  if (input.comments !== undefined && typeof input.comments !== 'boolean')
    throw new AgentPolicyValidationError(`${path}.comments`, 'must be true or false');

  let attachments: OwnerAttachmentPolicyInput | undefined;
  if (input.attachments !== undefined) {
    const ap = `${path}.attachments`;
    if (!isObject(input.attachments)) throw new AgentPolicyValidationError(ap, 'must be a map');
    exactKeys(input.attachments, [
      'enabled', 'max_files_per_request', 'max_file_bytes', 'max_request_bytes',
      'retention_ms', 'allowed_mime',
    ], ap);
    const raw = input.attachments;
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
      throw new AgentPolicyValidationError(`${ap}.enabled`, 'must be true or false');
    const bounded = (key: string, min: number, max: number): void => {
      const value = raw[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value)
          || value < min || value > max))
        throw new AgentPolicyValidationError(`${ap}.${key}`, `must be an integer from ${min} to ${max}`);
    };
    bounded('max_files_per_request', 1, 32);
    bounded('max_file_bytes', 1, 100 * 1024 * 1024);
    bounded('max_request_bytes', 1, 256 * 1024 * 1024);
    bounded('retention_ms', 60_000, 30 * 24 * 60 * 60 * 1_000);
    if (raw.max_file_bytes !== undefined && raw.max_request_bytes !== undefined
        && (raw.max_request_bytes as number) < (raw.max_file_bytes as number))
      throw new AgentPolicyValidationError(`${ap}.max_request_bytes`, 'must be at least max_file_bytes');
    if (raw.allowed_mime !== undefined) {
      if (!Array.isArray(raw.allowed_mime) || raw.allowed_mime.length < 1
          || raw.allowed_mime.length > 64 || raw.allowed_mime.some(mime =>
            typeof mime !== 'string'
            || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime)))
        throw new AgentPolicyValidationError(
          `${ap}.allowed_mime`, 'must contain 1-64 lowercase MIME types');
      if (new Set(raw.allowed_mime).size !== raw.allowed_mime.length)
        throw new AgentPolicyValidationError(`${ap}.allowed_mime`, 'must not contain duplicates');
    }
    attachments = structuredClone(raw) as OwnerAttachmentPolicyInput;
  }
  return {
    ...(input.identity === undefined ? {} : { identity: (input.identity as string).trim() }),
    ...(owners ? { owners } : {}), ...(agent ? { agent } : {}),
    ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt as boolean }),
    ...(input.progress_interval_ms === undefined ? {} : { progress_interval_ms: input.progress_interval_ms as number }),
    ...(input.comments === undefined ? {} : { comments: input.comments as boolean }),
    ...(attachments ? { attachments } : {}),
  };
}

/** Validate a partial worklog input without filling defaults. */
export function validateWorklogPolicyInput(
  input: unknown, path = 'worklog', requireComplete = false,
): false | WorklogPolicyFields {
  if (input === false) return false;
  if (!isObject(input)) throw new AgentPolicyValidationError(path, 'must be a map or false');
  exactKeys(input, ['max_kb', 'keep_tail_kb', 'max_archives'], path);
  if (requireComplete && ['max_kb', 'keep_tail_kb', 'max_archives'].some(key => input[key] === undefined))
    throw new AgentPolicyValidationError(path, 'must define max_kb, keep_tail_kb, and max_archives');
  for (const key of ['max_kb', 'keep_tail_kb', 'max_archives'] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0))
      throw new AgentPolicyValidationError(`${path}.${key}`, 'must be a positive integer');
  }
  if (typeof input.max_archives === 'number' && input.max_archives > 1000)
    throw new AgentPolicyValidationError(`${path}.max_archives`, 'must be at most 1000');
  if (typeof input.keep_tail_kb === 'number' && typeof input.max_kb === 'number'
      && input.keep_tail_kb >= input.max_kb)
    throw new AgentPolicyValidationError(`${path}.keep_tail_kb`, 'must be less than max_kb');
  return structuredClone(input) as WorklogPolicyFields;
}
