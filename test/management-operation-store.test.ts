import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagementOperationStore, managementDigest } from '../src/application/management-operation-store.js';

describe('ManagementOperationStore', () => {
  it('durably round-trips canonical private records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-management-'));
    const store = new ManagementOperationStore(dir); const keyHash = managementDigest('same-key');
    store.write({ version: 1, keyHash, requestHash: managementDigest({ operation: 'x' }),
      phase: 'effecting', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(store.read(keyHash)?.phase).toBe('effecting');
    expect(readFileSync(store.path(keyHash), 'utf8')).toMatch(/"phase":"effecting"/u);
  });
  it('rejects symlink and group-readable records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-management-')); const store = new ManagementOperationStore(dir);
    const key = managementDigest('unsafe'); const target = join(dir, 'target'); writeFileSync(target, '{}');
    symlinkSync(target, store.path(key)); expect(() => store.read(key)).toThrow(/unsafe/u);
    const dir2 = mkdtempSync(join(tmpdir(), 'fleet-management-')); const store2 = new ManagementOperationStore(dir2);
    const path = store2.path(key); writeFileSync(path, '{}'); chmodSync(path, 0o640);
    expect(() => store2.read(key)).toThrow(/unsafe/u);
  });
});
