import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBundledAcpAgent } from '../harness/acp-agent.js';
import { probeCodexRuntime } from '../harness/codex-runtime.js';
import { codexOfferedModels, profileEnv, type OfferedModels } from '../subscriptions/cli.js';
import { profileHome, readSubscriptionState } from '../subscriptions/store.js';

export interface CodexModelDiscoveryDeps {
  /** The Codex executable ACP sessions will run, and its version. */
  runtime(): Promise<{ executable: string; version: string }>;
  ask(executable: string, env: NodeJS.ProcessEnv): Promise<OfferedModels>;
  now(): number;
}

const KNOWN_FOR_MS = 5 * 60_000;
const UNKNOWN_FOR_MS = 10_000;

/** When the profile's sign-in last changed; a new sign-in must not reuse another account's answer. */
function signInStamp(home: string): number {
  try { return statSync(join(home, 'auth.json')).mtimeMs; } catch { return 0; }
}

/**
 * The models offered to the active Codex account by the runtime that sessions will actually use.
 * An answer is reused only for the same executable, version, profile and sign-in.
 */
export function createCodexModelDiscovery(overrides: Partial<CodexModelDiscoveryDeps> = {}): () => Promise<OfferedModels> {
  const deps: CodexModelDiscoveryDeps = {
    runtime: () => probeCodexRuntime(resolveBundledAcpAgent('@agentclientprotocol/codex-acp', 'codex-acp', 'codex-acp'), process.env),
    ask: codexOfferedModels,
    now: Date.now,
    ...overrides,
  };
  let cached: { key: string; until: number; value: OfferedModels } | undefined;
  let pending: { key: string; answer: Promise<OfferedModels> } | undefined;
  return async () => {
    let key: string, executable: string, env: NodeJS.ProcessEnv;
    try {
      const profileId = readSubscriptionState().providers.codex.activeProfileId;
      const profile = profileHome('codex', profileId);
      const runtime = await deps.runtime();
      executable = runtime.executable;
      env = profileEnv('CODEX_HOME', profileId, profile);
      key = [runtime.executable, runtime.version, profileId, signInStamp(profile)].join('\n');
    } catch (error) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
    if (cached && cached.key === key && cached.until > deps.now()) return cached.value;
    if (pending?.key === key) return pending.answer;
    const answer = deps.ask(executable, env).then(value => {
      cached = { key, until: deps.now() + (value.state === 'known' ? KNOWN_FOR_MS : UNKNOWN_FOR_MS), value };
      return value;
    }).finally(() => { if (pending?.key === key) pending = undefined; });
    pending = { key, answer };
    return answer;
  };
}
