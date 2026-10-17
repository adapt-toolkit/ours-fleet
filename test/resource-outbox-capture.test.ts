import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtempSync,realpathSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,basename,dirname} from 'node:path';
import {FleetResourceViews} from '../src/web/resource-views.js';
import {NotificationOutbox} from '../src/notifications/outbox.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.reverse())fn();cleanup.length=0;vi.unstubAllEnvs();});
for(const resource of ['roles','directory'])it(`keeps ${resource} capture live through actual notification outbox checkpoint commits`,async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'fleet-outbox-capture-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));vi.stubEnv('OURS_FLEET_HOME',root);
 const outboxDir=join(root,'.ours-fleet','web','notification-outboxes'),file=join(outboxDir,'a'.repeat(64)+'.json');mkdirSync(outboxDir,{recursive:true});
 const outbox=new NotificationOutbox(file,{origin:'http://127.0.0.1',token:'unused'},async()=>{throw Error('no queued delivery');});cleanup.push(()=>{void outbox.close();});
 const callbacks=new Map<string,(event:string,name:string|null)=>void>();let reads=0;
 const resources=new FleetResourceViews({configPath:join(root,'fleet.yaml'),watch:(path,callback)=>{callbacks.set(path,callback);return Object.assign(new EventEmitter(),{close(){}});}},async()=>{
  const seen=reads++;await Promise.resolve();if(reads<=8){outbox.saveCheckpoint({offset:reads});callbacks.get(outboxDir)!('rename',basename(file));await Promise.resolve();}return {reads:seen};
 });cleanup.push(()=>resources.close());const response=Object.assign(new EventEmitter(),{write:vi.fn(()=>true),end:vi.fn()});const c=resources.open(response as any,'owner',()=>true);const binding=resources.register('owner',c.connectionId,'view',1,{viewId:'view',resource});
 await expect(resources.bound('owner',c.connectionId,'view',1,binding.baselineId)).resolves.toMatchObject({payload:{reads:0}});
 for(let n=0;n<20&&reads<=8;n++)await new Promise(setImmediate);
 expect(reads).toBeGreaterThan(8);const frames=response.write.mock.calls.map(([s])=>String(s)).filter(s=>s.startsWith('event: resource\n')).map(s=>JSON.parse(s.split('data: ')[1]));expect(frames.some(f=>f.kind==='resync')).toBe(false);expect(frames.filter(f=>f.kind==='snapshot').at(-1).payload.reads).toBe(8);
});
it.each(['fleet.yaml','.ours-fleet/tasks/member.json','.ours-fleet/web/notification-outboxes/unknown.json'])('retains structural invalidation for %s',async changed=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'fleet-outbox-boundary-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));vi.stubEnv('OURS_FLEET_HOME',root);const file=join(root,changed);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'{}');const callbacks=new Map<string,(event:string,name:string|null)=>void>();let reads=0;
 const resources=new FleetResourceViews({configPath:join(root,'fleet.yaml'),watch:(path,callback)=>{callbacks.set(path,callback);return Object.assign(new EventEmitter(),{close(){}});}},async()=>{reads++;await Promise.resolve();callbacks.get(dirname(file))!('rename',basename(file));await Promise.resolve();return {};});cleanup.push(()=>resources.close());const response=Object.assign(new EventEmitter(),{write:vi.fn(()=>true),end:vi.fn()});const c=resources.open(response as any,'owner',()=>true),binding=resources.register('owner',c.connectionId,'view',1,{viewId:'view',resource:'directory'});await expect(resources.bound('owner',c.connectionId,'view',1,binding.baselineId)).rejects.toThrow('projection unstable');expect(reads).toBe(3);
});
