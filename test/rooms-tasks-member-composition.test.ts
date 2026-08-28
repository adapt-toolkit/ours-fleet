import { describe, expect, it } from 'vitest';
import type { ConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { RoomTemplateMemberSpec } from '../src/config-resources.js';
import { previewRoomMemberComposition } from '../src/rooms-tasks/member-composition.js';

function snapshot(): ConfigResourceSnapshot {
  const role = { kind: 'Role' as const, version: 1 as const, id: 'Worker', spec: { mission: 'Work' } };
  const brain = { kind: 'Brain' as const, version: 1 as const, id: 'cheap',
    spec: { harness: 'codex', model: 'gpt', effort: 'low', session: 'acp' } };
  return {
    schemaVersion: 2, bootstrapFile: '/cfg/fleet.yaml', configDir: '/cfg/fleet.conf.d',
    digest: 'sha256:snapshot', bootstrap: {}, diagnostics: [],
    resources: { Role: { Worker: role }, Brain: { cheap: brain } },
    sources: [
      { kind: 'Role', id: 'Worker', sourceFile: '/cfg/roles.d/worker.yaml',
        relativePath: 'roles.d/worker.yaml', size: 1, sha256: 'role-sha', resource: role },
      { kind: 'Brain', id: 'cheap', sourceFile: '/cfg/brains.d/cheap.yaml',
        relativePath: 'brains.d/cheap.yaml', size: 1, sha256: 'brain-sha', resource: brain },
    ],
  };
}

describe('room member composition preview', () => {
  it('resolves named resources and preserves inert optional declarations', () => {
    const member: RoomTemplateMemberSpec = {
      slot: 'worker', role: 'Worker', count: 2, brain: { template: 'cheap' },
      permissions: { approval: 'ask' }, role_context: { mission_append: 'Task only.' },
    };
    const before = structuredClone(member);
    const preview = previewRoomMemberComposition(snapshot(), member, 'pair.yaml', '$.spec.members[0]');
    expect(preview).toMatchObject({
      member, role: { id: 'Worker', sha256: 'role-sha' },
      brain: { selection: 'named', sourceId: 'cheap', sha256: 'brain-sha', spec: { model: 'gpt' } },
    });
    expect(member).toEqual(before);
    expect(preview.member).not.toBe(member);
    expect(Object.isFrozen(preview.member.permissions)).toBe(true);
    expect(Object.isFrozen(preview.brain.spec)).toBe(true);
  });

  it('copies an inline Brain atomically and supports independent selections', () => {
    const brain = { harness: 'claude-code', model: 'sonnet', effort: 'high', session: 'acp' };
    const preview = previewRoomMemberComposition(snapshot(), {
      slot: 'worker', role: 'Worker', count: 1, brain,
    });
    expect(preview.brain).toMatchObject({ selection: 'inline', spec: brain });
    expect(preview.brain.spec).not.toBe(brain);
  });

  it.each([
    [{ slot: 'x', role: 'Worker', count: 1 }, /explicit atomic Brain selection is required/u],
    [{ slot: 'x', role: 'Missing', count: 1, brain: { template: 'cheap' } }, /Role resource 'Missing' not found/u],
    [{ slot: 'x', role: 'Worker', count: 1, brain: { template: 'missing' } }, /Brain resource 'missing' not found/u],
  ] as const)('fails before previewing missing resources', (member, error) => {
    expect(() => previewRoomMemberComposition(snapshot(), member, 'template.yaml', '$.members[0]'))
      .toThrow(error);
  });

  it.each([
    ['Role', (value: ConfigResourceSnapshot) => ({ ...value, sources: value.sources.filter(s => s.kind !== 'Role') }),
      /Role resource 'Worker' has no snapshot source evidence/u],
    ['Brain', (value: ConfigResourceSnapshot) => ({ ...value, sources: value.sources.filter(s => s.kind !== 'Brain') }),
      /Brain resource 'cheap' has no snapshot source evidence/u],
  ] as const)('requires %s snapshot source evidence', (_kind, alter, error) => {
    expect(() => previewRoomMemberComposition(alter(snapshot()), {
      slot: 'x', role: 'Worker', count: 1, brain: { template: 'cheap' },
    })).toThrow(error);
  });

  it('defensively rejects a wrong-kind resource in a corrupted snapshot', () => {
    const value = snapshot();
    const corrupted = { ...value, resources: { ...value.resources,
      Role: { Worker: value.resources.Brain!.cheap },
    } } as unknown as ConfigResourceSnapshot;
    expect(() => previewRoomMemberComposition(corrupted, {
      slot: 'x', role: 'Worker', count: 1, brain: { template: 'cheap' },
    })).toThrow(/Role resource 'Worker' not found/u);
  });
});
