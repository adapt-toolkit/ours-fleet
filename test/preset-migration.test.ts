import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
  statSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateLegacyStarterPresets, migratePackagedRoleDefaults } from '../src/preset-migration.js';
import { splitRootFor } from '../src/config.js';
import { bootstrapPresets } from '../src/preset-bootstrap.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

const names = ['Agent', 'Architect', 'Critic', 'Developer', 'Secretary', 'Tester'];
let dir: string;
let configPath: string;
let split: string;

function fixture(): void {
  configPath = join(dir, 'fleet.yaml');
  split = splitRootFor(configPath);
  mkdirSync(join(split, 'agents'), { recursive: true, mode: 0o700 });
  chmodSync(split, 0o700); chmodSync(join(split, 'agents'), 0o700);
  writeFileSync(configPath, 'api_version: ours.network/fleet/v2\n', { mode: 0o600 });
  for (const name of names) writeFileSync(join(split, 'agents', `${name}.yaml`),
    `role: { ref: ${name} }\nbrain: { ref: claude-default }\npermissions: { approval: ask, filesystem: workspace, unattended: deny }\n`,
    { mode: 0o600 });
}

function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory()
    ? { mode: stat.mode & 0o777, entries: Object.fromEntries(readdirSync(path).sort()
      .map(name => [name, snapshot(join(path, name))])) }
    : { mode: stat.mode & 0o777, body: readFileSync(path, 'hex') };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-migration-')); fixture(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('legacy starter Agent migration', () => {
  it('is a zero-write dry run by default', () => {
    const before = snapshot(dir);
    const result = migrateLegacyStarterPresets(configPath, {}, { nonce: 'dry' });
    expect(result.write).toBe(false);
    expect(result.moves).toHaveLength(6);
    expect(snapshot(dir)).toEqual(before);
  });

  it('atomically moves only exact starters, preserves custom Agents, and retains backup', () => {
    const custom = join(split, 'agents', 'Custom.yaml');
    writeFileSync(custom, 'role: { inline: { bio: custom } }\n', { mode: 0o600 });
    const timestamp = new Date('2024-01-02T03:04:05.000Z'); utimesSync(custom, timestamp, timestamp);
    const result = migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'success' });
    expect(existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(custom, 'utf8')).toBe('role: { inline: { bio: custom } }\n');
    expect(statSync(custom).mode & 0o777).toBe(0o600);
    expect(statSync(custom).mtime.toISOString()).toBe(timestamp.toISOString());
    expect(existsSync(join(split, 'agents', 'FleetCoordinator.yaml'))).toBe(true);
    for (const name of names) {
      expect(existsSync(join(split, 'agents', `${name}.yaml`))).toBe(false);
      expect(existsSync(join(split, 'agent_templates', `${name}.yaml`))).toBe(true);
    }
  });

  it('accepts semantically exact starters with reordered YAML keys', () => {
    writeFileSync(join(split, 'agents', 'Agent.yaml'),
      'permissions: { unattended: deny, filesystem: workspace, approval: ask }\nrole: { ref: Agent }\nbrain: { ref: claude-default }\n',
      { mode: 0o600 });
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'reordered' }))
      .not.toThrow();
  });

  it('succeeds beneath an owner-controlled 0750 home-style parent', () => {
    chmodSync(dir, 0o750);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'parent-0750' }))
      .not.toThrow();
  });

  it('refuses customized known starters without changing a byte', () => {
    writeFileSync(join(split, 'agents', 'Critic.yaml'), 'role: { ref: Critic }\nbrain: { ref: custom }\n', { mode: 0o600 });
    const before = snapshot(dir);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'custom' }))
      .toThrow(/customized known starter/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses destination collisions and unsafe links without changing a byte', () => {
    mkdirSync(join(split, 'agent_templates'), { mode: 0o700 });
    writeFileSync(join(split, 'agent_templates', 'Agent.yaml'), 'collision\n', { mode: 0o600 });
    const collision = snapshot(dir);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'collision' }))
      .toThrow(/destination collides/);
    expect(snapshot(dir)).toEqual(collision);
    rmSync(join(split, 'agent_templates'), { recursive: true });
    symlinkSync(join(split, 'agents', 'Agent.yaml'), join(split, 'unsafe-link'));
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'link' }))
      .toThrow(/symlink or special file/);
  });

  it('refuses unsafe modes without changing a byte', () => {
    chmodSync(join(split, 'agents', 'Tester.yaml'), 0o640);
    const before = snapshot(dir);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'mode' }))
      .toThrow(/owner-private/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses special files before creating transaction artifacts', () => {
    const fifo = join(split, 'unsafe-fifo');
    const made = spawnSync('mkfifo', [fifo]);
    expect(made.status).toBe(0);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'fifo' }))
      .toThrow(/symlink or special file/);
    expect(existsSync(join(dir, '.fleet.agent-templates-stage-fifo'))).toBe(false);
    expect(existsSync(join(dir, '.fleet.legacy-backup-fifo'))).toBe(false);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  });

  it('refuses lock contention without mutation', () => {
    const lock = join(dir, '.fleet.agent-templates-migration.lock');
    writeFileSync(lock, 'busy\n', { mode: 0o600 });
    const before = snapshot(dir);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, { nonce: 'locked' }))
      .toThrow(/existing staging, backup, or lock/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('leaves the original published when first publication rename fails', () => {
    const before = snapshot(split);
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, {
      nonce: 'first-fail', rename: () => { throw new Error('first rename failed'); },
    })).toThrow(/first rename failed/);
    expect(snapshot(split)).toEqual(before);
    expect(existsSync(join(dir, '.fleet.agent-templates-stage-first-fail'))).toBe(true);
  });

  it('rolls back the original when the second publication rename fails', () => {
    const before = snapshot(split); let calls = 0;
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, {
      nonce: 'second-fail', rename: (from, to) => {
        calls += 1;
        if (calls === 2) throw new Error('second rename failed');
        renameSync(from, to);
      },
    })).toThrow(/second rename failed/);
    expect(snapshot(split)).toEqual(before);
    expect(existsSync(join(dir, '.fleet.agent-templates-stage-second-fail'))).toBe(true);
  });

  it('names manual recovery when publication and rollback both fail', () => {
    let calls = 0;
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, {
      nonce: 'rollback-fail', rename: (from, to) => {
        calls += 1;
        if (calls >= 2) throw new Error(`rename ${calls} failed`);
        renameSync(from, to);
      },
    })).toThrow(/manually recover .*legacy-backup-rollback-fail.* to .*fleet/);
    expect(existsSync(join(dir, '.fleet.legacy-backup-rollback-fail'))).toBe(true);
  });

  it('never removes a replaced foreign lock token', () => {
    const lock = join(dir, '.fleet.agent-templates-migration.lock');
    expect(() => migrateLegacyStarterPresets(configPath, { write: true }, {
      nonce: 'foreign-lock', beforeLockClaim: () => {
        rmSync(lock); writeFileSync(lock, 'foreign-token\n', { mode: 0o600 });
      },
    })).toThrow(/lock changed during atomic release; foreign lock preserved/);
    expect(readFileSync(lock, 'utf8')).toBe('foreign-token\n');
  });
});

describe('packaged role-default adoption', () => {
  it.each([
    ['packaged', 'claude-default'],
    ['generated', 'coordination'],
  ] as const)('adopts the exact revision-4 %s LocalCoordinator and team defaults', (_form, brain) => {
    const config = join(dir, `adopt-v4-${brain}.yaml`);
    bootstrapPresets(config);
    const root = splitRootFor(config);
    writeFileSync(join(root, 'agent_templates', 'LocalCoordinator.yaml'), [
      'role: { ref: LocalCoordinator }',
      `brain: { ref: ${brain} }`,
      'coordinator: FleetCoordinator',
      'permissions: { approval: ask, filesystem: workspace, unattended: deny }',
      '',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(join(root, 'room_templates', 'team.yaml'), [
      'version: 1',
      'description: "Locally coordinated team: LocalCoordinator sequences, Developer executes, Critic reviews"',
      'room: { quiet_membership: false, anonymous: false }',
      'contract: |',
      '  LocalCoordinator coordinates sequencing, handoffs, context, and blockers among existing members.',
      '  Developer owns implementation and verification evidence.',
      '  Critic independently reviews and withholds sign-off on material failures.',
      '  LocalCoordinator has no Fleet lifecycle or agent-management authority.',
      'members:',
      '  - { slot: local_coordinator, role: LocalCoordinator, count: 1, agent_template: LocalCoordinator }',
      '  - { slot: developer, role: Developer, count: 1, agent_template: Developer }',
      '  - { slot: critic, role: Critic, count: 1, agent_template: Critic }',
      '',
    ].join('\n'), { mode: 0o600 });

    const dry = migratePackagedRoleDefaults(config);
    expect(dry.replacements).toContain(join(root, 'agent_templates', 'LocalCoordinator.yaml'));
    expect(dry.replacements).toContain(join(root, 'room_templates', 'team.yaml'));

    const applied = migratePackagedRoleDefaults(config, { write: true }, { nonce: `v4-${brain}` });
    expect(applied.replacements).toEqual(dry.replacements);
    expect(readFileSync(join(root, 'agent_templates', 'LocalCoordinator.yaml'), 'utf8'))
      .toContain('continuity:');
    expect(readFileSync(join(root, 'room_templates', 'team.yaml'), 'utf8'))
      .toMatch(/15-minute continuity/i);
    const rerun = migratePackagedRoleDefaults(config, { write: true }, { nonce: `v5-${brain}` });
    expect(rerun.replacements).toEqual([]);
    expect(existsSync(rerun.backupPath)).toBe(false);
  });

  it('preserves a nearby customized revision-4 LocalCoordinator Agent Template', () => {
    const config = join(dir, 'custom-v4-local.yaml');
    bootstrapPresets(config);
    const root = splitRootFor(config);
    const custom = [
      'role: { ref: LocalCoordinator }',
      'brain: { ref: claude-default }',
      'coordinator: MyCoordinator',
      'permissions: { approval: ask, filesystem: workspace, unattended: deny }',
      '',
    ].join('\n');
    writeFileSync(join(root, 'agent_templates', 'LocalCoordinator.yaml'), custom, { mode: 0o600 });
    const result = migratePackagedRoleDefaults(config);
    expect(result.preserved).toContain(join(root, 'agent_templates', 'LocalCoordinator.yaml'));
    expect(result.replacements).not.toContain(join(root, 'agent_templates', 'LocalCoordinator.yaml'));
    expect(readFileSync(join(root, 'agent_templates', 'LocalCoordinator.yaml'), 'utf8')).toBe(custom);
  });

  it('recognizes the exact generated-v3 brain selections without matching nearby customization', () => {
    const config = join(dir, 'generated-v3.yaml');
    const root = splitRootFor(config);
    mkdirSync(join(root, 'agent_templates'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'agents'), { mode: 0o700 });
    writeFileSync(config, 'api_version: ours.network/fleet/v2\n', { mode: 0o600 });
    const brains: Record<string, string> = {
      Agent: 'development', Architect: 'coordination', Critic: 'review',
      Developer: 'development', Secretary: 'development', Tester: 'review',
    };
    for (const [role, brain] of Object.entries(brains)) writeFileSync(
      join(root, 'agent_templates', `${role}.yaml`),
      `role: { ref: ${role} }\nbrain: { ref: ${brain} }\npermissions: { approval: ask, filesystem: workspace, unattended: deny }\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(root, 'agents', 'FleetCoordinator.yaml'),
      'template: Agent\noverrides: { role: Agent, brain: coordination, coordinator: FleetCoordinator }\n',
      { mode: 0o600 });

    let result = migratePackagedRoleDefaults(config);
    for (const role of ['Agent', 'Architect', 'Secretary', 'Tester'])
      expect(result.removals).toContain(join(root, 'agent_templates', `${role}.yaml`));
    for (const role of ['Critic', 'Developer'])
      expect(result.replacements).toContain(join(root, 'agent_templates', `${role}.yaml`));
    expect(result.replacements).toContain(join(root, 'agents', 'FleetCoordinator.yaml'));

    writeFileSync(join(root, 'agent_templates', 'Critic.yaml'),
      'role: { ref: Critic }\nbrain: { ref: review }\ncoordinator: MyCoordinator\npermissions: { approval: ask, filesystem: workspace, unattended: deny }\n',
      { mode: 0o600 });
    result = migratePackagedRoleDefaults(config);
    expect(result.preserved).toContain(join(root, 'agent_templates', 'Critic.yaml'));
    expect(result.replacements).not.toContain(join(root, 'agent_templates', 'Critic.yaml'));
  });

  it('dry-runs exact defaults while preserving customized same-name files byte-for-byte', () => {
    const config = join(dir, 'adopt.yaml');
    const root = splitRootFor(config);
    mkdirSync(join(root, 'roles'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'agent_templates'), { mode: 0o700 });
    mkdirSync(join(root, 'room_templates'), { mode: 0o700 });
    writeFileSync(config, 'api_version: ours.network/fleet/v2\n', { mode: 0o600 });
    writeFileSync(join(root, 'roles', 'Secretary.yaml'),
      'mission: Implement the agreed solution and maintain the task\'s shared record.\npersona: |\n  Turn agreed decisions into focused code, documentation, and tests. Keep collaborators\n  informed with compact evidence and preserve unrelated state. Pause material work for\n  required review; do not merge, publish, or widen scope without owner authorization.\nbio: Implementing partner and record keeper; engage to deliver reviewed changes.\n', { mode: 0o600 });
    writeFileSync(join(root, 'agent_templates', 'Secretary.yaml'),
      'role: { ref: Secretary }\nbrain: { ref: claude-default }\npermissions: { approval: ask, filesystem: workspace, unattended: deny }\n', { mode: 0o600 });
    const custom = 'version: 7\ndescription: my pair\nroom: {}\nmembers: []\n';
    writeFileSync(join(root, 'room_templates', 'pair.yaml'), custom, { mode: 0o600 });
    const before = snapshot(root);
    const result = migratePackagedRoleDefaults(config, {}, { nonce: 'role-dry' });
    expect(result.write).toBe(false);
    expect(result.removals).toContain(join(root, 'roles', 'Secretary.yaml'));
    expect(result.removals).toContain(join(root, 'agent_templates', 'Secretary.yaml'));
    expect(result.preserved).toContain(join(root, 'room_templates', 'pair.yaml'));
    expect(snapshot(root)).toEqual(before);
  });

  it('atomically removes exact obsolete files, preserves v4/custom files, and reruns as a no-op', () => {
    const config = join(dir, 'write.yaml'); bootstrapPresets(config); const root = splitRootFor(config);
    writeFileSync(join(root, 'roles', 'Secretary.yaml'),
      'mission: Implement the agreed solution and maintain the task\'s shared record.\npersona: |\n  Turn agreed decisions into focused code, documentation, and tests. Keep collaborators\n  informed with compact evidence and preserve unrelated state. Pause material work for\n  required review; do not merge, publish, or widen scope without owner authorization.\nbio: Implementing partner and record keeper; engage to deliver reviewed changes.\n', { mode: 0o600 });
    const custom = 'mission: my local coordinator\n';
    writeFileSync(join(root, 'roles', 'LocalCoordinator.yaml'), custom, { mode: 0o600 });
    const result = migratePackagedRoleDefaults(config, { write: true }, { nonce: 'role-write' });
    expect(existsSync(result.backupPath)).toBe(true);
    expect(existsSync(join(root, 'roles', 'Secretary.yaml'))).toBe(false);
    expect(readFileSync(join(root, 'roles', 'LocalCoordinator.yaml'), 'utf8')).toBe(custom);
    const rerun = migratePackagedRoleDefaults(config, { write: true }, { nonce: 'role-rerun' });
    expect(rerun.removals).toEqual([]); expect(rerun.replacements).toEqual([]);
    expect(rerun.additions).toEqual([]); expect(existsSync(rerun.backupPath)).toBe(false);
  });

  it('refuses publication when a preserved custom template would dangle after removal', () => {
    const config = join(dir, 'dangling.yaml'); bootstrapPresets(config); const root = splitRootFor(config);
    writeFileSync(join(root, 'roles', 'Secretary.yaml'),
      'mission: Implement the agreed solution and maintain the task\'s shared record.\npersona: |\n  Turn agreed decisions into focused code, documentation, and tests. Keep collaborators\n  informed with compact evidence and preserve unrelated state. Pause material work for\n  required review; do not merge, publish, or widen scope without owner authorization.\nbio: Implementing partner and record keeper; engage to deliver reviewed changes.\n', { mode: 0o600 });
    writeFileSync(join(root, 'agent_templates', 'Secretary.yaml'),
      'role: { ref: Secretary }\nbrain: { ref: claude-default }\npermissions: { approval: ask, filesystem: workspace, unattended: deny }\n', { mode: 0o600 });
    writeFileSync(join(root, 'room_templates', 'custom.yaml'),
      'version: 1\ndescription: custom\nroom: {}\nmembers:\n  - { slot: secretary, role: Secretary, count: 1, agent_template: Secretary }\n', { mode: 0o600 });
    const before = snapshot(root);
    expect(() => migratePackagedRoleDefaults(config, { write: true }, { nonce: 'role-dangle' }))
      .toThrow(/staged configuration.*invalid|Agent Template|Role/i);
    expect(snapshot(root)).toEqual(before);
  });

  it('retains named recovery evidence when second publication rename and rollback fail', () => {
    const config = join(dir, 'rollback.yaml'); bootstrapPresets(config); const root = splitRootFor(config);
    writeFileSync(join(root, 'roles', 'Secretary.yaml'),
      'mission: Implement the agreed solution and maintain the task\'s shared record.\npersona: |\n  Turn agreed decisions into focused code, documentation, and tests. Keep collaborators\n  informed with compact evidence and preserve unrelated state. Pause material work for\n  required review; do not merge, publish, or widen scope without owner authorization.\nbio: Implementing partner and record keeper; engage to deliver reviewed changes.\n', { mode: 0o600 });
    let calls = 0;
    expect(() => migratePackagedRoleDefaults(config, { write: true }, {
      nonce: 'role-rollback', rename: (from, to) => {
        calls++; if (calls >= 2) throw new Error(`rename ${calls} failed`); renameSync(from, to);
      },
    })).toThrow(/rollback failed.*role-defaults-backup-role-rollback/i);
    expect(existsSync(join(dir, '.rollback.role-defaults-backup-role-rollback'))).toBe(true);
  });

  it.each(['custom-tree', 'manifest'] as const)(
    'refuses publication and preserves a concurrent %s edit', target => {
    const config = join(dir, `concurrent-${target}.yaml`); bootstrapPresets(config); const root = splitRootFor(config);
    writeFileSync(join(root, 'roles', 'Secretary.yaml'),
      'mission: Implement the agreed solution and maintain the task\'s shared record.\npersona: |\n  Turn agreed decisions into focused code, documentation, and tests. Keep collaborators\n  informed with compact evidence and preserve unrelated state. Pause material work for\n  required review; do not merge, publish, or widen scope without owner authorization.\nbio: Implementing partner and record keeper; engage to deliver reviewed changes.\n',
      { mode: 0o600 });
    const custom = join(root, 'roles', 'MyCustomRole.yaml');
    const originalRole = 'mission: before concurrent edit\n';
    writeFileSync(custom, originalRole, { mode: 0o600 });
    const originalManifest = readFileSync(config, 'utf8');
    const newerRole = 'mission: newer concurrent edit\n';
    const newerManifest = 'api_version: ours.network/fleet/v2\nvars: { concurrent: newer }\n';
    const nonce = `role-concurrent-${target}`;

    expect(() => migratePackagedRoleDefaults(config, { write: true }, {
      nonce, beforeRoleDefaultPublish: () => {
        if (target === 'custom-tree') writeFileSync(custom, newerRole, { mode: 0o600 });
        else writeFileSync(config, newerManifest, { mode: 0o600 });
      },
    })).toThrow(/post-rename verification failed.*live root restored.*staged recovery retained/i);
    expect(readFileSync(custom, 'utf8')).toBe(target === 'custom-tree' ? newerRole : originalRole);
    expect(readFileSync(config, 'utf8')).toBe(target === 'manifest' ? newerManifest : originalManifest);
    expect(existsSync(join(dir, `.concurrent-${target}.role-defaults-stage-${nonce}`))).toBe(true);
    expect(existsSync(join(dir, `.concurrent-${target}.role-defaults-backup-${nonce}`))).toBe(false);
  });

  it('restores the live root when post-rename verification encounters a concurrent symlink', () => {
    const config = join(dir, 'verification-error.yaml'); bootstrapPresets(config); const root = splitRootFor(config);
    writeFileSync(join(root, 'roles', 'Secretary.yaml'),
      'mission: Implement the agreed solution and maintain the task\'s shared record.\npersona: |\n  Turn agreed decisions into focused code, documentation, and tests. Keep collaborators\n  informed with compact evidence and preserve unrelated state. Pause material work for\n  required review; do not merge, publish, or widen scope without owner authorization.\nbio: Implementing partner and record keeper; engage to deliver reviewed changes.\n',
      { mode: 0o600 });
    const custom = join(root, 'roles', 'MyCustomRole.yaml');
    const external = join(dir, 'newer-external-role.yaml');
    writeFileSync(custom, 'mission: old\n', { mode: 0o600 });
    writeFileSync(external, 'mission: newer external\n', { mode: 0o600 });

    expect(() => migratePackagedRoleDefaults(config, { write: true }, {
      nonce: 'role-proof-error', beforeRoleDefaultPublish: () => {
        rmSync(custom); symlinkSync(external, custom);
      },
    })).toThrow(/post-rename verification failed.*live root restored.*symlink or special file/i);
    expect(existsSync(root)).toBe(true);
    expect(lstatSync(custom).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, '.verification-error.role-defaults-stage-role-proof-error'))).toBe(true);
    expect(existsSync(join(dir, '.verification-error.role-defaults-backup-role-proof-error'))).toBe(false);
  });
});
