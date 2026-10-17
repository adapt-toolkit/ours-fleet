import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSelectedDaemonHealth } from '../src/daemon-recovery.js';
import { gatewayFixture } from './gateway-fixture.js';

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'selected-health-'));
  env = gatewayFixture(root).env;
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
const info = (pid = 41) => ({ name: 'ours', pid, stateDir: '/opaque', startup: {
  version: 1, pid: 41, bootId: 'boot', phase: 'ready', startedAt: 1000, updatedAt: 1100,
} });

it('shares a sequential probe chain across roles and stops after the final release', async () => {
  let reads = 0;
  let closes = 0;
  const deps = { attachClient: async () => ({
    version: async () => { reads++; return info(); },
    identities: async () => [{ name: 'Root' }, { name: 'T', temporary: true }],
    close: async () => { closes++; },
  }) };
  const leases = Array.from({ length: 12 }, () => acquireSelectedDaemonHealth(env, deps as never));
  try {
    const snapshots = await Promise.all(leases.map(lease => lease.sample()));
    expect(reads).toBe(1);
    expect(snapshots[0].generation.state).toBe('ready');
    expect(leases[0].presence('T', snapshots[0])).toEqual({ state: 'present', temporary: true, stale: false });
    expect(leases[0].presence('missing', snapshots[0])).toEqual({ state: 'absent' });
    leases.slice(1).forEach(lease => lease.release());
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads).toBe(2);
    expect(closes).toBe(2);
    leases[0].release();
    await vi.advanceTimersByTimeAsync(20000);
    expect(reads).toBe(2);
  } finally { leases.forEach(lease => lease.release()); }
});

it('does not turn a wrong generation or failed probe into authoritative absence', async () => {
  let fail = false;
  const lease = acquireSelectedDaemonHealth(env, { attachClient: async () => ({
    version: async () => { if (fail) throw Error('offline'); return info(99); },
    identities: async () => [{ name: 'Other' }], close: async () => {},
  }) } as never);
  try {
    let sample = await lease.sample();
    expect(sample.generation).toEqual({ state: 'unavailable', reason: 'DAEMON_GENERATION_MISMATCH' });
    expect(lease.presence('T', sample).state).toBe('unknown');
    fail = true;
    await vi.advanceTimersByTimeAsync(2000);
    sample = await lease.sample();
    expect(sample.generation.state).toBe('unavailable');
    expect(lease.presence('T', sample).state).toBe('unknown');
  } finally { lease.release(); }
});

it('bounds stalled I/O to ten seconds and closes the selected client', async () => {
  let closed = 0;
  let reads = 0;
  const lease = acquireSelectedDaemonHealth(env, { attachClient: async () => ({
    version: async () => { reads++; return new Promise(() => {}); },
    identities: async () => [{ name: 'Other' }], close: async () => { closed++; },
  }) } as never);
  try {
    const sample = lease.sample();
    await vi.advanceTimersByTimeAsync(9999);
    expect(reads).toBe(1);
    expect(closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await sample).generation.state).toBe('unavailable');
    expect(closed).toBe(1);
    lease.release();
    await vi.advanceTimersByTimeAsync(20000);
    expect(reads).toBe(1);
  } finally { lease.release(); }
});

it('closes a late selection after final release and never publishes it into a replacement owner', async () => {
  let attach!: (client: unknown) => void;
  let closed = 0;
  const old = acquireSelectedDaemonHealth(env, {
    attachClient: () => new Promise(resolve => { attach = resolve; }),
  } as never);
  const oldSample = old.sample();
  old.release();
  expect((await oldSample).generation.state).toBe('unavailable');
  const replacement = acquireSelectedDaemonHealth(env, { attachClient: async () => ({
    version: async () => info(), identities: async () => [{ name: 'Root' }], close: async () => {},
  }) } as never);
  try {
    attach({ version: async () => info(99), identities: async () => [], close: async () => { closed++; } });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(1);
    expect((await replacement.sample()).generation.state).toBe('ready');
  } finally { replacement.release(); }
});

it('isolates different credential profiles selecting the same daemon', async () => {
  const secondRoot = mkdtempSync(join(tmpdir(), 'selected-health-other-'));
  let reads = 0;
  const deps = { attachClient: async () => ({
    version: async () => { reads++; return info(); },
    identities: async () => [{ name: 'Root' }], close: async () => {},
  }) };
  const first = acquireSelectedDaemonHealth(env, deps as never);
  const second = acquireSelectedDaemonHealth(gatewayFixture(secondRoot).env, deps as never);
  try {
    await Promise.all([first.sample(), second.sample()]);
    expect(reads).toBe(2);
  } finally {
    first.release(); second.release(); rmSync(secondRoot, { recursive: true, force: true });
  }
});

it('refreshes an overdue snapshot before exposing absence after an event-loop suspension', async () => {
  let reads = 0;
  const lease = acquireSelectedDaemonHealth(env, { attachClient: async () => ({
    version: async () => { reads++; if (reads > 1) throw Error('offline'); return info(); },
    identities: async () => [{ name: 'Other' }], close: async () => {},
  }) } as never);
  try {
    expect(lease.presence('T', await lease.sample()).state).toBe('absent');
    vi.setSystemTime(Date.now() + 5000); // Advance wall time without running queued timers.
    const resumed = await lease.sample();
    expect(reads).toBe(2);
    expect(lease.presence('T', resumed).state).toBe('unknown');
  } finally { lease.release(); }
});

it('cancels actual SDK HTTP I/O at the ten-second owner deadline', async () => {
  vi.useRealTimers();
  const { createServer } = await import('node:http');
  const { writeFileSync } = await import('node:fs');
  let closed = false;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/daemon/selection') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({schema:1,instanceId:'11111111-2222-3333-4444-555555555555',capabilities:['external-sessions-v1']}));
    } else if (request.url === '/daemon/version?startup=1') {
      response.on('close', () => { closed = true; });
      started(); // Deliberately hold the real HTTP response beyond owner deadline.
    } else { response.setHeader('content-type','application/json'); response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address() as {port:number};
  const selection = gatewayFixture(root,`http://127.0.0.1:${address.port}`);
  writeFileSync(selection.profile.credentialPath,'health-test-token',{mode:0o600});
  const lease = acquireSelectedDaemonHealth(selection.env);
  try {
    await requested;
    expect((await lease.sample()).generation.state).toBe('unavailable');
    await new Promise(resolve=>setTimeout(resolve,100));
    expect(closed,'timed-out owner must cancel the underlying HTTP response').toBe(true);
  } finally {
    lease.release(); server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
},15000);
