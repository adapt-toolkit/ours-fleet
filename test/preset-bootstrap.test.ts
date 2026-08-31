import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapPresets } from '../src/preset-bootstrap.js';
import { loadConfig } from '../src/config.js';
import { listTemplates } from '../src/rooms-tasks/templates.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ours-fleet-presets-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('packaged preset bootstrap', () => {
  it('materializes a complete resolvable standard configuration at an explicit root', () => {
    const configPath = join(root, 'alternate.yaml');
    const seeded = bootstrapPresets(configPath);
    expect(seeded.revision).toBe(1);
    expect(seeded.created).toHaveLength(17);
    const cfg = loadConfig(configPath);
    expect(listTemplates(cfg.roomTemplates ?? {}).map(template => template.name))
      .toEqual(['pair', 'single', 'team']);
    expect(cfg.sourceDocuments?.filter(source => source.kind === 'RoomTemplate'))
      .toHaveLength(3);
    for (const template of listTemplates(cfg.roomTemplates ?? {})) {
      expect(template.sourceFile).toBe(join(root, 'alternate', 'room_templates', `${template.name}.yaml`));
      for (const member of template.members) {
        expect('ref' in member.agent).toBe(true);
        if (!('ref' in member.agent)) continue;
        const definition = cfg.agentDefinitions?.[member.agent.ref];
        expect(definition, `${template.name}:${member.agent.ref}`).toBeDefined();
        expect(definition?.role).toEqual({ ref: member.role });
        expect(definition?.brain).toEqual({ ref: 'claude-default' });
        expect(definition?.permissions).toMatchObject({ approval: 'ask', unattended: 'deny' });
      }
    }
  });

  it('is repeatable and preserves edited and partial trees byte-for-byte', () => {
    const configPath = join(root, 'fleet.yaml');
    bootstrapPresets(configPath);
    const role = join(root, 'fleet', 'roles', 'Agent.yaml');
    writeFileSync(role, 'mission: my edited contract\n', { mode: 0o600 });
    rmSync(join(root, 'fleet', 'roles', 'Tester.yaml'));
    const second = bootstrapPresets(configPath);
    expect(readFileSync(role, 'utf8')).toBe('mission: my edited contract\n');
    expect(existsSync(join(root, 'fleet', 'roles', 'Tester.yaml'))).toBe(true);
    expect(second.created).toEqual([join(root, 'fleet', 'roles', 'Tester.yaml')]);
    expect(second.preserved).toHaveLength(16);
  });

  it('creates private files and refuses symlink targets', () => {
    const configPath = join(root, 'fleet.yaml');
    bootstrapPresets(configPath);
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    const unsafe = join(root, 'unsafe.yaml');
    symlinkSync(configPath, unsafe);
    expect(() => bootstrapPresets(unsafe)).toThrow(/refuses symlink target/);
  });

  it('refuses an untrusted existing split root', () => {
    const configPath = join(root, 'unsafe.yaml');
    writeFileSync(configPath, 'user bytes\n', { mode: 0o600 });
    mkdirSync(join(root, 'unsafe'), { mode: 0o777 });
    chmodSync(join(root, 'unsafe'), 0o777);
    expect(() => bootstrapPresets(configPath)).toThrow(/group\/world-writable target/);
    expect(readFileSync(configPath, 'utf8')).toBe('user bytes\n');
  });
});
