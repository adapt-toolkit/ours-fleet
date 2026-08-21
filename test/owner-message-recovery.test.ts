import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MessageRecoveryState } from '../src/owner-channel/message-recovery.js';

const dirs: string[] = [];

function state() {
  const dir = mkdtempSync(join(tmpdir(), 'ours-message-recovery-'));
  dirs.push(dir);
  const path = join(dir, 'messages.json');
  return { path, journal: new MessageRecoveryState(path) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MessageRecoveryState', () => {
  it('persists only bounded claim metadata at mode 0600 and prunes handled wires', () => {
    const { path, journal } = state();
    journal.claim([{ wireId: 'wire-1', seq: 41, claimedAt: 1_000 }]);
    const raw = readFileSync(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      version: 1, pending: [{ wireId: 'wire-1', seq: 41, claimedAt: 1_000 }],
    });
    expect(raw).not.toContain('owner message body');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(journal.pruneHandled(wireId => wireId === 'wire-1')).toBe(1);
    expect(journal.list()).toEqual([]);
  });

  it('is idempotent for the same claim and fails closed if a wire changes sequence', () => {
    const { journal } = state();
    journal.claim([{ wireId: 'wire-1', seq: 41, claimedAt: 1_000 }]);
    journal.claim([{ wireId: 'wire-1', seq: 41, claimedAt: 2_000 }]);
    expect(journal.list()).toEqual([{ wireId: 'wire-1', seq: 41, claimedAt: 1_000 }]);
    expect(() => journal.claim([{ wireId: 'wire-1', seq: 42, claimedAt: 3_000 }]))
      .toThrow(/changed sequence/);
  });

  it('retains corrupt evidence and disables reads and mutations', () => {
    const { path } = state();
    writeFileSync(path, '{"version":1,"pending":[{"wireId":"x","seq":0}]}\n');
    chmodSync(path, 0o644);
    const journal = new MessageRecoveryState(path);
    expect(journal.integrity()).toBe(false);
    expect(() => journal.list()).toThrow(/corrupt/);
    expect(() => journal.claim([{ wireId: 'wire-1', seq: 1, claimedAt: 1 }]))
      .toThrow(/corrupt/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
