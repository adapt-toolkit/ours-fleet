import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
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

export interface CodexRuntime {
  source: 'CODEX_PATH' | 'bundled';
  entry: string;
  executable: string;
  version: string;
}

export async function probeCodexRuntime(
  adapter: AcpAgentResolution, env: NodeJS.ProcessEnv, exec: Exec = realExec, cwd = process.cwd(),
): Promise<CodexRuntime> {
  const configured = env.CODEX_PATH;
  if (!configured && !adapter.manifestPath)
    throw new Error('ACP runtime is unknown for a PATH/custom adapter; set CODEX_PATH to an absolute executable or use the bundled adapter');
  const entry = configured ? executableOnPath(configured, env, cwd)
    : createRequire(adapter.manifestPath!).resolve('@openai/codex/bin/codex.js');
  const executable = codexExecutable(entry);
  const result = await exec(!configured ? process.execPath : entry,
    !configured ? [entry, '--version'] : ['--version'], { env, timeout: 5_000 });
  const version = result.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (result.code !== 0 || !version)
    throw new Error(`Cannot read Codex version from ${entry}; check CODEX_PATH and executable permissions`);
  return { source: configured ? 'CODEX_PATH' : 'bundled', entry, executable, version };
}

export function codexVersionAtLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}
