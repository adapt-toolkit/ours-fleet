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
  const state = { enabled: true, live: true, loaded: true, fragment: nativePath, dropIns: '', probeCode: 0 };
  const events: string[] = [], catalog = new Map<string, 'running' | 'stopped'>();
  const exec = vi.fn(async (command: string, args: string[]) => {
    if (command === 'ps') return { code: 0, stdout: '', stderr: '' };
    if (command === 'systemctl' && args.includes('show')) return { code: state.probeCode,
      stdout: `LoadState=loaded\nFragmentPath=${state.fragment}\nDropInPaths=${state.dropIns}\nUnitFileState=${state.enabled ? 'enabled' : 'disabled'}\nActiveState=${state.live ? 'active' : 'inactive'}\n`, stderr: '' };
    if (command === 'systemctl' && args.includes('disable')) {
      events.push('disable-old'); state.enabled = false; state.live = false;
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
  const input = { roles: [{ name, identity }], binPath, platform, configPath: '/fixture/fleet.yaml', exec, register };
  const receiptPath = join(stateRoot(), 'supervisor/legacy-permanent', `${name}.json`);
  return { name, identity, dir, nativePath, receiptPath, state, events, catalog, input, register, exec };
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
it.each(['linux', 'darwin'] as const)('preserves stopped intent during %s migration', async platform => {
  const f = fixture(platform); f.state.live = false;
  await migrateLegacyPermanentMembers(f.input);
  expect(f.catalog.get(f.name)).toBe('stopped');
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
  if (phase === 'prepared') f.exec.mockImplementationOnce(async () => ({ code: 0,
    stdout: `LoadState=loaded\nFragmentPath=${f.nativePath}\nDropInPaths=\nUnitFileState=enabled\nActiveState=active\n`, stderr: '' }));
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
  if (mode === 'foreign-command') writeFileSync(f.nativePath, '[Service]\nExecStart=/foreign/daemon\n');
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
  await expect(migrateLegacyPermanentMembers(f.input)).rejects.toThrow('LEGACY_PERMANENT_PROCESS_STILL_RUNNING');
  expect(f.register).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(f.receiptPath, 'utf8')).phase).toBe('native-retired');
  f.exec.mockImplementation(original);
  await migrateLegacyPermanentMembers(f.input); expect(f.catalog.get(f.name)).toBe('running');
});
