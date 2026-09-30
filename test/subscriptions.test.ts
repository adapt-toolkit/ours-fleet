import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveIsolation } from '../src/isolation/policy.js';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
import { claudeSettingsAuthSources, pinSubscriptionForLaunch } from '../src/subscriptions/launch.js';
import { profileEnv } from '../src/subscriptions/cli.js';
import { allowedLoginUrl } from '../src/subscriptions/login.js';
import { recordClaudeRateLimit } from '../src/subscriptions/observed.js';
import { SubscriptionService, type AgentRef } from '../src/subscriptions/service.js';
import {
  DEFAULT_PROFILE_ID, PIN_FILE, createProfileHome, profileHome, readPin, readSubscriptionState, updateSubscriptionState,
} from '../src/subscriptions/store.js';

const fixtures = resolve('test/fixtures/subscriptions');
const bins = { claude: join(fixtures, 'fake-claude.mjs'), codex: join(fixtures, 'fake-codex.mjs'), script: 'script' };

let root: string;
let previousHome: string | undefined;
let previousUserHome: string | undefined;
const claudeRole = { name: 'Alpha', harness: 'claude-code' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-subs-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  previousUserHome = process.env.HOME;
  process.env.HOME = root;
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.claude', 'settings.json'), '{}');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  process.env.HOME = previousUserHome;
  rmSync(root, { recursive: true, force: true });
  delete process.env.FAKE_CLAUDE_URL;
  delete process.env.FAKE_CODEX_URL;
  delete process.env.FAKE_CODEX_EXPIRED;
  delete process.env.FAKE_CLAUDE_NO_LIMIT;
  delete process.env.FAKE_CLAUDE_PROBE_FAIL;
  delete process.env.FAKE_CLAUDE_PROBE_EXHAUSTED;
});

async function addProfile(provider: 'claude' | 'codex'): Promise<string> {
  const { id } = createProfileHome(provider);
  await updateSubscriptionState(s => { s.providers[provider].profiles.push({ id, label: id, createdAt: '' }); });
  return id;
}

function agentDir(name: string): string {
  const dir = join(root, '.ours-fleet', 'agents', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('subscription profiles: launch pinning', () => {
  it('leaves the default profile launch environment untouched and records the pin', () => {
    const dir = agentDir('Alpha');
    const pin = pinSubscriptionForLaunch(claudeRole, dir, {});
    expect(pin?.env).toEqual({});
    expect(pin?.writablePath).toBeUndefined();
    expect(readPin(dir)).toMatchObject({ provider: 'claude', profileId: DEFAULT_PROFILE_ID });
  });

  it('pins new launches to the active profile; running pins do not move on switch', async () => {
    const id = await addProfile('claude');
    const before = agentDir('Before');
    pinSubscriptionForLaunch(claudeRole, before, {});
    await updateSubscriptionState(s => { s.providers.claude.activeProfileId = id; });
    const after = agentDir('After');
    const pin = pinSubscriptionForLaunch(claudeRole, after, {});
    expect(pin?.env).toEqual({ CLAUDE_CONFIG_DIR: join(root, '.ours-fleet', 'subscriptions', 'claude', id) });
    expect(readPin(before)?.profileId).toBe(DEFAULT_PROFILE_ID);
    expect(readPin(after)?.profileId).toBe(id);
    // Codex is independent: still on its default.
    expect(pinSubscriptionForLaunch({ name: 'C', harness: 'codex' }, agentDir('C'), {})?.env).toEqual({});
  });

  it('refuses role or supervisor credentials that would bypass a non-default active profile', async () => {
    const id = await addProfile('claude');
    expect(pinSubscriptionForLaunch({ ...claudeRole, env: { ANTHROPIC_API_KEY: 'x' } }, agentDir('A'), {})?.env).toEqual({});
    await updateSubscriptionState(s => { s.providers.claude.activeProfileId = id; });
    expect(() => pinSubscriptionForLaunch({ ...claudeRole, env: { ANTHROPIC_API_KEY: 'x' } }, agentDir('B'), {}))
      .toThrow(/ANTHROPIC_API_KEY would bypass/);
    expect(() => pinSubscriptionForLaunch({ ...claudeRole, env: { CLAUDE_CONFIG_DIR: '/elsewhere' } }, agentDir('C'), {}))
      .toThrow(/CLAUDE_CONFIG_DIR/);
    expect(() => pinSubscriptionForLaunch(claudeRole, agentDir('D'), { CLAUDE_CODE_OAUTH_TOKEN: 'x' }))
      .toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    // An inherited CLAUDE_CONFIG_DIR is simply overridden by the pin.
    expect(pinSubscriptionForLaunch(claudeRole, agentDir('E'), { CLAUDE_CONFIG_DIR: '/x' })?.pin.profileId).toBe(id);
    // auth_proxy roles are not managed.
    expect(pinSubscriptionForLaunch({ ...claudeRole, auth_proxy: { url: 'http://127.0.0.1:1' } }, agentDir('F'), {})).toBeUndefined();
  });

  it('never tears the active profile under concurrent switch and start', async () => {
    const ids = [DEFAULT_PROFILE_ID, await addProfile('codex'), await addProfile('codex')];
    const switches = Array.from({ length: 30 }, (_, i) =>
      updateSubscriptionState(s => { s.providers.codex.activeProfileId = ids[i % 3]; }));
    const starts = Array.from({ length: 30 }, async (_, i) => {
      await new Promise(r => setTimeout(r, i % 7));
      return pinSubscriptionForLaunch({ name: `A${i}`, harness: 'codex' }, agentDir(`A${i}`), {})!.pin.profileId;
    });
    const [, pinned] = await Promise.all([Promise.all(switches), Promise.all(starts)]);
    for (const id of pinned) expect(ids).toContain(id);
    expect(readSubscriptionState().providers.codex.activeProfileId).toBe(ids[29 % 3]);
    expect(readSubscriptionState().providers.codex.profiles).toHaveLength(3);
  });

  it('shares only non-history configuration into a new profile home', () => {
    const { home } = createProfileHome('claude');
    expect(existsSync(join(home, 'settings.json'))).toBe(true);
    expect(existsSync(join(home, 'projects'))).toBe(false);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });
});

describe('subscription profiles: fail-closed auth sources', () => {
  it('refuses to start launches when the state file is corrupt or has an unknown active profile', async () => {
    await addProfile('claude');
    const file = join(root, '.ours-fleet', 'subscriptions', 'state.json');
    writeFileSync(file, '{not json');
    expect(() => pinSubscriptionForLaunch(claudeRole, agentDir('X'), {})).toThrow(/unreadable or invalid/);
    writeFileSync(file, JSON.stringify({ version: 1, providers: { claude: { activeProfileId: 'p-gone', profiles: [] } } }));
    expect(() => readSubscriptionState()).toThrow(/unreadable or invalid/);
    writeFileSync(file, JSON.stringify({ version: 1, providers: { claude: { activeProfileId: 'default', profiles: [] } } }));
    expect(() => readSubscriptionState()).toThrow(/unreadable or invalid/);
    rmSync(file);
    expect(readSubscriptionState().providers.claude.activeProfileId).toBe(DEFAULT_PROFILE_ID);
  });

  it('strips every credential selector from helper processes', () => {
    const env = profileEnv('CLAUDE_CONFIG_DIR', 'p-1', '/profiles/p-1', {
      PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', OPENAI_API_KEY: 'k',
      CODEX_API_KEY: 'k', CODEX_HOME: '/elsewhere', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_FEDERATION_RULE_ID: 'r',
    });
    expect(env).toMatchObject({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/p-1' });
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_FEDERATION_RULE_ID'])
      expect(env[key]).toBeUndefined();
    expect(profileEnv('CLAUDE_CONFIG_DIR', DEFAULT_PROFILE_ID, '/x', { CLAUDE_CONFIG_DIR: '/y' }).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('refuses a managed Claude launch when shared settings declare a competing credential', async () => {
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' }, apiKeyHelper: '/bin/key' }));
    const id = await addProfile('claude');
    expect(claudeSettingsAuthSources(join(root, '.ours-fleet', 'subscriptions', 'claude', id), '/nonexistent'))
      .toEqual([expect.stringMatching(/^ANTHROPIC_API_KEY/), expect.stringMatching(/^apiKeyHelper/)]);
    await updateSubscriptionState(s => { s.providers.claude.activeProfileId = id; });
    expect(() => pinSubscriptionForLaunch(claudeRole, agentDir('S'), {})).toThrow(/Claude settings declare ANTHROPIC_API_KEY/);
  });

  it('records default-profile sessions whose env points elsewhere as unmanaged', () => {
    const dir = agentDir('U');
    pinSubscriptionForLaunch({ name: 'U', harness: 'codex', env: { OPENAI_API_KEY: 'x' } }, dir, { CODEX_HOME: '/y' });
    expect(readPin(dir)).toMatchObject({ profileId: DEFAULT_PROFILE_ID, unmanaged: ['CODEX_HOME', 'OPENAI_API_KEY'] });
  });
});

describe('subscription profiles: isolation', () => {
  it('mounts the pinned profile home read-write, and nothing for the default', () => {
    const stateDir = agentDir('Iso');
    const ctx = { stateDir, runCwd: stateDir, home: root, harness: 'codex' };
    const home = join(root, '.ours-fleet', 'subscriptions', 'codex', 'p-1');
    expect(resolveIsolation({}, { ...ctx, subscriptionHome: home }).mounts).toContainEqual({ src: home, dst: home, mode: 'rw' });
    expect(resolveIsolation({}, ctx).mounts.some(m => m.src.includes('subscriptions'))).toBe(false);
  });

  const bwrapOk = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-user', '--', 'true']).status === 0;
  it.skipIf(!bwrapOk)('a sandboxed child can refresh its pinned profile and cannot see another profile', async () => {
    const id = await addProfile('codex');
    const other = await addProfile('codex');
    await updateSubscriptionState(s => { s.providers.codex.activeProfileId = id; });
    const stateDir = agentDir('Sandboxed');
    const pin = pinSubscriptionForLaunch({ name: 'Sandboxed', harness: 'codex' }, stateDir, {})!;
    const ctx = { stateDir, runCwd: stateDir, home: root, harness: 'codex', subscriptionHome: pin.writablePath };
    const argv = makeBubblewrapBackend().wrap(['/bin/sh', '-c',
      'echo refreshed > "$CODEX_HOME/auth.json" && ! ls "$OTHER" 2>/dev/null'], resolveIsolation({}, ctx), ctx);
    const run = spawnSync(argv[0], argv.slice(1), {
      env: { PATH: '/usr/bin:/bin', ...pin.env, OTHER: join(root, '.ours-fleet', 'subscriptions', 'codex', other) },
    });
    expect(run.status, String(run.stderr)).toBe(0);
    expect(readFileSync(join(pin.writablePath!, 'auth.json'), 'utf8').trim()).toBe('refreshed');
  });
});

describe('subscription service', () => {
  const agents: AgentRef[] = [];
  const service = () => new SubscriptionService({ agents: async () => agents, binaries: bins });
  beforeEach(() => { agents.length = 0; });

  it('allowlists login URLs by provider', () => {
    expect(allowedLoginUrl('claude', 'https://claude.com/cai/oauth/authorize?x=1')).toBeDefined();
    expect(allowedLoginUrl('claude', 'https://evil.example/claude.com')).toBeUndefined();
    expect(allowedLoginUrl('claude', 'http://claude.com/')).toBeUndefined();
    expect(allowedLoginUrl('claude', 'https://claude.com:8443/')).toBeUndefined();
    expect(allowedLoginUrl('codex', 'https://auth.openai.com/codex/device')).toBeDefined();
    expect(allowedLoginUrl('codex', 'https://claude.com/')).toBeUndefined();
  });

  it('adds a Claude account through the paste-code flow without exposing the code', async () => {
    const svc = service();
    const started = await svc.startLogin('claude', 'browser-1');
    expect(started).toMatchObject({ kind: 'paste_code', state: 'awaiting_user' });
    expect(started.url).toMatch(/^https:\/\/claude\.com\//);
    expect(() => svc.login(started.loginId, 'browser-2')).toThrow(/login not found/);
    const login = svc.login(started.loginId, 'browser-1');
    expect(() => login.submitCode('bad code\nwith newline')).toThrow(/sign-in code/);
    login.submitCode('good-code#state123');
    expect(() => login.submitCode('good-code#state123')).toThrow(/not waiting/);
    await login.done;
    expect(login.view()).toMatchObject({ state: 'succeeded' });
    expect(login.view().url).toBeUndefined();
    const claude = (await svc.list()).find(p => p.provider === 'claude')!;
    expect(claude.profiles.map(p => p.label)).toContain('second@example.test');
    expect(claude.activeProfileId).toBe(DEFAULT_PROFILE_ID);
    const added = claude.profiles.find(p => p.label === 'second@example.test')!;
    const check = await svc.check('claude', added.id);
    expect(check.health.state).toBe('ok');
    expect(check.account?.email).toBe('second@example.test');
    expect(JSON.stringify(check)).not.toMatch(/SECRET/);
  });

  it('rejects a second Claude login for an account already in a profile or default', async () => {
    const svc = service();
    const first = await svc.startLogin('claude', 'b');
    svc.login(first.loginId, 'b').submitCode('good-code#state123');
    await svc.login(first.loginId, 'b').done;
    const second = await svc.startLogin('claude', 'b');
    svc.login(second.loginId, 'b').submitCode('good-code#state123');
    await svc.login(second.loginId, 'b').done;
    expect(svc.login(second.loginId, 'b').view()).toMatchObject({ state: 'failed', error: 'this account is already added' });
    expect(readSubscriptionState().providers.claude.profiles).toHaveLength(2);
    writeFileSync(join(root, '.claude', 'fake-login.json'), JSON.stringify({ email: 'second@example.test' }));
    const third = await svc.startLogin('claude', 'b');
    svc.login(third.loginId, 'b').submitCode('good-code#state123');
    await svc.login(third.loginId, 'b').done;
    expect(svc.login(third.loginId, 'b').view().error).toBe('this account is already added');
    expect(readSubscriptionState().providers.claude.profiles).toHaveLength(2);
  });

  it('fails a Claude login whose URL is not allowlisted, and removes the half-made home', async () => {
    process.env.FAKE_CLAUDE_URL = 'https://evil.example/oauth';
    const svc = service();
    const started = await svc.startLogin('claude', 'b');
    const login = svc.login(started.loginId, 'b');
    await login.done;
    expect(login.view()).toMatchObject({ state: 'failed' });
    expect(login.view().url).toBeUndefined();
    await waitFor(() => readdirSync(join(root, '.ours-fleet', 'subscriptions', 'claude')).length === 0 ? true : undefined);
  });

  it('rejects a wrong Claude code and registers nothing', async () => {
    const svc = service();
    const started = await svc.startLogin('claude', 'b');
    const login = svc.login(started.loginId, 'b');
    login.submitCode('wrong-code#state123');
    await login.done;
    expect(login.view().state).toBe('failed');
    expect(readSubscriptionState().providers.claude.profiles).toHaveLength(1);
  });

  it('adds a Codex account by device code, then reads health and rate limits without refreshing', async () => {
    const svc = service();
    const started = await svc.startLogin('codex', 'b');
    expect(started).toMatchObject({ kind: 'device_code', state: 'awaiting_user', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
    const login = svc.login(started.loginId, 'b');
    await login.done;
    expect(login.view()).toMatchObject({ state: 'succeeded' });
    expect(login.view().userCode).toBeUndefined();
    const codex = (await svc.list()).find(p => p.provider === 'codex')!;
    const added = codex.profiles.find(p => p.label === 'codex2@example.test')!;
    expect(added.health.state).toBe('ok');
    expect(added.usage).toMatchObject({ source: 'pull', windows: [{ usedPercent: 61, windowMins: 10080, label: 'codex · weekly' }] });
    process.env.FAKE_CODEX_EXPIRED = '1';
    expect((await svc.check('codex', added.id)).health.state).toBe('expired');
    expect((await svc.check('codex', DEFAULT_PROFILE_ID)).health.state).toBe('signed_out');
  });

  it('rejects a second Codex device login for the same account', async () => {
    const svc = service();
    const first = await svc.startLogin('codex', 'b');
    await svc.login(first.loginId, 'b').done;
    const second = await svc.startLogin('codex', 'b');
    await svc.login(second.loginId, 'b').done;
    expect(svc.login(second.loginId, 'b').view()).toMatchObject({ state: 'failed', error: 'this account is already added' });
    expect(readSubscriptionState().providers.codex.profiles).toHaveLength(2);
  });

  it('reports unmanaged running agents and non-subscription Claude credentials', async () => {
    const svc = service();
    const dir = agentDir('Env');
    pinSubscriptionForLaunch({ name: 'Env', harness: 'claude-code', env: { ANTHROPIC_API_KEY: 'x' } }, dir, {});
    agents.push({ roleId: 'Env', stateDir: dir, running: true });
    writeFileSync(join(root, '.claude', 'fake-login.json'), JSON.stringify({ email: 'a@example.test', authMethod: 'api_key' }));
    const claude = (await svc.list()).find(p => p.provider === 'claude')!;
    expect(claude.unmanagedAgents).toEqual([{ roleId: 'Env', via: ['ANTHROPIC_API_KEY'] }]);
    expect((await svc.check('claude', DEFAULT_PROFILE_ID)).health).toMatchObject({ state: 'error', detail: expect.stringMatching(/not using a Claude subscription/) });
  });

  it('does not register a Codex login that is not a working ChatGPT subscription', async () => {
    process.env.FAKE_CODEX_EXPIRED = '1';
    const svc = service();
    const started = await svc.startLogin('codex', 'b');
    const login = svc.login(started.loginId, 'b');
    await login.done;
    expect(login.view().state).toBe('failed');
    expect(readSubscriptionState().providers.codex.profiles).toHaveLength(1);
  });

  it('replaces an unfinished login for the same provider after a page refresh', async () => {
    process.env.FAKE_CODEX_DELAY = '60000';
    try {
      const svc = service();
      const started = await svc.startLogin('codex', 'b');
      const login = svc.login(started.loginId, 'b');
      const replacement = await svc.startLogin('codex', 'b');
      await login.done;
      expect(login.view()).toMatchObject({ state: 'cancelled' });
      expect(login.view().userCode).toBeUndefined();
      expect(replacement).toMatchObject({ provider: 'codex', state: 'awaiting_user' });
      expect(replacement.loginId).not.toBe(started.loginId);
      expect(() => svc.login(started.loginId, 'b')).toThrow(/login not found/);
      svc.login(replacement.loginId, 'b').cancel();
    } finally { delete process.env.FAKE_CODEX_DELAY; }
  });

  it('replaces a pending Claude login with a fresh sign-in URL', async () => {
    const svc = service();
    const started = await svc.startLogin('claude', 'b');
    const old = svc.login(started.loginId, 'b');
    const replacement = await svc.startLogin('claude', 'b');
    await old.done;
    expect(old.view().state).toBe('cancelled');
    expect(replacement).toMatchObject({ provider: 'claude', state: 'awaiting_user', url: expect.stringMatching(/^https:\/\/claude\.com\//) });
    expect(replacement.loginId).not.toBe(started.loginId);
    expect(() => svc.login(started.loginId, 'b')).toThrow(/login not found/);
    svc.login(replacement.loginId, 'b').cancel();
  });

  it('lets a cancel during post-login verification win: nothing is registered', async () => {
    const svc = new SubscriptionService({ agents: async () => agents, binaries: { ...bins, codex: join(fixtures, 'slow-verify-codex.sh') } });
    const started = await svc.startLogin('codex', 'b');
    const login = svc.login(started.loginId, 'b');
    await waitFor(() => login.view().state === 'verifying' ? true : undefined);
    login.cancel();
    await new Promise(r => setTimeout(r, 1500));
    expect(login.view().state).toBe('cancelled');
    expect(readSubscriptionState().providers.codex.profiles).toHaveLength(1);
    expect(readdirSync(join(root, '.ours-fleet', 'subscriptions', 'codex'))).toEqual([]);
  });

  it('refuses to remove the default, the active, or a profile running agents are pinned to', async () => {
    const svc = service();
    const a = await addProfile('claude');
    const b = await addProfile('claude');
    await expect(svc.remove('claude', DEFAULT_PROFILE_ID)).rejects.toThrow(/default/);
    await svc.setActive('claude', a);
    await expect(svc.remove('claude', a)).rejects.toThrow(/active/);
    const dir = agentDir('Pinned');
    writeFileSync(join(dir, PIN_FILE), JSON.stringify({ claude: { provider: 'claude', profileId: b, pinnedAt: '' } }));
    agents.push({ roleId: 'Pinned', stateDir: dir, running: true });
    await expect(svc.remove('claude', b)).rejects.toThrow(/in use by running agents: Pinned/);
    const view = (await svc.list()).find(p => p.provider === 'claude')!;
    expect(view.staleAgents).toEqual([{ roleId: 'Pinned', profileId: b }]);
    agents[0].running = false;
    await svc.remove('claude', b);
    expect(existsSync(join(root, '.ours-fleet', 'subscriptions', 'claude', b))).toBe(false);
    expect(existsSync(join(root, '.claude'))).toBe(true);
  });

  it('attributes observed Claude rate limits to the agent\'s pinned profile', async () => {
    const svc = service();
    const dir = agentDir('Obs');
    pinSubscriptionForLaunch(claudeRole, dir, {});
    agents.push({ roleId: 'Obs', stateDir: dir, running: true });
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(recordClaudeRateLimit(dir, {
      status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.71, resetsAt: future }, seven_day: { utilization: 0.09, resetsAt: future } },
    })).toBe(true);
    const profile = (await svc.list()).find(p => p.provider === 'claude')!.profiles[0];
    expect(profile.usage.source).toBe('agent');
    expect(profile.usage.windows.map(w => [w.label, w.usedPercent])).toEqual([['5h', 71], ['weekly', 9]]);
    expect(profile.agents).toEqual(['Obs']);
  });

  it('checks Claude usage only on demand using the selected profile and hides failed probes', async () => {
    const svc = service();
    const id = await addProfile('claude');
    const other = await addProfile('claude');
    writeFileSync(join(profileHome('claude', id), 'fake-login.json'), JSON.stringify({ email: 'probe@example.test' }));
    const usage = await svc.probeClaudeUsage(id);
    expect(usage).toMatchObject({ source: 'probe', windows: [{ label: '5h', usedPercent: 42 }, { label: 'weekly', usedPercent: 17 }] });
    const profiles = (await svc.list()).find(p => p.provider === 'claude')!.profiles;
    expect(profiles.find(p => p.id === id)!.usage.source).toBe('probe');
    expect(profiles.find(p => p.id === other)!.usage.windows).toEqual([]);
    process.env.FAKE_CLAUDE_NO_LIMIT = '1';
    expect(await svc.probeClaudeUsage(id)).toEqual({ source: 'none', windows: [] });
    expect((await svc.list()).find(p => p.provider === 'claude')!.profiles.find(p => p.id === id)!.usage.windows).toEqual([]);
    process.env.FAKE_CLAUDE_PROBE_EXHAUSTED = '1';
    const exhausted = await svc.probeClaudeUsage(id);
    expect(exhausted).toMatchObject({ source: 'probe', exhausted: true, windows: [] });
    expect((await svc.list()).find(p => p.provider === 'claude')!.profiles.find(p => p.id === id)!.usage.exhausted).toBe(true);
  });
});
