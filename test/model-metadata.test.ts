import { describe, expect, it } from 'vitest';
import { normalizeCodexModel } from '../src/subscriptions/cli.js';
describe('Codex runtime model metadata', () => {
  it('keeps canonical ID, label, provider effort order and supported default', () => {
    expect(normalizeCodexModel({ id: 'row', model: 'provider/model', displayName: 'Custom model', supportedReasoningEfforts: [{reasoningEffort:'high'}, {reasoningEffort:'low'}, {reasoningEffort:'high'}], defaultReasoningEffort:'low' })).toEqual({ id:'provider/model',label:'Custom model',efforts:['high','low'],defaultEffort:'low' });
  });
  it('does not invent efforts or defaults when absent, malformed or unsupported', () => {
    expect(normalizeCodexModel({id:'model'})).toEqual({id:'model',label:'model',efforts:null});
    expect(normalizeCodexModel({id:'model',supportedReasoningEfforts:[],defaultReasoningEffort:'high'})).toEqual({id:'model',label:'model',efforts:[]});
    for (const row of [null, {}, {id:7}, {id:'bad\n'}, {id:'hidden',hidden:true}]) expect(normalizeCodexModel(row)).toBeUndefined();
  });
});

it('keeps runtime effort metadata through capability validation',async()=>{
 const { harnessCapabilities, validateBrainChoice }=await import('../src/application/harness-capabilities.js');
 await import('../src/harness/codex.js');
 const report=await harnessCapabilities({harnesses:['codex'],checkReadiness:false,codexModels:async()=>({state:'known',models:['gpt-6.1-sol'],freshness:'fresh',catalog:[{id:'gpt-6.1-sol',label:'Runtime label',efforts:['low'],defaultEffort:'low'}]})});
 expect(report.harnesses[0].models.find(row=>row.id==='gpt-6.1-sol')).toMatchObject({label:'Runtime label',efforts:['low'],defaultEffort:'low',source:'runtime-discovery'});
 expect(validateBrainChoice(report,{harness:'codex',model:'gpt-6.1-sol',effort:'ultra'})).toMatchObject({ok:false,code:'effort_unsupported'});
});
it('publishes a validated runtime model without silently reverting to a static alias',async()=>{
 const {generateSetup}=await import('../src/init-wizard.js');
 const chosen={harness:'claude-code' as const,session:'acp' as const,model:'custom/model',effort:'low'};
 const answers={subscriptions:['claude' as const],assignmentStrategy:'one-model' as const,models:{development:chosen,review:chosen,coordination:chosen},runtimeCatalog:[{harness:'claude-code' as const,session:'acp' as const,model:'custom/model',label:'Custom',efforts:['low']}]};
 const setup=generateSetup(answers);
 expect([...setup.files.values()].some(content=>content.includes('model: custom/model'))).toBe(true);
 expect(()=>generateSetup({...answers,models:{...answers.models,review:{...chosen,effort:'high'}}})).toThrow(/does not support effort/);
});
