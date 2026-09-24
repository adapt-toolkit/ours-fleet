import { mkdirSync } from 'node:fs';
import { agentDir } from '../src/paths.js';
import { prepareTempSupervisor } from '../src/temp-lifecycle.js';
import { getRoomRecord, updateMemberStartup } from '../src/rooms-tasks/room-state.js';

/** Give a presentation fixture real durable launch IDs; its live transports are mocked separately. */
export function prepareReadinessMembers(roomId: string): void {
  for (const seat of getRoomRecord(roomId)!.member_seats) {
    mkdirSync(agentDir(seat.role_name, true), { recursive: true });
    const supervisor = prepareTempSupervisor(agentDir(seat.role_name, true), seat.role_name);
    if (seat.launch) updateMemberStartup(roomId, seat.role_name, { launch: { ...seat.launch, launch_id: supervisor.launchId } });
  }
}

export function healthyCoworkRoom(roomId: string) {
  const room = getRoomRecord(roomId)!;
  return { room_id: roomId, room_name: room.room_name, identity_name: 'fixture',
    identity_cid: room.room_identity_cid!, state: room.state, anonymous: false, role_briefings: {},
    seats: room.member_seats.map(seat => ({ identity_cid: seat.identity_cid!, display_name: seat.role_name,
      role: seat.cowork_role, invite_id: 'fixture', seat_state: seat.seat_state })),
  };
}
