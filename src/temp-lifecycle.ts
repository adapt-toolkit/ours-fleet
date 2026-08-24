import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { replaceFileAtomically, withFileLock } from './atomic-file.js';
import { realExec, type Exec } from './exec.js';
import { stateRoot, tmpRoot } from './paths.js';

export const TEMP_SUPERVISOR_FILE = '.temp-supervisor.json';
export const TEMP_TERMINATION_FILE = 'termination.jsonl';
export const TEMP_STOP_REQUEST_FILE = '.temp-stop-request.json';
const TEMP_GLOBAL_TERMINATION_MARKER = '.termination-globally-recorded';
export const TEMP_RECLAIM_BATCH = 32;
export const TEMP_LAUNCH_GRACE_MS = 60_000;

export type TempSupervisorKind = 'systemd-transient' | 'launchd-transient' | 'detached';
export type TempTerminationReason =
  | 'identity-closed'
  | 'session-ended'
  | 'operator-stop'
  | 'supervisor-signal'
  | 'startup-failure'
  | 'stale-supervisor';

export interface TempSupervisorRecord {
  version: 1;
  role: string;
  launchId: string;
  createdAt: string;
  phase: 'launching' | 'active';
  kind?: TempSupervisorKind;
  target?: string;
  pid?: number;
  binPath?: string;
}

export interface TempTerminationRecord {
  version: 1;
  role: string;
  launchId?: string;
  at: string;
  reason: TempTerminationReason;
  outcome: 'retired' | 'reclaimed' | 'failed';
  detail: string;
}

export type SupervisorLauncher = (
  binPath: string, args: string[], dir: string,
) => void | Promise<void>;

const metadataPath = (dir: string) => join(dir, TEMP_SUPERVISOR_FILE);
export const tempSystemdUnit = (name: string) => `ours-fleet-temp-${name}.service`;
export const tempLaunchdLabel = (name: string) => `network.ours.fleet.temp.${name}`;

export function prepareTempSupervisor(dir: string, role: string): TempSupervisorRecord {
  const record: TempSupervisorRecord = {
    version: 1, role, launchId: randomUUID(), createdAt: new Date().toISOString(), phase: 'launching',
  };
  replaceFileAtomically(metadataPath(dir), JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function readTempSupervisor(dir: string): TempSupervisorRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(metadataPath(dir), 'utf8')) as TempSupervisorRecord;
    if (value.version !== 1 || typeof value.role !== 'string' || typeof value.launchId !== 'string')
      return undefined;
    return value;
  } catch { return undefined; }
}

const metadataLockPath = (dir: string) => join(
  stateRoot(), 'locks', 'temp-supervisors', encodeURIComponent(basename(dir)),
);

async function updateTempSupervisor(
  dir: string, update: Partial<Omit<TempSupervisorRecord, 'version' | 'role' | 'launchId' | 'createdAt'>>,
): Promise<TempSupervisorRecord | undefined> {
  // The launcher and the just-started supervisor are separate processes. Lock
  // their read/merge/write updates so neither can discard the other's kind,
  // target, pid or phase. The lock lives outside the role directory so an
  // already-archived role is never accidentally recreated by a late writer.
  return withFileLock(metadataLockPath(dir), () => {
    if (!existsSync(dir)) return undefined;
    const current = readTempSupervisor(dir);
    if (!current) throw new Error(`temporary supervisor metadata is missing from ${dir}`);
    const next = { ...current, ...update };
    replaceFileAtomically(metadataPath(dir), JSON.stringify(next, null, 2) + '\n');
    return next;
  });
}

/**
 * Launch a temp supervisor outside the caller's service-manager ownership
 * boundary. `detached: true` creates a new process group but does not escape a
 * systemd cgroup; a transient unit does, and is not enabled across reboot.
 */
export function makeTempSupervisorLauncher(options: {
  exec?: Exec;
  platform?: NodeJS.Platform;
  supervisor?: string;
  spawnDetached?: (binPath: string, args: string[], dir: string) => number;
} = {}): SupervisorLauncher {
  const exec = options.exec ?? realExec;
  const platform = options.platform ?? process.platform;
  const supervisor = options.supervisor ?? process.env.OURS_FLEET_SUPERVISOR;
  return async (binPath, args, dir) => {
    const inherited = [
      'HOME', 'PATH', 'XDG_RUNTIME_DIR', 'OURS_FLEET_HOME', 'CODEX_HOME',
      // The child supervisor performs daemon identity and wake probes itself;
      // it must resolve the same ours profile as the spawning supervisor.
      'OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN', 'OURS_CONFIG',
    ]
      .flatMap(key => process.env[key] !== undefined ? [`${key}=${process.env[key]}`] : []);
    const role = args.at(-1);
    if (!role) throw new Error('temporary supervisor launch requires a role name');
    const log = join(dir, 'supervisor.log');
    if (supervisor !== 'none' && platform === 'linux') {
      const target = tempSystemdUnit(role);
      await updateTempSupervisor(dir, { phase: 'launching', kind: 'systemd-transient', target, binPath });
      const result = await exec('systemd-run', [
        '--user', '--quiet', '--collect', `--unit=${target}`,
        '--property=Type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=15s',
        `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
        ...inherited.map(value => `--setenv=${value}`),
        process.execPath, binPath, ...args,
      ]);
      if (result.code !== 0)
        throw new Error(`systemd-run ${target} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      await updateTempSupervisor(dir, { phase: 'active' });
      return;
    }
    if (supervisor !== 'none' && platform === 'darwin') {
      const target = tempLaunchdLabel(role);
      await updateTempSupervisor(dir, { phase: 'launching', kind: 'launchd-transient', target, binPath });
      const result = await exec('launchctl', [
        'submit', '-l', target, '-o', log, '-e', log, '--',
        '/usr/bin/env', ...inherited, process.execPath, binPath, ...args,
      ]);
      if (result.code !== 0)
        throw new Error(`launchctl submit ${target} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      await updateTempSupervisor(dir, { phase: 'active' });
      return;
    }
    if (!options.spawnDetached)
      throw new Error('detached temp launch requires a spawnDetached implementation');
    const pid = options.spawnDetached(binPath, args, dir);
    await updateTempSupervisor(dir, { phase: 'active', kind: 'detached', pid, binPath });
  };
}

export async function markTempSupervisorActive(dir: string, pid = process.pid): Promise<void> {
  const current = readTempSupervisor(dir);
  if (!current) return;
  await updateTempSupervisor(dir, { phase: 'active', pid });
}

export function requestedTempStopReason(dir: string): 'operator-stop' | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, TEMP_STOP_REQUEST_FILE), 'utf8')) as {
      reason?: unknown;
    };
    return value.reason === 'operator-stop' ? value.reason : undefined;
  } catch { return undefined; }
}

function archiveRoot(): string {
  return join(stateRoot(), 'recovery', 'temporary');
}

function appendTermination(dir: string, record: TempTerminationRecord): void {
  const line = JSON.stringify(record) + '\n';
  appendFileSync(join(dir, TEMP_TERMINATION_FILE), line, { mode: 0o600 });
  appendGlobalTermination(line);
  // Normal retirement no longer rereads the entire global journal. This
  // durable per-archive marker tells crash recovery the append completed; only
  // the narrow crash seam before this marker needs the legacy dedupe scan.
  replaceFileAtomically(join(dir, TEMP_GLOBAL_TERMINATION_MARKER), line);
}

function appendGlobalTermination(line: string, checkExisting = false): void {
  mkdirSync(archiveRoot(), { recursive: true, mode: 0o700 });
  const path = join(archiveRoot(), 'terminations.jsonl');
  // Recovery may revisit a .retiring directory after a crash between the
  // global append and final rename. Avoid duplicating that exact event.
  if (checkExisting) {
    try { if (readFileSync(path, 'utf8').split('\n').includes(line.trimEnd())) return; }
    catch { /* the journal does not exist yet */ }
  }
  appendFileSync(path, line, { mode: 0o600 });
}

/** Pick a sibling path without overwriting evidence from an earlier attempt. */
function collisionSafeArchivePaths(targetBase: string, retiringBase: string): {
  target: string; retiring: string;
} {
  for (let attempt = 0; ; attempt++) {
    const discriminator = attempt === 0 ? '' : `-${attempt + 1}`;
    const target = `${targetBase}${discriminator}`;
    const retiring = `${retiringBase}${discriminator}`;
    if (!existsSync(target) && !existsSync(retiring)) return { target, retiring };
  }
}

function roleFromRetiringName(name: string): string {
  const stem = name.slice(1, -'.retiring'.length);
  // Archive names end in the eight-hex launch discriminator, optionally plus
  // a numeric collision discriminator. Strip from the RIGHT so role names such
  // as Developer-3 and Tester-2 remain intact.
  return /^(.*)-[0-9a-f]{8}(?:-\d+)?$/i.exec(stem)?.[1] ?? stem;
}

/** Move retired state out of the live roster without deleting any evidence. */
export function archiveTempState(
  role: string, reason: TempTerminationReason, outcome: TempTerminationRecord['outcome'], detail: string,
  now = new Date(),
): string | undefined {
  const dir = join(tmpRoot(), role);
  if (!existsSync(dir)) return undefined;
  const supervisor = readTempSupervisor(dir);
  const record: TempTerminationRecord = {
    version: 1, role, launchId: supervisor?.launchId, at: now.toISOString(), reason, outcome, detail,
  };
  mkdirSync(archiveRoot(), { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replaceAll(/[:.]/g, '-');
  const suffix = supervisor?.launchId.slice(0, 8) ?? randomUUID().slice(0, 8);
  const paths = collisionSafeArchivePaths(
    join(archiveRoot(), `${stamp}-${role}-${suffix}`),
    join(archiveRoot(), `.${role}-${suffix}.retiring`),
  );
  // The rename is the idempotency boundary: only one concurrent retirement
  // owns the live directory. Everyone else sees it absent and does nothing.
  try { renameSync(dir, paths.retiring); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(dir)) return undefined;
    throw error;
  }
  try { appendTermination(paths.retiring, record); }
  finally { renameSync(paths.retiring, paths.target); }
  return paths.target;
}

function isArchiveForLaunch(path: string, role: string, launchId: string): boolean {
  const supervisor = readTempSupervisor(path);
  if (supervisor?.role !== role || supervisor.launchId !== launchId) return false;
  try {
    return readFileSync(join(path, TEMP_TERMINATION_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .some(line => {
        const record = JSON.parse(line) as Partial<TempTerminationRecord>;
        return record.version === 1 && record.role === role && record.launchId === launchId;
      });
  } catch { return false; }
}

/** Resolve only an exact role+launch archive; names and timestamps are never proof. */
export function tempArchiveForLaunch(role: string, launchId: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(archiveRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
      .map(entry => join(archiveRoot(), entry.name));
  } catch { return undefined; }
  const matches = entries.filter(path => isArchiveForLaunch(path, role, launchId));
  if (matches.length > 1) {
    throw new Error(
      `temporary role '${role}' launch ${launchId} has ${matches.length} recovery archives; refusing ambiguity`,
    );
  }
  return matches[0];
}

/** Resolve one terminated archive by exact role + durable creation action. */
export function tempArchiveForCreationAction(
  role: string, creationActionId: string,
): { path: string; launchId: string } | undefined {
  let entries: string[];
  try {
    entries = readdirSync(archiveRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
      .map(entry => join(archiveRoot(), entry.name));
  } catch { return undefined; }
  const matches = entries.flatMap(path => {
    const supervisor = readTempSupervisor(path);
    if (!supervisor || supervisor.role !== role || !isArchiveForLaunch(path, role, supervisor.launchId))
      return [];
    try {
      const provenance = JSON.parse(readFileSync(join(path, 'creation.json'), 'utf8')) as {
        role?: unknown; creationActionId?: unknown;
      };
      return provenance.role === role && provenance.creationActionId === creationActionId
        ? [{ path, launchId: supervisor.launchId }] : [];
    } catch { return []; }
  });
  if (matches.length > 1) {
    throw new Error(
      `temporary role '${role}' action ${creationActionId} has ${matches.length} recovery archives; refusing ambiguity`,
    );
  }
  return matches[0];
}

/**
 * Preserve a definitively stopped launch as recovery evidence, or prove that
 * its supervisor already did so. Never creates a second archive.
 */
export async function secureStoppedTempArchive(
  role: string, launchId: string, deps: TempLifecycleDeps = {},
): Promise<string> {
  const dir = join(tmpRoot(), role);
  if (existsSync(dir)) {
    const supervisor = readTempSupervisor(dir);
    if (!supervisor || supervisor.role !== role || supervisor.launchId !== launchId) {
      throw new Error(
        `temporary role '${role}' no longer matches recorded launch ${launchId}; refusing to archive`,
      );
    }
    const live = await tempSupervisorLiveness(dir, deps);
    if (live !== 'stopped') {
      throw new Error(
        `temporary role '${role}' supervisor is ${live}; refusing to archive before proven stop`,
      );
    }
    const archived = archiveTempState(
      role, 'operator-stop', 'retired',
      'room close proved the supervisor stopped; full role evidence preserved',
    );
    if (!archived || !isArchiveForLaunch(archived, role, launchId)) {
      throw new Error(`temporary role '${role}' archive could not be verified for launch ${launchId}`);
    }
    return archived;
  }
  const archived = tempArchiveForLaunch(role, launchId);
  if (!archived) {
    throw new Error(
      `temporary role '${role}' live state disappeared without an exact recovery archive for launch ${launchId}`,
    );
  }
  return archived;
}

/** Finish bounded archive renames interrupted by process or host termination. */
function recoverInterruptedArchives(now: Date): string[] {
  let names: string[];
  try {
    names = readdirSync(archiveRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name.startsWith('.') && entry.name.endsWith('.retiring'))
      .map(entry => entry.name)
      .sort()
      .slice(0, TEMP_RECLAIM_BATCH);
  } catch { return []; }
  const recovered: string[] = [];
  for (const name of names) {
    const source = join(archiveRoot(), name);
    const supervisor = readTempSupervisor(source);
    let line: string | undefined;
    try {
      line = readFileSync(join(source, TEMP_TERMINATION_FILE), 'utf8')
        .split('\n').filter(Boolean).at(-1);
    } catch { /* synthesize the audit event below */ }
    if (!line) {
      const record: TempTerminationRecord = {
        version: 1,
        role: supervisor?.role ?? roleFromRetiringName(name),
        launchId: supervisor?.launchId,
        at: now.toISOString(),
        reason: 'stale-supervisor',
        outcome: 'reclaimed',
        detail: 'completed an evidence archive interrupted before its termination journal was durable',
      };
      line = JSON.stringify(record);
      appendFileSync(join(source, TEMP_TERMINATION_FILE), line + '\n', { mode: 0o600 });
    }
    if (!existsSync(join(source, TEMP_GLOBAL_TERMINATION_MARKER))) {
      appendGlobalTermination(line + '\n', true);
      replaceFileAtomically(join(source, TEMP_GLOBAL_TERMINATION_MARKER), line + '\n');
    }
    const suffix = name.slice(1, -'.retiring'.length);
    const targetBase = join(
      archiveRoot(), `${now.toISOString().replaceAll(/[:.]/g, '-')}-recovered-${suffix}`,
    );
    let target = targetBase;
    for (let attempt = 2; existsSync(target); attempt++) target = `${targetBase}-${attempt}`;
    renameSync(source, target);
    recovered.push(target);
  }
  return recovered;
}

export interface TempLifecycleDeps {
  exec?: Exec;
  now?(): number;
  kill?(pid: number, signal: NodeJS.Signals | 0): void;
  log?(line: string): void;
  sleep?(ms: number): Promise<void>;
}

async function detachedProcessLiveness(
  record: TempSupervisorRecord, deps: TempLifecycleDeps,
): Promise<'running' | 'stopped' | 'unknown'> {
  if (!record.pid || !Number.isSafeInteger(record.pid) || record.pid < 2) return 'unknown';
  try { (deps.kill ?? process.kill)(record.pid, 0); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'unknown';
  }
  try {
    const argv = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const i = argv.indexOf('_run-temp');
    return i >= 1 && argv[i + 1] === record.role ? 'running' : 'stopped';
  } catch { /* macOS and other non-/proc hosts use ps below */ }
  const result = await (deps.exec ?? realExec)('ps', ['-p', String(record.pid), '-o', 'command=']);
  if (result.code !== 0) return result.code === 1 ? 'stopped' : 'unknown';
  const role = record.role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)_run-temp\\s+${role}(?:\\s|$)`).test(result.stdout.trim())
    ? 'running' : 'stopped';
}

async function exactTempSupervisorPids(role: string, exec: Exec): Promise<number[] | undefined> {
  const processes = await exec('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  if (processes.code !== 0) return undefined;
  const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)_run-temp\\s+${escaped}(?:\\s|$)`);
  return processes.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && pattern.test(match[2]) ? [Number(match[1])] : [];
  }).filter(pid => Number.isSafeInteger(pid) && pid >= 2);
}

export async function tempSupervisorLiveness(
  dir: string, deps: TempLifecycleDeps = {},
): Promise<'running' | 'stopped' | 'unknown'> {
  const record = readTempSupervisor(dir);
  if (!record) return 'unknown';
  const exec = deps.exec ?? realExec;
  const age = (deps.now ?? Date.now)() - Date.parse(record.createdAt);
  // A concurrent spawn writes the target before systemd-run/launchctl has
  // registered it. A not-yet-created unit looks exactly like an inactive one,
  // so launch phase plus its bounded grace is not cleanup authority.
  if (record.phase === 'launching'
      && (!Number.isFinite(age) || age < TEMP_LAUNCH_GRACE_MS)) return 'unknown';
  // Older writers could lose `kind` in an unlocked metadata RMW while retaining
  // the supervisor pid. Exact argv ownership is stronger than the missing tag.
  if (record.pid && (!record.kind || record.kind === 'detached'))
    return detachedProcessLiveness(record, deps);
  if (record.kind === 'systemd-transient' && record.target) {
    const result = await exec('systemctl', [
      '--user', 'show', '-p', 'ActiveState', '--value', record.target,
    ]);
    const state = result.stdout.trim();
    if (['active', 'activating', 'reloading', 'deactivating'].includes(state)) return 'running';
    if (['inactive', 'failed'].includes(state)
        || /not (?:be )?(?:found|loaded)|could not be found/i.test(result.stderr)) return 'stopped';
    return 'unknown';
  }
  if (record.kind === 'launchd-transient' && record.target) {
    const result = await exec('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${record.target}`]);
    if (result.code === 0) return 'running';
    return /could not find service|no such process/i.test(`${result.stdout}\n${result.stderr}`)
      ? 'stopped' : 'unknown';
  }
  if (record.kind === 'detached') return detachedProcessLiveness(record, deps);
  if (!Number.isFinite(age) || age < TEMP_LAUNCH_GRACE_MS) return 'unknown';
  // Incomplete records are settled only from an exact process-table match.
  // Zero matches proves the old supervisor is gone; ambiguity remains unknown.
  const matches = await exactTempSupervisorPids(record.role, exec);
  if (!matches || matches.length > 1) return 'unknown';
  return matches.length === 1 ? 'running' : 'stopped';
}

export async function stopTempSupervisor(
  role: string, deps: TempLifecycleDeps = {},
): Promise<'stopped' | 'already-stopped'> {
  const dir = join(tmpRoot(), role);
  if (!existsSync(dir)) return 'already-stopped';
  const exec = deps.exec ?? realExec;
  let record = readTempSupervisor(dir);
  if (!record) {
    // Upgrade seam for pre-metadata temp roles: derive an exact supervisor only
    // from the OS process table, adopt that one pid into the new fenced record,
    // and refuse ambiguity. Never infer ownership from a directory alone.
    const matches = await exactTempSupervisorPids(role, exec);
    if (!matches)
      throw new Error(
        `temporary role '${role}' has no supervisor metadata and the process table `
        + 'could not be read; refusing an unverified process kill');
    if (matches.length > 1)
      throw new Error(
        `temporary role '${role}' has ${matches.length} matching legacy supervisors; `
        + 'refusing an ambiguous process kill');
    if (matches.length === 0) return 'already-stopped';
    prepareTempSupervisor(dir, role);
    record = await updateTempSupervisor(dir, {
      phase: 'active', kind: 'detached', pid: matches[0], binPath: '(legacy adopted)',
    });
  }
  if (!record) return 'already-stopped';
  if (record.role !== role)
    throw new Error(
      `temporary role '${role}' metadata names '${record.role}'; refusing mismatched supervisor control`);
  replaceFileAtomically(join(dir, TEMP_STOP_REQUEST_FILE), JSON.stringify({
    version: 1, role, reason: 'operator-stop', requestedAt: new Date().toISOString(),
  }) + '\n');
  if (record.kind === 'systemd-transient' && record.target) {
    const result = await exec('systemctl', ['--user', 'stop', record.target]);
    if (result.code !== 0
        && !/not (?:be )?(?:found|loaded)|could not be found/i.test(result.stderr))
      throw new Error(`systemctl stop ${record.target} failed: ${result.stderr.trim()}`);
    return result.code === 0 ? 'stopped' : 'already-stopped';
  }
  if (record.kind === 'launchd-transient' && record.target) {
    const result = await exec('launchctl', ['remove', record.target]);
    if (result.code !== 0 && !/could not find|no such process/i.test(`${result.stdout}\n${result.stderr}`))
      throw new Error(`launchctl remove ${record.target} failed: ${result.stderr.trim()}`);
    return result.code === 0 ? 'stopped' : 'already-stopped';
  }
  if (record.pid && (!record.kind || record.kind === 'detached')) {
    const live = await detachedProcessLiveness(record, deps);
    if (live === 'stopped') return 'already-stopped';
    if (live === 'unknown')
      throw new Error(`temporary role '${role}' process ownership could not be verified; refusing to signal pid ${record.pid}`);
    (deps.kill ?? process.kill)(record.pid, 'SIGTERM');
    return 'stopped';
  }
  // A valid-but-incomplete record from an interrupted/unlocked older launch is
  // not permanently unremovable. Adopt exactly one matching legacy process, or
  // prove there is none; never guess when the process table is unreadable or
  // more than one candidate exists.
  const matches = await exactTempSupervisorPids(role, exec);
  if (!matches)
    throw new Error(
      `temporary role '${role}' has incomplete supervisor metadata and the process table `
      + 'could not be read; refusing an unverified process kill');
  if (matches.length > 1)
    throw new Error(
      `temporary role '${role}' has incomplete supervisor metadata and ${matches.length} `
      + 'matching supervisors; refusing an ambiguous process kill');
  if (matches.length === 0) return 'already-stopped';
  record = await updateTempSupervisor(dir, {
    phase: 'active', kind: 'detached', pid: matches[0], binPath: '(incomplete metadata adopted)',
  });
  if (!record) return 'already-stopped';
  const live = await detachedProcessLiveness(record, deps);
  if (live !== 'running') {
    if (live === 'stopped') return 'already-stopped';
    throw new Error(
      `temporary role '${role}' adopted process ownership could not be verified; `
      + `refusing to signal pid ${record.pid}`);
  }
  (deps.kill ?? process.kill)(record.pid!, 'SIGTERM');
  return 'stopped';
}

/**
 * Move a bounded batch of definitely-dead temp state into the evidence archive.
 * Unknown/legacy/live entries are preserved; absence of proof is never cleanup authority.
 */
export async function reclaimStaleTempState(deps: TempLifecycleDeps = {}): Promise<string[]> {
  const now = new Date((deps.now ?? Date.now)());
  const recovered = recoverInterruptedArchives(now);
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    entries = readdirSync(tmpRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => ({ name: entry.name, mtimeMs: statSync(join(tmpRoot(), entry.name)).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, TEMP_RECLAIM_BATCH);
  } catch { return recovered; }
  const archived: string[] = [...recovered];
  for (const entry of entries) {
    const dir = join(tmpRoot(), entry.name);
    if (!readTempSupervisor(dir)) continue; // legacy evidence has no safe ownership proof
    if (await tempSupervisorLiveness(dir, deps) !== 'stopped') continue;
    const target = archiveTempState(
      entry.name, 'stale-supervisor', 'reclaimed',
      'supervisor is definitively stopped; state moved from the live roster without deletion',
      now,
    );
    if (target) {
      archived.push(target);
      deps.log?.(`reclaimed stale temporary role '${entry.name}' to ${target}`);
    }
  }
  return archived;
}
