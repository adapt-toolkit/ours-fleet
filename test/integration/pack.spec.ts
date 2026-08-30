/**
 * The published tarball must carry its own provenance.
 *
 * `dist/` is gitignored, so a clean checkout has none. If packing does not build
 * first, `npm pack` succeeds and ships a package whose `bin` target does not
 * exist — and, once build provenance matters, one with no build-info.json, which
 * is exactly the "unknown build" an installed artifact must never be.
 *
 * These tests pack a copy of the working tree with dist/ absent, so they prove
 * the contract rather than the state of this developer's machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REPO = resolve('.');
const SKIP_COPY = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report']);

let clean: string;
let packed: string;
let entries: string[];

beforeAll(async () => {
  clean = mkdtempSync(join(tmpdir(), 'ours-fleet-pack-'));
  const root = join(clean, 'checkout');
  cpSync(REPO, root, {
    recursive: true,
    dereference: false,
    filter: source => !SKIP_COPY.has(source.slice(REPO.length + 1).split('/')[0]),
  });
  expect(existsSync(join(root, 'dist'))).toBe(false);
  // Dependencies are the one thing a clean checkout gets from `npm ci`; linking
  // them keeps this test about the pack contract, not about npm's registry.
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));

  const out = join(clean, 'out');
  mkdirSync(out, { recursive: true });
  await run('npm', ['pack', '--pack-destination', out], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const tarball = readdirSync(out).find(name => name.endsWith('.tgz'));
  if (!tarball) throw new Error(`npm pack produced no tarball: ${readdirSync(out).join(', ')}`);
  packed = join(out, tarball);
  const listed = await run('tar', ['-tzf', packed], { maxBuffer: 32 * 1024 * 1024 });
  entries = listed.stdout.split('\n').filter(Boolean).map(line => line.replace(/^package\//, ''));
}, 300_000);

afterAll(() => rmSync(clean, { recursive: true, force: true }));

describe('npm pack from a checkout with no dist', () => {
  it('ships the executable the package.json bin field points at', () => {
    const bin = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).bin as Record<string, string>;
    for (const target of Object.values(bin)) expect(entries).toContain(target);
  });

  it('ships the build stamp, so an installed artifact is never an unknown build', () => {
    expect(entries).toContain('dist/build-info.json');
  });

  it('ships the compiled capability declaration the stamp is read from', () => {
    expect(entries).toContain('dist/capabilities.js');
  });

  it('ships the web console assets the CLI serves', () => {
    expect(entries.some(name => name.startsWith('dist/web-app/'))).toBe(true);
  });

  it('ships the complete split default configuration referenced by init', () => {
    for (const path of [
      'examples/fleet.yaml',
      'examples/fleet/agents/Alice.yaml',
      'examples/fleet/agents/FleetCoordinator.yaml',
      'examples/fleet/roles/developer.yaml',
      'examples/fleet/roles/coordinator.yaml',
      'examples/fleet/brains/claude-default.yaml',
    ]) expect(entries).toContain(path);
  });

  // What the nightly channel exists to deliver. A tarball that packs and stamps
  // correctly but ships the old transport would publish green and be wrong.
  it('ships the SDK-backed owner-channel client and not the removed MCP transport', () => {
    expect(entries).toContain('dist/owner-channel/ours-client.js');
    expect(entries).toContain('dist/owner-channel/channel.js');
    expect(entries).not.toContain('dist/owner-channel/mcp.js');
  });

  it('declares the pinned ours SDK and structured CLI', async () => {
    const shipped = await run('tar', ['-xzOf', packed, 'package/package.json'],
      { maxBuffer: 32 * 1024 * 1024 });
    const pkg = JSON.parse(shipped.stdout) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@ours.network/sdk']).toBe('3.0.1');
    expect(pkg.dependencies['@ours.network/cli']).toBe('1.0.1');
  });

  it('leaks no environment file, tarball, or node_modules into the package', () => {
    expect(entries.filter(name => name.startsWith('node_modules/'))).toEqual([]);
    expect(entries).not.toContain('.env');
    expect(entries.filter(name => name.endsWith('.tgz'))).toEqual([]);
  });
});
