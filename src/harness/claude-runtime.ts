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
 * one does not. Missing or unqualified installed CLIs produce an actionable error; an explicit
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
  try { path = executableOnPath('claude', env, cwd); } catch { throw new Error('Claude Code is missing from PATH. Install it from https://code.claude.com/docs/en/setup, sign in, then retry the Fleet command. Set CLAUDE_CODE_EXECUTABLE for a custom executable; an explicit empty value retains the bundled runtime.'); }
  const found = version(path, env);
  if (!found || !codexVersionAtLeast(found, bundled)) throw new Error(`Claude Code at ${path} reports ${found ?? 'an unreadable version'}; this adapter is qualified with ${bundled} or newer. Update your chosen CLI explicitly, then retry, or explicitly select a runtime with CLAUDE_CODE_EXECUTABLE. No bundled fallback was selected.`);
  return { path, version: found };
}
