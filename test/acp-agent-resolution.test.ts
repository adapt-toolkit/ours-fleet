import {
  mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  recheckBundledAcpAgent, resolveAuthenticatedBundledAcpAgent, resolveBundledAcpAgent,
} from '../src/harness/acp-agent.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageRoot(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'ours-acp-resolution-'));
  roots.push(sandbox);
  const root = join(sandbox, 'package');
  mkdirSync(root);
  return root;
}

describe('resolveBundledAcpAgent', () => {
  it('fails closed to the PATH command when the package cannot be resolved', () => {
    const missing = join(packageRoot(), 'missing');
    expect(resolveBundledAcpAgent(missing, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it.each([
    ['corrupt manifest', '{not-json'],
    ['missing bin', JSON.stringify({ version: '1.1.7' })],
    ['wrong bin', JSON.stringify({ version: '1.1.7', bin: { other: 'dist/index.js' } })],
  ])('fails closed for a %s', (_label, manifest) => {
    const root = packageRoot();
    writeFileSync(join(root, 'package.json'), manifest);
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it('fails closed when the declared adapter entrypoint is absent', () => {
    const root = packageRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it('fails closed when the declared adapter entrypoint traverses outside the package', () => {
    const root = packageRoot();
    writeFileSync(join(dirname(root), 'outside-agent.js'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': '../outside-agent.js' },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it('fails closed when the declared adapter entrypoint is an absolute path outside the package', () => {
    const root = packageRoot();
    const outside = join(dirname(root), 'absolute-agent.js');
    writeFileSync(outside, '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': outside },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it('fails closed when the declared adapter entrypoint is a directory', () => {
    const root = packageRoot();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist' },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it('fails closed when the declared adapter entrypoint is a symlink outside the package', () => {
    const root = packageRoot();
    const outside = join(dirname(root), 'symlinked-agent.js');
    writeFileSync(outside, '');
    mkdirSync(join(root, 'dist'));
    symlinkSync(outside, join(root, 'dist', 'index.js'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it('returns manifest, version, and node entrypoint for a valid bundle', () => {
    const root = packageRoot();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.js'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: [process.execPath, join(root, 'dist', 'index.js')],
      bundled: true,
      manifestPath: join(root, 'package.json'),
      version: '1.1.7',
    });
  });

  it('authenticates manifest and entrypoint identities without changing legacy resolution', () => {
    const root = packageRoot();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.js'), 'entrypoint');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
    }));
    const resolution = resolveAuthenticatedBundledAcpAgent(root, 'codex-acp', 'codex-acp');
    expect(resolution).toMatchObject({
      argv: [process.execPath, join(root, 'dist', 'index.js')], bundled: true,
      manifestPath: join(root, 'package.json'), entrypointPath: join(root, 'dist', 'index.js'),
      version: '1.1.7',
    });
    expect(isAbsolute(resolution.manifestPath!)).toBe(true);
    expect(isAbsolute(resolution.entrypointPath!)).toBe(true);
    expect(resolution.identity?.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(resolution.identity?.entrypoint.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(recheckBundledAcpAgent(resolution)).toBe(true);
  });

  it('keeps legacy resolution lightweight when authenticated size policy fails closed', () => {
    const root = packageRoot();
    mkdirSync(join(root, 'dist'));
    const entrypoint = join(root, 'dist', 'index.js');
    writeFileSync(entrypoint, '');
    truncateSync(entrypoint, 64 * 1024 * 1024 + 1);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
    }));
    expect(resolveBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toMatchObject({ bundled: true });
    expect(resolveAuthenticatedBundledAcpAgent(root, 'codex-acp', 'codex-acp')).toEqual({
      argv: ['codex-acp'], bundled: false,
    });
  });

  it.each(['manifest', 'entrypoint'] as const)(
    'fails the side-effect-boundary recheck after %s substitution', target => {
      const root = packageRoot();
      mkdirSync(join(root, 'dist'));
      const manifestPath = join(root, 'package.json');
      const entrypointPath = join(root, 'dist', 'index.js');
      writeFileSync(entrypointPath, 'original');
      writeFileSync(manifestPath, JSON.stringify({
        version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
      }));
      const resolution = resolveAuthenticatedBundledAcpAgent(root, 'codex-acp', 'codex-acp');
      expect(resolution.bundled).toBe(true);
      writeFileSync(target === 'manifest' ? manifestPath : entrypointPath, 'substituted-content');
      expect(recheckBundledAcpAgent(resolution)).toBe(false);
    },
  );

  it('pins an in-package symlink to its real entrypoint so later retargeting cannot redirect argv', () => {
    const root = packageRoot();
    mkdirSync(join(root, 'dist'));
    const first = join(root, 'dist', 'first.js');
    const second = join(root, 'dist', 'second.js');
    const link = join(root, 'dist', 'agent.js');
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    symlinkSync(first, link);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/agent.js' },
    }));
    const resolution = resolveAuthenticatedBundledAcpAgent(root, 'codex-acp', 'codex-acp');
    expect(resolution.entrypointPath).toBe(first);
    rmSync(link);
    symlinkSync(second, link);
    expect(resolution.argv[1]).toBe(first);
    expect(recheckBundledAcpAgent(resolution)).toBe(true);
  });

  it('binds bytes and identity to one fd when the manifest path is substituted after open', () => {
    const root = packageRoot();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.js'), 'entrypoint');
    const manifestPath = join(root, 'package.json');
    const openedPath = join(root, 'opened-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      version: '1.1.7', bin: { 'codex-acp': 'dist/index.js' },
    }));
    let swapped = false;
    const resolution = resolveAuthenticatedBundledAcpAgent(root, 'codex-acp', 'codex-acp', {
      afterOpen: path => {
        if (path !== manifestPath || swapped) return;
        swapped = true;
        renameSync(manifestPath, openedPath);
        writeFileSync(manifestPath, JSON.stringify({ version: 'forged', bin: {} }));
      },
    });
    expect(resolution.bundled).toBe(true);
    expect(resolution.version).toBe('1.1.7');
    expect(resolution.identity?.manifest.path).toBe(manifestPath);
    expect(recheckBundledAcpAgent(resolution)).toBe(false);
  });
});
