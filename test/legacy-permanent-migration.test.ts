import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentDir, stateRoot } from '../src/paths.js';
import { migrateLegacyPermanentMembers } from '../src/supervisor/legacy.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'legacy-permanent-')); vi.stubEnv('OURS_FLEET_HOME', root); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function fixture(platform: 'linux' | 'darwin' = 'linux') {
  const name = 'PersonalAssistant', identity = 'PermanentIdentity', binPath = '/fixture/fleet';
  const dir = agentDir(name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.identity'), identity); writeFileSync(join(dir, '.config-path'), '/fixture/fleet.yaml');
  writeFileSync(join(dir, '.session-id'), 'same-session'); writeFileSync(join(dir, '.booted'), 'same-boot-state');
  const nativePath = platform === 'linux' ? join(root, '.config/systemd/user/ours-fleet-agent@.service')
    : join(root, `Library/LaunchAgents/network.ours.fleet.${name}.plist`);
  mkdirSync(join(nativePath, '..'), { recursive: true });
  writeFileSync(nativePath, platform === 'linux' ? `[Service]\nExecStart="${process.execPath}" "${binPath}" _run %i\nRestart=on-failure\n`
    : `<plist><dict><key>Label</key><string>network.ours.fleet.${name}</string><key>ProgramArguments</key><array><string>${binPath}</string><string>_run</string><string>${name}</string></array><key>RunAtLoad</key><true/></dict></plist>`);
  const effective = (args: string[]) => `{ path=${args[0]} ; argv[]=${args.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  const state = { enabled: true, live: true, loaded: true, fragment: nativePath, dropIns: '', probeCode: 0,
    start: effective([process.execPath, binPath, '_run', name]), pre: '', active: '', environment: '', mainPid: '' };
  const events: string[] = [], catalog = new Map<string, 'running' | 'stopped'>();
  const exec = vi.fn(async (command: string, args: string[]) => {
    if (command === 'ps') return { code: 0, stdout: '', stderr: '' };
    if (command === 'systemctl' && args.includes('show')) return { code: state.probeCode,
      stdout: `LoadState=loaded\nFragmentPath=${state.fragment}\nDropInPaths=${state.dropIns}\nUnitFileState=${state.enabled ? 'enabled' : 'disabled'}\nActiveState=${state.active || (state.live ? 'active' : 'inactive')}\nExecStart=${state.start}\nExecStartPre=${state.pre}\nExecStartPost=\nExecStop=\nExecStopPost=\nExecReload=\nExecCondition=\nEnvironment=${state.environment}\nMainPID=${state.mainPid || (state.live ? '123' : '0')}\nControlGroup=\nTimeoutStartUSec=4min 30s\nRestartUSec=15s\nStartLimitIntervalUSec=0\nRestart=on-failure\n`, stderr: '' };
    if (command === 'systemctl' && args.includes('disable')) {
      events.push('disable-old'); state.enabled = false; state.live = false; state.active = '';
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'launchctl' && args[0] === 'print') return state.loaded ? { code: state.probeCode,
      stdout: `path = ${nativePath}\nprogram = ${binPath}\narguments = {\n${binPath}\n_run\n${name}\n}\nstate = ${state.live ? 'running' : 'not running'}\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: 'Could not find service' };
    if (command === 'launchctl' && args[0] === 'bootout') {
      events.push('bootout-old'); state.loaded = false; state.live = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    throw Error(`Unexpected fixture native call: ${command} ${args.join(' ')}`);
  });
  const register = vi.fn(async (role: string, desired: 'running' | 'stopped') => {
    expect(state.live).toBe(false); expect(platform === 'linux' ? state.enabled : state.loaded).toBe(false);
    events.push('register-central'); if (!catalog.has(role)) catalog.set(role, desired);
  });
  const input = { roles: [{ name, identity }], binPath, platform, configPath: '/fixture/fleet.yaml', exec, register, prepareParent: async () => {} };
  const receiptPath = join(stateRoot(), 'supervisor/legacy-permanent', `${name}.json`);
  return { name, identity, dir, nativePath, receiptPath, state, events, catalog, input, register, exec, effective };
}
it.each(['linux', 'darwin'] as const)('transfers an exact live legacy %s registration after quiescence without changing identity or conversation', async platform => {
  const f = fixture(platform), before = ['.identity', '.session-id', '.booted'].map(file => readFileSync(join(f.dir, file)));
  expect(await migrateLegacyPermanentMembers(f.input)).toEqual([{ name: f.name, status: 'migrated' }]);
  expect(f.events).toEqual([platform === 'linux' ? 'disable-old' : 'bootout-old', 'register-central']);
  expect(f.catalog.get(f.name)).toBe('running');
  expect(['.identity', '.session-id', '.booted'].map(file => readFileSync(join(f.dir, file)))).toEqual(before);
  if (platform === 'darwin') expect(existsSync(f.nativePath)).toBe(false);
  f.catalog.set(f.name, 'stopped');
  expect(await migrateLegacyPermanentMembers(f.input)).toEqual([{ name: f.name, status: 'already-migrated' }]);
  expect(f.register).toHaveBeenCalledTimes(1); expect(f.catalog.get(f.name)).toBe('stopped');
});
it.each(['linux', 'darwin'] as const)('maps native boot intent during %s migration', async platform => {
  const f = fixture(platform); f.state.live = false;
  await migrateLegacyPermanentMembers(f.input);
  expect(f.catalog.get(f.name)).toBe(platform === 'linux' ? 'running' : 'stopped');
});
it.each(['PersonalAssistant', 'Coordinator'])('accepts systemctl omission of unset properties for %s', async name => {
  const f = fixture(), original = f.exec.getMockImplementation()!;
  // Real systemctl show omits empty hooks, Environment and an inactive
  // ControlGroup; do not let the fixture's printed empty keys hide this.
  f.exec.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === 'systemctl' && args.includes('show'))
      return { ...result, stdout: result.stdout.replace(/^[A-Za-z]+=\n/gm, '') };
    return result;
  });
  if (name !== f.name) {
    const dir = agentDir(name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.identity'), f.identity);
    writeFileSync(join(dir, '.config-path'), f.input.configPath);
    f.state.start = f.effective([process.execPath, f.input.binPath, '_run', name]);
  }
  await migrateLegacyPermanentMembers({ ...f.input, roles: [{ name, identity: f.identity }] });
  expect(f.catalog.get(name)).toBe('running');
  expect(f.events).toEqual(['disable-old', 'register-central']);
});
it('still refuses omitted required systemctl state before any mutation', async () => {
  const f = fixture(), original = f.exec.getMockImplementation()!;
  f.exec.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    return command === 'systemctl' && args.includes('show')
      ? { ...result, stdout: result.stdout.replace(/^MainPID=.*\n/m, '') } : result;
  });
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('LEGACY_PERMANENT_NATIVE_PROBE_UNKNOWN');
  expect(f.events).toEqual([]); expect(f.register).not.toHaveBeenCalled();
});
it('does not discover unconfigured roles or mutate a disabled legacy unit', async () => {
  const f = fixture(); f.state.enabled = false; f.state.live = false;
  expect(await migrateLegacyPermanentMembers({ ...f.input, roles: [] })).toEqual([]); expect(f.exec).not.toHaveBeenCalled();
  expect(await migrateLegacyPermanentMembers(f.input)).toEqual([{ name: f.name, status: 'disabled' }]);
  expect(f.register).not.toHaveBeenCalled(); expect(f.events).toEqual([]); expect(existsSync(f.receiptPath)).toBe(false);
});
it('migrates a stopped, unloaded launchd plist without starting the role', async () => {
  const f = fixture('darwin'); f.state.loaded = false; f.state.live = false;
  await migrateLegacyPermanentMembers(f.input);
  expect(f.events).toEqual(['register-central']); expect(f.catalog.get(f.name)).toBe('stopped');
  expect(existsSync(f.nativePath)).toBe(false);
});
it.each(['prepared', 'native-retired'] as const)('resumes a %s receipt after interrupted native removal/registration', async phase => {
  const f = fixture();
  if (phase === 'prepared') {
    const original = f.exec.getMockImplementation()!;
    f.exec.mockImplementation(async (command, args) => {
      if (args.includes('disable')) throw Error('crash before disable');
      return original(command, args);
    });
    await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('crash before disable');
    expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).phase).toBe('prepared');
    f.exec.mockImplementation(original);
  } else {
    f.register.mockRejectedValueOnce(Error('crash before register'));
    await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('crash before register');
    expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).phase).toBe('native-retired');
  }
  await migrateLegacyPermanentMembers(f.input);
  expect(f.catalog.get(f.name)).toBe('running'); expect(f.events.filter(event => event === 'disable-old')).toHaveLength(1);
});
it('preserves later stopped catalog intent after a crash between register and receipt completion', async () => {
  const f = fixture(), original = f.register.getMockImplementation()!;
  f.register.mockImplementationOnce(async (name, desired) => { await original(name, desired); throw Error('reply lost'); });
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('reply lost');
  f.catalog.set(f.name, 'stopped');
  await migrateLegacyPermanentMembers(f.input);
  expect(f.catalog.get(f.name)).toBe('stopped'); expect(f.events.filter(event => event === 'disable-old')).toHaveLength(1);
});
it.each(['identity', 'foreign-command', 'fragment', 'drop-in', 'bus', 'config', 'unsafe', 'disabled-running'])('fails closed before native mutation for %s proof', async mode => {
  const f = fixture();
  if (mode === 'identity') writeFileSync(join(f.dir, '.identity'), 'ForeignIdentity');
  if (mode === 'foreign-command') f.state.start = f.effective(['/foreign/daemon']);
  if (mode === 'fragment') f.state.fragment = '/foreign/unit';
  if (mode === 'drop-in') f.state.dropIns = '/foreign/override.conf';
  if (mode === 'bus') f.state.probeCode = 1;
  if (mode === 'config') writeFileSync(join(f.dir, '.config-path'), '/foreign/fleet.yaml');
  if (mode === 'unsafe') { rmSync(f.nativePath); symlinkSync(join(f.dir, '.session-id'), f.nativePath); }
  if (mode === 'disabled-running') f.state.enabled = false;
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow();
  expect(f.events).toEqual([]); expect(f.register).not.toHaveBeenCalled(); expect(readFileSync(join(f.dir, '.session-id'), 'utf8')).toBe('same-session');
});
it('rejects an old service reappearing after completed migration', async () => {
  const f = fixture(); await migrateLegacyPermanentMembers(f.input); f.state.enabled = true; f.state.live = true;
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('LEGACY_PERMANENT_NATIVE_REAPPEARED');
  expect(f.register).toHaveBeenCalledTimes(1);
});
it('does not register the central member while an old runner still survives native retirement', async () => {
  const f = fixture(), original = f.exec.getMockImplementation()!;
  f.exec.mockImplementation(async (command, args) => command === 'ps'
    ? { code: 0, stdout: `1234 /fixture/fleet _run ${f.name}\n`, stderr: '' } : original(command, args));
  await expect(migrateLegacyPermanentMembers({ ...f.input, processHome: () => root })).rejects.toThrow('LEGACY_PERMANENT_PROCESS_STILL_RUNNING');
  expect(f.register).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).phase).toBe('native-retired');
  f.exec.mockImplementation(original);
  await migrateLegacyPermanentMembers(f.input); expect(f.catalog.get(f.name)).toBe('running');
});
function hostOverrides(f: ReturnType<typeof fixture>) {
  const oldCli = join(root, '.local/share/old-fleet/node_modules/@ours.network/fleet/dist/cli.js');
  mkdirSync(dirnameOf(oldCli), { recursive: true });
  writeFileSync(oldCli, '// installed old release');
  writeFileSync(join(oldCli, '../..', 'package.json'), JSON.stringify({ name: '@ours.network/fleet', bin: { 'ours-fleet': 'dist/cli.js' } }));
  const shared = `${f.nativePath}.d/60-dependency-readiness.conf`;
  const override = join(root, `.config/systemd/user/ours-fleet-agent@${f.name}.service.d/70-current-fleet.conf`);
  mkdirSync(dirnameOf(shared), { recursive: true }); mkdirSync(dirnameOf(override), { recursive: true });
  const gate = join(root, 'bin/ours-fleet-wait-ready'); mkdirSync(dirnameOf(gate), { recursive: true });
  writeFileSync(gate, '# fixture: wait for daemon, cowork and gateway health');
  const settings = `[Unit]\nStartLimitIntervalSec=0\n[Service]\nExecStartPre=${gate}\nTimeoutStartSec=270\nRestartSec=15\nRestart=on-failure\n`;
  writeFileSync(shared, settings);
  writeFileSync(override, `[Service]\nExecStart=\nExecStart=${process.execPath} ${oldCli} _run ${f.name}\n`);
  f.state.dropIns = `${shared} ${override}`;
  f.state.start = f.effective([process.execPath, oldCli, '_run', f.name]);
  f.state.pre = f.effective([gate]);
  const parent = join(root, '.config/systemd/user/ours-fleet.service.d/60-operator-readiness.conf');
  return { parent, settings, oldCli, shared, override, gate };
}
const dirnameOf = (path: string) => join(path, '..');
it('fails host-shaped drop-ins before mutation, then adopts only after operator parent settings and readiness acknowledgement', async () => {
  const f = fixture(), host = hostOverrides(f);
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('OPERATOR_DROPIN_REQUIRED');
  expect(f.events).toEqual([]); expect(existsSync(f.receiptPath)).toBe(false);
  mkdirSync(dirnameOf(host.parent), { recursive: true }); writeFileSync(host.parent, host.settings);
  await expect(migrateLegacyPermanentMembers({ ...f.input, prepareParent: undefined as any })).rejects.toThrow('PARENT_PREPARATION_REQUIRED');
  const before = readFileSync(host.parent), prepareParent = vi.fn(async gates => {
    expect(gates).toEqual([expect.objectContaining({ path: host.gate, timeoutStartSec: 270, restartSec: 15 })]);
    f.events.push('parent-ready');
  });
  await migrateLegacyPermanentMembers({ ...f.input, prepareParent });
  expect(f.events).toEqual(['parent-ready', 'disable-old', 'register-central']);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  expect(receipt.legacyBinPath).toBe(host.oldCli); expect(receipt.files).toHaveLength(3);
  expect(readFileSync(host.parent)).toEqual(before);
  await migrateLegacyPermanentMembers({ ...f.input, prepareParent });
  expect(readFileSync(host.parent)).toEqual(before); expect(f.register).toHaveBeenCalledTimes(1);
  expect(existsSync(f.nativePath)).toBe(true); expect(existsSync(host.shared)).toBe(true);
});
it('validates every configured role before writing receipts or disabling the first', async () => {
  const f = fixture();
  await expect(migrateLegacyPermanentMembers({ ...f.input, roles: [
    ...f.input.roles, { name: 'FleetCoordinator', identity: 'MissingContext' },
  ] })).rejects.toThrow();
  expect(f.events).toEqual([]); expect(existsSync(f.receiptPath)).toBe(false);
});
it('keeps parent-before-retirement ordering even when registration fails and retry completes after a CLI upgrade', async () => {
  const f = fixture(), prepareParent = vi.fn(async () => { f.events.push('parent-ready'); });
  f.register.mockRejectedValueOnce(Error('register failed'));
  await expect(migrateLegacyPermanentMembers({ ...f.input, prepareParent })).rejects.toThrow('register failed');
  expect(f.events).toEqual(['parent-ready', 'disable-old']);
  await migrateLegacyPermanentMembers({ ...f.input, prepareParent, binPath: '/fixture/new-cli-release' });
  expect(f.catalog.get(f.name)).toBe('running');
  expect(f.events).toEqual(['parent-ready', 'disable-old', 'parent-ready', 'register-central']);
});
it('preserves enabled failed-unit boot intent instead of silently stopping it', async () => {
  const f = fixture(); f.state.live = false; f.state.active = 'failed';
  await migrateLegacyPermanentMembers(f.input); expect(f.catalog.get(f.name)).toBe('running');
});
it('does not treat same-name runners from another Fleet home as this native member', async () => {
  const f = fixture(), original = f.exec.getMockImplementation()!;
  f.exec.mockImplementation(async (command, args) => command === 'ps'
    ? { code: 0, stdout: `2345 /fixture/fleet _run ${f.name}\n`, stderr: '' } : original(command, args));
  await migrateLegacyPermanentMembers({ ...f.input, processHome: () => '/another/fleet' });
  expect(f.catalog.get(f.name)).toBe('running');
});
it('rejects a lingering native MainPID without registering a replacement', async () => {
  const f = fixture(); f.state.mainPid = '123';
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('NATIVE_STOP_UNPROVEN');
  expect(f.register).not.toHaveBeenCalled();
});
it('proves a standard launcher symlink into an older installed Fleet package and records both paths', async () => {
  const f = fixture(), host = hostOverrides(f), launcher = join(root, '.local/bin/ours-fleet');
  mkdirSync(dirnameOf(launcher), { recursive: true }); symlinkSync(host.oldCli, launcher);
  f.state.start = f.effective([process.execPath, launcher, '_run', f.name]);
  writeFileSync(host.override, `[Service]\nExecStart=\nExecStart="${process.execPath}" "${launcher}" _run %i\n`);
  mkdirSync(dirnameOf(host.parent), { recursive: true }); writeFileSync(host.parent, host.settings);
  await migrateLegacyPermanentMembers(f.input);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  expect(receipt.legacyBinPath).toBe(launcher); expect(receipt.cliRealPath).toBe(host.oldCli);
  expect(receipt.cliLinkTarget).toBe(host.oldCli);
});
it('keeps operator-owned settings and gate scripts editable after successful adoption', async () => {
  const f = fixture(), host = hostOverrides(f);
  mkdirSync(dirnameOf(host.parent), { recursive: true }); writeFileSync(host.parent, host.settings);
  await migrateLegacyPermanentMembers(f.input);
  writeFileSync(host.parent, '[Service]\nRestartSec=30\n'); writeFileSync(host.gate, '# revised operator-owned gate');
  expect(await migrateLegacyPermanentMembers(f.input)).toEqual([{ name: f.name, status: 'already-migrated' }]);
  expect(f.register).toHaveBeenCalledTimes(1);
});
it('supports a generic explicitly parent-owned readiness gate without reading or executing its script', async () => {
  const f = fixture(), host = hostOverrides(f), gate = '/operator/custom/readiness';
  const settings = host.settings.replace(host.gate, gate);
  writeFileSync(host.shared, settings); f.state.pre = f.effective([gate]);
  mkdirSync(dirnameOf(host.parent), { recursive: true }); writeFileSync(host.parent, settings);
  expect(existsSync(gate)).toBe(false);
  await migrateLegacyPermanentMembers(f.input); expect(f.catalog.get(f.name)).toBe('running');
});
it('allows a different regular executable Node path and maps missing package proof to a role-scoped error', async () => {
  const f = fixture(), node = join(root, 'runtime/node'); mkdirSync(dirnameOf(node), { recursive: true });
  writeFileSync(node, 'isolated executable fixture', { mode: 0o755 });
  f.state.start = f.effective([node, f.input.binPath, '_run', f.name]);
  await migrateLegacyPermanentMembers(f.input); expect(f.catalog.get(f.name)).toBe('running');
  rmSync(f.receiptPath); f.state.enabled = true; f.state.live = true;
  f.state.start = f.effective([node, '/missing/installation/dist/cli.js', '_run', f.name]);
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow(`LEGACY_PERMANENT_PROOF_UNAVAILABLE: ${f.name}: ENOENT`);
});
