import { runtimePolicy, selectRuntime, stripRuntimePolicy, type RuntimeChoice } from './runtime-policy.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executableOnPath } from './codex-runtime.js';

export const VERIFIED_CLAUDE_ACP_VERSIONS=new Set(['0.103.0']);
const versionOf = (text: string): string | undefined => text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
function installedClaudeVersion(path: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(path, ['--version'], { env:stripRuntimePolicy(env), encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? versionOf(result.stdout ?? '') : undefined;
}

/** The Claude Code version shipped inside the adapter's own SDK dependency. */
export function bundledClaudeVersion(adapterManifest: string): string | undefined {
  try {
    const sdk = dirname(createRequire(adapterManifest).resolve('@anthropic-ai/claude-agent-sdk'));
    const version = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).claudeCodeVersion;
    return typeof version === 'string' ? version : undefined;
  } catch { return undefined; }
}

/** Resolve only the SDK's selected platform binary; no auth or process startup. */
export function bundledClaudeExecutable(adapterManifest:string):string|undefined {
 try {
  const sdk=createRequire(adapterManifest).resolve('@anthropic-ai/claude-agent-sdk');
  const req=createRequire(sdk),ext=process.platform==='win32'?'.exe':'';
  const musl=process.platform==='linux' && !(process.report?.getReport() as {header?:{glibcVersionRuntime?:string}}|undefined)?.header?.glibcVersionRuntime;
  const names=process.platform==='linux' ? (musl
   ? [`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude`, `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`]
   : [`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`, `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude`])
   : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
  for(const name of names){try{return req.resolve(name);}catch{}}
 }catch{}
 return undefined;
}

/**
 * The host's own Claude Code, when ACP sessions should run it instead of the copy bundled with the adapter.
 * The person signs in to, updates and checks the host Claude Code, and a newer one knows models the bundled
 * one does not. Legacy mode prefers a host at least as new as the bundle; installed-v1
 * requires the qualified installed runtime. An explicit
 * CLAUDE_CODE_EXECUTABLE, in the role or the service environment, always decides instead.
 */
export function hostClaude(
  adapterManifest: string | undefined, env: NodeJS.ProcessEnv, cwd = process.cwd(),
  version: (path: string, env: NodeJS.ProcessEnv) => string | undefined = installedClaudeVersion,
  warn?: (message:string)=>void,
  selected?: (choice:RuntimeChoice)=>void,
): { path: string; version: string } | undefined {
  const mode=runtimePolicy(env);
  if (!adapterManifest) {
    if(mode==='installed-v1') throw new Error('Claude adapter provenance unavailable; use a verified adapter or explicit custom ACP policy');
    return undefined;
  }
  if(mode==='installed-v1') {
    const adapterVersion=JSON.parse(readFileSync(adapterManifest,'utf8')).version;
    if(!VERIFIED_CLAUDE_ACP_VERSIONS.has(adapterVersion))throw new Error('Claude adapter version is not qualified for installed-v1; use a qualified Fleet adapter or an explicitly command-owned runtime policy');
  }
  const bundled=bundledClaudeVersion(adapterManifest);
  if(!bundled) { if(mode==='installed-v1') throw new Error('Claude SDK runtime version unavailable'); return undefined; }
  const observe=(command:string) => {try {const path=executableOnPath(command,env,cwd),found=version(path,env);return found?{path,version:found}:undefined;}catch{return undefined;}};
  const explicit=mode==='installed-v1' && env.CLAUDE_CODE_EXECUTABLE ? observe(env.CLAUDE_CODE_EXECUTABLE) : undefined;
  const host=env.CLAUDE_CODE_EXECUTABLE===undefined ? observe('claude') : undefined;
  const choice=selectRuntime({provider:'claude',env,bundled:{path:bundledClaudeExecutable(adapterManifest) ?? 'adapter-managed Claude Code',version:bundled},host,explicit,minimum:bundled});
  selected?.(choice);
  if(choice.warning) warn?.(choice.warning);
  return choice.source==='host'?choice.binary:undefined;
}
