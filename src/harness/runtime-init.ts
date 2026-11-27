import {realExec} from '../exec.js';
import {stripRuntimePolicy} from './runtime-policy.js';
import type {RuntimeChoice} from './runtime-policy.js';
import type { InitAnswers } from '../init-wizard.js';
import { resolveBundledAcpAgent } from './acp-agent.js';
import { bundledClaudeVersion, bundledClaudeExecutable, hostClaude } from './claude-runtime.js';
import { codexVersionAtLeast, probeCodexRuntime } from './codex-runtime.js';

/** Read-only init check before service, configuration or credential mutations. */
export async function preflightInitRuntimes(answers:InitAnswers):Promise<string[]> {
 if(!answers.runtimePolicy || answers.runtimePolicy==='legacy')return [];
 const details:string[]=[];
 for(const harness of new Set(Object.values(answers.models).map(model=>model.harness))) {
  const env={...process.env,OURS_FLEET_RUNTIME_POLICY:'installed-v1'};
  if(harness==='codex') {
   const runtime=await probeCodexRuntime(resolveBundledAcpAgent('@agentclientprotocol/codex-acp','codex-acp','codex-acp'),
    answers.runtimePolicy==='bundled'?{...env,CODEX_PATH:''}:env);
   details.push(`Codex ${runtime.executable} (${runtime.version}); ${runtime.source}`);
  } else {
   const adapter=resolveBundledAcpAgent('@agentclientprotocol/claude-agent-acp','claude-agent-acp','claude-agent-acp');
   const selected:NodeJS.ProcessEnv=answers.runtimePolicy==='bundled'?{...env,CLAUDE_CODE_EXECUTABLE:''}:env;
   let choice:RuntimeChoice|undefined;
   hostClaude(adapter.manifestPath,selected,undefined,undefined,undefined,value=>{choice=value;});
   if(choice?.source==='bundled') {
     const path=bundledClaudeExecutable(adapter.manifestPath!);
     if(!path)throw new Error('Selected bundled Claude executable is missing. Reinstall Fleet with optional dependencies or choose a supported installed runtime; nothing was installed.');
     const result=await realExec(path,['--version'],{env:stripRuntimePolicy(selected),timeout:5000});
     const version=result.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
     const floor=bundledClaudeVersion(adapter.manifestPath!)!;
     if(result.code!==0 || !version || !codexVersionAtLeast(version,floor))throw new Error('Selected bundled Claude runtime failed its version check; no runtime was substituted');
     choice={source:'bundled',binary:{path,version}};
   }
   details.push(`Claude ${choice?.binary?.path ?? selected.CLAUDE_CODE_EXECUTABLE ?? 'adapter-managed runtime'} (${choice?.binary?.version ?? bundledClaudeVersion(adapter.manifestPath!) ?? 'unknown'}); ${choice?.source}`);
  }
 }
 return details;
}
