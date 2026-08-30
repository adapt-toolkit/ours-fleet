import { describe, it, expect } from 'vitest';
import { registerAdapter, getAdapter, knownAdapters } from '../src/harness/registry.js';
import type { HarnessAdapter } from '../src/harness/types.js';

export const fakeAdapter: HarnessAdapter = {
  id: 'fake',
  agentSession: {
    resolveBrain(brain) { return { model: brain.model, harnessOptions: brain.harnessOptions }; },
    modelEnvironmentVariable() { return undefined; },
    prepareLaunch(_role, prep) { return { argv: ['fakebin', '--fake-prep'], env: prep.env }; },
    async start() { throw new Error('fake agent session must be injected by the test'); },
  },
  supportsResume: true,
  async checkPrereqs() { return { ok: true, checks: [] }; },
  validateOptions() { return []; },
  async prepareSession() { return { env: { FAKE: '1' } }; },
  nativePermissionOverrides(options: unknown) {
    const mode = (options as { fake_mode?: string } | undefined)?.fake_mode;
    return mode == null ? {} : { fake_mode: mode };
  },
  translatePermissions(permissions) {
    return {
      supported: true,
      native: { fake_mode: permissions.approval },
      exact: permissions.approval === 'ask',
      warnings: permissions.approval === 'ask' ? [] : ['the fake harness only approximates this'],
      capabilities: [
        'read-state', 'write-state', 'messaging', 'monitor', 'workspace-edit', 'status-commands',
      ],
    };
  },
  effectivePermissionMode: role => ({
    fleetMode: role.permissions?.approval === 'allow' ? 'allow'
      : role.permissions?.approval === 'auto' ? 'auto' : 'ask',
    nativeMode: 'fake',
  }),
  vocabulary: {
    bindTool: 'choose_identity', createTool: 'create_identity',
    temporaryCreateTool: 'create_temporary_identity', setBioTool: 'set_bio',
    setPersonaTool: 'set_persona', currentIdentityTool: 'current_identity',
    sendTool: 'send_message', getMessagesTool: 'get_messages',
    listHistoryTool: 'list_history', getHistoryItemTool: 'get_history_item',
    monitorInstruction: id =>
      `Arm a persistent Monitor running \`ours api watch-notifications --input '{"identity":"${id}"}' --json\`.`,
    supervisedWakeNote: () => 'Wakes arrive as [fleet-monitor] lines — do NOT arm a Monitor. Run get_messages.',
    launchNote: name => `You are session ${name}.`,
    restartPrompt: (id, wl, role) => role?.monitor?.mode === 'fleet'
      ? `Restarted. Re-bind "${id}"; wakes via [fleet-monitor] lines. Continue from ${wl}.`
      : `Restarted. Re-bind "${id}", continue from ${wl}.`,
  },
  exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
};

describe('harness registry', () => {
  it('registers and resolves adapters', () => {
    registerAdapter(fakeAdapter);
    expect(getAdapter('fake')).toBe(fakeAdapter);
    expect(knownAdapters()).toContain('fake');
  });

  it('throws for unknown ids, listing known ones', () => {
    registerAdapter(fakeAdapter);
    expect(() => getAdapter('nope')).toThrowError(/unknown harness 'nope'.*fake/);
  });
});

describe('adapter permission-translation contract', () => {
  it('refuses an adapter missing the unified Brain selection method', () => {
    const agentSession = { ...fakeAdapter.agentSession } as Partial<typeof fakeAdapter.agentSession>;
    delete agentSession.resolveBrain;
    expect(() => registerAdapter({ ...fakeAdapter, id: 'brainless', agentSession } as unknown as HarnessAdapter))
      .toThrow(/agentSession\.resolveBrain/);
  });

  it('refuses an adapter missing its model recovery channel declaration', () => {
    const agentSession = { ...fakeAdapter.agentSession } as Partial<typeof fakeAdapter.agentSession>;
    delete agentSession.modelEnvironmentVariable;
    expect(() => registerAdapter({ ...fakeAdapter, id: 'model-channel-less', agentSession } as unknown as HarnessAdapter))
      .toThrow(/agentSession\.modelEnvironmentVariable/);
  });

  it('refuses to register an adapter that does not declare translatePermissions', () => {
    const { translatePermissions, ...silent } = fakeAdapter;
    expect(() => registerAdapter({ ...silent, id: 'silent' } as unknown as HarnessAdapter))
      .toThrowError(/'silent' must implement translatePermissions/);
    expect(knownAdapters()).not.toContain('silent');
  });

  it('accepts an adapter that explicitly declares neutral permissions unsupported', () => {
    const declining: HarnessAdapter = {
      ...fakeAdapter,
      id: 'declining',
      translatePermissions: () => ({ supported: false, reason: 'it has no permission model' }),
    };
    expect(() => registerAdapter(declining)).not.toThrow();
    expect(getAdapter('declining')).toBe(declining);
  });

  it('both production adapters translate', async () => {
    await import('../src/harness/claude-code.js');
    await import('../src/harness/codex.js');
    for (const id of ['claude-code', 'codex']) {
      const t = getAdapter(id).translatePermissions(
        { approval: 'ask', filesystem: 'workspace', unattended: 'deny' });
      expect(t.supported, id).toBe(true);
    }
  });
});
