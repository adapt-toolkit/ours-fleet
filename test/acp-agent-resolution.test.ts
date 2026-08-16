import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBundledAcpAgent } from '../src/harness/acp-agent.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ours-acp-resolution-'));
  roots.push(root);
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
});
