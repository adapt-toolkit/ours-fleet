import '../src/harness/codex.js';
import '../src/harness/claude-code.js';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {generateSetup,publishSetup,readInitSettings,executeInitAnswers,type InitAnswers} from '../src/init-wizard.js';
import {loadConfig,splitRootFor} from '../src/config.js';
const roots:string[]=[];
const temp=()=>{const path=mkdtempSync(join(tmpdir(),'runtime-init-'));roots.push(path);return path;};
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const chosen={harness:'codex' as const,session:'acp' as const,model:'gpt-6.1-sol',effort:'medium'};
const answers=(runtimePolicy?:InitAnswers['runtimePolicy']):InitAnswers=>({subscriptions:['codex'],assignmentStrategy:'one-model',models:{development:chosen,review:chosen,coordination:chosen},...(runtimePolicy?{runtimePolicy}:{})});
it.each(['installed-v1','bundled','legacy'] as const)('persists explicit %s choice in ordinary env maps and survives restart',async policy=>{
 const path=join(temp(),'fleet.yaml'),setup=generateSetup(answers(policy));await publishSetup(path,setup);
 for(let i=0;i<2;i++){
  const cfg=loadConfig(path),role=cfg.roles.find(role=>role.name==='FleetCoordinator')!;
  if(policy==='installed-v1')expect(role.env?.OURS_FLEET_RUNTIME_POLICY).toBe('installed-v1');
  else if(policy==='bundled')expect(role.env?.CODEX_PATH).toBe('');
  else expect(role.env?.OURS_FLEET_RUNTIME_POLICY).toBeUndefined();
 }
});
it('keeps existing files byte-identical when init is repeated with a new policy',async()=>{
 const path=join(temp(),'fleet.yaml');await publishSetup(path,generateSetup(answers()));
 const role=join(splitRootFor(path),'agents/FleetCoordinator.yaml'),before=readFileSync(role,'utf8');
 await publishSetup(path,generateSetup(answers('installed-v1')));
 expect(readFileSync(role,'utf8')).toBe(before);
});
it('accepts optional runtime choice in modern and installer legacy settings JSON',()=>{
 const path=join(temp(),'settings.json');writeFileSync(path,JSON.stringify(answers('bundled')));
 expect(readInitSettings(path).runtimePolicy).toBe('bundled');
 writeFileSync(path,JSON.stringify({subscriptions:['codex'],assignmentStrategy:'one-model',runtimePolicy:'installed-v1',reasoning:'balanced',models:Object.fromEntries(['development','review','coordination'].map(work=>[work,{harness:'codex',session:'acp',model:'gpt-6.1-sol',efforts:['medium']}]))}));
 expect(readInitSettings(path).runtimePolicy).toBe('installed-v1');
});
it('runtime preflight failure happens before host setup or config publication',async()=>{
 let host=0,publish=0;
 await expect(executeInitAnswers(answers('installed-v1'),join(temp(),'fleet.yaml'),{runtimePreflight:async()=>{throw Error('missing installed CLI; resume');},hostSetup:async()=>{host++;},publish:async()=>{publish++;throw Error('should not publish')}})).rejects.toThrow(/missing installed CLI/);
 expect(host).toBe(0);expect(publish).toBe(0);
});
it('real init preflight reports a missing selected CLI without installing anything',async()=>{
 const {vi}=await import('vitest');const {preflightInitRuntimes}=await import('../src/harness/runtime-init.js');
 try {vi.stubEnv('PATH',temp());vi.stubEnv('CODEX_PATH',undefined);
 await expect(preflightInitRuntimes(answers('installed-v1'))).rejects.toThrow(/missing or unreadable/);
 }finally{vi.unstubAllEnvs();}
});
it('deliberate bundled preflight works without a PATH CLI and names the selected binary',async()=>{
 const {vi}=await import('vitest');const {preflightInitRuntimes}=await import('../src/harness/runtime-init.js');
 try {vi.stubEnv('PATH',temp());vi.stubEnv('CODEX_PATH',undefined);
 const details=await preflightInitRuntimes(answers('bundled'));expect(details[0]).toContain('bundled');expect(details[0]).toMatch(/\(\d+\.\d+\.\d+\)/);
 }finally{vi.unstubAllEnvs();}
});
