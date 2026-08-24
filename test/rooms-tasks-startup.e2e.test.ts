import { describe, expect, it } from 'vitest';
import type { RoomHistoryEvidence } from '../src/rooms-tasks/types.js';
import {
  buildRoomMemberCharter, classifyRoomAuthor, reconcileBriefingHistory, sha256Text,
} from '../src/rooms-tasks/member-startup.js';

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

  it('derives Owner authority only from the pinned author CID', () => {
    expect(classifyRoomAuthor(OWNER_CID, OWNER_CID)).toBe('owner');
    expect(classifyRoomAuthor(PEER_CID, OWNER_CID)).toBe('peer');
    expect(classifyRoomAuthor(OWNER_CID, null)).toBe('peer');
    // Display names and claimed roles never enter the authorization function.
    const spoof = { identity: PEER_CID, display_name: 'Owner', role: 'Owner' };
    expect(classifyRoomAuthor(spoof.identity, OWNER_CID)).toBe('peer');
  });
});
