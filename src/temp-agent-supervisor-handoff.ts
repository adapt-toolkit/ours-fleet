import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync,
  unlinkSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { runtimeCanonical } from './agent-runtime-record.js';
import type { TempAgentPlanReservationAuthority, VerifiedTempAgentPlanReservation } from './temp-agent-plan-reservation.js';
import { withConfigGraphLock } from './config-graph-lock.js';

export const TEMP_AGENT_SUPERVISOR_HANDOFF_FILENAME = 'temp-active.json';
const TEMP_AGENT_SUPERVISOR_RETIRED_FILENAME = '.temp-active.retired.json';
const SHA=/^sha256:[a-f0-9]{64}$/u;const TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const KEYS=['schemaVersion','kind','agentId','actionId','generation','planDigest','snapshotDigest',
  'reservationDigest','canonicalDir','planBytesDigest','authorizationRevision','lifetime','identityLifecycle','completion','handoffDigest'] as const;
export interface TempAgentSupervisorHandoff {schemaVersion:1;kind:'TempAgentSupervisorHandoff';agentId:string;
  actionId:string;generation:number;planDigest:string;snapshotDigest:string;reservationDigest:string;
  canonicalDir:string;planBytesDigest:string;authorizationRevision:string;lifetime:'temporary';
  identityLifecycle:'connector_session_owned';completion:'deferred';handoffDigest:string}
export interface TempAgentSupervisorHandoffFaults {beforeSecureOpen?(path:string):void;beforeReplace?():void;
  afterReplace?():void;fsyncFile?(fd:number):void;fsyncDirectory?(path:string):void;
  beforeUnlink?(path:string):void;afterUnlink?(path:string):void;unlink?(path:string):void;
  write?(fd:number,bytes:Buffer,offset:number,length:number):number}
export class TempAgentSupervisorHandoffError extends Error{constructor(readonly code:'invalid_reservation'|'invalid_handoff'|'generation_conflict'|'write_failed'){
  super(`temp agent supervisor handoff: ${code}`);this.name='TempAgentSupervisorHandoffError';}}
const digest=(value:unknown)=>`sha256:${createHash('sha256').update(typeof value==='string'?value:runtimeCanonical(value)).digest('hex')}`;
const safe=(value:string)=>{if(!TOKEN.test(value))throw new TempAgentSupervisorHandoffError('invalid_handoff');return Buffer.from(value).toString('base64url');};
const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs;
function parents(path:string){const absolute=resolve(path),root=parse(absolute).root;let cursor=root;for(const part of absolute.slice(root.length).split(sep).filter(Boolean)){
  cursor=join(cursor,part);let stat;try{stat=lstatSync(cursor);}catch{throw new TempAgentSupervisorHandoffError('invalid_handoff');}
  if(stat.isSymbolicLink())throw new TempAgentSupervisorHandoffError('invalid_handoff');}}
function bytes(path:string,faults:TempAgentSupervisorHandoffFaults={}){parents(dirname(path));let before:BigIntStats;
  try{before=lstatSync(path,{bigint:true});}catch{throw new TempAgentSupervisorHandoffError('invalid_handoff');}
  if(before.isSymbolicLink()||!before.isFile()||(Number(before.mode)&0o777)!==0o600||before.size<1n||before.size>65536n)
    throw new TempAgentSupervisorHandoffError('invalid_handoff');faults.beforeSecureOpen?.(path);let fd:number|undefined;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd,{bigint:true});if(!opened.isFile()||!same(before,opened))throw new Error();
    const output=Buffer.alloc(Number(opened.size));for(let offset=0;offset<output.length;){const count=readSync(fd,output,offset,output.length-offset,offset);if(count<=0)throw new Error();offset+=count;}
    if(!same(opened,fstatSync(fd,{bigint:true}))||!same(opened,lstatSync(path,{bigint:true})))throw new Error();return output;
  }catch(error){if(error instanceof TempAgentSupervisorHandoffError)throw error;throw new TempAgentSupervisorHandoffError('invalid_handoff');}
  finally{if(fd!==undefined)try{closeSync(fd);}catch{}}}
export function readTempAgentSupervisorHandoff(root:string,agentId:string,faults:TempAgentSupervisorHandoffFaults={}):Readonly<TempAgentSupervisorHandoff>{
  try{const path=join(resolve(root),'agents',safe(agentId),TEMP_AGENT_SUPERVISOR_HANDOFF_FILENAME);const text=bytes(path,faults).toString('utf8');const value=JSON.parse(text) as Record<string,unknown>;
    if(Object.keys(value).sort().join('\0')!==[...KEYS].sort().join('\0')||`${runtimeCanonical(value)}\n`!==text)throw new Error();
    const record=value as unknown as TempAgentSupervisorHandoff;const{handoffDigest,...unsigned}=record;
    if(record.schemaVersion!==1||record.kind!=='TempAgentSupervisorHandoff'||record.agentId!==agentId||!TOKEN.test(record.actionId)
      ||!Number.isSafeInteger(record.generation)||record.generation<1||record.lifetime!=='temporary'
      ||record.identityLifecycle!=='connector_session_owned'||record.completion!=='deferred'||!TOKEN.test(record.authorizationRevision)
      ||![record.planDigest,record.snapshotDigest,record.reservationDigest,record.planBytesDigest,handoffDigest].every(v=>SHA.test(v))
      ||digest(unsigned)!==handoffDigest)throw new Error();return Object.freeze(record);
  }catch(error){if(error instanceof TempAgentSupervisorHandoffError)throw error;throw new TempAgentSupervisorHandoffError('invalid_handoff');}}
export function readTempAgentSupervisorHandoffIfPresent(root:string,agentId:string,
  faults:TempAgentSupervisorHandoffFaults={}):Readonly<TempAgentSupervisorHandoff>|undefined{
  const path=join(resolve(root),'agents',safe(agentId),TEMP_AGENT_SUPERVISOR_HANDOFF_FILENAME);
  try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  return readTempAgentSupervisorHandoff(root,agentId,faults);
}
export class TempAgentSupervisorHandoffPublisher{constructor(private readonly root:string,private readonly authority:TempAgentPlanReservationAuthority,
  private readonly faults:TempAgentSupervisorHandoffFaults={}){}
  async publish(evidence:VerifiedTempAgentPlanReservation){const owned=this.authority.authenticate(evidence);if(!owned)throw new TempAgentSupervisorHandoffError('invalid_reservation');
    const r=owned.record,p=owned.prepared;const unsigned={schemaVersion:1 as const,kind:'TempAgentSupervisorHandoff' as const,agentId:r.agentId,
      actionId:r.actionId,generation:r.generation,planDigest:r.planDigest,snapshotDigest:r.snapshotDigest,reservationDigest:r.reservationDigest,
      canonicalDir:r.canonicalDir,planBytesDigest:r.planBytesDigest,authorizationRevision:p.authorizationRevision,lifetime:'temporary' as const,
      identityLifecycle:'connector_session_owned' as const,completion:'deferred' as const};
    const record=Object.freeze({...unsigned,handoffDigest:digest(unsigned)});await this.#cas(record);return record;}
  async #cas(record:TempAgentSupervisorHandoff){const agentRoot=join(resolve(this.root),'agents',safe(record.agentId));parents(agentRoot);const stat=lstatSync(agentRoot);
    if(!stat.isDirectory()||(stat.mode&0o077)!==0)throw new TempAgentSupervisorHandoffError('write_failed');const path=join(agentRoot,TEMP_AGENT_SUPERVISOR_HANDOFF_FILENAME);
    await withConfigGraphLock(join(agentRoot,'.temp-active'),'exclusive',()=>{let prior:Readonly<TempAgentSupervisorHandoff>|undefined;
      try{prior=readTempAgentSupervisorHandoff(this.root,record.agentId,this.faults);}catch{try{lstatSync(path);throw new TempAgentSupervisorHandoffError('invalid_handoff');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
      if(prior&&runtimeCanonical(prior)===runtimeCanonical(record))return;if(prior&&record.generation!==prior.generation+1)throw new TempAgentSupervisorHandoffError('generation_conflict');
      const payload=Buffer.from(`${runtimeCanonical(record)}\n`),temp=join(agentRoot,`.temp-active.${randomUUID()}.tmp`);let fd:number|undefined;
      try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);for(let offset=0;offset<payload.length;){const count=this.faults.write?.(fd,payload,offset,payload.length-offset)??writeSync(fd,payload,offset,payload.length-offset);if(count<=0)throw new Error();offset+=count;}
        if(this.faults.fsyncFile)this.faults.fsyncFile(fd);else fsyncSync(fd);closeSync(fd);fd=undefined;this.faults.beforeReplace?.();renameSync(temp,path);this.faults.afterReplace?.();
        if(this.faults.fsyncDirectory)this.faults.fsyncDirectory(agentRoot);else{const dir=openSync(agentRoot,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(dir);}finally{closeSync(dir);}}
      }catch(error){if(error instanceof TempAgentSupervisorHandoffError)throw error;throw new TempAgentSupervisorHandoffError('write_failed');}
      finally{if(fd!==undefined)try{closeSync(fd);}catch{}try{unlinkSync(temp);}catch{}}});}}

function exactRecord(value:Readonly<TempAgentSupervisorHandoff>,agentId:string):boolean{try{const{handoffDigest,...unsigned}=value;
  return Object.keys(value).sort().join('\0')===[...KEYS].sort().join('\0')&&value.schemaVersion===1
    &&value.kind==='TempAgentSupervisorHandoff'&&value.agentId===agentId&&TOKEN.test(value.actionId)
    &&Number.isSafeInteger(value.generation)&&value.generation>0&&value.lifetime==='temporary'
    &&value.identityLifecycle==='connector_session_owned'&&value.completion==='deferred'
    &&TOKEN.test(value.authorizationRevision)&&[value.planDigest,value.snapshotDigest,value.reservationDigest,
      value.planBytesDigest,handoffDigest].every(v=>SHA.test(v))&&digest(unsigned)===handoffDigest;
}catch{return false;}}

/** Same-authority retirement: callers can request an Agent retirement, never a raw path deletion. */
export class TempAgentSupervisorHandoffRetirementAuthority{
  constructor(private readonly root:string,private readonly faults:TempAgentSupervisorHandoffFaults={}){}
  async retire(expected:Readonly<TempAgentSupervisorHandoff>):Promise<'retired'|'duplicate'|'absent'>{
    const agentId=expected.agentId;
    if(!exactRecord(expected,agentId))throw new TempAgentSupervisorHandoffError('invalid_handoff');
    const agentRoot=join(resolve(this.root),'agents',safe(agentId));
    try{const stat=lstatSync(agentRoot);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)
      throw new TempAgentSupervisorHandoffError('invalid_handoff');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return'absent';throw error;}parents(agentRoot);
    const activePath=join(agentRoot,TEMP_AGENT_SUPERVISOR_HANDOFF_FILENAME);
    const retiredPath=join(agentRoot,TEMP_AGENT_SUPERVISOR_RETIRED_FILENAME);
    return withConfigGraphLock(join(agentRoot,'.temp-active'),'exclusive',()=>{
      let retired:Readonly<TempAgentSupervisorHandoff>|undefined;
      try{const text=bytes(retiredPath,this.faults).toString('utf8');const parsed=JSON.parse(text) as TempAgentSupervisorHandoff;
        if(`${runtimeCanonical(parsed)}\n`!==text||!exactRecord(parsed,agentId))throw new Error();retired=Object.freeze(parsed);
      }catch(error){try{lstatSync(retiredPath);throw new TempAgentSupervisorHandoffError('invalid_handoff');}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
      let active:Readonly<TempAgentSupervisorHandoff>|undefined;
      try{active=readTempAgentSupervisorHandoff(this.root,agentId,this.faults);}
      catch(error){try{lstatSync(activePath);throw error;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
      const expectedCanonical=runtimeCanonical(expected);
      if(!active){if(!retired)return'absent';if(runtimeCanonical(retired)!==expectedCanonical)
        throw new TempAgentSupervisorHandoffError('generation_conflict');this.#fsyncDirectory(agentRoot);return'duplicate';}
      if(runtimeCanonical(active)!==expectedCanonical)
        throw new TempAgentSupervisorHandoffError('generation_conflict');
      if(retired&&runtimeCanonical(retired)!==expectedCanonical
        &&expected.generation!==retired.generation+1)
        throw new TempAgentSupervisorHandoffError('generation_conflict');
      if(!retired||runtimeCanonical(retired)!==expectedCanonical)
        this.#writeRetired(agentRoot,retiredPath,active);
      const before=lstatSync(activePath,{bigint:true});this.faults.beforeUnlink?.(activePath);
      const after=lstatSync(activePath,{bigint:true});if(!same(before,after)||after.isSymbolicLink())
        throw new TempAgentSupervisorHandoffError('invalid_handoff');
      try{if(this.faults.unlink)this.faults.unlink(activePath);else unlinkSync(activePath);this.faults.afterUnlink?.(activePath);
        this.#fsyncDirectory(agentRoot);return'retired';}
      catch(error){if(error instanceof TempAgentSupervisorHandoffError)throw error;
        throw new TempAgentSupervisorHandoffError('write_failed');}
    });
  }
  #writeRetired(agentRoot:string,path:string,record:Readonly<TempAgentSupervisorHandoff>){
    const payload=Buffer.from(`${runtimeCanonical(record)}\n`),temp=join(agentRoot,`.temp-active.retired.${randomUUID()}.tmp`);
    let fd:number|undefined;try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      for(let offset=0;offset<payload.length;){const count=this.faults.write?.(fd,payload,offset,payload.length-offset)
        ??writeSync(fd,payload,offset,payload.length-offset);if(count<=0)throw new Error();offset+=count;}
      if(this.faults.fsyncFile)this.faults.fsyncFile(fd);else fsyncSync(fd);closeSync(fd);fd=undefined;
      this.faults.beforeReplace?.();renameSync(temp,path);this.faults.afterReplace?.();this.#fsyncDirectory(agentRoot);
    }catch(error){if(error instanceof TempAgentSupervisorHandoffError)throw error;
      throw new TempAgentSupervisorHandoffError('write_failed');}
    finally{if(fd!==undefined)try{closeSync(fd);}catch{}try{unlinkSync(temp);}catch{}}}
  #fsyncDirectory(path:string){if(this.faults.fsyncDirectory)this.faults.fsyncDirectory(path);else{
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}}
}
