import {validateAccountOrigin} from './account-origin.js';
import { lstatSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readClientProfile } from './client-profile.js';
import { stateRoot,defaultConfigPath } from './paths.js';
import { replaceFileAtomically } from './atomic-file.js';
import { loadConfig, splitRootFor } from './config.js';
import { stringify } from 'yaml';
import { WebAccessStore } from './web/access.js';
import { WorkspaceDeviceStore } from './web/workspace-devices.js';
export interface WorkspacePayload {version:1;appOrigin:string;hostname:string;rootName:string;name:string;surname:string;connectorToken:string;invitation:string;serverCid:string;challenge:{nonce:string;workspaceId:string;accountId:string;expiresAt:number}}
export function readWorkspacePayload(file:string):WorkspacePayload {
  const path=resolve(file),stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (stat.mode&0o077)!==0 || stat.size>32768)throw Error('Setup payload requires an owned private regular file (chmod 600)');
  let p:WorkspacePayload;try{p=JSON.parse(Buffer.from(readFileSync(path,'utf8').trim(),'base64url').toString());}catch{throw Error('Invalid workspace payload');}
  if(p.version!==1 || !['https://app.ours.network','https://app.ours-tunnel.com'].includes(p.appOrigin) || !/^[a-z0-9][a-z0-9-]{2,60}\.ours-tunnel\.com$/.test(p.hostname) || !/^[a-z0-9-]{2,30}@[a-z0-9-]{2,30}$/.test(p.rootName) || !/^[a-f0-9]{64}$/i.test(p.serverCid) || !p.challenge || !['nonce','accountId','workspaceId'].every(k=>/^[\w-]{43}$/.test(String(p.challenge[k as keyof typeof p.challenge]))) || p.challenge.expiresAt<=Date.now() || p.challenge.expiresAt>Date.now()+16*60000)throw Error('Workspace payload is invalid or expired');
  for(const k of ['connectorToken','invitation','name','surname'] as const)if(typeof p[k]!=='string' || !p[k] || p[k].length>8192 || /[\x00-\x1f\x7f]/.test(p[k]))throw Error('Invalid workspace payload');
  return p;
}
export async function enrollWorkspace(payload:WorkspacePayload,configuration=defaultConfigPath(),options:{migrateAppOrigin?:boolean;preserveProfile?:boolean}={}) {
  const profile=readClientProfile();const base=new URL(profile.endpoint);base.pathname=base.pathname.replace(/\/daemon\/?$/,'/messenger/');
  if(!base.pathname.endsWith('/messenger/'))throw Error('Workspace setup requires the supported gateway client profile');
  const secret=readFileSync(profile.credentialPath,'utf8').trim();
  const request=async(path:string,value?:unknown)=>{const response=await fetch(new URL('api/'+path,base),{method:value===undefined?'GET':'POST',headers:{'X-Ours-Api-Token':secret,...(value===undefined?{}:{'Content-Type':'application/json','Origin':base.origin,'X-Ours-Messenger-CSRF':'1'})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(value===undefined?15000:60000),redirect:'error'});if(!response.ok){await response.body?.cancel();throw Error('Workspace Messenger enrollment failed (HTTP '+response.status+'); request a fresh setup payload before retrying');}return response.json();};
  if(new WebAccessStore().read().mode==='none')throw Error('Workspace enrollment requires protected web access; enable pairing or password before setup');
  const dir=join(stateRoot(),'workspace');mkdirSync(dir,{recursive:true,mode:0o700});
  const appOrigin=validateAccountOrigin(payload.appOrigin);
  const previousFile=join(dir,'binding.json');
  let migrating=false;
  if(existsSync(previousFile)) {const previous=JSON.parse(readFileSync(previousFile,'utf8'));if(previous.workspaceId!==payload.challenge.workspaceId)throw Error('This host is already associated with another workspace');const priorOrigin=validateAccountOrigin(previous.appOrigin ?? 'https://app.ours.network');migrating=priorOrigin!==appOrigin;if(migrating && !options.migrateAppOrigin)throw Error('Account origin change requires explicit --migrate-app-origin and a fresh setup payload');if(migrating && previous.serverCid && previous.serverCid.toUpperCase()!==payload.serverCid.toUpperCase())throw Error('Account origin migration must retain the enrollment server identity');}
  const loaded=loadConfig(configuration);if(loaded.rooms?.defaults?.attach_owner===false)throw Error('Existing rooms.defaults.attach_owner is disabled; enable automatic Human Owner admission before workspace setup');if(loaded.rooms && !loaded.rooms.owner.public_invite_file)throw Error('Existing room owner configuration must be reviewed before workspace enrollment');
  const identity=await request('workspace/enrollment-identity');
  if(!/^[a-f0-9]{64}$/i.test(identity.cid))throw Error('Bound Messenger identity unavailable');
  if(options.preserveProfile && identity.preserveProfile!==true)throw Error('Existing-host setup requires Messenger profile-preservation support; update the host Messenger before retrying');
  if(loaded.rooms && loaded.rooms.owner.expected_cid.toLowerCase()!==identity.cid.toLowerCase())throw Error('Retained room owner CID conflicts with the Human root');
  const inviteFile=loaded.rooms?.owner.public_invite_file || join(dir,'owner.invite');
  if(existsSync(inviteFile)) {const stat=lstatSync(inviteFile);if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || stat.nlink!==1 || (stat.mode&0o077)!==0)throw Error('Retained Owner invitation file must be owned and private');}
  const devices=new WorkspaceDeviceStore();const hostWorkspaceId=devices.workspaceId;devices.close();
  const {name,surname,...proofPayload}=payload;
  const result=await request('workspace/enroll',options.preserveProfile?{...proofPayload,hostWorkspaceId,preserveProfile:true}:{...payload,hostWorkspaceId});
  if(!result.submitted || !/^[a-f0-9]{64}$/i.test(result.rootCid) || typeof result.ownerInvite!=='string')throw Error('Malformed workspace enrollment response');
  if(loaded.rooms && loaded.rooms.owner.expected_cid.toLowerCase()!==result.rootCid.toLowerCase())throw Error('Retained room owner CID conflicts with the Human root');
  if(migrating){
    const deadline=Date.now()+15000;
    while(true){
      const response=await fetch(appOrigin+'/account-api/workspace-proof',{method:'POST',headers:{Origin:appOrigin,'Content-Type':'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000),body:JSON.stringify({...payload.challenge,hostWorkspaceId,rootCid:result.rootCid})});
      if(!response.ok){await response.body?.cancel();throw Error('Account origin migration proof was rejected; local trust unchanged');}
      const receipt=await response.json() as {verified?:boolean};if(receipt.verified===true)break;
      if(Date.now()>=deadline)throw Error('Account origin migration proof is not confirmed; local trust unchanged');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  replaceFileAtomically(inviteFile,result.ownerInvite+'\n',0o600);
  const split=splitRootFor(configuration);mkdirSync(split,{recursive:true,mode:0o700});
  if(!loaded.rooms)replaceFileAtomically(configuration,readFileSync(configuration,'utf8')+'\n'+stringify({rooms:{owner:{provider:'messenger-server',expected_cid:result.rootCid,public_invite_file:inviteFile,role:'Owner'},defaults:{attach_owner:true,close_when_task_done:true}}}),0o600);
  replaceFileAtomically(join(dir,'connector'),payload.connectorToken+'\n',0o600);
  const origin=`https://${payload.hostname}`;
  replaceFileAtomically(join(dir,'tunnel.json'),JSON.stringify({origin,tokenFile:join(dir,'connector')})+'\n',0o600);
  replaceFileAtomically(previousFile,JSON.stringify({workspaceId:payload.challenge.workspaceId,hostWorkspaceId,appOrigin,serverCid:payload.serverCid.toUpperCase()})+'\n',0o600);
  loadConfig(configuration);return {origin,hostWorkspaceId,rootCid:result.rootCid};
}

/** Only the existing signed-root receipt authorizes the scoped tunnel target. */
export async function configureWorkspacePort(payload:Pick<WorkspacePayload,'appOrigin'|'challenge'>,hostWorkspaceId:string,rootCid:string,port:number):Promise<void> {
  const deadline=Date.now()+15000;
  while(true){
    const response=await fetch(payload.appOrigin+'/account-api/workspace-tunnel-configure',{method:'POST',headers:{Origin:payload.appOrigin,'Content-Type':'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({...payload.challenge,hostWorkspaceId,rootCid,port})});
    if(!response.ok){await response.body?.cancel();throw Error('Workspace tunnel target configuration failed (HTTP '+response.status+')');}
    const receipt=await response.json() as {configured?:boolean};if(receipt.configured===true)return;
    if(Date.now()>=deadline)throw Error('Signed workspace binding is not confirmed; tunnel target was not changed');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}
