import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  passwordAccess, validatePublicOrigin, verifyPassword, WebAccessStore,
} from '../../src/web/access.js';

describe('web access configuration', () => {
  it('stores only a salted password verifier in a private file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-access-'));
    const store = new WebAccessStore(dir);
    store.write(passwordAccess('correct horse battery staple'));
    const raw = readFileSync(store.path, 'utf8');
    expect(raw).not.toContain('correct horse battery staple');
    expect(verifyPassword(store.read(), 'correct horse battery staple')).toBe(true);
    expect(verifyPassword(store.read(), 'incorrect password')).toBe(false);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it('defaults safely to pairing and validates an exact proxy origin', () => {
    const store = new WebAccessStore(mkdtempSync(join(tmpdir(), 'ours-fleet-access-default-')));
    expect(store.read().mode).toBe('pairing');
    expect(validatePublicOrigin('https://fleet.example.com:8443').host)
      .toBe('fleet.example.com:8443');
    expect(() => validatePublicOrigin('https://user@fleet.example.com/path')).toThrow(/only scheme/);
  });
});
