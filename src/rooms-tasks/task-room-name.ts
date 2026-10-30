/**
 * Cowork room identities are named `ours-cowork:<room name>` and both the
 * room and identity contracts count NFC-normalized Unicode code points.
 * Keeping the complete task ID inside that shared budget makes every derived
 * name stable, directly correlated, and unique even when the title is empty,
 * sanitized, or truncated.
 */
export const COWORK_ROOM_IDENTITY_PREFIX = 'ours-cowork:';
export const COWORK_IDENTITY_NAME_MAX_CODE_POINTS = 64;
export const TASK_ROOM_NAME_MAX_CODE_POINTS = COWORK_IDENTITY_NAME_MAX_CODE_POINTS
  - Array.from(COWORK_ROOM_IDENTITY_PREFIX).length;

const TASK_ID_PATTERN = /^[0-9a-z]{9}[0-9a-f]{8}$/;
const FORBIDDEN = /[\\/\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const DASH_SEPARATOR = /\p{Pd}/u;
const WHITESPACE = /\s/u;
const FALLBACK_TITLE = 'Task';

function sanitizeTitle(title: string): string {
  const normalized = title.normalize('NFC');
  let result = '';
  let pending: 'space' | 'separator' | undefined;
  for (const character of normalized) {
    if (FORBIDDEN.test(character) || DASH_SEPARATOR.test(character)) {
      pending = 'separator';
    } else if (WHITESPACE.test(character)) {
      if (pending !== 'separator') pending = 'space';
    } else {
      if (result && pending) result += pending === 'separator' ? ' - ' : ' ';
      result += character;
      pending = undefined;
    }
  }
  return result;
}

/** Truncate to a code-point budget without cutting an extended grapheme. */
function graphemeBound(value: string, maxCodePoints: number): string {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  let result = '';
  let length = 0;
  for (const { segment } of segmenter.segment(value)) {
    const segmentLength = Array.from(segment).length;
    if (length + segmentLength > maxCodePoints) break;
    result += segment;
    length += segmentLength;
  }
  return result.trimEnd();
}

const MISSION_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,5}-[1-9][0-9]{0,8}$/;

/**
 * Canonical Cowork room name for a Fleet task; never mutates the task title.
 * With a mission key the key leads (`MSN-1 Title [id]`), so it survives the
 * room-identity cut; the canonical suffix keeps the name unique on a daemon
 * shared by several Fleets.
 */
export function deriveTaskRoomName(title: string, taskId: string, missionKey?: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`invalid canonical task ID: ${taskId}`);
  if (missionKey !== undefined && !MISSION_KEY_PATTERN.test(missionKey))
    throw new Error(`invalid mission key: ${missionKey}`);
  const lead = missionKey ? `${missionKey} ` : '';
  const suffix = ` [${taskId}]`;
  const titleBudget = TASK_ROOM_NAME_MAX_CODE_POINTS - Array.from(lead + suffix).length;
  const readable = sanitizeTitle(title);
  const bounded = graphemeBound(readable || FALLBACK_TITLE, titleBudget) || FALLBACK_TITLE;
  return `${lead}${bounded}${suffix}`;
}
