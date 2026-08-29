import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import {
  loadConfig, resolveMonitorConfig, resolvePermissions, ROLE_NAME_RE,
  type ResolvedRole, type RoleConfig,
} from '../config.js';
import { agentsRoot, tmpRoot } from '../paths.js';
import type { RoleRecord, ResolvedRoleView, Problem } from './types.js';
import { readSpawnLineage } from '../web/topology.js';

const MAX_SNAPSHOT_BYTES = 256 * 1024;

export interface RoleRepositoryOptions {
  configPath?: string;
  permanentRoot?: string;
  temporaryRoot?: string;
  probeBackend?: (name: string, intended?: 'acp') => Promise<{
    acp: boolean;
  }>;
  concurrency?: number;
  timeoutMs?: number;
}

function safeDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && ROLE_NAME_RE.test(entry.name))
      .map(entry => entry.name);
  } catch { return []; }
}

function view(role: ResolvedRole): ResolvedRoleView {
  const options = role.harness_options as Record<string, unknown> | undefined;
  return {
    name: role.name, harness: role.harness, session: role.session, identity: role.identity,
    mission: role.mission, coordinator: role.coordinator, model: role.model,
    cwd: role.cwd ? redactHome(role.cwd) : undefined,
    permissions: role.permissions,
    nativeRuntime: {
      ...(typeof options?.approval === 'string' ? { approval: options.approval } : {}),
      ...(typeof options?.permission_mode === 'string' ? { permissionMode: options.permission_mode } : {}),
      ...(typeof options?.sandbox === 'string' ? { sandbox: options.sandbox } : {}),
    },
    oversee: role.oversee,
  };
}

function redactHome(path: string): string {
  const home = process.env.OURS_FLEET_HOME;
  return home && (path === home || path.startsWith(home + '/')) ? `~${path.slice(home.length)}` : path;
}

function snapshot(path: string, name: string): { role?: ResolvedRole; problem?: Problem } {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES)
      throw new Error('snapshot is not a bounded regular file');
    const raw = parse(readFileSync(path, 'utf8')) as RoleConfig & Partial<ResolvedRole>;
    if (!raw || typeof raw !== 'object') throw new Error('snapshot must be a mapping');
    if ((raw.session as string | undefined) === 'tmux') throw new Error(
      'session: tmux is no longer supported; use session: acp with the Codex or Claude Code adapter');
    if (raw.session !== undefined && raw.session !== 'acp')
      throw new Error(`unsupported session '${String(raw.session)}'; expected session: acp`);
    const session = 'acp' as const;
    return {
      role: {
        ...raw, name, harness: typeof raw.harness === 'string' ? raw.harness : 'claude-code',
        session, identity: typeof raw.identity === 'string' ? raw.identity : name,
        permissions: resolvePermissions(undefined, raw.permissions),
        permissionsDeclared: raw.permissions !== undefined,
        monitor: resolveMonitorConfig(undefined, raw.monitor),
        sourceFile: '(temp)',
      },
    };
  } catch (error) {
    return {
      problem: {
        code: 'corrupt_temp_snapshot', severity: 'error', source: 'role.yaml',
        detail: `temporary snapshot is unreadable: ${(error as Error).message}`,
      },
    };
  }
}

async function boundedMap<T, R>(
  values: T[], limit: number, fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}

export class RoleRepository {
  constructor(private readonly options: RoleRepositoryOptions = {}) {}

  async list(): Promise<RoleRecord[]> {
    const permanentRoot = this.options.permanentRoot ?? agentsRoot();
    const temporaryRoot = this.options.temporaryRoot ?? tmpRoot();
    let configured: ResolvedRole[] = [];
    let configProblem: Problem | undefined;
    try { configured = loadConfig(this.options.configPath).roles; }
    catch (error) {
      configProblem = { code: 'config_invalid', severity: 'error', source: 'config', detail: (error as Error).message };
    }
    const permanent = new Set(safeDirs(permanentRoot));
    const temporary = new Set(safeDirs(temporaryRoot));
    const configuredByName = new Map(configured.map(role => [role.name, role]));
    const names = [...new Set([...configuredByName.keys(), ...permanent, ...temporary])].sort();

    return boundedMap(names, this.options.concurrency ?? 8, async name => {
      const config = configuredByName.get(name);
      const inPermanent = permanent.has(name);
      const inTemporary = temporary.has(name);
      const problems: Problem[] = configProblem ? [configProblem] : [];
      let tempRole: ResolvedRole | undefined;
      let stateHealth: RoleRecord['stateHealth'] = inPermanent || inTemporary ? 'present' : 'missing';
      if (inTemporary) {
        const read = snapshot(join(temporaryRoot, name, 'role.yaml'), name);
        tempRole = read.role;
        if (read.problem) { problems.push(read.problem); stateHealth = 'corrupt'; }
      }
      if (inPermanent && inTemporary)
        problems.push({ code: 'duplicate_state', severity: 'error', detail: 'both permanent and temporary state exist' });
      const intended = config?.session ?? tempRole?.session;
      const detected = await this.detect(name, intended);
      if (intended && detected !== 'none' && detected !== intended && detected !== 'ambiguous')
        problems.push({
          code: 'backend_mismatch', severity: 'warning',
          detail: `configured ${intended}, detected ${detected}`,
        });
      const stateRef = inTemporary ? { lifetime: 'temporary' as const }
        : inPermanent ? { lifetime: 'permanent' as const } : undefined;
      const tempStateDir = inTemporary ? join(temporaryRoot, name) : undefined;
      return {
        id: name,
        lifetime: config ? 'permanent' : inTemporary ? 'temporary' : 'orphan',
        configured: Boolean(config),
        config: config ? view(config) : tempRole ? view(tempRole) : undefined,
        stateRef,
        stateHealth,
        configuredBackend: intended,
        detectedBackend: detected,
        compatibility: { compatible: true },
        problems,
        lineage: tempStateDir ? readSpawnLineage(tempStateDir) : undefined,
      };
    });
  }

  async get(id: string): Promise<RoleRecord | undefined> {
    if (!ROLE_NAME_RE.test(id)) return undefined;
    return (await this.list()).find(role => role.id === id);
  }

  stateDir(record: RoleRecord): string | undefined {
    if (!record.stateRef) return undefined;
    const root = record.stateRef.lifetime === 'temporary'
      ? (this.options.temporaryRoot ?? tmpRoot()) : (this.options.permanentRoot ?? agentsRoot());
    const candidate = join(root, record.id);
    try {
      const canonicalRoot = realpathSync(root);
      const canonical = realpathSync(candidate);
      const rel = relative(canonicalRoot, canonical);
      if (rel.startsWith('..') || rel === '') return rel === '' ? undefined : undefined;
      return canonical;
    } catch { return undefined; }
  }

  private async detect(name: string, intended?: 'acp'): Promise<RoleRecord['detectedBackend']> {
    if (!this.options.probeBackend) return intended ?? 'none';
    const timeoutMs = this.options.timeoutMs ?? 2_000;
    const result = await Promise.race([
      this.options.probeBackend(name, intended),
      new Promise<{ acp: boolean }>(resolve =>
        setTimeout(() => resolve({ acp: false }), timeoutMs)),
    ]).catch(() => ({ acp: false }));
    if (result.acp) return 'acp';
    return 'none';
  }
}
