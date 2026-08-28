import { describe, expect, it, vi } from 'vitest';
import { AgentInstallationService } from '../src/agent-installation.js';

describe('AgentInstallationService',()=>{
  it('routes an existing permanent identity only through production ingress and root',async()=>{
    const evidence={},result={state:'complete'},direct=vi.fn(()=>evidence),createPermanent=vi.fn(async()=>result);
    const service=new AgentInstallationService({ingress:{direct,managed:vi.fn()},root:{createPermanent},temporary:{reserve:vi.fn()}} as never);
    const context={} as never;const composition={source:{kind:'runtime_composition',agentId:'a',role:'R',
      identity:{name:'a',ownership:'existing'},lifecycle:'persistent',brain:{},permissions:{}}} as never;
    await expect(service.installPermanent({context,composition,actionId:'x'})).resolves.toBe(result);
    expect(direct).toHaveBeenCalledWith(context);expect(createPermanent).toHaveBeenCalledWith({...composition,callerEvidence:evidence},'x');
  });
  it('rejects create and temporary ownership before ingress',async()=>{const direct=vi.fn();const service=new AgentInstallationService({
    ingress:{direct},root:{},temporary:{}} as never);await expect(service.installPermanent({context:{} as never,actionId:'x',composition:{
      source:{kind:'runtime_composition',lifecycle:'temporary',identity:{ownership:'create_temporary'}}} as never})).rejects.toThrow(/invalid_request/u);
    expect(direct).not.toHaveBeenCalled();});
});
