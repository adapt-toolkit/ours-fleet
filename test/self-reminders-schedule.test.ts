import { describe, expect, it } from 'vitest';

import { ReminderScheduleError, resolveSchedule } from '../src/reminders/schedule.js';

const code = (run: () => unknown): string => {
  try { run(); } catch (error) { return (error as ReminderScheduleError).code; }
  return 'resolved';
};

describe('self-reminder wall-clock resolution', () => {
  it('resolves an explicit local time in an explicit IANA zone, never the host zone', () => {
    expect(resolveSchedule('2027-01-20T16:00', 'UTC')).toEqual({
      localTime: '2027-01-20T16:00:00', timeZone: 'UTC', dueAt: Date.parse('2027-01-20T16:00:00Z'),
    });
    expect(resolveSchedule('2027-01-20T16:00:00', 'Europe/London').dueAt).toBe(Date.parse('2027-01-20T16:00:00Z'));
    expect(resolveSchedule('2027-07-20T16:00', 'Europe/London').dueAt).toBe(Date.parse('2027-07-20T15:00:00Z'));
    expect(resolveSchedule('2027-07-20T09:30', 'America/New_York').dueAt).toBe(Date.parse('2027-07-20T13:30:00Z'));
    expect(resolveSchedule('2027-07-20T09:30', 'Asia/Kolkata').dueAt).toBe(Date.parse('2027-07-20T04:00:00Z'));
  });

  it('refuses a time skipped by a spring-forward gap', () => {
    expect(code(() => resolveSchedule('2027-03-28T01:30', 'Europe/London'))).toBe('nonexistent_local_time');
    expect(code(() => resolveSchedule('2027-03-14T02:30', 'America/New_York'))).toBe('nonexistent_local_time');
    // The instants around the gap are fine.
    expect(resolveSchedule('2027-03-28T00:59', 'Europe/London').dueAt).toBe(Date.parse('2027-03-28T00:59:00Z'));
    expect(resolveSchedule('2027-03-28T02:00', 'Europe/London').dueAt).toBe(Date.parse('2027-03-28T01:00:00Z'));
  });

  it('requires fold for a time repeated by a fall-back overlap, and honours it', () => {
    expect(code(() => resolveSchedule('2027-10-31T01:30', 'Europe/London'))).toBe('ambiguous_local_time');
    expect(resolveSchedule('2027-10-31T01:30', 'Europe/London', 0))
      .toMatchObject({ fold: 0, dueAt: Date.parse('2027-10-31T00:30:00Z') });
    expect(resolveSchedule('2027-10-31T01:30', 'Europe/London', 1))
      .toMatchObject({ fold: 1, dueAt: Date.parse('2027-10-31T01:30:00Z') });
    expect(resolveSchedule('2027-11-07T01:15', 'America/New_York', 1).dueAt).toBe(Date.parse('2027-11-07T06:15:00Z'));
    // fold is ignored information on an unambiguous time, not a reason to fail.
    expect(resolveSchedule('2027-07-20T16:00', 'Europe/London', 1)).not.toHaveProperty('fold');
    expect(code(() => resolveSchedule('2027-10-31T01:30', 'Europe/London', 2))).toBe('invalid_fold');
  });

  it('handles a half-hour daylight-saving zone', () => {
    // Lord Howe Island moves 30 minutes: 02:00 -> 02:30 on 2027-10-03.
    expect(code(() => resolveSchedule('2027-10-03T02:15', 'Australia/Lord_Howe'))).toBe('nonexistent_local_time');
    expect(code(() => resolveSchedule('2027-04-04T01:45', 'Australia/Lord_Howe'))).toBe('ambiguous_local_time');
  });

  it('refuses offsets, missing dates, impossible dates and unknown zones', () => {
    for (const bad of ['2027-01-20T16:00Z', '2027-01-20T16:00+01:00', '16:00', '2027-01-20', '2027-01-20 16:00',
      '2027-02-30T10:00', '2027-13-01T10:00', '2027-01-20T24:00', '2027-01-20T10:60', 20270120, null])
      expect(code(() => resolveSchedule(bad, 'UTC'))).toBe('invalid_local_time');
    for (const zone of ['Mars/Olympus', 'local', '', '../../etc/passwd', 42, undefined])
      expect(code(() => resolveSchedule('2027-01-20T16:00', zone))).toBe('invalid_time_zone');
  });

  it('canonicalizes zone aliases', () => {
    expect(resolveSchedule('2027-01-20T16:00', 'utc').timeZone).toBe('UTC');
  });
});
