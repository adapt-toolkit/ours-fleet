import type { RoomLayoutDefinition } from './layout-config.js';

/** Reserved built-in source; task runs snapshot it just like a saved layout. */
export const EMPTY_TASK_LAYOUT = 'builtin-empty';
export const EMPTY_TASK_ROOM = 'mission';
export function emptyTaskLayout(): RoomLayoutDefinition {
  return { version: 1, participants: {}, rooms: {
    [EMPTY_TASK_ROOM]: { goal: 'Work on the mission', members: [] },
  } };
}
