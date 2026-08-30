import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { RoleRepository } from '../../src/application/role-repository.js';
import { FleetError, normalizeError } from '../../src/application/errors.js';
import { roleCapabilities } from '../../src/application/capabilities.js';
import { RoleCreationService } from '../../src/application/role-creation-service.js';
import type { SupervisorBackend } from '../../src/supervisor/types.js';
import type { OpsDeps } from '../../src/ops.js';
import { SessionControlError } from '../../src/session/types.js';
import { writeV2Fixture } from '../v2-fixture.js';

let oldHome: string | undefined;
afterEach(() => {
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
});

function fixture(): string {
  oldHome = process.env.OURS_FLEET_HOME;
  const root = mkdtempSync(join(tmpdir(), 'fleet-web-app-'));
  process.env.OURS_FLEET_HOME = root;
  mkdirSync(join(root, '.ours-fleet', 'agents'), { recursive: true });
  mkdirSync(join(root, '.ours-fleet', 'tmp'), { recursive: true });
  return root;
}

const backend: SupervisorBackend = {
  id: 'none',
  async init() { return []; },
  async install() { return { created: true, detail: 'created' }; },
  async start() {},
  async stop() {},
  async restart() {},
  async status() { return 'running'; },
  async liveness() { return { state: 'running', detail: 'fixture running' }; },
  async uninstall() { return { removed: true, detail: 'removed' }; },
  logsArgs() { return { cmd: 'tmux', args: [] }; },
};

function canonicalWeb(input: Record<string, any>): Record<string, any> {
  if (input.brain && input.role) return input;
  const { harness = 'codex', model, reasoningEffort, session: _session,
    mission, bio, persona, ...rest } = input;
  return {
    ...rest,
    brain: { inline: { harness, ...(model == null ? {} : { model }),
      ...(reasoningEffort ? { effort: reasoningEffort } : {}) } },
    role: { inline: { ...(mission ? { mission } : {}), ...(bio ? { bio } : {}),
      ...(persona ? { persona } : {}) } },
  };
}

describe('application services', () => {
  it('unions configured, permanent, temporary, orphan, and corrupt state without secrets', async () => {
    const root = fixture();
    writeV2Fixture(join(root, 'fleet.yaml'), `
roles:
  ConfigOnly:
    session: acp
    env: { SECRET: never-return-this }
  Permanent:
    session: acp
`);
    mkdirSync(join(root, '.ours-fleet', 'agents', 'Permanent'));
    mkdirSync(join(root, '.ours-fleet', 'agents', 'Orphan'));
    mkdirSync(join(root, '.ours-fleet', 'tmp', 'Temp'), { recursive: true });
    writeFileSync(join(root, '.ours-fleet', 'tmp', 'Temp', 'role.yaml'), `
harness: codex
session: acp
identity: Temp
`);
    mkdirSync(join(root, '.ours-fleet', 'tmp', 'Broken'), { recursive: true });
    writeFileSync(join(root, '.ours-fleet', 'tmp', 'Broken', 'role.yaml'), '[');
    const repo = new RoleRepository({
      configPath: join(root, 'fleet.yaml'),
      probeBackend: async (_name, intended) => ({ acp: intended === 'acp' }),
    });
    const roles = await repo.list();
    expect(roles.map(role => role.id)).toEqual(['Broken', 'ConfigOnly', 'Orphan', 'Permanent', 'Temp']);
    expect(roles.find(role => role.id === 'ConfigOnly')?.stateHealth).toBe('missing');
    expect(roles.find(role => role.id === 'Temp')?.lifetime).toBe('temporary');
    expect(roles.find(role => role.id === 'Orphan')?.lifetime).toBe('orphan');
    expect(roles.find(role => role.id === 'Broken')?.stateHealth).toBe('corrupt');
    expect(JSON.stringify(roles)).not.toContain('never-return-this');
  });

  it('keeps timeout/control failures distinct from proof of offline', () => {
    expect(normalizeError(new SessionControlError('timeout', 'busy')).toJSON()).toMatchObject({
      code: 'timeout', provesOffline: false, retryable: true,
    });
    expect(normalizeError(new SessionControlError('offline', 'gone')).toJSON()).toMatchObject({
      code: 'offline', provesOffline: true,
    });
  });

  it('computes capabilities from evidence and optional PTY availability', () => {
    const caps = roleCapabilities({
      id: 'A', lifetime: 'permanent', configured: true, stateHealth: 'present',
      configuredBackend: 'acp', detectedBackend: 'acp',
      compatibility: { compatible: true }, problems: [],
    }, {
      roleId: 'A', observedAt: new Date().toISOString(), overall: 'ready',
      supervisor: { backend: 'none', liveness: 'running', detail: 'running' },
      session: { backend: 'acp', reachability: 'online', readiness: 'idle', evidence: 'authoritative' },
      restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
      monitor: { mode: 'unknown', health: 'unknown', stale: true },
      isolation: { degraded: false }, problems: [],
    });
    expect(caps.input.text).toBe(true);
  });

  for (const flow of [
    { lifetime: 'permanent', session: 'acp', harness: 'codex', check: false, probe: 'ready' },
    { lifetime: 'permanent', session: 'acp', harness: 'claude-code', check: false, probe: 'attention' },
    { lifetime: 'temporary', session: 'acp', harness: 'claude-code', check: false, probe: 'ready' },
    { lifetime: 'temporary', session: 'acp', harness: 'codex', check: 'unknown', probe: 'attention' },
  ] as const) {
    it(`creates ${flow.lifetime} ${flow.harness}/${flow.session} with honest ${String(flow.check)} identity evidence`, async () => {
      const root = fixture();
      writeV2Fixture(join(root, 'fleet.yaml'), 'defaults: { harness: codex, session: acp }\nroles: {}\n');
      let mutationCalls = 0;
      const service = new RoleCreationService({
        configPath: join(root, 'fleet.yaml'),
        ops: { backend, binPath: '/bin/true', log() {} } satisfies OpsDeps,
        binPath: '/bin/true',
        identityProvisioner: {
          async exists() { return flow.check; },
          async create() { mutationCalls++; },
          async remove() { mutationCalls++; },
        },
        tempLauncher() {},
        allowedCwdRoots: [root],
        journalDir: join(root, '.ours-fleet', 'web-actions'),
        probeReady: async () => flow.probe,
      });
      const request = {
        name: `Created_${flow.lifetime}_${flow.session}`,
        harness: flow.harness, session: flow.session, lifetime: flow.lifetime,
        openAfterCreate: true,
        unverifiedIdentityAcknowledged: flow.check === 'unknown',
        permissions: {
          approval: 'ask' as const, filesystem: 'workspace' as const,
          unattended: 'deny' as const,
        },
        monitor: flow.lifetime === 'permanent' ? {
          mode: 'fleet' as const, interrupt: true, batch_ms: 750,
          inject: 'notification' as const,
          wake_sources: ['message_received', 'inbound_error'] as const,
        } : { mode: 'native' as const },
      };
      const canonicalRequest = canonicalWeb(request) as any;
      const preview = await service.preview(canonicalRequest);
      expect(preview.effective.identity).toBe(request.name);
      expect(preview.identityBootstrap).toMatchObject({
        existingIdentity: flow.check === false ? 'missing' : 'unknown',
        mode: 'current-fleet-first-boot', bindingEvidence: 'not-structured',
      });
      const first = await service.create(
        canonicalRequest, preview.previewHash, '0123456789abcdef0123456789abcdef', 'browser',
      );
      const duplicate = await service.create(
        canonicalRequest, preview.previewHash, '0123456789abcdef0123456789abcdef', 'browser',
      );
      expect(duplicate.actionId).toBe(first.actionId);
      await expect(service.create(
        canonicalWeb({ ...request, mission: 'changed request' }) as any, preview.previewHash,
        '0123456789abcdef0123456789abcdef', 'browser',
      )).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const finalState = flow.probe === 'ready' ? 'session_reachable' : 'attention';
      for (let i = 0; i < 100 && service.get(first.actionId)?.state !== finalState; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(service.get(first.actionId)).toMatchObject({
        state: finalState,
        identityCheck: flow.lifetime === 'temporary'
          ? 'unknown'
          : flow.check === false ? 'missing' : 'unknown',
        identityBindingEvidence: 'not-structured',
      });
      const stateDir = join(
        root, '.ours-fleet', flow.lifetime === 'permanent' ? 'agents' : 'tmp', request.name,
      );
      const briefing = readFileSync(join(stateDir, 'briefing.md'), 'utf8');
      if (flow.lifetime === 'permanent') {
        expect(briefing).toContain('choose_identity');
        expect(briefing).not.toContain('call **create_identity**');
        expect(briefing).toContain('It was created when your role');
      } else {
        expect(briefing).toContain('create_temporary_identity');
        expect(briefing).not.toContain('choose_identity');
        expect(briefing).not.toContain('call **create_identity**');
      }
      expect(service.get(first.actionId)?.stages.map(stage => stage.stage)).toContain(
        'identity_bootstrap_pending',
      );
      expect(mutationCalls).toBe(flow.lifetime === 'permanent' ? 1 : 0);
      const written = flow.lifetime === 'permanent'
        ? parse(readFileSync(join(root, 'fleet', 'agents', `${request.name}.yaml`), 'utf8'))
        : parse(readFileSync(join(stateDir, 'role.yaml'), 'utf8'));
      expect(written.monitor.mode).toBe(request.monitor.mode);
      const creation = JSON.parse(readFileSync(join(stateDir, 'creation.json'), 'utf8'));
      expect(creation.settings.monitor).toEqual({ source: 'cli', value: request.monitor });
      if (flow.lifetime === 'permanent') expect(written.monitor).toMatchObject({
        interrupt: true, batch_ms: 750, inject: 'notification',
        wake_sources: ['message_received', 'inbound_error'],
      });
    });
  }

  it('previews monitor defaults/provenance and rejects unsupported or invalid web monitor input', async () => {
    const root = fixture();
    writeV2Fixture(join(root, 'fleet.yaml'), `defaults:
  harness: codex
  model: fleet-codex
  monitor: { mode: native, batch_ms: 5000 }
roles:
  ExistingCodex:
    harness: codex
    model: fleet-codex
  ExistingClaude:
    harness: claude-code
    model: fleet-sonnet
`);
    const service = new RoleCreationService({
      configPath: join(root, 'fleet.yaml'),
      ops: { backend, binPath: '/bin/true', log() {} }, binPath: '/bin/true',
      identityProvisioner: { async exists() { return false; } },
      journalDir: join(root, '.ours-fleet', 'web-actions'),
      modelCatalogs: { codex: () => ({ models: [], warnings: ['Codex runtime model catalog unavailable: fixture.'] }) },
    });
    const base = {
      name: 'MonitorPreview', harness: 'codex' as const, session: 'acp' as const,
      lifetime: 'permanent' as const, openAfterCreate: true,
      permissions: {
        approval: 'ask' as const, filesystem: 'workspace' as const, unattended: 'deny' as const,
      },
    };
    const inherited = await service.preview(canonicalWeb(base) as any);
    expect(inherited.effective.monitor).toMatchObject({ mode: 'native', batch_ms: 5000 });
    expect(inherited.provenance.monitor).toBe('fleet-default');
    const creationCapabilities = await service.capabilities();
    expect(creationCapabilities.monitor).toMatchObject({
      modes: ['fleet', 'native'], injectModes: ['notification'],
      defaults: { mode: 'native', batch_ms: 5000 },
    });
    const explicit = await service.preview({
      ...canonicalWeb(base),
      monitor: {
        mode: 'fleet', interrupt: false, batch_ms: 25, inject: 'notification',
        wake_sources: ['state_import_failed'],
      },
    });
    expect(explicit.effective.monitor).toMatchObject({
      mode: 'fleet', batch_ms: 25, wake_sources: ['state_import_failed'],
    });
    expect(explicit.provenance.monitor).toBe('request');
    const safeBoundary = await service.preview({
      ...canonicalWeb(base),
      monitor: {
        mode: 'fleet', interrupt: 'after_tool', batch_ms: 25, inject: 'notification',
        wake_sources: ['message_received'],
      },
    });
    expect(safeBoundary.request.monitor).toMatchObject({ interrupt: 'after_tool' });
    expect(safeBoundary.effective.monitor.interrupt).toBe('after_tool');
    await expect(service.preview({
      ...canonicalWeb(base), monitor: { mode: 'fleet', wake_sources: ['not_real'] },
    } as any)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.preview({
      ...canonicalWeb(base),
      monitor: {
        mode: 'fleet', interrupt: false, batch_ms: 25, inject: 'full', wake_sources: [],
      },
    } as any)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('treats blank web model as harness default instead of a foreign fleet default', async () => {
    const root = fixture();
    writeV2Fixture(join(root, 'fleet.yaml'), `defaults:
  harness: codex
  model: gpt-5.6
roles: {}
`);
    const service = new RoleCreationService({
      configPath: join(root, 'fleet.yaml'),
      ops: { backend, binPath: '/bin/true', log() {} }, binPath: '/bin/true',
      identityProvisioner: { async exists() { return false; } },
      journalDir: join(root, '.ours-fleet', 'web-actions'),
    });
    const base = {
      name: 'ClaudeBlank', harness: 'claude-code' as const, model: null,
      session: 'acp' as const, lifetime: 'temporary' as const, openAfterCreate: true,
      permissions: {
        approval: 'ask' as const, filesystem: 'workspace' as const, unattended: 'deny' as const,
      },
    };
    const blank = await service.preview(canonicalWeb(base) as any);
    expect(blank.effective.model).toBeUndefined();
    expect(blank.provenance.brain).toBe('request');
    const inherited = await service.preview(canonicalWeb({
      ...base, name: 'CodexInherited', harness: 'codex', model: undefined,
    }) as any);
    expect(inherited.effective.model).toBeUndefined();
    expect(inherited.provenance.brain).toBe('request');
    const explicit = await service.preview(canonicalWeb({
      ...base, name: 'ClaudeExplicit', model: 'claude-x',
    }) as any);
    expect(explicit.effective.model).toBe('claude-x');
    expect(explicit.provenance.brain).toBe('request');
  });

  it('requires explicit confirmation before reusing an existing identity', async () => {
    const root = fixture();
    writeV2Fixture(join(root, 'fleet.yaml'), 'roles: {}\n');
    const service = new RoleCreationService({
      configPath: join(root, 'fleet.yaml'),
      ops: { backend, binPath: '/bin/true', log() {} },
      binPath: '/bin/true',
      identityProvisioner: { async exists() { return true; } },
      journalDir: join(root, '.ours-fleet', 'web-actions'),
    });
    const request = {
      name: 'Existing', harness: 'codex' as const, session: 'acp' as const,
      lifetime: 'permanent' as const, openAfterCreate: true,
      permissions: {
        approval: 'ask' as const, filesystem: 'workspace' as const,
        unattended: 'deny' as const,
      },
    };
    const canonicalRequest = canonicalWeb(request) as any;
    const preview = await service.preview(canonicalRequest);
    expect(preview.prerequisites).toContain('confirm reuse of the existing local identity');
    await expect(service.create(
      canonicalRequest, preview.previewHash, 'fedcba9876543210fedcba9876543210', 'browser',
    )).rejects.toMatchObject({ code: 'prerequisite_unavailable' });
  });

  it('preserves direct-only creation fields and rejects their injection into web requests', async () => {
    const root = fixture();
    const configPath = join(root, 'fleet.yaml');
    const missionFile = join(root, 'mission.md');
    const isolationFile = join(root, 'isolation.yaml');
    writeV2Fixture(configPath, 'defaults: { harness: codex, session: acp }\nroles: {}\n');
    writeFileSync(missionFile, 'Direct mission\n');
    writeFileSync(isolationFile, 'backend: auto\non_unavailable: warn\n');
    const service = new RoleCreationService({ configPath,
      ops: { backend, binPath: '/bin/true', log() {} }, binPath: '/bin/true', journal: false });
    const plan = service.previewSpawn({ origin: 'direct', options: {
      name: 'DirectFields', identity: 'SeparateIdentity', missionFile, isolationFile,
      brain: { inline: { harness: 'codex', harness_options: {
        profile: 'work', launcher: 'codex', search: true, model_verbosity: 'low',
      } } }, role: { inline: { mission: 'Direct mission\n' } },
      profile: 'work', launcher: 'codex', search: true,
      codexConfig: { model_verbosity: 'low' }, temp: true,
    } });
    expect(plan.origin).toBe('direct');
    expect(plan.options).toMatchObject({ identity: 'SeparateIdentity', missionFile, isolationFile,
      profile: 'work', launcher: 'codex', search: true,
      codexConfig: { model_verbosity: 'low' } });
    expect(plan.preview.resolvedRole).toMatchObject({ identity: 'SeparateIdentity',
      mission: 'Direct mission\n', harness_options: expect.objectContaining({
        profile: 'work', launcher: 'codex', search: true,
      }) });

    await expect(service.preview({
      name: 'WebInjected', harness: 'codex', session: 'acp', lifetime: 'temporary',
      openAfterCreate: true, permissions: { approval: 'ask', filesystem: 'workspace',
        unattended: 'deny' }, isolationFile,
    } as any)).rejects.toMatchObject({ code: 'invalid_request',
      message: 'unsupported web creation field: harness' });
  });

  it('persists equivalent role state once through direct, managed, and web creation', async () => {
    const root = fixture();
    const configPath = join(root, 'fleet.yaml');
    writeV2Fixture(configPath, 'defaults: { harness: codex, session: acp }\nroles: {}\n');
    let launches = 0;
    const common = { configPath,
      ops: { backend, binPath: '/bin/true', log() {} }, binPath: '/bin/true',
      tempLauncher() { launches++; }, identityProvisioner: { async exists() { return false; } } };
    const direct = new RoleCreationService({ ...common, journal: false });
    await direct.createDirect({ name: 'DirectParity', temp: true,
      brain: { inline: { harness: 'codex' } }, role: { inline: {} },
      approval: 'ask', filesystem: 'workspace', unattended: 'deny',
      monitorConfig: { mode: 'native' } });
    const caller = {
      name: 'TrustedCaller', harness: 'codex', session: 'acp', identity: 'TrustedCaller',
      agentSelections: { brain: { inline: { harness: 'codex' } }, role: { inline: {} } },
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      monitor: { mode: 'native', interrupt: false }, sourceFile: configPath,
    } as any;
    const managedPlan = direct.previewSpawn({ origin: 'managed', caller,
      options: { name: 'ManagedParity', temp: true } });
    expect(managedPlan).toMatchObject({ origin: 'managed', caller: 'TrustedCaller',
      options: { configPath, callerRole: 'TrustedCaller', surface: 'agent' } });
    expect(managedPlan.origin === 'managed' && managedPlan.inherited).toEqual(expect.arrayContaining([
      'brain', 'role', 'coordinator', 'approval', 'filesystem', 'unattended', 'monitorConfig',
    ]));
    const managed = await direct.createManaged(caller, { name: 'ManagedParity', temp: true });
    expect(managed).toMatchObject({ caller: 'TrustedCaller', role: 'ManagedParity',
      lifetime: 'temporary' });
    expect(managed.inherited).toEqual(expect.arrayContaining([
      'brain', 'role', 'coordinator', 'approval', 'filesystem', 'unattended', 'monitorConfig',
    ]));
    const web = new RoleCreationService({ ...common,
      journalDir: join(root, '.ours-fleet', 'web-actions'), probeReady: async () => 'ready' });
    const request = canonicalWeb({ name: 'WebParity', harness: 'codex' as const, session: 'acp' as const,
      lifetime: 'temporary' as const, openAfterCreate: true,
      permissions: { approval: 'ask' as const, filesystem: 'workspace' as const,
        unattended: 'deny' as const }, monitor: { mode: 'native' as const } }) as any;
    const preview = await web.preview(request);
    const action = await web.create(request, preview.previewHash,
      'abcdef0123456789abcdef0123456789', 'browser');
    await vi.waitFor(() => expect(web.get(action.actionId)?.state).toBe('session_reachable'));
    const role = (name: string) => parse(readFileSync(
      join(root, '.ours-fleet', 'tmp', name, 'role.yaml'), 'utf8')) as Record<string, unknown>;
    const directRole = role('DirectParity');
    const managedRole = role('ManagedParity');
    const webRole = role('WebParity');
    for (const key of ['harness', 'session', 'permissions', 'monitor']) {
      expect(webRole[key]).toEqual(directRole[key]);
      expect(managedRole[key]).toEqual(directRole[key]);
    }
    expect(launches).toBe(3);
  });
});
