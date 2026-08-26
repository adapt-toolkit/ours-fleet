import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyConfigGraphTransaction, ConfigGraphSimulatedCrash, ConfigGraphTransactionCleanupError,
  ConfigGraphTransactionError,
  loadConsistentConfigResourceSnapshot, recoverConfigGraphTransaction,
} from '../src/config-graph-transaction.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';

let root: string;
let bootstrap: string;
let configDir: string;

const role = (id: string, mission = 'work') => `
kind: Role
version: 1
id: ${id}
spec: {mission: ${mission}}
`;

const write = (relative: string, contents: string): string => {
  const path = join(configDir, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-graph-transaction-'));
  bootstrap = join(root, 'fleet.yaml');
  configDir = join(root, 'fleet.conf.d');
  mkdirSync(configDir);
  writeFileSync(bootstrap, 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('journaled configuration graph transaction', () => {
  it('atomically creates, replaces, deletes, and updates bootstrap policy', async () => {
    write('roles.d/old.yaml', role('Old'));
    write('roles.d/change.yaml', role('Change', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    const after = await applyConfigGraphTransaction({
      bootstrapFile: bootstrap,
      expectedDigest: before.digest,
      mutations: [
        { target: { scope: 'resource', directory: 'roles.d', basename: 'old.yaml' }, contents: null },
        { target: { scope: 'resource', directory: 'roles.d', basename: 'change.yaml' }, contents: Buffer.from(role('Change', 'after')) },
        { target: { scope: 'resource', directory: 'roles.d', basename: 'new.yaml' }, contents: Buffer.from(role('New')) },
        { target: { scope: 'bootstrap' }, contents: Buffer.from('schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {mode: test}\n') },
      ],
    });
    expect(after.resources.Role).toMatchObject({ Change: { id: 'Change' }, New: { id: 'New' } });
    expect(after.resources.Role?.Old).toBeUndefined();
    expect(readFileSync(bootstrap, 'utf8')).toContain('mode: test');
    expect(existsSync(`${bootstrap}.graph-journal.json`)).toBe(false);
    expect(readFileSync(join(configDir, 'roles.d', 'change.yaml'), 'utf8')).toContain('after');
    expect((await loadConsistentConfigResourceSnapshot({ bootstrapFile: bootstrap })).digest)
      .toBe(after.digest);
  });

  it('rejects stale revisions and referential deletion before publishing artifacts', async () => {
    write('roles.d/a.yaml', role('A'));
    write('room-templates.d/a.yaml', `
kind: RoomTemplate
version: 1
id: a
spec: {version: 1, description: a, members: [{slot: a, role: A, count: 1}]}
`);
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: 'sha256:'.padEnd(71, '0'),
      mutations: [{ target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: null }],
    })).rejects.toThrow(/stale configuration digest/u);
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{ target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: null }],
    })).rejects.toThrow(/unknown Role 'A'/u);
    expect(existsSync(`${bootstrap}.graph-journal.json`)).toBe(false);
  });

  it('uses an independent backup when an open descriptor mutates the old inode', async () => {
    const path = write('roles.d/a.yaml', role('A', 'before'));
    const fd = openSync(path, 'r+');
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    let mutated = false;
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: { checkpoint: name => {
        if (name === 'backup_fsynced:0' && !mutated) {
          mutated = true;
          writeSync(fd, Buffer.from('CORRUPT'), 0, 7, 0);
        }
      } },
    })).rejects.toThrow(/changed before visible mutation/u);
    closeSync(fd);
    const backupName = readdirSync(join(configDir, 'roles.d')).find(name => name.endsWith('.backup'))!;
    expect(readFileSync(join(configDir, 'roles.d', backupName), 'utf8')).toContain('before');
    writeFileSync(path, role('A', 'before'));
    await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
    const after = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    expect(after.resources.Role?.A).toMatchObject({ spec: { mission: 'after' } });
    expect(readFileSync(path, 'utf8')).toContain('after');
  });

  it('keeps deletion rollback bytes independent from an open old-inode descriptor', async () => {
    const path = write('roles.d/a.yaml', role('A', 'before'));
    const fd = openSync(path, 'r+');
    const beforeBytes = readFileSync(path);
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: null,
      }],
      deps: { checkpoint: name => {
        if (name === 'backup_fsynced:0') writeSync(fd, Buffer.from('CORRUPT'), 0, 7, 0);
      } },
    })).rejects.toThrow(/changed before visible mutation/u);
    closeSync(fd);
    const backup = readdirSync(join(configDir, 'roles.d')).find(name => name.endsWith('.backup'))!;
    expect(readFileSync(join(configDir, 'roles.d', backup))).toEqual(beforeBytes);
    writeFileSync(path, beforeBytes);
    await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
    expect(existsSync(path)).toBe(false);
  });

  it('cleans stale pre-journal owner artifacts without touching visible files', async () => {
    write('roles.d/a.yaml', role('A'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: {
        now: () => 0, processId: () => 900, processFingerprint: () => 'old',
        checkpoint: name => { if (name === 'backup_fsynced:0') throw new Error('simulated crash'); },
      },
    })).rejects.toThrow(/simulated crash/u);
    expect(readFileSync(join(configDir, 'roles.d', 'a.yaml'), 'utf8')).toContain('work');
    await recoverConfigGraphTransaction({
      bootstrapFile: bootstrap,
      deps: { now: () => 40_000, processState: () => 'dead' },
    });
    expect(readFileSync(join(configDir, 'roles.d', 'a.yaml'), 'utf8')).toContain('work');
    expect(readdirSync(root).filter(name => name.includes('graph-owner'))).toEqual([]);
    expect(readdirSync(join(configDir, 'roles.d')).filter(name => name.includes('.fleet-txn.'))).toEqual([]);
  });

  it('removes an empty target directory created only for stale pre-journal staging', async () => {
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A')),
      }],
      deps: {
        now: () => 0, processId: () => 901, processFingerprint: () => 'old',
        checkpoint: name => { if (name === 'stage_fsynced:0') throw new ConfigGraphSimulatedCrash('crash'); },
      },
    })).rejects.toThrow(/crash/u);
    expect(existsSync(join(configDir, 'roles.d'))).toBe(true);
    await recoverConfigGraphTransaction({
      bootstrapFile: bootstrap, deps: { now: () => 31_000, processState: () => 'dead' },
    });
    expect(existsSync(join(configDir, 'roles.d'))).toBe(false);
  });

  it('rejects invalid target paths and duplicate mutations', async () => {
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: '../escape.yaml' },
        contents: Buffer.from(role('A')),
      }],
    })).rejects.toBeInstanceOf(ConfigGraphTransactionError);
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [
        { target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: Buffer.from(role('A')) },
        { target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: Buffer.from(role('B')) },
      ],
    })).rejects.toThrow(/duplicate mutation target/u);
  });

  it.each([
    'journal_publication_linked', 'journal_publication_directory_fsynced', 'journal_prepared',
    'journal_installing_replace_temp_fsynced', 'journal_installing_replaced',
    'journal_installing_replace_directory_fsynced', 'journal_installing',
    'visible_renamed:0', 'visible_installed:0',
    'journal_installed_replace_temp_fsynced', 'journal_installed_replaced',
    'journal_installed_replace_directory_fsynced',
    'journal_committed_replace_temp_fsynced', 'journal_committed_replaced',
    'journal_committed_replace_directory_fsynced', 'journal_committed',
    'cleanup_entry:roles.d/a.yaml', 'cleanup_owner', 'cleanup_directories_fsynced',
    'cleanup_journal_removed',
  ])('recovers idempotently from crash checkpoint %s', async checkpoint => {
    const path = write('roles.d/a.yaml', role('A', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    let crashed = false;
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: { checkpoint: name => {
        if (name === checkpoint && !crashed) {
          crashed = true; throw new ConfigGraphSimulatedCrash(`crash:${checkpoint}`);
        }
      } },
    })).rejects.toThrow(`crash:${checkpoint}`);
    expect(crashed).toBe(true);
    await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
    await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
    expect(readFileSync(path, 'utf8')).toContain('after');
    expect(existsSync(`${bootstrap}.graph-journal.json`)).toBe(false);
  });

  it.each([
    'owner_publication_temp_fsynced', 'owner_publication_linked', 'owner_published',
    'stage_file_fsynced:0', 'stage_fsynced:0', 'backup_file_fsynced:0', 'backup_fsynced:0',
    'journal_publication_temp_fsynced',
  ])(
    'cleans pre-journal crash artifacts at %s only after dead-owner staleness', async checkpoint => {
      const path = write('roles.d/a.yaml', role('A', 'before'));
      write('roles.d/b.yaml', role('B', 'before'));
      const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
      await expect(applyConfigGraphTransaction({
        bootstrapFile: bootstrap, expectedDigest: before.digest,
        mutations: [
          { target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: Buffer.from(role('A', 'after')) },
          { target: { scope: 'resource', directory: 'roles.d', basename: 'b.yaml' }, contents: Buffer.from(role('B', 'after')) },
        ],
        deps: {
          now: () => 0, processId: () => 950, processFingerprint: () => 'old-birth',
          checkpoint: name => {
            if (name === checkpoint) throw new ConfigGraphSimulatedCrash(`crash:${checkpoint}`);
          },
        },
      })).rejects.toThrow(`crash:${checkpoint}`);
      await recoverConfigGraphTransaction({
        bootstrapFile: bootstrap, deps: { now: () => 20_000, processState: () => 'dead' },
      });
      expect(readdirSync(root).some(name => name.includes('graph-owner'))).toBe(true);
      await recoverConfigGraphTransaction({
        bootstrapFile: bootstrap, deps: { now: () => 31_000, processState: () => 'dead' },
      });
      expect(readdirSync(root).some(name => name.includes('graph-owner'))).toBe(false);
      expect(readdirSync(join(configDir, 'roles.d')).some(name => name.includes('.fleet-txn.'))).toBe(false);
      expect(readFileSync(path, 'utf8')).toContain('before');
    },
  );

  it.each([
    'owner_publication_linked', 'owner_published', 'stage_file_fsynced:0',
    'stage_fsynced:0', 'backup_file_fsynced:0', 'backup_fsynced:0',
    'journal_publication_temp_fsynced',
  ])('immediately unwinds ordinary pre-journal failure at %s and permits retry', async fault => {
    const path = write('roles.d/a.yaml', role('A', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: { checkpoint: name => { if (name === fault) throw new Error(`ordinary:${fault}`); } },
    })).rejects.toThrow(`ordinary:${fault}`);
    expect(readFileSync(path, 'utf8')).toContain('before');
    expect(readdirSync(root).filter(name => name.includes('graph-owner'))).toEqual([]);
    expect(readdirSync(root).filter(name => name.includes('graph-journal'))).toEqual([]);
    expect(readdirSync(join(configDir, 'roles.d')).filter(name => name.includes('.fleet-txn.'))).toEqual([]);

    const after = await applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
    });
    expect(after.resources.Role?.A).toMatchObject({ spec: { mission: 'after' } });
    expect(readdirSync(root).filter(name => name.includes('graph-owner')
      || name.includes('graph-journal'))).toEqual([]);
    expect(readdirSync(join(configDir, 'roles.d')).filter(name => name.includes('.fleet-txn.'))).toEqual([]);
  });

  it('fails closed with primary error and retained evidence when pre-journal cleanup fails', async () => {
    write('roles.d/a.yaml', role('A', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    let failure: unknown;
    try {
      await applyConfigGraphTransaction({
        bootstrapFile: bootstrap, expectedDigest: before.digest,
        mutations: [{
          target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
          contents: Buffer.from(role('A', 'after')),
        }],
        deps: { checkpoint: name => {
          if (name === 'stage_fsynced:0') throw new Error('primary fault');
          if (name === 'prejournal_cleanup_start') throw new Error('cleanup fault');
        } },
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigGraphTransactionCleanupError);
    expect((failure as ConfigGraphTransactionCleanupError).primaryError).toMatchObject({ message: 'primary fault' });
    expect((failure as ConfigGraphTransactionCleanupError).message).toMatch(/retained evidence/u);
    expect((failure as ConfigGraphTransactionCleanupError).retainedPaths.length).toBeGreaterThan(0);
    expect(readdirSync(root).some(name => name.includes('graph-owner'))).toBe(true);
  });

  it('persists one rollback direction when forward evidence is missing', async () => {
    const path = write('roles.d/a.yaml', role('A', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: { checkpoint: name => {
        if (name === 'journal_prepared') throw new ConfigGraphSimulatedCrash('crash');
      } },
    })).rejects.toThrow(/crash/u);
    const journal = JSON.parse(readFileSync(`${bootstrap}.graph-journal.json`, 'utf8')) as {
      entries: Array<{ stageBasename: string }>;
    };
    rmSync(join(configDir, 'roles.d', journal.entries[0].stageBasename));
    await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
    expect(readFileSync(path, 'utf8')).toContain('before');
    expect(existsSync(`${bootstrap}.graph-journal.json`)).toBe(false);
  });

  it.each([
    'recovery_direction_replace_temp_fsynced', 'recovery_direction_replaced',
    'recovery_direction_replace_directory_fsynced',
    'rollback_restore_fsynced:0', 'rollback_renamed:0', 'rollback_installed:0',
  ])(
    'resumes the persisted rollback after crash checkpoint %s', async rollbackCheckpoint => {
      const path = write('roles.d/a.yaml', role('A', 'before'));
      write('roles.d/b.yaml', role('B', 'before'));
      const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
      await expect(applyConfigGraphTransaction({
        bootstrapFile: bootstrap, expectedDigest: before.digest,
        mutations: [
          { target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: Buffer.from(role('A', 'after')) },
          { target: { scope: 'resource', directory: 'roles.d', basename: 'b.yaml' }, contents: Buffer.from(role('B', 'after')) },
        ],
        deps: { checkpoint: name => {
          if (name === 'journal_prepared') throw new ConfigGraphSimulatedCrash('initial crash');
        } },
      })).rejects.toThrow(/initial crash/u);
      const journal = JSON.parse(readFileSync(`${bootstrap}.graph-journal.json`, 'utf8')) as {
        entries: Array<{ stageBasename: string }>;
      };
      rmSync(join(configDir, 'roles.d', journal.entries[1].stageBasename));
      writeFileSync(path, role('A', 'after'));
      let crashed = false;
      await expect(recoverConfigGraphTransaction({
        bootstrapFile: bootstrap,
        deps: { checkpoint: name => {
          if (name === rollbackCheckpoint && !crashed) {
            crashed = true; throw new ConfigGraphSimulatedCrash(`crash:${rollbackCheckpoint}`);
          }
        } },
      })).rejects.toThrow(`crash:${rollbackCheckpoint}`);
      await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
      expect(readFileSync(path, 'utf8')).toContain('before');
      expect(existsSync(`${bootstrap}.graph-journal.json`)).toBe(false);
    },
  );

  it('fails closed without deleting evidence when neither whole direction is provable', async () => {
    const path = write('roles.d/a.yaml', role('A', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: { checkpoint: name => {
        if (name === 'journal_prepared') throw new ConfigGraphSimulatedCrash('crash');
      } },
    })).rejects.toThrow(/crash/u);
    writeFileSync(path, role('A', 'external'));
    await expect(recoverConfigGraphTransaction({ bootstrapFile: bootstrap }))
      .rejects.toThrow(/neither complete forward nor complete rollback/u);
    expect(existsSync(`${bootstrap}.graph-journal.json`)).toBe(true);
    expect(readdirSync(join(configDir, 'roles.d')).some(name => name.endsWith('.backup'))).toBe(true);
  });

  it('accepts a referential delete only with an atomic valid replacement graph', async () => {
    write('roles.d/a.yaml', role('A'));
    write('room-templates.d/pair.yaml', `
kind: RoomTemplate
version: 1
id: pair
spec: {version: 1, description: pair, members: [{slot: one, role: A, count: 1}]}
`);
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    const after = await applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [
        { target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: null },
        { target: { scope: 'resource', directory: 'roles.d', basename: 'b.yaml' }, contents: Buffer.from(role('B')) },
        { target: { scope: 'resource', directory: 'room-templates.d', basename: 'pair.yaml' }, contents: Buffer.from(`
kind: RoomTemplate
version: 1
id: pair
spec: {version: 1, description: pair, members: [{slot: one, role: B, count: 1}]}
`) },
      ],
    });
    expect(after.resources.Role?.A).toBeUndefined();
    expect(after.resources.Role?.B).toMatchObject({ id: 'B' });
  });

  it('recovers one whole mixed create/replace/delete direction after a partial install', async () => {
    const replaced = write('roles.d/m.yaml', role('M', 'before'));
    const deleted = write('roles.d/z.yaml', role('Z'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [
        { target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' }, contents: Buffer.from(role('A')) },
        { target: { scope: 'resource', directory: 'roles.d', basename: 'm.yaml' }, contents: Buffer.from(role('M', 'after')) },
        { target: { scope: 'resource', directory: 'roles.d', basename: 'z.yaml' }, contents: null },
      ],
      deps: { checkpoint: name => {
        if (name === 'visible_installed:0') throw new ConfigGraphSimulatedCrash('mixed crash');
      } },
    })).rejects.toThrow(/mixed crash/u);
    expect(existsSync(join(configDir, 'roles.d', 'a.yaml'))).toBe(true);
    expect(readFileSync(replaced, 'utf8')).toContain('before');
    expect(existsSync(deleted)).toBe(true);
    await recoverConfigGraphTransaction({ bootstrapFile: bootstrap });
    expect(readFileSync(replaced, 'utf8')).toContain('after');
    expect(existsSync(deleted)).toBe(false);
  });

  it('rejects bootstrap config_dir relocation inside a transaction', async () => {
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'bootstrap' },
        contents: Buffer.from('schema_version: 2\nconfig_dir: moved\npolicy: {}\n'),
      }],
    })).rejects.toThrow(/must match the transaction config directory/u);
  });

  it('retains live pre-journal ownership and fails closed on unknown liveness', async () => {
    write('roles.d/a.yaml', role('A'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: {
        now: () => 0, processId: () => 980, processFingerprint: () => 'birth',
        checkpoint: name => { if (name === 'owner_published') throw new ConfigGraphSimulatedCrash('crash'); },
      },
    })).rejects.toThrow(/crash/u);
    await recoverConfigGraphTransaction({
      bootstrapFile: bootstrap, deps: { now: () => 40_000, processState: () => 'same' },
    });
    expect(readdirSync(root).some(name => name.includes('graph-owner'))).toBe(true);
    await expect(recoverConfigGraphTransaction({
      bootstrapFile: bootstrap, deps: { now: () => 40_000, processState: () => 'unknown' },
    })).rejects.toThrow(/owner liveness unknown/u);
    expect(readdirSync(root).some(name => name.includes('graph-owner'))).toBe(true);
  });

  it.each(['malformed', 'oversized', 'permissive', 'symlink'])(
    'fails closed on %s journal evidence without removing it', async kind => {
      const journal = `${bootstrap}.graph-journal.json`;
      if (kind === 'symlink') {
        const outside = join(root, 'outside.json');
        writeFileSync(outside, '{}', { mode: 0o600 });
        symlinkSync(outside, journal);
      } else {
        writeFileSync(journal, kind === 'oversized' ? Buffer.alloc(1024 * 1024 + 1) : '{}', { mode: 0o600 });
        chmodSync(journal, kind === 'permissive' ? 0o644 : 0o600);
      }
      await expect(recoverConfigGraphTransaction({ bootstrapFile: bootstrap }))
        .rejects.toBeInstanceOf(ConfigGraphTransactionError);
      expect(existsSync(journal)).toBe(true);
    },
  );

  it('rejects journal path tampering and symlinked stage evidence', async () => {
    write('roles.d/a.yaml', role('A', 'before'));
    const before = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    await expect(applyConfigGraphTransaction({
      bootstrapFile: bootstrap, expectedDigest: before.digest,
      mutations: [{
        target: { scope: 'resource', directory: 'roles.d', basename: 'a.yaml' },
        contents: Buffer.from(role('A', 'after')),
      }],
      deps: { checkpoint: name => {
        if (name === 'journal_prepared') throw new ConfigGraphSimulatedCrash('crash');
      } },
    })).rejects.toThrow(/crash/u);
    const journalPath = `${bootstrap}.graph-journal.json`;
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ target: { basename: string }; stageBasename: string }>;
    };
    const original = readFileSync(journalPath);
    journal.entries[0].target.basename = '../escape.yaml';
    writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
    await expect(recoverConfigGraphTransaction({ bootstrapFile: bootstrap }))
      .rejects.toThrow(/invalid journal schema/u);
    writeFileSync(journalPath, original, { mode: 0o600 });
    const stage = join(configDir, 'roles.d', journal.entries[0].stageBasename);
    rmSync(stage);
    symlinkSync(join(configDir, 'roles.d', 'a.yaml'), stage);
    await expect(recoverConfigGraphTransaction({ bootstrapFile: bootstrap }))
      .rejects.toThrow(/regular non-symlink file/u);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('fails closed on an unmatched transaction artifact without an owner record', async () => {
    const directory = join(configDir, 'roles.d');
    mkdirSync(directory);
    const artifact = join(directory, '.fleet-txn.deadbeef.0.stage');
    writeFileSync(artifact, role('A'), { mode: 0o600 });
    await expect(recoverConfigGraphTransaction({ bootstrapFile: bootstrap }))
      .rejects.toThrow(/unmatched transaction artifact requires manual repair/u);
    expect(existsSync(artifact)).toBe(true);
  });
});
