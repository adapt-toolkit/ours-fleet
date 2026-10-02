import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve, delimiter } from 'node:path';
import { realExec, type Exec } from '../exec.js';
import type { AcpAgentResolution } from './acp-agent.js';

export const VERIFIED_CODEX_ACP_VERSIONS = new Set(['1.1.7', '1.10.0']);

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
  const result = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? versionOf(result.stdout ?? '') : undefined;
}

/**
 * The host's own Codex, when ACP sessions should run it instead of the copy bundled with the adapter.
 * The person signs in to, updates and checks the host Codex, and a newer Codex knows models the bundled
 * one does not. It is used only when it is at least as new as the bundled copy; an explicit CODEX_PATH
 * (including an empty one, which selects the bundled copy) always decides instead.
 */
export function hostCodex(
  adapterManifest: string | undefined, env: NodeJS.ProcessEnv, cwd = process.cwd(),
  version: (path: string, env: NodeJS.ProcessEnv) => string | undefined = installedCodexVersion,
): { path: string; version: string } | undefined {
  if (env.CODEX_PATH !== undefined || !adapterManifest) return undefined;
  let path: string, bundled: string;
  try {
    path = executableOnPath('codex', env, cwd);
    bundled = JSON.parse(readFileSync(createRequire(adapterManifest).resolve('@openai/codex/package.json'), 'utf8')).version;
  } catch { return undefined; }
  const found = version(path, env);
  return found && typeof bundled === 'string' && codexVersionAtLeast(found, bundled) ? { path, version: found } : undefined;
}

export interface CodexRuntime {
  source: 'CODEX_PATH' | 'host' | 'bundled';
  entry: string;
  executable: string;
  version: string;
}

export async function probeCodexRuntime(
  adapter: AcpAgentResolution, env: NodeJS.ProcessEnv, exec: Exec = realExec, cwd = process.cwd(),
): Promise<CodexRuntime> {
  const host = hostCodex(adapter.manifestPath, env, cwd);
  const configured = env.CODEX_PATH || host?.path;
  if (!configured && !adapter.manifestPath)
    throw new Error('ACP runtime is unknown for a PATH/custom adapter; set CODEX_PATH to an absolute executable or use the bundled adapter');
  const entry = configured ? executableOnPath(configured, env, cwd)
    : createRequire(adapter.manifestPath!).resolve('@openai/codex/bin/codex.js');
  const executable = codexExecutable(entry);
  const result = await exec(!configured ? process.execPath : entry,
    !configured ? [entry, '--version'] : ['--version'], { env, timeout: 5_000 });
  const version = versionOf(result.stdout);
  if (result.code !== 0 || !version)
    throw new Error(`Cannot read Codex version from ${entry}; check CODEX_PATH and executable permissions`);
  return { source: host ? 'host' : configured ? 'CODEX_PATH' : 'bundled', entry, executable, version };
}

export function codexVersionAtLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}
