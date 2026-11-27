import { createHash } from 'node:crypto';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { profileEnv } from '../subscriptions/cli.js';
import { profileHome, readSubscriptionState, DEFAULT_PROFILE_ID } from '../subscriptions/store.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveBundledAcpAgent } from '../harness/acp-agent.js';
import { bundledClaudeVersion } from '../harness/claude-runtime.js';
import { codexVersionAtLeast, executableOnPath } from '../harness/codex-runtime.js';
import type { RuntimeModel } from '../subscriptions/cli.js';

export type ClaudeModels = { state: 'known'; catalog: RuntimeModel[]; freshness: 'fresh' | 'cached' }
  | { state: 'unknown'; reason: string };

export function normalizeClaudeModel(raw: unknown): RuntimeModel | undefined {
  if (!raw || typeof raw !== 'object') return;
  const row = raw as Record<string, unknown>;
  const valid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
  if (!valid(row.value)) return;
  const efforts = row.supportsEffort === false ? [] : Array.isArray(row.supportedEffortLevels)
    ? [...new Set(row.supportedEffortLevels.filter(valid))] : null;
  return { id: row.value, label: valid(row.displayName) ? row.displayName : row.value, efforts };
}

/** Metadata initialization only: no input messages, tools, hooks, MCP, or persisted session. */
export async function askClaudeModels(sdk: string, executable: string, env: NodeJS.ProcessEnv, budgetMs = 5_000): Promise<ClaudeModels> {
  const controller = new AbortController();
  // CLI initialization writes metadata even with persistSession=false. Keep it away
  // from the user's settings/auth homes; this is a provider catalog, not entitlement.
  const probeHome = mkdtempSync(join(tmpdir(), 'fleet-model-metadata-'));
  let q: { supportedModels(): Promise<unknown[]>; close(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { query } = await import(pathToFileURL(sdk).href);
    const prompt = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } };
    q = query({ prompt, options: { pathToClaudeCodeExecutable: executable, env: { ...env, CLAUDE_CONFIG_DIR: probeHome, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, abortController: controller,
      persistSession: false, settingSources: [], settings: { disableAllHooks: true }, plugins: [], tools: [], mcpServers: {}, strictMcpConfig: true } });
    const rows = await Promise.race([q!.supportedModels(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); q?.close(); reject(new Error('Claude model initialization timed out')); }, budgetMs);
    })]);
    if (!Array.isArray(rows)) throw new Error('Claude returned malformed model metadata');
    const catalog = [...new Map(rows.flatMap(raw => { const row = normalizeClaudeModel(raw); return row ? [[row.id, row] as const] : []; })).values()];
    if (!catalog.length) throw new Error('Claude returned no model metadata');
    return { state: 'known', catalog, freshness: 'fresh' };
  } catch (error) {
    return { state: 'unknown', reason: controller.signal.aborted ? 'Claude model initialization timed out' : 'Claude model initialization unavailable; using static fallback' };
  } finally { if (timer) clearTimeout(timer); q?.close(); rmSync(probeHome, { recursive: true, force: true }); }
}

/** A bounded metadata cache; provider environment is part of its key. */
export interface ClaudeDiscoveryDeps {
  runtime(): Promise<{sdk:string;executable:string;env:NodeJS.ProcessEnv;key:string}>;
  ask: typeof askClaudeModels;
  now(): number;
}
export function createClaudeModelDiscovery(overrides: Partial<ClaudeDiscoveryDeps> = {}) {
  const deps: ClaudeDiscoveryDeps = {
    runtime: async () => {
      const adapter = resolveBundledAcpAgent('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', 'claude-agent-acp');
      if (!adapter.manifestPath) throw new Error('Claude SDK metadata is unavailable for a custom adapter');
      const profileId = readSubscriptionState().providers.claude.activeProfileId;
      const home = profileHome('claude', profileId);
      const env = profileId === DEFAULT_PROFILE_ID ? { ...process.env } : profileEnv('CLAUDE_CONFIG_DIR', profileId, home);
      if (env.CLAUDE_CODE_EXECUTABLE === '') throw new Error('Bundled-only Claude selection uses the static adapter catalog');
      const executable = executableOnPath(env.CLAUDE_CODE_EXECUTABLE ?? 'claude', env);
      const { stdout } = await promisify(execFile)(executable, ['--version'], { env, timeout: 1000 });
      const version = stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
      const floor = bundledClaudeVersion(adapter.manifestPath);
      if (!version || (floor && !codexVersionAtLeast(version, floor))) throw new Error('Installed Claude CLI is below the qualified metadata runtime; use static fallback or update your selected CLI explicitly');
      const sdk = createRequire(adapter.manifestPath).resolve('@anthropic-ai/claude-agent-sdk');
      // Never serialize credentials into output or persistent cache.
      let stamp = 0;
      try { stamp = statSync(join(env.CLAUDE_CONFIG_DIR ?? home, '.credentials.json')).mtimeMs; } catch { /* no local credential */ }
      const key = createHash('sha256').update(JSON.stringify([executable, version, profileId, stamp, env])).digest('hex');
      return {sdk,executable,env,key};
    },
    ask: askClaudeModels, now: Date.now, ...overrides,
  };
  let cache: { key: string; until: number; value: ClaudeModels } | undefined;
  let pending: { key: string; value: Promise<ClaudeModels> } | undefined;
  return async (): Promise<ClaudeModels> => {
    try {
      const {sdk,executable,env,key} = await deps.runtime();
      if (cache?.key === key && cache.until > deps.now()) return cache.value.state === 'known' ? { ...cache.value, freshness: 'cached' } : cache.value;
      if (pending?.key === key) return pending.value;
      const value = deps.ask(sdk, executable, env).then(value => {
        cache = { key, until: deps.now() + (value.state === 'known' ? 300_000 : 10_000), value }; return value;
      }).finally(() => { if (pending?.key === key) pending = undefined; });
      pending = { key, value };
      return value;
    } catch (error) { return { state: 'unknown', reason: 'Claude runtime metadata unavailable; using static fallback. Check the selected CLI and provider configuration.' }; }
  };
}
