import { expect, it, vi } from 'vitest';
import { createServer, get } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetNotificationProducer } from '../src/notifications/fleet-producer.js';

it('serves real HTTP during a native-observed twelve-role backlog and catches up every checkpoint without notification sends',async()=>{
  const home=mkdtempSync(join(tmpdir(),'notification-native-http-')),root=join(home,'agents');mkdirSync(root);
  vi.stubEnv('OURS_FLEET_HOME',home);const request=vi.fn();vi.stubGlobal('fetch',request);
  const producer=new FleetNotificationProducer([root],join(home,'outboxes'),{origin:'http://127.0.0.1:1',token:'x'.repeat(40)});
  const queues=()=>(producer as any).queues as Map<string,any>;
  let total=0,servedAt=-1;
  const progress=()=>[...queues().values()].reduce((sum,queue)=>sum+(queue.checkpoint?.offset??0),0);
  const server=createServer((_req,res)=>{servedAt=progress();res.end('ready');});
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    for(let n=0;n<12;n++){
      const role='Role'+n,dir=join(root,role,'.conversation');mkdirSync(dir,{recursive:true});
      const text=Array.from({length:1800},(_,seq)=>JSON.stringify({schemaVersion:1,roleId:role,sessionGeneration:'g',kind:'message.chunk',seq:seq+1,payload:{text:'x'.repeat(256)}})+'\n').join('');
      total+=Buffer.byteLength(text);writeFileSync(join(dir,'events-000001.jsonl'),text);
    }
    const response=new Promise<void>((resolve,reject)=>{
      get(`http://127.0.0.1:${(server.address() as any).port}`,res=>{
        expect(res.statusCode).toBe(200);res.resume();res.on('end',resolve);
      }).on('error',reject);
    });
    producer.poll();await response;
    expect(servedAt).toBeGreaterThanOrEqual(0);expect(servedAt).toBeLessThan(total);
    await expect.poll(progress,{timeout:3000}).toBe(total);expect(queues().size).toBe(12);
    expect(request).not.toHaveBeenCalled();
  }finally{
    await producer.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});
  }
});
