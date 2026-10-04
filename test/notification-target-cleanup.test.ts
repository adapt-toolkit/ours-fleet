import {expect,it} from 'vitest';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {retireNotificationTarget,drainNotificationTargetCleanup} from '../src/notifications/target-cleanup.js';
it('persists exact source cleanup on outage and replays through authenticated producer gateway',async()=>{
 mkdirSync('.test-artifacts',{recursive:true});
 const dir=mkdtempSync(join('.test-artifacts','target-cleanup-')),url='/fleet/chats?chat=deleted-agent';
 const config={origin:'http://127.0.0.1:1/notifications',token:'fixture-producer',gatewayCredential:'fixture-gateway'};
 const calls:Array<{url:unknown;init?:RequestInit}>=[];let failure=true;
 const request=(async(url:unknown,init?:RequestInit)=>{calls.push({url,init});return new Response('{}',{status:failure?503:200});}) as typeof fetch;
 await retireNotificationTarget(url,config,dir,request);expect(readdirSync(dir)).toHaveLength(1);expect(JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8'))).toEqual({url});
 expect(calls[0]).toMatchObject({url:config.origin+'/api/v1/delete-target',init:{method:'POST',redirect:'error',headers:{'X-Ours-Api-Token':config.gatewayCredential,'X-Ours-Notifications-Producer':config.token},body:JSON.stringify({url})}});
 failure=false;await drainNotificationTargetCleanup(config,dir,request);expect(readdirSync(dir)).toHaveLength(0);expect(calls).toHaveLength(2);
});
