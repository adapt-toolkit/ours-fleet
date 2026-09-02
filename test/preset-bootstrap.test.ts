import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapPresets } from '../src/preset-bootstrap.js';
import { loadConfig, validateEffectiveAgentTemplate } from '../src/config.js';
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
    expect(seeded.revision).toBe(6);
    expect(seeded.created).toHaveLength(61);
    const cfg = loadConfig(configPath);
    expect(listTemplates(cfg.roomTemplates ?? {}).map(template => template.name))
      .toEqual(['pair', 'single', 'team']);
    expect(cfg.sourceDocuments?.filter(source => source.kind === 'RoomTemplate'))
      .toHaveLength(3);
    const continuity = cfg.agentTemplates?.LocalCoordinator.loops?.continuity;
    expect(continuity).toMatchObject({ interval: '15m' });
    expect(continuity?.prompt).toMatch(/scheduled_at minus 15 minutes/);
    expect(continuity?.prompt).toMatch(/mandatory final history recheck/);
    expect(continuity?.prompt).toMatch(/CONTINUITY ACTIVE/);
    expect(continuity?.prompt).toMatch(/CONTINUITY CHECK/);
    expect(continuity?.prompt).toMatch(/CONTINUITY STALLED/);
    expect(continuity?.prompt).toMatch(/suppress a semantic duplicate/);
    expect(cfg.agentTemplates?.Developer.loops).toBeUndefined();
    expect(cfg.agentTemplates?.Critic.loops).toBeUndefined();
    for (const template of listTemplates(cfg.roomTemplates ?? {})) {
      expect(template.sourceFile).toBe(join(root, 'alternate', 'room_templates', `${template.name}.yaml`));
      for (const member of template.members) {
        const definition = cfg.agentTemplates?.[member.agent_template];
        expect(definition, `${template.name}:${member.agent_template}`).toBeDefined();
        expect(definition?.role).toEqual({ inline: expect.objectContaining({}) });
        expect(definition?.brain).toEqual({ inline: expect.objectContaining({ harness: 'claude-code' }) });
        expect(definition?.permissions).toMatchObject({ approval: 'ask', unattended: 'deny' });
      }
    }
    expect(Object.keys(cfg.brainPresets ?? {})).toHaveLength(49);
    for (const [id, brain] of Object.entries(cfg.brainPresets ?? {}))
      expect(() => validateEffectiveAgentTemplate({ role: { inline: {} }, brain: { inline: brain } }, id))
        .not.toThrow();
  });

  it('is repeatable and preserves edited and partial trees byte-for-byte', () => {
    const configPath = join(root, 'fleet.yaml');
    bootstrapPresets(configPath);
    const role = join(root, 'fleet', 'roles', 'Developer.yaml');
    writeFileSync(role, 'mission: my edited contract\n', { mode: 0o600 });
    rmSync(join(root, 'fleet', 'roles', 'LocalCoordinator.yaml'));
    const second = bootstrapPresets(configPath);
    expect(readFileSync(role, 'utf8')).toBe('mission: my edited contract\n');
    expect(existsSync(join(root, 'fleet', 'roles', 'LocalCoordinator.yaml'))).toBe(true);
    expect(second.created).toEqual([join(root, 'fleet', 'roles', 'LocalCoordinator.yaml')]);
    expect(second.preserved).toHaveLength(60);
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
