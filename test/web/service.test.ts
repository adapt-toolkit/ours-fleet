import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../src/exec.js';
import {
  launchdPlist, systemdUnit, WebServiceManager, WEB_LAUNCHD_LABEL, WEB_SYSTEMD_UNIT,
} from '../../src/web/service.js';

function fixture(platform: 'linux' | 'darwin', environment: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ours-fleet-web-service-'));
  const executable = join(root, 'ours fleet & safe');
  writeFileSync(executable, 'console.log("fixture")\n', { mode: 0o644 });
  const calls: Array<[string, string[]]> = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, args]);
    if (command === 'loginctl') return { code: 0, stdout: 'no\n', stderr: '' };
    if (command === 'launchctl' && args[0] === 'print')
      return { code: 1, stdout: '', stderr: 'could not find service' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new WebServiceManager({
    platform, exec, homeDir: root, stateDir: join(root, 'state'), uid: 123,
    runtimeExecutable: process.execPath, environment,
  });
  return { root, executable, calls, manager };
}

describe('native supervised web service', () => {
  it('atomically installs a private systemd user unit without enabling linger', async () => {
    const { executable, calls, manager } = fixture('linux');
    const messages = await manager.install(executable, 49_271, '/tmp/fleet config.yaml');
    const unit = readFileSync(manager.definitionPath, 'utf8');
    const metadata = readFileSync(manager.metadataPath, 'utf8');
    expect(unit).toContain(
      `ExecStart="${process.execPath}" "${executable}" web serve --port 49271 --no-open`,
    );
    expect(statSync(executable).mode & 0o111).toBe(0);
    expect(spawnSync(process.execPath, [executable], { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(metadata)).toMatchObject({ runtime: process.execPath, script: executable });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toMatch(/#bootstrap|device|secret/i);
    expect(metadata).not.toMatch(/secret|credential|cookie/i);
    expect(statSync(manager.definitionPath).mode & 0o777).toBe(0o600);
    expect(statSync(manager.metadataPath).mode & 0o777).toBe(0o600);
    expect(calls).toContainEqual(['systemctl', ['--user', 'enable', WEB_SYSTEMD_UNIT]]);
    expect(calls.some(([command, args]) => command === 'loginctl' && args.includes('enable-linger'))).toBe(false);
    expect(messages.join('\n')).toContain('requires linger');
    await manager.start();
    await manager.restart();
    await manager.stop();
    expect(calls).toContainEqual(['systemctl', ['--user', 'start', WEB_SYSTEMD_UNIT]]);
    expect(await manager.uninstall()).toContain('uninstalled');
  });

  it('writes an escaped launchd LaunchAgent and manages it in the owner GUI domain', async () => {
    const { executable, calls, manager } = fixture('darwin');
    await manager.install(executable, 49_271, '/tmp/a&b.yaml');
    const plist = readFileSync(manager.definitionPath, 'utf8');
    expect(plist).toContain('ours fleet &amp; safe');
    expect(plist).toContain(process.execPath);
    expect(plist).toContain('/tmp/a&amp;b.yaml');
    expect(plist).not.toMatch(/#bootstrap|device|secret/i);
    await manager.start();
    expect(calls).toContainEqual([
      'launchctl', ['bootstrap', 'gui/123', manager.definitionPath],
    ]);
    await manager.restart();
    await manager.stop();
    expect(await manager.uninstall()).toContain(WEB_LAUNCHD_LABEL);
  });

  it('reloads a loaded macOS job with the retained actual listener and profile', async () => {
    const root=mkdtempSync(join(tmpdir(),'fleet-launchd-retain-'));
    const executable=join(root,'fleet.js');writeFileSync(executable,'// fixture');
    let loadedPort:number|undefined=49271;
    const events:string[]=[];
    let manager:WebServiceManager;
    const exec:Exec=async (_command,args)=>{
      events.push(args[0]);
      if(args[0]==='print')return {code:loadedPort===undefined?1:0,stdout:'',stderr:''};
      if(args[0]==='bootout')loadedPort=undefined;
      if(args[0]==='bootstrap'){
        const plist=readFileSync(manager.definitionPath,'utf8');
        const match=plist.match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/);
        if(!match)throw Error('No persisted launchd listener');
        loadedPort=Number(match[1]);
      }
      return {code:0,stdout:'',stderr:''};
    };
    manager=new WebServiceManager({platform:'darwin',exec,homeDir:root,stateDir:join(root,'state'),uid:123,environment:{OURS_CONFIG:join(root,'profile.json')}});
    await manager.retainBoundPort(executable,49272,join(root,'fleet.yaml'),{bind:'127.0.0.1',publicOrigin:'https://fixture.ours-tunnel.com'});
    expect(loadedPort).toBe(49272);
    expect(events).toEqual(['bootout','print','bootstrap']);
    expect(manager.readMetadata()).toMatchObject({port:49272,publicOrigin:'https://fixture.ours-tunnel.com',environment:{OURS_CONFIG:join(root,'profile.json')}});
    await manager.restart();expect(loadedPort).toBe(49272);
  });

  it('quotes template arguments without shell interpolation', () => {
    const unit = systemdUnit('/runtime/node', '/tmp/a";%n', 49_271, '/tmp/$(touch nope)');
    expect(unit).toContain('/tmp/a\\";%%n');
    expect(unit).toContain('"/tmp/$(touch nope)"');
    const plist = launchdPlist('/runtime/node', '/tmp/a<&', 49_271, '/tmp/"config"');
    expect(plist).toContain('/tmp/a&lt;&amp;');
    expect(plist).toContain('/tmp/&quot;config&quot;');
  });

  it('persists explicit reverse-proxy bind/origin arguments without credentials', async () => {
    const { executable, manager } = fixture('linux');
    await manager.install(executable, 49_271, undefined, {
      bind: '127.0.0.1', publicOrigin: 'https://fleet.example.com',
    });
    const unit = readFileSync(manager.definitionPath, 'utf8');
    const metadata = readFileSync(manager.metadataPath, 'utf8');
    expect(unit).toContain('--bind "127.0.0.1"');
    expect(unit).toContain('--public-origin "https://fleet.example.com"');
    expect(JSON.parse(metadata)).toMatchObject({
      version: 3, bind: '127.0.0.1', publicOrigin: 'https://fleet.example.com',
    });
    expect(metadata).not.toMatch(/password|secret|credential/i);
  });

  it.each(['linux', 'darwin'] as const)('retains selected profile and tool paths on %s without inherited secrets', async platform => {
    const environment = {
      OURS_CONFIG: '/tmp/selected profile&%n.json', OURS_FLEET_HOME: '/tmp/fleet home',
      PATH: '/private/tools/bin:/usr/bin', OURS_API_TOKEN: 'unrelated-private-value',
    };
    const { executable, manager } = fixture(platform, environment);
    await manager.install(executable);
    const definition = readFileSync(manager.definitionPath, 'utf8');
    const metadata = JSON.parse(readFileSync(manager.metadataPath, 'utf8'));
    expect(metadata.environment).toEqual({
      OURS_CONFIG: environment.OURS_CONFIG, OURS_FLEET_HOME: environment.OURS_FLEET_HOME,
      PATH: environment.PATH,
    });
    expect(definition).toContain(platform === 'linux'
      ? 'Environment="OURS_CONFIG=/tmp/selected profile&%%n.json"'
      : '<key>OURS_CONFIG</key><string>/tmp/selected profile&amp;%n.json</string>');
    expect(definition).toContain('/private/tools/bin:/usr/bin');
    expect(definition).not.toContain('unrelated-private-value');
    expect(JSON.stringify(metadata)).not.toContain('OURS_API_TOKEN');
  });

  it('rejects newline injection in service path settings', () => {
    expect(() => fixture('linux', { PATH: '/bin\nExecStart=/malicious' })).toThrow('invalid service path setting');
  });

  it('accepts version-2 local metadata as the safe pairing migration', async () => {
    const { executable, manager } = fixture('linux');
    await manager.install(executable);
    const metadata = JSON.parse(readFileSync(manager.metadataPath, 'utf8'));
    writeFileSync(manager.metadataPath, JSON.stringify({ ...metadata, version: 2 }));
    expect(manager.readMetadata()).toMatchObject({ version: 3, port: 49_271 });
    await expect(manager.start()).resolves.toBeUndefined();
  });
});
