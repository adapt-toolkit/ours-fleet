import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedRole } from '../src/config.js';
import type { AgentSessionStartOptions } from '../src/harness/agent-session.js';
import { HermesAgentSessionAdapter, type HermesStartupChecks } from '../src/harness/hermes-session.js';
import { prepareHermesConfig } from '../src/harness/hermes-config.js';
import { AcpSession, type AcpSessionOptions } from '../src/session/acp.js';
import type { AgentSession } from '../src/session/types.js';

let root: string;
const sessions: AgentSession[] = [];
const checks: HermesStartupChecks = {
  expectedProvider: () => 'custom:fixture',
  validateArtifact: initialized => {
    if (initialized.agentInfo?.name !== 'hermes-agent' || initialized.agentInfo.version !== '0.21.1')
      throw new Error('unsupported Hermes artifact');
  },
};
const role = (extra: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: 'Worker', identity: 'Worker', harness: 'hermes', session: 'acp', model: 'vendor/model:latest',
  permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
  permissionsDeclared: true, sourceFile: 'test',
  monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 0, inject: 'notification', interrupt: false },
  ...extra,
} as ResolvedRole);

// A real stdio ACP peer; observed requests prove the adapter's final child boundary.
const fixtureSource = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const sid = randomUUID(); let pending;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); const { id, method, params } = request;
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ method, params, cwd: process.cwd(),
    home: process.env.HERMES_HOME, sentinel: process.env.FLEET_PARENT_SENTINEL ?? null,
    modelSecret: process.env.OPENAI_API_KEY ?? null, route: process.env.OURS_FLEET_PROXY_CALLER ?? null,
    identity: process.env.OURS_BIND_IDENTITY ?? null }) + '\\n');
  if (method === 'initialize') result(id, { protocolVersion: 1,
    agentInfo: { name: 'hermes-agent', version: process.env.FIXTURE_VERSION ?? '0.21.1' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } });
  if (method === 'session/new') result(id, { sessionId: sid,
    models: { currentModelId: process.env.FIXTURE_MODEL ?? 'custom:fixture:vendor/model:latest' },
    modes: { currentModeId: 'default', availableModes: (process.env.FIXTURE_MODES ?? 'default,accept_edits,dont_ask').split(',').map(id => ({ id, name: id })) } });
  if (method === 'session/set_mode') {
    if (process.env.FIXTURE_MODE_FAIL) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'mode unavailable' } });
    else result(id, {});
  }
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:' + text } } } });
    if (text === 'block') pending = id; else result(id, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel' && pending !== undefined) { result(pending, { stopReason: 'cancelled' }); pending = undefined; }
  if (method === 'session/close') result(id, {});
});
`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-hermes-session-'));
  mkdirSync(join(root, 'project'));
  writeFileSync(join(root, 'peer.mjs'), fixtureSource);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function options(adapter: HermesAgentSessionAdapter, extra: Partial<ResolvedRole> = {}): Promise<AgentSessionStartOptions> {
  const selected = role({ ...extra, env: { FIXTURE_LOG: join(root, 'wire.jsonl'), ...extra.env },
    session_options: { acp: { command: [process.execPath, join(root, 'peer.mjs')] } } });
  const stateDir = join(root, 'state');
  const home = join(stateDir, 'harness/hermes');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), YAML.stringify({ model: { provider: 'custom:fixture' } }));
  const prep = await prepareHermesConfig(selected, { stateDir, runCwd: join(root, 'project') });
  const launch = adapter.prepareLaunch(selected, prep);
  launch.env.OURS_FLEET_PROXY_CALLER = 'trusted-worker';
  return { role: selected, prep, launch, cwd: join(root, 'project'), stateDir, mode: 'resume',
    permissions: selected.permissions, permissionMode: { fleetMode: 'ask', nativeMode: 'default' }, log: () => {} };
}
const wire = (): Array<Record<string, any>> => readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function start(adapter: HermesAgentSessionAdapter, opts: AgentSessionStartOptions) {
  const session = await adapter.start(opts); sessions.push(session); return session;
}

describe('Hermes session adapter', () => {
  it.each([undefined, null, '', ' '])('rejects missing Brain model %s', model => {
    expect(() => new HermesAgentSessionAdapter(undefined, checks).resolveBrain({ model })).toThrow(/model/i);
  });
  it('rejects unsupported Brain effort and provider overrides', () => {
    const adapter = new HermesAgentSessionAdapter(undefined, checks);
    expect(() => adapter.resolveBrain({ model: 'm', effort: 'high' })).toThrow(/effort/);
    expect(() => adapter.resolveBrain({ model: 'm', harnessOptions: { provider: 'other' } })).toThrow(/provider/);
    expect(adapter.resolveBrain({ model: 'm', harnessOptions: { mcp_servers: { extra: { command: 'extra-mcp' } } } })).toEqual({ model: 'm', harnessOptions: { mcp_servers: { extra: { command: 'extra-mcp' } } } });
    expect(adapter.modelEnvironmentVariable()).toBeUndefined();
    expect(adapter.sessionConfigSelections(role())).toEqual([]);
    expect(() => adapter.sessionConfigSelections(role({ model_chain: ['a'] } as any))).toThrow(/model_chain/);
  });
  it('defaults to hermes-acp and requires a prepared home', () => {
    const adapter = new HermesAgentSessionAdapter(undefined, checks);
    expect(adapter.prepareLaunch(role(), { env: { HERMES_HOME: '/prepared/home' } }).argv).toEqual(['hermes-acp']);
    expect(() => adapter.prepareLaunch(role(), { env: {} })).toThrow(/home/i);
  });
  it('fails before child launch without independently supplied startup checks', async () => {
    const adapter = new HermesAgentSessionAdapter();
    const opts = await options(adapter);
    await expect(adapter.start(opts)).rejects.toThrow(/startup checks/i);
    expect(existsSync(join(root, 'wire.jsonl'))).toBe(false);
  });
  it('starts fresh despite stale persisted ID and resume request, keeping cwd separate from home', async () => {
    let captured: AcpSessionOptions | undefined;
    const adapter = new HermesAgentSessionAdapter(async opts => { captured = opts; return AcpSession.start(opts); }, checks);
    const opts = await options(adapter, { harness_options: { mcp_servers: { extra: { command: 'extra-mcp', args: [], env: { COLOR: 'blue' } } } } });
    writeFileSync(join(opts.stateDir, '.acp-session-id'), 'stale-id\n');
    const session = await start(adapter, opts);
    expect(captured).toMatchObject({ mode: 'fresh', inheritEnvironment: false, requireMode: true, modeId: 'default', permissionTimeoutMs: 50_000 });
    expect(session.snapshot().sessionId).not.toBe('stale-id');
    expect(session.snapshot().readiness).toBe('idle');
    const created = wire().find(row => row.method === 'session/new')!;
    expect(created.cwd).toBe(opts.cwd);
    expect(created.home).toBe(opts.prep.env.HERMES_HOME);
    expect(created.home).not.toBe(created.cwd);
    expect(created.params.mcpServers).toEqual([
      { name: 'ours', command: 'ours-mcp', args: ['proxy'], env: expect.arrayContaining([
        { name: 'OURS_BIND_IDENTITY', value: 'Worker' }, { name: 'OURS_FLEET_PROXY_CALLER', value: 'trusted-worker' },
      ]) },
      { name: 'extra', command: 'extra-mcp', args: [], env: [{ name: 'COLOR', value: 'blue' }] },
    ]);
    expect(wire().some(row => ['session/load', 'session/resume', 'session/set_config_option'].includes(row.method))).toBe(false);
    expect((await session.submitPrompt('full briefing')).output).toBe('echo:full briefing');
  });
  it('strips ambient and final-merge credentials while preserving trusted ours routing', async () => {
    vi.stubEnv('FLEET_PARENT_SENTINEL', 'ambient'); vi.stubEnv('OPENAI_API_KEY', 'ambient-key');
    const adapter = new HermesAgentSessionAdapter(undefined, checks);
    const opts = await options(adapter);
    opts.launch.env.OPENAI_API_KEY = 'late-key'; opts.launch.env.FLEET_PARENT_SENTINEL = 'late-sentinel';
    await start(adapter, opts);
    expect(wire()[0]).toMatchObject({ sentinel: null, modelSecret: null, identity: 'Worker', route: 'trusted-worker' });
  });
  it.each([
    { FIXTURE_MODES: 'unrelated' }, { FIXTURE_MODE_FAIL: '1' },
    { FIXTURE_MODEL: 'other:vendor/model:latest' }, { FIXTURE_MODEL: 'custom:fixture:wrong' },
    { FIXTURE_MODEL: '' }, { FIXTURE_VERSION: 'unknown' },
  ])('rejects incompatible startup before briefing and persistence: %j', async env => {
    const adapter = new HermesAgentSessionAdapter(undefined, checks);
    const opts = await options(adapter, { env });
    await expect(adapter.start(opts)).rejects.toThrow();
    expect(existsSync(join(opts.stateDir, '.acp-session-id'))).toBe(false);
    expect(wire().some(row => row.method === 'session/prompt')).toBe(false);
  });
  it('ignores provider case and whitespace in native encoding without splitting colon-bearing models', async () => {
    const adapter = new HermesAgentSessionAdapter(undefined, { ...checks, expectedProvider: () => ' Custom:Fixture ' });
    await start(adapter, await options(adapter));
  });
  it('uses the native Ollama catalog provider prefix', async () => {
    const adapter = new HermesAgentSessionAdapter(undefined, { ...checks, expectedProvider: () => 'ollama' });
    await start(adapter, await options(adapter, { env: { FIXTURE_MODEL: 'custom:ollama:vendor/model:latest' } }));
  });
  it('awaits preflight using the final filtered environment and rejects before child launch', async () => {
    let checked = false;
    const adapter = new HermesAgentSessionAdapter(undefined, { ...checks,
      preflight: async (opts, env) => {
        await Promise.resolve();
        expect(opts.launch.argv).toEqual([process.execPath, join(root, 'peer.mjs')]);
        expect(env.OURS_FLEET_PROXY_CALLER).toBe('trusted-worker');
        expect(env.OPENAI_API_KEY).toBeUndefined();
        checked = true;
        throw new Error('unsupported executable');
      },
    });
    const opts = await options(adapter); opts.launch.env.OPENAI_API_KEY = 'late-key';
    await expect(adapter.start(opts)).rejects.toThrow('unsupported executable');
    expect(checked).toBe(true);
    expect(existsSync(join(root, 'wire.jsonl'))).toBe(false);
  });
  it('rejects missing expected native provider before child launch', async () => {
    const adapter = new HermesAgentSessionAdapter(undefined, { ...checks, expectedProvider: () => '' });
    const opts = await options(adapter);
    await expect(adapter.start(opts)).rejects.toThrow(/provider/i);
    expect(existsSync(join(root, 'wire.jsonl'))).toBe(false);
  });
  it('normal output and cancellation use the shared transport', async () => {
    const adapter = new HermesAgentSessionAdapter(undefined, checks);
    const session = await start(adapter, await options(adapter));
    const pending = await session.queuePrompt('block');
    await vi.waitFor(() => expect(wire().some(row => row.method === 'session/prompt')).toBe(true));
    await session.interrupt();
    expect(await pending.completion).toMatchObject({ outcome: 'cancelled' });
    expect((await session.submitPrompt('again')).output).toBe('echo:again');
  });
  it('restarts into a new ACP session with retained home and accepts the full briefing again', async () => {
    const adapter = new HermesAgentSessionAdapter(undefined, checks);
    const opts = await options(adapter);
    const memory = join(opts.prep.env.HERMES_HOME, 'memory.txt'); writeFileSync(memory, 'retained');
    const first = await start(adapter, opts);
    const firstId = first.snapshot().sessionId;
    await first.submitPrompt('full briefing'); await first.close(); sessions.splice(sessions.indexOf(first), 1);
    const second = await start(adapter, opts);
    expect(second.snapshot().sessionId).not.toBe(firstId);
    expect(readFileSync(memory, 'utf8')).toBe('retained');
    expect((await second.submitPrompt('full briefing')).output).toBe('echo:full briefing');
    expect(wire().filter(row => row.method === 'session/new')).toHaveLength(2);
    expect(wire().filter(row => row.method === 'session/prompt' && row.params.prompt[0].text === 'full briefing')).toHaveLength(2);
  });
});
