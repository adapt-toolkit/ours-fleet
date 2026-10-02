import {afterEach,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {confirmWorkspaceTarget,removeEnrollmentContact} from '../../src/workspace-enrollment.js';

const undo:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const step of undo.splice(0).reverse())await step();});

/** A host Messenger that records what it is asked, answering removals with `status`. */
async function host(binding:unknown,status=200) {
 const dir=mkdtempSync(join(tmpdir(),'fleet-contact-')),prior={...process.env};const requests:Array<{method?:string;url?:string;body:unknown}>=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);requests.push({method:req.method,url:req.url,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined});res.statusCode=status;res.setHeader('Content-Type','application/json');res.end('{}');});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 undo.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);rmSync(dir,{recursive:true,force:true});});
 for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];process.env.OURS_FLEET_HOME=dir;
 const endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const credential=join(dir,'credential');writeFileSync(credential,'fixture-credential',{mode:0o600});
 const profile=join(dir,'profile.json');writeFileSync(profile,JSON.stringify({serverUrl:endpoint,endpoint:endpoint+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
 if(binding!==undefined){mkdirSync(join(dir,'.ours-fleet','workspace'),{recursive:true,mode:0o700});writeFileSync(join(dir,'.ours-fleet','workspace','binding.json'),typeof binding==='string'?binding:JSON.stringify(binding),{mode:0o600});}
 return requests;
}

it('removes exactly the enrollment server recorded with the binding',async()=>{
 const requests=await host({workspaceId:'w'.repeat(43),appOrigin:'https://app.ours-tunnel.com',serverCid:'b'.repeat(64)});
 expect(await removeEnrollmentContact()).toBe(true);
 expect(requests).toEqual([{method:'POST',url:'/messenger/api/contacts/remove',body:{contact:'B'.repeat(64)}}]);
});

it.each([
 ['no binding record',undefined],
 ['a binding without a server identity',{workspaceId:'w'.repeat(43)}],
 ['a malformed server identity',{serverCid:'not-a-cid'}],
 ['an unreadable binding record','{not json'],
])('asks Messenger for nothing with %s',async(_name,binding)=>{
 const requests=await host(binding);
 expect(await removeEnrollmentContact()).toBe(false);
 expect(requests).toEqual([]);
});

it('reports a Messenger that did not remove the contact',async()=>{
 const requests=await host({serverCid:'b'.repeat(64)},500);
 await expect(removeEnrollmentContact()).rejects.toThrow('Messenger did not remove it');
 expect(requests).toHaveLength(1);
});

/** An account server whose tunnel-target answers are played in order; every exchange is recorded in `order`. */
async function account(order:string[],answers:Array<{status:number;body:unknown}>) {
 const server=createServer(async(req,res)=>{for await(const _ of req){/* drain */}const answer=answers.shift() ?? {status:500,body:{}};order.push(`account ${req.url} ${answer.status} ${JSON.stringify(answer.body)}`);res.statusCode=answer.status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer.body));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 undo.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return 'http://127.0.0.1:'+(server.address() as {port:number}).port;
}
const challenge={nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000};
const removals=(requests:Awaited<ReturnType<typeof host>>)=>requests.filter(request=>request.url==='/messenger/api/contacts/remove').length;

it('removes the contact only after the account confirmed the binding',async()=>{
 const requests=await host({serverCid:'b'.repeat(64)});const order:string[]=[];
 const appOrigin=await account(order,[{status:200,body:{configured:false}},{status:200,body:{configured:true}}]);
 let seenBeforeConfirmation=-1;
 const watch=setInterval(()=>{if(order.length===1 && seenBeforeConfirmation<0)seenBeforeConfirmation=removals(requests);},20);
 try{await confirmWorkspaceTarget({appOrigin,challenge},'h'.repeat(43),'d'.repeat(64),49271);}finally{clearInterval(watch);}
 expect(order).toHaveLength(2);expect(order[0]).toContain('"configured":false');expect(order[1]).toContain('"configured":true');
 expect(seenBeforeConfirmation).toBe(0);
 expect(removals(requests)).toBe(1);
});

it('keeps the contact when the account refuses the tunnel target',async()=>{
 const requests=await host({serverCid:'b'.repeat(64)});const order:string[]=[];
 const appOrigin=await account(order,[{status:403,body:{error:'invalid_root_proof'}}]);
 await expect(confirmWorkspaceTarget({appOrigin,challenge},'h'.repeat(43),'d'.repeat(64),49271)).rejects.toThrow('HTTP 403');
 expect(order).toHaveLength(1);expect(removals(requests)).toBe(0);
});

it('finishes the setup when Messenger cannot remove the contact, and says so',async()=>{
 const requests=await host({serverCid:'b'.repeat(64)},500);const order:string[]=[];const reported:unknown[]=[];
 const appOrigin=await account(order,[{status:200,body:{configured:true}}]);
 await confirmWorkspaceTarget({appOrigin,challenge},'h'.repeat(43),'d'.repeat(64),49271,error=>reported.push(error));
 expect(removals(requests)).toBe(1);expect(String(reported[0])).toContain('Messenger did not remove it');
});
