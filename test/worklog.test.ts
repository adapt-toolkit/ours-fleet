import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorklog, rotateWorklog } from '../src/worklog.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-worklog-'));
  path = join(dir, 'WORKLOG.md');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policy = { max_kb: 2, keep_tail_kb: 1, max_archives: 2 };

describe('worklog rotation', () => {
  it('is a no-op when disabled or below threshold', () => {
    writeFileSync(path, 'small\n');
    expect(inspectWorklog(path).enabled).toBe(false);
    expect(rotateWorklog(path).rotated).toBe(false);
    expect(rotateWorklog(path, policy).rotated).toBe(false);
  });

  it('archives the removed head, keeps valid UTF-8 whole-line tail, and preserves mode', () => {
    const original = Array.from({ length: 500 }, (_, i) => `${i}: žluťoučký kůň\n`).join('');
    writeFileSync(path, original);
    chmodSync(path, 0o640);
    const result = rotateWorklog(path, policy, { now: () => new Date('2026-07-31T10:11:12.123Z') });
    expect(result.rotated).toBe(true);
    const head = readFileSync(result.archivePath!, 'utf8');
    const tail = readFileSync(path, 'utf8');
    expect(head + tail).toBe(original);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024);
    expect(() => Buffer.from(tail, 'utf8').toString('utf8')).not.toThrow();
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('defers without truncation when an append races the stable-snapshot check', () => {
    const original = 'line\n'.repeat(1000);
    writeFileSync(path, original);
    const result = rotateWorklog(path, policy, {
      beforeCommit: () => appendFileSync(path, 'concurrent\n'),
    });
    expect(result).toMatchObject({ rotated: false, deferred: true });
    expect(readFileSync(path, 'utf8')).toBe(`${original}concurrent\n`);
  });
});

