import {validateAccountOrigin} from './account-origin.js';
import { lstatSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readClientProfile } from './client-profile.js';
import { stateRoot,defaultConfigPath,workspaceOwnerInvite } from './paths.js';
import { replaceFileAtomically } from './atomic-file.js';
import { loadConfig, splitRootFor } from './config.js';
import { parse, stringify } from 'yaml';
import { preflightInitPaths } from './init-wizard.js';
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
const GENERATED_VERSION='ours.network/fleet/v2';
/** The rooms section tunnel setup writes for the enrolled Human root. */
const generatedRooms=(rootCid:string,inviteFile:string)=>({rooms:{owner:{provider:'messenger-server',expected_cid:rootCid,public_invite_file:inviteFile,role:'Owner'},defaults:{attach_owner:true,close_when_task_done:true}}});
/**
 * True only when this configuration is, key for key, what tunnel setup generated itself and nothing
 * else was added beside it. Only then may its Owner entry be treated as the record of an enrollment.
 */
function generatedConfigurationOnly(configuration:string):boolean {
  let document:unknown;try{document=parse(readFileSync(configuration,'utf8'));}catch{return false;}
  const only=(value:unknown,keys:string[]):value is Record<string,any>=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join()===[...keys].sort().join();
  if(!only(document,['api_version','rooms']) || document.api_version!==GENERATED_VERSION)return false;
  const rooms=document.rooms;
  if(!only(rooms,['owner','defaults']) || !only(rooms.owner,['provider','expected_cid','public_invite_file','role']) || !only(rooms.defaults,['attach_owner','close_when_task_done']))return false;
  if(rooms.owner.provider!=='messenger-server' || rooms.owner.role!=='Owner' || rooms.owner.public_invite_file!==workspaceOwnerInvite() || typeof rooms.owner.expected_cid!=='string' || !/^[a-f0-9]{64}$/i.test(rooms.owner.expected_cid)
    || rooms.defaults.attach_owner!==true || rooms.defaults.close_when_task_done!==true)return false;
  const split=splitRootFor(configuration);
  if(!existsSync(split))return true;
  const entries=readdirSync(split);
  return entries.every(entry=>entry==='agents') && (!entries.length || (lstatSync(join(split,'agents')).isDirectory() && readdirSync(join(split,'agents')).length===0));
}
/**
 * The Owner entry of a generated configuration records an enrollment whose host state is gone:
 * no binding and no invitation remain. Nothing else is ever replaced.
 */
const recordsLostEnrollment=(configuration:string):boolean=>!existsSync(join(stateRoot(),'workspace','binding.json')) && !existsSync(workspaceOwnerInvite()) && generatedConfigurationOnly(configuration);
function hostMessenger() {
  const profile=readClientProfile();const base=new URL(profile.endpoint);base.pathname=base.pathname.replace(/\/daemon\/?$/,'/messenger/');
  if(!base.pathname.endsWith('/messenger/'))throw Error('Workspace setup requires the supported gateway client profile');
  const secret=readFileSync(profile.credentialPath,'utf8').trim();
  return async(path:string,value?:unknown)=>{const response=await fetch(new URL('api/'+path,base),{method:value===undefined?'GET':'POST',headers:{'X-Ours-Api-Token':secret,...(value===undefined?{}:{'Content-Type':'application/json','Origin':base.origin,'X-Ours-Messenger-CSRF':'1'})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(value===undefined?15000:60000),redirect:'error'});if(!response.ok){await response.body?.cancel();throw Error('Workspace Messenger enrollment failed (HTTP '+response.status+'); request a fresh setup payload before retrying');}return response.json();};
}
/**
 * Check the Fleet configuration tunnel setup will use, before the one-time command is used.
 * Reads only; an existing Owner is compared with this host's own Messenger identity.
 */
export async function checkWorkspaceConfiguration(configuration=defaultConfigPath()):Promise<void> {
  const paths=preflightInitPaths(configuration);
  if(!paths.manifestExisted){
    if(paths.rootExisted)throw Error(`${paths.splitRoot} exists without ${paths.configPath}. Restore that file or move the directory away.`);
    return;
  }
  const loaded=loadConfig(paths.configPath,{yamlMode:'strict',deferredOwnerInviteFile:workspaceOwnerInvite()});
  if(!loaded.rooms)return;
  if(loaded.rooms.defaults?.attach_owner===false)throw Error(`${paths.configPath}: rooms.defaults.attach_owner is disabled; enable it before tunnel setup.`);
  if(!loaded.rooms.owner.public_invite_file)throw Error(`${paths.configPath}: rooms.owner must use public_invite_file before tunnel setup.`);
  let cid:unknown;
  try{cid=(await hostMessenger()('workspace/enrollment-identity')).cid;}catch{cid=undefined;}
  if(typeof cid!=='string' || !/^[a-f0-9]{64}$/i.test(cid))throw Error(`${paths.configPath} names a room Owner, and this host's Messenger identity cannot be read to compare with it. Start Messenger on this host first.`);
  if(loaded.rooms.owner.expected_cid.toLowerCase()!==cid.toLowerCase() && !recordsLostEnrollment(paths.configPath))
    throw Error(`${paths.configPath}: rooms.owner.expected_cid names a different Owner than this host's Messenger identity. Tunnel setup does not replace an existing Owner.`);
}
export async function enrollWorkspace(payload:WorkspacePayload,configuration=defaultConfigPath(),options:{migrateAppOrigin?:boolean;preserveProfile?:boolean}={}) {
  const request=hostMessenger();
  if(new WebAccessStore().read().mode==='none')throw Error('Workspace enrollment requires protected web access; enable pairing or password before setup');
  const dir=join(stateRoot(),'workspace');mkdirSync(dir,{recursive:true,mode:0o700});
  const appOrigin=validateAccountOrigin(payload.appOrigin);
  const previousFile=join(dir,'binding.json');
  let migrating=false;
  if(existsSync(previousFile)) {const previous=JSON.parse(readFileSync(previousFile,'utf8'));if(previous.workspaceId!==payload.challenge.workspaceId)throw Error('This host is already associated with another workspace');const priorOrigin=validateAccountOrigin(previous.appOrigin ?? 'https://app.ours.network');migrating=priorOrigin!==appOrigin;if(migrating && !options.migrateAppOrigin)throw Error('Account origin change requires explicit --migrate-app-origin and a fresh setup payload');if(migrating && previous.serverCid && previous.serverCid.toUpperCase()!==payload.serverCid.toUpperCase())throw Error('Account origin migration must retain the enrollment server identity');}
  const loaded=loadConfig(configuration,{deferredOwnerInviteFile:workspaceOwnerInvite()});
  // Decided before anything is sent or written: the Owner entry is replaced only when it records an enrollment this host has lost.
  const lost=Boolean(loaded.rooms) && recordsLostEnrollment(resolve(configuration));
  if(loaded.rooms?.defaults?.attach_owner===false)throw Error('Existing rooms.defaults.attach_owner is disabled; enable automatic Human Owner admission before workspace setup');if(loaded.rooms && !loaded.rooms.owner.public_invite_file)throw Error('Existing room owner configuration must be reviewed before workspace enrollment');
  const identity=await request('workspace/enrollment-identity');
  if(!/^[a-f0-9]{64}$/i.test(identity.cid))throw Error('Bound Messenger identity unavailable');
  if(options.preserveProfile && identity.preserveProfile!==true)throw Error('Existing-host setup requires Messenger profile-preservation support; update the host Messenger before retrying');
  if(loaded.rooms && !lost && loaded.rooms.owner.expected_cid.toLowerCase()!==identity.cid.toLowerCase())throw Error('Retained room owner CID conflicts with the Human root');
  const inviteFile=loaded.rooms?.owner.public_invite_file || join(dir,'owner.invite');
  if(existsSync(inviteFile)) {const stat=lstatSync(inviteFile);if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || stat.nlink!==1 || (stat.mode&0o077)!==0)throw Error('Retained Owner invitation file must be owned and private');}
  const devices=new WorkspaceDeviceStore();const hostWorkspaceId=devices.workspaceId;devices.close();
  const {name,surname,...proofPayload}=payload;
  const result=await request('workspace/enroll',options.preserveProfile?{...proofPayload,hostWorkspaceId,preserveProfile:true}:{...payload,hostWorkspaceId});
  if(!result.submitted || !/^[a-f0-9]{64}$/i.test(result.rootCid) || typeof result.ownerInvite!=='string')throw Error('Malformed workspace enrollment response');
  // Whatever the configuration said before, what is recorded from here on is this host's own root.
  if(result.rootCid.toLowerCase()!==identity.cid.toLowerCase())throw Error('Workspace enrollment answered for a different root than this host identity; local configuration is unchanged');
  if(loaded.rooms && !lost && loaded.rooms.owner.expected_cid.toLowerCase()!==result.rootCid.toLowerCase())throw Error('Retained room owner CID conflicts with the Human root');
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
  if(!loaded.rooms)replaceFileAtomically(configuration,readFileSync(configuration,'utf8')+'\n'+stringify(generatedRooms(result.rootCid,inviteFile)),0o600);
  else if(lost && loaded.rooms.owner.expected_cid.toLowerCase()!==result.rootCid.toLowerCase())replaceFileAtomically(configuration,`api_version: ${GENERATED_VERSION}\n\n`+stringify(generatedRooms(result.rootCid,inviteFile)),0o600);
  replaceFileAtomically(join(dir,'connector'),payload.connectorToken+'\n',0o600);
  const origin=`https://${payload.hostname}`;
  replaceFileAtomically(join(dir,'tunnel.json'),JSON.stringify({origin,tokenFile:join(dir,'connector')})+'\n',0o600);
  replaceFileAtomically(previousFile,JSON.stringify({workspaceId:payload.challenge.workspaceId,hostWorkspaceId,appOrigin,serverCid:payload.serverCid.toUpperCase()})+'\n',0o600);
  loadConfig(configuration);return {origin,hostWorkspaceId,rootCid:result.rootCid};
}

/** Only the existing signed-root receipt authorizes the scoped tunnel target. */
/**
 * The enrollment server contact exists only to carry the signed binding. Once the account has confirmed
 * that binding, remove exactly that contact from this host's Messenger, so it does not stay in the
 * person's chats. The server identity is the one recorded with the binding; nothing else is touched.
 */
export async function removeEnrollmentContact():Promise<boolean> {
  let serverCid:unknown;
  try{serverCid=JSON.parse(readFileSync(join(stateRoot(),'workspace','binding.json'),'utf8')).serverCid;}catch{return false;}
  if(typeof serverCid!=='string' || !/^[A-F0-9]{64}$/i.test(serverCid))return false;
  try{await hostMessenger()('contacts/remove',{contact:serverCid.toUpperCase()});}catch{throw Error('Messenger did not remove it');}
  return true;
}
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
