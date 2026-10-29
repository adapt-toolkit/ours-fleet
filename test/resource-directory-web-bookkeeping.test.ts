import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {FleetResourceViews} from '../src/web/resource-views.js';
import {publishFleetResourceCommit} from '../src/application/resource-observer.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();vi.unstubAllEnvs();});
function fixture(resource:string,file:string,boundary=''){
 const root=mkdtempSync(join(tmpdir(),'directory-web-bookkeeping-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));vi.stubEnv('OURS_FLEET_HOME',root);
 const web=join(root,'.ours-fleet','web'),path=join(web,file),roles=join(root,'roles');mkdirSync(dirname(path),{recursive:true});mkdirSync(roles);
 let reads=0,running=true,churn=true;const callbacks=new Map<string,(e:string,n:string|null)=>void>();
 const response=Object.assign(new EventEmitter(),{write:vi.fn(()=>true),end:vi.fn()});
 const resources=new FleetResourceViews({configPath:boundary==='explicit'?path:join(root,'fleet.yaml'),roots:boundary==='root'?[web]:[roles],paths:[web,roles],watch:(p,fn)=>{callbacks.set(p,fn);return Object.assign(new EventEmitter(),{close(){}});}},async()=>{
  reads++;await Promise.resolve();if(churn)callbacks.get(dirname(path))!('change',boundary==='ancestor'?null:basename(path));await Promise.resolve();return {roles:[{id:'a',readiness:running?'running':'idle'}]};
 },()=>[],0);cleanup.push(()=>resources.close());const c=resources.open(response as any,'owner',()=>true),binding=resources.register('owner',c.connectionId,'view',1,{viewId:'view',resource,...(resource==='previews'?{ids:['a']}:{})});
 const frames=()=>response.write.mock.calls.map(([s])=>String(s)).filter(s=>s.startsWith('event: resource\n')).map(s=>JSON.parse(s.split('data: ')[1]));
 return {bound:()=>resources.bound('owner',c.connectionId,'view',1,binding.baselineId),reads:()=>reads,frames,noise(){callbacks.get(dirname(path))!('change',basename(path));},idle(){churn=false;running=false;publishFleetResourceCommit(join(roles,'a','.session-events.jsonl'));}};
}
for(const resource of ['directory','roles','previews'])for(const file of ['workspace-devices.db','workspace-devices.db-wal','workspace-devices.db-shm','workspace-devices.db-journal','audit/audit.jsonl'])it(`keeps ${resource} ready through unrelated web ${file} writes`,async()=>{
 const f=fixture(resource,file);await expect(f.bound()).resolves.toMatchObject({payload:{roles:[{readiness:'running'}]}});expect(f.reads()).toBe(1);
 f.noise();await new Promise(setImmediate);expect(f.reads()).toBe(1);
 f.idle();await expect.poll(()=>f.frames().filter(r=>r.kind==='snapshot').at(-1)?.payload.roles[0].readiness).toBe('idle');expect(f.frames().some(r=>r.kind==='resync')).toBe(false);
});
for(const file of ['access.json','audit/unknown.jsonl','unknown.db-wal'])it(`keeps capture fence for web ${file}`,async()=>{
 const f=fixture('directory',file);await expect(f.bound()).rejects.toThrow('projection unstable');expect(f.reads()).toBe(3);
});
for(const boundary of ['explicit','root','ancestor'])it(`keeps web-bookkeeping ${boundary} capture fence`,async()=>{
 const f=fixture('directory','workspace-devices.db-wal',boundary);await expect(f.bound()).rejects.toThrow('projection unstable');expect(f.reads()).toBe(3);
});
it('does not widen the exclusion to other resource projections',async()=>{
 const f=fixture('tasks','workspace-devices.db-wal');await expect(f.bound()).rejects.toThrow('projection unstable');expect(f.reads()).toBe(3);
});
