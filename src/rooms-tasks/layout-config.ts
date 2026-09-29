import { lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parseFleetDocument } from '../config-yaml.js';
import { validateLayout, type LayoutDefinition } from './layout.js';

export interface RoomLayoutDefinition extends LayoutDefinition {
  version: 1; description?: string; sourceFile?: string;
}
export const validLayoutKey = (key: string): boolean => /^[A-Za-z][A-Za-z0-9_-]*$/.test(key)
  && !['constructor', 'prototype', '__proto__'].includes(key);
function mapping(raw: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`${label}: mapping required`);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw Error(`${label}: unknown field ${key}`);
  return raw as Record<string, unknown>;
}
function text(raw: unknown, label: string): asserts raw is string {
  if (typeof raw !== 'string' || !raw.trim()) throw Error(`${label}: non-empty string required`);
}
export function validateRoomLayout(raw: unknown, label = 'room layout'): RoomLayoutDefinition {
  const doc = mapping(raw, ['version', 'description', 'participants', 'rooms'], label);
  if (doc.version !== 1) throw Error(`${label}: version must be 1`);
  if (doc.description !== undefined) text(doc.description, `${label}.description`);
  for (const section of ['participants', 'rooms']) {
    const value = doc[section];
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length)
      throw Error(`${label}.${section}: non-empty mapping required`);
    for (const key of Object.keys(value)) if (!validLayoutKey(key)) throw Error(`${label}: invalid key ${key}`);
  }
  for (const [key, rawParticipant] of Object.entries(doc.participants as object)) {
    const participant = mapping(rawParticipant, ['agent_template'], `${label}.participants.${key}`);
    if (participant.agent_template !== undefined) text(participant.agent_template, 'agent_template');
  }
  for (const [key, rawRoom] of Object.entries(doc.rooms as object)) {
    const room = mapping(rawRoom, ['goal', 'members', 'contract', 'quiet_membership', 'anonymous', 'roles'], `${label}.rooms.${key}`);
    text(room.goal, 'goal');
    for (const field of ['members']) {
      if (!Array.isArray(room[field]) || !(room[field] as unknown[]).every(v => typeof v === 'string' && validLayoutKey(v)))
        throw Error(`${label}.${key}.${field}: list of participant/room keys required`);
      if (new Set(room[field] as string[]).size !== (room[field] as string[]).length) throw Error(`${label}.${key}.${field}: duplicate key`);
    }
    if (room.roles !== undefined) {
      const roles = mapping(room.roles, room.members as string[], 'room roles');
      for (const value of Object.values(roles)) text(value, 'room role');
    }
    if (room.contract !== undefined) text(room.contract, 'contract');
    for (const field of ['quiet_membership', 'anonymous']) if (room[field] !== undefined && typeof room[field] !== 'boolean')
      throw Error(`${field}: boolean required`);
  }
  const result = structuredClone(doc) as unknown as RoomLayoutDefinition;
  validateLayout(result); return result;
}
export function assertLayoutFile(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)
      || (!directory && stat.size > 1_000_000)) throw Error(`${path}: untrusted layout path`);
}
export function readRoomLayout(path: string): RoomLayoutDefinition {
  assertLayoutFile(path);
  return { ...validateRoomLayout(parseFleetDocument(path, readFileSync(path, 'utf8'), 'strict').value, path), sourceFile: path };
}
export function readRoomLayouts(root: string, files: string[]): Record<string, RoomLayoutDefinition> {
  if (!existsSync(root)) return {};
  assertLayoutFile(root, true);
  const result: Record<string, RoomLayoutDefinition> = {};
  for (const file of readdirSync(root).filter(f => /\.ya?ml$/.test(f)).sort()) {
    const id = basename(file, extname(file));
    if (!validLayoutKey(id)) throw Error(`invalid room layout id: ${id}`);
    if (Object.hasOwn(result, id)) throw Error(`duplicate room layout: ${id}`);
    const path = join(root, file); result[id] = readRoomLayout(path); files.push(path);
  }
  return result;
}
