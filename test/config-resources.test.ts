import { describe, expect, it } from 'vitest';
import {
  MAX_BRAIN_FIELD_BYTES, MAX_CAPABILITIES, MAX_CAPABILITY_BYTES, MAX_ROLE_TEXT_BYTES,
  parseBrainRef, parseTypedResource, ResourceValidationError,
} from '../src/config-resources.js';
import {
  validateOwnerChannelPolicyInput, validateWorklogPolicyInput,
} from '../src/agent-runtime-policy.js';
import { resolveOwnerChannelConfig, resolveWorklogPolicy } from '../src/config.js';

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
    ['lifecycle: persistent\n  runtime: {native_options: {}}', /unknown key\(s\): native_options/u],
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

  it('stores validated Agent runtime input without filling resolved defaults', () => {
    const parsed = parseTypedResource('agents.d/worker.yaml', `
kind: Agent
version: 1
id: worker
spec:
  role: Worker
  brain: {template: cheap}
  identity: {name: Worker, ownership: existing}
  lifecycle: persistent
  permissions: {approval: ask, filesystem: workspace, unattended: wait}
  runtime:
    supervision: {coordinator: coordinator, oversee: [{role: helper, interval: 30s}]}
    isolation: {backend: bubblewrap, network: allowlist, allow_hosts: [broker.example], resources: {cpu: '1.5', mem: 2G, pids: 64}}
    owner_channel:
      identity: fleet-owner
      owners: [AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA]
      attachments: {max_files_per_request: 2, allowed_mime: [text/plain]}
    monitoring: {mode: fleet, wake_sources: [message_received], batch_ms: 50}
    worklog: {max_kb: 2048}
    scheduling: {cwd: /work, max_tokens: 100000, autocompact_pct: 80}
`);
    expect(parsed).toMatchObject({ kind: 'Agent', spec: { runtime: {
      supervision: { coordinator: 'coordinator' }, isolation: { backend: 'bubblewrap' },
      owner_channel: {
        identity: 'fleet-owner',
        owners: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        attachments: { max_files_per_request: 2 },
      },
      monitoring: { mode: 'fleet', batch_ms: 50 }, worklog: { max_kb: 2048 },
      scheduling: { cwd: '/work' },
    } } });
    const runtime = (parsed as { spec: { runtime: Record<string, unknown> } }).spec.runtime;
    expect(runtime.owner_channel).not.toHaveProperty('comments');
    expect(runtime.monitoring).not.toHaveProperty('inject');
    expect(runtime.worklog).not.toHaveProperty('keep_tail_kb');
  });

  it('uses the same pure owner-channel and worklog normalization as legacy resolution', () => {
    const cid = 'AbCdEf12'.repeat(8);
    const owner = validateOwnerChannelPolicyInput({
      identity: ' owner-channel ', owners: [cid], comments: false,
      attachments: { max_file_bytes: 100, max_request_bytes: 200 },
    });
    expect(owner).toEqual({
      identity: 'owner-channel', owners: [cid.toLowerCase()], comments: false,
      attachments: { max_file_bytes: 100, max_request_bytes: 200 },
    });
    expect(resolveOwnerChannelConfig(undefined, {
      identity: ' owner-channel ', owners: [cid], comments: false,
      attachments: { max_file_bytes: 100, max_request_bytes: 200 },
    }, 'acp')).toMatchObject(owner);
    expect(validateWorklogPolicyInput({ max_kb: 512, keep_tail_kb: 64 })).toEqual({
      max_kb: 512, keep_tail_kb: 64,
    });
    expect(resolveWorklogPolicy(undefined, { max_kb: 512, keep_tail_kb: 64 }))
      .toMatchObject({ max_kb: 512, keep_tail_kb: 64 });
  });

  it.each([
    ['owner duplicate CIDs', `owner_channel: {identity: owner, owners: [${'A'.repeat(64)}, ${'a'.repeat(64)}]}`, /duplicates/u],
    ['owner attachment lower bound', 'owner_channel: {identity: owner, owners: [cid], attachments: {max_files_per_request: 0}}', /integer from 1 to 32/u],
    ['owner attachment cross-field bound', 'owner_channel: {identity: owner, owners: [cid], attachments: {max_file_bytes: 20, max_request_bytes: 10}}', /at least max_file_bytes/u],
    ['owner unsafe progress integer', `owner_channel: {identity: owner, owners: [cid], progress_interval_ms: ${Number.MAX_SAFE_INTEGER + 1}}`, /safe integer/u],
    ['worklog archive bound', 'worklog: {max_archives: 1001}', /at most 1000/u],
    ['worklog cross-field bound', 'worklog: {max_kb: 10, keep_tail_kb: 10}', /less than max_kb/u],
    ['monitor wake source', 'monitoring: {wake_sources: [message_recieved]}', /unknown source/u],
    ['monitor zero batch', 'monitoring: {batch_ms: 0}', /at least 1/u],
    ['monitor unsafe threshold', `monitoring: {turn_fail_threshold: ${Number.MAX_SAFE_INTEGER + 1}}`, /positive integer/u],
    ['isolation list shape', 'isolation: {fs: {read: nope}}', /list of non-empty strings/u],
    ['isolation resource value', 'isolation: {resources: {pids: 0}}', /positive safe integer/u],
    ['scheduling percentage', 'scheduling: {autocompact_pct: 101}', /at most 100/u],
    ['native runtime option', 'native_options: {command: codex}', /unknown key/u],
    ['malformed supervision interval', 'supervision: {oversee: [{role: helper, interval: soon}]}', /invalid duration/u],
    ['zero supervision interval', 'supervision: {oversee: [{role: helper, interval: 0s}]}', /below the minimum/u],
    ['unsafe supervision interval', `supervision: {oversee: [{role: helper, interval: ${'9'.repeat(30)}d}]}`, /too large/u],
  ])('rejects invalid portable Agent runtime input: %s', (_name, runtime, error) => {
    expect(() => parseTypedResource('agent.yaml', `
kind: Agent
version: 1
id: worker
spec:
  role: Worker
  brain: {template: cheap}
  identity: {name: Worker, ownership: existing}
  lifecycle: persistent
  permissions: {approval: ask, filesystem: workspace, unattended: wait}
  runtime: {${runtime}}
`)).toThrow(error);
  });

  it('defers build capability admission while retaining intrinsic monitor validation', () => {
    expect(parseTypedResource('agent.yaml', `
kind: Agent
version: 1
id: worker
spec:
  role: Worker
  brain: {template: cheap}
  identity: {name: Worker, ownership: existing}
  lifecycle: persistent
  permissions: {approval: ask, filesystem: workspace, unattended: wait}
  runtime: {monitoring: {interrupt: after_tool}}
`)).toMatchObject({ spec: { runtime: { monitoring: { interrupt: 'after_tool' } } } });
  });

  it('reports exact monitor and isolation leaf paths', () => {
    for (const [runtime, leaf] of [
      ['monitoring: {turn_fail_threshold: 0}', '$.spec.runtime.monitoring.turn_fail_threshold'],
      ['isolation: {resources: {pids: 0}}', '$.spec.runtime.isolation.resources.pids'],
    ] as const) {
      expect(() => parseTypedResource('agent.yaml', `
kind: Agent
version: 1
id: worker
spec:
  role: Worker
  brain: {template: cheap}
  identity: {name: Worker, ownership: existing}
  lifecycle: persistent
  permissions: {approval: ask, filesystem: workspace, unattended: wait}
  runtime: {${runtime}}
`)).toThrow(`agent.yaml:${leaf}`);
    }
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
