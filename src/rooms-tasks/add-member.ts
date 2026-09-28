import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { canonicalJson } from '../canonical-json.js';
import type { FleetConfig } from '../config.js';
import { stateRoot } from '../paths.js';
import { getTask, TaskStateError } from './task-state.js';
import { getRoomRecord } from './room-state.js';
import { prepareExecutionPlan } from './member-overrides.js';
import { sealTemplateSnapshot } from './templates.js';
import { provisionMembers } from './provision.js';
import type { CoworkAdapter } from './cowork-adapter.js';

export class MemberAdditionRejected extends TaskStateError { readonly accepted=false; }
export interface AddMemberRequest { requestId: string; slot: string; role: string; brain: string; agentTemplate: string }
interface Receipt { requestId:string; taskId:string; roleId:string; hash:string; state:'running'|'succeeded'|'attention'|'failed'; error?:string }
const running = new Set<string>();
function pathFor(taskId:string, requestId:string) {
  if (!/^[a-z0-9]{10,40}$/.test(taskId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw new TaskStateError('Invalid task or request ID');
  return join(stateRoot(),'member-additions',taskId,requestId+'.json');
}
export function memberAddition(taskId:string,requestId:string) {
  getTask(taskId);
  const path=pathFor(taskId,requestId);
  if(!existsSync(path))throw new TaskStateError('Member request not found');
  const receipt=JSON.parse(readFileSync(path,'utf8')) as Receipt;
  const {hash,...view}=receipt;
  return receipt.state==='running'&&!running.has(path) ? {...view,state:'attention',error:'The server stopped observing this launch. Inspect the existing agent before any recovery.'} : view;
}
export async function requestMemberAddition(input:{taskId:string;request:AddMemberRequest;cfg:FleetConfig;cowork:CoworkAdapter;configPath?:string;binPath:string;provision?:typeof provisionMembers}) {
  const {request:r,taskId}=input;
  if(!r || typeof r.slot!=='string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(r.slot)
      || ![r.role,r.brain,r.agentTemplate].every(v=>typeof v==='string'&&v.length>0&&v.length<=128))
    throw new MemberAdditionRejected('Slot, Role, Brain and Agent Template are required');
  const path=pathFor(taskId,r.requestId);
  const hash=createHash('sha256').update(canonicalJson(r)).digest('hex');
  mkdirSync(join(stateRoot(),'member-additions',taskId),{recursive:true,mode:0o700});
  return withFileLock(path+'.lock',async()=>{
    if(existsSync(path)) {
      const old=JSON.parse(readFileSync(path,'utf8')) as Receipt;
      if(old.hash!==hash)throw new TaskStateError('Request ID was already used with different settings');
      return memberAddition(taskId,r.requestId);
    }
    const task=getTask(taskId);const room=task.room_id&&getRoomRecord(task.room_id);
    if(!room || !['active','review'].includes(task.state) || task.terminal_intent || task.blocked || room.state!=='active'
        || room.task_id!==taskId || room.room_identity_cid!==task.room_identity_cid)
      throw new MemberAdditionRejected('Adding an agent requires an active, unblocked task room');
    const roleId=`${taskId.slice(0,8)}-${r.slot}-1`;
    if(room.member_seats.some(s=>s.role_name===roleId))throw new MemberAdditionRejected('This member slot already exists');
    const plan=(()=>{try{return prepareExecutionPlan({name:'additional-member',version:1,description:'Additional task participant',
      contract:room.template_snapshot?.contract,members:[{slot:r.slot,role:r.role,count:1,agent_template:r.agentTemplate}]},input.cfg,
      {[r.slot]:{role:r.role,brain:r.brain}});}catch(error){throw new MemberAdditionRejected(error instanceof Error?error.message:'Invalid member configuration');}})();
    const template=sealTemplateSnapshot(plan.snapshot,input.cfg.agentTemplates??{},plan.launchDefinitions);
    const receipt:Receipt={taskId,requestId:r.requestId,roleId,hash,state:'running'};
    const save=()=>replaceFileAtomically(path,JSON.stringify(receipt)+'\n',0o600);
    save();running.add(path);
    void (input.provision??provisionMembers)({cfg:input.cfg,cowork:input.cowork,configPath:input.configPath,binPath:input.binPath,
      taskId,roomId:room.room_id,template,goal:task.title,brief:task.brief,append:true}).then(result=>{
        const seat=result.member_seats.find(s=>s.role_name===roleId);
        receipt.state=seat?.seat_state==='active'&&getTask(taskId).member_roles.some(m=>m.name===roleId)?'succeeded':'attention';
        if(receipt.state==='attention')receipt.error='Admission is not confirmed. Inspect the existing launch; no automatic retry was made.';
      }).catch(()=>{receipt.state='failed';receipt.error='Member launch failed. Inspect the task and agent logs before recovery.';})
      .finally(()=>{try{save();}finally{running.delete(path);}}).catch(()=>{running.delete(path);});
    return memberAddition(taskId,r.requestId);
  });
}
