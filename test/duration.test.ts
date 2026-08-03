import { describe, it, expect } from 'vitest';
import { parseDuration, formatDuration } from '../src/duration.js';

describe('parseDuration', () => {
  it('parses seconds, minutes, hours', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });
  it('rejects malformed values with the offending text', () => {
    for (const bad of ['', '10', 'm10', '1.5h', '10 m', '-5m'])
      expect(() => parseDuration(bad, { name: 'interval' }))
        .toThrowError(new RegExp(`interval.*'${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  });
  it('supports whole days', () => expect(parseDuration('10d')).toBe(864_000_000));
  it('enforces a minimum', () => {
    expect(() => parseDuration('30s', { name: 'interval', minMs: 60_000 }))
      .toThrowError(/interval.*minimum.*1m/);
    expect(parseDuration('1m', { minMs: 60_000 })).toBe(60_000);
  });
});

describe('formatDuration', () => {
  it('picks the largest exact unit', () => {
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(90_000)).toBe('90s');
  });
});
