import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FleetError } from '../application/errors.js';
import { replaceFileAtomically } from '../atomic-file.js';
import {
  claudeAuthStatus, claudeLoginExpiry, codexUsageWindows, defaultBinaries, profileEnv, withCodex,
  type SubscriptionBinaries, type UsageWindow,
} from './cli.js';
import { HOME_ENV } from './launch.js';
import { ClaudeLogin, CodexDeviceLogin, type LoginHandle, type LoginView } from './login.js';
import { recordClaudeRateLimit } from './observed.js';
import { probeClaudeRateLimit } from './probe.js';
import {
  DEFAULT_PROFILE_ID, OBSERVED_USAGE_FILE, SUBSCRIPTION_PROVIDERS, createProfileHome, profileHome,
  readPin, readSubscriptionState, removeProfileHome, subscriptionsRoot, updateSubscriptionState,
  type SubscriptionProvider,
} from './store.js';

export type HealthState = 'ok' | 'expiring' | 'expired' | 'signed_out' | 'error' | 'unknown';

export interface ProfileHealth {
  state: HealthState;
  checkedAt?: string;
  detail?: string;
  /** When the stored login stops refreshing (Claude, observed field). */
  loginExpiresAt?: string;
}

export interface ProfileUsage {
  windows: UsageWindow[];
  observedAt?: string;
  /** `pull`: asked the provider. `agent`: last value an agent session reported. */
  source: 'pull' | 'agent' | 'probe' | 'none';
  /** A probe received an explicit limit error, even if no percentages were sent. */
  exhausted?: boolean;
}

export interface ProfileView {
  id: string;
  label: string;
  active: boolean;
  account?: { email?: string; plan?: string; org?: string };
  health: ProfileHealth;
  usage: ProfileUsage;
  /** Running agents whose session is pinned to this profile. */
  agents: string[];
}

export interface ProviderView {
  provider: SubscriptionProvider;
  activeProfileId: string;
  profiles: ProfileView[];
  /** Running agents still on a profile other than the active one: restart to switch. */
  staleAgents: Array<{ roleId: string; profileId: string }>;
  /** Running agents whose credentials come from env, not a Fleet profile. */
  unmanagedAgents: Array<{ roleId: string; via: string[] }>;
}

export interface AgentRef { roleId: string; stateDir?: string; running: boolean }

export interface SubscriptionServiceOptions {
  agents(): Promise<AgentRef[]>;
  binaries?: SubscriptionBinaries;
  now?: () => number;
  onChange?: () => void;
}

interface CheckResult { health: ProfileHealth; account?: ProfileView['account']; usage?: ProfileUsage }

const EXPIRING_MS = 3 * 24 * 3600_000;
const STALE_CHECK_MS = 10 * 60_000;

export class SubscriptionService {
  private readonly bins: SubscriptionBinaries;
  private readonly now: () => number;
  private readonly checks = new Map<string, CheckResult>();
  private readonly running = new Map<string, Promise<CheckResult>>();
  private readonly logins = new Map<string, LoginHandle>();
  private readonly probes = new Map<string, Promise<ProfileUsage>>();

  constructor(private readonly options: SubscriptionServiceOptions) {
    this.bins = options.binaries ?? defaultBinaries();
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<ProviderView[]> {
    const state = readSubscriptionState();
    const pins = await this.pins();
    return SUBSCRIPTION_PROVIDERS.map(provider => {
      const p = state.providers[provider];
      const profiles = p.profiles.map(profile => {
        const key = `${provider}/${profile.id}`;
        const cached = this.checks.get(key);
        if (!cached || this.now() - Date.parse(cached.health.checkedAt ?? '0') > STALE_CHECK_MS)
          void this.check(provider, profile.id).catch(() => {});
        const observed = provider === 'claude' ? this.observedUsage(pins, profile.id) : undefined;
        const probed = provider === 'claude' ? this.probedUsage(profile.id) : undefined;
        const usage = observed && probed
          ? (observed.observedAt ?? '') >= (probed.observedAt ?? '') ? observed : probed
          : observed ?? probed;
        return {
          id: profile.id, label: profile.label, active: profile.id === p.activeProfileId,
          account: cached?.account,
          health: cached?.health ?? { state: 'unknown' as const },
          usage: usage ?? cached?.usage ?? { windows: [], source: 'none' as const },
          agents: pins.filter(x => x.running && x.provider === provider && x.profileId === profile.id).map(x => x.roleId),
        };
      });
      return {
        provider, activeProfileId: p.activeProfileId, profiles,
        staleAgents: pins.filter(x => x.running && x.provider === provider && x.profileId !== p.activeProfileId)
          .map(x => ({ roleId: x.roleId, profileId: x.profileId })),
        unmanagedAgents: pins.filter(x => x.running && x.provider === provider && x.unmanaged?.length)
          .map(x => ({ roleId: x.roleId, via: x.unmanaged! })),
      };
    });
  }

  /** Health + account + (Codex) usage for one profile. Concurrent calls share one run. */
  check(provider: SubscriptionProvider, profileId: string): Promise<CheckResult> {
    this.profile(provider, profileId);
    const key = `${provider}/${profileId}`;
    const inflight = this.running.get(key);
    if (inflight) return inflight;
    const run = (provider === 'claude' ? this.checkClaude(profileId) : this.checkCodex(profileId))
      .catch((error): CheckResult => ({
        health: { state: 'error', checkedAt: new Date(this.now()).toISOString(), detail: (error as Error)?.message?.includes('prerequisite') ? 'subscription state unreadable' : 'health check failed' },
      }))
      .then(result => { this.checks.set(key, result); this.options.onChange?.(); return result; })
      .finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  private async checkClaude(profileId: string): Promise<CheckResult> {
    const home = profileHome('claude', profileId);
    const status = await claudeAuthStatus(this.bins.claude, profileEnv(HOME_ENV.claude, profileId, home));
    const checkedAt = new Date(this.now()).toISOString();
    const { refreshExpiresAt } = claudeLoginExpiry(home);
    const loginExpiresAt = refreshExpiresAt ? new Date(refreshExpiresAt).toISOString() : undefined;
    let state: HealthState = status.loggedIn ? 'ok' : 'signed_out';
    // The CLI reports the credential it would actually use (env, settings, helper…).
    if (status.loggedIn && status.authMethod && status.authMethod !== 'claude.ai') {
      return {
        health: { state: 'error', checkedAt, detail: `not using a Claude subscription login (${status.authMethod.slice(0, 40)})` },
        account: { email: status.email, plan: status.authMethod, org: status.org },
      };
    }
    if (status.loggedIn && refreshExpiresAt !== undefined) {
      if (refreshExpiresAt <= this.now()) state = 'expired';
      else if (refreshExpiresAt - this.now() < EXPIRING_MS) state = 'expiring';
    }
    return {
      health: { state, checkedAt, loginExpiresAt },
      account: status.loggedIn ? { email: status.email, plan: status.plan, org: status.org } : undefined,
    };
  }

  private async checkCodex(profileId: string): Promise<CheckResult> {
    const home = profileHome('codex', profileId);
    return withCodex(this.bins.codex, profileEnv(HOME_ENV.codex, profileId, home), async server => {
      const checkedAt = new Date(this.now()).toISOString();
      // refreshToken:false — a health check must not rotate a token agents use.
      const read = await server.call<{ account: null | { type: string; email?: string | null; planType?: string } }>(
        'account/read', { refreshToken: false });
      if (!read.account) return { health: { state: 'signed_out', checkedAt } };
      if (read.account.type !== 'chatgpt') {
        return {
          health: { state: 'error', checkedAt, detail: 'not a ChatGPT subscription login' },
          account: { plan: read.account.type === 'apiKey' ? 'API key' : read.account.type },
        };
      }
      const account = { email: read.account.email ?? undefined, plan: read.account.planType ?? 'chatgpt' };
      try {
        const limits = await server.call<Parameters<typeof codexUsageWindows>[0]>('account/rateLimits/read', {});
        return {
          health: { state: 'ok', checkedAt }, account,
          usage: { windows: codexUsageWindows(limits), observedAt: checkedAt, source: 'pull' },
        };
      } catch (error) {
        const expired = /401|unauthori[sz]ed|expired|sign in again|log in again/i.test(String((error as Error).message));
        return { health: { state: expired ? 'expired' : 'error', checkedAt, detail: expired ? 'login expired: sign in again' : 'usage limits unavailable' }, account };
      }
    });
  }

  async startLogin(provider: SubscriptionProvider, owner: string): Promise<LoginView> {
    for (const [id, login] of this.logins) {
      const view = login.view();
      if (view.provider !== provider) continue;
      if (view.state === 'starting' || view.state === 'awaiting_user' || view.state === 'verifying')
        login.cancel();
      this.logins.delete(id);
    }
    const { id: profileId, home } = createProfileHome(provider);
    const login = provider === 'claude'
      ? new ClaudeLogin(owner, this.bins, home, profileId)
      : new CodexDeviceLogin(owner, this.bins, home, profileId);
    const loginId = login.view().loginId;
    this.logins.set(loginId, login);
    void this.completeLogin(provider, profileId, login);
    // Give the CLI a moment to print its URL so the first response is useful.
    const deadline = this.now() + 8_000;
    while (login.view().state === 'starting' && this.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
    return login.view();
  }

  private async completeLogin(provider: SubscriptionProvider, profileId: string, login: ClaudeLogin | CodexDeviceLogin): Promise<void> {
    let label: string | undefined;
    let email: string | undefined;
    let error = 'sign-in did not complete';
    try {
      if (login instanceof ClaudeLogin) {
        const code = await login.exited;
        if (code === 0 && login.view().state === 'verifying') {
          const status = await claudeAuthStatus(this.bins.claude, profileEnv(HOME_ENV.claude, profileId, profileHome('claude', profileId)));
          if (status.loggedIn) { email = status.email; label = status.email ?? 'Claude account'; }
        } else if (login.view().state === 'verifying') error = 'the sign-in code was not accepted';
      } else if (await login.completed) {
        const result = await this.checkCodex(profileId);
        // Only a verified ChatGPT subscription login becomes a profile.
        if (result.health.state === 'ok') {
          email = result.account?.email;
          label = email ?? 'Codex account';
          this.checks.set(`${provider}/${profileId}`, result);
        }
      }
      if (label !== undefined) {
        if (!email?.trim()) { label = undefined; error = 'the CLI did not provide an account email'; }
        else if (await this.accountAlreadyAdded(provider, email)) {
          label = undefined;
          error = 'this account is already added';
        }
      }
    } catch { label = undefined; error = 'sign-in could not be verified'; }
    let registered = false;
    if (label !== undefined) {
      try {
        // Registration and the login's terminal state change together inside the
        // lock callback (synchronous), so a cancel or timeout that ran during the
        // verification awaits wins and nothing is registered.
        await updateSubscriptionState(state => {
          if (login.view().state !== 'verifying' || !existsSync(profileHome(provider, profileId))) return;
          state.providers[provider].profiles.push({ id: profileId, label: label!.slice(0, 80), createdAt: new Date(this.now()).toISOString() });
          login.complete(true);
          registered = true;
        });
      } catch { error = 'sign-in could not be saved'; }
    }
    if (!registered) {
      login.complete(false, error);
      removeProfileHome(provider, profileId);
      this.checks.delete(`${provider}/${profileId}`);
    }
    this.options.onChange?.();
  }

  /** Query the official CLI for each existing profile, including the adopted default. */
  private async accountAlreadyAdded(provider: SubscriptionProvider, email: string): Promise<boolean> {
    const wanted = email.trim().toLowerCase();
    for (const profile of readSubscriptionState().providers[provider].profiles) {
      const home = profileHome(provider, profile.id);
      let existing: string | undefined;
      if (provider === 'claude') {
        const status = await claudeAuthStatus(this.bins.claude, profileEnv(HOME_ENV.claude, profile.id, home));
        if (status.loggedIn) existing = status.email;
      } else {
        existing = await withCodex(this.bins.codex, profileEnv(HOME_ENV.codex, profile.id, home), async server => {
          const read = await server.call<{ account: null | { type: string; email?: string | null } }>(
            'account/read', { refreshToken: false });
          return read.account?.type === 'chatgpt' ? read.account.email ?? undefined : undefined;
        });
      }
      if (existing?.trim().toLowerCase() === wanted) return true;
    }
    return false;
  }

  login(loginId: string, owner: string): LoginHandle {
    const login = this.logins.get(loginId);
    // Unknown and foreign logins look the same: no probing of other sessions' logins.
    if (!login || login.owner !== owner) throw new FleetError('resource_not_found', 'login not found');
    return login;
  }

  async setActive(provider: SubscriptionProvider, profileId: string): Promise<ProviderView> {
    this.profile(provider, profileId);
    await updateSubscriptionState(state => {
      if (!state.providers[provider].profiles.some(p => p.id === profileId))
        throw new FleetError('resource_not_found', 'profile not found');
      state.providers[provider].activeProfileId = profileId;
    });
    this.options.onChange?.();
    return (await this.list()).find(p => p.provider === provider)!;
  }

  async rename(provider: SubscriptionProvider, profileId: string, label: string): Promise<void> {
    const clean = label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (!clean) throw new FleetError('invalid_request', 'label is required');
    await updateSubscriptionState(state => {
      const profile = state.providers[provider].profiles.find(p => p.id === profileId);
      if (!profile) throw new FleetError('resource_not_found', 'profile not found');
      profile.label = clean;
    });
    this.options.onChange?.();
  }

  /**
   * Remove a profile and its login. Refused while it is active or while any
   * running agent is still pinned to it; the adopted default is never removed.
   */
  async remove(provider: SubscriptionProvider, profileId: string): Promise<void> {
    if (profileId === DEFAULT_PROFILE_ID)
      throw new FleetError('conflict', 'the default profile is your existing CLI login and cannot be removed here');
    const pinned = (await this.pins()).filter(x => x.running && x.provider === provider && x.profileId === profileId);
    if (pinned.length)
      throw new FleetError('conflict', `profile is in use by running agents: ${pinned.map(x => x.roleId).join(', ')}; restart or stop them first`);
    await updateSubscriptionState(state => {
      const p = state.providers[provider];
      if (!p.profiles.some(x => x.id === profileId)) throw new FleetError('resource_not_found', 'profile not found');
      if (p.activeProfileId === profileId) throw new FleetError('conflict', 'switch to another profile before removing the active one');
      p.profiles = p.profiles.filter(x => x.id !== profileId);
    });
    removeProfileHome(provider, profileId);
    if (provider === 'claude') rmSync(this.probeUsageDir(profileId), { recursive: true, force: true });
    this.checks.delete(`${provider}/${profileId}`);
    this.options.onChange?.();
  }

  private profile(provider: SubscriptionProvider, profileId: string): void {
    if (!readSubscriptionState().providers[provider].profiles.some(p => p.id === profileId))
      throw new FleetError('resource_not_found', 'profile not found');
  }

  /** An explicit, bounded Haiku request can refresh Claude usage for an idle profile. */
  probeClaudeUsage(profileId: string): Promise<ProfileUsage> {
    this.profile('claude', profileId);
    const inFlight = this.probes.get(profileId);
    if (inFlight) return inFlight;
    const run = (async (): Promise<ProfileUsage> => {
      const dir = this.probeUsageDir(profileId);
      const result = await probeClaudeRateLimit(this.bins.claude, profileId);
      if (result) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const observedAt = new Date(this.now()).toISOString();
        const windows = result.rateLimit && recordClaudeRateLimit(dir, result.rateLimit, new Date(this.now()))
          ? readObservedClaudeUsage(dir, this.now())?.windows ?? [] : [];
        if (windows.length || result.exhausted) {
          const usage: ProfileUsage = { windows, observedAt, source: 'probe', ...(result.exhausted ? { exhausted: true } : {}) };
          replaceFileAtomically(join(dir, OBSERVED_USAGE_FILE), `${JSON.stringify(usage)}\n`, 0o600);
          this.options.onChange?.();
          return usage;
        }
      }
      rmSync(join(dir, OBSERVED_USAGE_FILE), { force: true });
      this.options.onChange?.();
      return { windows: [], source: 'none' };
    })().catch((): ProfileUsage => ({ windows: [], source: 'none' }))
      .finally(() => this.probes.delete(profileId));
    this.probes.set(profileId, run);
    return run;
  }

  private probeUsageDir(profileId: string): string {
    return join(subscriptionsRoot(), 'observed', 'claude', profileId);
  }

  private probedUsage(profileId: string): ProfileUsage | undefined {
    const usage = readObservedClaudeUsage(this.probeUsageDir(profileId), this.now());
    return usage && (usage.windows.length || usage.exhausted) ? { ...usage, source: 'probe' } : undefined;
  }

  private async pins(): Promise<Array<{ roleId: string; stateDir: string; running: boolean; provider: SubscriptionProvider; profileId: string; unmanaged?: string[] }>> {
    const result = [];
    for (const agent of await this.options.agents()) {
      if (!agent.stateDir) continue;
      const pin = readPin(agent.stateDir);
      if (pin) result.push({ roleId: agent.roleId, stateDir: agent.stateDir, running: agent.running, provider: pin.provider, profileId: pin.profileId, unmanaged: pin.unmanaged });
    }
    return result;
  }

  /** Latest Claude rate-limit snapshot any agent on this profile reported. */
  private observedUsage(pins: Awaited<ReturnType<SubscriptionService['pins']>>, profileId: string): ProfileUsage | undefined {
    let best: ProfileUsage | undefined;
    for (const pin of pins) {
      if (pin.provider !== 'claude' || pin.profileId !== profileId) continue;
      const observed = readObservedClaudeUsage(pin.stateDir);
      if (observed && (!best || (observed.observedAt ?? '') > (best.observedAt ?? ''))) best = observed;
    }
    return best;
  }
}

/** Read what `recordClaudeRateLimit` stored, dropping windows that already reset. */
export function readObservedClaudeUsage(stateDir: string, now = Date.now()): ProfileUsage | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, OBSERVED_USAGE_FILE), 'utf8')) as ProfileUsage;
    const windows = (raw.windows ?? []).filter(w => !w.resetsAt || Date.parse(w.resetsAt) > now);
    return { windows, observedAt: raw.observedAt, source: 'agent', ...(raw.exhausted === true ? { exhausted: true } : {}) };
  } catch { return undefined; }
}
