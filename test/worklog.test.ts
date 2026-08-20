import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectWorklog, rotateWorklog, WORKLOG_ARCHIVE_DIR,
} from '../src/worklog.js';

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
    const archive = readFileSync(result.archivePath!, 'utf8');
    const tail = readFileSync(path, 'utf8');
    expect(archive).toBe(original);
    expect(original.endsWith(tail)).toBe(true);
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

  it('preserves an append after archive publication without a missing-live-file window', () => {
    const original = 'old\n'.repeat(1000);
    writeFileSync(path, original);
    const result = rotateWorklog(path, policy, {
      afterArchiveRename: () => appendFileSync(path, 'commit-window-ack\n'),
    });
    expect(result.rotated).toBe(true);
    const retained = readFileSync(result.archivePath!, 'utf8') + readFileSync(path, 'utf8');
    expect(retained).toContain(original);
    expect(retained).toContain('commit-window-ack\n');
    expect(readFileSync(result.archivePath!, 'utf8')).toContain('commit-window-ack\n');
    expect(readFileSync(path, 'utf8').length).toBeLessThanOrEqual(1024);
  });

  it('rotates only above the threshold and remains bounded on repeated rotations', () => {
    writeFileSync(path, 'x'.repeat(policy.max_kb * 1024));
    expect(rotateWorklog(path, policy).rotated).toBe(false);
    appendFileSync(path, 'x');
    expect(rotateWorklog(path, policy, {
      now: () => new Date('2026-08-20T10:00:00.000Z'),
    }).rotated).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(policy.keep_tail_kb * 1024);
    appendFileSync(path, '\n' + 'y'.repeat(policy.max_kb * 1024));
    expect(rotateWorklog(path, policy, {
      now: () => new Date('2026-08-20T10:00:00.000Z'),
    }).rotated).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(policy.keep_tail_kb * 1024);
    const archives = readdirSync(dir).filter(name => /^WORKLOG\..*\.md$/.test(name));
    expect(archives).toEqual(expect.arrayContaining([
      'WORKLOG.2026-08-20T10-00-00.000Z.md',
      'WORKLOG.2026-08-20T10-00-00.000Z.1.md',
    ]));
  });

  it('moves excess recent archives to lossless cold storage instead of deleting them', () => {
    const oneRecent = { ...policy, max_archives: 1 };
    const first = 'FIRST-COMPLETE-SNAPSHOT\n' + 'a\n'.repeat(2_000);
    writeFileSync(path, first);
    const firstRotation = rotateWorklog(path, oneRecent, {
      now: () => new Date('2026-08-20T10:00:00.000Z'),
    });
    appendFileSync(path, 'SECOND-CURRENT-SNAPSHOT\n' + 'b\n'.repeat(2_000));
    const secondRotation = rotateWorklog(path, oneRecent, {
      now: () => new Date('2026-08-20T10:00:00.000Z'),
    });
    expect(firstRotation.rotated && secondRotation.rotated).toBe(true);
    const recent = readdirSync(dir).filter(name => /^WORKLOG\..*\.md$/.test(name));
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain('.1.md');
    const coldDir = join(dir, WORKLOG_ARCHIVE_DIR);
    const cold = readdirSync(coldDir);
    expect(cold).toHaveLength(1);
    expect(readFileSync(join(coldDir, cold[0]), 'utf8')).toBe(first);
    expect(readFileSync(secondRotation.archivePath!, 'utf8'))
      .toContain('SECOND-CURRENT-SNAPSHOT');
    const status = JSON.parse(readFileSync(join(dir, '.worklog-rotation.json'), 'utf8'));
    expect(status).toMatchObject({
      archive: 'WORKLOG.2026-08-20T10-00-00.000Z.1.md',
      olderArchives: WORKLOG_ARCHIVE_DIR,
      recentArchiveLimit: 1,
      archiveContainsFullSnapshot: true,
    });
  });

  it('leaves the complete live file and published archive recoverable on commit error', () => {
    const original = 'ERROR-SAFE\n' + 'line\n'.repeat(1_000);
    writeFileSync(path, original);
    expect(() => rotateWorklog(path, policy, {
      now: () => new Date('2026-08-20T10:00:00.000Z'),
      afterArchiveRename: () => { throw new Error('simulated crash boundary'); },
    })).toThrow(/simulated crash boundary/);
    expect(readFileSync(path, 'utf8')).toBe(original);
    const archive = join(dir, 'WORKLOG.2026-08-20T10-00-00.000Z.md');
    expect(readFileSync(archive, 'utf8')).toBe(original);
    expect(existsSync(join(dir, '.worklog-rotation.json'))).toBe(false);
    expect(readdirSync(dir).some(name => name.endsWith('.rotate'))).toBe(false);
  });

  it('retains every acknowledged cross-process append across rotation', async () => {
    writeFileSync(path, 'seed\n'.repeat(1000));
    const childFile = join(dir, 'append-child.cjs');
    writeFileSync(childFile, [
      "const { appendFileSync } = require('node:fs');",
      'const [path, count] = process.argv.slice(2);',
      "appendFileSync(path, `ack-${process.pid}-0\\n`);",
      "if (process.send) process.send('ready');",
      "process.on('message', message => {",
      "if (message !== 'go') return;",
      'for (let i = 1; i < Number(count); i++) {',
      "  const marker = `ack-${process.pid}-${i}\\n`;",
      '  appendFileSync(path, marker);',
      '}',
      'if (process.disconnect) process.disconnect();',
      '});',
      '',
    ].join('\n'));
    const child = fork(childFile, [path, '250'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      child.on('message', marker => {
        if (marker === 'ready') resolve();
      });
      child.once('error', reject);
    });
    const result = rotateWorklog(path, policy, {
      afterArchiveRename: () => child.send('go'),
    });
    await new Promise<void>((resolve, reject) => {
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
      child.once('error', reject);
    });
    const retained = [
      ...(result.archivePath ? [readFileSync(result.archivePath, 'utf8')] : []),
      readFileSync(path, 'utf8'),
    ].join('');
    const acknowledged = Array.from({ length: 250 }, (_, i) => `ack-${child.pid}-${i}`);
    expect(acknowledged).toHaveLength(250);
    for (const marker of acknowledged) expect(retained).toContain(`${marker}\n`);
  });
});
