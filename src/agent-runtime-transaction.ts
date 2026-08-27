import type { VerifiedGenerationReservation } from './agent-generation-reservation.js';
import type { AgentCreationCompletionAuthority, CompleteAgentCreationBindings,
  VerifiedCompleteAgentCreation } from './agent-creation-transaction.js';
import { AgentRuntimeRecordError, AgentRuntimeRecordStore, runtimeCanonical, runtimeDigest,
  type RuntimeCommon, type RuntimeTransition } from './agent-runtime-record.js';

declare const requestBrand: unique symbol;
export interface VerifiedRuntimeOperationRequest { readonly [requestBrand]: true }
export interface TrustedRuntimeOperationRequest {
  operation:'start'|'restore'|'retire'; requestActionId:string; authorizationRevision:string;
  principal:Readonly<{id:string;kind:'owner'|'agent'|'system'}>; agentId:string; generation:number;
  planDigest:string; reservationDigest:string; issuedAt:number; recoveryReason?:string;
}
export interface RuntimeOperationAuthority {
  authenticateRequest(evidence:VerifiedRuntimeOperationRequest):Readonly<TrustedRuntimeOperationRequest>|undefined;
}
export interface TrustedRuntimeAdapter {
  adapterId:string; adapterVersion:string; policyDigest:string; descriptorDigest:string;
  descriptor:Readonly<Record<string,unknown>>;
}
export interface ResolvedRuntimeAdapter {
  durable:Readonly<TrustedRuntimeAdapter>;
  /** Opaque process-local capability; excluded from every durable projection and key. */
  preparationEvidence:unknown;
}
type DurableRuntimeAdapter = TrustedRuntimeAdapter;
export interface RuntimeAdapterAuthority {
  resolve(completion:Readonly<CompleteAgentCreationBindings>):Readonly<ResolvedRuntimeAdapter>;
}
export type RuntimeProofOutcome = 'not_started'|'started_by_action'|'unknown';
export interface TrustedRuntimeStartProof {
  runtimeInstanceKey:string; startEffectKey:string; outcome:RuntimeProofOutcome; provider:string;
  providerRuntimeId?:string; startEvidenceDigest?:string; receiptDigest?:string;
}
export interface TrustedRuntimeRestoreProof {
  runtimeInstanceKey:string; startEffectKey:string; providerRuntimeId:string;
  outcome:'current_exact'|'absent'|'unknown'; evidenceDigest:string;
}
export interface TrustedRuntimeReadinessProof {
  runtimeInstanceKey:string; startEffectKey:string; providerRuntimeId:string;
  outcome:'ready'|'not_ready'|'unknown'; evidenceDigest:string;
}
export interface TrustedRuntimeRetireProof {
  runtimeInstanceKey:string; retireEffectKey:string; providerRuntimeId:string;
  outcome:'current_exact'|'already_absent'|'unknown'; evidenceDigest:string;
}
export interface TrustedCurrentRuntimeCapability {
  runtimeInstanceKey:string; retireEffectKey:string; providerRuntimeId:string; currentOwner:true;
}
export interface RuntimeProviderEvidenceAuthority {
  authenticateStart(value:unknown):Readonly<TrustedRuntimeStartProof>|undefined;
  authenticateRestore(value:unknown):Readonly<TrustedRuntimeRestoreProof>|undefined;
  authenticateReadiness(value:unknown):Readonly<TrustedRuntimeReadinessProof>|undefined;
  authenticateRetire(value:unknown):Readonly<TrustedRuntimeRetireProof>|undefined;
  consumeCurrent(value:unknown):Readonly<TrustedCurrentRuntimeCapability>|undefined;
}
export interface IdempotentRuntimeProvider {
  readonly supportsIdempotentRuntimeActionKeys:true;
  reconcileStart(input:Readonly<RuntimeProviderBindings>,preparation:unknown):Promise<unknown>;
  startBrain(input:Readonly<RuntimeProviderBindings & {descriptor:Readonly<Record<string,unknown>>}>,preparation:unknown):Promise<unknown>;
  checkReadiness(input:Readonly<RuntimeProviderBindings & {providerRuntimeId:string}>,preparation:unknown):Promise<unknown>;
  reconcileRestore(input:Readonly<RuntimeProviderBindings & {providerRuntimeId:string;restoreRequestKey:string}>,preparation:unknown):Promise<unknown>;
  reconcileRetire(input:Readonly<RuntimeProviderBindings & {providerRuntimeId:string;retireEffectKey:string}>,preparation:unknown):Promise<unknown>;
  acquireCurrent(input:Readonly<RuntimeProviderBindings & {providerRuntimeId:string;retireEffectKey:string}>,preparation:unknown):Promise<unknown>;
  retire(capability:unknown):Promise<void>;
}
export interface RuntimeProviderBindings extends RuntimeCommon {
  startEffectKey:string; adapterDescriptorDigest:string;
}
export interface RuntimeOperationResult { state:string; runtimeInstanceKey:string }
export class AgentRuntimeTransactionError extends Error {
  constructor(readonly code:'unauthorized'|'invalid_proof'|'corrupt'|'ambiguous') {
    super(`agent runtime transaction: ${code}`); this.name='AgentRuntimeTransactionError';
  }
}
const SHA=/^sha256:[a-f0-9]{64}$/u; const TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
function deepFreeze<T>(value:T):T{
  if(value&&typeof value==='object'){
    for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const LAUNCH:Record<string,readonly string[]>={start:['prerequisites_validated'],prerequisites_validated:['active_claimed'],
  active_claimed:['start_authorized'],start_authorized:['starting'],starting:['started','ambiguous'],
  started:['readiness_checking'],readiness_checking:['ready','not_ready','ambiguous'],ready:[],not_ready:[],ambiguous:[]};
const RESTORE:Record<string,readonly string[]>={start:['restore_authorized'],restore_authorized:['reconciling'],
  reconciling:['restored','missing','ambiguous'],restored:[],missing:[],ambiguous:[]};
const RETIRE:Record<string,readonly string[]>={start:['retire_authorized'],retire_authorized:['reconciling'],
  reconciling:['retiring','already_absent','ambiguous'],retiring:['retired','retire_failed','ambiguous'],
  retired:[],retire_failed:[],already_absent:[],ambiguous:[]};

export class AgentRuntimeTransaction {
  constructor(private readonly completion:AgentCreationCompletionAuthority,
    private readonly operations:RuntimeOperationAuthority, private readonly adapters:RuntimeAdapterAuthority,
    private readonly provider:IdempotentRuntimeProvider, private readonly proofs:RuntimeProviderEvidenceAuthority,
    private readonly records:AgentRuntimeRecordStore) {
    if (provider.supportsIdempotentRuntimeActionKeys!==true) throw new AgentRuntimeTransactionError('unauthorized');
  }
  async start(reservation:VerifiedGenerationReservation,evidence:VerifiedRuntimeOperationRequest):Promise<RuntimeOperationResult>{
    const admitted=this.#admit('start',reservation,evidence); const {trusted,request,adapter,common,bindings}=admitted;
    const prerequisite=this.records.publishPrerequisite(trusted.canonicalDir,'launch',request.requestActionId,
      request.authorizationRevision,common);
    const claim=await this.records.claim(trusted.canonicalDir,common,request.requestActionId,request.authorizationRevision,
      ()=>this.#validatePrerequisite('launch',reservation,trusted,request,common,prerequisite.prerequisiteDigest));
    return this.records.withActiveLock(trusted.canonicalDir,trusted.agentId,
      ()=>this.#validatePrerequisite('launch',reservation,trusted,request,common,prerequisite.prerequisiteDigest),async lockedClaim=>{
    this.#claim(lockedClaim,common);
    this.records.readOperationIndex(trusted.canonicalDir,trusted.agentId,'start',request.requestActionId,
      request.authorizationRevision,common.runtimeInstanceKey,claim.claimDigest);
    await this.#append('launch',trusted,request,common,'prerequisites_validated',{prerequisiteDigest:prerequisite.prerequisiteDigest});
    await this.#append('launch',trusted,request,common,'active_claimed',{claimDigest:claim.claimDigest});
    let chain=this.#chain('launch',trusted,request,common,LAUNCH); let state=chain.at(-1)?.state;
    const durableStarted=chain.find(value=>value.state==='started')?.event;
    if(durableStarted) this.#runtimeArtifacts(trusted,request,bindings,adapter,
      {runtimeInstanceKey:bindings.runtimeInstanceKey,startEffectKey:bindings.startEffectKey,
        outcome:'started_by_action',provider:String(durableStarted.provider),
        providerRuntimeId:String(durableStarted.providerRuntimeId),
        startEvidenceDigest:String(durableStarted.startEvidenceDigest),receiptDigest:String(durableStarted.receiptDigest)});
    if(state==='ready'||state==='not_ready'){
      this.#binding(trusted,bindings,adapter);
      return {state,runtimeInstanceKey:common.runtimeInstanceKey};
    }
    if(state==='ambiguous') return {state,runtimeInstanceKey:common.runtimeInstanceKey};
    if(state==='active_claimed'){await this.#append('launch',trusted,request,common,'start_authorized',{startEffectKey:bindings.startEffectKey});state='start_authorized';}
    if(state==='start_authorized'){await this.#append('launch',trusted,request,common,'starting',{});state='starting';}
    if(state==='starting'){
      let proof=this.#startProof(await this.provider.reconcileStart(bindings,admitted.preparationEvidence),bindings);
      if(proof.outcome==='not_started'){
        const hint=await this.provider.startBrain({...bindings,descriptor:adapter.descriptor},admitted.preparationEvidence);
        proof=this.#startProof(await this.provider.reconcileStart(bindings,admitted.preparationEvidence),bindings,hint);
      }
      if(proof.outcome!=='started_by_action'){await this.#append('launch',trusted,request,common,'ambiguous',{reason:'start_unknown'});return {state:'ambiguous',runtimeInstanceKey:common.runtimeInstanceKey};}
      await this.#append('launch',trusted,request,common,'started',{provider:proof.provider,
        providerRuntimeId:proof.providerRuntimeId!,startEvidenceDigest:proof.startEvidenceDigest!,receiptDigest:proof.receiptDigest!});
      this.#runtimeArtifacts(trusted,request,bindings,adapter,proof); state='started';
    }
    if(state==='started'){
      const event=this.#chain('launch',trusted,request,common,LAUNCH).at(-1)!.event;
      this.#runtimeArtifacts(trusted,request,bindings,adapter,{runtimeInstanceKey:bindings.runtimeInstanceKey,
        startEffectKey:bindings.startEffectKey,outcome:'started_by_action',provider:String(event.provider),
        providerRuntimeId:String(event.providerRuntimeId),startEvidenceDigest:String(event.startEvidenceDigest),
        receiptDigest:String(event.receiptDigest)});
      await this.#append('launch',trusted,request,common,'readiness_checking',{});state='readiness_checking';
    }
    if(state==='readiness_checking'){
      const binding=this.#binding(trusted,bindings,adapter); const proof=this.#readiness(await this.provider.checkReadiness({...bindings,providerRuntimeId:String(binding.providerRuntimeId)},admitted.preparationEvidence),bindings,String(binding.providerRuntimeId));
      const terminal=proof.outcome==='unknown'?'ambiguous':proof.outcome;
      await this.#append('launch',trusted,request,common,terminal,proof.outcome==='unknown'?{reason:'readiness_unknown'}:{evidenceDigest:proof.evidenceDigest});
      return {state:terminal,runtimeInstanceKey:common.runtimeInstanceKey};
    }
    throw new AgentRuntimeTransactionError('corrupt');
    });
  }
  async restore(reservation:VerifiedGenerationReservation,evidence:VerifiedRuntimeOperationRequest):Promise<RuntimeOperationResult>{
    const a=this.#admit('restore',reservation,evidence); const key=runtimeDigest(runtimeCanonical({kind:'runtime.restore',runtimeInstanceKey:a.common.runtimeInstanceKey,requestActionId:a.request.requestActionId,authorizationRevision:a.request.authorizationRevision}));
    const prerequisite=this.records.publishPrerequisite(a.trusted.canonicalDir,'restore',a.request.requestActionId,a.request.authorizationRevision,a.common);
    return this.records.withActiveLock(a.trusted.canonicalDir,a.trusted.agentId,()=>this.#validatePrerequisite('restore',reservation,a.trusted,a.request,a.common,prerequisite.prerequisiteDigest),async claim=>{
      this.#claim(claim,a.common); this.records.indexOperation(a.trusted.canonicalDir,a.trusted.agentId,'restore',a.request.requestActionId,a.request.authorizationRevision,a.common.runtimeInstanceKey,key);
      this.records.readOperationIndex(a.trusted.canonicalDir,a.trusted.agentId,'restore',a.request.requestActionId,
        a.request.authorizationRevision,a.common.runtimeInstanceKey,key);
      await this.#append('restore',a.trusted,a.request,a.common,'restore_authorized',{restoreRequestKey:key});
      let chain=this.#chain('restore',a.trusted,a.request,a.common,RESTORE),state=chain.at(-1)!.state;
      if(['restored','missing','ambiguous'].includes(state))return{state,runtimeInstanceKey:a.common.runtimeInstanceKey};
      if(state==='restore_authorized'){await this.#append('restore',a.trusted,a.request,a.common,'reconciling',{});state='reconciling';}
      const binding=this.#binding(a.trusted,a.bindings,a.adapter); const proof=this.#restore(await this.provider.reconcileRestore({...a.bindings,providerRuntimeId:String(binding.providerRuntimeId),restoreRequestKey:key},a.preparationEvidence),a.bindings,String(binding.providerRuntimeId));
      state=proof.outcome==='current_exact'?'restored':proof.outcome==='absent'?'missing':'ambiguous';
      await this.#append('restore',a.trusted,a.request,a.common,state,state==='ambiguous'?{reason:'restore_unknown'}:{evidenceDigest:proof.evidenceDigest});return{state,runtimeInstanceKey:a.common.runtimeInstanceKey};
    });
  }
  async retire(reservation:VerifiedGenerationReservation,evidence:VerifiedRuntimeOperationRequest):Promise<RuntimeOperationResult>{
    const a=this.#admit('retire',reservation,evidence); const key=runtimeDigest(runtimeCanonical({kind:'runtime.retire',runtimeInstanceKey:a.common.runtimeInstanceKey,requestActionId:a.request.requestActionId,authorizationRevision:a.request.authorizationRevision}));
    const prerequisite=this.records.publishPrerequisite(a.trusted.canonicalDir,'retire',a.request.requestActionId,a.request.authorizationRevision,a.common);
    return this.records.withActiveLock(a.trusted.canonicalDir,a.trusted.agentId,()=>this.#validatePrerequisite('retire',reservation,a.trusted,a.request,a.common,prerequisite.prerequisiteDigest),async claim=>{
      this.#claim(claim,a.common);this.records.indexOperation(a.trusted.canonicalDir,a.trusted.agentId,'retire',a.request.requestActionId,a.request.authorizationRevision,a.common.runtimeInstanceKey,key);
      this.records.readOperationIndex(a.trusted.canonicalDir,a.trusted.agentId,'retire',a.request.requestActionId,
        a.request.authorizationRevision,a.common.runtimeInstanceKey,key);
      await this.#append('retire',a.trusted,a.request,a.common,'retire_authorized',{retireEffectKey:key});let chain=this.#chain('retire',a.trusted,a.request,a.common,RETIRE),state=chain.at(-1)!.state;
      if(['retired','retire_failed','already_absent','ambiguous'].includes(state))return{state,runtimeInstanceKey:a.common.runtimeInstanceKey};
      if(state==='retire_authorized'){await this.#append('retire',a.trusted,a.request,a.common,'reconciling',{});state='reconciling';}
      const binding=this.#binding(a.trusted,a.bindings,a.adapter);const proof=this.#retireProof(await this.provider.reconcileRetire({...a.bindings,providerRuntimeId:String(binding.providerRuntimeId),retireEffectKey:key},a.preparationEvidence),a.bindings,String(binding.providerRuntimeId),key);
      if(proof.outcome==='already_absent'){await this.#append('retire',a.trusted,a.request,a.common,'already_absent',{evidenceDigest:proof.evidenceDigest});return{state:'already_absent',runtimeInstanceKey:a.common.runtimeInstanceKey};}
      if(proof.outcome!=='current_exact'){await this.#append('retire',a.trusted,a.request,a.common,'ambiguous',{reason:'retire_unknown'});return{state:'ambiguous',runtimeInstanceKey:a.common.runtimeInstanceKey};}
      await this.#append('retire',a.trusted,a.request,a.common,'retiring',{evidenceDigest:proof.evidenceDigest});const capability=await this.provider.acquireCurrent({...a.bindings,providerRuntimeId:String(binding.providerRuntimeId),retireEffectKey:key},a.preparationEvidence);
      const current=this.proofs.consumeCurrent(capability);if(!current||!current.currentOwner||current.runtimeInstanceKey!==a.common.runtimeInstanceKey||current.retireEffectKey!==key||current.providerRuntimeId!==binding.providerRuntimeId){await this.#append('retire',a.trusted,a.request,a.common,'ambiguous',{reason:'ownership_unknown'});return{state:'ambiguous',runtimeInstanceKey:a.common.runtimeInstanceKey};}
      try{await this.provider.retire(capability);await this.#append('retire',a.trusted,a.request,a.common,'retired',{});return{state:'retired',runtimeInstanceKey:a.common.runtimeInstanceKey};}
      catch{await this.#append('retire',a.trusted,a.request,a.common,'ambiguous',{reason:'retire_unknown'});return{state:'ambiguous',runtimeInstanceKey:a.common.runtimeInstanceKey};}
    });
  }
  #admit(operation:TrustedRuntimeOperationRequest['operation'],reservation:VerifiedGenerationReservation,evidence:VerifiedRuntimeOperationRequest){
    const authenticated=this.operations.authenticateRequest(evidence);const reason=authenticated?.recoveryReason;
    if(!authenticated||authenticated.operation!==operation||!TOKEN.test(authenticated.requestActionId)
      ||!TOKEN.test(authenticated.authorizationRevision)||!TOKEN.test(authenticated.principal.id)
      ||!['owner','agent','system'].includes(authenticated.principal.kind)
      ||!Number.isSafeInteger(authenticated.issuedAt)||authenticated.issuedAt<0
      ||authenticated.agentId!==reservation.agentId||authenticated.generation!==reservation.generation
      ||authenticated.planDigest!==reservation.planDigest||authenticated.reservationDigest!==reservation.reservationDigest
      ||operation==='restore'&&(authenticated.principal.kind!=='system'||typeof reason!=='string'||reason.length<1
        ||Buffer.byteLength(reason,'utf8')>512||/[\u0000-\u001f\u007f]/u.test(reason))
      ||operation==='retire'&&!['owner','system'].includes(authenticated.principal.kind)
      ||operation!=='restore'&&reason!==undefined)throw new AgentRuntimeTransactionError('unauthorized');
    const request=Object.freeze({operation:authenticated.operation,requestActionId:String(authenticated.requestActionId),
      authorizationRevision:String(authenticated.authorizationRevision),principal:Object.freeze({
        id:String(authenticated.principal.id),kind:authenticated.principal.kind}),agentId:String(authenticated.agentId),
      generation:Number(authenticated.generation),planDigest:String(authenticated.planDigest),
      reservationDigest:String(authenticated.reservationDigest),issuedAt:Number(authenticated.issuedAt),
      ...(reason===undefined?{}:{recoveryReason:String(reason)})}) as Readonly<TrustedRuntimeOperationRequest>;
    const fresh=this.completion.validateComplete(reservation);const trusted=this.completion.authenticateComplete(fresh);if(!trusted)throw new AgentRuntimeTransactionError('unauthorized');const resolved=this.adapters.resolve(trusted);const adapter=resolved?.durable;const preparationEvidence=resolved?.preparationEvidence;
    let descriptorBytes:string;
    try{descriptorBytes=runtimeCanonical(adapter?.descriptor);}catch{throw new AgentRuntimeTransactionError('unauthorized');}
    if(!adapter||!preparationEvidence||typeof preparationEvidence!=='object'
      ||!TOKEN.test(adapter.adapterId)||!TOKEN.test(adapter.adapterVersion)
      ||Buffer.byteLength(descriptorBytes,'utf8')>64*1024
      ||![adapter.policyDigest,adapter.descriptorDigest].every(value=>SHA.test(value))
      ||runtimeDigest(descriptorBytes)!==adapter.descriptorDigest)throw new AgentRuntimeTransactionError('unauthorized');
    const ownedAdapter=Object.freeze({adapterId:String(adapter.adapterId),adapterVersion:String(adapter.adapterVersion),
      policyDigest:String(adapter.policyDigest),descriptorDigest:String(adapter.descriptorDigest),
      descriptor:deepFreeze(JSON.parse(descriptorBytes) as Record<string,unknown>)});
    const runtimeInstanceKey=runtimeDigest(runtimeCanonical({agentId:trusted.agentId,generation:trusted.generation,planDigest:trusted.planDigest,snapshotDigest:trusted.snapshotDigest,reservationDigest:trusted.reservationDigest,identityEvidenceDigest:trusted.identity.evidenceDigest,adapterId:ownedAdapter.adapterId,adapterVersion:ownedAdapter.adapterVersion,adapterPolicyDigest:ownedAdapter.policyDigest}));
    const common:RuntimeCommon={agentId:trusted.agentId,generation:trusted.generation,planDigest:trusted.planDigest,snapshotDigest:trusted.snapshotDigest,reservationDigest:trusted.reservationDigest,identityEvidenceDigest:trusted.identity.evidenceDigest,runtimeInstanceKey};const startEffectKey=runtimeDigest(runtimeCanonical({kind:'runtime.start',runtimeInstanceKey}));const bindings={...common,startEffectKey,adapterDescriptorDigest:ownedAdapter.descriptorDigest};return{request,trusted,adapter:ownedAdapter,preparationEvidence,common,bindings};
  }
  #fresh(reservation:VerifiedGenerationReservation,expected:Readonly<CompleteAgentCreationBindings>){const evidence=this.completion.validateComplete(reservation);const current=this.completion.authenticateComplete(evidence);if(!current||runtimeCanonical(current)!==runtimeCanonical(expected))throw new AgentRuntimeTransactionError('corrupt');}
  #validatePrerequisite(operation:RuntimeTransition['chain'],reservation:VerifiedGenerationReservation,
    expected:Readonly<CompleteAgentCreationBindings>,request:Readonly<TrustedRuntimeOperationRequest>,common:RuntimeCommon,
    digest:string){this.#fresh(reservation,expected);const durable=this.records.readPrerequisite(expected.canonicalDir,
      operation,request.requestActionId,request.authorizationRevision,common);if(durable.prerequisiteDigest!==digest)
      throw new AgentRuntimeTransactionError('corrupt');}
  async #append(chain:RuntimeTransition['chain'],trusted:Readonly<CompleteAgentCreationBindings>,request:Readonly<TrustedRuntimeOperationRequest>,common:RuntimeCommon,state:string,event:Record<string,unknown>){await this.records.append(trusted.canonicalDir,chain,request.requestActionId,request.authorizationRevision,common,state,event);}
  #chain(chain:RuntimeTransition['chain'],trusted:Readonly<CompleteAgentCreationBindings>,request:Readonly<TrustedRuntimeOperationRequest>,common:RuntimeCommon,edges:Record<string,readonly string[]>){const values=this.records.readChain(trusted.canonicalDir,chain,request.requestActionId,common);for(let index=0;index<values.length;index++){const prior=values[index-1]?.state??'start';if(!edges[prior]?.includes(values[index]!.state)||values[index]!.authorizationRevision!==request.authorizationRevision)throw new AgentRuntimeTransactionError('corrupt');}return values;}
  #claim(claim:Readonly<RuntimeCommon>,common:RuntimeCommon){if(runtimeCanonical(claim)!==runtimeCanonical({...common,schemaVersion:1,kind:'AgentRuntimeActiveClaim',claimDigest:(claim as Record<string,unknown>).claimDigest}))throw new AgentRuntimeTransactionError('corrupt');}
  #startProof(raw:unknown,b:RuntimeProviderBindings,_hint?:unknown){const p=this.proofs.authenticateStart(raw);const started=p?.outcome==='started_by_action';if(!p||p.runtimeInstanceKey!==b.runtimeInstanceKey||p.startEffectKey!==b.startEffectKey||!['not_started','started_by_action','unknown'].includes(p.outcome)||!TOKEN.test(p.provider)||started&&(!p.providerRuntimeId||!TOKEN.test(p.providerRuntimeId)||!p.startEvidenceDigest||!p.receiptDigest||![p.startEvidenceDigest,p.receiptDigest].every(x=>SHA.test(x)))||!started&&(p.providerRuntimeId!==undefined||p.startEvidenceDigest!==undefined||p.receiptDigest!==undefined))throw new AgentRuntimeTransactionError('invalid_proof');return p;}
  #readiness(raw:unknown,b:RuntimeProviderBindings,id:string){const p=this.proofs.authenticateReadiness(raw);if(!p||p.runtimeInstanceKey!==b.runtimeInstanceKey||p.startEffectKey!==b.startEffectKey||p.providerRuntimeId!==id||!['ready','not_ready','unknown'].includes(p.outcome)||!SHA.test(p.evidenceDigest))throw new AgentRuntimeTransactionError('invalid_proof');return p;}
  #restore(raw:unknown,b:RuntimeProviderBindings,id:string){const p=this.proofs.authenticateRestore(raw);if(!p||p.runtimeInstanceKey!==b.runtimeInstanceKey||p.startEffectKey!==b.startEffectKey||p.providerRuntimeId!==id||!['current_exact','absent','unknown'].includes(p.outcome)||!SHA.test(p.evidenceDigest))throw new AgentRuntimeTransactionError('invalid_proof');return p;}
  #retireProof(raw:unknown,b:RuntimeProviderBindings,id:string,key:string){const p=this.proofs.authenticateRetire(raw);if(!p||p.runtimeInstanceKey!==b.runtimeInstanceKey||p.retireEffectKey!==key||p.providerRuntimeId!==id||!['current_exact','already_absent','unknown'].includes(p.outcome)||!SHA.test(p.evidenceDigest))throw new AgentRuntimeTransactionError('invalid_proof');return p;}
  #runtimeArtifacts(t:Readonly<CompleteAgentCreationBindings>,r:Readonly<TrustedRuntimeOperationRequest>,b:RuntimeProviderBindings,a:Readonly<DurableRuntimeAdapter>,p:Readonly<TrustedRuntimeStartProof>){const binding={schemaVersion:1,kind:'AgentRuntimeBinding',...b,provider:p.provider,providerRuntimeId:p.providerRuntimeId,startEvidenceDigest:p.startEvidenceDigest};this.records.publishArtifact(t.canonicalDir,'runtime-binding.json',binding);this.records.publishArtifact(t.canonicalDir,'runtime-provenance.json',{schemaVersion:1,kind:'AgentRuntimeProvenance',requestActionId:r.requestActionId,authorizationRevision:r.authorizationRevision,...b,startEvidenceDigest:p.startEvidenceDigest,adapterId:a.adapterId,adapterVersion:a.adapterVersion});}
  #binding(t:Readonly<CompleteAgentCreationBindings>,b:RuntimeProviderBindings,a:Readonly<DurableRuntimeAdapter>){
    const v=this.records.readArtifact(t.canonicalDir,'runtime-binding.json');
    const provenance=this.records.readArtifact(t.canonicalDir,'runtime-provenance.json');
    for(const [key,value] of Object.entries(b)) if(v[key]!==value||provenance[key]!==value)
      throw new AgentRuntimeTransactionError('corrupt');
    if(typeof v.providerRuntimeId!=='string'||v.startEvidenceDigest!==provenance.startEvidenceDigest
      ||provenance.adapterId!==a.adapterId||provenance.adapterVersion!==a.adapterVersion)
      throw new AgentRuntimeTransactionError('corrupt');
    if(typeof provenance.requestActionId!=='string'||typeof provenance.authorizationRevision!=='string')
      throw new AgentRuntimeTransactionError('corrupt');
    const common:RuntimeCommon={agentId:b.agentId,generation:b.generation,planDigest:b.planDigest,
      snapshotDigest:b.snapshotDigest,reservationDigest:b.reservationDigest,
      identityEvidenceDigest:b.identityEvidenceDigest,runtimeInstanceKey:b.runtimeInstanceKey};
    const launch=this.records.readChain(t.canonicalDir,'launch',provenance.requestActionId,common);
    for(let index=0;index<launch.length;index++){
      const prior=launch[index-1]?.state??'start';
      if(!LAUNCH[prior]?.includes(launch[index]!.state)
        ||launch[index]!.authorizationRevision!==provenance.authorizationRevision)
        throw new AgentRuntimeTransactionError('corrupt');
    }
    const started=launch.find(value=>value.state==='started');
    if(!started||started.authorizationRevision!==provenance.authorizationRevision
      ||started.event.provider!==v.provider||started.event.providerRuntimeId!==v.providerRuntimeId
      ||started.event.startEvidenceDigest!==v.startEvidenceDigest)
      throw new AgentRuntimeTransactionError('corrupt');
    return v;
  }
}
