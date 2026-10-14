import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { FleetError } from '../application/errors.js';
import { homedir } from 'node:os';
import { stateRoot } from '../paths.js';

/**
 * Fleet-wide Claude Code / Codex subscription profiles.
 *
 * A profile is one CLI home directory holding one account's login. Fleet never
 * reads or returns token values; the official CLIs own the credential files.
 * The `default` profile adopts the operator's existing `~/.claude` / `~/.codex`
 * in place, so a fleet that never adds a profile launches exactly as before.
 * Exactly one profile per provider is active; switching only affects agents
 * launched afterwards (running sessions stay pinned until restarted).
 */
export type SubscriptionProvider = 'claude' | 'codex';
export const SUBSCRIPTION_PROVIDERS: SubscriptionProvider[] = ['claude', 'codex'];
export const DEFAULT_PROFILE_ID = 'default';

export interface SubscriptionProfile {
  id: string;
  label: string;
  createdAt: string;
}

export interface ProviderState {
  activeProfileId: string;
  profiles: SubscriptionProfile[];
}

export interface SubscriptionState {
  version: 1;
  providers: Record<SubscriptionProvider, ProviderState>;
}

/** Recorded in an agent's state dir at launch: which profile the session uses. */
export interface SubscriptionPin {
  provider: SubscriptionProvider;
  profileId: string;
  /** Explicit CLI home, absent for the adopted default (the CLI's own default). */
  home?: string;
  /**
   * Default profile only: credential env (role or supervisor) that makes this
   * session authenticate outside Fleet's profiles. Reported, not managed.
   */
  unmanaged?: string[];
  pinnedAt: string;
}

export const PIN_FILE = '.subscription-pin.json';
export const OBSERVED_USAGE_FILE = '.subscription-usage.json';

/** Non-history configuration shared from the base home into each new profile. */
const SHARED_CONFIG: Record<SubscriptionProvider, string[]> = {
  claude: ['settings.json', 'CLAUDE.md', 'plugins', 'skills', 'agents', 'commands'],
  codex: ['config.toml', 'AGENTS.md', 'plugins', 'skills', 'rules'],
};

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const subscriptionsRoot = () => join(stateRoot(), 'subscriptions');
const stateFile = () => join(subscriptionsRoot(), 'state.json');
const lockPath = () => join(subscriptionsRoot(), '.lock');

/**
 * The CLI's own default home, adopted as the `default` profile. This follows
 * `$HOME` like the CLIs do, not OURS_FLEET_HOME (which may relocate Fleet state).
 */
export const baseHome = (provider: SubscriptionProvider) =>
  join(homedir(), provider === 'claude' ? '.claude' : '.codex');

export function isProvider(value: unknown): value is SubscriptionProvider {
  return value === 'claude' || value === 'codex';
}

export function profileHome(provider: SubscriptionProvider, profileId: string): string {
  if (profileId === DEFAULT_PROFILE_ID) return baseHome(provider);
  if (!PROFILE_ID_RE.test(profileId)) throw new FleetError('invalid_request', 'invalid profile id');
  return join(subscriptionsRoot(), provider, profileId);
}

function initialState(): SubscriptionState {
  const provider = (): ProviderState => ({
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [{ id: DEFAULT_PROFILE_ID, label: 'Default (existing login)', createdAt: new Date(0).toISOString() }],
  });
  return { version: 1, providers: { claude: provider(), codex: provider() } };
}

/**
 * Read the state. The file is only ever replaced by an atomic rename, so a
 * reader (including a launching agent) sees either the old or the new active
 * profile, never a torn write.
 */
export function readSubscriptionState(): SubscriptionState {
  let text: string;
  try { text = readFileSync(stateFile(), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialState();
    throw unreadable();
  }
  // Fail closed: a damaged state file must not silently move launches to another account.
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw unreadable(); }
  const state = initialState();
  const providers = (raw as { providers?: Record<string, Partial<ProviderState>> })?.providers;
  if (!providers || typeof providers !== 'object') throw unreadable();
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    const p = providers[provider];
    if (!p || !Array.isArray(p.profiles) || typeof p.activeProfileId !== 'string') throw unreadable();
    const profiles = p.profiles;
    if (profiles.some(x => !x || typeof x.id !== 'string' || (x.id !== DEFAULT_PROFILE_ID && !PROFILE_ID_RE.test(x.id))))
      throw unreadable();
    if (!profiles.some(x => x.id === DEFAULT_PROFILE_ID)) profiles.unshift(state.providers[provider].profiles[0]);
    if (!profiles.some(x => x.id === p.activeProfileId)) throw unreadable();
    const active = p.activeProfileId;
    state.providers[provider] = {
      activeProfileId: active,
      profiles: profiles.map(x => ({ id: x.id, label: String(x.label ?? x.id).slice(0, 80), createdAt: String(x.createdAt ?? '') })),
    };
  }
  return state;
}

const unreadable = () => new FleetError('prerequisite_unavailable',
  `subscription state ${stateFile()} is unreadable or invalid; fix or remove it before starting agents`);

/** Serialised read-modify-write of the state under a cross-process lock. */
export async function updateSubscriptionState<T>(
  fn: (state: SubscriptionState) => T,
): Promise<T> {
  mkdirSync(subscriptionsRoot(), { recursive: true, mode: 0o700 });
  return withFileLock(lockPath(), () => {
    const state = readSubscriptionState();
    const result = fn(state);
    replaceFileAtomically(stateFile(), `${JSON.stringify(state, null, 2)}\n`, 0o600);
    return result;
  });
}

/**
 * Create an empty profile home (not yet registered). Shared, non-history
 * configuration is symlinked from the base home; credentials and session
 * history stay per profile.
 */
export function createProfileHome(provider: SubscriptionProvider): { id: string; home: string } {
  const id = `p-${randomBytes(6).toString('hex')}`;
  const dir = profileHome(provider, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = baseHome(provider);
  for (const name of SHARED_CONFIG[provider]) {
    const src = join(base, name);
    if (existsSync(src)) {
      try { symlinkSync(src, join(dir, name)); } catch { /* optional convenience */ }
    }
  }
  return { id, home: dir };
}

/** Remove a non-default profile home. Never touches the adopted default. */
export function removeProfileHome(provider: SubscriptionProvider, profileId: string): void {
  if (profileId === DEFAULT_PROFILE_ID) return;
  rmSync(profileHome(provider, profileId), { recursive: true, force: true });
}

export function readPin(stateDir: string, provider?: SubscriptionProvider): SubscriptionPin | undefined {
  try {
    const pin = JSON.parse(readFileSync(join(stateDir, PIN_FILE), 'utf8')) as Record<string, SubscriptionPin>;
    if (provider) return pin[provider];
    return Object.values(pin)[0];
  } catch { return undefined; }
}

export function writePin(stateDir: string, pin: SubscriptionPin): void {
  replaceFileAtomically(join(stateDir, PIN_FILE), `${JSON.stringify({ [pin.provider]: pin })}\n`, 0o600);
}
