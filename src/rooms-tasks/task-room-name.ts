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

/** Canonical Cowork room name for a Fleet task; never mutates the task title. */
export function deriveTaskRoomName(title: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`invalid canonical task ID: ${taskId}`);
  const suffix = ` [${taskId}]`;
  const titleBudget = TASK_ROOM_NAME_MAX_CODE_POINTS - Array.from(suffix).length;
  const readable = sanitizeTitle(title);
  const bounded = graphemeBound(readable || FALLBACK_TITLE, titleBudget) || FALLBACK_TITLE;
  return `${bounded}${suffix}`;
}
