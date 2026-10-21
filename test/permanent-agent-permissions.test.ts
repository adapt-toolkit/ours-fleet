import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-agent-permissions-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('permanent Agent creation and private update checks', () => {
  it.each([0o000, 0o002, 0o022, 0o077])('keeps a created Agent updateable under umask %i', mask => {
    // A child owns its umask; changing it in a Vitest worker would affect
    // unrelated fixtures (and is unsupported by Node worker threads).
    const dist = pathToFileURL(resolve('dist') + '/').href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { chmodSync, readFileSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      import { writeRoleFile } from ${JSON.stringify(dist + 'creation.js')};
      import { bootstrapPresets } from ${JSON.stringify(dist + 'preset-bootstrap.js')};
      import { loadConfig, splitRootFor } from ${JSON.stringify(dist + 'config.js')};
      import { preflightInitPaths } from ${JSON.stringify(dist + 'init-wizard.js')};
      import { migratePackagedRoleDefaults } from ${JSON.stringify(dist + 'preset-migration.js')};
      await import(${JSON.stringify(dist + 'harness/codex.js')});
      await import(${JSON.stringify(dist + 'harness/claude-code.js')});

      process.umask(${mask});
      const manifest = join(${JSON.stringify(root)}, 'fleet.yaml');
      bootstrapPresets(manifest);
      const file = join(splitRootFor(manifest), 'agents', 'Custom.yaml');
      const contents = 'brain: { inline: { harness: codex } }\\nrole: { inline: { mission: synthetic custom agent } }\\n';
      writeRoleFile({ record() {} }, file, contents);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(readFileSync(file, 'utf8'), contents);
      assert.ok(loadConfig(manifest).roles.some(role => role.name === 'Custom'));
      preflightInitPaths(manifest);
      assert.equal(migratePackagedRoleDefaults(manifest).write, false);
      assert.equal(readFileSync(file, 'utf8'), contents);

      // Preserve the update guard: readable-by-others files still load, but
      // private-tree operations must reject them without altering contents.
      chmodSync(file, 0o644);
      loadConfig(manifest);
      assert.throws(() => preflightInitPaths(manifest), /init requires owner-private mode/);
      assert.throws(() => migratePackagedRoleDefaults(manifest), /migration requires owner-private/);
      assert.equal(readFileSync(file, 'utf8'), contents);
    `], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OURS_FLEET_HOME: root } });
    expect({ status: child.status, error: child.error?.message, stderr: child.stderr })
      .toEqual({ status: 0, error: undefined, stderr: '' });
  });
});
