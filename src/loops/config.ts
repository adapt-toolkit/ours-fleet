import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';

import { ConfigError, ROLE_NAME_RE } from '../config.js';
import type { ResolvedRole } from '../config.js';
import { sessionBackendCapabilities } from '../session/types.js';
import { parseDuration } from '../duration.js';

export interface LoopConfig {
  roles?: string[];
  interval?: string;
  prompt?: string;
  enabled?: boolean;
  initial_delay?: string;
  jitter?: string;
}

export interface ResolvedLoop {
  name: string;
  selectors: string[];
  roleNames: string[];
  intervalMs: number;
  prompt: string;
  promptBytes: number;
  promptHash: string;
  enabled: boolean;
  initialDelayMs: number;
  jitterMs: number;
  sourceFile: string;
}

export interface ResolvedRoleLoop extends Omit<ResolvedLoop, 'selectors' | 'roleNames'> {
  role: string;
  definitionHash: string;
}

const LOOP_KEYS = ['roles', 'interval', 'prompt', 'enabled', 'initial_delay', 'jitter'];
const MIN_INTERVAL_MS = 60_000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_JITTER_MS = 60 * 60 * 1_000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_PROMPT_SCALARS = 12_000;

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{(\w+)\}/g, (match, key) => key in vars ? String(vars[key]) : match);
  if (Array.isArray(value)) return value.map(item => substitute(item, vars));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, substitute(item, vars)]));
  return value;
}

function duration(raw: unknown, where: string, minMs: number): number {
  if (typeof raw !== 'string') throw new ConfigError(`${where} must be a duration string`);
  let value: number;
  try { value = parseDuration(raw, { name: where, minMs }); }
  catch (error) { throw new ConfigError((error as Error).message); }
  if (!Number.isSafeInteger(value) || value > MAX_DURATION_MS)
    throw new ConfigError(`${where} must not exceed 30d`);
  return value;
}

function normalizePrompt(raw: unknown, where: string): string {
  if (typeof raw !== 'string') throw new ConfigError(`${where} must be text`);
  const prompt = raw.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!prompt.trim()) throw new ConfigError(`${where} must be non-blank text`);
  if (prompt.includes('\0')) throw new ConfigError(`${where} must not contain NUL`);
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES || Array.from(prompt).length > MAX_PROMPT_SCALARS)
    throw new ConfigError(`${where} exceeds 16384 bytes or 12000 Unicode scalars`);
  return prompt;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function resolveLoops(
  block: unknown, baseFile: string, roles: ResolvedRole[], vars: Record<string, string>,
): { loops: ResolvedLoop[]; byRole: Map<string, ResolvedRoleLoop[]> } {
  const byRole = new Map(roles.map(role => [role.name, [] as ResolvedRoleLoop[]]));
  if (block === undefined || block === null) return { loops: [], byRole };
  if (!block || typeof block !== 'object' || Array.isArray(block))
    throw new ConfigError(`${baseFile}: loops must be a map`);
  const roleByName = new Map(roles.map(role => [role.name, role]));
  const out: ResolvedLoop[] = [];
  for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
    const where = `${baseFile}: loop '${name}'`;
    if (!ROLE_NAME_RE.test(name))
      throw new ConfigError(`${baseFile}: invalid loop name '${name}' (allowed: [A-Za-z0-9_-])`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new ConfigError(`${where} must be a map`);
    const value = substitute(raw, vars) as LoopConfig;
    const bad = Object.keys(value).filter(key => !LOOP_KEYS.includes(key));
    if (bad.length)
      throw new ConfigError(`${where} has unknown key(s) ${bad.join(', ')}; allowed: ${LOOP_KEYS.join(', ')}`);
    if (!Array.isArray(value.roles) || !value.roles.length
        || value.roles.some(role => typeof role !== 'string' || !role))
      throw new ConfigError(`${where}: roles must be a non-empty list of role names`);
    if (new Set(value.roles).size !== value.roles.length)
      throw new ConfigError(`${where}: roles must not contain duplicates`);
    if (value.roles.includes('*') && value.roles.length !== 1)
      throw new ConfigError(`${where}: '*' must be the sole role selector`);
    const selected = value.roles[0] === '*' ? roles : value.roles.map(roleName => {
      const role = roleByName.get(roleName);
      if (!role) throw new ConfigError(`${where}: roles names missing role '${roleName}'`);
      return role;
    });
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
      throw new ConfigError(`${where}: enabled must be true or false`);
    const enabled = value.enabled ?? true;
    const intervalMs = duration(value.interval, `${where}: interval`, MIN_INTERVAL_MS);
    const initialDelayMs = value.initial_delay === undefined
      ? intervalMs : duration(value.initial_delay, `${where}: initial_delay`, 0);
    const jitterMs = value.jitter === undefined ? 0 : duration(value.jitter, `${where}: jitter`, 0);
    if (jitterMs >= intervalMs || jitterMs > MAX_JITTER_MS)
      throw new ConfigError(`${where}: jitter must be less than interval and no more than 1h`);
    const prompt = normalizePrompt(value.prompt, `${where}: prompt`);
    if (enabled) for (const role of selected) {
      if (!sessionBackendCapabilities(role.session, role.harness).promptInput)
        throw new ConfigError(`${where} selects role '${role.name}' with session '${role.session}'; scheduled loops require managed prompt input`);
    }
    const promptHash = digest(prompt);
    const resolved: ResolvedLoop = {
      name, selectors: [...value.roles], roleNames: selected.map(role => role.name), intervalMs,
      prompt, promptBytes: Buffer.byteLength(prompt), promptHash, enabled,
      initialDelayMs, jitterMs, sourceFile: baseFile,
    };
    out.push(resolved);
    for (const role of selected) {
      const definitionHash = digest({
        role: role.name, name, intervalMs, initialDelayMs, jitterMs, enabled,
      });
      byRole.get(role.name)!.push({
        name, role: role.name, intervalMs, prompt, promptBytes: resolved.promptBytes,
        promptHash, enabled, initialDelayMs, jitterMs, sourceFile: baseFile, definitionHash,
      });
    }
  }
  for (const values of byRole.values()) values.sort((a, b) => a.name.localeCompare(b.name));
  out.sort((a, b) => a.name.localeCompare(b.name));
  if (out.some(loop => loop.enabled)) assertSafeLoopConfig(baseFile);
  return { loops: out, byRole };
}

function assertSafeLoopConfig(path: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new ConfigError(`${path}: cannot inspect scheduled-loop config permissions: ${(error as Error).message}`); }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ConfigError(`${path}: scheduled-loop config must be a regular non-symlink file`);
  if ((stat.mode & 0o022) !== 0)
    throw new ConfigError(`${path}: scheduled-loop config is group/world writable; refusing loop delivery`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new ConfigError(`${path}: scheduled-loop config is not owned by the current user`);
}
