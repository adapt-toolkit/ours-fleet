import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleRepository } from '../../src/application/role-repository.js';
import { FleetError, normalizeError } from '../../src/application/errors.js';
import { roleCapabilities } from '../../src/application/capabilities.js';
import { RoleCreationService, type AtomicCreationIdentityProvider } from '../../src/application/role-creation-service.js';
import type { SupervisorBackend } from '../../src/supervisor/types.js';
import type { OpsDeps } from '../../src/ops.js';
import { SessionControlError } from '../../src/session/types.js';

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

describe('Phase 0 application services', () => {
  it('unions configured, permanent, temporary, orphan, and corrupt state without secrets', async () => {
    const root = fixture();
    writeFileSync(join(root, 'fleet.yaml'), `
roles:
  ConfigOnly:
    session: acp
    env: { SECRET: never-return-this }
  Permanent:
    session: tmux
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
      probeBackend: async (_name, intended) => ({
        acp: intended === 'acp', tmux: intended === 'tmux',
      }),
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
      configuredBackend: 'tmux', detectedBackend: 'tmux',
      compatibility: { compatible: true }, problems: [],
    }, {
      roleId: 'A', observedAt: new Date().toISOString(), overall: 'ready',
      supervisor: { backend: 'none', liveness: 'running', detail: 'running' },
      session: { backend: 'tmux', reachability: 'online', readiness: 'idle', evidence: 'inferred' },
      restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
      monitor: { mode: 'unknown', health: 'unknown', stale: true },
      isolation: { degraded: false }, problems: [],
    }, { terminalPtyAvailable: false });
    expect(caps.input.text).toBe(true);
    expect(caps.terminal).toMatchObject({ available: false, reason: 'pty_unavailable' });
  });

  it('previews and executes one idempotent typed permanent creation', async () => {
    const root = fixture();
    writeFileSync(join(root, 'fleet.yaml'), 'defaults: { harness: codex, session: acp }\nroles: {}\n');
    const reservations = new Set<string>();
    const identities = new Set<string>();
    const provider: AtomicCreationIdentityProvider = {
      async capability() { return { available: true, version: 1 }; },
      async reserve(name) {
        if (reservations.has(name)) return false;
        reservations.add(name); return true;
      },
      async release(name) { reservations.delete(name); },
      async exists(name) { return identities.has(name); },
      async create(name) { identities.add(name); },
      async remove(name) { identities.delete(name); },
    };
    const ops: OpsDeps = { backend, binPath: '/bin/true', log() {} };
    const service = new RoleCreationService({
      configPath: join(root, 'fleet.yaml'), ops, binPath: '/bin/true',
      identityProvider: provider, allowedCwdRoots: [root],
      journalDir: join(root, '.ours-fleet', 'web-actions'),
      probeReady: async () => 'ready',
    });
    const request = {
      name: 'Created', harness: 'codex' as const, session: 'acp' as const,
      lifetime: 'permanent' as const, openAfterCreate: true,
      permissions: { approval: 'ask' as const, filesystem: 'workspace' as const, unattended: 'deny' as const },
    };
    const preview = await service.preview(request);
    const first = await service.create(request, preview.previewHash, '0123456789abcdef0123456789abcdef', 'browser');
    const duplicate = await service.create(request, preview.previewHash, '0123456789abcdef0123456789abcdef', 'browser');
    expect(duplicate.actionId).toBe(first.actionId);
    for (let i = 0; i < 50 && service.get(first.actionId)?.state !== 'ready'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.get(first.actionId)).toMatchObject({
      state: 'ready', openPath: '/roles/Created/activity',
    });
    expect(identities.has('Created')).toBe(true);
    await expect(service.create(
      { ...request, mission: 'different' }, preview.previewHash,
      '0123456789abcdef0123456789abcdef', 'browser',
    )).rejects.toBeInstanceOf(FleetError);
  });
});
