import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { agentDir, stateRoot } from './paths.js';
import { readTempSupervisor } from './temp-lifecycle.js';
import { createHash } from 'node:crypto';
import { readProvenance } from './creation.js';
import type { ResolvedRole } from './config.js';
import { getTask } from './rooms-tasks/task-state.js';
import { getRoomRecord } from './rooms-tasks/room-state.js';
import { assertWorkspacePresent } from './rooms-tasks/workspace.js';
import { privateRuntimeRoot } from './agent-ours/service.js';
import { binderKey, RuntimeJournal } from './agent-ours/state.js';
import { assertMemberNotPermanent } from './rooms-tasks/member-ownership.js';
import { readClientProfile } from './client-profile.js';
import { firstManagedSessionMayStart } from './managed-recovery.js';

function readProof(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('TASK_SUPERVISOR_UNSAFE_PROOF');
  return readFileSync(path, 'utf8');
}

/** An admitted task member must resume its retained instance, never allocate a successor. */
function assertRetainedRuntime(role: ResolvedRole, action: string, cid: string, launch?: string, session?: string): void {
  const profile = readClientProfile({ ...process.env, ...role.env });
  if (!profile) throw Error('TASK_RUNTIME_PROFILE_MISSING');
  const dir = join(privateRuntimeRoot(), binderKey(profile.expectedInstanceId, role.identity));
  const instance = JSON.parse(readProof(join(dir, 'instance.json')));
  const owner = JSON.parse(readProof(join(dir, 'owner.json')));
  const pin = JSON.parse(readProof(join(dir, 'identity-pin.json')));
  readProof(join(dir, 'state.json'));
  const state = new RuntimeJournal(dir).read();
  const creation = JSON.parse(readProof(join(privateRuntimeRoot(), 'launches', binderKey('temporary', role.name) + '.json')));
  const sessionDir = agentDir(role.name, true);
  let retainedSession = '';
  try { retainedSession = readProof(join(sessionDir, role.session === 'codex-app-server' ? '.session-id' : '.acp-session-id')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || session || !firstManagedSessionMayStart(sessionDir)) throw error; }
  readProof(join(sessionDir, '.booted')); // presence is the runner's resume marker, including legacy empty files
  if (creation.role !== role.name || creation.identity !== role.identity || creation.action !== action
      || !state || instance.role !== role.name || instance.temporary !== true || !instance.instance
      || owner.instance !== instance.instance || typeof owner.token !== 'string' || !owner.token
      || pin.daemon !== profile.expectedInstanceId || pin.name !== role.identity || pin.cid !== cid
      || state.daemon !== profile.expectedInstanceId || state.name !== role.identity || state.cid !== cid
      || state.instance !== instance.instance || state.lifetime !== 'temporary' || state.action !== action
      || ['QUIESCING', 'TERMINAL_INTENT', 'RELEASED', 'CLEANUP_PENDING', 'FAILED'].includes(state.phase)
      || (!retainedSession && !firstManagedSessionMayStart(sessionDir)) || (launch && launch !== instance.instance) || (session && session !== retainedSession))
    throw Error('TASK_RETAINED_RUNTIME_MISMATCH');
}

/** Read-only ownership fence: absence/mismatch never permits a new identity or launch. */
export function taskSupervisorMayRun(name: string): boolean {
  assertMemberNotPermanent(name);
  const dir = agentDir(name, true);
  readProof(join(dir, '.temp-supervisor.json'));
  readProof(join(dir, 'creation.json'));
  const supervisor = readTempSupervisor(dir), owner = supervisor?.taskOwner;
  if (!owner || supervisor.role !== name || !owner.taskId || !owner.creationActionId)
    throw Error('TASK_SUPERVISOR_OWNER_MISSING');
  const role = parse(readProof(join(dir, 'role.yaml'))) as ResolvedRole;
  const startup = role.roomMemberStartup, provenance = readProvenance(dir);
  const task = getTask(owner.taskId);
  if (role.name !== name || role.identity !== name || provenance?.role !== name
      || provenance.creationActionId !== owner.creationActionId) throw Error('TASK_SUPERVISOR_OWNERSHIP_MISMATCH');
  if (!task.deletion && !task.terminal_intent && ['provisioning', 'active', 'review'].includes(task.state) && task.workspace) {
    if (role.cwd !== task.workspace.path) throw Error('TASK_WORKSPACE_MISMATCH');
    assertWorkspacePresent(task.workspace, 'task', task.task_id);
  }
  if (owner.layout) {
    const { runId, participant } = owner.layout;
    const expectedName = `layout-${createHash('sha256').update(runId + ':' + participant).digest('hex').slice(0, 16)}`;
    if (!task.layout || task.layout.run_id !== runId || runId !== `task-${owner.taskId}`
        || !/^[A-Za-z0-9_-]+$/.test(runId) || expectedName !== name
        || owner.creationActionId !== `${runId}:${participant}`) throw Error('TASK_LAYOUT_OWNER_MISMATCH');
    const state = JSON.parse(readProof(join(stateRoot(), 'layouts', `${runId}.json`)));
    const member = state.participants[participant];
    if (!member?.owned || member.instance?.remote || (member.instance?.agent && member.instance.agent !== name)
        || (member.instance && member.instance.temporary !== true)) throw Error('TASK_LAYOUT_PARTICIPANT_MISMATCH');
    if (task.deletion || task.terminal_intent || state.closed || state.closing || member.retired
        || !['provisioning', 'active', 'review'].includes(task.state)) return false;
    if (member.instance) assertRetainedRuntime(role, owner.creationActionId, member.instance.cid,
      member.instance.launch, member.instance.session);
    return true;
  }
  if (!owner.roomId || !owner.roomIdentityCid) throw Error('TASK_SUPERVISOR_OWNER_MISSING');
  const room = getRoomRecord(owner.roomId);
  const seat = room?.member_seats.find(member => member.role_name === name);
  if (!task || !room || room.task_id !== task.task_id || room.room_identity_cid !== owner.roomIdentityCid
      || (task.room_id !== undefined && task.room_id !== owner.roomId)
      || (task.room_identity_cid !== undefined && task.room_identity_cid !== owner.roomIdentityCid)
      || role.name !== name || role.identity !== name || startup?.task_id !== owner.taskId
      || startup.room_id !== owner.roomId || startup.room_identity_cid !== owner.roomIdentityCid
      || startup.identity_name !== name || !seat || seat.invite_id !== startup.invite_id
      || seat.cowork_role !== startup.role || provenance?.role !== name
      || provenance.creationActionId !== owner.creationActionId
      || seat.launch?.action_id !== owner.creationActionId
      || (seat.launch.launch_id !== undefined && seat.launch.launch_id !== supervisor.launchId))
    throw Error('TASK_SUPERVISOR_OWNERSHIP_MISMATCH');
  if (task.deletion || task.terminal_intent || room.close || seat.retirement
      || !['provisioning', 'active', 'review'].includes(task.state)
      || !['provisioning', 'active'].includes(room.state)) return false;
  if (task.workspace && (role.cwd !== task.workspace.path
      || JSON.stringify(startup.workspace) !== JSON.stringify(task.workspace)
      || JSON.stringify(room.workspace) !== JSON.stringify(task.workspace))) throw Error('TASK_WORKSPACE_MISMATCH');
  if (seat.identity_cid) assertRetainedRuntime(role, owner.creationActionId, seat.identity_cid);
  return true;
}

/** Resolve the externally recorded CID/action for explicit terminal retirement.
 * Run only after the same launch passed taskSupervisorMayRun's ownership fence.
 * An unpublished failed launch stays for its seat's retry/retirement saga. */
export function taskMemberRetirementProof(name: string): { cid: string; action: string } {
  const dir = agentDir(name, true), metadata = readTempSupervisor(dir), owner = metadata?.taskOwner;
  if (!owner || metadata.role !== name) throw Error('TASK_SUPERVISOR_OWNER_MISSING');
  let cid: string | undefined;
  if (owner.layout) {
    const state = JSON.parse(readProof(join(stateRoot(), 'layouts', `${owner.layout.runId}.json`)));
    const participant = state.participants[owner.layout.participant];
    if (!participant?.owned || participant.instance?.agent !== name || participant.instance?.remote
        || participant.instance?.temporary !== true) throw Error('TASK_LAYOUT_PARTICIPANT_MISMATCH');
    cid = participant.instance.cid;
  } else {
    const seat = owner.roomId && getRoomRecord(owner.roomId)?.member_seats.find(member => member.role_name === name);
    if (!seat || seat.launch?.action_id !== owner.creationActionId || seat.launch.launch_id !== metadata.launchId)
      throw Error('TASK_SUPERVISOR_OWNERSHIP_MISMATCH');
    cid = seat.identity_cid;
  }
  if (!cid) throw Error('TASK_MEMBER_RETIREMENT_CID_MISSING');
  return { cid, action: owner.creationActionId };
}
