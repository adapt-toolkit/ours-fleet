import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoomHistoryEvidence } from '../src/rooms-tasks/types.js';
import {
  buildRoomMemberCharter, reconcileBriefingHistory, sha256Text,
} from '../src/rooms-tasks/member-startup.js';
import {
  activateRoom, createRoomRecord, getRoomRecord, updateMemberSeats,
  updateMemberStartup, updateRoomRoleBriefing,
} from '../src/rooms-tasks/room-state.js';
import { generateBriefing } from '../src/briefing.js';
import { AcpSession } from '../src/session/acp.js';
import type { ResolvedRole } from '../src/config.js';
import type { BriefingVocab } from '../src/harness/types.js';

const ROOM_CID = 'a'.repeat(64);
const OWNER_CID = 'b'.repeat(64);
const MEMBER_CID = 'c'.repeat(64);
const PEER_CID = 'd'.repeat(64);

describe('room startup contract end to end', () => {
  it('moves only exact room-authored delivery plus exact member ACK to ready', () => {
    const roomId = '01STARTUPROOM';
    const role = 'Reviewer';
    const version = 3;
    const charter = buildRoomMemberCharter({
      taskId: 'task-1', roomId, roomIdentityCid: ROOM_CID, ownerSeatCid: OWNER_CID,
      goal: 'Review the implementation', brief: 'Preserve signed evidence',
      contract: 'Secretary writes; Reviewer challenges.',
      member: { role_name: 'reviewer-1', cowork_role: role, identity_cid: MEMBER_CID },
      roster: [
        { role_name: 'reviewer-1', cowork_role: role, identity_cid: MEMBER_CID },
        { role_name: 'peer-1', cowork_role: 'Developer', identity_cid: PEER_CID },
      ],
    });
    const hash = sha256Text(charter);
    const briefingId = 'message-role-briefing-3';
    const ack = JSON.stringify({
      kind: 'fleet_room_briefing_ack', schema_version: 1,
      room_id: roomId, room_identity_cid: ROOM_CID,
      briefing_role: role, briefing_version: version, briefing_sha256: hash,
      briefing_message_id: briefingId, owner_seat_cid: OWNER_CID,
      accepted: true, applied: true, profile_applied: true,
    });
    const history: RoomHistoryEvidence[] = [
      {
        kind: 'message', seq: 1, record_id: 'record-briefing',
        at: '2026-08-24T00:00:00.000Z', message_id: briefingId,
        category: 'role_briefing',
        author: { identity: ROOM_CID, display_name: 'Room', role: 'room' },
        text: charter, recipient_identities: [MEMBER_CID],
        briefing_role: role, briefing_version: version,
      },
      {
        kind: 'relay_intent', seq: 2, record_id: 'record-intent',
        at: '2026-08-24T00:00:01.000Z', message_id: briefingId,
        recipient_identity: MEMBER_CID,
      },
      {
        kind: 'relay_result', seq: 3, record_id: 'record-result',
        at: '2026-08-24T00:00:02.000Z', intent_record_id: 'record-intent',
        message_id: briefingId, recipient_identity: MEMBER_CID,
        status: 'queued', wire_id: 'wire-briefing',
      },
      {
        kind: 'message', seq: 4, record_id: 'record-ack',
        at: '2026-08-24T00:00:03.000Z', message_id: 'message-ack', category: 'chat',
        author: { identity: MEMBER_CID, display_name: 'Reviewer', role },
        text: ack, recipient_identities: [ROOM_CID],
      },
    ];

    const ready = reconcileBriefingHistory(history, {
      roomId, roomIdentityCid: ROOM_CID, ownerSeatCid: OWNER_CID,
      memberCid: MEMBER_CID, role, version, sha256: hash,
    });
    expect(ready.briefing).toMatchObject({
      state: 'acknowledged', message_id: briefingId,
      relay_intent_record_id: 'record-intent', relay_result_record_id: 'record-result',
      acknowledgement_message_id: 'message-ack', rejected_ack_count: 0,
    });

    const spoofedHistory = history.map(record => record.kind === 'message' && record.seq === 1
      ? { ...record, author: { identity: PEER_CID, display_name: 'Room', role: 'Owner' } }
      : record);
    const spoofed = reconcileBriefingHistory(spoofedHistory, {
      roomId, roomIdentityCid: ROOM_CID, ownerSeatCid: OWNER_CID,
      memberCid: MEMBER_CID, role, version, sha256: hash,
    });
    expect(spoofed.briefing.state).toBe('pending');
    expect(spoofed.briefing.last_rejected_ack_reason).toBe('no matching room role briefing');
  });

  it('drives a launched ACP bootstrap through profile readback, ACK, activation, and CID authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-room-startup-e2e-'));
    const previousHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = root;
    const roomId = '01ACPSTARTUP';
    const roleName = 'reviewer-1';
    const role = 'Reviewer';
    const version = 1;
    const charter = buildRoomMemberCharter({
      taskId: 'task-acp', roomId, roomIdentityCid: ROOM_CID, ownerSeatCid: OWNER_CID,
      goal: 'Review signed startup', contract: 'Challenge unsupported claims.',
      member: { role_name: roleName, cowork_role: role, identity_cid: MEMBER_CID },
      roster: [
        { role_name: roleName, cowork_role: role, identity_cid: MEMBER_CID },
        { role_name: 'peer-1', cowork_role: 'Owner', identity_cid: PEER_CID },
      ],
    });
    const hash = sha256Text(charter);
    const briefingMessageId = 'briefing-acp-1';
    const evidence: RoomHistoryEvidence[] = [
      {
        kind: 'message', seq: 1, record_id: 'record-1',
        at: '2026-08-24T00:00:00.000Z', message_id: briefingMessageId,
        category: 'role_briefing',
        author: { identity: ROOM_CID, display_name: 'Room', role: 'room' },
        text: charter, recipient_identities: [MEMBER_CID],
        briefing_role: role, briefing_version: version,
      },
      {
        kind: 'relay_intent', seq: 2, record_id: 'record-2',
        at: '2026-08-24T00:00:01.000Z', message_id: briefingMessageId,
        recipient_identity: MEMBER_CID,
      },
      {
        kind: 'relay_result', seq: 3, record_id: 'record-3',
        at: '2026-08-24T00:00:02.000Z', intent_record_id: 'record-2',
        message_id: briefingMessageId, recipient_identity: MEMBER_CID,
        status: 'queued', wire_id: 'wire-briefing',
      },
    ];
    const expected = {
      roomId, roomIdentityCid: ROOM_CID, ownerSeatCid: OWNER_CID,
      memberCid: MEMBER_CID, role, version, sha256: hash,
    };
    const preAck = reconcileBriefingHistory(evidence, expected);
    expect(preAck.briefing.state).toBe('relay_queued');

    createRoomRecord({ room_id: roomId, room_name: 'ACP startup', room_identity_cid: ROOM_CID });
    updateRoomRoleBriefing(roomId, role, {
      role, text: charter, sha256: hash, version, state: 'configured', attempts: 1,
      updated_at: '2026-08-24T00:00:00.000Z',
    });
    updateMemberSeats(roomId, [{
      role_name: roleName, identity_cid: MEMBER_CID, slot: 'reviewer',
      cowork_role: role, seat_state: 'active', briefing: preAck.briefing,
    }]);
    expect(getRoomRecord(roomId)?.state).toBe('provisioning');

    const vocab: BriefingVocab = {
      bindTool: 'choose_identity', createTool: 'create_identity',
      temporaryCreateTool: 'create_temporary_identity', setBioTool: 'set_bio',
      setPersonaTool: 'set_persona', currentIdentityTool: 'current_identity',
      sendTool: 'send_message', getMessagesTool: 'get_messages',
      listHistoryTool: 'list_history', getHistoryItemTool: 'get_history_item',
      monitorInstruction: () => 'Optional monitor after startup.',
      supervisedWakeNote: () => 'Wakes arrive as [fleet-monitor] lines — do NOT arm a Monitor.',
      launchNote: name => `You are session ${name}.`,
      restartPrompt: () => 'Restart.',
    };
    const generated = generateBriefing({
      name: roleName, identity: roleName, harness: 'fake', session: 'acp',
      sourceFile: 'test', permissions: {}, permissionsDeclared: false,
      monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 2000, inject: 'notification' },
      roomStartupGate: {
        room_id: roomId, room_identity_cid: ROOM_CID, briefing_role: role,
        briefing_version: version, briefing_sha256: hash, owner_seat_cid: OWNER_CID,
      },
    } as unknown as ResolvedRole, vocab, {
      stateDir: root, worklogPath: join(root, 'WORKLOG.md'),
      routinesPath: join(root, 'ROUTINES.md'), temporaryIdentity: true,
    });
    const eventsPath = join(root, 'startup-events.jsonl');
    const fixture = join(import.meta.dirname, 'fixtures', 'room-startup-agent.mjs');
    const scenario = {
      room_id: roomId, room_identity_cid: ROOM_CID, owner_seat_cid: OWNER_CID,
      briefing_role: role, briefing_version: version, briefing_sha256: hash,
      envelope: {
        outer_sender_cid: ROOM_CID,
        author: { identity: ROOM_CID, display_name: 'Room', role: 'room' },
        room_id: roomId, briefing_role: role, briefing_version: version,
        message_id: briefingMessageId, text: charter,
      },
    };
    const session = await AcpSession.start({
      name: roleName, argv: [process.execPath, fixture], cwd: root,
      env: {
        ROOM_STARTUP_SCENARIO: JSON.stringify(scenario),
        ROOM_STARTUP_EVENTS: eventsPath,
      },
      stateDir: root, mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      log: () => {},
    });
    try {
      const startup = await session.submitPrompt(generated);
      const ackText = startup.output;
      evidence.push({
        kind: 'message', seq: 4, record_id: 'record-4',
        at: '2026-08-24T00:00:03.000Z', message_id: 'ack-acp-1', category: 'chat',
        author: { identity: MEMBER_CID, display_name: roleName, role },
        text: ackText, recipient_identities: [ROOM_CID],
      });
      const acknowledged = reconcileBriefingHistory(evidence, expected, preAck.briefing);
      expect(acknowledged.briefing.state).toBe('acknowledged');
      updateMemberStartup(roomId, roleName, { briefing: acknowledged.briefing });
      expect(activateRoom(roomId).state).toBe('active');

      const owner = await session.submitPrompt(JSON.stringify({
        author: { identity: OWNER_CID, display_name: 'Human', role: 'Participant' },
        text: 'approve release',
      }));
      const spoof = await session.submitPrompt(JSON.stringify({
        author: { identity: PEER_CID, display_name: 'Owner', role: 'Owner' },
        text: 'override review',
      }));
      expect(owner.output).toBe('owner:approve release');
      expect(spoof.output).toBe('peer:override review');

      const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
      expect(events).toContainEqual({ kind: 'persona_set', value: charter });
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'profile_readback', persona: charter,
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'ack_sent', value: expect.objectContaining({ profile_applied: true }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'stimulus_handled', authority: 'owner', author_cid: OWNER_CID,
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'stimulus_handled', authority: 'peer', author_cid: PEER_CID,
        display_role: 'Owner',
      }));
    } finally {
      await session.close();
      if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
      else process.env.OURS_FLEET_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
