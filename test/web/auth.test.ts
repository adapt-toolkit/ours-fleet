import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';

const origin = 'http://127.0.0.1:49271';
const host = '127.0.0.1:49271';
const temporaryStore = (now: () => number = Date.now, ttl?: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-device-'));
  return { dir, store: new TrustedDeviceStore(dir, now, ttl) };
};

describe('browser auth and trusted devices', () => {
  it('binds a purpose/role ticket to one use', () => {
    const { store } = temporaryStore();
    const auth = new WebAuth(origin, host, Date.now, store);
    const { session } = auth.exchange(pairingRequest(auth));
    const authenticated = request({
      host, origin, cookie: `ofs_session=${session.id}`, 'x-csrf-token': session.csrf,
    });
    const { ticket } = auth.mintTicket(authenticated, 'terminal', 'Alpha');
    expect(auth.consumeTicket(authenticated, ticket, 'terminal', 'Alpha').id).toBe(session.id);
    expect(() => auth.consumeTicket(authenticated, ticket, 'terminal', 'Alpha'))
      .toThrow(/already used/);
  });

  it('idle-expires browser sessions without trusting cookie age', () => {
    let now = 1_000;
    const { store } = temporaryStore(() => now);
    const auth = new WebAuth(origin, host, () => now, store);
    const { session } = auth.exchange(pairingRequest(auth));
    now += 30 * 60_000 + 1;
    expect(() => auth.authenticate(request({ host, cookie: `ofs_session=${session.id}` })))
      .toThrow(/expired/);
  });

  it('persists only a strong hash with private modes and resumes after restart', () => {
    let now = 10_000;
    const { dir, store } = temporaryStore(() => now);
    const first = new WebAuth(origin, host, () => now, store);
    const paired = first.exchange(pairingRequest(first));
    const raw = readFileSync(store.path, 'utf8');
    const secret = paired.device.token.split('.')[1];
    expect(raw).not.toContain(paired.device.token);
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw).devices[0].secretHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);

    const restarted = new WebAuth(origin, host, () => now, new TrustedDeviceStore(dir, () => now));
    const resumed = restarted.resume(deviceRequest(paired.device.token));
    expect(resumed.session.id).toHaveLength(43);
    expect(resumed.device.token).not.toBe(paired.device.token);
    expect(() => restarted.resume(deviceRequest(paired.device.token))).toThrow(/revoked/);
    expect(restarted.resume(deviceRequest(resumed.device.token)).session.id).toHaveLength(43);
  });

  it('rejects expired devices, logout revokes current device, and revoke-all clears all', () => {
    let now = 1_000;
    const { store } = temporaryStore(() => now, 100);
    const auth = new WebAuth(origin, host, () => now, store);
    const expired = auth.exchange(pairingRequest(auth));
    now += 101;
    expect(() => auth.resume(deviceRequest(expired.device.token))).toThrow(/expired/);
    expect(store.count()).toBe(0);

    now = 2_000;
    const current = auth.exchange(request({ host, origin, authorization: `Bootstrap ${auth.mintBootstrap()}` }));
    auth.logout(request({
      host, origin,
      // Revocation is bound to the authenticated session, not to a caller-
      // supplied device cookie that could be omitted or substituted.
      cookie: `ofs_session=${current.session.id}`,
      'x-csrf-token': current.session.csrf,
    }));
    expect(() => auth.resume(deviceRequest(current.device.token))).toThrow(/revoked/);

    const another = auth.exchange(request({ host, origin, authorization: `Bootstrap ${auth.mintBootstrap()}` }));
    expect(auth.revokeAllTrustedDevices()).toBe(1);
    expect(() => auth.resume(deviceRequest(another.device.token))).toThrow(/revoked/);
  });

  it('fails closed on corrupt content and replaces it only on explicit pairing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-device-corrupt-'));
    writeFileSync(join(dir, 'trusted-devices.json'), '{not-json', { mode: 0o666 });
    const store = new TrustedDeviceStore(dir);
    expect(store.count()).toBe(0);
    const issued = store.issue();
    expect(readFileSync(store.path, 'utf8')).not.toContain(issued.token);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });
});

function pairingRequest(auth: WebAuth) {
  return request({ host, origin, authorization: `Bootstrap ${auth.bootstrapSecret}` });
}

function deviceRequest(token: string) {
  return request({ host, origin, cookie: `ofs_device=${token}` });
}

function request(headers: Record<string, string>) {
  return { headers } as any;
}
