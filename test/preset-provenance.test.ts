import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetProvenance } from '../src/application/preset-provenance.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provenance-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

describe('preset provenance', () => {
  it('classifies definitions by parsed value against the shipped presets', () => {
    const presets = join(root, 'presets'), split = join(root, 'fleet');
    write(join(presets, 'roles', 'Developer.yaml'), 'mission: Build\npersona: |\n  Line one\n  Line two\n');
    write(join(presets, 'roles', 'Critic.yaml'), 'mission: Review\n');
    write(join(presets, 'brains', 'fast.yaml'), 'harness: codex\nmodel: null\n');
    write(join(presets, 'room_layouts', 'single.yaml'), 'version: 1\n');
    // Same value, editor formatting (folded block, key order): still predefined.
    write(join(split, 'roles', 'Developer.yaml'), 'persona: >\n  Line one\n\n  Line two\nmission: Build\n');
    write(join(split, 'roles', 'Critic.yaml'), 'mission: Review harder\n');
    write(join(split, 'roles', 'Mine.yaml'), 'mission: Mine\n');
    write(join(split, 'brains', 'fast.yaml'), 'harness: codex\nmodel: null\n');
    write(join(split, 'room_layouts', 'single.yaml'), 'version: [unclosed\n');
    symlinkSync(join(presets, 'roles', 'Critic.yaml'), join(split, 'roles', 'Linked.yaml'));

    const result = new PresetProvenance(join(root, 'fleet.yaml'), presets).read();
    expect(result.role).toEqual({
      Critic: { status: 'changed', preset: 'mission: Review\n' },
      Developer: { status: 'predefined', preset: 'mission: Build\npersona: |\n  Line one\n  Line two\n' },
      Mine: { status: 'custom' },
    }); // the symlink is not followed
    expect(result.brain.fast.status).toBe('predefined');
    expect(result.layout.single.status).toBe('changed'); // unparseable never matches
    expect(result.template).toEqual({});
  });
});
