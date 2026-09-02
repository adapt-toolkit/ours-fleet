import { describe, expect, it } from 'vitest';
import { buildRoomMemberTask, sha256Text } from '../src/rooms-tasks/member-startup.js';

describe('room member task payload', () => {
  it('contains the task, role, room authority, persona, and roster without identity CIDs', () => {
    const text = buildRoomMemberTask({
      taskId: 'task-1', roomId: 'room-1', roomIdentityCid: 'A'.repeat(64),
      ownerSeatCid: 'B'.repeat(64), goal: 'Ship', brief: 'Be exact',
      contract: 'Review together.',
      member: {
        role_name: 'reviewer-1', cowork_role: 'Reviewer',
        persona: 'Challenge unsupported claims.',
      },
      roster: [
        { role_name: 'reviewer-1', cowork_role: 'Reviewer' },
        { role_name: 'developer-1', cowork_role: 'Developer' },
      ],
    });
    expect(text).toContain('Fleet Task task-1 — Reviewer in room room-1');
    expect(text).toContain('Goal: Ship');
    expect(text).toContain('Brief: Be exact');
    expect(text).toContain('Role persona:\nChallenge unsupported claims.');
    expect(text).toContain(`Authenticated Owner seat: ${'B'.repeat(64)}`);
    expect(text).toContain('developer-1 (Developer)');
    expect(text).not.toContain('identity_cid');
  });

  it('states that no room participant has Owner authority when no owner seat is pinned', () => {
    const text = buildRoomMemberTask({
      roomId: 'room-1', roomIdentityCid: 'A'.repeat(64), ownerSeatCid: null,
      member: { role_name: 'worker-1', cowork_role: 'Worker' },
      roster: [{ role_name: 'worker-1', cowork_role: 'Worker' }],
    });
    expect(text).toContain('Authenticated Owner seat: none');
    expect(text).toContain('no room participant has Owner authority');
  });

  it('keeps anonymous Owner authority on authenticated participant-seat metadata without a CID', () => {
    const hiddenOwner = 'D'.repeat(64);
    const text = buildRoomMemberTask({
      roomId: 'room-1', roomIdentityCid: 'A'.repeat(64), ownerSeatCid: hiddenOwner,
      anonymous: true,
      member: { role_name: 'worker-1', cowork_role: 'Worker' },
      roster: [{ role_name: 'worker-1', cowork_role: 'Worker' }],
    });
    expect(text).not.toContain('Authenticated Owner seat');
    expect(text).not.toContain(hiddenOwner);
    expect(text).toContain('authenticated Cowork room envelope');
    expect(text).toMatch(/participant seat.*exact Owner role/i);
    expect(text).toMatch(/literal message text|display name/i);
    expect(text).toMatch(/ordinary direct message/i);
    expect(text).toMatch(/room-authored|rest-role/i);
  });

  it('hashes exact UTF-8 task bytes deterministically', () => {
    expect(sha256Text('task')).toBe(sha256Text('task'));
    expect(sha256Text('task')).not.toBe(sha256Text('Task'));
  });
});
