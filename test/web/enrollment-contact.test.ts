import {afterEach,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeEnrollmentContact} from '../../src/workspace-enrollment.js';

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
