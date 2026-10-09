import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
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
}
export interface LegacyPermanentMigrationInput {
  roles: Pick<ResolvedRole, 'name' | 'identity'>[];
  binPath: string;
  platform: NodeJS.Platform;
  configPath?: string;
  exec?: Exec;
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
function quote(value: string): string {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
}
function assertSystemdFile(bytes: string, binPath: string): void {
  const starts = bytes.split('\n').filter(line => /^ExecStart\s*=/.test(line));
  const allowed = [
    `ExecStart=${quote(process.execPath)} ${quote(binPath)} _run %i`,
    `ExecStart=${binPath} _run %i`,
  ];
  if (starts.length !== 1 || !allowed.includes(starts[0].trim()))
    throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  if (/^Exec(?:Stop|StopPost|StartPost|Reload|Condition)\s*=/m.test(bytes))
    throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
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
async function systemdState(name: string, path: string, exec: Exec): Promise<{ enabled: boolean; live: boolean; absent: boolean }> {
  const result = await exec('systemctl', ['--user', 'show', '-p', 'LoadState', '-p', 'FragmentPath',
    '-p', 'DropInPaths', '-p', 'UnitFileState', '-p', 'ActiveState', `ours-fleet-agent@${name}.service`]);
  if (result.code !== 0) throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  const value = properties(result.stdout);
  if (value.LoadState === 'not-found' && !value.FragmentPath && !value.DropInPaths) return { enabled: false, live: false, absent: true };
  if (value.LoadState !== 'loaded' || value.FragmentPath !== path || value.DropInPaths !== '')
    throw Error('LEGACY_PERMANENT_NATIVE_OWNER_MISMATCH');
  if (!['enabled', 'disabled'].includes(value.UnitFileState)
      || ![...runningStates, ...stoppedStates].includes(value.ActiveState))
    throw Error('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  return { enabled: value.UnitFileState === 'enabled', live: runningStates.includes(value.ActiveState), absent: false };
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
async function assertLegacyProcessAbsent(name: string, exec: Exec): Promise<void> {
  const result = await exec('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  if (result.code !== 0) throw Error('LEGACY_PERMANENT_PROCESS_ABSENCE_UNKNOWN');
  const exactRole = new RegExp(`(?:^|\\s)_run\\s+${name}(?:\\s|$)`);
  if (result.stdout.split('\n').some(line => {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line);
    return row && exactRole.test(row[2]);
  })) throw Error('LEGACY_PERMANENT_PROCESS_STILL_RUNNING');
}

/** Called before the common parent may launch children. Only configured,
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
  for (const role of input.roles) results.push(await withFileLock(
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
        if (receipt.phase === 'registered') {
          if (platform === 'linux') {
            const state = await systemdState(role.name, nativePath, exec);
            if (state.enabled || state.live) throw Error('LEGACY_PERMANENT_NATIVE_REAPPEARED');
          } else if (existsSync(nativePath) || (await launchdState(role.name, nativePath, receipt.binPath, exec)).loaded)
            throw Error('LEGACY_PERMANENT_NATIVE_REAPPEARED');
          return { name: role.name, status: 'already-migrated' as const };
        }
        if (receipt.binPath !== input.binPath || receipt.configPath !== configPath)
          throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
      }
      if (existsSync(nativePath)) {
        const bytes = proof(nativePath);
        if (platform === 'linux') assertSystemdFile(bytes, input.binPath);
        else assertLaunchdFile(bytes, role.name, input.binPath);
        if (receipt && digest(bytes) !== receipt.fileHash) throw Error('LEGACY_PERMANENT_NATIVE_FILE_CHANGED');
      } else if (!receipt || receipt.phase === 'prepared') throw Error('LEGACY_PERMANENT_NATIVE_PROOF_MISSING');
      if (!receipt) {
        let desired: Desired;
        if (platform === 'linux') {
          const state = await systemdState(role.name, nativePath, exec);
          if (state.absent || (!state.enabled && !state.live)) return { name: role.name, status: 'disabled' as const };
          if (!state.enabled) throw Error('LEGACY_PERMANENT_DISABLED_BUT_RUNNING');
          desired = state.live ? 'running' : 'stopped';
        } else {
          const state = await launchdState(role.name, nativePath, input.binPath, exec);
          desired = state.live ? 'running' : 'stopped';
        }
        receipt = { version: 1, name: role.name, identity: role.identity, platform, binPath: input.binPath,
          configPath, nativePath, fileHash: digest(proof(nativePath)), desired, phase: 'prepared' };
        replaceFileAtomically(receiptPath, JSON.stringify(receipt));
      }
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
          const state = await launchdState(role.name, nativePath, input.binPath, exec);
          if (state.loaded) {
            const result = await exec('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/network.ours.fleet.${role.name}`]);
            if (result.code !== 0) throw Error('LEGACY_PERMANENT_NATIVE_RETIRE_FAILED');
          }
          if ((await launchdState(role.name, nativePath, input.binPath, exec)).loaded)
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
        if (after.enabled || after.live) throw Error('LEGACY_PERMANENT_NATIVE_STOP_UNPROVEN');
      } else {
        if ((await launchdState(role.name, nativePath, input.binPath, exec)).loaded)
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
      await assertLegacyProcessAbsent(role.name, exec);
      await input.register(role.name, receipt.desired, configPath);
      receipt.phase = 'registered'; replaceFileAtomically(receiptPath, JSON.stringify(receipt));
      return { name: role.name, status: 'migrated' as const };
    },
  ));
  return results;
}
