import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_RECOVERY_DEADLINE_MS, DAEMON_RECOVERY_MAX_ATTEMPTS, DAEMON_RECOVERY_MAX_BACKOFF_MS,
  DaemonGenerationObserver, RoleRecoveryController, daemonRecoveryBackoff, probeDaemonGeneration,
} from '../src/daemon-recovery.js';
import type { FetchLike, FetchResponse } from '../src/monitor.js';

const stateDir = '/state/ours';
const env = { OURS_PORT: '3050', OURS_STATE_DIR: stateDir, OURS_API_TOKEN: 'test-token' };
const progress = (over: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, pid: 41, bootId: 'boot-41-1000', phase: 'ready',
  startedAt: 1_000, updatedAt: 1_100, ...over,
});

describe('role recovery controller', () => {
  it('coalesces an epoch, isolates paths, exercises bounded retries, and writes mode-0600 evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-recovery-controller-'));
    try {
      let clock = 0;
      const sleeps: number[] = [];
      let agentAttempts = 0;
      let ownerAttempts = 0;
      const controller = new RoleRecoveryController({
        role: 'Role', identity: 'Role', stateDir: dir, now: () => clock,
        sleep: async ms => { sleeps.push(ms); clock += ms; }, log: () => undefined,
        recoverAgent: async () => (++agentAttempts < 3
          ? { ok: false, reason: 'AGENT_NOT_READY' } : { ok: true }),
        recoverOwner: async () => { ownerAttempts++; return { ok: false, reason: 'OWNER_DOWN' }; },
      });
      const generation = { bootId: 'boot', pid: 2, startedAt: 1, stateDir: dir };
      const first = controller.recover(generation);
      expect(controller.recover(generation)).toBe(first);
      const status = await first;
      expect(agentAttempts).toBe(3);
      expect(ownerAttempts).toBe(DAEMON_RECOVERY_MAX_ATTEMPTS);
      expect(status).toMatchObject({
        state: 'degraded',
        paths: { agent: { state: 'recovered', attempts: 3 }, owner: { state: 'degraded', attempts: 6 } },
      });
      expect(sleeps).toEqual(expect.arrayContaining([1_000, 2_000, 4_000, 5_000]));
      const path = join(dir, '.daemon-recovery.json');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const persisted = readFileSync(path, 'utf8');
      expect(persisted).not.toContain('AGENT_NOT_READY');
      expect(persisted).not.toContain('OWNER_BODY');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('supersedes repeated boot changes and prevents cancelled late status writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-recovery-controller-'));
    try {
      const firstGate = { resolve: () => undefined, promise: Promise.resolve({ ok: true } as const) };
      let firstResolve!: (value: { ok: true }) => void;
      firstGate.promise = new Promise(resolve => { firstResolve = resolve; });
      const agent = vi.fn()
        .mockImplementationOnce(() => firstGate.promise)
        .mockResolvedValue({ ok: true });
      const controller = new RoleRecoveryController({
        role: 'Role', identity: 'Role', stateDir: dir, now: () => 1,
        sleep: async () => undefined, log: () => undefined,
        recoverAgent: agent, recoverOwner: async () => ({ ok: true }),
      });
      const old = controller.recover({ bootId: 'old', pid: 1, startedAt: 1, stateDir: dir });
      const fresh = controller.recover({ bootId: 'new', pid: 2, startedAt: 2, stateDir: dir });
      await fresh;
      const before = readFileSync(join(dir, '.daemon-recovery.json'), 'utf8');
      firstResolve({ ok: true });
      await old;
      expect(readFileSync(join(dir, '.daemon-recovery.json'), 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('invalidates delayed paths on loss, starts the next generation independently, and redacts unsafe reasons', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-recovery-controller-'));
    try {
      let resolveOld!: (value: { ok: false; reason: string }) => void;
      const oldPath = new Promise<{ ok: false; reason: string }>(resolve => { resolveOld = resolve; });
      const recoverAgent = vi.fn().mockImplementationOnce(() => oldPath).mockResolvedValue({ ok: true });
      const controller = new RoleRecoveryController({
        role: 'Role', identity: 'Role', stateDir: dir, now: () => 1,
        sleep: async () => undefined, log: () => undefined, recoverAgent,
        recoverOwner: async () => ({ ok: true }),
      });
      const old = controller.recover({ bootId: 'old', pid: 1, startedAt: 1, stateDir: dir });
      controller.noteLoss('daemon body: TOKEN=value');
      const loss = readFileSync(join(dir, '.daemon-recovery.json'), 'utf8');
      expect(loss).toContain('DAEMON_UNAVAILABLE');
      expect(loss).not.toContain('TOKEN');
      const fresh = controller.recover({ bootId: 'fresh', pid: 2, startedAt: 2, stateDir: dir });
      await fresh;
      const afterFresh = readFileSync(join(dir, '.daemon-recovery.json'), 'utf8');
      resolveOld({ ok: false, reason: 'secret body punctuation!' });
      await old;
      expect(readFileSync(join(dir, '.daemon-recovery.json'), 'utf8')).toBe(afterFresh);
      expect(recoverAgent).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('normalizes an unsafe path result before persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-recovery-controller-'));
    try {
      const controller = new RoleRecoveryController({
        role: 'Role', identity: 'Role', stateDir: dir, now: () => 1,
        sleep: async () => undefined, log: () => undefined,
        recoverAgent: async () => ({ ok: false, reason: 'body-like: SECRET=123' }),
        recoverOwner: async () => ({ ok: true }),
      });
      await controller.recover({ bootId: 'boot', pid: 1, startedAt: 1, stateDir: dir });
      const persisted = readFileSync(join(dir, '.daemon-recovery.json'), 'utf8');
      expect(persisted).toContain('RECOVERY_PATH_FAILED');
      expect(persisted).not.toContain('SECRET');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('normalizes an unsafe exception name before persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-recovery-controller-'));
    try {
      const unsafe = new Error('not persisted');
      unsafe.name = 'Body: SECRET=value';
      const controller = new RoleRecoveryController({
        role: 'Role', identity: 'Role', stateDir: dir, now: () => 1,
        sleep: async () => undefined, log: () => undefined,
        recoverAgent: async () => { throw unsafe; }, recoverOwner: async () => ({ ok: true }),
      });
      await controller.recover({ bootId: 'boot', pid: 1, startedAt: 1, stateDir: dir });
      const persisted = readFileSync(join(dir, '.daemon-recovery.json'), 'utf8');
      expect(persisted).toContain('RECOVERY_UNKNOWN_ERROR');
      expect(persisted).not.toContain('SECRET');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
const response = (body: unknown, status = 200): FetchResponse => ({
  status, ok: status >= 200 && status < 300, json: async () => body as never,
});
const fetchInfo = (body: unknown, identities: unknown = [{ name: 'Root' }]): FetchLike => async (url, init) => {
  expect(init?.headers).toEqual({ 'x-ours-api-token': 'test-token' });
  return response(url.endsWith('/identities') ? { identities } : body);
};
const deps = (text: string, paths: string[] = []) => ({
  readText: (path: string) => { paths.push(path); return text; },
  canonicalize: (path: string) => path.replace('/alias', ''),
});

describe('daemon generation observation', () => {
  it('corroborates loopback info, credentialed identity readiness, and a strict boot record', async () => {
    const paths: string[] = [];
    const result = await probeDaemonGeneration(fetchInfo({
      name: 'ours', pid: 41, stateDir: '/alias/state/ours', version: '3', compat: 1,
    }), env, deps(progress(), paths));
    expect(result).toEqual({ state: 'ready', generation: {
      bootId: 'boot-41-1000', pid: 41, startedAt: 1_000, stateDir,
    } });
    expect(paths).toEqual(['/state/ours/startup-progress.json']);
  });

  it.each([
    [progress({ phase: 'server' }), 'DAEMON_PROGRESS_NOT_READY'],
    [progress({ pid: 42 }), 'DAEMON_GENERATION_MISMATCH'],
    [progress({ bootId: '' }), 'DAEMON_PROGRESS_INVALID'],
    [progress({ completed: 2 }), 'DAEMON_PROGRESS_INVALID'],
    [progress({ completed: 3, total: 2 }), 'DAEMON_PROGRESS_INVALID'],
    [progress({ startedAt: 2_000, updatedAt: 1_999 }), 'DAEMON_PROGRESS_INVALID'],
  ])('rejects stale or malformed progress without treating it as ready', async (text, reason) => {
    const result = await probeDaemonGeneration(fetchInfo({
      name: 'ours', pid: 41, stateDir, version: '3', compat: 1,
    }), env, deps(text));
    expect(result).toEqual({ state: 'unavailable', reason });
  });

  it('rejects a stale ready file when live info is unavailable or names another state root', async () => {
    const offline = await probeDaemonGeneration(async () => { throw new Error('offline'); }, env, deps(progress()));
    expect(offline).toEqual({ state: 'unavailable', reason: 'DAEMON_INFO_UNREACHABLE' });
    const mismatch = await probeDaemonGeneration(fetchInfo({
      name: 'ours', pid: 41, stateDir: '/other', version: '3', compat: 1,
    }), env, deps(progress()));
    expect(mismatch).toEqual({ state: 'unavailable', reason: 'DAEMON_STATE_DIR_MISMATCH' });
  });

  it('requires the credential-capable identity index to finish loading', async () => {
    const info = { name: 'ours', pid: 41, stateDir, version: '3', compat: 1 };
    const unauthorized: FetchLike = async url => url.endsWith('/identities')
      ? response({}, 401) : response(info);
    expect(await probeDaemonGeneration(unauthorized, env, deps(progress())))
      .toEqual({ state: 'unavailable', reason: 'DAEMON_IDENTITIES_UNAUTHORIZED' });
    expect(await probeDaemonGeneration(fetchInfo(info, []), env, deps(progress())))
      .toEqual({ state: 'unavailable', reason: 'DAEMON_IDENTITIES_NOT_READY' });
  });

  it('distinguishes loss, availability, stable duplicates, and PID-reuse generations', () => {
    const observer = new DaemonGenerationObserver();
    const first = { bootId: 'boot-a', pid: 41, startedAt: 1, stateDir };
    const reused = { bootId: 'boot-b', pid: 41, startedAt: 2, stateDir };
    expect(observer.observe({ state: 'ready', generation: first }).kind).toBe('baseline');
    expect(observer.observe({ state: 'ready', generation: first }).kind).toBe('stable');
    expect(observer.observe({ state: 'unavailable', reason: 'DAEMON_INFO_UNREACHABLE' }).kind).toBe('lost');
    expect(observer.observe({ state: 'unavailable', reason: 'DAEMON_INFO_UNREACHABLE' }).kind).toBe('unavailable');
    expect(observer.observe({ state: 'unavailable', reason: 'DAEMON_PROGRESS_NOT_READY' }).kind).toBe('unavailable');
    expect(observer.observe({ state: 'ready', generation: reused })).toMatchObject({
      kind: 'changed', previous: first, generation: reused,
    });
    expect(observer.observe({ state: 'ready', generation: reused }).kind).toBe('stable');
  });

  it('does not manufacture a recovery epoch during ordinary cold startup', () => {
    const observer = new DaemonGenerationObserver();
    expect(observer.observe({ state: 'unavailable', reason: 'DAEMON_INFO_UNREACHABLE' }).kind)
      .toBe('unavailable');
    expect(observer.observe({ state: 'unavailable', reason: 'DAEMON_IDENTITIES_NOT_READY' }).kind)
      .toBe('unavailable');
    const first = { bootId: 'boot-a', pid: 41, startedAt: 1, stateDir };
    expect(observer.observe({ state: 'ready', generation: first }).kind).toBe('baseline');
    expect(observer.observe({ state: 'unavailable', reason: 'DAEMON_INFO_UNREACHABLE' }).kind)
      .toBe('lost');
    expect(observer.observe({ state: 'ready', generation: first }).kind).toBe('available');
  });

  it('pins bounded recovery constants and capped exponential backoff', () => {
    expect(DAEMON_RECOVERY_MAX_ATTEMPTS).toBe(6);
    expect(DAEMON_RECOVERY_DEADLINE_MS).toBe(60_000);
    expect([1, 2, 3, 4, 5, 6].map(daemonRecoveryBackoff))
      .toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
    expect(daemonRecoveryBackoff(100)).toBe(DAEMON_RECOVERY_MAX_BACKOFF_MS);
  });
});
