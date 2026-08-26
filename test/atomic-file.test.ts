import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replaceFileAtomically, withFileLock, type WriteDeps } from '../src/atomic-file.js';

// dist/cli.js et al are built once by vitest's globalSetup
// (test/global-setup.ts), before any test file runs — the pretrust-child.mjs
// fixture below imports compiled modules straight out of dist/.
const DIST = resolve('dist');
const CHILD = resolve('test/fixtures/pretrust-child.mjs');

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ours-fleet-atomic-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run one child process; resolves with its exit code (never rejects). */
const child = (projectPath: string, env: NodeJS.ProcessEnv = {}) =>
  new Promise<number>(res => {
    const c = execFile(
      process.execPath, [CHILD, DIST, home, projectPath],
      { env: { ...process.env, ...env } }, () => {});
    c.on('exit', code => res(code ?? -1));
  });

describe('withFileLock', () => {
  it('serialises a read-modify-write that would otherwise interleave', async () => {
    const lock = join(home, 'x.lock');
    const target = join(home, 'counter');
    writeFileSync(target, '0');
    // Each task reads, yields (the interleaving window), then writes back.
    await Promise.all(Array.from({ length: 25 }, () => withFileLock(lock, async () => {
      const n = Number(readFileSync(target, 'utf8'));
      await new Promise(r => setImmediate(r));
      writeFileSync(target, String(n + 1));
    })));
    expect(readFileSync(target, 'utf8')).toBe('25');
  });

  it('releases the lock when the body throws', async () => {
    const lock = join(home, 'y.lock');
    await expect(withFileLock(lock, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(readdirSync(home)).not.toContain('y.lock');
    await expect(withFileLock(lock, () => 'second caller gets in')).resolves.toBe('second caller gets in');
  });

  it('breaks a stale lock rather than deadlocking the fleet', async () => {
    const lock = join(home, 'z.lock');
    // A crashed holder: the lock dir exists with an old timestamp.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'ts'), '0');            // epoch — long stale
    await expect(withFileLock(lock, () => 'recovered')).resolves.toBe('recovered');
  });

  it('does not steal or remove a live lock after the stale interval', async () => {
    const lock = join(home, 'live.lock');
    let clock = 0;
    let release!: () => void;
    const held = withFileLock(lock, () => new Promise<void>(resolve => { release = resolve; }),
      { now: () => clock, sleep: async () => { clock += 25; } }, 50);
    await new Promise(resolve => setImmediate(resolve));
    let entered = false;
    const waiter = withFileLock(lock, () => { entered = true; },
      { now: () => clock, sleep: async () => { clock += 25; await new Promise(resolve => setImmediate(resolve)); } }, 50);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(entered).toBe(false);
    release(); await held; await waiter;
    expect(entered).toBe(true);
  });

  it('publishes only fully populated claims when preparation is stalled', async () => {
    const lock = join(home, 'publish.lock');
    let prepared!: () => void; const preparedSignal = new Promise<void>(resolve => { prepared = resolve; });
    let publish!: () => void; const publishGate = new Promise<void>(resolve => { publish = resolve; });
    const first = withFileLock(lock, () => 'first', {
      beforePublish: async () => { prepared(); await publishGate; },
    });
    await preparedSignal;
    expect(() => readFileSync(join(lock, 'owner.json'), 'utf8')).toThrow(/ENOENT/);
    let releaseSecond!: () => void;
    const second = withFileLock(lock, () => new Promise<void>(resolve => { releaseSecond = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid });
    publish(); releaseSecond(); await second;
    await expect(first).resolves.toBe('first');
  });
});

describe('replaceFileAtomically', () => {
  it('replaces contents and leaves no temp file behind', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'old');
    replaceFileAtomically(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('a reader never sees a partial file: content is always one whole version', () => {
    const target = join(home, 'big.json');
    const a = JSON.stringify({ v: 'a'.repeat(200_000) });
    const b = JSON.stringify({ v: 'b'.repeat(200_000) });
    replaceFileAtomically(target, a);
    replaceFileAtomically(target, b);
    const seen = readFileSync(target, 'utf8');
    expect([a, b]).toContain(seen);
    expect(() => JSON.parse(seen)).not.toThrow();
  });

  it('finishes a write the kernel stopped short', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'old');
    let firstWrite = true;
    const shortOnce: WriteDeps = {
      writeSync(fd, buffer, offset, length) {
        if (firstWrite) { firstWrite = false; return writeSync(fd, buffer, offset, Math.floor(length / 3)); }
        return writeSync(fd, buffer, offset, length);
      },
    };

    replaceFileAtomically(target, 'a complete replacement', 0o600, shortOnce);

    expect(readFileSync(target, 'utf8')).toBe('a complete replacement');
  });

  it('keeps the previous contents when the disk fills mid-write', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'the last good version');
    const fills: WriteDeps = {
      writeSync(fd, buffer, offset, length) {
        writeSync(fd, buffer, offset, Math.floor(length / 3));
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
    };

    expect(() => replaceFileAtomically(target, 'a replacement that cannot fit', 0o600, fills)).toThrow(/ENOSPC/);

    expect(readFileSync(target, 'utf8')).toBe('the last good version');
  });

  it('does not leave its temp file behind when the write fails', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'old');
    const fails: WriteDeps = {
      writeSync() {
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
    };

    expect(() => replaceFileAtomically(target, 'new', 0o600, fails)).toThrow(/ENOSPC/);

    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('fails a write that reports no progress instead of spinning on it', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'the last good version');
    const stalls: WriteDeps = { writeSync: () => 0 };

    expect(() => replaceFileAtomically(target, 'new', 0o600, stalls)).toThrow(/no progress/);

    expect(readFileSync(target, 'utf8')).toBe('the last good version');
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('does not publish a temp file it could not close', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'the last good version');
    const fails: WriteDeps = {
      closeSync() {
        const error = new Error('EIO: i/o error, close') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    };

    expect(() => replaceFileAtomically(target, 'new', 0o600, fails)).toThrow(/close/);

    expect(readFileSync(target, 'utf8')).toBe('the last good version');
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('reports why the write failed even when the cleanup close also fails', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'the last good version');
    const fails: WriteDeps = {
      writeSync() {
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      },
      closeSync() { throw new Error('EIO: i/o error, close'); },
    };

    expect(() => replaceFileAtomically(target, 'new', 0o600, fails)).toThrow(/ENOSPC/);

    expect(readFileSync(target, 'utf8')).toBe('the last good version');
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('does not publish a temp file it could not fsync', () => {
    const target = join(home, 'f.json');
    writeFileSync(target, 'the last good version');
    const fails: WriteDeps = {
      fsyncSync() {
        const error = new Error('EIO: i/o error, fsync') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    };

    expect(() => replaceFileAtomically(target, 'new', 0o600, fails)).toThrow(/EIO/);

    expect(readFileSync(target, 'utf8')).toBe('the last good version');
    expect(readdirSync(home).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('concurrent pre-trust across processes', () => {
  it('ten processes trusting ten paths lose no entry and no operator state', async () => {
    const claudeJson = join(home, '.claude.json');
    // Pre-existing operator state that must survive untouched.
    writeFileSync(claudeJson, JSON.stringify({
      projects: { '/operators/own/project': { keep: 'me', hasTrustDialogAccepted: true } },
      numStartups: 42,
      oauthAccount: { emailAddress: 'operator@example.com' },
    }, null, 2));

    const paths = Array.from({ length: 10 }, (_, i) => `/work/project-${i}`);
    const codes = await Promise.all(paths.map(p => child(p)));
    expect(codes.every(c => c === 0), codes.join(',')).toBe(true);

    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    // Every one of the ten entries is present — none lost to an interleave.
    for (const p of paths) {
      expect(doc.projects[p], p).toBeTruthy();
      expect(doc.projects[p].hasTrustDialogAccepted, p).toBe(true);
      expect(doc.projects[p].hasCompletedProjectOnboarding, p).toBe(true);
    }
    // …and the operator's unrelated state is exactly as it was.
    expect(doc.projects['/operators/own/project']).toEqual({ keep: 'me', hasTrustDialogAccepted: true });
    expect(doc.numStartups).toBe(42);
    expect(doc.oauthAccount).toEqual({ emailAddress: 'operator@example.com' });
    expect(Object.keys(doc.projects)).toHaveLength(11);

    expect(readdirSync(home).filter(f => f.endsWith('.lock'))).toEqual([]);
  }, 60_000);

  it('a process killed before its rename leaves the last good file intact', async () => {
    const claudeJson = join(home, '.claude.json');
    const good = JSON.stringify({ projects: { '/kept': { keep: true } }, numStartups: 7 }, null, 2);
    writeFileSync(claudeJson, good);

    const code = await child('/never-applied', { PRETRUST_ABORT_BEFORE_RENAME: '1' });
    expect(code).toBe(9);                                  // it really did die mid-flight

    // Untouched, byte for byte — an interrupted write cannot replace the last
    // good file with a partial one.
    expect(readFileSync(claudeJson, 'utf8')).toBe(good);

    // And the fleet is not wedged: the abandoned lock is broken and the next
    // pre-trust succeeds.
    expect(await child('/after-the-crash')).toBe(0);
    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    expect(doc.projects['/after-the-crash'].hasTrustDialogAccepted).toBe(true);
    expect(doc.projects['/kept']).toEqual({ keep: true });
    expect(doc.numStartups).toBe(7);
  }, 60_000);
});
