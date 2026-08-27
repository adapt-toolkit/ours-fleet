import { describe,expect,it,vi } from 'vitest';
import { mkdirSync,mkdtempSync,rmSync,symlinkSync,unlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { AgentRuntimePreparationAuthority,AuthenticatedAgentRuntimeProvider,attachRuntimePreparation,
  RecordedAgentRuntimePlanAuthority,
  type AgentRuntimeReconciliationQuery,type AuthenticatedAgentRuntimeRetireReconciliation,
  type AuthenticatedAgentRuntimeStartReconciliation,type VerifiedAgentRuntimePlan,
  type DurableRuntimeAdapterDescriptor } from '../src/agent-runtime-provider.js';
import { runtimeCanonical,runtimeDigest } from '../src/agent-runtime-record.js';
import { getBrainAdapter } from '../src/harness/brain-adapter.js';
import { createAcpBodyBrainPreparedLaunch,type AcpBodyBrainInjectedDriver } from '../src/session/acp-body-brain-provider.js';
import type { CompleteAgentCreationBindings } from '../src/agent-creation-transaction.js';
import { computeBrainDigest,computePermissionsDigest,resolveAgentPlan,type AdapterValidationRecord } from '../src/agent-plan.js';
import { encodeAgentPlan } from '../src/agent-plan-codec.js';
import { storeAgentPlan } from '../src/agent-plan-store.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { RuntimeProviderBindings } from '../src/agent-runtime-transaction.js';
import type { VerifiedGenerationReservation } from '../src/agent-generation-reservation.js';
import '../src/harness/codex.js';
import '../src/harness/claude-code.js';

const sha=(c:string)=>`sha256:${c.repeat(64)}`;
const completion:CompleteAgentCreationBindings={actionId:'create-1',agentId:'agent-1',generation:3,
  planDigest:sha('1'),snapshotDigest:sha('2'),reservationDigest:sha('3'),canonicalDir:'/state',identity:{
    name:'Agent One',ownership:'existing',provider:'ours',authenticatedIdentityId:'identity-1',
    evidenceDigest:sha('4'),acquisition:'external'}};

function durable(adapterId:string,adapterVersion:string):DurableRuntimeAdapterDescriptor{
  const descriptor=Object.freeze({schemaVersion:1,kind:'redacted-runtime-adapter',adapterId,adapterVersion});
  return {adapterId,adapterVersion,policyDigest:sha('5'),descriptor,
    descriptorDigest:runtimeDigest(runtimeCanonical(descriptor))};
}
function bindings(adapter:DurableRuntimeAdapterDescriptor):RuntimeProviderBindings{
  const runtimeInstanceKey=runtimeDigest(runtimeCanonical({agentId:completion.agentId,generation:completion.generation,
    planDigest:completion.planDigest,snapshotDigest:completion.snapshotDigest,
    reservationDigest:completion.reservationDigest,identityEvidenceDigest:completion.identity.evidenceDigest,
    adapterId:adapter.adapterId,adapterVersion:adapter.adapterVersion,adapterPolicyDigest:adapter.policyDigest}));
  return {agentId:completion.agentId,generation:completion.generation,planDigest:completion.planDigest,
    snapshotDigest:completion.snapshotDigest,reservationDigest:completion.reservationDigest,
    identityEvidenceDigest:completion.identity.evidenceDigest,runtimeInstanceKey,
    startEffectKey:runtimeDigest(runtimeCanonical({kind:'runtime.start',runtimeInstanceKey})),
    adapterDescriptorDigest:adapter.descriptorDigest};
}
function planAuthority(input:{brain:unknown;permissions:unknown;enforcementEvidence:unknown},adapter:DurableRuntimeAdapterDescriptor,
  boundCompletion=completion){const evidence=Object.freeze({}) as VerifiedAgentRuntimePlan;
  const authenticated={completion:boundCompletion,brain:input.brain,permissions:input.permissions,adapter:{
    adapterId:adapter.adapterId,adapterVersion:adapter.adapterVersion,policyRevision:'policy-1',
    policyDigest:adapter.policyDigest,brainDigest:sha('a'),permissionsDigest:sha('b')}};
  return {evidence,authority:{authenticate:(candidate:VerifiedAgentRuntimePlan)=>candidate===evidence?authenticated as never:undefined},
    launchInput:{policy:{revision:'policy-1',digest:adapter.policyDigest,value:{} as never},
      enforcementEvidence:input.enforcementEvidence as never}};}

function driver(calls:string[]):AcpBodyBrainInjectedDriver{
  const accepted=async()=>({state:'accepted' as const});
  return {subscribe:()=>()=>{},start:async()=>{calls.push('start');return{state:'accepted',sessionMetadata:{schemaVersion:1,
    token:'opaque-session',digest:sha('6')}};},restore:async()=>{calls.push('restore');return{state:'accepted',
    sessionMetadata:{schemaVersion:1,token:'opaque-session',digest:sha('6')}};},submit:accepted,
    respondPermission:accepted,cancel:accepted,forceTerminate:accepted,close:accepted,
    retire:async()=>{calls.push('retire');return{state:'accepted'};},cleanup:async()=>{calls.push('cleanup');}};
}

function reconciler(initial:AuthenticatedAgentRuntimeStartReconciliation={outcome:'not_started'}){
  let startState=initial;let retireState:AuthenticatedAgentRuntimeRetireReconciliation=
    initial.outcome==='unknown'?{outcome:'unknown'}:{outcome:'already_absent'};
  const start=new WeakMap<object,{query:string;state:AuthenticatedAgentRuntimeStartReconciliation}>();
  const retire=new WeakMap<object,{query:string;state:AuthenticatedAgentRuntimeRetireReconciliation}>();
  const issue=<T extends AuthenticatedAgentRuntimeStartReconciliation|AuthenticatedAgentRuntimeRetireReconciliation>(
    map:WeakMap<object,{query:string;state:T}>,input:AgentRuntimeReconciliationQuery,state:T)=>{const raw={};
    map.set(raw,{query:runtimeCanonical(input),state});return raw;};
  const authenticate=<T extends AuthenticatedAgentRuntimeStartReconciliation|AuthenticatedAgentRuntimeRetireReconciliation>(
    map:WeakMap<object,{query:string;state:T}>,raw:unknown,input:AgentRuntimeReconciliationQuery)=>{
    const owned=raw&&typeof raw==='object'?map.get(raw as object):undefined;
    return owned?.query===runtimeCanonical(input)?owned.state:undefined;};
  return {reconcileStart:vi.fn(async(input:AgentRuntimeReconciliationQuery)=>issue(start,input,startState)),
    authenticateStart:(raw:unknown,input:AgentRuntimeReconciliationQuery)=>authenticate(start,raw,input),
    reconcileRetire:vi.fn(async(input:AgentRuntimeReconciliationQuery)=>issue(retire,input,retireState)),
    authenticateRetire:(raw:unknown,input:AgentRuntimeReconciliationQuery)=>authenticate(retire,raw,input),
    setCurrent:(providerRuntimeId:string)=>{startState={outcome:'started_by_action',providerRuntimeId};
      retireState={outcome:'current_exact',providerRuntimeId};}};
}

describe('authenticated Agent runtime provider bridge',()=>{
  it('securely resolves and owns the exact completed stored AgentPlan before any Brain effect',()=>{
    const root=mkdtempSync(join(tmpdir(),'runtime-plan-'));try{
      const configDir=join(root,'fleet.conf.d');mkdirSync(configDir);mkdirSync(join(configDir,'roles.d'));
      writeFileSync(join(root,'fleet.yaml'),'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
      writeFileSync(join(configDir,'roles.d','builder.yaml'),'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
      const recordedBrain={harness:'codex' as const,model:'gpt-test',effort:'high',session:'acp' as const};
      const recordedPermissions={approval:'ask' as const,filesystem:'workspace' as const,unattended:'deny' as const};
      const recordedAdapter:AdapterValidationRecord={redacted:true,adapterId:'codex-acp',adapterVersion:'1.1.7',
        policyRevision:'policy-1',policyDigest:sha('1'),brainDigest:computeBrainDigest(recordedBrain),
        permissionsDigest:computePermissionsDigest(recordedPermissions),portableDescriptor:recordedPermissions,
        nativeDescriptor:{approvalMode:'ask',filesystemMode:'workspace',unattendedMode:'deny',exact:true},
        enforcement:{approval:{owner:'native_adapter',policyDigest:sha('1')},
          filesystem:{owner:'native_adapter',policyDigest:sha('1')},unattended:{owner:'body_controller',policyDigest:sha('1')}}};
      const makeStoredPlan=(generation:number)=>resolveAgentPlan({snapshot:loadConfigResourceSnapshot({bootstrapFile:join(root,'fleet.yaml')}),
        source:{kind:'runtime_composition',agentId:'agent-1',role:'Builder',identity:{name:'Agent One',ownership:'existing'},
          lifecycle:'persistent',brain:recordedBrain,permissions:recordedPermissions},principal:{id:'owner-1',kind:'owner'},
        operation:{id:`op-${generation}`,type:'agent.create',resourceScope:'agents/agent-1'},authorizationRevision:'auth-1',
        generation,evaluatedAt:1000,adapter:recordedAdapter});
      const stored=makeStoredPlan(1);const stateDir=join(root,'state');mkdirSync(stateDir,{mode:0o700});
      storeAgentPlan(stateDir,stored,{agentId:stored.agentId,generation:stored.generation,
        planDigest:stored.planDigest,snapshotDigest:stored.snapshotDigest},'fixture');
      const exactReservation=Object.freeze({}) as VerifiedGenerationReservation;
      const completeEvidence=Object.freeze({});const completed:CompleteAgentCreationBindings={...completion,generation:1,
        planDigest:stored.planDigest,snapshotDigest:stored.snapshotDigest,canonicalDir:stateDir};
      const completions={validateComplete:(candidate:VerifiedGenerationReservation)=>{
        if(candidate!==exactReservation)throw new TypeError('foreign reservation');return completeEvidence as never;},
      authenticateComplete:(candidate:unknown)=>candidate===completeEvidence?completed:undefined};
      const authority=new RecordedAgentRuntimePlanAuthority(completions);
      expect(()=>authority.resolve(Object.freeze({}) as VerifiedGenerationReservation)).toThrow(/foreign reservation/u);
      const evidence=authority.resolve(exactReservation);const authenticated=authority.authenticate(evidence)!;
      expect(authenticated).toMatchObject({completion:completed,brain:recordedBrain,permissions:recordedPermissions,
        adapter:{adapterId:'codex-acp',policyDigest:sha('1')}});
      expect(authority.authenticate(Object.freeze({}) as VerifiedAgentRuntimePlan)).toBeUndefined();
      expect(Object.isFrozen(authenticated.completion)).toBe(true);expect(Object.isFrozen(authenticated.completion.identity)).toBe(true);
      expect(Object.isFrozen(authenticated.brain)).toBe(true);expect(Object.isFrozen(authenticated.permissions)).toBe(true);

      const final=join(stateDir,'agent-plan.json');unlinkSync(final);writeFileSync(final,'{}\n',{mode:0o600});
      expect(()=>authority.resolve(exactReservation)).toThrow();
      expect(authenticated.brain).toEqual(recordedBrain); // owned evidence is unchanged after source replacement
      unlinkSync(final);writeFileSync(final,encodeAgentPlan(makeStoredPlan(2)),{mode:0o600});
      expect(()=>authority.resolve(exactReservation)).toThrow();
      unlinkSync(final);const target=join(root,'plan-target');writeFileSync(target,encodeAgentPlan(stored),{mode:0o600});
      symlinkSync(target,final);expect(()=>authority.resolve(exactReservation)).toThrow();
      completed.planDigest=sha('f');
      expect(authenticated.completion.planDigest).toBe(stored.planDigest);
    }finally{rmSync(root,{recursive:true,force:true});}
  });

  it.each(['codex','claude-code'] as const)('binds %s preparation, starts, restores and retires without durable leakage',async harness=>{
    const adapter=getBrainAdapter(harness,'acp');const durableAdapter=durable(adapter.adapterId,adapter.adapterVersion);
    const launch=createAcpBodyBrainPreparedLaunch({schemaVersion:1,adapterId:adapter.adapterId,
      adapterVersion:adapter.adapterVersion,argv:['node','agent.js'],env:{SECRET:'process-only'},translation:{
        model:harness==='codex'?'gpt-5.6-sol':'claude-opus-4-6',effort:'high',
        ...(harness==='codex'?{permissionMetadataSource:'codex-acp' as const}:{})}});
    const ephemeral=Object.freeze({recheckAtSideEffectBoundary:()=>true});
    const brainBindings={input:{brain:{harness,session:'acp'},permissions:{},policy:{},enforcementEvidence:{}},adapter,
      validation:{adapterId:adapter.adapterId,adapterVersion:adapter.adapterVersion,policyDigest:durableAdapter.policyDigest,
        brainDigest:sha('a'),permissionsDigest:sha('b')},native:{},bodyBrainLaunch:launch,
      artifactIdentity:{}};
    const brains={prepare:vi.fn(()=>ephemeral),authenticateForRuntime:vi.fn(()=>brainBindings)};
    const plan=planAuthority(brainBindings.input,durableAdapter);
    const authority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);
    const opaque=authority.prepare(plan.evidence,plan.launchInput,durableAdapter);
    expect(attachRuntimePreparation(durableAdapter,opaque).durable).toMatchObject(durableAdapter);
    expect(JSON.stringify(durableAdapter)).not.toContain('process-only');
    expect(JSON.stringify(opaque)).toBe('{}');
    const b=bindings(durableAdapter);const calls:string[]=[];
    const reconcile=reconciler();
    const provider=new AuthenticatedAgentRuntimeProvider(authority,completion,()=>driver(calls),reconcile);
    const absent=await provider.reconcileStart(b,opaque);
    expect(provider.authenticateStart(absent)).toMatchObject({outcome:'not_started'});
    await Promise.all([
      provider.startBrain({...b,descriptor:durableAdapter.descriptor},opaque),
      provider.startBrain({...b,descriptor:durableAdapter.descriptor},opaque),
    ]);
    const started=provider.authenticateStart(await provider.reconcileStart(b,opaque))!;
    reconcile.setCurrent(started.providerRuntimeId!);
    expect(started).toMatchObject({outcome:'started_by_action',runtimeInstanceKey:b.runtimeInstanceKey});
    expect(provider.authenticateReadiness(await provider.checkReadiness({...b,
      providerRuntimeId:started.providerRuntimeId!},opaque))).toMatchObject({outcome:'ready'});
    const recovered=new AuthenticatedAgentRuntimeProvider(authority,completion,()=>driver(calls),reconcile);
    expect(recovered.authenticateRestore(await recovered.reconcileRestore({...b,
      providerRuntimeId:started.providerRuntimeId!,restoreRequestKey:'restore-1'},opaque))).toMatchObject({outcome:'current_exact'});
    const retireKey=sha('7');const retire=await provider.reconcileRetire({...b,
      providerRuntimeId:started.providerRuntimeId!,retireEffectKey:retireKey},opaque);
    expect(provider.authenticateRetire(retire)).toMatchObject({outcome:'current_exact'});
    const capability=await provider.acquireCurrent({...b,providerRuntimeId:started.providerRuntimeId!,
      retireEffectKey:retireKey},opaque);expect(provider.consumeCurrent(capability)).toMatchObject({currentOwner:true});
    await provider.retire(capability);
    await expect(provider.retire(capability)).rejects.toThrow(/ownership/u);
    expect(calls).toEqual(['start','restore','retire','cleanup']);
  });

  it('rejects foreign authority, completion, runtime and effect substitutions before driver creation',async()=>{
    const adapter=getBrainAdapter('codex','acp');const durableAdapter=durable(adapter.adapterId,adapter.adapterVersion);
    const launch=createAcpBodyBrainPreparedLaunch({schemaVersion:1,adapterId:'codex-acp',adapterVersion:'1.1.7',
      argv:['node','agent.js'],env:{},translation:{model:'gpt-5.6-sol',effort:'high',permissionMetadataSource:'codex-acp'}});
    const brains={prepare:()=>({recheckAtSideEffectBoundary:()=>true}),authenticateForRuntime:()=>({input:{},adapter,
      validation:{adapterId:'codex-acp',adapterVersion:'1.1.7',policyDigest:durableAdapter.policyDigest,
        brainDigest:sha('a'),permissionsDigest:sha('b')},native:{},bodyBrainLaunch:launch,artifactIdentity:{}})};
    const plan=planAuthority({brain:{},permissions:{},enforcementEvidence:{}},durableAdapter);
    const authority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);const opaque=authority.prepare(plan.evidence,plan.launchInput,durableAdapter);
    const create=vi.fn(()=>driver([]));const reconcile=reconciler();
    const provider=new AuthenticatedAgentRuntimeProvider(authority,completion,create,reconcile);
    const b=bindings(durableAdapter);
    for(const evidence of [{},new AgentRuntimePreparationAuthority(brains as never,plan.authority)])
      await expect(provider.reconcileStart(b,evidence)).rejects.toThrow(/unavailable/u);
    await expect(provider.reconcileStart({...b,startEffectKey:sha('9')},opaque)).rejects.toThrow(/unavailable/u);
    for(const substituted of [
      {...b,planDigest:sha('c')},{...b,snapshotDigest:sha('d')},{...b,reservationDigest:sha('e')},
      {...b,generation:b.generation+1},
    ])await expect(provider.reconcileStart(substituted,opaque)).rejects.toThrow(/unavailable/u);
    await expect(provider.startBrain({...b,descriptor:{substituted:true}},opaque)).rejects.toThrow(/adapter mismatch/u);
    expect(reconcile.reconcileStart).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('derives Brain and permissions from authenticated plan evidence and rejects foreign plan or policy',()=>{
    const adapter=getBrainAdapter('codex','acp');const durableAdapter=durable(adapter.adapterId,adapter.adapterVersion);
    const recorded={brain:{harness:'codex',session:'acp',model:'gpt-5.6-sol',effort:'high'},
      permissions:{approval:'ask',filesystem:'workspace',unattended:'wait'},enforcementEvidence:{}};
    const plan=planAuthority(recorded,durableAdapter);const prepare=vi.fn(()=>({recheckAtSideEffectBoundary:()=>true}));
    const brains={prepare,authenticateForRuntime:()=>undefined};
    const authority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);
    expect(()=>authority.prepare({} as VerifiedAgentRuntimePlan,plan.launchInput,durableAdapter)).toThrow(/AgentPlan/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(()=>authority.prepare(plan.evidence,{...plan.launchInput,policy:{...plan.launchInput.policy,digest:sha('f')}},
      durableAdapter)).toThrow(/AgentPlan/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(()=>authority.prepare(plan.evidence,plan.launchInput,durableAdapter)).toThrow(/preparation/u);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({brain:recorded.brain,permissions:recorded.permissions,
      policy:plan.launchInput.policy,enforcementEvidence:recorded.enforcementEvidence}));
  });

  it('redacts dependency and artifact recheck failures without publishing a started proof',async()=>{
    const adapter=getBrainAdapter('codex','acp');const durableAdapter=durable(adapter.adapterId,adapter.adapterVersion);
    const launch=createAcpBodyBrainPreparedLaunch({schemaVersion:1,adapterId:'codex-acp',adapterVersion:'1.1.7',
      argv:['node','agent.js'],env:{},translation:{model:'gpt-5.6-sol',effort:'high',permissionMetadataSource:'codex-acp'}});
    let current=true;const brains={prepare:()=>({recheckAtSideEffectBoundary:()=>current}),authenticateForRuntime:()=>({input:{},adapter,
      validation:{adapterId:'codex-acp',adapterVersion:'1.1.7',policyDigest:durableAdapter.policyDigest,
        brainDigest:sha('a'),permissionsDigest:sha('b')},native:{},bodyBrainLaunch:launch,artifactIdentity:{}})};
    const plan=planAuthority({brain:{},permissions:{},enforcementEvidence:{}},durableAdapter);
    const authority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);const opaque=authority.prepare(plan.evidence,plan.launchInput,durableAdapter);
    const b=bindings(durableAdapter);const provider=new AuthenticatedAgentRuntimeProvider(authority,completion,()=>{
      throw new Error('driver factory secret');
    },reconciler());
    expect(provider.authenticateStart(await provider.reconcileStart(b,opaque))).toMatchObject({outcome:'not_started'});
    await expect(provider.startBrain({...b,descriptor:durableAdapter.descriptor},opaque)).resolves.toEqual({});
    expect(provider.authenticateStart(await provider.reconcileStart(b,opaque))).toMatchObject({outcome:'not_started'});
    current=false;
    await expect(provider.reconcileStart(b,opaque)).rejects.toThrow(/preparation is unavailable/u);
    await expect(provider.reconcileStart(b,opaque)).rejects.not.toThrow(/secret/u);
  });

  it('fails closed on restart ambiguity and never starts or certifies retirement from empty local state',async()=>{
    const adapter=getBrainAdapter('codex','acp');const durableAdapter=durable(adapter.adapterId,adapter.adapterVersion);
    const launch=createAcpBodyBrainPreparedLaunch({schemaVersion:1,adapterId:'codex-acp',adapterVersion:'1.1.7',
      argv:['node','agent.js'],env:{},translation:{model:'gpt-5.6-sol',effort:'high',permissionMetadataSource:'codex-acp'}});
    const brains={prepare:()=>({recheckAtSideEffectBoundary:()=>true}),authenticateForRuntime:()=>({input:{},adapter,
      validation:{adapterId:'codex-acp',adapterVersion:'1.1.7',policyDigest:durableAdapter.policyDigest,
        brainDigest:sha('a'),permissionsDigest:sha('b')},native:{},bodyBrainLaunch:launch,artifactIdentity:{}})};
    const plan=planAuthority({brain:{},permissions:{},enforcementEvidence:{}},durableAdapter);
    const authority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);const opaque=authority.prepare(plan.evidence,plan.launchInput,durableAdapter);
    const b=bindings(durableAdapter);const create=vi.fn(()=>driver([]));const unknown=reconciler({outcome:'unknown'});
    const restarted=new AuthenticatedAgentRuntimeProvider(authority,completion,create,unknown);
    expect(restarted.authenticateStart(await restarted.reconcileStart(b,opaque))).toMatchObject({outcome:'unknown'});
    await expect(restarted.startBrain({...b,descriptor:durableAdapter.descriptor},opaque)).rejects.toThrow(/authority/u);
    const retire=await restarted.reconcileRetire({...b,providerRuntimeId:'external-runtime',retireEffectKey:sha('8')},opaque);
    expect(restarted.authenticateRetire(retire)).toMatchObject({outcome:'unknown'});
    expect(create).not.toHaveBeenCalled();

    const foreignAuthority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);
    const foreignProvider=new AuthenticatedAgentRuntimeProvider(foreignAuthority,completion,create,unknown);
    await expect(foreignProvider.reconcileStart(b,opaque)).rejects.toThrow(/unavailable/u);
  });

  it('reconciles a crash after external start without issuing a second start',async()=>{
    const adapter=getBrainAdapter('codex','acp');const durableAdapter=durable(adapter.adapterId,adapter.adapterVersion);
    const launch=createAcpBodyBrainPreparedLaunch({schemaVersion:1,adapterId:'codex-acp',adapterVersion:'1.1.7',
      argv:['node','agent.js'],env:{},translation:{model:'gpt-5.6-sol',effort:'high',permissionMetadataSource:'codex-acp'}});
    const brains={prepare:()=>({recheckAtSideEffectBoundary:()=>true}),authenticateForRuntime:()=>({input:{},adapter,
      validation:{adapterId:'codex-acp',adapterVersion:'1.1.7',policyDigest:durableAdapter.policyDigest,
        brainDigest:sha('a'),permissionsDigest:sha('b')},native:{},bodyBrainLaunch:launch,artifactIdentity:{}})};
    const plan=planAuthority({brain:{},permissions:{},enforcementEvidence:{}},durableAdapter);
    const authority=new AgentRuntimePreparationAuthority(brains as never,plan.authority);const opaque=authority.prepare(plan.evidence,plan.launchInput,durableAdapter);
    const b=bindings(durableAdapter);const externalId=`acp-${b.runtimeInstanceKey.slice(-32)}`;const reconcile=reconciler();let starts=0;
    const crashingDriver=()=>{const value=driver([]);value.start=async()=>{starts++;reconcile.setCurrent(externalId);
      throw new Error('crash after external start');};return value;};
    const first=new AuthenticatedAgentRuntimeProvider(authority,completion,crashingDriver,reconcile);
    expect(first.authenticateStart(await first.reconcileStart(b,opaque))).toMatchObject({outcome:'not_started'});
    const recoveredProof=first.authenticateStart(await first.startBrain({...b,descriptor:durableAdapter.descriptor},opaque));
    expect(recoveredProof).toMatchObject({outcome:'started_by_action',providerRuntimeId:externalId});
    const restartedPlan=planAuthority({brain:{},permissions:{},enforcementEvidence:{}},durableAdapter);
    const restartedAuthority=new AgentRuntimePreparationAuthority(brains as never,restartedPlan.authority);
    const restartedOpaque=restartedAuthority.prepare(restartedPlan.evidence,restartedPlan.launchInput,durableAdapter);
    const restarted=new AuthenticatedAgentRuntimeProvider(restartedAuthority,completion,crashingDriver,reconcile);
    expect(restarted.authenticateStart(await restarted.reconcileStart(b,restartedOpaque))).toMatchObject({outcome:'started_by_action'});
    expect(starts).toBe(1);
  });
});
