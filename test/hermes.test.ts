import { describe, expect, it } from 'vitest';
import { makeHermesAdapter } from '../src/harness/hermes.js';
import { getAdapter, productionAdapters } from '../src/harness/registry.js';
import type { ResolvedRole } from '../src/config.js';
const role = (extra: Partial<ResolvedRole> = {}): ResolvedRole => ({ name: 'Worker', identity: 'Worker', harness: 'hermes', session: 'acp', model: 'fixture-model', permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' }, monitor: { mode: 'fleet' }, ...extra } as ResolvedRole);
describe('Hermes harness', () => {
  const adapter = makeHermesAdapter(async () => ({ code: 0, stdout: 'usage: hermes-acp', stderr: '' }));
  it('registers a production fresh-only harness', () => {
    expect(getAdapter('hermes').supportsResume).toBe(false);
    expect(productionAdapters()).toContain('hermes');
    expect(adapter.exitPolicy.cleanExitIsFresh).toBe(true);
  });
  it('reports missing executable and home setup requirements', async () => {
    const missing = makeHermesAdapter(async () => ({ code: 127, stdout: '', stderr: 'missing' }));
    expect(await missing.checkPrereqs()).toMatchObject({ ok: false });
    expect(JSON.stringify(await adapter.checkPrereqs())).toMatch(/stopped.*home|home.*stopped/);
  });
  it('validates model and unsupported settings through the registered adapter', () => {
    expect(adapter.validateOptions({}, role({ model: null }))).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'model' })]));
    expect(adapter.validateOptions({ provider: 'override' }, role())).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'harness_options.provider' })]));
    expect(adapter.validateOptions({}, role())).toEqual([]);
  });
  it.each([['ask', 'default'], ['auto', 'accept_edits'], ['allow', 'dont_ask']] as const)('reports effective %s mode', (approval, nativeMode) => {
    expect(adapter.effectivePermissionMode!(role({ permissions: { approval, filesystem: 'workspace', unattended: 'wait' } }))).toEqual({ fleetMode: approval, nativeMode });
  });
  it('uses Fleet wake and non-force identity binding with fresh-conversation wording', () => {
    const text = adapter.vocabulary.restartPrompt('Worker', '/role/WORKLOG.md', role());
    expect(text).toMatch(/fresh/i);
    expect(text).not.toMatch(/force=true/);
    expect(adapter.vocabulary.supervisedWakeNote('Worker')).toMatch(/get_messages/);
    expect(adapter.vocabulary.supervisedWakeNote('Worker')).toMatch(/do NOT arm/i);
  });
  it('does not expose operator state as shared isolation paths', () => {
    expect(adapter.isolationPaths!(role(), { stateDir: '/role', runCwd: '/project' }).shared).toEqual([]);
  });
});
