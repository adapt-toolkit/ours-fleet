import {expect,it} from 'vitest';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {retireNotificationTarget,drainNotificationTargetCleanup} from '../src/notifications/target-cleanup.js';
it('persists exact source cleanup on outage and replays through authenticated producer gateway',async()=>{
 mkdirSync('.test-artifacts',{recursive:true});
 const dir=mkdtempSync(join('.test-artifacts','target-cleanup-')),url='/fleet/chats/agents/deleted-agent';
 const config={origin:'http://127.0.0.1:1/notifications',token:'fixture-producer',gatewayCredential:'fixture-gateway'};
 const calls:Array<{url:unknown;init?:RequestInit}>=[];let failure=true;
 const request=(async(url:unknown,init?:RequestInit)=>{calls.push({url,init});return new Response('{}',{status:failure?503:200});}) as typeof fetch;
 await retireNotificationTarget(url,config,dir,request);expect(readdirSync(dir)).toHaveLength(1);expect(JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8'))).toEqual({url});
 expect(calls[0]).toMatchObject({url:config.origin+'/api/v1/delete-target',init:{method:'POST',redirect:'error',headers:{'X-Ours-Api-Token':config.gatewayCredential,'X-Ours-Notifications-Producer':config.token},body:JSON.stringify({url})}});
 failure=false;await drainNotificationTargetCleanup(config,dir,request);expect(readdirSync(dir)).toHaveLength(0);expect(calls).toHaveLength(2);
});

it('retains obsolete and malformed cleanup records without sending or invoking absence checks',async()=>{
 mkdirSync('.test-artifacts',{recursive:true});
 const dir=mkdtempSync(join('.test-artifacts','unsupported-target-'));
 const config={origin:'http://127.0.0.1:1',token:'t'.repeat(40)};
 let calls=0,checks=0;
 const request=(async()=>{calls++;return new Response('{}');}) as typeof fetch;
 const urls=['/fleet/chats?chat=old','/fleet/chats/agents/A/extra','/fleet/chats/contacts/A','/fleet/chats/agents/%2f','/fleet/chats/agents/A?chat='];
 for(const url of urls)await retireNotificationTarget(url,config,dir,request);
 await drainNotificationTargetCleanup(config,dir,request,{beforeDelete:async()=>{checks++;return false;}});
 expect(calls).toBe(0);expect(checks).toBe(0);expect(readdirSync(dir)).toHaveLength(urls.length);
});
it('recognizes canonical encoded role IDs and filter/anchor variants for cleanup',async()=>{
 mkdirSync('.test-artifacts',{recursive:true});const dir=mkdtempSync(join('.test-artifacts','encoded-target-'));
 const config={origin:'http://127.0.0.1:1',token:'t'.repeat(40)};const bodies:string[]=[];
 const request=(async(_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));return new Response('{}');}) as typeof fetch;
 const url='/fleet/chats/agents/%6Eew?scope=All#fleet-message-X';
 await retireNotificationTarget(url,config,dir,request);expect(bodies).toEqual([JSON.stringify({url})]);
 await drainNotificationTargetCleanup(config,dir,request,{beforeDelete:async()=>false});expect(readdirSync(dir)).toHaveLength(0);
});

it('retained obsolete records do not consume the canonical cleanup batch',async()=>{
 mkdirSync('.test-artifacts',{recursive:true});const dir=mkdtempSync(join('.test-artifacts','cleanup-batch-'));
 const config={origin:'http://127.0.0.1:1',token:'t'.repeat(40)};
 for(let i=0;i<33;i++)writeFileSync(join(dir,i.toString(16).padStart(64,'0')+'.json'),JSON.stringify({url:'/fleet/chats?chat=old-'+i}));
 const url='/fleet/chats/agents/new';writeFileSync(join(dir,'f'.repeat(64)+'.json'),JSON.stringify({url}));
 const bodies:string[]=[];const request=(async(_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));return new Response('{}');}) as typeof fetch;
 await drainNotificationTargetCleanup(config,dir,request);
 expect(bodies).toEqual([JSON.stringify({url})]);expect(readdirSync(dir)).toHaveLength(33);
});
