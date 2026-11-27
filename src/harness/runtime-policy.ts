/** Persisted only in an existing env map so older Fleet versions can read it. */
export const RUNTIME_POLICY_ENV = 'OURS_FLEET_RUNTIME_POLICY';
export type RuntimePolicy = 'legacy' | 'installed-v1';
export function runtimePolicy(env: NodeJS.ProcessEnv): RuntimePolicy {
  const marker = env[RUNTIME_POLICY_ENV];
  if (marker === undefined || marker === 'legacy') return 'legacy';
  if (marker === 'installed-v1') return marker;
  throw new Error(`${RUNTIME_POLICY_ENV} must be installed-v1 or legacy; remove the marker to retain legacy runtime selection`);
}
const atLeast = (actual: string, floor: string) => {
  const a=actual.split('.').map(Number), b=floor.split('.').map(Number);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return true;
};
export interface RuntimeBinary { path: string; version: string }
export interface RuntimeChoice { source: 'host'|'bundled'|'explicit'; binary?: RuntimeBinary; warning?: string }
/** Select without rewriting config, PATH or auth. Explicit choices are user-owned. */
export function selectRuntime(input: {
  provider: 'claude'|'codex'; env: NodeJS.ProcessEnv; bundled: RuntimeBinary;
  host?: RuntimeBinary; explicit?: RuntimeBinary; minimum: string;
}): RuntimeChoice {
 const {provider,env,bundled,host,minimum}=input;
 const mode=runtimePolicy(env), key=provider==='claude'?'CLAUDE_CODE_EXECUTABLE':'CODEX_PATH';
 const override=env[key];
 if(override!==undefined) {
  if(override==='') return {source:'bundled',binary:bundled};
  if(mode==='installed-v1' && (!input.explicit || !atLeast(input.explicit.version,minimum)))
   throw new Error(`${key} selects an unreadable or unsupported executable; requires ${minimum} or newer. Check the exact path and --version; no runtime was substituted.`);
  return {source:'explicit',binary:input.explicit};
 }
 if(mode==='installed-v1') {
  if(host && atLeast(host.version,minimum)) return {source:'host',binary:host};
  const url=provider==='claude'?'https://code.claude.com/docs/en/setup':'https://developers.openai.com/codex/cli';
  throw new Error(`${provider==='claude'?'Claude Code':'Codex'} installed runtime is ${host?.version ?? 'missing or unreadable'}; requires ${minimum} or newer. Install/update your chosen CLI from ${url}, sign in, then retry the same Fleet command. Set ${key} to an explicit supported executable, or explicitly set ${key}="" to use the bundled runtime. No CLI was installed and no runtime was substituted.`);
 }
 if(host && atLeast(host.version,bundled.version)) return {source:'host',binary:host};
 return {source:'bundled',binary:bundled,warning:`Legacy runtime selection uses ${bundled.path} (${bundled.version}); installed ${provider} is ${host?.version ?? 'missing or unreadable'}. Pin this choice with ${key}="", or set ${key} to your chosen supported executable path. Legacy configuration was kept.`};
}
export function stripRuntimePolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 const output={...env};delete output[RUNTIME_POLICY_ENV];return output;
}
