import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexVersionAtLeast, executableOnPath } from './codex-runtime.js';

const versionOf = (text: string): string | undefined => text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
function installedClaudeVersion(path: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
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

/**
 * The host's own Claude Code, when ACP sessions should run it instead of the copy bundled with the adapter.
 * The person signs in to, updates and checks the host Claude Code, and a newer one knows models the bundled
 * one does not. It is used only when it is at least as new as the bundled copy; an explicit
 * CLAUDE_CODE_EXECUTABLE, in the role or the service environment, always decides instead.
 */
export function hostClaude(
  adapterManifest: string | undefined, env: NodeJS.ProcessEnv, cwd = process.cwd(),
  version: (path: string, env: NodeJS.ProcessEnv) => string | undefined = installedClaudeVersion,
): { path: string; version: string } | undefined {
  if (env.CLAUDE_CODE_EXECUTABLE !== undefined || !adapterManifest) return undefined;
  const bundled = bundledClaudeVersion(adapterManifest);
  if (!bundled) return undefined;
  let path: string;
  try { path = executableOnPath('claude', env, cwd); } catch { return undefined; }
  const found = version(path, env);
  return found && codexVersionAtLeast(found, bundled) ? { path, version: found } : undefined;
}
