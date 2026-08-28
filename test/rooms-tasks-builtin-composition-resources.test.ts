import { describe, expect, it } from 'vitest';
import { createBuiltinCompositionResources } from '../src/rooms-tasks/builtin-composition-resources.js';
import { previewRoomMemberComposition } from '../src/rooms-tasks/member-composition.js';
import type { ConfigResourceSnapshot, ConfigResourceSource } from '../src/config-resource-loader.js';

describe('built-in composition resources', () => {
  const roles = () => Object.fromEntries([
    'Architect', 'Developer', 'Tester', 'Secretary', 'Critic', 'Agent',
  ].map((id, index) => [id, {
    kind: 'Role' as const, version: 1 as const, id,
    spec: index % 2 ? { persona: `${id} persona`, capabilities: [`cap-${index}`] } : {},
  }]));

  it.each([
    { template: 'cheap' },
    { harness: 'codex', model: 'gpt', effort: 'high', session: 'acp' },
  ])('copies an explicit atomic Brain into every inert prototype', brain => {
    const supplied = roles();
    const resources = createBuiltinCompositionResources(supplied, brain);
    expect(resources.roles.map(role => role.id)).toEqual([
      'Architect', 'Developer', 'Tester', 'Secretary', 'Critic', 'Agent',
    ]);
    expect(resources.templates.map(template => template.id)).toEqual(['team', 'pair', 'single']);
    for (const template of resources.templates) {
      for (const member of template.spec.members) expect(member.brain).toEqual(brain);
    }
    expect(resources.roles).toEqual(Object.values(supplied));
    expect(resources.roles[1].spec).toEqual({ persona: 'Developer persona', capabilities: ['cap-1'] });
    expect(resources.roles[1]).not.toBe(supplied.Developer);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(resources.templates[0].spec.members[0].brain)).toBe(true);
  });

  it('requires a supplied complete Brain selection and never invents a default', () => {
    expect(() => createBuiltinCompositionResources(roles(), undefined as never)).toThrow(/\$\.brain/u);
    expect(() => createBuiltinCompositionResources(roles(), { harness: 'codex' } as never))
      .toThrow(/exactly \{template\}/u);
  });

  it('requires exactly the caller-supplied inert Roles with matching kinds and ids', () => {
    const missing = roles(); delete missing.Critic;
    expect(() => createBuiltinCompositionResources(missing, { template: 'cheap' }))
      .toThrow(/missing: Critic/u);
    expect(() => createBuiltinCompositionResources({ ...roles(), Observer: {
      kind: 'Role', version: 1, id: 'Observer', spec: {},
    } }, { template: 'cheap' })).toThrow(/extra: Observer/u);
    expect(() => createBuiltinCompositionResources({ ...roles(), Critic: {
      kind: 'Brain', version: 1, id: 'Critic', spec: {},
    } as never }, { template: 'cheap' })).toThrow(/roles\.Critic must be Role/u);
    expect(() => createBuiltinCompositionResources({ ...roles(), Critic: {
      kind: 'Role', version: 1, id: 'Reviewer', spec: {},
    } }, { template: 'cheap' })).toThrow(/id 'Critic'/u);
  });

  it('returns deterministic independent snapshots', () => {
    const first = createBuiltinCompositionResources(roles(), { template: 'cheap' });
    const second = createBuiltinCompositionResources(roles(), { template: 'cheap' });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('previews every prototype without a configured runnable role or Agent', () => {
    const builtins = createBuiltinCompositionResources(roles(), { template: 'cheap' });
    const brain = { kind: 'Brain' as const, version: 1 as const, id: 'cheap',
      spec: { harness: 'codex', model: 'gpt', effort: 'low', session: 'acp' } };
    const brainSource: ConfigResourceSource = {
      kind: 'Brain', id: 'cheap', sourceFile: '/cfg/brains.d/cheap.yaml',
      relativePath: 'brains.d/cheap.yaml', size: 1, sha256: 'brain-sha', resource: brain,
    };
    const snapshot: ConfigResourceSnapshot = {
      schemaVersion: 2, bootstrapFile: '/cfg/fleet.yaml', configDir: '/cfg/fleet.conf.d',
      digest: 'sha256:fixture', bootstrap: {}, diagnostics: [],
      sources: [...builtins.sources, brainSource],
      resources: {
        Role: Object.fromEntries(builtins.roles.map(role => [role.id, role])), Brain: { cheap: brain },
        RoomTemplate: Object.fromEntries(builtins.templates.map(template => [template.id, template])),
      },
    };
    const previews = builtins.templates.flatMap(template => template.spec.members.map((member, index) =>
      previewRoomMemberComposition(snapshot, member, `builtin:${template.id}`, `$.members[${index}]`)));
    expect(previews).toHaveLength(6);
    expect(previews.every(preview => preview.brain.sourceId === 'cheap')).toBe(true);
    expect(snapshot.resources.Agent).toBeUndefined();
  });
});
