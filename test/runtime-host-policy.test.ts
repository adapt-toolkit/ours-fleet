import {chmodSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {hostClaude,bundledClaudeVersion} from '../src/harness/claude-runtime.js';
import {hostCodex,probeCodexRuntime} from '../src/harness/codex-runtime.js';
import {resolveBundledAcpAgent} from '../src/harness/acp-agent.js';
import {makeClaudeCodeAdapter} from '../src/harness/claude-code.js';
import {harnessChildEnv} from '../src/runner.js';
const roots:string[]=[];const temp=()=>{const path=mkdtempSync(join(tmpdir(),'runtime-host-'));roots.push(path);return path;};
beforeEach(()=>{vi.stubEnv('CLAUDE_CODE_EXECUTABLE',undefined);vi.stubEnv('CODEX_PATH',undefined);});
afterEach(()=>{vi.unstubAllEnvs();for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const claude=()=>resolveBundledAcpAgent('@agentclientprotocol/claude-agent-acp','claude-agent-acp','claude-agent-acp');
const codex=()=>resolveBundledAcpAgent('@agentclientprotocol/codex-acp','codex-acp','codex-acp');
const cli=(name:string,version:string)=>{const dir=join(temp(),'path with spaces');mkdirSync(dir);const path=join(dir,name);writeFileSync(path,`#!/bin/sh\nprintf '${version}\\n'\n`);chmodSync(path,0o700);return {dir,path};};
it('preserves legacy old/missing host behavior but reports selected bundle once',async()=>{
 const c=cli('claude','0.1.0'),warnings:string[]=[];
 expect(hostClaude(claude().manifestPath,{PATH:c.dir},undefined,undefined,message=>warnings.push(message))).toBeUndefined();
 expect(warnings).toHaveLength(1);expect(warnings[0]).toContain(bundledClaudeVersion(claude().manifestPath!)!);
 const runtime=await probeCodexRuntime(codex(),{PATH:temp()});expect(runtime.source).toBe('bundled');expect(runtime.warning).toContain('CODEX_PATH=""');
});
it('marked old/missing hosts fail instead of silently selecting a second CLI',()=>{
 const c=cli('claude','0.1.0');expect(()=>hostClaude(claude().manifestPath,{PATH:c.dir,OURS_FLEET_RUNTIME_POLICY:'installed-v1'})).toThrow(/No CLI was installed/);
 const x=cli('codex','0.1.0');expect(()=>hostCodex(codex().manifestPath,{PATH:x.dir,OURS_FLEET_RUNTIME_POLICY:'installed-v1'})).toThrow(/No CLI was installed/);
});
it('explicit empty overrides pin bundles without warnings in both modes',async()=>{
 for(const mode of ['legacy','installed-v1']){
  const warnings:string[]=[];expect(hostClaude(claude().manifestPath,{PATH:temp(),OURS_FLEET_RUNTIME_POLICY:mode,CLAUDE_CODE_EXECUTABLE:''},undefined,undefined,m=>warnings.push(m))).toBeUndefined();
  expect(warnings).toEqual([]);expect((await probeCodexRuntime(codex(),{PATH:temp(),OURS_FLEET_RUNTIME_POLICY:mode,CODEX_PATH:''})).warning).toBeUndefined();
 }
});
it('validates custom paths with spaces and leaves their values to normal role-env precedence',()=>{
 const c=cli('claude','99.0.0'),env={OURS_FLEET_RUNTIME_POLICY:'installed-v1',CLAUDE_CODE_EXECUTABLE:c.path,PATH:temp()};
 expect(hostClaude(claude().manifestPath,env)).toBeUndefined();
 expect(env.CLAUDE_CODE_EXECUTABLE).toBe(c.path);
 const x=cli('codex','99.0.0');expect(hostCodex(codex().manifestPath,{...env,CODEX_PATH:x.path})).toBeUndefined();
});
it('passes a once-per-launch warning through SessionPrep and strips only the marker before child launch',async()=>{
 const c=cli('claude','0.1.0'),root=temp();
 const role={name:'Legacy',identity:'Legacy',harness:'claude-code',session:'acp',sourceFile:'fixture',env:{PATH:c.dir}} as import('../src/config.js').ResolvedRole;
 const prep=await makeClaudeCodeAdapter().prepareSession(role,{stateDir:root,runCwd:root});expect(prep.runtimeWarnings).toHaveLength(1);
 const child=harnessChildEnv({...role,env:{...role.env,OURS_FLEET_RUNTIME_POLICY:'installed-v1',CUSTOM:'preserve'}},prep.env,root);
 expect(child.OURS_FLEET_RUNTIME_POLICY).toBeUndefined();expect(child.CUSTOM).toBe('preserve');
});
it('does not leak the internal marker into CLI version subprocesses',()=>{
 for(const provider of ['claude','codex']) {
  const entry=cli(provider,'99.0.0');
  writeFileSync(entry.path,'#!/bin/sh\nif [ -n "$OURS_FLEET_RUNTIME_POLICY" ]; then exit 9; fi\nprintf "99.0.0\\n"\n');
  const env={PATH:entry.dir,OURS_FLEET_RUNTIME_POLICY:'installed-v1'};
  const selected=provider==='claude'?hostClaude(claude().manifestPath,env):hostCodex(codex().manifestPath,env);
  expect(selected?.version).toBe('99.0.0');
 }
});
it.each(['claude','codex'])('marked %s rejects a non-executable, unparseable or hung version with a bounded error',provider=>{
 const entry=cli(provider,'99.0.0'),key=provider==='claude'?'CLAUDE_CODE_EXECUTABLE':'CODEX_PATH';
 const env={PATH:entry.dir,OURS_FLEET_RUNTIME_POLICY:'installed-v1',[key]:entry.path};
 const check=()=>provider==='claude'?hostClaude(claude().manifestPath,env):hostCodex(codex().manifestPath,env);
 chmodSync(entry.path,0o600);expect(check).toThrow(/unreadable or unsupported/);
 chmodSync(entry.path,0o700);writeFileSync(entry.path,'#!/bin/sh\nprintf "unknown version\\n"\n');expect(check).toThrow(/unreadable or unsupported/);
 writeFileSync(entry.path,'#!/bin/sh\nexec /bin/sleep 20\n');const start=Date.now();expect(check).toThrow(/unreadable or unsupported/);expect(Date.now()-start).toBeLessThan(8000);
},10000);
it('async Codex inspection leaves the picker event loop responsive while --version hangs',async()=>{
 const entry=cli('codex','99.0.0');writeFileSync(entry.path,'#!/bin/sh\nexec /bin/sleep 20\n');
 const started=Date.now();
 const inspection=probeCodexRuntime(codex(),{PATH:entry.dir,OURS_FLEET_RUNTIME_POLICY:'installed-v1'});
 // Attach before the timer so a fast error is not an unhandled rejection.
 const failed=inspection.then(()=>false,()=>true);
 await new Promise(resolve=>setTimeout(resolve,30));
 expect(Date.now()-started).toBeLessThan(1000);expect(await failed).toBe(true);
},10000);
