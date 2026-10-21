/**
 * Wall-clock schedule resolution for self-reminders.
 *
 * A reminder is stated the way a person states it — a calendar date, a time of
 * day and the IANA zone it is meant in — and stored as the one UTC instant that
 * statement denotes. Nothing is inferred from the host's own zone: a time with
 * an offset, a missing date or an unknown zone is refused rather than guessed.
 *
 * Daylight-saving transitions are the two places a wall time is not one
 * instant. A time skipped by a spring-forward gap does not exist and is
 * refused. A time repeated by a fall-back overlap exists twice, and the caller
 * must say which with `fold` (0 = the first occurrence, 1 = the second), the
 * same convention as Python's `datetime.fold`.
 */

export class ReminderScheduleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReminderScheduleError';
  }
}

const LOCAL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const HOUR_MS = 60 * 60 * 1000;

interface WallTime {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', era: 'short',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

/** Canonical IANA zone name, or a typed refusal. Host defaults never apply. */
export function canonicalTimeZone(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw))
    throw new ReminderScheduleError('invalid_time_zone', 'time_zone must be an IANA zone name such as Europe/London or UTC');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    throw new ReminderScheduleError('invalid_time_zone', `unknown IANA time zone '${raw}'`);
  }
}

function parseLocalTime(raw: unknown): WallTime {
  const match = typeof raw === 'string' ? LOCAL_TIME_RE.exec(raw) : null;
  if (!match)
    throw new ReminderScheduleError('invalid_local_time',
      'local_time must be a calendar date and time without an offset, e.g. 2027-01-20T16:00 or 2027-01-20T16:00:00');
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? 0));
  const wall = { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! };
  // Date.UTC normalizes overflow (Feb 30 -> Mar 2); a round trip rejects it.
  const probe = new Date(wallMs(wall));
  if (wall.year < 1970 || wall.year > 9999 || probe.getUTCFullYear() !== wall.year
      || probe.getUTCMonth() + 1 !== wall.month || probe.getUTCDate() !== wall.day
      || wall.hour > 23 || wall.minute > 59 || wall.second > 59)
    throw new ReminderScheduleError('invalid_local_time', `local_time '${String(raw)}' is not a real calendar date and time`);
  return wall;
}

function wallMs(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** The wall-clock reading of `instant` in `timeZone`, expressed as naive UTC milliseconds. */
function wallAt(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant))
    .map(part => [part.type, part.value]));
  if (parts.era !== 'AD') throw new ReminderScheduleError('invalid_local_time', 'dates before the common era are not supported');
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
}

export interface ResolvedSchedule {
  /** Canonical `YYYY-MM-DDTHH:MM:SS`, as the caller meant it. */
  localTime: string;
  timeZone: string;
  /** Present only when the wall time was ambiguous and the caller chose. */
  fold?: 0 | 1;
  dueAt: number;
}

/**
 * Resolve a wall time in a zone to its instant. Every offset the zone uses in
 * the surrounding two days is a candidate; a candidate survives only if it
 * reads back as the requested wall time. Zero survivors is a gap, two is an
 * overlap. Zones change offset at most once in any such window in practice,
 * and a reading that does not round-trip is never accepted, so the answer is
 * never a guess.
 */
export function resolveSchedule(localTime: unknown, timeZone: unknown, fold?: unknown): ResolvedSchedule {
  const zone = canonicalTimeZone(timeZone);
  const wall = parseLocalTime(localTime);
  if (fold !== undefined && fold !== null && fold !== 0 && fold !== 1)
    throw new ReminderScheduleError('invalid_fold', 'fold must be 0 (first occurrence) or 1 (second occurrence)');
  const naive = wallMs(wall);
  const offsets = new Set<number>();
  for (let probe = -48; probe <= 48; probe += 6) {
    const instant = naive + probe * HOUR_MS;
    offsets.add(wallAt(instant, zone) - instant);
  }
  const matches = [...new Set([...offsets].map(offset => naive - offset))]
    .filter(instant => wallAt(instant, zone) === naive)
    .sort((a, b) => a - b);
  const canonical = new Date(naive).toISOString().slice(0, 19);
  if (!matches.length)
    throw new ReminderScheduleError('nonexistent_local_time',
      `${canonical} does not exist in ${zone} (skipped by a daylight-saving change); choose another time`);
  if (matches.length > 1) {
    if (fold !== 0 && fold !== 1)
      throw new ReminderScheduleError('ambiguous_local_time',
        `${canonical} occurs twice in ${zone}; pass fold 0 for the first occurrence or 1 for the second`);
    return { localTime: canonical, timeZone: zone, fold, dueAt: matches[fold]! };
  }
  return { localTime: canonical, timeZone: zone, dueAt: matches[0]! };
}
