import { describe, expect, it } from 'vitest';
import {
  buildRoomMemberCharter, parseRoomBriefingAck,
  reconcileBriefingHistory, sha256Text,
} from '../src/rooms-tasks/member-startup.js';
import type { RoomHistoryEvidence } from '../src/rooms-tasks/types.js';

const ROOM_CID = 'A'.repeat(64);
const OWNER_CID = 'B'.repeat(64);
const MEMBER_CID = 'C'.repeat(64);

function charter() {
  return buildRoomMemberCharter({
    taskId: 'task-1', roomId: 'room-1', roomIdentityCid: ROOM_CID,
    ownerSeatCid: OWNER_CID, goal: 'Ship', brief: 'Be exact', contract: 'Review together.',
    member: {
      role_name: 'reviewer-1', cowork_role: 'Reviewer', identity_cid: MEMBER_CID,
      persona: 'Challenge every unsupported claim.',
    },
    roster: [{
      role_name: 'reviewer-1', cowork_role: 'Reviewer', identity_cid: MEMBER_CID,
    }],
  });
}

function ack(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    kind: 'fleet_room_briefing_ack', schema_version: 1,
    room_id: 'room-1', room_identity_cid: ROOM_CID,
    briefing_role: 'Reviewer', briefing_version: 1,
    briefing_sha256: sha256Text(charter()), briefing_message_id: 'briefing-1',
    owner_seat_cid: OWNER_CID, accepted: true, applied: true, profile_applied: true,
    ...overrides,
  });
}

function history(author = MEMBER_CID, ackText = ack()): RoomHistoryEvidence[] {
  return [{
    kind: 'message', seq: 1, record_id: 'room:1', at: '2026-08-24T00:00:00Z',
    message_id: 'briefing-1', category: 'role_briefing',
    author: { identity: ROOM_CID, display_name: 'Room', role: 'room' },
    text: charter(), recipient_identities: [MEMBER_CID],
    briefing_role: 'Reviewer', briefing_version: 1,
  }, {
    kind: 'relay_intent', seq: 2, record_id: 'room:2', at: '2026-08-24T00:00:01Z',
    message_id: 'briefing-1', recipient_identity: MEMBER_CID,
  }, {
    kind: 'relay_result', seq: 3, record_id: 'room:3', at: '2026-08-24T00:00:02Z',
    intent_record_id: 'room:2', message_id: 'briefing-1', recipient_identity: MEMBER_CID,
    status: 'queued', wire_id: 'wire-1',
  }, {
    kind: 'message', seq: 4, record_id: 'room:4', at: '2026-08-24T00:00:03Z',
    message_id: 'ack-1', category: 'chat',
    author: { identity: author, display_name: 'Reviewer', role: 'Owner' },
    text: ackText, recipient_identities: [ROOM_CID],
  }];
}

const expected = () => ({
  roomId: 'room-1', roomIdentityCid: ROOM_CID, ownerSeatCid: OWNER_CID,
  memberCid: MEMBER_CID, role: 'Reviewer', version: 1, sha256: sha256Text(charter()),
});

describe('room member startup contract', () => {
  it('builds a byte-stable role charter with exact room and Owner CIDs and persona', () => {
    const text = charter();
    expect(text).toContain(`Room identity CID: ${ROOM_CID}`);
    expect(text).toContain(`Authenticated Owner seat: ${OWNER_CID}`);
    expect(text).toContain('Challenge every unsupported claim.');
    expect(sha256Text(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('states null Owner semantics explicitly', () => {
    const text = buildRoomMemberCharter({
      roomId: 'room', roomIdentityCid: ROOM_CID, ownerSeatCid: null,
      member: { role_name: 'agent-1', cowork_role: 'Agent', identity_cid: MEMBER_CID },
      roster: [],
    });
    expect(text).toContain('Authenticated Owner seat: none');
    expect(text).toContain('no room participant has Owner authority');
  });

  it('parses only the exact canonical ACK shape and required true assertions', () => {
    expect(parseRoomBriefingAck(ack())).toMatchObject({ profile_applied: true });
    expect(parseRoomBriefingAck(ack({ extra: true }))).toBeUndefined();
    expect(parseRoomBriefingAck(ack({ applied: false }))).toBeUndefined();
    expect(parseRoomBriefingAck(ack({ briefing_sha256: 'A'.repeat(64) }))).toBeUndefined();
  });

  it('accepts an ACK only after matching room-authored briefing and queued relay evidence', () => {
    const result = reconcileBriefingHistory(history(), expected());
    expect(result.briefing).toMatchObject({
      state: 'acknowledged', message_id: 'briefing-1', relay_wire_id: 'wire-1',
      acknowledgement_message_id: 'ack-1', rejected_ack_count: 0,
    });
  });

  it('keeps an exact authenticated ACK non-ready when relay result evidence is missing', () => {
    const records = history().filter(record => record.kind !== 'relay_result');
    const result = reconcileBriefingHistory(records, expected());
    expect(result.briefing.state).toBe('pending');
    expect(result.briefing.last_rejected_ack_reason).toBe('briefing relay was not queued');
  });

  it('increments from durable evidence without double-counting replayed ACKs', () => {
    const first = reconcileBriefingHistory(history().slice(0, 3), expected());
    const second = reconcileBriefingHistory(history(), expected(), first.briefing);
    const replay = reconcileBriefingHistory(history(), expected(), second.briefing);
    expect(second.briefing.state).toBe('acknowledged');
    expect(replay.briefing.rejected_ack_count).toBe(0);
    expect(replay.briefing.acknowledgement_seq).toBe(4);
  });

  it('reports a newer room-authored role briefing as source-of-truth drift', () => {
    const records = history();
    const originalAck = records.at(-1)!;
    originalAck.seq = 5;
    records.splice(3, 0, {
      kind: 'message', seq: 4, record_id: 'room:4-new',
      at: '2026-08-24T00:00:02.500Z', message_id: 'briefing-2',
      category: 'role_briefing',
      author: { identity: ROOM_CID, display_name: 'Room', role: 'room' },
      text: 'new charter', recipient_identities: [MEMBER_CID],
      briefing_role: 'Reviewer', briefing_version: 2,
    });
    expect(reconcileBriefingHistory(records, expected()).drift)
      .toContain('role briefing drift');
  });

  it.each([
    ['spoofed author CID', 'D'.repeat(64), ack()],
    ['wrong message id', MEMBER_CID, ack({ briefing_message_id: 'invented' })],
    ['wrong Owner CID', MEMBER_CID, ack({ owner_seat_cid: 'D'.repeat(64) })],
    ['wrong room author', MEMBER_CID, ack()],
  ])('rejects %s', (_label, author, text) => {
    const records = history(author, text);
    if (_label === 'wrong room author') {
      const first = records[0];
      if (first.kind === 'message') first.author.identity = 'D'.repeat(64);
    }
    const result = reconcileBriefingHistory(records, expected());
    expect(result.briefing.state).not.toBe('acknowledged');
  });

  it('bounds rejected ACK observability to count and last reason/seq', () => {
    const records = history(MEMBER_CID, ack({ briefing_version: 9 }));
    records.push({
      ...(records.at(-1)! as RoomHistoryEvidence & { kind: 'message' }),
      seq: 5, record_id: 'room:5', message_id: 'ack-2',
      text: ack({ briefing_message_id: 'wrong' }),
    });
    const result = reconcileBriefingHistory(records, expected());
    expect(result.briefing).toMatchObject({
      rejected_ack_count: 2, last_rejected_ack_reason: 'briefing_message_id mismatch',
      last_rejected_ack_seq: 5,
    });
    expect(result.briefing).not.toHaveProperty('rejected_acks');
  });

});
