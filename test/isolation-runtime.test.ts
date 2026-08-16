import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLaunchRuntime } from '../src/isolation/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'ours-fleet-runtime-home-'));
  roots.push(root);
  return root;
}

function executable(path: string, contents = '#!/bin/sh\nexit 0\n'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

describe('resolveLaunchRuntime', () => {
  it.each([
    '@agentclientprotocol/codex-acp',
    '@agentclientprotocol/claude-agent-acp',
  ])('finds a home-scoped Node interpreter and bundled %s dependency closure', packageName => {
    const home = tempHome();
    const node = join(home, '.hermes/node/bin/node');
    executable(node);
    const modules = join(home, '.local/lib/node_modules/@ours.network/fleet/node_modules');
    const adapter = join(modules, packageName);
    const dependency = join(modules, 'adapter-dependency');
    mkdirSync(join(adapter, 'dist'), { recursive: true });
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(adapter, 'package.json'), JSON.stringify({
      name: packageName, dependencies: { 'adapter-dependency': '1.0.0' },
    }));
    writeFileSync(join(adapter, 'dist/index.js'), 'import "adapter-dependency";\n');
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'adapter-dependency' }));

    const runtime = resolveLaunchRuntime([node, join(adapter, 'dist/index.js')], {
      nodeExecutable: node, path: join(home, '.hermes/node/bin'),
    });

    expect(runtime.argv).toEqual([node, join(adapter, 'dist/index.js')]);
    expect(runtime.readPaths).toEqual(expect.arrayContaining([node, adapter, dependency]));
    expect(runtime.readPaths).not.toContain(home);
    expect(runtime.readPaths.every(path => path.startsWith(home))).toBe(true);
  });

  it.each([
    ['codex', '.codex/packages/standalone/releases/1/bin/codex'],
    ['claude', '.local/share/claude/versions/1'],
  ])('canonicalizes a home-scoped %s tmux launcher and binds only its executable', (command, releasePath) => {
    const home = tempHome();
    const release = join(home, releasePath);
    const launcher = join(home, '.local/bin', command);
    executable(release);
    mkdirSync(join(launcher, '..'), { recursive: true });
    symlinkSync(release, launcher);

    const runtime = resolveLaunchRuntime([command, '--version'], {
      path: join(home, '.local/bin'), nodeExecutable: join(home, '.hermes/node/bin/node'),
    });

    expect(runtime.argv[0]).toBe(release);
    expect(runtime.readPaths).toEqual([release]);
  });
});
