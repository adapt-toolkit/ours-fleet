import type { AgentCreationCompletionAuthority,CompleteAgentCreationBindings } from './agent-creation-transaction.js';
import type { VerifiedGenerationReservation } from './agent-generation-reservation.js';
import type { AdapterValidationRecord } from './agent-plan.js';
import { readStoredAgentPlan } from './agent-plan-store.js';
import {
  type IdempotentRuntimeProvider, type RuntimeProviderBindings,
  type RuntimeProviderEvidenceAuthority, type TrustedCurrentRuntimeCapability,
  type ResolvedRuntimeAdapter, type TrustedRuntimeReadinessProof, type TrustedRuntimeRestoreProof,
  type TrustedRuntimeRetireProof, type TrustedRuntimeStartProof,
} from './agent-runtime-transaction.js';
import { runtimeCanonical, runtimeDigest } from './agent-runtime-record.js';
import {
  BrainAdapterPreparationAuthority, type BrainAdapterResolutionInput,
  type AuthenticatedPreparedBrainLaunchBindings, type EphemeralPreparedBrainLaunch,
} from './harness/brain-adapter.js';
import { getBodyBrainAdapterDescriptor } from './harness/registry.js';
import type { AcpBodyBrainInjectedDriver } from './session/acp-body-brain-provider.js';
import type { AcpBodyBrainProvider, AcpSessionMetadata } from './session/acp-body-brain-transport.js';
import { AgentConversationRelay, type AgentConversationEndpoint,
  type AgentConversationEndpointAuthority } from './agent-conversation-control.js';

const preparationBrand: unique symbol = Symbol('agent runtime Brain preparation');
export interface VerifiedAgentRuntimePreparation { readonly [preparationBrand]: true }

export interface DurableRuntimeAdapterDescriptor {
  adapterId:string; adapterVersion:string; policyDigest:string; descriptorDigest:string;
  descriptor:Readonly<Record<string,unknown>>;
}

const runtimePlanBrand:unique symbol=Symbol('authenticated runtime AgentPlan');
export interface VerifiedAgentRuntimePlan {readonly [runtimePlanBrand]:true}
export interface AuthenticatedAgentRuntimePlanBindings {
  completion:Readonly<CompleteAgentCreationBindings>;
  brain:BrainAdapterResolutionInput['brain'];permissions:BrainAdapterResolutionInput['permissions'];
  adapter:Readonly<AdapterValidationRecord>;
}
export interface AgentRuntimePlanAuthority {
  authenticate(evidence:VerifiedAgentRuntimePlan):Readonly<AuthenticatedAgentRuntimePlanBindings>|undefined;
}
/** Resolves the securely stored plan only through same-instance completed-generation evidence. */
export class RecordedAgentRuntimePlanAuthority implements AgentRuntimePlanAuthority {
  readonly #issued=new WeakMap<object,Readonly<AuthenticatedAgentRuntimePlanBindings>>();
  constructor(private readonly completions:AgentCreationCompletionAuthority){}
  resolve(reservation:VerifiedGenerationReservation):VerifiedAgentRuntimePlan{
    const completeEvidence=this.completions.validateComplete(reservation);
    const completion=this.completions.authenticateComplete(completeEvidence);
    if(!completion)throw new TypeError('runtime AgentPlan is unavailable');
    const ownedCompletion=Object.freeze({...completion,identity:Object.freeze({...completion.identity})});
    const plan=readStoredAgentPlan(ownedCompletion.canonicalDir,{agentId:ownedCompletion.agentId,generation:ownedCompletion.generation,
      planDigest:ownedCompletion.planDigest,snapshotDigest:ownedCompletion.snapshotDigest},'runtime').plan;
    const evidence=Object.freeze({[runtimePlanBrand]:true as const});
    this.#issued.set(evidence,Object.freeze({completion:ownedCompletion,brain:plan.brain,permissions:plan.permissions,adapter:plan.adapter}));
    return evidence;
  }
  authenticate(evidence:VerifiedAgentRuntimePlan){return evidence&&typeof evidence==='object'
    ?this.#issued.get(evidence as object):undefined;}
}

export interface AgentRuntimeLaunchAuthorityInput {
  policy:BrainAdapterResolutionInput['policy'];
  enforcementEvidence:BrainAdapterResolutionInput['enforcementEvidence'];
}

interface Prepared {
  completion:Readonly<CompleteAgentCreationBindings>;
  launch:EphemeralPreparedBrainLaunch;
  brain:AuthenticatedPreparedBrainLaunchBindings;
  runtimeInstanceKey:string; startEffectKey:string; adapterDescriptorDigest:string;
  sessionMetadata?:Readonly<AcpSessionMetadata>;
  runtimeLaunchContext?:Readonly<{evidence:unknown;sessionRequestId:string;
    sessionRequest:Readonly<Record<string,unknown>>}>;
}

const sameCompletion=(left:Readonly<CompleteAgentCreationBindings>,right:Readonly<CompleteAgentCreationBindings>)=>
  runtimeCanonical(left)===runtimeCanonical(right);

function runtimeKeys(completion:Readonly<CompleteAgentCreationBindings>,adapter:DurableRuntimeAdapterDescriptor){
  const runtimeInstanceKey=runtimeDigest(runtimeCanonical({agentId:completion.agentId,generation:completion.generation,
    planDigest:completion.planDigest,snapshotDigest:completion.snapshotDigest,
    reservationDigest:completion.reservationDigest,identityEvidenceDigest:completion.identity.evidenceDigest,
    adapterId:adapter.adapterId,adapterVersion:adapter.adapterVersion,adapterPolicyDigest:adapter.policyDigest}));
  return {runtimeInstanceKey,startEffectKey:runtimeDigest(runtimeCanonical({kind:'runtime.start',runtimeInstanceKey}))};
}

/** Owns the only mapping from an opaque runtime capability to authenticated launch material. */
export class AgentRuntimePreparationAuthority {
  readonly #issued=new WeakMap<object,Prepared>();
  constructor(private readonly brains:BrainAdapterPreparationAuthority,private readonly plans:AgentRuntimePlanAuthority){}

  prepare(planEvidence:VerifiedAgentRuntimePlan,launchInput:AgentRuntimeLaunchAuthorityInput,
    adapter:DurableRuntimeAdapterDescriptor):VerifiedAgentRuntimePreparation{
    const plan=this.plans.authenticate(planEvidence);if(!plan)throw new TypeError('runtime AgentPlan is unavailable');
    const completion=plan.completion;
    if(adapter.adapterId!==plan.adapter.adapterId||adapter.adapterVersion!==plan.adapter.adapterVersion
      ||adapter.policyDigest!==plan.adapter.policyDigest||launchInput.policy.digest!==plan.adapter.policyDigest
      ||launchInput.policy.revision!==plan.adapter.policyRevision)
      throw new TypeError('runtime AgentPlan is unavailable');
    const input:BrainAdapterResolutionInput={brain:plan.brain,permissions:plan.permissions,
      policy:launchInput.policy,enforcementEvidence:launchInput.enforcementEvidence};
    const launch=this.brains.prepare(input);
    const brain=this.brains.authenticateForRuntime(launch,input);
    if(!brain||brain.validation.adapterId!==adapter.adapterId
      ||brain.validation.adapterVersion!==adapter.adapterVersion
      ||runtimeDigest(runtimeCanonical(adapter.descriptor))!==adapter.descriptorDigest
      ||brain.validation.policyDigest!==plan.adapter.policyDigest
      ||brain.validation.brainDigest!==plan.adapter.brainDigest
      ||brain.validation.permissionsDigest!==plan.adapter.permissionsDigest)
      throw new TypeError('runtime Brain preparation is unavailable');
    const keys=runtimeKeys(completion,adapter);
    const evidence=Object.freeze({[preparationBrand]:true as const});
    this.#issued.set(evidence,{completion:Object.freeze(JSON.parse(runtimeCanonical(completion))),launch,brain,
      ...keys,adapterDescriptorDigest:adapter.descriptorDigest});
    return evidence;
  }

  authenticate(evidence:unknown,completion:Readonly<CompleteAgentCreationBindings>,
    bindings:Readonly<RuntimeProviderBindings>):Prepared|undefined{
    if(!evidence||typeof evidence!=='object')return undefined;
    const prepared=this.#issued.get(evidence as object);
    if(!prepared||!sameCompletion(prepared.completion,completion)
      ||prepared.runtimeInstanceKey!==bindings.runtimeInstanceKey
      ||prepared.startEffectKey!==bindings.startEffectKey
      ||prepared.adapterDescriptorDigest!==bindings.adapterDescriptorDigest
      ||prepared.completion.agentId!==bindings.agentId||prepared.completion.generation!==bindings.generation
      ||prepared.completion.planDigest!==bindings.planDigest||prepared.completion.snapshotDigest!==bindings.snapshotDigest
      ||prepared.completion.reservationDigest!==bindings.reservationDigest
      ||prepared.completion.identity.evidenceDigest!==bindings.identityEvidenceDigest
      ||!prepared.brain.bodyBrainLaunch||!prepared.brain.adapter)return undefined;
    return prepared;
  }

  recordMetadata(evidence:unknown,metadata:Readonly<AcpSessionMetadata>):void{
    const prepared=evidence&&typeof evidence==='object'?this.#issued.get(evidence as object):undefined;
    if(!prepared)throw new TypeError('runtime Brain preparation is unavailable');
    prepared.sessionMetadata=Object.freeze({...metadata});
  }
  attachLaunchContext(evidence:unknown,context:Readonly<{evidence:unknown;sessionRequestId:string;
    sessionRequest:Readonly<Record<string,unknown>>}>):void{
    const prepared=evidence&&typeof evidence==='object'?this.#issued.get(evidence as object):undefined;
    if(!prepared||!context||typeof context!=='object'||typeof context.sessionRequestId!=='string'||!context.sessionRequestId)
      throw new TypeError('runtime launch context unavailable');
    if(prepared.runtimeLaunchContext){if(prepared.runtimeLaunchContext.evidence===context.evidence
      &&prepared.runtimeLaunchContext.sessionRequestId===context.sessionRequestId
      &&runtimeCanonical(prepared.runtimeLaunchContext.sessionRequest)===runtimeCanonical(context.sessionRequest))return;
      throw new TypeError('runtime launch context unavailable');}
    prepared.runtimeLaunchContext=Object.freeze({evidence:context.evidence,sessionRequestId:context.sessionRequestId,
      sessionRequest:Object.freeze(JSON.parse(runtimeCanonical(context.sessionRequest)))});
  }
  takeLaunchContext(evidence:unknown):Readonly<{evidence:unknown;sessionRequestId:string;
    sessionRequest:Readonly<Record<string,unknown>>}>|undefined{
    const prepared=evidence&&typeof evidence==='object'?this.#issued.get(evidence as object):undefined;
    const context=prepared?.runtimeLaunchContext;if(prepared)delete prepared.runtimeLaunchContext;return context;
  }
}

export type AgentRuntimeDriverFactory=(prepared:Readonly<AuthenticatedPreparedBrainLaunchBindings>,
  bindings:Readonly<RuntimeProviderBindings&{providerRuntimeId:string}>, canonicalDir:string,
  runtimeLaunchContext:unknown, actionId:string)=>AcpBodyBrainInjectedDriver;

export interface AgentRuntimeReconciliationQuery extends RuntimeProviderBindings {
  readonly providerRuntimeId?:string;
  readonly retireEffectKey?:string;
}
export type AuthenticatedAgentRuntimeStartReconciliation = Readonly<
  | {outcome:'not_started'|'unknown'}
  | {outcome:'started_by_action';providerRuntimeId:string}
>;
export type AuthenticatedAgentRuntimeRetireReconciliation = Readonly<
  | {outcome:'already_absent'|'unknown'}
  | {outcome:'current_exact';providerRuntimeId:string}
>;
/** External idempotency authority. Raw dependency answers are unusable until same-instance authentication. */
export interface AgentRuntimeReconciliationAuthority {
  reconcileStart(input:Readonly<AgentRuntimeReconciliationQuery>):Promise<unknown>;
  authenticateStart(evidence:unknown,input:Readonly<AgentRuntimeReconciliationQuery>):AuthenticatedAgentRuntimeStartReconciliation|undefined;
  reconcileRetire(input:Readonly<AgentRuntimeReconciliationQuery&{providerRuntimeId:string;retireEffectKey:string}>):Promise<unknown>;
  authenticateRetire(evidence:unknown,input:Readonly<AgentRuntimeReconciliationQuery&{providerRuntimeId:string;retireEffectKey:string}>):AuthenticatedAgentRuntimeRetireReconciliation|undefined;
}

interface Live {provider:AcpBodyBrainProvider;providerRuntimeId:string;preparation:unknown;
  sessionMetadata:Readonly<AcpSessionMetadata>;
  conversation:AgentConversationRelay;}

/** Production process-local bridge; durable truth remains owned by AgentRuntimeTransaction. */
export class AuthenticatedAgentRuntimeProvider implements IdempotentRuntimeProvider,RuntimeProviderEvidenceAuthority,
AgentConversationEndpointAuthority{
  readonly supportsIdempotentRuntimeActionKeys=true as const;
  readonly #live=new Map<string,Live>();
  readonly #starting=new Map<string,{evidence:unknown;promise:Promise<void>}>();
  readonly #startAuthorized=new Map<string,unknown>();
  readonly #start=new WeakMap<object,Readonly<TrustedRuntimeStartProof>>();
  readonly #ready=new WeakMap<object,Readonly<TrustedRuntimeReadinessProof>>();
  readonly #restore=new WeakMap<object,Readonly<TrustedRuntimeRestoreProof>>();
  readonly #retire=new WeakMap<object,Readonly<TrustedRuntimeRetireProof>>();
  readonly #current=new WeakMap<object,Readonly<TrustedCurrentRuntimeCapability>>();
  readonly #consumed=new WeakMap<object,Readonly<TrustedCurrentRuntimeCapability>>();
  constructor(private readonly preparations:AgentRuntimePreparationAuthority,
    private readonly completion:Readonly<CompleteAgentCreationBindings>,private readonly drivers:AgentRuntimeDriverFactory,
    private readonly reconciliation:AgentRuntimeReconciliationAuthority){}

  #prepared(bindings:Readonly<RuntimeProviderBindings>,evidence:unknown){
    const prepared=this.preparations.authenticate(evidence,this.completion,bindings);let current=false;
    try{current=!!prepared&&prepared.launch.recheckAtSideEffectBoundary();}catch{/* redacted below */}
    if(!prepared||!current)
      throw new TypeError('runtime Brain preparation is unavailable');
    return prepared;
  }
  #issue<T extends object>(map:WeakMap<object,Readonly<T>>,value:T):object{
    const evidence=Object.freeze({});map.set(evidence,Object.freeze(value));return evidence;
  }
  #id(bindings:Readonly<RuntimeProviderBindings>){return `acp-${bindings.runtimeInstanceKey.slice(-32)}`;}
  #digest(kind:string,bindings:Readonly<RuntimeProviderBindings>){return runtimeDigest(runtimeCanonical({kind,
    runtimeInstanceKey:bindings.runtimeInstanceKey,startEffectKey:bindings.startEffectKey}));}

  async reconcileStart(bindings:Readonly<RuntimeProviderBindings>,evidence:unknown):Promise<unknown>{
    this.#prepared(bindings,evidence);const live=this.#live.get(bindings.runtimeInstanceKey);
    let outcome:AuthenticatedAgentRuntimeStartReconciliation|undefined;
    if(live)outcome={outcome:'started_by_action',providerRuntimeId:live.providerRuntimeId};
    else try{const raw=await this.reconciliation.reconcileStart(bindings);
      outcome=this.reconciliation.authenticateStart(raw,bindings);}catch{/* unknown below */}
    if(outcome?.outcome==='not_started')this.#startAuthorized.set(bindings.runtimeInstanceKey,evidence);
    else this.#startAuthorized.delete(bindings.runtimeInstanceKey);
    let exactLive=false;
    if(outcome?.outcome==='started_by_action'&&live)
      exactLive=live.providerRuntimeId===outcome.providerRuntimeId;
    return this.#issue(this.#start,exactLive?{runtimeInstanceKey:bindings.runtimeInstanceKey,
      startEffectKey:bindings.startEffectKey,outcome:'started_by_action',provider:'acp-body-brain',
      providerRuntimeId:live!.providerRuntimeId,startEvidenceDigest:this.#digest('start-evidence',bindings),
      receiptDigest:runtimeDigest(runtimeCanonical({kind:'start-receipt',runtimeInstanceKey:bindings.runtimeInstanceKey,
        startEffectKey:bindings.startEffectKey,sessionLocator:live!.sessionMetadata.token,
        sessionMetadataDigest:live!.sessionMetadata.digest})),sessionLocator:live!.sessionMetadata.token,
      sessionMetadataDigest:live!.sessionMetadata.digest}:outcome?.outcome==='not_started'
      ?{runtimeInstanceKey:bindings.runtimeInstanceKey,startEffectKey:bindings.startEffectKey,
        outcome:'not_started',provider:'acp-body-brain'}
      :{runtimeInstanceKey:bindings.runtimeInstanceKey,startEffectKey:bindings.startEffectKey,
        outcome:'unknown',provider:'acp-body-brain'});
  }

  async startBrain(bindings:Readonly<RuntimeProviderBindings&{descriptor:Readonly<Record<string,unknown>>}>,
    evidence:unknown):Promise<unknown>{
    const prepared=this.#prepared(bindings,evidence);
    if(runtimeDigest(runtimeCanonical(bindings.descriptor))!==prepared.adapterDescriptorDigest)
      throw new TypeError('runtime adapter mismatch');
    if(this.#live.has(bindings.runtimeInstanceKey))return this.reconcileStart(bindings,evidence);
    const existing=this.#starting.get(bindings.runtimeInstanceKey);
    if(existing){if(existing.evidence!==evidence)throw new TypeError('runtime start authority is unavailable');
      await existing.promise;return this.reconcileStart(bindings,evidence);}
    if(this.#startAuthorized.get(bindings.runtimeInstanceKey)!==evidence)
      throw new TypeError('runtime start authority is unavailable');
    this.#startAuthorized.delete(bindings.runtimeInstanceKey);
    const pending=(async()=>{let provider:AcpBodyBrainProvider|undefined;
      try{const descriptor=getBodyBrainAdapterDescriptor(prepared.brain.adapter.harness as 'codex'|'claude-code');
        if(descriptor.adapterId!==prepared.brain.validation.adapterId
          ||descriptor.adapterVersion!==prepared.brain.validation.adapterVersion)throw new TypeError();
        const providerRuntimeId=this.#id(bindings);const context=this.preparations.takeLaunchContext(evidence);
        const driver=this.drivers(prepared.brain,{...bindings,providerRuntimeId},prepared.completion.canonicalDir,
          context,prepared.completion.actionId);
        provider=descriptor.createProvider(prepared.brain.bodyBrainLaunch,driver);
        const conversation=new AgentConversationRelay({agentId:bindings.agentId,
          generation:bindings.generation,runtimeInstanceKey:bindings.runtimeInstanceKey,providerRuntimeId},descriptor.adapterId,provider,
        ()=>typeof (driver as {pid?:unknown}).pid==='function'?(driver as unknown as {pid():number}).pid():2_147_483_647);
        const result=await conversation.start({protocolVersion:1,generation:`g${bindings.generation}`,planDigest:bindings.planDigest});
        if(result.state!=='accepted'){await provider.cleanup();return;}
        this.preparations.recordMetadata(evidence,result.sessionMetadata);
        this.#live.set(bindings.runtimeInstanceKey,{provider,providerRuntimeId,preparation:evidence,conversation,
          sessionMetadata:result.sessionMetadata});
      }catch{try{await provider?.cleanup();}catch{/* redacted */}}})();
    this.#starting.set(bindings.runtimeInstanceKey,{evidence,promise:pending});
    void pending.finally(()=>this.#starting.delete(bindings.runtimeInstanceKey));
    await pending;
    return this.reconcileStart(bindings,evidence);
  }

  async checkReadiness(bindings:Readonly<RuntimeProviderBindings&{providerRuntimeId:string}>,evidence:unknown){
    this.#prepared(bindings,evidence);const live=this.#live.get(bindings.runtimeInstanceKey);const current=live?.providerRuntimeId===bindings.providerRuntimeId;
    return this.#issue(this.#ready,{runtimeInstanceKey:bindings.runtimeInstanceKey,startEffectKey:bindings.startEffectKey,
      providerRuntimeId:bindings.providerRuntimeId,outcome:current?'ready':'unknown',evidenceDigest:this.#digest('readiness',bindings)});
  }

  async reconcileRestore(bindings:Readonly<RuntimeProviderBindings&{providerRuntimeId:string;restoreRequestKey:string;
    sessionLocator:string;sessionMetadataDigest:string}>,evidence:unknown){
    const prepared=this.#prepared(bindings,evidence);let live=this.#live.get(bindings.runtimeInstanceKey);
    if(!prepared.sessionMetadata)this.preparations.recordMetadata(evidence,Object.freeze({schemaVersion:1,
      token:bindings.sessionLocator,digest:bindings.sessionMetadataDigest}));
    if(!live&&prepared.sessionMetadata){
      try{const descriptor=getBodyBrainAdapterDescriptor(prepared.brain.adapter.harness as 'codex'|'claude-code');
        const context=this.preparations.takeLaunchContext(evidence);
        const driver=this.drivers(prepared.brain,{...bindings,providerRuntimeId:bindings.providerRuntimeId},
          prepared.completion.canonicalDir,context,prepared.completion.actionId);
        const provider=descriptor.createProvider(prepared.brain.bodyBrainLaunch,driver);
        const conversation=new AgentConversationRelay({agentId:bindings.agentId,generation:bindings.generation,
          runtimeInstanceKey:bindings.runtimeInstanceKey,providerRuntimeId:bindings.providerRuntimeId},descriptor.adapterId,provider,
        ()=>typeof (driver as {pid?:unknown}).pid==='function'?(driver as unknown as {pid():number}).pid():2_147_483_647);
        const result=await conversation.restore({protocolVersion:1,generation:`g${bindings.generation}`,
          planDigest:bindings.planDigest,sessionMetadata:prepared.sessionMetadata});
        if(result.state==='accepted'){live={provider,providerRuntimeId:bindings.providerRuntimeId,preparation:evidence,conversation,
          sessionMetadata:result.sessionMetadata};
          this.#live.set(bindings.runtimeInstanceKey,live);}else await provider.cleanup();
      }catch{/* unknown proof below */}
    }
    const outcome=live?.providerRuntimeId===bindings.providerRuntimeId?'current_exact':'unknown';
    return this.#issue(this.#restore,{runtimeInstanceKey:bindings.runtimeInstanceKey,startEffectKey:bindings.startEffectKey,
      providerRuntimeId:bindings.providerRuntimeId,outcome,evidenceDigest:this.#digest('restore',bindings)});
  }

  async reconcileRetire(bindings:Readonly<RuntimeProviderBindings&{providerRuntimeId:string;retireEffectKey:string}>,evidence:unknown){
    this.#prepared(bindings,evidence);const live=this.#live.get(bindings.runtimeInstanceKey);
    let outcome:AuthenticatedAgentRuntimeRetireReconciliation|undefined;
    if(live?.providerRuntimeId===bindings.providerRuntimeId)outcome={outcome:'current_exact',providerRuntimeId:live.providerRuntimeId};
    else try{const raw=await this.reconciliation.reconcileRetire(bindings);
      outcome=this.reconciliation.authenticateRetire(raw,bindings);}catch{/* unknown below */}
    return this.#issue(this.#retire,{runtimeInstanceKey:bindings.runtimeInstanceKey,retireEffectKey:bindings.retireEffectKey,
      providerRuntimeId:bindings.providerRuntimeId,outcome:outcome?.outcome==='current_exact'
        &&outcome.providerRuntimeId===bindings.providerRuntimeId?'current_exact':outcome?.outcome==='already_absent'
          ?'already_absent':'unknown',evidenceDigest:this.#digest('retire',bindings)});
  }
  async acquireCurrent(bindings:Readonly<RuntimeProviderBindings&{providerRuntimeId:string;retireEffectKey:string}>,evidence:unknown){
    this.#prepared(bindings,evidence);const live=this.#live.get(bindings.runtimeInstanceKey);
    if(live?.providerRuntimeId!==bindings.providerRuntimeId)return Object.freeze({});
    return this.#issue(this.#current,{runtimeInstanceKey:bindings.runtimeInstanceKey,retireEffectKey:bindings.retireEffectKey,
      providerRuntimeId:bindings.providerRuntimeId,currentOwner:true});
  }
  async retire(capability:unknown):Promise<void>{
    const current=capability&&typeof capability==='object'?this.#consumed.get(capability as object):undefined;
    if(!current)throw new TypeError('runtime ownership is unavailable');
    const live=this.#live.get(current.runtimeInstanceKey);if(!live||live.providerRuntimeId!==current.providerRuntimeId)
      throw new TypeError('runtime ownership is unavailable');
    const result=await live.provider.retire({generation:`g${this.completion.generation}`,commandId:'runtime-retire'});
    if(result.state!=='accepted')throw new TypeError('runtime ownership is unavailable');
    await live.provider.cleanup();
    this.#live.delete(current.runtimeInstanceKey);
  }
  issueConversation(runtimeInstanceKey:string,evidence:unknown):AgentConversationEndpoint{
    const live=this.#live.get(runtimeInstanceKey);
    if(!live||live.preparation!==evidence)
      throw new TypeError('runtime conversation is unavailable');
    return live.conversation.issue();
  }
  hasConversation(runtimeInstanceKey:string,evidence:unknown):boolean{
    const live=this.#live.get(runtimeInstanceKey);return !!live&&live.preparation===evidence;
  }
  authenticate(value:AgentConversationEndpoint){for(const live of this.#live.values()){
    const authenticated=live.conversation.authenticate(value);if(authenticated)return authenticated;
  }return undefined;}
  authenticateStart(value:unknown){return value&&typeof value==='object'?this.#start.get(value as object):undefined;}
  authenticateRestore(value:unknown){return value&&typeof value==='object'?this.#restore.get(value as object):undefined;}
  authenticateReadiness(value:unknown){return value&&typeof value==='object'?this.#ready.get(value as object):undefined;}
  authenticateRetire(value:unknown){return value&&typeof value==='object'?this.#retire.get(value as object):undefined;}
  consumeCurrent(value:unknown){if(!value||typeof value!=='object')return undefined;
    const result=this.#current.get(value as object);this.#current.delete(value as object);
    if(result)this.#consumed.set(value as object,result);return result;}
}

export function attachRuntimePreparation(adapter:DurableRuntimeAdapterDescriptor,
  preparationEvidence:VerifiedAgentRuntimePreparation):ResolvedRuntimeAdapter{
  return Object.freeze({durable:Object.freeze({...adapter}),preparationEvidence});
}
