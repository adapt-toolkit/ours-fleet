import { describe, expect, it } from 'vitest';
import {
  MAX_BRAIN_FIELD_BYTES, MAX_CAPABILITIES, MAX_CAPABILITY_BYTES, MAX_ROLE_TEXT_BYTES,
  parseBrainRef, parseTypedResource, ResourceValidationError,
} from '../src/config-resources.js';

describe('typed configuration resources', () => {
  it('accepts named and complete inline Brain references', () => {
    expect(parseBrainRef({ template: 'cheap' })).toEqual({ template: 'cheap' });
    expect(parseBrainRef({
      harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', session: 'acp',
    })).toEqual({
      harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', session: 'acp',
    });
  });

  it.each([
    [{ harness: 'codex', model: 'gpt', session: 'acp' }],
    [{ template: 'cheap', effort: 'low' }],
    [{ harness: 'codex', model: 'gpt', effort: 'high', session: 'acp', extra: true }],
  ])('rejects partial, ambiguous, and extra-field Brain references', value => {
    expect(() => parseBrainRef(value)).toThrow(/exactly \{template\}/u);
  });

  it('never normalizes IDs, template references, or Brain fields', () => {
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: " cheap "
spec: {}
`)).toThrow(/leading or trailing whitespace/u);
    expect(() => parseBrainRef({ template: ' cheap ' })).toThrow(/leading or trailing whitespace/u);
    expect(() => parseBrainRef({ template: 'not.a.resource' })).toThrow(/must match/u);
    expect(() => parseBrainRef({
      harness: ' codex', model: 'gpt', effort: 'high', session: 'acp',
    })).toThrow(/leading or trailing whitespace/u);
  });

  it('keeps Role resources behavior-only', () => {
    expect(parseTypedResource('secretary.yaml', `
kind: Role
version: 1
id: Secretary
spec:
  bio: Public card
  persona: Deliberate first
  capabilities: [implementation, deliberation]
`)).toEqual({
      kind: 'Role', version: 1, id: 'Secretary',
      spec: {
        bio: 'Public card', persona: 'Deliberate first',
        capabilities: ['implementation', 'deliberation'],
      },
    });
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: Secretary
spec: { harness: codex }
`)).toThrow(/unknown key\(s\): harness/u);
  });

  it('requires Brain resources to contain exactly the four defining fields', () => {
    expect(parseTypedResource('cheap.yaml', `
kind: Brain
version: 1
id: cheap
spec: { harness: claude-code, model: claude-haiku, effort: low, session: acp }
`)).toMatchObject({ kind: 'Brain', id: 'cheap' });
    expect(() => parseTypedResource('bad.yaml', `
kind: Brain
version: 1
id: bad
spec: { template: cheap }
`)).toThrow(/require a complete inline definition/u);
  });

  it('rejects duplicate capabilities, invalid IDs, unknown top-level fields, and YAML streams', () => {
    const cases = [
      [`kind: Role\nversion: 1\nid: bad.id\nspec: {}\n`, /must match/u],
      [`kind: Role\nversion: 1\nid: ok\nextra: true\nspec: {}\n`, /unknown key/u],
      [`kind: Role\nversion: 1\nid: ok\nspec:\n  capabilities: [same, same]\n`, /duplicates/u],
      [`kind: Role\nversion: 1\nid: one\nspec: {}\n---\nkind: Role\nversion: 1\nid: two\nspec: {}\n`, /exactly one YAML document/u],
    ] as const;
    for (const [source, error] of cases)
      expect(() => parseTypedResource('resource.yaml', source)).toThrow(error);
  });

  it('requires bounded stable capability tokens and bounded Role/Brain strings', () => {
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: ["two words"] }
`)).toThrow(/stable ASCII token/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: [" padded "] }
`)).toThrow(/leading or trailing whitespace/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: [${Array.from({ length: MAX_CAPABILITIES + 1 }, (_, i) => `c${i}`).join(', ')}] }
`)).toThrow(/at most 64 entries/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: [${'x'.repeat(MAX_CAPABILITY_BYTES + 1)}] }
`)).toThrow(/at most 128 UTF-8 bytes/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec:
  bio: ${'x'.repeat(MAX_ROLE_TEXT_BYTES + 1)}
`)).toThrow(/at most 65536 UTF-8 bytes/u);
    expect(() => parseBrainRef({
      harness: 'x'.repeat(MAX_BRAIN_FIELD_BYTES + 1), model: 'gpt', effort: 'high', session: 'acp',
    })).toThrow(/at most 256 UTF-8 bytes/u);
  });

  it('reports the source file and exact field path', () => {
    try {
      parseTypedResource('/config/brains.d/cheap.yaml', `
kind: Brain
version: 1
id: cheap
spec: { harness: claude-code, model: '', effort: low, session: acp }
`);
      expect.fail('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceValidationError);
      expect((error as Error).message).toContain('/config/brains.d/cheap.yaml:$.spec.model');
    }
  });

  it('parses persistent Agents with complete identity, Brain, and permissions', () => {
    expect(parseTypedResource('agents.d/coordinator.yaml', `
kind: Agent
version: 1
id: coordinator
spec:
  role: Coordinator
  brain: {template: smart}
  identity: {name: VPSCoordinator, ownership: existing}
  lifecycle: persistent
  permissions: {approval: allow, filesystem: workspace, unattended: wait}
`)).toMatchObject({
      kind: 'Agent', id: 'coordinator',
      spec: { role: 'Coordinator', brain: { template: 'smart' }, lifecycle: 'persistent' },
    });
  });

  it.each([
    ['lifecycle: temporary', /must be persistent/u],
    ['lifecycle: persistent\n  mission: injected', /unknown key\(s\): mission/u],
    ['lifecycle: persistent\n  harness: codex', /unknown key\(s\): harness/u],
    ['lifecycle: persistent\n  runtime: {}', /unknown key\(s\): runtime/u],
  ])('rejects forbidden Agent composition: %s', (tail, error) => {
    expect(() => parseTypedResource('agent.yaml', `
kind: Agent
version: 1
id: worker
spec:
  role: Worker
  brain: {harness: codex, model: gpt, effort: high, session: acp}
  identity: {name: Worker, ownership: create_persistent}
  ${tail}
  permissions: {approval: ask, filesystem: read-only, unattended: deny}
`)).toThrow(error);
  });

  it('requires complete Agent permissions and a permitted identity intent', () => {
    const base = (identity: string, permissions: string) => `
kind: Agent
version: 1
id: worker
spec:
  role: Worker
  brain: {template: cheap}
  identity: ${identity}
  lifecycle: persistent
  permissions: ${permissions}
`;
    expect(() => parseTypedResource('agent.yaml', base(
      '{name: Worker, ownership: create_temporary}',
      '{approval: ask, filesystem: workspace, unattended: wait}',
    ))).toThrow(/existing or create_persistent/u);
    expect(() => parseTypedResource('agent.yaml', base(
      '{name: Worker, ownership: existing}', '{approval: ask, filesystem: workspace}',
    ))).toThrow(/must define approval, filesystem, and unattended/u);
  });

  it('parses heterogeneous RoomTemplate members with bounded overrides', () => {
    const resource = parseTypedResource('room-templates.d/pair.yaml', `
kind: RoomTemplate
version: 1
id: pair
spec:
  version: 1
  description: Paired review
  contract: Secretary writes; Critic reviews.
  room: {quiet_membership: true, anonymous: false}
  members:
    - slot: secretary
      role: Secretary
      count: 1
      brain: {template: smart}
      permissions: {filesystem: workspace}
      role_context: {mission_append: Implement the assigned slice.}
    - slot: critic
      role: Critic
      count: 1
`);
    expect(resource).toMatchObject({ kind: 'RoomTemplate', id: 'pair' });
    expect((resource as { spec: { members: unknown[] } }).spec.members).toHaveLength(2);
  });

  it('rejects runtime room state and unknown member fields in templates', () => {
    expect(() => parseTypedResource('room.yaml', `
kind: RoomTemplate
version: 1
id: bad
spec: {version: 1, description: bad, room_id: live, members: [{slot: one, role: Worker, count: 1}]}
`)).toThrow(/unknown key\(s\): room_id/u);
    expect(() => parseTypedResource('room.yaml', `
kind: RoomTemplate
version: 1
id: bad
spec: {version: 1, description: bad, members: [{slot: one, role: Worker, count: 1, identity: nope}]}
`)).toThrow(/unknown key\(s\): identity/u);
  });

  it('maps singleton RoomsPolicy and TasksPolicy resources', () => {
    expect(parseTypedResource('rooms.d/default.yaml', `
kind: RoomsPolicy
version: 1
id: default
spec:
  cowork: {config: /etc/ours/cowork.yaml}
  owner: {provider: ours, expected_cid: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, role: Owner, public_invite_file: /run/owner.invite}
  defaults: {template: pair, attach_owner: true, close_when_task_done: true, brain: {template: smart}, permissions: {approval: ask}}
`)).toMatchObject({
      kind: 'RoomsPolicy', id: 'default',
      spec: { owner: { expected_cid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
    });
    expect(parseTypedResource('tasks.d/default.yaml', `
kind: TasksPolicy
version: 1
id: default
spec: {default_room_template: pair, create_mode: backlog, close_room_on_done: true, retain_completed_for: 7d, permissions: {filesystem: workspace}}
`)).toMatchObject({ kind: 'TasksPolicy', id: 'default' });
  });

  it('enforces singleton IDs, invite XOR, CID shape, and exact policy keys', () => {
    const room = (id: string, owner: string) => `
kind: RoomsPolicy
version: 1
id: ${id}
spec:
  owner: ${owner}
`;
    expect(() => parseTypedResource('rooms.yaml', room(
      'other', '{provider: ours, expected_cid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, role: Owner}',
    ))).toThrow(/singleton id must be default/u);
    expect(() => parseTypedResource('rooms.yaml', room(
      'default', '{provider: ours, expected_cid: short, role: Owner}',
    ))).toThrow(/64 hexadecimal/u);
    expect(() => parseTypedResource('rooms.yaml', room(
      'default', '{provider: ours, expected_cid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, role: Owner, public_invite: x, public_invite_file: y}',
    ))).toThrow(/mutually exclusive/u);
    expect(() => parseTypedResource('tasks.yaml', `
kind: TasksPolicy
version: 1
id: default
spec: {create_mode: immediate}
`)).toThrow(/start or backlog/u);
  });
});
