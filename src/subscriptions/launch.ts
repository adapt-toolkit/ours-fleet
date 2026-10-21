import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FleetError } from '../application/errors.js';
import {
  DEFAULT_PROFILE_ID, profileHome, readSubscriptionState, writePin,
  type SubscriptionPin, type SubscriptionProvider,
} from './store.js';

/** The subscription provider a harness authenticates with, if Fleet manages it. */
export function providerForHarness(harness: string): SubscriptionProvider | undefined {
  if (harness === 'claude-code') return 'claude';
  if (harness === 'codex') return 'codex';
  return undefined;
}

/** Env var that selects the CLI home for each provider. */
export const HOME_ENV: Record<SubscriptionProvider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Credential sources that would silently outrank the fleet-wide active profile
 * (see Claude Code's documented authentication precedence and Codex's
 * API-key login). While a non-default profile is active they are refused.
 */
export const CONFLICTING_AUTH_ENV: Record<SubscriptionProvider, string[]> = {
  claude: [
    'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE',
  ],
  codex: ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
};

/** Claude managed-settings file (Linux), which outranks user settings. */
export const CLAUDE_MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';

/**
 * Competing Claude credential sources declared in settings files: an `env`
 * block entry from CONFLICTING_AUTH_ENV, or an `apiKeyHelper`. Settings are
 * shared into profiles, so they can silently outrank a profile's login.
 */
export function claudeSettingsAuthSources(home: string, managed = CLAUDE_MANAGED_SETTINGS): string[] {
  const found: string[] = [];
  for (const file of [join(home, 'settings.json'), managed]) {
    let settings: { env?: Record<string, unknown>; apiKeyHelper?: unknown };
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const key of CONFLICTING_AUTH_ENV.claude)
      if (settings?.env && typeof settings.env === 'object' && key in settings.env) found.push(`${key} (${file})`);
    if (settings?.apiKeyHelper) found.push(`apiKeyHelper (${file})`);
  }
  return found;
}

export interface LaunchPin {
  pin: SubscriptionPin;
  /** Added to the harness child env last. Empty for the adopted default. */
  env: Record<string, string>;
  /** Host path the sandbox must mount read-write, if any. */
  writablePath?: string;
}

/**
 * Resolve the provider's active profile for a launch and record it in the
 * agent's state dir. Resolution happens once, here: a later switch never
 * changes what this session uses.
 */
export function pinSubscriptionForLaunch(
  role: { name: string; harness: string; env?: Record<string, string>; auth_proxy?: unknown },
  stateDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): LaunchPin | undefined {
  const provider = providerForHarness(role.harness);
  // A loopback auth proxy supplies credentials itself; it is not managed here.
  if (!provider || role.auth_proxy) return undefined;
  const profileId = readSubscriptionState().providers[provider].activeProfileId;
  const pin: SubscriptionPin = { provider, profileId, pinnedAt: now().toISOString() };
  if (profileId === DEFAULT_PROFILE_ID) {
    // The adopted default launches exactly as before; credential env that points
    // elsewhere is recorded so the panel can say this session is not managed.
    const unmanaged = CONFLICTING_AUTH_ENV[provider].filter(key => role.env?.[key] !== undefined || inherited[key]);
    if (unmanaged.length) pin.unmanaged = unmanaged;
    writePin(stateDir, pin);
    return { pin, env: {} };
  }
  const conflicts = CONFLICTING_AUTH_ENV[provider].filter(key =>
    role.env?.[key] !== undefined || (key !== HOME_ENV[provider] && inherited[key]));
  if (conflicts.length) {
    throw new FleetError('invalid_request',
      `role '${role.name}': ${conflicts.join(', ')} would bypass the active ${provider} subscription profile; ` +
      'remove it from the role env / supervisor environment or switch back to the default profile');
  }
  const home = profileHome(provider, profileId);
  if (provider === 'claude') {
    const settings = claudeSettingsAuthSources(home);
    if (settings.length) {
      throw new FleetError('invalid_request',
        `role '${role.name}': Claude settings declare ${settings.join(', ')}, which would bypass the active subscription profile`);
    }
  }
  pin.home = home;
  writePin(stateDir, pin);
  return { pin, env: { [HOME_ENV[provider]]: home }, writablePath: home };
}
