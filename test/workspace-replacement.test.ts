import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginWorkspaceReplacement, clearReplacedWorkspaceLocalState, confirmWorkspaceReplacement, finishWorkspaceReplacement, readWorkspaceReplacement, sameWorkspaceBinding, refreshWorkspaceReplacement, abandonWorkspaceReplacement, requiresWorkspaceReplacement, readWorkspaceBinding } from '../src/workspace-replacement.js';
import { WorkspaceDeviceStore } from '../src/web/workspace-devices.js';
import type { WorkspacePayload } from '../src/workspace-enrollment.js';
const ROOT='a'.repeat(64), SERVER='b'.repeat(64);
const undo:Array<()=>void>=[];
afterEach(()=>{for(const step of undo.splice(0).reverse())step();});
function host(){
 const dir=mkdtempSync(join(tmpdir(),'replacement-')),prior=process.env.OURS_FLEET_HOME;process.env.OURS_FLEET_HOME=dir;
 undo.push(()=>{if(prior===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=prior;rmSync(dir,{recursive:true,force:true});});
 const workspace=join(dir,'.ours-fleet','workspace');mkdirSync(workspace,{recursive:true});
 const devices=new WorkspaceDeviceStore(),hostWorkspaceId=devices.workspaceId;devices.close();
 const previous={workspaceId:'o'.repeat(43),hostWorkspaceId,appOrigin:'https://app.ours-tunnel.com',serverCid:SERVER,proofRootCid:ROOT};
 writeFileSync(join(workspace,'binding.json'),JSON.stringify(previous),{mode:0o600});
 const payload:WorkspacePayload={version:1,appOrigin:previous.appOrigin,hostname:'new-home.ours-tunnel.com',rootName:'alice@home',name:'Alice',surname:'Tester',connectorToken:'fixture-private-token',invitation:'fixture-invitation',serverCid:SERVER,challenge:{workspaceId:'w'.repeat(43),accountId:'c'.repeat(43),nonce:'n'.repeat(43),expiresAt:Date.now()+600000}};
 return {dir,workspace,previous,payload,config:join(dir,'fleet.yaml')};
}
describe('registration replacement consent and recovery',()=>{
 it.each(['n','','no','maybe'])('preserves setup for answer %j',async answer=>{const h=host(),before=readFileSync(join(h.workspace,'binding.json'),'utf8');const ask=vi.fn(async()=>answer),write=vi.fn();expect(await confirmWorkspaceReplacement(h.previous,false,{interactive:true,ask,write})).toBe(false);expect(ask).toHaveBeenCalledOnce();expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);});
 it('requires consent in a pipe and treats failed input as refusal',async()=>{const h=host(),ask=vi.fn(async()=>{throw Error('EOF');});expect(await confirmWorkspaceReplacement(h.previous,false,{interactive:false,ask,write:()=>{}})).toBe(false);expect(ask).not.toHaveBeenCalled();expect(await confirmWorkspaceReplacement(h.previous,false,{interactive:true,ask,write:()=>{}})).toBe(false);});
 it.each(['y','YES',' yes '])('accepts explicit terminal confirmation %j',async answer=>{const h=host();expect(await confirmWorkspaceReplacement(h.previous,false,{interactive:true,ask:async()=>answer,write:()=>{}})).toBe(true);});
 it('allows the explicit flag and recognizes the same pinned registration',async()=>{const h=host();expect(await confirmWorkspaceReplacement(h.previous,true,{interactive:false,write:()=>{}})).toBe(true);expect(sameWorkspaceBinding(h.previous,{...h.payload,challenge:{...h.payload.challenge,workspaceId:h.previous.workspaceId}})).toBe(true);expect(sameWorkspaceBinding(h.previous,h.payload)).toBe(false);});
 it('never retires the same workspace for an origin or server change, even with consent',async()=>{
   const h=host(),before=readFileSync(join(h.workspace,'binding.json'),'utf8');
   const origin={...h.payload,challenge:{...h.payload.challenge,workspaceId:h.previous.workspaceId},appOrigin:'https://app.ours.network'};
   expect(()=>requiresWorkspaceReplacement(h.previous,{workspaceId:h.previous.workspaceId,serverCid:SERVER,appOrigin:origin.appOrigin})).toThrow('migrate-app-origin');
   expect(requiresWorkspaceReplacement(h.previous,{workspaceId:h.previous.workspaceId,serverCid:SERVER,appOrigin:origin.appOrigin},true)).toBe(false);
   await expect(beginWorkspaceReplacement(h.previous,origin,h.config,{preflight:vi.fn()})).rejects.toThrow('migrate-app-origin');
   await expect(beginWorkspaceReplacement(h.previous,{...origin,appOrigin:h.previous.appOrigin,serverCid:'f'.repeat(64)},h.config,{preflight:vi.fn()})).rejects.toThrow('retain the enrollment server');
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);
 });
 it('allows a legacy binding to rerun only its own workspace',()=>{
   const h=host();delete (h.previous as {serverCid?:string}).serverCid;
   writeFileSync(join(h.workspace,'binding.json'),JSON.stringify(h.previous));
   const old=readWorkspaceBinding()!;
   expect(requiresWorkspaceReplacement(old,{workspaceId:old.workspaceId,serverCid:SERVER,appOrigin:old.appOrigin})).toBe(false);
   expect(()=>requiresWorkspaceReplacement(old,{workspaceId:h.payload.challenge.workspaceId,serverCid:SERVER,appOrigin:old.appOrigin})).toThrow('Rerun its own');
 });
 it('preflights before saving private recovery and can abandon an unsent operation',async()=>{
   const h=host(),before=readFileSync(join(h.workspace,'binding.json'),'utf8');
   await expect(beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>{throw Error('root/host/service unavailable');}})).rejects.toThrow('unavailable');
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);
   expect(requiresWorkspaceReplacement(h.previous,{workspaceId:h.previous.workspaceId,serverCid:SERVER,appOrigin:h.previous.appOrigin})).toBe(false);
   await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});
   await abandonWorkspaceReplacement({inspect:async(_previous,_payload,_nonce,_attach,options)=>{expect(options?.checkOnly).toBe(true);options?.onReceipt?.({deleted:false,retired:false});return ROOT;}});
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);
 });
 it('persists possible dispatch before a failed send and refuses unsafe abandonment',async()=>{
   const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});
   const unregister:typeof import('../src/workspace-enrollment.js').unregisterWorkspace=async(_previous,_payload,_nonce,_attach,options)=>{options?.beforeSend?.();expect(readWorkspaceReplacement()!.dispatchAttempted).toBe(true);throw Error('transport response lost');};
   await expect(finishWorkspaceReplacement(record,{unregister})).rejects.toThrow('lost');
   await expect(abandonWorkspaceReplacement({inspect:async(_a,_b,_c,_d,options)=>{options?.onReceipt?.({deleted:false,retired:false});return ROOT;}})).rejects.toThrow('may already');
   record.dispatchAttempted=false;record.retired=true;record.rootCid=ROOT;writeFileSync(join(h.workspace,'replacement.json'),JSON.stringify(record),{mode:0o600});
   await expect(abandonWorkspaceReplacement({inspect:async(_a,_b,_c,_d,options)=>{options?.onReceipt?.({deleted:false,retired:false});return ROOT;}})).rejects.toThrow('may already');
 });
 it('does not clean or enroll before retirement acknowledgement; preserves nonce for retry',async()=>{const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT}),cleanup=vi.fn(async()=>{}),enroll=vi.fn();const unregister=vi.fn(async()=>{throw Error('retirement pending');});await expect(finishWorkspaceReplacement(record,{unregister,cleanup,enroll})).rejects.toThrow('pending');expect(cleanup).not.toHaveBeenCalled();expect(enroll).not.toHaveBeenCalled();const resumed=readWorkspaceReplacement()!;expect(resumed.operationNonce).toBe(record.operationNonce);expect(resumed.retired).toBeUndefined();expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toContain(h.previous.workspaceId);});
 it('abandons a sent operation only after exact terminal rejection, preserving local registration',async()=>{
   const h=host(),before=readFileSync(join(h.workspace,'binding.json'),'utf8');
   const record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});record.dispatchAttempted=true;
   writeFileSync(join(h.workspace,'replacement.json'),JSON.stringify(record),{mode:0o600});
   await expect(abandonWorkspaceReplacement({inspect:async(_a,_b,_c,_d,options)=>{options?.onReceipt?.({deleted:false,rejected:true});return 'f'.repeat(64);}})).rejects.toThrow('may already');
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(true);
   await abandonWorkspaceReplacement({inspect:async(_a,_b,_c,_d,options)=>{expect(options?.operationExpiresAt).toBe(record.operationExpiresAt);options?.onReceipt?.({deleted:false,rejected:true});return ROOT;}});
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);
 });
 it('requires the expiry grace and an explicit private expired-rejection receipt before abandonment',async()=>{
   const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});record.dispatchAttempted=true;record.operationExpiresAt=Date.now()-4*60000;
   const save=()=>writeFileSync(join(h.workspace,'replacement.json'),JSON.stringify(record),{mode:0o600});save();
   const inspect:typeof import('../src/workspace-enrollment.js').unregisterWorkspace=async(_a,_b,_c,_d,options)=>{options?.onReceipt?.({deleted:false,rejected:true,expired:true});return ROOT;};
   await expect(abandonWorkspaceReplacement({inspect})).rejects.toThrow('may already');expect(existsSync(join(h.workspace,'replacement.json'))).toBe(true);
   record.operationExpiresAt=Date.now()-6*60000;save();
   await expect(abandonWorkspaceReplacement({inspect:async(_a,_b,_c,_d,options)=>{options?.onReceipt?.({deleted:false});return ROOT;}})).rejects.toThrow('may already');
   await abandonWorkspaceReplacement({inspect});expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);
 });
 it('exits a lost dispatch after the immutable deadline only with a fresh server enforcement guarantee',async()=>{
   const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});record.dispatchAttempted=true;record.operationExpiresAt=Date.now()-6*60000;
   writeFileSync(join(h.workspace,'replacement.json'),JSON.stringify(record),{mode:0o600});
   const missing=async(_a:any,_b:any,_c:any,_d:any,options:any)=>{options?.onReceipt?.({deleted:false});return ROOT;};
   await expect(abandonWorkspaceReplacement({inspect:missing})).rejects.toThrow('may already');
   await expect(abandonWorkspaceReplacement({inspect:async()=>ROOT})).rejects.toThrow('may already');
   await expect(abandonWorkspaceReplacement({inspect:async()=>{throw Error('HTTP unavailable');}})).rejects.toThrow('unavailable');
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(true);
   await abandonWorkspaceReplacement({inspect:async(_a,_b,_c,_d,options)=>{expect(options?.operationExpiresAt).toBe(record.operationExpiresAt);options?.onReceipt?.({deleted:false,deadlineEnforced:true});return ROOT;}});
   expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);
 });
 it('resumes after local failure, then enrollment failure without repeating retirement',async()=>{const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT}),unregister=vi.fn(async()=>ROOT);let failCleanup=true;const cleanup=vi.fn(async()=>{if(failCleanup)throw Error('stop failed');});const enroll=vi.fn(async()=>{throw Error('proof failed');});await expect(finishWorkspaceReplacement(record,{unregister,cleanup,enroll})).rejects.toThrow('stop failed');expect(readWorkspaceReplacement()!.retired).toBe(true);failCleanup=false;await expect(finishWorkspaceReplacement(readWorkspaceReplacement()!,{unregister,cleanup,enroll})).rejects.toThrow('proof failed');expect(unregister).toHaveBeenCalledOnce();expect(readWorkspaceReplacement()!.cleaned).toBe(true);const done=vi.fn(async()=>({origin:'https://new-home.ours-tunnel.com',hostWorkspaceId:h.previous.hostWorkspaceId,rootCid:ROOT}));expect(await finishWorkspaceReplacement(readWorkspaceReplacement()!,{unregister,cleanup,enroll:done})).toMatchObject({rootCid:ROOT});expect(cleanup).toHaveBeenCalledTimes(2);expect(unregister).toHaveBeenCalledOnce();});
 it('retains recovery after expiry and rejects public recovery files',async()=>{const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});record.retired=true;record.cleaned=true;record.rootCid=ROOT;record.payload.challenge.expiresAt=Date.now()-1;writeFileSync(join(h.workspace,'replacement.json'),JSON.stringify(record),{mode:0o600});await expect(finishWorkspaceReplacement(readWorkspaceReplacement()!,{enroll:vi.fn()})).rejects.toThrow('window expired');chmodSync(join(h.workspace,'replacement.json'),0o644);expect(()=>readWorkspaceReplacement()).toThrow('private');});
 it('renews an expired command even when retirement acknowledgement was interrupted, keeping the exact target and nonce',async()=>{
   const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});record.payload.challenge.expiresAt=Date.now()-1;
   const fresh={...h.payload,invitation:'fresh-one-time-invite',challenge:{...h.payload.challenge,nonce:'f'.repeat(43),expiresAt:Date.now()+600000}};
   refreshWorkspaceReplacement(record,fresh,h.config);const retry=readWorkspaceReplacement()!;
   expect(retry.operationNonce).toBe(record.operationNonce);expect(retry.operationExpiresAt).toBe(record.operationExpiresAt);expect(retry.retired).toBeUndefined();expect(retry.payload.challenge.nonce).toBe(fresh.challenge.nonce);
   const unregister=vi.fn(async()=>ROOT),enroll=vi.fn(async()=>({origin:'https://new-home.ours-tunnel.com',hostWorkspaceId:h.previous.hostWorkspaceId,rootCid:ROOT}));
   await finishWorkspaceReplacement(retry,{unregister,cleanup:async()=>{},enroll});expect(unregister).toHaveBeenCalledOnce();expect(enroll).toHaveBeenCalledOnce();
 });
 it('refuses redirecting a pending or retired operation to another successor, account, server or configuration',async()=>{
   const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT}),before=readFileSync(join(h.workspace,'replacement.json'),'utf8');
   for(const payload of [{...h.payload,challenge:{...h.payload.challenge,workspaceId:'z'.repeat(43)}},{...h.payload,challenge:{...h.payload.challenge,accountId:'z'.repeat(43)}},{...h.payload,serverCid:'f'.repeat(64)},{...h.payload,appOrigin:'https://app.ours.network'},{...h.payload,hostname:'elsewhere.ours-tunnel.com'}]){
     expect(()=>refreshWorkspaceReplacement(record,payload,h.config)).toThrow('same target workspace');expect(readFileSync(join(h.workspace,'replacement.json'),'utf8')).toBe(before);
   }
   expect(()=>refreshWorkspaceReplacement(record,h.payload,join(h.dir,'other.yaml'))).toThrow('original configuration');
 });
 it('proves a refreshed challenge even when the successor binding committed before setup recovery was saved',async()=>{
   const h=host(),record=await beginWorkspaceReplacement(h.previous,h.payload,h.config,{preflight:async()=>ROOT});record.retired=true;record.cleaned=true;record.rootCid=ROOT;
   writeFileSync(join(h.workspace,'binding.json'),JSON.stringify({...h.previous,workspaceId:h.payload.challenge.workspaceId}),{mode:0o600});
   const fresh={...h.payload,challenge:{...h.payload.challenge,nonce:'f'.repeat(43),expiresAt:Date.now()+600000}};
   refreshWorkspaceReplacement(record,fresh,h.config);
   const unregister=vi.fn(),cleanup=vi.fn(),enroll=vi.fn(async()=>({origin:'https://new-home.ours-tunnel.com',hostWorkspaceId:h.previous.hostWorkspaceId,rootCid:ROOT}));
   await finishWorkspaceReplacement(readWorkspaceReplacement()!,{unregister,cleanup,enroll});
   expect(enroll).toHaveBeenCalledOnce();expect(enroll.mock.calls[0][0].challenge.nonce).toBe(fresh.challenge.nonce);expect(unregister).not.toHaveBeenCalled();expect(cleanup).not.toHaveBeenCalled();
 });
 it('revokes only account links and pending link codes; preserves host ID, local data and owner invite',async()=>{const h=host();writeFileSync(h.config,'retained agents config');writeFileSync(join(h.workspace,'owner.invite'),'retained owner');for(const file of ['connector','tunnel.json','pending-setup.json'])writeFileSync(join(h.workspace,file),'old');const devices=new WorkspaceDeviceStore();const code=devices.mint(),link=devices.enroll(code.enrollment,code.workspaceId,'old browser'),pending=devices.mint();devices.close();await clearReplacedWorkspaceLocalState();const after=new WorkspaceDeviceStore();try{expect(after.workspaceId).toBe(h.previous.hostWorkspaceId);expect(()=>after.authenticate(link.token)).toThrow();expect(()=>after.enroll(pending.enrollment,pending.workspaceId,'late old browser')).toThrow();}finally{after.close();}expect(readFileSync(h.config,'utf8')).toBe('retained agents config');expect(readFileSync(join(h.workspace,'owner.invite'),'utf8')).toBe('retained owner');expect(existsSync(join(h.workspace,'binding.json'))).toBe(true);for(const file of ['connector','tunnel.json','pending-setup.json'])expect(existsSync(join(h.workspace,file))).toBe(false);});
});
