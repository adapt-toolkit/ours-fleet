import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendLineAtomic, readLog, type LogIo } from '../src/session/event-log.js';
import { SessionEvents } from '../src/session/events.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ours-event-integrity-'));
  dirs.push(dir);
  return dir;
}

const record = (seq: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, seq, at: `2026-08-13T06:32:${String(seq % 60).padStart(2, '0')}.000Z`, kind: 'tool_update', ...extra,
});

/**
 * The 06:32 incident bytes, verbatim in shape: a 31-byte partial prefix of seq
 * 715 fused with the complete seq 732 record the kernel wrote once space freed.
 */
const FUSED_INCIDENT_LINE =
  '{"version":1,"seq":715,"at":"20'
  + '{"version":1,"seq":732,"at":"2026-08-13T06:33:48.197Z","kind":"tool_update","toolCallId":"toolu_01SmsMPMbJBsD7GRDrxmNC86"}';

function incidentLog(path: string): void {
  writeFileSync(path, [
    record(713, { toolCallId: 'toolu_a' }),
    record(714, { toolCallId: 'toolu_01K7kVMbbgBSqmEiPGQEdpe5', status: 'completed' }),
    FUSED_INCIDENT_LINE,
    record(733, { toolCallId: 'toolu_01SmsMPMbJBsD7GRDrxmNC86', status: 'completed' }),
    '',
  ].join('\n'), { mode: 0o600 });
}

/** Real fs, but the first writeSync of every attempt stops short and then reports ENOSPC. */
function shortWriteIo(realIo: LogIo, prefixBytes: number, opts: { rollbackFails?: boolean } = {}): LogIo {
  return {
    ...realIo,
    writeSync(fd, data, offset, length) {
      if (offset === 0 && length > prefixBytes) {
        realIo.writeSync(fd, data, 0, prefixBytes);
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return realIo.writeSync(fd, data, offset, length);
    },
    ftruncateSync(fd, len) {
      if (opts.rollbackFails) {
        const error = new Error('EIO: i/o error, ftruncate') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      realIo.ftruncateSync(fd, len);
    },
  };
}

describe('appendLineAtomic', () => {
  it('rolls a short write back so no partial record is left on disk', async () => {
    const { nodeLogIo } = await import('../src/session/event-log.js');
    const path = join(workspace(), 'events.jsonl');
    appendLineAtomic(path, record(1));
    const committed = readFileSync(path, 'utf8');

    expect(() => appendLineAtomic(path, record(2), { io: shortWriteIo(nodeLogIo, 31) })).toThrow(/ENOSPC/);

    expect(readFileSync(path, 'utf8')).toBe(committed);
  });

  it('never fuses a later record onto a pre-existing partial prefix', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, record(714) + '\n' + '{"version":1,"seq":715,"at":"20', { mode: 0o600 });

    const result = appendLineAtomic(path, record(732));

    expect(result.repairedBoundary).toBe(true);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).seq).toBe(732);
  });

  it('reports a failed rollback instead of leaving it silently unresolved', async () => {
    const { nodeLogIo } = await import('../src/session/event-log.js');
    const path = join(workspace(), 'events.jsonl');

    let caught: unknown;
    try { appendLineAtomic(path, record(1), { io: shortWriteIo(nodeLogIo, 5, { rollbackFails: true }) }); }
    catch (error) { caught = error; }

    expect((caught as { rollbackFailed?: boolean }).rollbackFailed).toBe(true);
    expect(String((caught as Error).message)).toMatch(/ENOSPC/);
  });

  it('fails a write that reports no progress instead of spinning on it', async () => {
    const { nodeLogIo } = await import('../src/session/event-log.js');
    const path = join(workspace(), 'events.jsonl');
    const stalls: LogIo = { ...nodeLogIo, writeSync: () => 0 };

    expect(() => appendLineAtomic(path, record(1), { io: stalls })).toThrow(/no progress/);

    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('bounds its retries', async () => {
    const { nodeLogIo } = await import('../src/session/event-log.js');
    const path = join(workspace(), 'events.jsonl');
    let attempts = 0;
    const countingIo: LogIo = {
      ...nodeLogIo,
      openSync(p, flags, mode) { attempts++; return nodeLogIo.openSync(p, flags, mode); },
      writeSync() {
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
    };

    expect(() => appendLineAtomic(path, record(1), { io: countingIo, maxAttempts: 3 })).toThrow(/ENOSPC/);

    expect(attempts).toBe(3);
  });
});

describe('readLog', () => {
  it('keeps the valid records on both sides of an interior corrupt line', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const result = readLog(path);

    expect(result.records.map(r => r.seq)).toEqual([713, 714, 733]);
  });

  it('classifies the fused incident line as interior corruption, not a truncated tail', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const result = readLog(path);

    expect(result.damaged).toHaveLength(1);
    expect(result.damaged[0].reason).toBe('interior_corruption');
    expect(result.damaged[0].lineNumber).toBe(3);
    expect(result.damaged[0].raw).toBe(FUSED_INCIDENT_LINE);
  });

  it('classifies an unterminated final line as a truncated tail', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, record(1) + '\n' + record(2) + '\n' + '{"version":1,"seq":3,"at":"20', { mode: 0o600 });

    const result = readLog(path);

    expect(result.records.map(r => r.seq)).toEqual([1, 2]);
    expect(result.damaged).toHaveLength(1);
    expect(result.damaged[0].reason).toBe('truncated_tail');
  });

  it('reports the sequence gap left by records that were never written', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const result = readLog(path);

    expect(result.gaps).toEqual([{ afterSeq: 714, beforeSeq: 733, missing: 18 }]);
  });

  it('reports the highest sequence it can still read', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    expect(readLog(path).maxSeq).toBe(733);
  });

  it('skips records of an unknown version without calling them corrupt', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, record(1) + '\n' + '{"version":2,"seq":2,"kind":"future"}' + '\n', { mode: 0o600 });

    const result = readLog(path);

    expect(result.damaged).toEqual([]);
    expect(result.records.map(r => r.seq)).toEqual([1]);
  });

  it('lets an unknown version occupy its sequence number rather than leaving a hole', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [
      record(1), '{"version":2,"seq":2,"kind":"future"}', record(3), '',
    ].join('\n'), { mode: 0o600 });

    const result = readLog(path);

    expect(result.gaps).toEqual([]);
    expect(result.damaged).toEqual([]);
    expect(result.records.map(r => r.seq)).toEqual([1, 3]);
    expect(result.maxSeq).toBe(3);
  });

  it('counts an unknown version towards the highest sequence on disk', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, '{"version":2,"seq":100,"kind":"future"}\n', { mode: 0o600 });

    const result = readLog(path);

    expect(result.maxSeq).toBe(100);
    expect(result.records).toEqual([]);
    expect(result.damaged).toEqual([]);
  });
});

describe('SessionEvents recovery', () => {
  it('restores the valid events that follow an interior corrupt line', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const events = new SessionEvents(path);

    expect(events.since(0).map(e => e.seq)).toContain(733);
  });

  it('never re-uses a sequence number that is already on disk', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const events = new SessionEvents(path);
    const emitted = events.emit('state', { status: 'idle' });

    expect(emitted.seq).toBeGreaterThan(733);
  });

  it('appends after damage without fusing onto the partial prefix', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, record(714) + '\n' + '{"version":1,"seq":715,"at":"20', { mode: 0o600 });

    new SessionEvents(path).emit('state', { status: 'idle' });

    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const unparseable = lines.filter(l => { try { JSON.parse(l); return false; } catch { return true; } });
    expect(unparseable).toEqual(['{"version":1,"seq":715,"at":"20']);
  });

  it('reports the damage instead of recovering silently', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const integrity = new SessionEvents(path).integrity();

    expect(integrity.healthy).toBe(false);
    expect(integrity.damaged).toHaveLength(1);
    expect(integrity.gaps).toEqual([{ afterSeq: 714, beforeSeq: 733, missing: 18 }]);
  });

  it('surfaces the damage as a replayable error event', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    const reported = new SessionEvents(path).since(0).filter(e => e.kind === 'error');

    expect(reported).toHaveLength(1);
    expect(reported[0].text).toMatch(/interior corruption/);
    expect(reported[0].text).toMatch(/18 record/);
  });

  it('quarantines the damaged bytes without touching the damaged file', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);
    const before = readFileSync(path, 'utf8');

    const integrity = new SessionEvents(path).integrity();

    expect(integrity.quarantined).toBe(true);
    expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true);
    const entry = JSON.parse(readFileSync(path + '.corrupt', 'utf8').trim());
    expect(entry.raw).toBe(FUSED_INCIDENT_LINE);
    expect(entry.reason).toBe('interior_corruption');
  });

  it('does not re-quarantine the same damage on every restart', () => {
    const path = join(workspace(), 'events.jsonl');
    incidentLog(path);

    new SessionEvents(path);
    new SessionEvents(path);

    const entries = readFileSync(path + '.corrupt', 'utf8').split('\n').filter(Boolean);
    expect(entries).toHaveLength(1);
  });

  it('stays visibly unhealthy when the quarantine sidecar cannot be written', () => {
    const dir = workspace();
    const path = join(dir, 'events.jsonl');
    incidentLog(path);
    mkdirSync(path + '.corrupt');

    const integrity = new SessionEvents(path).integrity();

    expect(integrity.healthy).toBe(false);
    expect(integrity.quarantined).toBe(false);
    expect(integrity.quarantineError).toBeTruthy();
    expect(integrity.damaged).toHaveLength(1);
  });

  it('records a write failure instead of swallowing it', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    const events = new SessionEvents(join(dir, 'blocked', 'events.jsonl'));

    const emitted = events.emit('state', { status: 'idle' });

    expect(emitted.seq).toBe(1);
    expect(events.since(0)).toHaveLength(1);
    const integrity = events.integrity();
    expect(integrity.healthy).toBe(false);
    expect(integrity.writeFailures).toBe(1);
    expect(integrity.lastWriteError).toMatch(/ENOTDIR|ENOENT/);
  });

  it('does not truncate the stream when rotation cannot rename', () => {
    const dir = workspace();
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, record(1, { text: 'x'.repeat(2 * 1024 * 1024) }) + '\n', { mode: 0o600 });
    const sizeBefore = statSync(path).size;
    mkdirSync(path + '.1');
    appendFileSync(join(path + '.1', 'occupied'), 'keeps the rename from succeeding');

    const events = new SessionEvents(path);
    events.emit('state', { status: 'idle' });

    expect(statSync(path).size).toBeGreaterThanOrEqual(sizeBefore);
    expect(events.integrity().rotationFailed).toBe(true);
    expect(events.integrity().healthy).toBe(false);
  });
});

describe('SessionEvents rotation window', () => {
  /** Rotation renames the live stream away; a crash before the next append leaves only `.1`. */
  it('continues the sequence from the rotated stream when the live one is gone', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', [record(732), record(733), ''].join('\n'), { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.emit('state', { status: 'idle' }).seq).toBe(734);
  });

  it('keeps replaying the rotated events when the live stream is short', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', [record(1), record(2), ''].join('\n'), { mode: 0o600 });
    writeFileSync(path, record(3) + '\n', { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.since(0).map(e => e.seq)).toEqual([1, 2, 3]);
  });

  it('does not call itself healthy when the rotated stream is damaged', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', [record(1), FUSED_INCIDENT_LINE, record(733), ''].join('\n'), { mode: 0o600 });

    const integrity = new SessionEvents(path).integrity();

    expect(integrity.healthy).toBe(false);
    expect(integrity.damaged).toHaveLength(1);
    expect(integrity.quarantined).toBe(true);
  });

  it('survives a real rotation and the restart that follows it', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [record(732), record(733, { text: 'x'.repeat(2 * 1024 * 1024) }), ''].join('\n'), { mode: 0o600 });

    const events = new SessionEvents(path);
    expect(events.emit('state', { status: 'idle' }).seq).toBe(734);
    expect(existsSync(path + '.1')).toBe(true);

    const restored = new SessionEvents(path);

    expect(restored.emit('state', { status: 'idle' }).seq).toBe(735);
    expect(restored.integrity().healthy).toBe(true);
  });
});

describe('SessionEvents irrecoverable loss', () => {
  /** Every line parses, so nothing is "damaged" — but records are still gone. */
  it('reports a gap that spans the rotated and live streams', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', record(733) + '\n', { mode: 0o600 });
    writeFileSync(path, record(735) + '\n', { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.integrity().healthy).toBe(false);
    expect(events.integrity().gaps).toEqual([{ afterSeq: 733, beforeSeq: 735, missing: 1 }]);
  });

  it('reports a gap inside a single stream', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [record(1), record(3), ''].join('\n'), { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.integrity().healthy).toBe(false);
    expect(events.integrity().gaps).toEqual([{ afterSeq: 1, beforeSeq: 3, missing: 1 }]);
  });

  it('names the loss as irrecoverable in one replayable report', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [record(1), record(3), ''].join('\n'), { mode: 0o600 });

    const reported = new SessionEvents(path).since(0).filter(e => e.kind === 'error');

    expect(reported).toHaveLength(1);
    expect(reported[0].text).toMatch(/1 record lost between seq 1\.\.3 \(irrecoverable\)/);
  });

  it('does not quarantine when nothing is damaged', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [record(1), record(3), ''].join('\n'), { mode: 0o600 });

    const integrity = new SessionEvents(path).integrity();

    expect(integrity.damaged).toEqual([]);
    expect(integrity.quarantined).toBe(false);
    expect(existsSync(path + '.corrupt')).toBe(false);
  });

  it('still replays the records on both sides of the gap', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', record(733) + '\n', { mode: 0o600 });
    writeFileSync(path, record(735) + '\n', { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.since(0).filter(e => e.kind === 'tool_update').map(e => e.seq)).toEqual([733, 735]);
  });

  it('stays healthy when the streams are contiguous across rotation', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', [record(733), record(734), ''].join('\n'), { mode: 0o600 });
    writeFileSync(path, record(735) + '\n', { mode: 0o600 });

    const integrity = new SessionEvents(path).integrity();

    expect(integrity.healthy).toBe(true);
    expect(integrity.gaps).toEqual([]);
  });
});

describe('SessionEvents forward compatibility', () => {
  it('stays healthy when an unknown version sits between two readable records', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [
      record(1), '{"version":2,"seq":2,"kind":"future"}', record(3), '',
    ].join('\n'), { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.integrity().healthy).toBe(true);
    expect(events.integrity().gaps).toEqual([]);
    expect(events.integrity().damaged).toEqual([]);
  });

  it('replays only the records it understands', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, [
      record(1), '{"version":2,"seq":2,"kind":"future"}', record(3), '',
    ].join('\n'), { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.since(0).map(e => e.seq)).toEqual([1, 3]);
  });

  it('continues past a sequence only an unknown version occupies', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path, '{"version":2,"seq":100,"kind":"future"}\n', { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.since(0)).toEqual([]);
    expect(events.emit('state', { status: 'idle' }).seq).toBe(101);
  });

  it('honours an unknown version across the rotation boundary', () => {
    const path = join(workspace(), 'events.jsonl');
    writeFileSync(path + '.1', record(733) + '\n', { mode: 0o600 });
    writeFileSync(path, '{"version":2,"seq":734,"kind":"future"}\n', { mode: 0o600 });

    const events = new SessionEvents(path);

    expect(events.integrity().healthy).toBe(true);
    expect(events.integrity().gaps).toEqual([]);
    expect(events.emit('state', { status: 'idle' }).seq).toBe(735);
  });
});

describe('ENOSPC incident, end to end', () => {
  it('survives short write, rollback, later append and restart without fusing or losing events', async () => {
    const { nodeLogIo } = await import('../src/session/event-log.js');
    const path = join(workspace(), 'events.jsonl');
    const events = new SessionEvents(path);
    events.emit('state', { status: 'idle', text: 'before the disk filled' });

    // The disk fills: every append short-writes and then reports ENOSPC.
    const failing = shortWriteIo(nodeLogIo, 31);
    for (let i = 0; i < 3; i++) {
      try { appendLineAtomic(path, record(900 + i), { io: failing }); } catch { /* as the writer sees it */ }
    }

    // Space frees and the session keeps working.
    events.emit('state', { status: 'running', text: 'after the disk freed' });

    // The role restarts and replays its own stream.
    const restored = new SessionEvents(path);

    expect(restored.integrity().healthy).toBe(true);
    expect(restored.integrity().damaged).toEqual([]);
    expect(restored.since(0).map(e => e.text)).toEqual(['before the disk filled', 'after the disk freed']);
    expect(restored.emit('state', {}).seq).toBe(3);
  });
});
