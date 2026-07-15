import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(process.cwd(), 'integrations/codex/ours-fleet');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('@ours.network/fleet-codex package', () => {
  it('ships a version-synchronized native plugin and both skills', () => {
    const pkg = JSON.parse(read('package.json'));
    const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
    expect(pkg.name).toBe('@ours.network/fleet-codex');
    expect(manifest.name).toBe('ours-fleet');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.skills).toBe('./skills/');

    for (const name of ['spawn-ours-agent', 'oversee-agents']) {
      const skill = read(`skills/${name}/SKILL.md`);
      expect(skill).toContain(`name: ${name}`);
      expect(skill).not.toContain('[TODO:');
      expect(read(`skills/${name}/agents/openai.yaml`)).toContain(`$${name}`);
    }
  });

  it('packages the manifest, installer, skills, and UI metadata', () => {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8',
    }))[0];
    const files = new Set(packed.files.map((file: { path: string }) => file.path));
    for (const path of [
      '.codex-plugin/plugin.json',
      'bin/ours-fleet-codex-install.mjs',
      'skills/spawn-ours-agent/SKILL.md',
      'skills/spawn-ours-agent/agents/openai.yaml',
      'skills/oversee-agents/SKILL.md',
      'skills/oversee-agents/agents/openai.yaml',
      'README.md',
      'LICENSE',
    ]) expect(files.has(path), path).toBe(true);
  });

  it('installer wires the CLI, ours runtime, and shared Codex marketplace', () => {
    const installer = read('bin/ours-fleet-codex-install.mjs');
    expect(installer).toContain('@ours.network/fleet');
    expect(installer).toContain('@ours.network/codex');
    expect(installer).toContain('ours-codex-install');
    expect(installer).toContain('adapt-toolkit/ours-codex-marketplace');
    expect(installer).toContain('ours-fleet@ours-codex-marketplace');
  });
});
