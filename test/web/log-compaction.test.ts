import { describe, expect, it } from 'vitest';
import { compactMonitorStreamHiccups } from '../../src/application/log-service.js';
import type { LogRecord } from '../../src/application/types.js';

const record = (at: string, text: string, cursor: string): LogRecord => ({
  at, text, cursor, redactionApplied: false,
});

describe('web monitor-hiccup log compaction', () => {
  it('compacts only consecutive identical reasons and retains range evidence', () => {
    const records = compactMonitorStreamHiccups([
      record('2026-07-31T09:00:00.000Z', 'monitor degraded: stream hiccup (fetch failed)', 'a1'),
      record('2026-07-31T09:00:01.000Z', 'monitor degraded: stream hiccup (fetch failed)', 'a2'),
      record('2026-07-31T09:00:02.000Z', 'monitor degraded: stream hiccup (This operation was aborted)', 'b1'),
      record('2026-07-31T09:00:03.000Z', 'monitor degraded: stream hiccup (This operation was aborted)', 'b2'),
      record('2026-07-31T09:00:04.000Z', 'different backend failure', 'different'),
      record('2026-07-31T09:00:05.000Z', 'monitor degraded: stream hiccup (fetch failed)', 'a3'),
      record('2026-07-31T09:00:06.000Z', 'monitor degraded: stream hiccup (fetch failed)', 'a4'),
      record('2026-07-31T09:00:07.000Z', 'monitor degraded: stream hiccup (single)', 'single'),
    ]);

    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      text: 'monitor degraded: stream hiccup', cursor: 'a2',
      compacted: {
        reason: 'fetch failed', count: 2,
        firstAt: '2026-07-31T09:00:00.000Z', lastAt: '2026-07-31T09:00:01.000Z',
      },
    });
    expect(records[1].compacted).toMatchObject({
      reason: 'This operation was aborted', count: 2,
    });
    expect(records[2]).toMatchObject({ text: 'different backend failure', cursor: 'different' });
    expect(records[3].compacted).toMatchObject({ reason: 'fetch failed', count: 2 });
    expect(records[4].text).toBe('monitor degraded: stream hiccup (single)');
    expect(records[4].compacted).toBeUndefined();
  });
});
