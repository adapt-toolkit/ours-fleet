import { parseAllDocuments } from 'yaml';
import { validateIsolationConfigProblems } from './isolation/policy.js';
import type { IsolationConfig } from './isolation/types.js';
import { parseDuration } from './duration.js';
import {
  AgentPolicyValidationError, validateOwnerChannelPolicyInput, validateWorklogPolicyInput,
  validateMonitorPolicyProblems,
  type OwnerChannelPolicyInput, type WorklogPolicyFields,
} from './agent-runtime-policy.js';

/** All six resource kinds implemented by the intentionally unwired schema layer. */
export type ResourceKind =
  | 'Role' | 'Brain' | 'Agent' | 'RoomTemplate' | 'RoomsPolicy' | 'TasksPolicy';

export interface ResourceMeta {
  kind: ResourceKind;
  version: 1;
  id: string;
  display_name?: string;
}

export interface RoleSpec {
  bio?: string;
  persona?: string;
  mission?: string;
  capabilities?: string[];
}

export interface BrainSpec {
  harness: string;
  model: string;
  effort: string;
  session: string;
}

export interface PermissionSpec {
  approval: 'ask' | 'auto' | 'allow';
  filesystem: 'read-only' | 'workspace' | 'unrestricted';
  unattended: 'deny' | 'wait';
}

export type PartialPermissionSpec = Partial<PermissionSpec>;
export interface IdentityIntentSpec {
  name: string;
  ownership: 'existing' | 'create_persistent';
}

export interface AgentSpec {
  role: string;
  brain: BrainRef;
  identity: IdentityIntentSpec;
  lifecycle: 'persistent';
  permissions: PermissionSpec;
  runtime?: AgentRuntimeSpec;
}

export interface AgentRuntimeSpec {
  supervision?: { coordinator?: string; oversee?: Array<{ role: string; interval: string }> };
  isolation?: IsolationConfig;
  owner_channel?: OwnerChannelPolicyInput;
  monitoring?: {
    mode?: 'fleet' | 'native'; wake_sources?: string[]; batch_ms?: number;
    inject?: 'notification' | 'full'; interrupt?: boolean | 'after_tool';
    turn_fail_threshold?: number;
  };
  worklog?: false | WorklogPolicyFields;
  scheduling?: { cwd?: string; max_tokens?: number; autocompact_pct?: number };
}

export interface RoleContextSpec { mission_append?: string; persona_append?: string }
export interface RoomTemplateMemberSpec {
  slot: string;
  role: string;
  count: number;
  brain?: BrainRef;
  permissions?: PartialPermissionSpec;
  role_context?: RoleContextSpec;
}
export interface RoomTemplateSpec {
  version: number;
  description: string;
  contract?: string;
  room?: { quiet_membership?: boolean; anonymous?: boolean };
  members: RoomTemplateMemberSpec[];
}
export interface RoomsPolicySpec {
  cowork?: { config?: string };
  owner: {
    provider: string;
    expected_cid: string;
    role: string;
    public_invite?: string;
    public_invite_file?: string;
  };
  defaults?: { template?: string; attach_owner?: boolean; close_when_task_done?: boolean; brain?: BrainRef; permissions?: PartialPermissionSpec };
}
export interface TasksPolicySpec {
  default_room_template?: string;
  create_mode?: 'start' | 'backlog';
  close_room_on_done?: boolean;
  retain_completed_for?: string;
  brain?: BrainRef;
  permissions?: PartialPermissionSpec;
}

export type BrainRef = { template: string } | BrainSpec;

export interface RoleResource extends ResourceMeta { kind: 'Role'; spec: RoleSpec }
export interface BrainResource extends ResourceMeta { kind: 'Brain'; spec: BrainSpec }
export interface AgentResource extends ResourceMeta { kind: 'Agent'; spec: AgentSpec }
export interface RoomTemplateResource extends ResourceMeta { kind: 'RoomTemplate'; spec: RoomTemplateSpec }
export interface RoomsPolicyResource extends ResourceMeta { kind: 'RoomsPolicy'; spec: RoomsPolicySpec }
export interface TasksPolicyResource extends ResourceMeta { kind: 'TasksPolicy'; spec: TasksPolicySpec }

export type TypedResource = RoleResource | BrainResource | AgentResource
  | RoomTemplateResource | RoomsPolicyResource | TasksPolicyResource;

export class ResourceValidationError extends Error {
  constructor(readonly sourceFile: string, readonly fieldPath: string, message: string) {
    super(`${sourceFile}:${fieldPath}: ${message}`);
  }
}

const RESOURCE_ID = /^[A-Za-z0-9_-]+$/u;
const STABLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
export const MAX_ROLE_TEXT_BYTES = 64 * 1024;
export const MAX_CAPABILITIES = 64;
export const MAX_CAPABILITY_BYTES = 128;
export const MAX_BRAIN_FIELD_BYTES = 256;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function objectAt(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new ResourceValidationError(source, path, 'must be a mapping');
  return value;
}

function exactKeys(
  value: Record<string, unknown>, allowed: readonly string[], source: string, path: string,
): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (extras.length)
    throw new ResourceValidationError(source, path, `unknown key(s): ${extras.join(', ')}`);
}

function stringAt(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || !value.length)
    throw new ResourceValidationError(source, path, 'must be a non-empty string');
  if (value !== value.trim())
    throw new ResourceValidationError(source, path, 'must not have leading or trailing whitespace');
  return value;
}

function boundedStringAt(
  value: unknown, maxBytes: number, source: string, path: string,
): string {
  const result = stringAt(value, source, path);
  if (Buffer.byteLength(result, 'utf8') > maxBytes)
    throw new ResourceValidationError(source, path, `must be at most ${maxBytes} UTF-8 bytes`);
  return result;
}

function stableTokenAt(
  value: unknown, maxBytes: number, source: string, path: string,
): string {
  const result = boundedStringAt(value, maxBytes, source, path);
  if (!STABLE_TOKEN.test(result))
    throw new ResourceValidationError(source, path, 'must be a stable ASCII token');
  return result;
}

function resourceIdAt(value: unknown, source: string, path: string): string {
  const result = stringAt(value, source, path);
  if (!RESOURCE_ID.test(result))
    throw new ResourceValidationError(source, path, 'must match [A-Za-z0-9_-]+');
  return result;
}

function resourceMeta(raw: Record<string, unknown>, source: string): ResourceMeta {
  exactKeys(raw, ['kind', 'version', 'id', 'display_name', 'spec'], source, '$');
  const kind = stringAt(raw.kind, source, '$.kind');
  if (!['Role', 'Brain', 'Agent', 'RoomTemplate', 'RoomsPolicy', 'TasksPolicy'].includes(kind))
    throw new ResourceValidationError(source, '$.kind', `unsupported resource kind '${kind}'`);
  if (raw.version !== 1)
    throw new ResourceValidationError(source, '$.version', 'must be 1');
  const id = resourceIdAt(raw.id, source, '$.id');
  const displayName = raw.display_name === undefined
    ? undefined : stringAt(raw.display_name, source, '$.display_name');
  return { kind: kind as ResourceKind, version: 1, id, ...(displayName ? { display_name: displayName } : {}) };
}

export function parseBrainRef(value: unknown, source = 'config', path = '$.brain'): BrainRef {
  const raw = objectAt(value, source, path);
  const keys = Object.keys(raw).sort();
  if (keys.length === 1 && keys[0] === 'template')
    return { template: resourceIdAt(raw.template, source, `${path}.template`) };
  const inline = ['effort', 'harness', 'model', 'session'];
  if (keys.length !== inline.length || keys.some((key, index) => key !== inline[index]))
    throw new ResourceValidationError(
      source, path,
      'must contain exactly {template} or all and only {harness, model, effort, session}',
    );
  return {
    harness: boundedStringAt(raw.harness, MAX_BRAIN_FIELD_BYTES, source, `${path}.harness`),
    model: boundedStringAt(raw.model, MAX_BRAIN_FIELD_BYTES, source, `${path}.model`),
    effort: boundedStringAt(raw.effort, MAX_BRAIN_FIELD_BYTES, source, `${path}.effort`),
    session: boundedStringAt(raw.session, MAX_BRAIN_FIELD_BYTES, source, `${path}.session`),
  };
}

function roleSpec(value: unknown, source: string): RoleSpec {
  const raw = objectAt(value, source, '$.spec');
  exactKeys(raw, ['bio', 'persona', 'mission', 'capabilities'], source, '$.spec');
  const capabilities = raw.capabilities;
  if (capabilities !== undefined && !Array.isArray(capabilities))
    throw new ResourceValidationError(source, '$.spec.capabilities', 'must be a list of non-empty strings');
  if (capabilities && capabilities.length > MAX_CAPABILITIES)
    throw new ResourceValidationError(
      source, '$.spec.capabilities', `must contain at most ${MAX_CAPABILITIES} entries`);
  const normalized = capabilities?.map((item, index) => stableTokenAt(
    item, MAX_CAPABILITY_BYTES, source, `$.spec.capabilities[${index}]`));
  if (normalized && new Set(normalized).size !== normalized.length)
    throw new ResourceValidationError(source, '$.spec.capabilities', 'must not contain duplicates');
  return {
    ...(raw.bio === undefined ? {} : { bio: boundedStringAt(raw.bio, MAX_ROLE_TEXT_BYTES, source, '$.spec.bio') }),
    ...(raw.persona === undefined ? {} : { persona: boundedStringAt(raw.persona, MAX_ROLE_TEXT_BYTES, source, '$.spec.persona') }),
    ...(raw.mission === undefined ? {} : { mission: boundedStringAt(raw.mission, MAX_ROLE_TEXT_BYTES, source, '$.spec.mission') }),
    ...(normalized ? { capabilities: normalized } : {}),
  };
}

function brainSpec(value: unknown, source: string, path = '$.spec'): BrainSpec {
  const parsed = parseBrainRef(value, source, path);
  if ('template' in parsed)
    throw new ResourceValidationError(source, path, 'Brain resources require a complete inline definition');
  return parsed;
}

function booleanAt(value: unknown, source: string, path: string): boolean {
  if (typeof value !== 'boolean') throw new ResourceValidationError(source, path, 'must be a boolean');
  return value;
}

function positiveIntegerAt(value: unknown, source: string, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ResourceValidationError(source, path, 'must be a positive integer');
  return value as number;
}

function permissionSpec(value: unknown, source: string, path: string, partial: false): PermissionSpec;
function permissionSpec(value: unknown, source: string, path: string, partial: true): PartialPermissionSpec;
function permissionSpec(
  value: unknown, source: string, path: string, partial: boolean,
): PermissionSpec | PartialPermissionSpec {
  const raw = objectAt(value, source, path);
  exactKeys(raw, ['approval', 'filesystem', 'unattended'], source, path);
  if (!partial && ['approval', 'filesystem', 'unattended'].some(key => raw[key] === undefined))
    throw new ResourceValidationError(source, path, 'must define approval, filesystem, and unattended');
  const result: PartialPermissionSpec = {};
  if (raw.approval !== undefined) {
    const approval = stringAt(raw.approval, source, `${path}.approval`);
    if (!['ask', 'auto', 'allow'].includes(approval))
      throw new ResourceValidationError(source, `${path}.approval`, 'must be ask, auto, or allow');
    result.approval = approval as PermissionSpec['approval'];
  }
  if (raw.filesystem !== undefined) {
    const filesystem = stringAt(raw.filesystem, source, `${path}.filesystem`);
    if (!['read-only', 'workspace', 'unrestricted'].includes(filesystem))
      throw new ResourceValidationError(source, `${path}.filesystem`, 'must be read-only, workspace, or unrestricted');
    result.filesystem = filesystem as PermissionSpec['filesystem'];
  }
  if (raw.unattended !== undefined) {
    const unattended = stringAt(raw.unattended, source, `${path}.unattended`);
    if (!['deny', 'wait'].includes(unattended))
      throw new ResourceValidationError(source, `${path}.unattended`, 'must be deny or wait');
    result.unattended = unattended as PermissionSpec['unattended'];
  }
  return result as PermissionSpec | PartialPermissionSpec;
}

function agentRuntimeSpec(value: unknown, source: string): AgentRuntimeSpec {
  const path = '$.spec.runtime';
  const raw = objectAt(value, source, path);
  exactKeys(raw, [
    'supervision', 'isolation', 'owner_channel', 'monitoring', 'worklog', 'scheduling',
  ], source, path);
  const result: AgentRuntimeSpec = {};
  if (raw.supervision !== undefined) {
    const p = `${path}.supervision`; const value = objectAt(raw.supervision, source, p);
    exactKeys(value, ['coordinator', 'oversee'], source, p);
    let oversee: Array<{ role: string; interval: string }> | undefined;
    if (value.oversee !== undefined) {
      if (!Array.isArray(value.oversee))
        throw new ResourceValidationError(source, `${p}.oversee`, 'must be a list');
      oversee = value.oversee.map((item, index) => {
        const ip = `${p}.oversee[${index}]`; const entry = objectAt(item, source, ip);
        exactKeys(entry, ['role', 'interval'], source, ip);
        const intervalPath = `${ip}.interval`;
        const interval = stringAt(entry.interval, source, intervalPath);
        try { parseDuration(interval, { name: intervalPath, minMs: 1_000 }); }
        catch (error) {
          throw new ResourceValidationError(
            source, intervalPath, error instanceof Error ? error.message : String(error));
        }
        return { role: resourceIdAt(entry.role, source, `${ip}.role`), interval };
      });
    }
    result.supervision = {
      ...(value.coordinator === undefined ? {} : {
        coordinator: resourceIdAt(value.coordinator, source, `${p}.coordinator`),
      }),
      ...(oversee ? { oversee } : {}),
    };
  }
  if (raw.isolation !== undefined) {
    const problems = validateIsolationConfigProblems(raw.isolation, `${path}.isolation`);
    if (problems.length) {
      const problem = problems[0];
      throw new ResourceValidationError(source, problem.fieldPath, problem.message);
    }
    result.isolation = structuredClone(raw.isolation) as IsolationConfig;
  }
  if (raw.owner_channel !== undefined) {
    try {
      result.owner_channel = validateOwnerChannelPolicyInput(
        raw.owner_channel, `${path}.owner_channel`, true);
    } catch (error) {
      if (error instanceof AgentPolicyValidationError)
        throw new ResourceValidationError(source, error.fieldPath, error.detail);
      throw error;
    }
  }
  if (raw.monitoring !== undefined) {
    const p = `${path}.monitoring`; const monitoring = objectAt(raw.monitoring, source, p);
    exactKeys(monitoring, [
      'mode', 'wake_sources', 'batch_ms', 'inject', 'interrupt', 'turn_fail_threshold',
    ], source, p);
    const problems = validateMonitorPolicyProblems(monitoring, { minimumBatchMs: 1 }, p);
    if (problems.length) {
      const problem = problems[0];
      throw new ResourceValidationError(source, problem.fieldPath, problem.message);
    }
    result.monitoring = structuredClone(monitoring) as AgentRuntimeSpec['monitoring'];
  }
  if (raw.worklog !== undefined) {
    try {
      result.worklog = validateWorklogPolicyInput(raw.worklog, `${path}.worklog`, false);
    } catch (error) {
      if (error instanceof AgentPolicyValidationError)
        throw new ResourceValidationError(source, error.fieldPath, error.detail);
      throw error;
    }
  }
  if (raw.scheduling !== undefined) {
    const p = `${path}.scheduling`; const scheduling = objectAt(raw.scheduling, source, p);
    exactKeys(scheduling, ['cwd', 'max_tokens', 'autocompact_pct'], source, p);
    const pct = scheduling.autocompact_pct;
    if (pct !== undefined && (typeof pct !== 'number' || !Number.isFinite(pct)
        || pct <= 0 || pct > 100))
      throw new ResourceValidationError(source, `${p}.autocompact_pct`, 'must be greater than 0 and at most 100');
    result.scheduling = {
      ...(scheduling.cwd === undefined ? {} : { cwd: stringAt(scheduling.cwd, source, `${p}.cwd`) }),
      ...(scheduling.max_tokens === undefined ? {} : {
        max_tokens: positiveIntegerAt(scheduling.max_tokens, source, `${p}.max_tokens`),
      }),
      ...(pct === undefined ? {} : { autocompact_pct: pct }),
    };
  }
  return result;
}

function agentSpec(value: unknown, source: string): AgentSpec {
  const raw = objectAt(value, source, '$.spec');
  exactKeys(raw, ['role', 'brain', 'identity', 'lifecycle', 'permissions', 'runtime'], source, '$.spec');
  if (raw.lifecycle !== 'persistent')
    throw new ResourceValidationError(source, '$.spec.lifecycle', 'agents.d resources must be persistent');
  const identity = objectAt(raw.identity, source, '$.spec.identity');
  exactKeys(identity, ['name', 'ownership'], source, '$.spec.identity');
  const ownership = stringAt(identity.ownership, source, '$.spec.identity.ownership');
  if (!['existing', 'create_persistent'].includes(ownership))
    throw new ResourceValidationError(source, '$.spec.identity.ownership', 'must be existing or create_persistent');
  return {
    role: resourceIdAt(raw.role, source, '$.spec.role'),
    brain: parseBrainRef(raw.brain, source, '$.spec.brain'),
    identity: { name: stringAt(identity.name, source, '$.spec.identity.name'), ownership: ownership as IdentityIntentSpec['ownership'] },
    lifecycle: 'persistent', permissions: permissionSpec(raw.permissions, source, '$.spec.permissions', false),
    ...(raw.runtime === undefined ? {} : { runtime: agentRuntimeSpec(raw.runtime, source) }),
  };
}

function roleContext(value: unknown, source: string, path: string): RoleContextSpec {
  const raw = objectAt(value, source, path);
  exactKeys(raw, ['mission_append', 'persona_append'], source, path);
  return {
    ...(raw.mission_append === undefined ? {} : { mission_append: boundedStringAt(raw.mission_append, MAX_ROLE_TEXT_BYTES, source, `${path}.mission_append`) }),
    ...(raw.persona_append === undefined ? {} : { persona_append: boundedStringAt(raw.persona_append, MAX_ROLE_TEXT_BYTES, source, `${path}.persona_append`) }),
  };
}

function roomTemplateSpec(value: unknown, source: string): RoomTemplateSpec {
  const raw = objectAt(value, source, '$.spec');
  exactKeys(raw, ['version', 'description', 'contract', 'room', 'members'], source, '$.spec');
  if (!Array.isArray(raw.members) || !raw.members.length)
    throw new ResourceValidationError(source, '$.spec.members', 'must be a non-empty list');
  const members = raw.members.map((value, index): RoomTemplateMemberSpec => {
    const path = `$.spec.members[${index}]`; const member = objectAt(value, source, path);
    exactKeys(member, ['slot', 'role', 'count', 'brain', 'permissions', 'role_context'], source, path);
    return {
      slot: stableTokenAt(member.slot, MAX_CAPABILITY_BYTES, source, `${path}.slot`),
      role: resourceIdAt(member.role, source, `${path}.role`), count: positiveIntegerAt(member.count, source, `${path}.count`),
      ...(member.brain === undefined ? {} : { brain: parseBrainRef(member.brain, source, `${path}.brain`) }),
      ...(member.permissions === undefined ? {} : { permissions: permissionSpec(member.permissions, source, `${path}.permissions`, true) }),
      ...(member.role_context === undefined ? {} : { role_context: roleContext(member.role_context, source, `${path}.role_context`) }),
    };
  });
  let room: RoomTemplateSpec['room'];
  if (raw.room !== undefined) {
    const rr = objectAt(raw.room, source, '$.spec.room'); exactKeys(rr, ['quiet_membership', 'anonymous'], source, '$.spec.room');
    room = { ...(rr.quiet_membership === undefined ? {} : { quiet_membership: booleanAt(rr.quiet_membership, source, '$.spec.room.quiet_membership') }), ...(rr.anonymous === undefined ? {} : { anonymous: booleanAt(rr.anonymous, source, '$.spec.room.anonymous') }) };
  }
  return { version: positiveIntegerAt(raw.version, source, '$.spec.version'), description: boundedStringAt(raw.description, MAX_ROLE_TEXT_BYTES, source, '$.spec.description'), ...(raw.contract === undefined ? {} : { contract: boundedStringAt(raw.contract, MAX_ROLE_TEXT_BYTES, source, '$.spec.contract') }), ...(room ? { room } : {}), members };
}

function roomsPolicySpec(value: unknown, source: string): RoomsPolicySpec {
  const raw = objectAt(value, source, '$.spec'); exactKeys(raw, ['cowork', 'owner', 'defaults'], source, '$.spec');
  const owner = objectAt(raw.owner, source, '$.spec.owner'); exactKeys(owner, ['provider', 'expected_cid', 'role', 'public_invite', 'public_invite_file'], source, '$.spec.owner');
  if (owner.public_invite !== undefined && owner.public_invite_file !== undefined)
    throw new ResourceValidationError(source, '$.spec.owner', 'public_invite and public_invite_file are mutually exclusive');
  const expectedCid = stringAt(owner.expected_cid, source, '$.spec.owner.expected_cid');
  if (!/^[0-9A-Fa-f]{64}$/u.test(expectedCid)) throw new ResourceValidationError(source, '$.spec.owner.expected_cid', 'must be 64 hexadecimal characters');
  let cowork: RoomsPolicySpec['cowork']; if (raw.cowork !== undefined) { const c = objectAt(raw.cowork, source, '$.spec.cowork'); exactKeys(c, ['config'], source, '$.spec.cowork'); cowork = { ...(c.config === undefined ? {} : { config: stringAt(c.config, source, '$.spec.cowork.config') }) }; }
  let defaults: RoomsPolicySpec['defaults']; if (raw.defaults !== undefined) { const d = objectAt(raw.defaults, source, '$.spec.defaults'); exactKeys(d, ['template', 'attach_owner', 'close_when_task_done', 'brain', 'permissions'], source, '$.spec.defaults'); defaults = { ...(d.template === undefined ? {} : { template: resourceIdAt(d.template, source, '$.spec.defaults.template') }), ...(d.attach_owner === undefined ? {} : { attach_owner: booleanAt(d.attach_owner, source, '$.spec.defaults.attach_owner') }), ...(d.close_when_task_done === undefined ? {} : { close_when_task_done: booleanAt(d.close_when_task_done, source, '$.spec.defaults.close_when_task_done') }), ...(d.brain === undefined ? {} : { brain: parseBrainRef(d.brain, source, '$.spec.defaults.brain') }), ...(d.permissions === undefined ? {} : { permissions: permissionSpec(d.permissions, source, '$.spec.defaults.permissions', true) }) }; }
  return { ...(cowork ? { cowork } : {}), owner: { provider: stableTokenAt(owner.provider, MAX_BRAIN_FIELD_BYTES, source, '$.spec.owner.provider'), expected_cid: expectedCid.toLowerCase(), role: stringAt(owner.role, source, '$.spec.owner.role'), ...(owner.public_invite === undefined ? {} : { public_invite: stringAt(owner.public_invite, source, '$.spec.owner.public_invite') }), ...(owner.public_invite_file === undefined ? {} : { public_invite_file: stringAt(owner.public_invite_file, source, '$.spec.owner.public_invite_file') }) }, ...(defaults ? { defaults } : {}) };
}

function tasksPolicySpec(value: unknown, source: string): TasksPolicySpec {
  const raw = objectAt(value, source, '$.spec'); exactKeys(raw, ['default_room_template', 'create_mode', 'close_room_on_done', 'retain_completed_for', 'brain', 'permissions'], source, '$.spec');
  const mode = raw.create_mode === undefined ? undefined : stringAt(raw.create_mode, source, '$.spec.create_mode'); if (mode !== undefined && mode !== 'start' && mode !== 'backlog') throw new ResourceValidationError(source, '$.spec.create_mode', 'must be start or backlog');
  return { ...(raw.default_room_template === undefined ? {} : { default_room_template: resourceIdAt(raw.default_room_template, source, '$.spec.default_room_template') }), ...(mode ? { create_mode: mode } : {}), ...(raw.close_room_on_done === undefined ? {} : { close_room_on_done: booleanAt(raw.close_room_on_done, source, '$.spec.close_room_on_done') }), ...(raw.retain_completed_for === undefined ? {} : { retain_completed_for: stringAt(raw.retain_completed_for, source, '$.spec.retain_completed_for') }), ...(raw.brain === undefined ? {} : { brain: parseBrainRef(raw.brain, source, '$.spec.brain') }), ...(raw.permissions === undefined ? {} : { permissions: permissionSpec(raw.permissions, source, '$.spec.permissions', true) }) };
}

export function parseTypedResource(sourceFile: string, sourceText: string): TypedResource {
  const documents = parseAllDocuments(sourceText);
  if (documents.length !== 1)
    throw new ResourceValidationError(sourceFile, '$', 'must contain exactly one YAML document');
  const document = documents[0];
  if (document.errors.length)
    throw new ResourceValidationError(sourceFile, '$', document.errors[0].message);
  const raw = objectAt(document.toJS(), sourceFile, '$');
  const meta = resourceMeta(raw, sourceFile);
  if (meta.kind === 'Role') return { ...meta, kind: 'Role', spec: roleSpec(raw.spec, sourceFile) };
  if (meta.kind === 'Brain') return { ...meta, kind: 'Brain', spec: brainSpec(raw.spec, sourceFile) };
  if (meta.kind === 'Agent') return { ...meta, kind: 'Agent', spec: agentSpec(raw.spec, sourceFile) };
  if (meta.kind === 'RoomTemplate') return { ...meta, kind: 'RoomTemplate', spec: roomTemplateSpec(raw.spec, sourceFile) };
  if (meta.id !== 'default') throw new ResourceValidationError(sourceFile, '$.id', `${meta.kind} singleton id must be default`);
  if (meta.kind === 'RoomsPolicy') return { ...meta, kind: 'RoomsPolicy', spec: roomsPolicySpec(raw.spec, sourceFile) };
  return { ...meta, kind: 'TasksPolicy', spec: tasksPolicySpec(raw.spec, sourceFile) };
}
