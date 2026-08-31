import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
  statSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateLegacyStarterPresets } from '../src/preset-migration.js';
import { splitRootFor } from '../src/config.js';

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
