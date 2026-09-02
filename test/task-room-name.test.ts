import { describe, expect, it } from 'vitest';

import {
  COWORK_ROOM_IDENTITY_PREFIX, deriveTaskRoomName, TASK_ROOM_NAME_MAX_CODE_POINTS,
} from '../src/rooms-tasks/task-room-name.js';

const TASK_A = '0mtjupjwx6b441d77';
const TASK_B = '0mtjupjwx6b441d78';
const suffix = (taskId: string) => ` [${taskId}]`;
const points = (value: string) => Array.from(value).length;

describe('canonical task title to Cowork room name derivation', () => {
  it('sanitizes slash, backslash, controls, formats, surrogates, and line separators', () => {
    const title = 'A/B\\C\u0000\u200bD\ud800\u2028E';
    expect(deriveTaskRoomName(title, TASK_A)).toBe(
      `A - B - C - D - E${suffix(TASK_A)}`,
    );
  });

  it('trims and collapses whitespace and dash runs around translated separators', () => {
    expect(deriveTaskRoomName('  foo/-/bar —  baz  ', TASK_A)).toBe(
      `foo - bar - baz${suffix(TASK_A)}`,
    );
  });

  it('normalizes to NFC before enforcing the post-normalization limit', () => {
    const decomposed = 'Cafe\u0301 A\u030Angstro\u0308m';
    const result = deriveTaskRoomName(decomposed, TASK_A);
    expect(result).toBe(`Café Ångström${suffix(TASK_A)}`);
    expect(result).toBe(result.normalize('NFC'));

    // U+0344 expands to two code points in NFC. The output remains bounded.
    const expanding = `a${'\u0344'.repeat(40)}z`;
    expect(points(deriveTaskRoomName(expanding, TASK_A))).toBeLessThanOrEqual(
      TASK_ROOM_NAME_MAX_CODE_POINTS,
    );
  });

  it('uses a deterministic non-empty fallback for empty-after-sanitize titles', () => {
    for (const title of ['', '   ', '/\\\u0000\u200b\u2028']) {
      expect(deriveTaskRoomName(title, TASK_A)).toBe(`Task${suffix(TASK_A)}`);
    }
  });

  it('keeps boundary names and generated identities within 64 Unicode code points', () => {
    const exact = deriveTaskRoomName('a'.repeat(32), TASK_A);
    expect(points(exact)).toBe(TASK_ROOM_NAME_MAX_CODE_POINTS);
    expect(points(`${COWORK_ROOM_IDENTITY_PREFIX}${exact}`)).toBe(64);

    const overlong = deriveTaskRoomName('a'.repeat(200), TASK_A);
    expect(overlong).toBe(exact);
  });

  it('bounds multibyte titles by Unicode code points without splitting graphemes', () => {
    const emoji = '👍🏽';
    const result = deriveTaskRoomName(emoji.repeat(20), TASK_A);
    const readable = result.slice(0, -suffix(TASK_A).length);
    expect(points(result)).toBeLessThanOrEqual(TASK_ROOM_NAME_MAX_CODE_POINTS);
    expect(readable).toBe(emoji.repeat(16));
  });

  it('uses the complete task ID to prevent sanitized or truncated collisions', () => {
    expect(deriveTaskRoomName('same/title', TASK_A)).not.toBe(
      deriveTaskRoomName('same\\title', TASK_B),
    );
    expect(deriveTaskRoomName('x'.repeat(200), TASK_A)).not.toBe(
      deriveTaskRoomName('x'.repeat(200), TASK_B),
    );
  });

  it('is deterministic and rejects non-canonical correlation IDs', () => {
    expect(deriveTaskRoomName('Ship it', TASK_A)).toBe(deriveTaskRoomName('Ship it', TASK_A));
    expect(() => deriveTaskRoomName('Ship it', '../bad')).toThrow('invalid canonical task ID');
  });
});
