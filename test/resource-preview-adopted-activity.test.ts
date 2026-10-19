import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetResourceViews } from '../src/web/resource-views.js';
import { publishFleetResourceCommit } from '../src/application/resource-observer.js';

const adoptedHome=vi.hoisted(()=>({path:''}));
vi.mock('node:os',async importOriginal=>({...await importOriginal<typeof import('node:os')>(),homedir:()=>adoptedHome.path}));
const clean:Array<()=>void>=[];
afterEach(()=>{for(const dispose of clean.splice(0).reverse())dispose();});
function fixture(changed:string, resource='previews', explicitConfig=false, roleRoot=false, unknownWake=false) {
 const root=mkdtempSync(join(tmpdir(),'preview-adopted-activity-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 adoptedHome.path=root;const adopted=join(homedir(),'.codex');mkdirSync(adopted,{mode:0o700});const roles=join(root,'agents');mkdirSync(roles,{mode:0o700});let reads=0,value='initial';
 const callbacks=new Map<string,(event:string,name:string|null)=>void>();
 const response=Object.assign(new EventEmitter(),{write:vi.fn(()=>true),end:vi.fn()});
 const resources=new FleetResourceViews({paths:[roles,adopted],roots:roleRoot?[adopted]:[roles],configPath:explicitConfig?join(adopted,changed):join(root,'fleet.yaml'),watch:(path,callback)=>{callbacks.set(path,callback);return Object.assign(new EventEmitter(),{close(){}});}},async()=>{
  reads++;if(unknownWake)callbacks.get(adopted)!('change',null);else publishFleetResourceCommit(join(adopted,changed));return {value};
 });clean.push(()=>resources.close());
 const connection=resources.open(response as any,'owner',()=>true);
 const binding=resources.register('owner',connection.connectionId,'view',1,{viewId:'view',resource,...(resource==='previews'?{ids:['selected']}:{})});
 const bound=()=>resources.bound('owner',connection.connectionId,'view',1,binding.baselineId);
 const frames=()=>response.write.mock.calls.map(([s])=>String(s)).filter(s=>s.startsWith('event: resource\n')).map(s=>JSON.parse(s.split('data: ')[1]));
 return {root,adopted,resources,connection,binding,bound,frames,callbacks,reads:()=>reads,update(){value='committed';publishFleetResourceCommit(join(roles,'selected','.conversation','events-000001.jsonl'));}};
}
for(const changed of ['history.jsonl','models_cache.json','state_5.sqlite','logs_2.sqlite-wal','thread_history_1.sqlite-shm','queue_1.sqlite-journal','goals_1.sqlite-wal'])it(`keeps previews ready through adopted Codex activity ${changed}`,async()=>{
 const f=fixture(changed);expect((await f.bound()).payload).toEqual({value:'initial'});expect(f.reads()).toBe(1);
 for(let n=0;n<5;n++)f.callbacks.get(f.adopted)!('change',changed);
 await new Promise(setImmediate);expect(f.reads()).toBe(1);
 f.update();await expect.poll(()=>f.frames().filter(frame=>frame.kind==='snapshot').at(-1).payload).toEqual({value:'committed'});expect(f.reads()).toBe(2);expect(f.frames().some(frame=>['resync','health'].includes(frame.kind))).toBe(false);
});
for(const [resource,changed,explicit]of [['previews','auth.json',false],['previews','config.toml',false],['previews','unknown.sqlite-wal',false],['previews','nested/state_5.sqlite-wal',false],['previews','history.jsonl',true],['subscriptions','state_5.sqlite-wal',false],['directory','logs_2.sqlite-wal',false]]as const)it(`retains three-attempt capture fence for ${resource} ${changed} explicit=${explicit}`,async()=>{
 const f=fixture(changed,resource,explicit);await expect(f.bound()).rejects.toThrow('projection unstable');expect(f.reads()).toBe(3);expect(f.frames().some(frame=>frame.kind==='snapshot')).toBe(false);
});

it('retains capture fencing when an activity-shaped path belongs to a declared role root',async()=>{
 const f=fixture('state_5.sqlite-wal','previews',false,true);await expect(f.bound()).rejects.toThrow('projection unstable');expect(f.reads()).toBe(3);
});
it('retains capture fencing for an unknown directory-level adopted-home wake',async()=>{
 const f=fixture('history.jsonl','previews',false,false,true);await expect(f.bound()).rejects.toThrow('projection unstable');expect(f.reads()).toBe(3);
});
