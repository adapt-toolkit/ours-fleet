import { describe, expect, it, vi } from 'vitest';
import { loadConfigResourceSnapshotFromDocuments } from '../src/config-resource-loader.js';
import type { AgentProductionRuntime } from '../src/agent-production-runtime.js';
import { reserveCanonicalRoomMemberPlan } from '../src/rooms-tasks/member-plan.js';

function snapshot() {
  const document = (relativePath: string, text: string) => ({ relativePath, bytes: Buffer.from(text) });
  return loadConfigResourceSnapshotFromDocuments({
    bootstrapFile: '/cfg/fleet.yaml', configDir: '/cfg/fleet.conf.d',
    bootstrapBytes: Buffer.from('schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n'),
    documents: [
      document('roles.d/worker.yaml', 'kind: Role\nversion: 1\nid: Worker\nspec: {mission: Work}\n'),
      document('brains.d/cheap.yaml', 'kind: Brain\nversion: 1\nid: cheap\nspec: {harness: codex, model: gpt, effort: high, session: acp}\n'),
      document('room-templates.d/pair.yaml', 'kind: RoomTemplate\nversion: 1\nid: pair\nspec:\n  version: 1\n  description: pair\n  members:\n    - {slot: worker, role: Worker, count: 1, brain: {template: cheap}, permissions: {approval: ask, filesystem: workspace, unattended: deny}}\n'),
    ],
  });
}

const member = {
  slot: 'worker', role: 'Worker', count: 1, brain: { template: 'cheap' },
  permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
} as const;

describe('canonical room member AgentPlan producer', () => {
  it('reserves before returning an exact immutable handoff binding', async () => {
    const reserve = vi.fn(async () => ({
      schemaVersion: 1, kind: 'TempAgentSupervisorHandoff', agentId: 'member-1', actionId: 'action-1',
      generation: 2, planDigest: `sha256:${'1'.repeat(64)}`, snapshotDigest: `sha256:${'2'.repeat(64)}`,
      reservationDigest: `sha256:${'3'.repeat(64)}`, canonicalDir: '/state/agent',
      planBytesDigest: `sha256:${'4'.repeat(64)}`, authorizationRevision: 'revision-1',
      lifetime: 'temporary', identityLifecycle: 'connector_session_owned', completion: 'deferred',
      handoffDigest: `sha256:${'5'.repeat(64)}`,
    } as const));
    const runtime = { reserveTemporaryComposition: reserve } as unknown as AgentProductionRuntime;
    const binding = await reserveCanonicalRoomMemberPlan(runtime, {
      snapshot: snapshot(), templateId: 'pair', member, roomId: 'room-1', taskId: 'task-1',
      memberId: 'member-1', identityName: 'member-1', ordinal: 1,
      actionId: 'action-1', issuedAt: 1,
    });
    expect(binding).toMatchObject({
      kind: 'canonical_agent_plan', agent_id: 'member-1', generation: 2,
      action_id: 'action-1', role_id: 'Worker', identity_ownership: 'create_temporary',
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve.mock.calls[0][0].request).toMatchObject({
      source: { agentId: 'member-1', role: 'Worker', lifecycle: 'temporary',
        identity: { name: 'member-1', ownership: 'create_temporary' } },
      membership: { roomId: 'room-1', taskId: 'task-1', slot: 'worker', ordinal: 1, memberId: 'member-1' },
    });
  });

  it('rejects incomplete permissions before runtime reservation', async () => {
    const reserve = vi.fn();
    await expect(reserveCanonicalRoomMemberPlan(
      { reserveTemporaryComposition: reserve } as unknown as AgentProductionRuntime,
      { snapshot: snapshot(), templateId: 'pair', member: { ...member, permissions: { approval: 'ask' } },
        roomId: 'room-1', memberId: 'member-1', identityName: 'member-1', ordinal: 1,
        actionId: 'action-1', issuedAt: 1 },
    )).rejects.toThrow(/complete permissions/u);
    expect(reserve).not.toHaveBeenCalled();
  });
});
