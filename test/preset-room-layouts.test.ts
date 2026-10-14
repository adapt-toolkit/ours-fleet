/** The shipped room layouts are the standard room templates in layout form: same seats, flags and contract. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateRoomLayout } from '../src/rooms-tasks/layout-config.js';

const presets = join(import.meta.dirname, '..', 'presets', 'fleet');
const read = (kind: string, name: string) => parse(readFileSync(join(presets, kind, `${name}.yaml`), 'utf8'));
const words = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('preset room layouts', () => {
  for (const name of ['single', 'pair', 'team', 'engineering']) it(`${name} matches its room template`, () => {
    const template = read('room_templates', name);
    const layout = validateRoomLayout(read('room_layouts', name), name);
    const rooms = Object.values(layout.rooms);
    expect(rooms).toHaveLength(1);
    const [room] = rooms;
    // One participant per seat, same agent template and room role, in seat order.
    expect(room.members).toEqual(template.members.map((m: { slot: string }) => m.slot));
    for (const seat of template.members) {
      expect(seat.count).toBe(1);
      expect(layout.participants[seat.slot]).toEqual({ agent_template: seat.agent_template });
      expect(room.roles?.[seat.slot]).toBe(seat.role);
    }
    // Room flags are explicit, so engine defaults (quiet membership on) cannot change behaviour.
    expect(room.quiet_membership).toBe(template.room?.quiet_membership ?? true);
    expect(room.anonymous).toBe(template.room?.anonymous ?? false);
    expect(Object.hasOwn(room, 'quiet_membership') && Object.hasOwn(room, 'anonymous')).toBe(true);
    expect(words(room.contract!)).toBe(words(template.contract));
  });
});
