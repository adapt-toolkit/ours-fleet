import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The built CLI refuses an unpatched Node.js before any command runs.
const cli = (version: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-node-floor-'));
  try {
    const preload = join(dir, 'version.cjs');
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
    return spawnSync(process.execPath, ['--require', preload, resolve('dist/cli.js'), '--version'], { encoding: 'utf8', env: { ...process.env, OURS_FLEET_HOME: dir }, timeout: 20_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

it.each(['22.23.2', '24.22.0', '26.12.0', '20.20.2', '25.9.0', '27.0.0-pre'])('the CLI refuses Node.js %s with the advisory', version => {
  const result = cli(version);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`Node.js ${version} is not permitted`);
  expect(result.stderr).toContain('https://nodejs.org/en/blog/vulnerability/october-2026-security-releases');
  expect(result.stderr).not.toMatch(/\n\s+at /);
}, 30_000);

it('the CLI runs on a patched Node.js', () => {
  const result = cli('22.23.4');
  expect(result.stderr).not.toContain('is not permitted');
  expect(result.status).toBe(0);
}, 30_000);
