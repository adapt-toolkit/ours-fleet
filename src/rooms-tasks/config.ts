import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
  RoomsConfig, RoomsOwnerConfig, RoomsCoworkConfig, RoomsDefaults,
  TasksConfig, TemplateDefinition, RoomTemplatesConfig, TemplateMemberSlot,
  ROOMS_KEYS, ROOMS_OWNER_KEYS, ROOMS_COWORK_KEYS, ROOMS_DEFAULTS_KEYS,
  TASKS_KEYS, TEMPLATE_KEYS, TEMPLATE_MEMBER_KEYS,
} from './types.js';
import {
  ROOMS_KEYS as RK, ROOMS_OWNER_KEYS as ROK, ROOMS_COWORK_KEYS as RCK,
  ROOMS_DEFAULTS_KEYS as RDK, TASKS_KEYS as TK, TEMPLATE_KEYS as TPK,
  TEMPLATE_MEMBER_KEYS as TMK,
} from './types.js';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const CID_RE = /^[0-9a-fA-F]{64}$/;

export class RoomsTasksConfigError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
  }
}

function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  section: string,
): void {
  const bad = Object.keys(obj).filter(k => !(allowed as readonly string[]).includes(k));
  if (bad.length)
    throw new RoomsTasksConfigError(
      path, `${section} has unknown key(s) ${bad.join(', ')}; allowed: ${allowed.join(', ')}`);
}

export function fingerprint(invite: string): string {
  return createHash('sha256').update(invite.trim()).digest('hex');
}

function resolveInvite(
  owner: Record<string, unknown>,
  vars: Record<string, string>,
  path: string,
): { value: string; fingerprint: string } | undefined {
  const inline = owner.public_invite as string | undefined;
  const file = owner.public_invite_file as string | undefined;
  if (inline && file)
    throw new RoomsTasksConfigError(path, 'rooms.owner: exactly one of public_invite or public_invite_file');
  if (!inline && !file) return undefined;
  let raw: string;
  if (file) {
    const resolved = file.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    if (!existsSync(resolved))
      throw new RoomsTasksConfigError(path, `rooms.owner.public_invite_file: not found: ${resolved}`);
    raw = readFileSync(resolved, 'utf8').trim();
  } else {
    raw = inline!;
  }
  if (!raw) throw new RoomsTasksConfigError(path, 'rooms.owner: invite is empty');
  return { value: raw, fingerprint: fingerprint(raw) };
}

export function validateRoomsConfig(
  raw: unknown,
  vars: Record<string, string>,
  path: string,
): RoomsConfig & { _invite?: { value: string; fingerprint: string } } {
  if (!isPlainObject(raw)) throw new RoomsTasksConfigError(path, 'rooms: must be a mapping');
  // Migration-only input: provider selection was exposed before rooms shipped,
  // even though cowork was the sole implementation. Accept the one historical
  // value without carrying it into the current schema or resolved config.
  if (Object.hasOwn(raw, 'provider') && raw.provider !== 'cowork')
    throw new RoomsTasksConfigError(
      path,
      'rooms.provider: only the legacy value \'cowork\' can be migrated; remove this field because ours-cowork is always used',
    );
  const { provider: _legacyProvider, ...current } = raw;
  rejectUnknown(current, RK as unknown as string[], path, 'rooms');

  let cowork: RoomsCoworkConfig | undefined;
  if (raw.cowork !== undefined) {
    if (!isPlainObject(raw.cowork))
      throw new RoomsTasksConfigError(path, 'rooms.cowork: must be a mapping');
    rejectUnknown(raw.cowork, RCK as unknown as string[], path, 'rooms.cowork');
    cowork = { config: raw.cowork.config as string | undefined };
  }

  if (!isPlainObject(raw.owner))
    throw new RoomsTasksConfigError(path, 'rooms.owner: required and must be a mapping');
  rejectUnknown(raw.owner, ROK as unknown as string[], path, 'rooms.owner');

  const ownerProvider = (raw.owner.provider as string | undefined) ?? 'messenger-server';
  const expectedCid = raw.owner.expected_cid as string | undefined;
  if (!expectedCid) throw new RoomsTasksConfigError(path, 'rooms.owner.expected_cid: required');
  if (!CID_RE.test(expectedCid))
    throw new RoomsTasksConfigError(path, 'rooms.owner.expected_cid: must be exactly 64 hexadecimal characters');
  const ownerRole = (raw.owner.role as string | undefined) ?? 'Owner';
  const invite = resolveInvite(raw.owner, vars, path);

  const owner: RoomsOwnerConfig = {
    provider: ownerProvider,
    expected_cid: expectedCid.toLowerCase(),
    role: ownerRole,
    ...(raw.owner.public_invite ? { public_invite: '[REDACTED]' } : {}),
    ...(raw.owner.public_invite_file ? { public_invite_file: raw.owner.public_invite_file as string } : {}),
  };

  let defaults: RoomsDefaults | undefined;
  if (raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults))
      throw new RoomsTasksConfigError(path, 'rooms.defaults: must be a mapping');
    rejectUnknown(raw.defaults, RDK as unknown as string[], path, 'rooms.defaults');
    defaults = {
      template: raw.defaults.template as string | undefined,
      attach_owner: raw.defaults.attach_owner as boolean | undefined,
      close_when_task_done: raw.defaults.close_when_task_done as boolean | undefined,
    };
  }

  return { cowork, owner, defaults, _invite: invite } as
    RoomsConfig & { _invite?: { value: string; fingerprint: string } };
}

export function validateTasksConfig(
  raw: unknown,
  path: string,
): TasksConfig {
  if (!isPlainObject(raw)) throw new RoomsTasksConfigError(path, 'tasks: must be a mapping');
  rejectUnknown(raw, TK as unknown as string[], path, 'tasks');

  const createMode = raw.create_mode as string | undefined;
  if (createMode !== undefined && createMode !== 'start' && createMode !== 'backlog')
    throw new RoomsTasksConfigError(path, `tasks.create_mode: must be 'start' or 'backlog'`);

  if (raw.close_room_on_done !== undefined && typeof raw.close_room_on_done !== 'boolean')
    throw new RoomsTasksConfigError(path, 'tasks.close_room_on_done: must be a boolean');

  if (raw.retain_completed_for !== undefined && typeof raw.retain_completed_for !== 'string')
    throw new RoomsTasksConfigError(path, 'tasks.retain_completed_for: must be a duration string');

  return {
    default_room_template: raw.default_room_template as string | undefined,
    create_mode: createMode as 'start' | 'backlog' | undefined,
    close_room_on_done: raw.close_room_on_done as boolean | undefined,
    retain_completed_for: raw.retain_completed_for as string | undefined,
  };
}

export function validateRoomTemplatesConfig(
  raw: unknown,
  path: string,
): RoomTemplatesConfig {
  if (!isPlainObject(raw))
    throw new RoomsTasksConfigError(path, 'room_templates: must be a mapping');

  const result: RoomTemplatesConfig = {};
  for (const [name, tplRaw] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]+$/.test(name))
      throw new RoomsTasksConfigError(path, `room_templates: invalid template name '${name}' (allowed: [a-z0-9_-])`);
    if (!isPlainObject(tplRaw))
      throw new RoomsTasksConfigError(path, `room_templates.${name}: must be a mapping`);
    rejectUnknown(tplRaw, [...TPK, 'name'] as string[], path, `room_templates.${name}`);

    const version = tplRaw.version as number | undefined;
    if (version === undefined || !Number.isInteger(version) || version < 1)
      throw new RoomsTasksConfigError(path, `room_templates.${name}.version: required positive integer`);

    if (!tplRaw.description || typeof tplRaw.description !== 'string')
      throw new RoomsTasksConfigError(path, `room_templates.${name}.description: required string`);

    if (!Array.isArray(tplRaw.members) || !tplRaw.members.length)
      throw new RoomsTasksConfigError(path, `room_templates.${name}.members: required non-empty array`);

    const members = (tplRaw.members as unknown[]).map((m, i) => {
      if (!isPlainObject(m))
        throw new RoomsTasksConfigError(path, `room_templates.${name}.members[${i}]: must be a mapping`);
      rejectUnknown(m, TMK as unknown as string[], path, `room_templates.${name}.members[${i}]`);
      if (!m.slot || typeof m.slot !== 'string')
        throw new RoomsTasksConfigError(path, `room_templates.${name}.members[${i}].slot: required string`);
      if (!m.role || typeof m.role !== 'string')
        throw new RoomsTasksConfigError(path, `room_templates.${name}.members[${i}].role: required string`);
      if (!Number.isInteger(m.count) || (m.count as number) < 1)
        throw new RoomsTasksConfigError(path, `room_templates.${name}.members[${i}].count: required positive integer`);
      if (m.agent !== undefined)
        throw new RoomsTasksConfigError(path,
          `room_templates.${name}.members[${i}].agent: persistent Agent references are no longer allowed; use agent_template: <ID>`);
      if (typeof m.agent_template !== 'string' || !m.agent_template.trim())
        throw new RoomsTasksConfigError(path,
          `room_templates.${name}.members[${i}].agent_template: required non-blank Agent Template ID`);
      return {
        slot: m.slot as string,
        role: m.role as string,
        count: m.count as number,
        agent_template: m.agent_template,
      };
    });
    const slots = new Set<string>();
    for (const member of members) {
      if (slots.has(member.slot)) throw new RoomsTasksConfigError(path,
        `room_templates.${name}.members: duplicate slot '${member.slot}'`);
      slots.add(member.slot);
    }

    let room: { quiet_membership?: boolean; anonymous?: boolean } | undefined;
    if (tplRaw.room !== undefined) {
      if (!isPlainObject(tplRaw.room))
        throw new RoomsTasksConfigError(path, `room_templates.${name}.room: must be a mapping`);
      room = {
        quiet_membership: tplRaw.room.quiet_membership as boolean | undefined,
        anonymous: tplRaw.room.anonymous as boolean | undefined,
      };
    }

    result[name] = {
      name,
      version: version as number,
      description: tplRaw.description as string,
      room,
      contract: tplRaw.contract as string | undefined,
      members,
    };
  }
  return result;
}

export const FLEET_D_ALLOWED_KEYS = ['roles', 'rooms', 'room_templates', 'tasks'] as const;
