import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { agentDir, home, stateRoot } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import { assertSafeAncestors } from '../rooms-tasks/workspace.js';

type Desired = 'running' | 'stopped';
interface MigrationReceipt {
  version: 1; name: string; identity: string; platform: 'linux' | 'darwin';
  binPath: string; configPath?: string; nativePath: string; fileHash: string;
  desired: Desired; phase: 'prepared' | 'native-retired' | 'registered';
  files?: { path: string; hash: string }[];
  legacyBinPath?: string;
  readinessGates?: LegacyReadinessGate[];
  operatorFiles?: { path: string; hash: string }[];
}
export interface LegacyReadinessGate {
  path: string; hash: string; argv: string[]; timeoutStartSec: number; restartSec: number;
}
export interface LegacyPermanentMigrationInput {
  roles: Pick<ResolvedRole, 'name' | 'identity'>[];
  binPath: string;
  platform: NodeJS.Platform;
  configPath?: string;
  exec?: Exec;
  /** All-role preflight precedes this hook. Ensure the singleton is running and
   * preserves every gate before returning; failure prevents native retirement. */
  prepareParent(gates: LegacyReadinessGate[]): Promise<void>;
  /** Isolated process-environment seam; production reads only OURS_FLEET_HOME. */
  processHome?(pid: number): string;
  /** Create if absent; an existing registration's desired state must survive retry. */
  register(name: string, desired: Desired, configPath?: string): Promise<void>;
}
export interface LegacyPermanentMigrationResult {
  name: string; status: 'migrated' | 'already-migrated' | 'not-installed' | 'disabled';
}
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function proof(path: string): string {
  assertSafeAncestors(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error('LEGACY_PERMANENT_UNSAFE_PROOF');
  return readFileSync(path, 'utf8');
}
function assertReceiptGates(receipt: MigrationReceipt): void {
  if (receipt.readinessGates !== undefined && !Array.isArray(receipt.readinessGates))
    throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
  for (const gate of receipt.readinessGates ?? []) {
    if (gate.path !== join(home(), 'bin/ours-fleet-wait-ready') || !/^[a-f0-9]{64}$/.test(gate.hash)
        || JSON.stringify(gate.argv) !== JSON.stringify([gate.path])
        || !Number.isSafeInteger(gate.timeoutStartSec) || gate.timeoutStartSec < 1
        || !Number.isSafeInteger(gate.restartSec) || gate.restartSec < 0)
      throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
    if (digest(proof(gate.path)) !== gate.hash) throw Error('LEGACY_PERMANENT_READINESS_GATE_CHANGED');
  }
  if (receipt.operatorFiles !== undefined && !Array.isArray(receipt.operatorFiles))
    throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
  for (const file of receipt.operatorFiles ?? []) {
    if (dirname(file.path) !== join(home(), '.config/systemd/user/ours-fleet.service.d')
        || !/^[a-f0-9]{64}$/.test(file.hash) || digest(proof(file.path)) !== file.hash)
      throw Error('LEGACY_PERMANENT_OPERATOR_DROPIN_CHANGED');
  }
}
function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function assertLaunchdFile(bytes: string, name: string, binPath: string): void {
  const label = `<key>Label</key><string>network.ours.fleet.${name}</string>`;
  const argumentsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g;
  const matches = [...bytes.matchAll(argumentsBlock)];
  const expected = `<string>${xml(binPath)}</string><string>_run</string><string>${name}</string>`;
  if (!bytes.includes(label) || (bytes.match(/<key>Label<\/key>/g)?.length ?? 0) !== 1
      || matches.length !== 1 || matches[0][1].replace(/\s+(?=<)/g, '').trim() !== expected
      || /<key>(?:Program|WorkingDirectory)<\/key>/.test(bytes))
    throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
}
function properties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.trim().split('\n')) {
    const index = line.indexOf('=');
    if (index < 1 || Object.hasOwn(out, line.slice(0, index))) throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}
const runningStates = ['active', 'activating', 'reloading', 'deactivating'];
const stoppedStates = ['inactive', 'failed'];
function argv(value: string): string[] {
  // systemctl's structured command property is not shell syntax. Reject
  // ambiguous escaped/quoted paths rather than guessing token boundaries.
  const match = /^\{ path=([^;]+?) ; argv\[\]=(.*?) ; ignore_errors=no ; [^{}]*\}$/.exec(value);
  if (!match || /["'\\\n\r]/.test(match[2])) throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  const args = match[2].trim().split(/\s+/);
  if (args[0] !== match[1].trim()) throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  return args;
}
function legacyCli(args: string[], name: string, inputBin: string): string {
  const command = args.length === 4 && args[0] === process.execPath ? args.slice(1) : args;
  if (command.length !== 3 || command[1] !== '_run' || command[2] !== name
      || command[0] !== resolve(command[0])) throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  if (command[0] !== inputBin) {
    const packageDir = dirname(dirname(command[0]));
    const pkg = JSON.parse(proof(join(packageDir, 'package.json')));
    if (pkg.name !== '@ours.network/fleet' || pkg.bin?.['ours-fleet'] !== 'dist/cli.js'
        || command[0] !== join(packageDir, 'dist/cli.js')) throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
    // The installed CLI can exceed the small proof limit. Only its regular
    // non-symlink shape is needed; package metadata binds the entry point.
    assertSafeAncestors(dirname(command[0]));
    const stat = lstatSync(command[0]);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('LEGACY_PERMANENT_UNSAFE_PROOF');
  }
  return command[0];
}
function seconds(value: string): number {
  if (/^\d+s$/.test(value)) return Number(value.slice(0, -1));
  const parts = /^(?:(\d+)min )?(\d+)s$/.exec(value);
  if (!parts) throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  return Number(parts[1] ?? 0) * 60 + Number(parts[2]);
}
function directives(bytes: string): Map<string, string[]> {
  const result = new Map<string, string[]>(); let section = '';
  for (const raw of bytes.split('\n')) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[[A-Za-z]+\]$/.test(line)) { section = line; continue; }
    const match = /^([A-Za-z]+)\s*=(.*)$/.exec(line);
    if (!match || !section || /\\$/.test(line)) throw Error('LEGACY_PERMANENT_UNSUPPORTED_DROPIN');
    const key = `${section}${match[1]}`;
    result.set(key, [...result.get(key) ?? [], match[2].trim()]);
  }
  return result;
}
/** We never copy or execute operator hooks. Explicit parent drop-ins must
 * preserve non-ExecStart settings; generated parent init leaves them alone. */
function assertOperatorDropins(paths: string[]): { path: string; hash: string }[] {
  const required = new Map<string, string[]>();
  for (const path of paths) {
    for (const [key, values] of directives(proof(path))) {
      if (key === '[Service]ExecStart') continue;
      if (!['[Service]ExecStartPre', '[Service]TimeoutStartSec', '[Service]RestartSec', '[Service]Environment'].includes(key))
        throw Error(`LEGACY_PERMANENT_UNSUPPORTED_DROPIN: operator review required for ${key}`);
      if (key === '[Service]Environment' && values.some(value => !value || /["'\\]/.test(value)
          || value.split(/\s+/).some(field => !/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(field))))
        throw Error('LEGACY_PERMANENT_UNSUPPORTED_DROPIN');
      if (['[Service]TimeoutStartSec', '[Service]RestartSec'].includes(key)
          && values.some(value => !/^\d+$/.test(value))) throw Error('LEGACY_PERMANENT_UNSUPPORTED_DROPIN');
      const previous = required.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(values))
        throw Error('LEGACY_PERMANENT_OPERATOR_DROPIN_CONFLICT');
      required.set(key, values);
    }
  }
  if (!required.size) return [];
  const dir = join(home(), '.config/systemd/user/ours-fleet.service.d');
  if (!existsSync(dir)) throw Error('LEGACY_PERMANENT_OPERATOR_DROPIN_REQUIRED: preserve legacy directives in ours-fleet.service.d before retry');
  assertSafeAncestors(dir);
  const files = readdirSync(dir).filter(name => name.endsWith('.conf')).sort();
  if (!files.length || files.length > 32) throw Error('LEGACY_PERMANENT_OPERATOR_DROPIN_REQUIRED');
  const actual = new Map<string, string[]>(), proofs: { path: string; hash: string }[] = [];
  for (const name of files) {
    const path = join(dir, name), bytes = proof(path); proofs.push({ path, hash: digest(bytes) });
    for (const [key, values] of directives(bytes)) actual.set(key, [...actual.get(key) ?? [], ...values]);
  }
  for (const [key, values] of required) {
    if (JSON.stringify(actual.get(key)) !== JSON.stringify(values))
      throw Error(`LEGACY_PERMANENT_OPERATOR_DROPIN_REQUIRED: preserve ${key} in ours-fleet.service.d before retry`);
  }
  return proofs;
}
async function assertParentSettings(nativePaths: string[], exec: Exec): Promise<void> {
  const required = new Map<string, string[]>();
  for (const path of nativePaths) for (const [key, values] of directives(proof(path)))
    if (key !== '[Service]ExecStart') required.set(key, values);
  if (!required.size) return;
  const result = await exec('systemctl', ['--user', 'show', '-p', 'LoadState', '-p', 'ActiveState',
    '-p', 'ExecStartPre', '-p', 'TimeoutStartUSec', '-p', 'RestartUSec', '-p', 'Environment', 'ours-fleet.service']);
  if (result.code !== 0) throw Error('LEGACY_PERMANENT_PARENT_SETTINGS_UNPROVEN');
  const value = properties(result.stdout);
  if (value.LoadState !== 'loaded' || value.ActiveState !== 'active') throw Error('LEGACY_PERMANENT_PARENT_NOT_READY');
  const pre = required.get('[Service]ExecStartPre');
  if (pre) {
    const commands: string[] = [];
    for (const command of pre) { if (!command) commands.length = 0; else commands.push(command); }
    if (commands.length !== 1 || JSON.stringify(argv(value.ExecStartPre)) !== JSON.stringify(commands[0].split(/\s+/)))
      throw Error('LEGACY_PERMANENT_PARENT_SETTINGS_UNPROVEN');
  }
  for (const [key, property] of [['[Service]TimeoutStartSec', 'TimeoutStartUSec'], ['[Service]RestartSec', 'RestartUSec']]) {
    const wanted = required.get(key)?.at(-1);
    if (wanted && seconds(value[property]) !== Number(wanted)) throw Error('LEGACY_PERMANENT_PARENT_SETTINGS_UNPROVEN');
  }
  for (const line of required.get('[Service]Environment') ?? []) {
    if (!line || /["'\\]/.test(line)) throw Error('LEGACY_PERMANENT_UNSUPPORTED_DROPIN');
    for (const variable of line.split(/\s+/))
      if (!(value.Environment ?? '').split(/\s+/).includes(variable)) throw Error('LEGACY_PERMANENT_PARENT_SETTINGS_UNPROVEN');
  }
}
async function systemdState(name: string, path: string, exec: Exec) {
  const result = await exec('systemctl', ['--user', 'show', '-p', 'LoadState', '-p', 'FragmentPath',
    '-p', 'DropInPaths', '-p', 'UnitFileState', '-p', 'ActiveState', '-p', 'ExecStart', '-p', 'ExecStartPre',
    '-p', 'ExecStartPost', '-p', 'ExecStop', '-p', 'ExecStopPost', '-p', 'ExecReload', '-p', 'ExecCondition',
    '-p', 'Environment', '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'TimeoutStartUSec', '-p', 'RestartUSec',
    `ours-fleet-agent@${name}.service`]);
  if (result.code !== 0) throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  const value = properties(result.stdout);
  if (value.LoadState === 'not-found' && !value.FragmentPath && !value.DropInPaths && value.MainPID === '0')
    return { enabled: false, live: false, absent: true, value };
  if (value.LoadState !== 'loaded' || value.FragmentPath !== path)
    throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  if (!['enabled', 'disabled'].includes(value.UnitFileState)
      || ![...runningStates, ...stoppedStates].includes(value.ActiveState))
    throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  return { enabled: value.UnitFileState === 'enabled', live: runningStates.includes(value.ActiveState), absent: false, value };
}
function systemdProof(name: string, path: string, value: Record<string, string>, inputBin: string) {
  const paths = [path, ...(value.DropInPaths ? value.DropInPaths.split(' ') : [])];
  for (const drop of paths.slice(1)) {
    if (![`${path}.d`, join(dirname(path), `ours-fleet-agent@${name}.service.d`)].includes(dirname(drop))
        || !/^[A-Za-z0-9_.-]+\.conf$/.test(drop.slice(dirname(drop).length + 1)))
      throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  }
  const files = paths.map(file => ({ path: file, hash: digest(proof(file)) }));
  const operatorFiles = assertOperatorDropins(paths.slice(1));
  // Validate the effective command, not an overridden template ExecStart.
  const legacyBinPath = legacyCli(argv(value.ExecStart), name, inputBin);
  for (const hook of ['ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload', 'ExecCondition'])
    if (value[hook] !== '') throw Error('LEGACY_PERMANENT_UNSUPPORTED_HOOK');
  if (value.Environment === undefined || /(?:^|\s)OURS_FLEET_HOME=/.test(value.Environment)
      && !value.Environment.split(' ').includes(`OURS_FLEET_HOME=${home()}`))
    throw Error('LEGACY_PERMANENT_CONFIG_MISMATCH');
  if (!/^(0|[1-9]\d*)$/.test(value.MainPID) || value.ControlGroup === undefined)
    throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  const readinessGates: LegacyReadinessGate[] = [];
  if (value.ExecStartPre) {
    const pre = argv(value.ExecStartPre);
    const internal = pre.length === 4 && pre[0] === process.execPath && pre[1] === legacyBinPath
      && pre[2] === '_wait-daemon' && pre[3] === name;
    if (!internal) {
      if (pre.length !== 1 || pre[0] !== join(home(), 'bin/ours-fleet-wait-ready'))
        throw Error('LEGACY_PERMANENT_UNSUPPORTED_READINESS_GATE');
      readinessGates.push({ path: pre[0], argv: pre, hash: digest(proof(pre[0])),
        timeoutStartSec: seconds(value.TimeoutStartUSec), restartSec: seconds(value.RestartUSec) });
    }
  } else if (value.ExecStartPre !== '') throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  return { files, legacyBinPath, readinessGates, operatorFiles };
}
async function launchdState(name: string, path: string, binPath: string, exec: Exec): Promise<{ loaded: boolean; live: boolean }> {
  const result = await exec('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/network.ours.fleet.${name}`]);
  if (result.code !== 0) {
    if (/could not find service|no such process/i.test(`${result.stdout}\n${result.stderr}`)) return { loaded: false, live: false };
    throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  }
  const pathValue = /^\s*path\s*=\s*(.+)\s*$/m.exec(result.stdout)?.[1]?.trim();
  const program = /^\s*program\s*=\s*(.+)\s*$/m.exec(result.stdout)?.[1]?.trim();
  const args = /^\s*arguments\s*=\s*\{([\s\S]*?)^\s*\}/m.exec(result.stdout)?.[1]
    .split('\n').map(value => value.trim()).filter(Boolean);
  if (pathValue !== path || program !== binPath || JSON.stringify(args) !== JSON.stringify([binPath, '_run', name]))
    throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  const state = /^\s*state\s*=\s*(.+)\s*$/m.exec(result.stdout)?.[1]?.trim();
  if (!state || !['running', 'waiting', 'not running'].includes(state)) throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  return { loaded: true, live: state !== 'not running' };
}
async function assertLegacyProcessAbsent(name: string, binPath: string, input: LegacyPermanentMigrationInput): Promise<void> {
  const exec = input.exec ?? realExec;
  const result = await exec('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  if (result.code !== 0) throw Error('LEGACY_PERMANENT_PROCESS_ABSENCE_UNKNOWN');
  const exactRole = new RegExp(`(?:^|\\s)_run\\s+${name}(?:\\s|$)`);
  if (result.stdout.split('\n').some(line => {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!row || !exactRole.test(row[2]) || !row[2].split(/\s+/).includes(binPath)) return false;
    if (input.platform !== 'linux') return true;
    let fleetHome: string;
    try {
      fleetHome = input.processHome ? input.processHome(Number(row[1]))
        : readFileSync(`/proc/${row[1]}/environ`, 'utf8').split('\0')
          .find(field => field.startsWith('OURS_FLEET_HOME='))?.slice('OURS_FLEET_HOME='.length) ?? homedir();
    } catch { throw Error('LEGACY_PERMANENT_PROCESS_ABSENCE_UNKNOWN'); }
    return resolve(fleetHome) === resolve(home());
  })) throw Error('LEGACY_PERMANENT_PROCESS_STILL_RUNNING');
}

/** Start the common parent after all-role preflight and before retirement. Only configured,
 * identity-proven legacy registrations transfer; no identity/session writes.
 * A receipt survives removal of the old native job and preserves its original
 * running/stopped intent across retries. Native services are never inferred
 * from role names alone. Uncertain or conflicting proof fails closed.
 */
export async function migrateLegacyPermanentMembers(input: LegacyPermanentMigrationInput): Promise<LegacyPermanentMigrationResult[]> {
  if (!['linux', 'darwin'].includes(input.platform)) return [];
  if (!input.binPath || /[\r\n\0]/.test(input.binPath) || input.binPath !== resolve(input.binPath))
    throw Error('LEGACY_PERMANENT_INVALID_INPUT');
  const names = new Set<string>(), results: LegacyPermanentMigrationResult[] = [];
  for (const role of input.roles) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(role.name) || !/^[A-Za-z0-9_-]{1,120}$/.test(role.identity) || names.has(role.name))
      throw Error('LEGACY_PERMANENT_INVALID_INPUT');
    names.add(role.name);
  }
  const exec = input.exec ?? realExec;
  const gates = new Map<string, LegacyReadinessGate>();
  const execute = async (role: LegacyPermanentMigrationInput['roles'][number], dryRun: boolean) => withFileLock(
    join(stateRoot(), 'locks', 'legacy-permanent', role.name), async () => {
      const receiptPath = join(stateRoot(), 'supervisor', 'legacy-permanent', `${role.name}.json`);
      const platform = input.platform as 'linux' | 'darwin';
      const nativePath = platform === 'linux'
        ? join(home(), '.config', 'systemd', 'user', 'ours-fleet-agent@.service')
        : join(home(), 'Library', 'LaunchAgents', `network.ours.fleet.${role.name}.plist`);
      let receipt = existsSync(receiptPath) ? JSON.parse(proof(receiptPath)) as MigrationReceipt : undefined;
      if (!receipt && !existsSync(nativePath)) return { name: role.name, status: 'not-installed' as const };
      if (!receipt && platform === 'linux') {
        const state = await systemdState(role.name, nativePath, exec);
        if (state.absent) return { name: role.name, status: 'not-installed' as const };
        if (!state.enabled && !state.live) return { name: role.name, status: 'disabled' as const };
      }
      if (proof(join(agentDir(role.name), '.identity')).trim() !== role.identity)
        throw Error('LEGACY_PERMANENT_IDENTITY_MISMATCH');
      const recordedConfig = proof(join(agentDir(role.name), '.config-path')).trim() || undefined;
      if (recordedConfig && input.configPath && resolve(recordedConfig) !== resolve(input.configPath))
        throw Error('LEGACY_PERMANENT_CONFIG_MISMATCH');
      const configPath = recordedConfig ?? input.configPath;
      if (receipt) {
        if (receipt.version !== 1 || receipt.name !== role.name || receipt.identity !== role.identity
            || receipt.platform !== platform || receipt.nativePath !== nativePath || !/^[a-f0-9]{64}$/.test(receipt.fileHash)
            || !['running', 'stopped'].includes(receipt.desired)
            || !['prepared', 'native-retired', 'registered'].includes(receipt.phase))
          throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
        assertReceiptGates(receipt);
        if (receipt.phase === 'registered') {
          if (platform === 'linux') {
            const state = await systemdState(role.name, nativePath, exec);
            if (state.enabled || state.live) throw Error('LEGACY_PERMANENT_NATIVE_REAPPEARED');
          } else if (existsSync(nativePath) || (await launchdState(role.name, nativePath, receipt.binPath, exec)).loaded)
            throw Error('LEGACY_PERMANENT_NATIVE_REAPPEARED');
          for (const gate of receipt.readinessGates ?? []) gates.set(gate.path, gate);
          return { name: role.name, status: 'already-migrated' as const };
        }
        // A new CLI may finish an interrupted adoption of the same role. The
        // receipt pins old native artifacts, not the invoking release path.
        if (receipt.configPath !== configPath)
          throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
      }
      let linuxProof: ReturnType<typeof systemdProof> | undefined;
      if (existsSync(nativePath)) {
        const bytes = proof(nativePath);
        if (platform === 'linux') linuxProof = systemdProof(role.name, nativePath,
          (await systemdState(role.name, nativePath, exec)).value, receipt?.legacyBinPath ?? input.binPath);
        else assertLaunchdFile(bytes, role.name, receipt?.legacyBinPath ?? receipt?.binPath ?? input.binPath);
        if (receipt && digest(bytes) !== receipt.fileHash) throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
        if (receipt?.files && JSON.stringify(linuxProof?.files) !== JSON.stringify(receipt.files))
          throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
        if (receipt?.operatorFiles && JSON.stringify(linuxProof?.operatorFiles) !== JSON.stringify(receipt.operatorFiles))
          throw Error('LEGACY_PERMANENT_OPERATOR_DROPIN_CHANGED');
      } else if (!receipt || receipt.phase === 'prepared') throw Error('LEGACY_PERMANENT_NATIVE_PROOF_MISSING');
      if (!receipt) {
        let desired: Desired;
        if (platform === 'linux') {
          const state = await systemdState(role.name, nativePath, exec);
          if (state.absent || (!state.enabled && !state.live)) return { name: role.name, status: 'disabled' as const };
          if (!state.enabled) throw Error('LEGACY_PERMANENT_DISABLED_BUT_RUNNING');
          // Enabled units express boot intent, including failed/inactive units.
          desired = 'running';
        } else {
          const state = await launchdState(role.name, nativePath, input.binPath, exec);
          desired = state.live ? 'running' : 'stopped';
        }
        receipt = { version: 1, name: role.name, identity: role.identity, platform, binPath: input.binPath,
          configPath, nativePath, fileHash: digest(proof(nativePath)), desired, phase: 'prepared',
          ...linuxProof, legacyBinPath: linuxProof?.legacyBinPath ?? input.binPath };
      }
      for (const gate of receipt.readinessGates ?? []) {
        if (digest(proof(gate.path)) !== gate.hash) throw Error('LEGACY_PERMANENT_READINESS_GATE_CHANGED');
        const existing = gates.get(gate.path);
        if (existing && JSON.stringify(existing) !== JSON.stringify(gate)) throw Error('LEGACY_PERMANENT_READINESS_GATE_CONFLICT');
        gates.set(gate.path, gate);
      }
      if (dryRun) return { name: role.name, status: 'migrated' as const };
      if (platform === 'linux' && receipt.operatorFiles?.length)
        await assertParentSettings((receipt.files ?? []).slice(1).map(file => file.path), exec);
      if (!existsSync(receiptPath)) replaceFileAtomically(receiptPath, JSON.stringify(receipt));
      if (receipt.phase === 'prepared') {
        if (platform === 'linux') {
          const state = await systemdState(role.name, nativePath, exec);
          if (state.enabled || state.live) {
            const result = await exec('systemctl', ['--user', 'disable', '--now', `ours-fleet-agent@${role.name}.service`]);
            if (result.code !== 0) throw Error('LEGACY_PERMANENT_NATIVE_RETIRE_FAILED');
          }
          const after = await systemdState(role.name, nativePath, exec);
          if (after.enabled || after.live) throw Error('LEGACY_PERMANENT_NATIVE_STOP_UNPROVEN');
        } else {
          const state = await launchdState(role.name, nativePath, receipt.legacyBinPath ?? receipt.binPath, exec);
          if (state.loaded) {
            const result = await exec('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/network.ours.fleet.${role.name}`]);
            if (result.code !== 0) throw Error('LEGACY_PERMANENT_NATIVE_RETIRE_FAILED');
          }
          if ((await launchdState(role.name, nativePath, receipt.legacyBinPath ?? receipt.binPath, exec)).loaded)
            throw Error('LEGACY_PERMANENT_NATIVE_STOP_UNPROVEN');
          if (digest(proof(nativePath)) !== receipt.fileHash) throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
          // Mark native retirement before removing the file so a crash after
          // unlink still resumes from proof outside the old service path.
        }
        receipt.phase = 'native-retired'; replaceFileAtomically(receiptPath, JSON.stringify(receipt));
      }
      if (platform === 'linux') {
        if (digest(proof(nativePath)) !== receipt.fileHash) throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
        const after = await systemdState(role.name, nativePath, exec);
        if (after.enabled || after.live || after.value.MainPID !== '0') throw Error('LEGACY_PERMANENT_NATIVE_STOP_UNPROVEN');
        const postProof = systemdProof(role.name, nativePath, after.value, receipt.legacyBinPath ?? receipt.binPath);
        if (receipt.files && JSON.stringify(postProof.files) !== JSON.stringify(receipt.files))
          throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
        assertReceiptGates(receipt);
      } else {
        if ((await launchdState(role.name, nativePath, receipt.legacyBinPath ?? receipt.binPath, exec)).loaded)
          throw Error('LEGACY_PERMANENT_NATIVE_STOP_UNPROVEN');
        if (existsSync(nativePath)) {
          if (digest(proof(nativePath)) !== receipt.fileHash) throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
          rmSync(nativePath);
        }
      }
      if (proof(join(agentDir(role.name), '.identity')).trim() !== role.identity
          || (proof(join(agentDir(role.name), '.config-path')).trim() || input.configPath) !== configPath)
        throw Error('LEGACY_PERMANENT_STATE_CHANGED');
      // Native job absence alone does not prove that a late exiting runner or
      // an escaped process is gone. Block adoption rather than overlap it.
      await assertLegacyProcessAbsent(role.name, receipt.legacyBinPath ?? receipt.binPath, input);
      await input.register(role.name, receipt.desired, configPath);
      receipt.phase = 'registered'; replaceFileAtomically(receiptPath, JSON.stringify(receipt));
      return { name: role.name, status: 'migrated' as const };
    },
  );
  // No receipt writes, native changes or registrations until every requested
  // role passes inspection. Revalidate under its lock immediately before use.
  for (const role of input.roles) await execute(role, true);
  if (!input.prepareParent) throw Error('LEGACY_PERMANENT_PARENT_PREPARATION_REQUIRED');
  await input.prepareParent([...gates.values()]);
  for (const role of input.roles) results.push(await execute(role, false));
  return results;
}
