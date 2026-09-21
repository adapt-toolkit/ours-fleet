import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHermesAdapter } from '../src/index.js';
import { generateBriefing } from '../src/briefing.js';
import { findRole, loadConfig, type ResolvedRole } from '../src/config.js';
import type { Exec } from '../src/exec.js';
import { HermesAgentSessionAdapter } from '../src/harness/hermes-session.js';
import { registerAdapter } from '../src/harness/registry.js';
import type { AgentSessionStartOptions } from '../src/harness/agent-session.js';
import { agentDir } from '../src/paths.js';
import { loadTempRole, runOnce, type RunnerDeps } from '../src/runner.js';
import type { AcpSessionOptions } from '../src/session/acp.js';
import { turnResult, type AgentSession, type SubmitPromptOptions } from '../src/session/types.js';
import { writeV2Fixture } from './v2-fixture.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-hermes-runner-'));
  vi.stubEnv('OURS_FLEET_HOME', root);
  vi.stubEnv('OPENAI_API_KEY', 'ambient-provider-sentinel');
  mkdirSync(join(root, 'project'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function world() {
  const starts: AcpSessionOptions[] = [];
  const runnerStarts: AgentSessionStartOptions[] = [];
  const prompts: Array<{ text: string; options?: SubmitPromptOptions; briefing: string }> = [];
  let clock = 0;
  const exec: Exec = async cmd => ({ code: 0, stdout: cmd === 'bwrap' ? 'bubblewrap 0.11.1\n' : '', stderr: '' });
  const adapter = makeHermesAdapter(exec);
  // Keep real harness preparation and the real Hermes session adapter. Only
  // the external ACP process is replaced, through its existing transport seam.
  adapter.agentSession = new HermesAgentSessionAdapter(async options => {
    starts.push(options);
    let alive = true;
    const session: AgentSession = {
      backend: 'acp', pid: 4242,
      isAlive: () => alive,
      snapshot: () => ({ backend: 'acp', alive, readiness: 'idle' }),
      async queuePrompt(text, promptOptions) {
        prompts.push({ text, options: promptOptions,
          briefing: readFileSync(join(options.stateDir, 'briefing.md'), 'utf8') });
        alive = false;
        return { promptId: 'startup', queuedBehind: 0, completion: Promise.resolve(turnResult(true, 'completed')) };
      },
      submitPrompt: async () => turnResult(true, 'completed'),
      interrupt: async () => ({ state: 'settled' }), respondPermission: () => false,
      eventsSince: () => [], subscribe: () => () => {}, setControllerAttached: () => {},
      exitResult: () => ({ version: 1, class: 'program-exit', code: 1, detail: 'fixture ended' }),
      close: async () => { alive = false; },
    };
    return session;
  }, { expectedProvider: () => 'custom', validateArtifact: () => {} });
  registerAdapter(adapter);
  const deps: Partial<RunnerDeps> = {
    exec, now: () => clock, sleep: async ms => { clock += ms; }, log: () => {},
    isAlive: () => false, cpuDelegated: () => true,
    probeGeneration: async () => ({ state: 'ready', generation: { bootId: 'fixture', pid: 1, startedAt: 1, stateDir: root } }),
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ cursor: 0, events: [], identities: [] }) }),
    createMonitor: () => ({ prime: async () => {}, run: async () => {}, stop: () => {} }),
    startAgentSession: async (sessionAdapter, options) => { runnerStarts.push(options); return sessionAdapter.start(options); },
    createControlServer: () => ({ start: async () => {}, close: async () => {},
      setFleetSpawner: () => {}, setFleetAuditor: () => {}, setOwnerChannel: () => {}, setConfigReloader: () => {}, setLoopManager: () => {} }),
  };
  return { adapter, deps, starts, runnerStarts, prompts };
}
function provision(temporary: boolean, extra: Record<string, unknown> = {}) {
  const role = {
    harness: 'hermes', session: 'acp', model: 'fixture-model', identity: 'AssignedIdentity',
    mission: 'Complete the distinctive full mission.', cwd: join(root, 'project'),
    session_options: { acp: { command: [process.execPath, '-e', 'process.exit(0)'] } },
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    monitor: { mode: 'fleet' }, ...extra,
  };
  const configPath = join(root, 'fleet.yaml');
  if (temporary) {
    mkdirSync(agentDir('Worker', true), { recursive: true });
    writeFileSync(join(agentDir('Worker', true), 'role.yaml'), stringify({ ...role, name: 'Worker', sourceFile: '(temp)', permissionsDeclared: true }));
  } else writeV2Fixture(configPath, { roles: { Worker: role }, defaults: { start_stagger_ms: 0 } });
  const resolved: ResolvedRole = temporary ? loadTempRole('Worker') : findRole(loadConfig(configPath), 'Worker');
  const stateDir = agentDir('Worker', temporary);
  mkdirSync(join(stateDir, 'harness/hermes'), { recursive: true });
  writeFileSync(join(stateDir, 'harness/hermes/config.yaml'), stringify({ model: { provider: 'custom' } }));
  return { configPath, resolved, stateDir };
}
function briefing(w: ReturnType<typeof world>, p: ReturnType<typeof provision>, temporary: boolean,
  identityGuarantee: 'verified' | 'created' | 'unverified' = 'verified') {
  writeFileSync(join(p.stateDir, 'briefing.md'), generateBriefing(p.resolved, w.adapter.vocabulary, {
    stateDir: p.stateDir, worklogPath: join(p.stateDir, 'WORKLOG.md'), routinesPath: join(p.stateDir, 'ROUTINES.md'),
    temporaryIdentity: temporary, identityGuarantee,
  }));
}

describe('Hermes through the production runner', () => {
  it.each([
    { temporary: false, guarantee: 'verified' },
    { temporary: false, guarantee: 'created' },
    { temporary: false, guarantee: 'unverified' },
    { temporary: true, guarantee: 'unverified' },
  ] as const)('uses a full fresh briefing on every restart (%j)', async ({ temporary, guarantee }) => {
    const w = world(); const p = provision(temporary); briefing(w, p, temporary, guarantee);
    const memory = join(p.stateDir, 'harness/hermes/memory.txt'); writeFileSync(memory, 'retained');
    const opts = { temp: temporary, configPath: p.configPath };
    const first = await runOnce('Worker', opts, w.deps);
    writeFileSync(join(p.stateDir, '.booted'), 'previously started');
    writeFileSync(join(p.stateDir, '.acp-session-id'), 'stale-native-id');
    const second = await runOnce('Worker', opts, w.deps);
    expect([first.mode, second.mode]).toEqual(['fresh', 'fresh']);
    expect(w.runnerStarts.map(start => start.mode)).toEqual(['fresh', 'fresh']);
    expect(w.starts.map(start => start.mode)).toEqual(['fresh', 'fresh']);
    expect(w.prompts.map(prompt => prompt.text)).toEqual([
      `Read and follow ${join(p.stateDir, 'briefing.md')} now.`,
      `Read and follow ${join(p.stateDir, 'briefing.md')} now.`,
    ]);
    expect(w.prompts.every(prompt => prompt.options?.origin?.kind === 'startup')).toBe(true);
    expect(w.prompts[1].briefing).toContain('Complete the distinctive full mission.');
    expect(readFileSync(memory, 'utf8')).toBe('retained');
    expect(w.prompts[1].briefing).toContain('AssignedIdentity');
    expect(w.prompts[1].briefing).toContain('owned and verified by the Fleet supervisor');
    expect(w.prompts[1].briefing).not.toMatch(/choose_identity|create_temporary_identity/);
  });
  it('passes final routing and isolation argv through Hermes without restoring ambient credentials', async () => {
    const w = world(); const p = provision(false, { isolation: {} }); briefing(w, p, false);
    await runOnce('Worker', { configPath: p.configPath }, w.deps);
    const launched = w.starts[0];
    expect(launched.argv).toEqual(w.runnerStarts[0].launch.argv);
    expect(launched.argv).toContain('bwrap');
    expect(launched.argv).toContain(process.execPath);
    expect(launched.cwd).toBe(join(root, 'project'));
    expect(launched.env.HERMES_HOME).toBe(join(p.stateDir, 'harness/hermes'));
    expect(launched.env.OURS_BIND_IDENTITY).toBeUndefined();
    expect(launched.env.OURS_FLEET_PROXY_CALLER).toBe('Worker');
    expect(launched.env.OURS_FLEET_PROXY_STATE_DIR).toBe(p.stateDir);
    expect(launched.env.OPENAI_API_KEY).toBeUndefined();
    expect(launched.inheritEnvironment).toBe(false);
    const ours = launched.mcpServers!.find(server => server.name === 'ours')!;
    expect('env' in ours && ours.env).toEqual(expect.arrayContaining([{name:'FLEET_OURS_BRIDGE_DESCRIPTOR',value:expect.any(String)}]));
  });
  it.each([{ model: null }, { effort: 'high' }, { harness_options: { provider: 'other' } }])(
    'rejects unsupported persisted Brain settings before launch: %j', async extra => {
      const w = world();
      expect(() => provision(false, extra)).toThrow(/model|effort|provider/);
      expect(w.starts).toEqual([]);
    });
});

vi.mock('../src/agent-ours/service.js', async importOriginal => ({
 ...await importOriginal(),
 preparePermanentAssignment: vi.fn(async () => 'verified'),
 prepareManagedAgent: async () => ({descriptor:'/test/descriptor',privatePaths:[],runtime:{startHarness:async start=>start(),admit:async()=>()=>{}},close:async()=>{}}),
 releaseManagedAgent:async()=>{},
}));
