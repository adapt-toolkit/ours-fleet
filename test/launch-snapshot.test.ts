import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLaunchSnapshotLock, readLaunchSnapshot, sealLaunchSnapshot } from '../src/rooms-tasks/launch-snapshot.js';
import { sealTemplateSnapshot, snapshotTemplate } from '../src/rooms-tasks/templates.js';

let root: string;
let previous: string | undefined;
const definitions = {
  Used: { role: { inline: { persona: 'used' } }, brain: { inline: { harness: 'codex' } } },
  Unrelated: { role: { inline: { persona: 'secret-unrelated' } }, brain: { inline: { harness: 'codex' } } },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-launch-snapshot-'));
  previous = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

describe('sealed room launch snapshots', () => {
  it('keeps pure projection side-effect free and seals only referenced templates idempotently', () => {
    const projected = snapshotTemplate({ name: 'one', version: 1, description: 'one',
      members: [{ slot: 'used', role: 'Used', count: 1, agent_template: 'Used' }] }, definitions);
    expect(existsSync(join(root, '.ours-fleet', 'launch-snapshots'))).toBe(false);
    const first = sealTemplateSnapshot(projected, definitions);
    const second = sealTemplateSnapshot(projected, definitions);
    expect(first.launch_snapshot_hash).toBe(second.launch_snapshot_hash);
    expect(Object.keys(readLaunchSnapshot(first.launch_snapshot_hash!))).toEqual(['Used']);
    const dir = join(root, '.ours-fleet', 'launch-snapshots');
    const file = join(dir, `${first.launch_snapshot_hash}.json`);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('secret-unrelated');
  });

  it('fails closed on missing, corrupt, or permission-weakened sealed state', () => {
    const hash = sealLaunchSnapshot({ Used: definitions.Used });
    const file = join(root, '.ours-fleet', 'launch-snapshots', `${hash}.json`);
    writeFileSync(file, '{}\n');
    expect(() => readLaunchSnapshot(hash)).toThrow(/integrity/);
    rmSync(file);
    expect(() => readLaunchSnapshot(hash)).toThrow();
    const restored = sealLaunchSnapshot({ Used: definitions.Used });
    chmodSync(join(root, '.ours-fleet', 'launch-snapshots', `${restored}.json`), 0o644);
    expect(() => readLaunchSnapshot(restored)).toThrow(/unsafe ownership or permissions/);
  });

  it('refuses unsafe directories and corrupt pre-existing content before reuse', () => {
    const dir = join(root, '.ours-fleet', 'launch-snapshots');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    expect(() => sealLaunchSnapshot({ Used: definitions.Used })).toThrow(/unsafe ownership or permissions/);
    rmSync(dir, { recursive: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, dir);
    expect(() => sealLaunchSnapshot({ Used: definitions.Used })).toThrow(/unsafe ownership or permissions/);
    rmSync(dir);
    const hash = sealLaunchSnapshot({ Used: definitions.Used });
    writeFileSync(join(root, '.ours-fleet', 'launch-snapshots', `${hash}.json`), '{}\n');
    expect(() => sealLaunchSnapshot({ Used: definitions.Used })).toThrow(/integrity/);
  });

  it('publishes a complete atomic lock and a stale release cannot delete its successor', () => {
    const lock = join(root, '.ours-fleet', '.launch-snapshot.lock');
    const release = acquireLaunchSnapshotLock({ beforePublish: claim => {
      expect(existsSync(lock)).toBe(false);
      expect(JSON.parse(readFileSync(join(claim, 'owner.json'), 'utf8'))).toMatchObject({
        pid: process.pid, token: expect.any(String),
      });
    } });
    rmSync(lock, { recursive: true });
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'successor' }), { mode: 0o600 });
    release();
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token).toBe('successor');
  });

  it('reclaims a dead holder and sweeps its unreferenced sealed orphan', () => {
    const hash = sealLaunchSnapshot({ Used: definitions.Used });
    const file = join(root, '.ours-fleet', 'launch-snapshots', `${hash}.json`);
    const lock = join(root, '.ours-fleet', '.launch-snapshot.lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, token: 'dead' }), { mode: 0o600 });
    const release = acquireLaunchSnapshotLock();
    expect(existsSync(file)).toBe(false);
    release();
  });
});
