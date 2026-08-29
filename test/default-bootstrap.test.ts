import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import type { FleetConfig } from '../src/config.js';

const bootstrap = resolve('examples/fleet.yaml');

describe('packaged schema-v2 default graph', () => {
  it('loads every mapping-independent resource with no owner configuration', () => {
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    expect(Object.keys(snapshot.resources.Role ?? {}).sort()).toEqual([
      'Agent', 'Architect', 'Critic', 'Developer', 'Secretary', 'Tester',
    ]);
    expect(Object.keys(snapshot.resources.Brain ?? {}).sort()).toEqual([
      'claude-fable', 'claude-opus', 'gpt-sol', 'gpt-terra',
    ]);
    expect(snapshot.resources.Brain?.['gpt-terra']).toMatchObject({
      kind: 'Brain', spec: { harness: 'codex', model: 'gpt-5.6-terra' },
    });
    expect(Object.keys(snapshot.resources.RoomTemplate ?? {}).sort()).toEqual(['pair', 'single', 'team']);
    expect(Object.keys(snapshot.resources.TasksPolicy ?? {})).toEqual(['default']);
    expect(snapshot.resources.RoomsPolicy).toBeUndefined();
    const bytes = snapshot.sources.map(source => readFileSync(source.sourceFile, 'utf8')).join('\n');
    expect(bytes).not.toMatch(/expected_cid|public_invite|owner_channel|attach_owner/u);
  });

  it('defines exact reference-valid single, pair, and team seats', () => {
    const templates = loadConfigResourceSnapshot({ bootstrapFile: bootstrap }).resources.RoomTemplate!;
    const seats = (id: string) => templates[id].kind === 'RoomTemplate'
      ? templates[id].spec.members.map(member => ({ slot: member.slot, role: member.role,
        brain: 'template' in member.brain! ? member.brain.template : 'inline',
        permissions: member.permissions })) : [];
    const permissions = { approval: 'ask', filesystem: 'workspace', unattended: 'wait' };
    expect(seats('single')).toEqual([
      { slot: 'agent', role: 'Agent', brain: 'gpt-sol', permissions },
    ]);
    expect(seats('pair')).toEqual([
      { slot: 'secretary', role: 'Secretary', brain: 'claude-fable', permissions },
      { slot: 'critic', role: 'Critic', brain: 'gpt-sol', permissions },
    ]);
    expect(seats('team')).toEqual([
      { slot: 'architect', role: 'Architect', brain: 'claude-opus', permissions },
      { slot: 'developer', role: 'Developer', brain: 'gpt-sol', permissions },
      { slot: 'tester', role: 'Tester', brain: 'claude-fable', permissions },
    ]);
  });

  it('fails at the explicit runtime-model validation boundary when a catalog is unavailable', () => {
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap,
      validateBrain: brain => brain.harness === 'codex' ? ['runtime model catalog unavailable'] : [] }))
      .toThrow(/runtime model catalog unavailable/u);
  });

  it('fails closed before room or provisioning effects when owner RoomsPolicy is absent', async () => {
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    const cowork = vi.fn(); const provisionMembers = vi.fn();
    const app = new TaskRoomApplicationService(bootstrap, {
      loadConfiguration: () => ({
        roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
        watchdogs: [], loops: [], roomTemplates: {}, tasks: { default_room_template: 'single' },
      } as FleetConfig),
      loadResourceSnapshot: () => snapshot, cowork, provisionMembers,
    });
    await expect(app.createRoom({ actor: { kind: 'local_control', surface: 'cli' },
      name: 'Must stop', template: 'single' }))
      .rejects.toThrow('rooms: configuration is required');
    expect(cowork).not.toHaveBeenCalled();
    expect(provisionMembers).not.toHaveBeenCalled();
  });
});
