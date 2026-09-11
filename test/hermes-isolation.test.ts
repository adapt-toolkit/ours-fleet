import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveIsolation } from '../src/isolation/policy.js';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
import { createNativeHermesFixture } from './fixtures/hermes-acp/native-fixture.js';

const enabled = process.env.HERMES_ACP_INTEGRATION === '1' || process.env.HERMES_ACP_INTEGRATION_REQUIRED === '1';
describe.skipIf(!enabled)('Hermes real Fleet workspace isolation', () => {
  it('allows a project write and denies a write to a read-only outside directory', async () => {
    if (process.platform !== 'linux') throw new Error('Required Hermes workspace conformance needs the tested Linux bubblewrap platform');
    const backend = makeBubblewrapBackend();
    const available = await backend.available();
    expect(available.ok, available.detail).toBe(true);
    const fixture = await createNativeHermesFixture();
    try {
      const outside = join(fixture.root, 'outside');
      await mkdir(outside);
      const protectedFile = join(outside, 'protected.txt');
      await writeFile(protectedFile, 'original');
      const stateDir = join(fixture.root, 'fleet', 'Worker');
      await mkdir(stateDir, { recursive: true });
      const context = { stateDir, runCwd: fixture.cwd, home: fixture.userHome, harness: 'hermes', runtimeReadPaths: [fixture.source] };
      const pythonLink = join(fixture.source, 'venv/bin/python');
      const pythonRuntime = dirname(dirname(resolve(dirname(pythonLink), readlinkSync(pythonLink))));
      const policy = resolveIsolation({ backend: 'bubblewrap', on_unavailable: 'strict', network: 'allow', fs: { read: [outside, pythonRuntime], write: [fixture.home] } }, context);
      const child = await fixture.start('fleet-fixture-isolation', argv => backend.wrap(argv, policy, context));
      child.setPermissionAnswer('allow_once');
      const allowed = join(fixture.cwd, 'allowed.txt');
      fixture.callTerminalNext(`printf allowed > '${allowed}'; printf forbidden > '${protectedFile}'`);
      await child.prompt('Perform the deterministic filesystem checks.');
      expect(await readFile(allowed, 'utf8')).toBe('allowed');
      expect(await readFile(protectedFile, 'utf8')).toBe('original');
      expect(child.toolOutput()).toMatch(/Read-only file system|Permission denied/);
    } finally { await fixture.close(); }
  }, 60_000);
});
