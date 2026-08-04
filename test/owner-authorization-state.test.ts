import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnerAuthorizationState } from '../src/owner-channel/state.js';

const A = 'A'.repeat(64);
const B = 'B'.repeat(64);
const C = 'C'.repeat(64);
const dirs: string[] = [];
const setup = (baseline = [A, B]) => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-owner-auth-'));
  dirs.push(dir);
  const path = join(dir, '.owner-channel-owners.json');
  return { dir, path, state: new OwnerAuthorizationState(path, baseline) };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OwnerAuthorizationState', () => {
  it('combines baseline and dynamic owners, reports source, and refuses ambiguous no-ops', () => {
    const { state } = setup();
    expect([...state.effective()]).toEqual([A, B]);
    expect(() => state.authorize(A)).toThrow(/already authorized/);
    expect(state.authorize(C)).toEqual({ cid: C, source: 'dynamic', effective: true });
    expect(state.revoke(A)).toEqual({ cid: A, source: 'baseline', effective: false });
    expect(state.entries()).toEqual([
      { cid: A, source: 'baseline', effective: false },
      { cid: B, source: 'baseline', effective: true },
      { cid: C, source: 'dynamic', effective: true },
    ]);
    expect(() => state.revoke(A)).toThrow(/not authorized/);
  });

  it('persists atomically with mode 0600 and reloads the overlay across restart', () => {
    const { path, state } = setup();
    state.authorize(C);
    state.revoke(A);
    chmodSync(path, 0o644);
    const restarted = new OwnerAuthorizationState(path, [A, B]);
    expect([...restarted.effective()].sort()).toEqual([B, C]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted).toMatchObject({ version: 1, added: [C], revoked: [A] });
    expect(persisted.audit).toHaveLength(2);
    expect(readFileSync(path, 'utf8')).not.toContain('invite');
  });

  it('canonicalizes hex case in authorization decisions so casing cannot bypass revocation', () => {
    const upper = 'AB'.repeat(32);
    const lower = upper.toLowerCase();
    const { path, state } = setup([lower, B]);
    // A case variant of an effective owner is the same owner, not a new one.
    expect(() => state.authorize(upper)).toThrow(/already authorized/);
    // Revoking by a different casing must still revoke the canonical owner.
    state.revoke(upper);
    expect([...state.effective()].map(cid => cid.toLowerCase())).not.toContain(lower);
    expect(() => state.revoke(lower)).toThrow(/not authorized/);
    // A persisted revocation keeps applying when the configured casing changes.
    const restarted = new OwnerAuthorizationState(path, [upper, B]);
    expect([...restarted.effective()].map(cid => cid.toLowerCase())).not.toContain(lower);
  });

  it('protects the last effective owner, including a dynamic-only owner', () => {
    const first = setup([A]).state;
    expect(() => first.revoke(A)).toThrow(/last effective owner/);
    first.authorize(C);
    first.revoke(A);
    expect(() => first.revoke(C)).toThrow(/last effective owner/);
  });

  it('fails closed and refuses mutation when persisted state is corrupt or unbounded', () => {
    const { path } = setup();
    writeFileSync(path, '{not-json', { mode: 0o600 });
    const corrupt = new OwnerAuthorizationState(path, [A]);
    expect(corrupt.integrity().ok).toBe(false);
    expect([...corrupt.effective()]).toEqual([]);
    expect(corrupt.entries()).toEqual([{ cid: A, source: 'baseline', effective: false }]);
    expect(() => corrupt.authorize(C)).toThrow(/corrupt.*refusing mutation/);
  });

  it('an abandoned temporary file cannot replace the last committed authorization set', () => {
    const { dir, path, state } = setup();
    state.authorize(C);
    writeFileSync(join(dir, '..owner-channel-owners.json.crash.tmp'), '{', { mode: 0o600 });
    expect([...new OwnerAuthorizationState(path, [A, B]).effective()].sort()).toEqual([A, B, C]);
  });
});
