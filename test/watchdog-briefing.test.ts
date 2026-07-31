import { describe, it, expect } from 'vitest';
import { generateWatchdogBriefing } from '../src/watchdog/briefing.js';
import { getAdapter } from '../src/harness/registry.js';
import '../src/harness/claude-code.js';

const wd = {
  name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
  intervalMs: 600_000, watch: ['Alice'], harness: 'claude-code', session: 'tmux' as const,
  identity: 'Watchdog-nightwatch', timeoutMs: 300_000, keepReports: 50,
  alertCooldownMs: 3_600_000, sourceFile: 'f',
};
const gen = (extra: Partial<Parameters<typeof generateWatchdogBriefing>[0]> = {}) =>
  generateWatchdogBriefing({
    wd, manifestPath: '/run/watch.json', reportPath: '/run/report.json',
    vocabulary: getAdapter('claude-code').vocabulary,
    identityGuarantee: 'unverified', ...extra,
  });

it('contains the observe-only contract, vocabulary, schema and completion sentinel', () => {
  const b = gen();
  for (const needle of [
    'never restart, stop, spawn or remove a role',
    'never answer a pending permission',
    'healthy', 'idle', 'stale', 'blocked', 'off_briefing', 'unreachable', 'unknown',
    'never reported as healthy',
    '"schema_version": 1',
    '/run/watch.json', '/run/report.json',
    'LAST action',
    'FleetCoordinator',
    'ONE message per run',
  ]) expect(b).toContain(needle);
});
it('tells an unverified identity to mint on first run, a verified one to just bind', () => {
  expect(gen()).toMatch(/create_identity/);
  expect(gen({ identityGuarantee: 'verified' })).not.toMatch(/if binding reports no such identity/i);
});
it('appends prompt_file focus without touching the contract (owner decision 1)', () => {
  const b = gen({ promptFocus: 'Pay attention to Docs drift.' });
  expect(b).toContain('## Extra focus (from prompt_file)');
  expect(b).toContain('Pay attention to Docs drift.');
  expect(b.indexOf('Pay attention to Docs drift.'))
    .toBeGreaterThan(b.indexOf('"schema_version": 1'));   // appended after the contract
});
it('makes interval thresholds concrete', () => {
  expect(gen()).toContain('10m');
});
