import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetResourceViews } from '../src/web/resource-views.js';
import { FleetConfigService } from '../src/web/fleet-config-service.js';
import { fleetDDir } from '../src/paths.js';
import { publishFleetResourceCommit } from '../src/application/resource-observer.js';
import { writeV2Fixture } from './v2-fixture.js';

it('retires a valid custom-manifest capture when global legacy YAML appears, then binds a repaired configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-validation-'));
  vi.stubEnv('OURS_FLEET_HOME', home);
  const file = join(home, 'custom.yaml');
  writeV2Fixture(file, {roles:{Alpha:{harness:'codex', session:'acp'}}});
  mkdirSync(fleetDDir(), {recursive:true});
  const service = new FleetConfigService({configPath:file});
  const response = Object.assign(new EventEmitter(), {write:vi.fn(() => true), end:vi.fn()});
  const resources = new FleetResourceViews({paths:[home], roots:[], configPath:file,
    watch:() => Object.assign(new EventEmitter(), {close(){}})}, async () => service.read());
  try {
    const connection = resources.open(response as any, 'owner', () => true);
    const register = (epoch:number) => resources.register('owner', connection.connectionId, 'config', epoch, {viewId:'config', resource:'configuration'});
    const bound = (epoch:number, baselineId:string) => resources.bound('owner', connection.connectionId, 'config', epoch, baselineId);
    const initial = register(1); await bound(1, initial.baselineId);
    const legacy = join(fleetDDir(), 'legacy.yaml'); writeFileSync(legacy, 'roles: {}\n');
    expect(() => service.read()).toThrow('legacy fleet.d'); publishFleetResourceCommit(legacy);
    await expect.poll(() => response.write.mock.calls.some(([text]) => String(text).includes('"kind":"resync"'))).toBe(true);
    await expect(bound(1, initial.baselineId)).rejects.toThrow('retired');
    rmSync(legacy); publishFleetResourceCommit(legacy);
    const repaired = register(2);
    expect((await bound(2, repaired.baselineId)).payload).toMatchObject({model:{agents:{Alpha:{}}}});
  } finally { resources.close(); vi.unstubAllEnvs(); rmSync(home, {recursive:true, force:true}); }
});

for (const kind of ['invite', 'prompt']) it(`invalidates a currently observed external ${kind} validation input without rereading config on unrelated activity`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-external-'));
  vi.stubEnv('OURS_FLEET_HOME', home);
  const file = join(home, 'custom.yaml'), input = join(home, 'runtime', `${kind}.txt`);
  mkdirSync(join(home, 'runtime')); writeFileSync(input, 'synthetic fixture input');
  writeV2Fixture(file, {roles:{Alpha:{harness:'codex', session:'acp'}}, vars:{INPUT:input},
    ...(kind === 'invite' ? {rooms:{owner:{expected_cid:'a'.repeat(64), public_invite_file:'${INPUT}'}}}
      : {watchdogs:{check:{coordinator:'Alpha', prompt_file:'${INPUT}'}}})});
  const service = new FleetConfigService({configPath:file});
  const read = vi.spyOn(service, 'read');
  const response = Object.assign(new EventEmitter(), {write:vi.fn(() => true), end:vi.fn()});
  const resources = new FleetResourceViews({paths:[home], roots:[], configPath:file,
    watch:() => Object.assign(new EventEmitter(), {close(){}})}, async () => service.read(), () => service.resourceValidationInputs());
  try {
    const connection = resources.open(response as any, 'owner', () => true);
    const register = (epoch:number) => resources.register('owner', connection.connectionId, 'config', epoch, {viewId:'config', resource:'configuration'});
    const bound = (epoch:number, baselineId:string) => resources.bound('owner', connection.connectionId, 'config', epoch, baselineId);
    const first = register(1); await bound(1, first.baselineId);
    expect(service.resourceValidationInputs()).toContain(input);
    for (let n=0;n<20;n++) publishFleetResourceCommit(join(home, 'runtime', 'status.json'));
    await new Promise(setImmediate); expect(read).toHaveBeenCalledTimes(1);
    rmSync(input); publishFleetResourceCommit(input);
    await expect.poll(() => response.write.mock.calls.some(([text]) => String(text).includes('"kind":"resync"'))).toBe(true);
    await expect(bound(1, first.baselineId)).rejects.toThrow('retired');
    writeFileSync(input, 'repaired synthetic fixture input'); publishFleetResourceCommit(input);
    const repaired = register(2); await bound(2, repaired.baselineId);
  } finally { resources.close(); vi.unstubAllEnvs(); rmSync(home, {recursive:true, force:true}); }
});

for (const malformed of ['API_KEY: [synthetic-canary-value\n', 'API_KEY: synthetic-canary-value\nAPI_KEY: duplicate-canary-value\n'])
  it('normalizes malformed YAML without including sensitive source excerpts', () => {
    const home=mkdtempSync(join(tmpdir(),'configuration-parse-error-')), file=join(home,'fleet.yaml');
    try {
      writeV2Fixture(file,{roles:{Alpha:{harness:'codex',session:'acp'}}});
      writeFileSync(file,'api_version: ours.network/fleet/v2\nenv:\n  '+malformed.replaceAll('\n','\n  '));
      let failure:any;try{new FleetConfigService({configPath:file}).read();}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'invalid_request'});
      expect(failure.message).not.toContain('synthetic-canary-value');
      expect(failure.message).not.toContain('duplicate-canary-value');
    }finally{rmSync(home,{recursive:true,force:true});}
  });
