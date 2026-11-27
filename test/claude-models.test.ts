import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { askClaudeModels, normalizeClaudeModel } from '../src/application/claude-models.js';
const roots: string[] = [];
function sdk(body: string) { const dir=mkdtempSync(join(tmpdir(),'metadata-')); roots.push(dir); const path=join(dir,'sdk.mjs'); writeFileSync(path,body); return path; }
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
it('normalizes unknown effort support without fabricating it',()=>{
  expect(normalizeClaudeModel({value:'provider.alias',displayName:'Alias'})).toEqual({id:'provider.alias',label:'Alias',efforts:null});
  expect(normalizeClaudeModel({value:'small',supportsEffort:false})).toEqual({id:'small',label:'small',efforts:[]});
  expect(normalizeClaudeModel({value:'opus',supportedEffortLevels:['high','low','high']} )?.efforts).toEqual(['high','low']);
  expect(normalizeClaudeModel({value:'\n'})).toBeUndefined();
});
it('uses no prompt messages, hooks, tools, MCP or persisted session', async()=>{
  const path=sdk(`export function query({prompt,options:o}) {
    if(!prompt[Symbol.asyncIterator] || o.persistSession !== false || o.settingSources.length || !o.settings.disableAllHooks || o.tools.length || Object.keys(o.mcpServers).length || !o.strictMcpConfig) throw Error('unsafe probe');
    return {supportedModels:async()=>[{value:'alias',displayName:'Alias',supportedEffortLevels:['high']}],close(){}};
  }`);
  expect(await askClaudeModels(path,'/custom path/claude',{},50)).toEqual({state:'known',freshness:'fresh',catalog:[{id:'alias',label:'Alias',efforts:['high']}]});
});
it.each(['offline','unauthenticated','quota exhausted'])('reports %s as unknown metadata',async reason=>{
 const path=sdk(`export function query(){return {supportedModels:async()=>{throw Error(${JSON.stringify(reason)})},close(){}}}`);
 expect(await askClaudeModels(path,'cli',{},50)).toMatchObject({state:'unknown',reason:'Claude model initialization unavailable; using static fallback'});
});
it('bounds a hung initialization and rejects empty or malformed catalogs',async()=>{
 const hung=sdk(`export function query(){return {supportedModels:()=>new Promise(()=>{}),close(){}}}`);
 expect((await askClaudeModels(hung,'cli',{},20)).state).toBe('unknown');
 for(const value of ['[]','{}']) {
 const path=sdk(`export function query(){return {supportedModels:async()=>(${value}),close(){}}}`);
 expect((await askClaudeModels(path,'cli',{},50)).state).toBe('unknown');
 }
});
it('isolates and removes the CLI metadata home even when initialization fails',async()=>{
 const path=sdk(`import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export function query({options:o}) {globalThis.__probeHome=o.env.CLAUDE_CONFIG_DIR;writeFileSync(join(o.env.CLAUDE_CONFIG_DIR,'.claude.json'),'{}');return {supportedModels:async()=>{throw Error('offline')},close(){}}}`);
 await askClaudeModels(path,'cli',{CLAUDE_CONFIG_DIR:'/never-write-user-home'},50);
 expect((globalThis as any).__probeHome).not.toBe('/never-write-user-home');
 expect(existsSync((globalThis as any).__probeHome)).toBe(false);
 delete (globalThis as any).__probeHome;
});
it('coalesces refreshes, labels cached data, honors TTL and invalidates changed credentials',async()=>{
 const {createClaudeModelDiscovery}=await import('../src/application/claude-models.js');
 let now=0,key='path/version/profile/stamp1',calls=0;
 const discover=createClaudeModelDiscovery({runtime:async()=>({sdk:'sdk',executable:'cli',env:{},key}),now:()=>now,ask:async()=>{calls++;return {state:'known',freshness:'fresh',catalog:[{id:'a',label:'A',efforts:null}]}}});
 expect((await discover()).state).toBe('known');
 expect(await discover()).toMatchObject({freshness:'cached'});expect(calls).toBe(1);
 key='path/version/profile/stamp2';await discover();expect(calls).toBe(2);
 now+=300001;await Promise.all([discover(),discover()]);expect(calls).toBe(3);
});
