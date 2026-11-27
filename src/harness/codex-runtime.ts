import { runtimePolicy, selectRuntime, stripRuntimePolicy } from './runtime-policy.js';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve, delimiter } from 'node:path';
import { realExec, type Exec } from '../exec.js';
import type { AcpAgentResolution } from './acp-agent.js';

export const VERIFIED_CODEX_ACP_VERSIONS = new Set(['1.1.7', '1.10.0', '2.7.0']);

/** The inspected runtime floor of the selected ACP adapter, shared by launch and doctor. */
export function minimumCodexVersion(adapterVersion: string | undefined, model?: string | null): string {
  if (adapterVersion === '2.7.0') return '0.166.0';
  return model === 'gpt-6-astra' || adapterVersion === '1.10.0' ? '0.153.3' : '0.145.0';
}

export function executableOnPath(command: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return resolve(cwd, command);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const path = resolve(cwd, dir, command + suffix);
      try { accessSync(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
    }
  }
  throw new Error(`${command} not found on PATH`);
}

/** Match the npm Codex wrapper's platform-package/vendor selection. */
export function codexExecutable(entry: string): string {
  const canonical = realpathSync(entry);
  if (!canonical.endsWith('/bin/codex.js') && !canonical.endsWith('\\bin\\codex.js')) return canonical;
  const platform = process.platform === 'android' ? 'linux' : process.platform;
  const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  const target = platform === 'linux' ? `${cpu}-unknown-linux-musl`
    : platform === 'darwin' ? `${cpu}-apple-darwin`
    : platform === 'win32' ? `${cpu}-pc-windows-msvc` : undefined;
  if (!cpu || !target) throw new Error(`Unsupported Codex platform ${platform}/${process.arch}`);
  let vendor: string;
  try {
    vendor = join(dirname(createRequire(canonical).resolve(
      `@openai/codex-${platform}-${process.arch}/package.json`)), 'vendor');
  } catch { vendor = join(dirname(canonical), '..', 'vendor'); }
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  // 0.153 uses bin/, while the supported legacy 0.145 wrapper uses codex/.
  for (const dir of ['bin', 'codex']) {
    const binary = join(vendor, target, dir, name);
    if (existsSync(binary)) return realpathSync(binary);
  }
  throw new Error(`Codex platform binary missing under ${vendor}; reinstall Fleet with optional dependencies`);
}

const versionOf = (text: string): string | undefined => text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
function installedCodexVersion(path: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(path, ['--version'], { env:stripRuntimePolicy(env), encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? versionOf(result.stdout ?? '') : undefined;
}

/**
 * The host's own Codex, when ACP sessions should run it instead of the copy bundled with the adapter.
 * The person signs in to, updates and checks the host Codex, and a newer Codex knows models the bundled
 * one does not. Legacy mode prefers a host at least as new as the bundle; installed-v1
 * requires the qualified installed runtime. An explicit CODEX_PATH
 * (including an empty one, which selects the bundled copy) always decides instead.
 */
export function hostCodex(
  adapterManifest: string | undefined, env: NodeJS.ProcessEnv, cwd = process.cwd(),
  version: (path: string, env: NodeJS.ProcessEnv) => string | undefined = installedCodexVersion,
  warn?: (message:string)=>void,
): { path: string; version: string } | undefined {
  const mode=runtimePolicy(env);
  if(!adapterManifest) { if(mode==='installed-v1') throw new Error('Codex adapter provenance unavailable; use a verified adapter or explicit custom ACP policy');return undefined; }
  let bundled:string,adapterVersion:string;
  try {bundled=JSON.parse(readFileSync(createRequire(adapterManifest).resolve('@openai/codex/package.json'),'utf8')).version;
    adapterVersion=JSON.parse(readFileSync(adapterManifest,'utf8')).version;}
  catch {if(mode==='installed-v1') throw new Error('Codex adapter runtime version unavailable');return undefined;}
  if(mode==='installed-v1' && !VERIFIED_CODEX_ACP_VERSIONS.has(adapterVersion))throw new Error('Codex adapter version is not qualified for installed-v1; use a qualified Fleet adapter or an explicitly command-owned runtime policy');
  const observe=(command:string) => {try {const path=executableOnPath(command,env,cwd),found=version(path,env);return found?{path,version:found}:undefined;}catch{return undefined;}};
  const explicit=mode==='installed-v1' && env.CODEX_PATH ? observe(env.CODEX_PATH) : undefined;
  const host=env.CODEX_PATH===undefined ? observe('codex') : undefined;
  const choice=selectRuntime({provider:'codex',env,bundled:{path:'adapter-managed Codex',version:bundled},host,explicit,minimum:minimumCodexVersion(adapterVersion)});
  if(choice.warning) warn?.(choice.warning);
  return choice.source==='host'?choice.binary:undefined;
}

export interface CodexRuntime {
  source: 'CODEX_PATH' | 'host' | 'bundled';
  warning?: string;
  entry: string;
  executable: string;
  version: string;
}

export async function probeCodexRuntime(
  adapter: AcpAgentResolution, env: NodeJS.ProcessEnv, exec: Exec = realExec, cwd = process.cwd(),
): Promise<CodexRuntime> {
  let warning:string|undefined;
  // Model discovery and doctor use this async path: never block their event loop
  // on a CLI --version subprocess. Launch-only hostCodex retains its sync seam.
  let observed:{path:string;result:Awaited<ReturnType<Exec>>}|undefined;
  const candidate=env.CODEX_PATH===undefined?'codex':env.CODEX_PATH;
  if(candidate){
    let path:string|undefined;
    try{path=executableOnPath(candidate,env,cwd);}catch{}
    if(path)observed={path,result:await exec(path,['--version'],{env:stripRuntimePolicy(env),timeout:5000})};
  }
  const observedVersion=(path:string)=>observed?.path===path && observed.result.code===0?versionOf(observed.result.stdout):undefined;
  const host = hostCodex(adapter.manifestPath, env, cwd, observedVersion, message=>{warning=message;});
  const configured = env.CODEX_PATH || host?.path;
  if (!configured && !adapter.manifestPath)
    throw new Error('ACP runtime is unknown for a PATH/custom adapter; set CODEX_PATH to an absolute executable or use the bundled adapter');
  const entry = configured ? executableOnPath(configured, env, cwd)
    : createRequire(adapter.manifestPath!).resolve('@openai/codex/bin/codex.js');
  const executable = codexExecutable(entry);
  const result = observed?.path===entry ? observed.result : await exec(!configured ? process.execPath : entry,
    !configured ? [entry, '--version'] : ['--version'], { env:stripRuntimePolicy(env), timeout: 5_000 });
  const version = versionOf(result.stdout);
  if (result.code !== 0 || !version)
    throw new Error(`Cannot read Codex version from ${entry}; check CODEX_PATH and executable permissions`);
  return { source: host ? 'host' : configured ? 'CODEX_PATH' : 'bundled', entry, executable, version, ...(warning?{warning}:{}) };
}

export function codexVersionAtLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}
