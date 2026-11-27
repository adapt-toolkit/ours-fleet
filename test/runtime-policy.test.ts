import {describe,it,expect} from 'vitest';
import {selectRuntime,runtimePolicy,stripRuntimePolicy} from '../src/harness/runtime-policy.js';
const bundle={path:'/adapter/bundled CLI',version:'2.0.0'}, old={path:'/installed CLI',version:'1.0.0'}, newer={path:'/installed CLI',version:'3.0.0'};
describe.each(['claude','codex'] as const)('%s runtime policy',provider=>{
 const key=provider==='claude'?'CLAUDE_CODE_EXECUTABLE':'CODEX_PATH';
 const select=(env:NodeJS.ProcessEnv={},host?:typeof bundle,explicit?:typeof bundle)=>selectRuntime({provider,env,host,explicit,bundled:bundle,minimum:'2.0.0'});
 it('keeps unmarked old and missing hosts on the same bundle with one actionable warning',()=>{
  for(const host of [undefined,old])expect(select({},host)).toMatchObject({source:'bundled',binary:bundle,warning:expect.stringContaining(`${key}=""`)});
  expect(select({},newer)).toEqual({source:'host',binary:newer});expect(select({},bundle)).toEqual({source:'host',binary:bundle});
 });
 it('requires supported installed hosts only for the persisted marker',()=>{
  for(const host of [undefined,old])expect(()=>select({OURS_FLEET_RUNTIME_POLICY:'installed-v1'},host)).toThrow(/No CLI was installed/);
  expect(select({OURS_FLEET_RUNTIME_POLICY:'installed-v1'},bundle)).toEqual({source:'host',binary:bundle});
 });
 it('honors deliberate bundled/custom choices in both modes without a fallback warning',()=>{
  for(const mode of ['legacy','installed-v1']){
   expect(select({OURS_FLEET_RUNTIME_POLICY:mode,[key]:''},old)).toEqual({source:'bundled',binary:bundle});
   expect(select({OURS_FLEET_RUNTIME_POLICY:mode,[key]:newer.path},old,newer)).toEqual({source:'explicit',binary:newer});
  }
 });
 it('does not replace an unsupported explicit path in strict mode',()=>{
  expect(()=>select({OURS_FLEET_RUNTIME_POLICY:'installed-v1',[key]:old.path},newer,old)).toThrow(/no runtime was substituted/);
  expect(select({[key]:old.path},newer,old)).toEqual({source:'explicit',binary:old});
 });
});
it('rejects unknown markers and removes only the Fleet-internal key from child env',()=>{
 expect(()=>runtimePolicy({OURS_FLEET_RUNTIME_POLICY:'unknown'})).toThrow(/must be/);
 const env={OURS_FLEET_RUNTIME_POLICY:'installed-v1',CODEX_PATH:'',CUSTOM:'keep'};
 expect(stripRuntimePolicy(env)).toEqual({CODEX_PATH:'',CUSTOM:'keep'});expect(env.OURS_FLEET_RUNTIME_POLICY).toBe('installed-v1');
});
