import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { attachOursClient } from '@ours.network/sdk/client';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { binderKey, type RuntimeState } from '../agent-ours/state.js';
import { readClientProfile } from '../client-profile.js';
import { readProvenance } from '../creation.js';
import { agentDir, stateRoot } from '../paths.js';
import { readTempSupervisor, tempSupervisorLiveness, TEMP_SUPERVISOR_FILE } from '../temp-lifecycle.js';
import { getTask } from './task-state.js';
import { getRoomRecord, updateMemberStartup } from './room-state.js';
import { assertMemberNotPermanent } from './member-ownership.js';

export interface LegacyTaskOwner {
  taskId: string; roomId: string; roomIdentityCid: string; creationActionId: string;
}
interface AdoptionDeps {
  liveness?: typeof tempSupervisorLiveness;
  verifyIdentity?(name: string, cid: string): Promise<void>;
  /** Crash seam: the role snapshot is durable before the supervisor owner. */
  beforeOwnerCommit?(): void;
}
function bounded(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error('LEGACY_TASK_MEMBER_UNSAFE_PROOF');
  return readFileSync(path, 'utf8');
}
async function verifyIdentity(name: string, cid: string, env: NodeJS.ProcessEnv): Promise<void> {
  const profile = readClientProfile(env);
  const client = await attachOursClient({ endpoint: profile.endpoint, expectedInstanceId: profile.expectedInstanceId,
    credentialPath: profile.credentialPath, sessionMode: 'external', env: {}, leaseToken: `task-migration-${randomUUID()}` });
  try {
    const identities = await client.listIdentities();
    const found = identities.find(value => value.name === name);
    if (!found || !('cid' in found) || found.cid.toLowerCase() !== cid.toLowerCase())
      throw Error('LEGACY_TASK_MEMBER_IDENTITY_MISMATCH');
  } finally { try { await client.releaseLease(); } finally { await client.close(); } }
}

/** Caller holds task and room operation locks. No service is started here.
 * Running legacy supervisors remain untouched; stopped exact state receives
 * only ownership metadata, preserving launch, identity and conversation.
 */
export async function adoptLegacyTaskMember(
  owner: LegacyTaskOwner, name: string, deps: AdoptionDeps = {},
): Promise<'adopted' | 'running-legacy' | 'already-durable'> {
  return withFileLock(join(stateRoot(), 'locks', 'temp-supervisors', encodeURIComponent(name)), async () => {
    assertMemberNotPermanent(name);
    const dir = agentDir(name, true), task = getTask(owner.taskId), room = getRoomRecord(owner.roomId);
    const seat = room?.member_seats.find(value => value.role_name === name);
    const supervisor = readTempSupervisor(dir) as ReturnType<typeof readTempSupervisor> & { taskOwner?: LegacyTaskOwner };
    const rolePath = join(dir, 'role.yaml'), roleBytes = bounded(rolePath);
    const role = parse(roleBytes);
    const startup = role?.roomMemberStartup, provenance = readProvenance(dir);
    if (task.deletion || task.terminal_intent || !['provisioning', 'active', 'review'].includes(task.state)
        || !room || room.close || !['provisioning', 'active'].includes(room.state) || room.task_id !== owner.taskId
        || task.room_id !== owner.roomId || room.room_identity_cid !== owner.roomIdentityCid
        || task.room_identity_cid !== owner.roomIdentityCid || !seat || seat.retirement
        || !supervisor || supervisor.role !== name || seat.launch?.launch_id !== supervisor.launchId
        || seat.launch.action_id !== owner.creationActionId || provenance?.creationActionId !== owner.creationActionId
        || provenance.role !== name || role.name !== name || role.identity !== name
        || startup?.identity_name !== name || startup.room_id !== owner.roomId
        || startup.room_identity_cid !== owner.roomIdentityCid || startup.invite_id !== seat.invite_id
        || startup.role !== seat.cowork_role || startup.invite !== ''
        || (startup.task_id !== undefined && startup.task_id !== owner.taskId)
        || (room.workspace && (role.cwd !== room.workspace.path || JSON.stringify(startup.workspace) !== JSON.stringify(room.workspace)))
        || bounded(join(dir, '.identity')).trim() !== name)
      throw Error('LEGACY_TASK_MEMBER_OWNERSHIP_MISMATCH');
    if (supervisor.taskOwner) {
      if (Object.entries(owner).some(([key, value]) => supervisor.taskOwner![key as keyof LegacyTaskOwner] !== value)
          || startup.task_id !== owner.taskId)
        throw Error('LEGACY_TASK_MEMBER_OWNER_MISMATCH');
      if (supervisor.kind !== 'detached' && process.env.OURS_FLEET_SUPERVISOR !== 'none')
        updateMemberStartup(owner.roomId, name, { launch: { ...seat.launch, task_supervised: true } });
      return 'already-durable';
    }
    const live = await (deps.liveness ?? tempSupervisorLiveness)(dir);
    if (live === 'running') return 'running-legacy';
    if (live !== 'stopped') throw Error('LEGACY_TASK_MEMBER_LIVENESS_UNKNOWN');
    const env = { ...process.env, ...role.env };
    const profile = readClientProfile(env);
    const privateDir = join(stateRoot(), 'private-ours', binderKey(profile.expectedInstanceId, name));
    const state = JSON.parse(bounded(join(privateDir, 'state.json'))) as RuntimeState;
    const instance = JSON.parse(bounded(join(privateDir, 'instance.json')));
    const externalOwner = JSON.parse(bounded(join(privateDir, 'owner.json')));
    const launch = JSON.parse(bounded(join(stateRoot(), 'private-ours', 'launches', binderKey('temporary', name) + '.json')));
    if (!seat.identity_cid || state.name !== name || state.daemon !== profile.expectedInstanceId
        || state.lifetime !== 'temporary' || state.action !== owner.creationActionId
        || state.cid?.toLowerCase() !== seat.identity_cid.toLowerCase()
        || !['READY', 'SERVING', 'RECOVERING'].includes(state.phase)
        || instance.role !== name || instance.temporary !== true || instance.instance !== state.instance
        || externalOwner.instance !== state.instance || typeof externalOwner.token !== 'string' || !externalOwner.token
        || state.room?.id !== owner.roomId || state.room.cid !== owner.roomIdentityCid
        || state.room.agentCid.toLowerCase() !== seat.identity_cid.toLowerCase() || state.room.action !== seat.invite_id
        || launch.role !== name || launch.identity !== name || launch.action !== owner.creationActionId)
      throw Error('LEGACY_TASK_MEMBER_RUNTIME_NOT_RESUMABLE');
    const sessionPath = join(dir, role.session === 'codex-app-server' ? '.session-id' : '.acp-session-id');
    if (!bounded(sessionPath).trim()) throw Error('LEGACY_TASK_MEMBER_CONVERSATION_MISSING');
    if (deps.verifyIdentity) await deps.verifyIdentity(name, seat.identity_cid);
    else await verifyIdentity(name, seat.identity_cid, env);
    assertMemberNotPermanent(name);
    if (bounded(rolePath) !== roleBytes || JSON.stringify(readTempSupervisor(dir)) !== JSON.stringify(supervisor))
      throw Error('LEGACY_TASK_MEMBER_STATE_CHANGED');
    // Crash after this write is healed by retrying the same stopped adoption.
    startup.task_id = owner.taskId;
    replaceFileAtomically(rolePath, stringify(role));
    if (supervisor.kind !== 'detached' && process.env.OURS_FLEET_SUPERVISOR !== 'none')
      updateMemberStartup(owner.roomId, name, { launch: { ...seat.launch, task_supervised: true } });
    deps.beforeOwnerCommit?.();
    replaceFileAtomically(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...supervisor, taskOwner: owner }, null, 2) + '\n');
    return 'adopted';
  });
}
