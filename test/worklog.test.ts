import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { fork } from 'node:child_process';
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

  it('never overwrites an append in the true rename-to-publish commit window', () => {
    const original = 'old\n'.repeat(1000);
    writeFileSync(path, original);
    const result = rotateWorklog(path, policy, {
      afterArchiveRename: () => appendFileSync(path, 'commit-window-ack\n'),
    });
    expect(result.rotated).toBe(true);
    const retained = readFileSync(result.archivePath!, 'utf8') + readFileSync(path, 'utf8');
    expect(retained).toContain(original);
    expect(retained).toContain('commit-window-ack\n');
    expect(readFileSync(path, 'utf8')).toBe('commit-window-ack\n');
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
