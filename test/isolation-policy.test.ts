import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveIsolation } from '../src/isolation/policy.js';
import type { WrapContext } from '../src/isolation/types.js';

const ctx = (over: Partial<WrapContext> = {}): WrapContext => ({
  stateDir: '/home/fleet/.ours-fleet/agents/Dev',
  runCwd: '/home/fleet/work/repo',
  home: '/home/fleet',
  ...over,
});

const srcs = (r: ReturnType<typeof resolveIsolation>) => r.mounts.map(m => m.src);
const mount = (r: ReturnType<typeof resolveIsolation>, src: string) => r.mounts.find(m => m.src === src);

describe('resolveIsolation defaults', () => {
  it('empty isolation fills sane defaults', () => {
    const r = resolveIsolation({}, ctx());
    expect(r.backend).toBe('auto');
    expect(r.onUnavailable).toBe('warn');
    expect(r.network).toBe('broker');
    expect(r.allowHosts).toEqual([]);
    expect(r.resources).toEqual({});
  });

  it('passes through explicit backend / network / resources', () => {
    const r = resolveIsolation(
      { backend: 'bubblewrap', network: 'deny', resources: { mem: '2G', cpu: '1.5', pids: 256 } }, ctx());
    expect(r.backend).toBe('bubblewrap');
    expect(r.network).toBe('deny');
    expect(r.resources).toEqual({ mem: '2G', cpu: '1.5', pids: 256 });
  });
});

describe('resolveIsolation durable mount set', () => {
  it('always mounts state dir and cwd read-write', () => {
    const r = resolveIsolation({}, ctx());
    expect(mount(r, '/home/fleet/.ours-fleet/agents/Dev')?.mode).toBe('rw');
    expect(mount(r, '/home/fleet/work/repo')?.mode).toBe('rw');
  });

  it('always mounts the Claude config (~/.claude + ~/.claude.json) rw', () => {
    const r = resolveIsolation({}, ctx());
    expect(mount(r, '/home/fleet/.claude')?.mode).toBe('rw');
    expect(mount(r, '/home/fleet/.claude.json')?.mode).toBe('rw');
  });

  it('mounts Codex config/auth rw and shared skills ro for Codex roles', () => {
    const r = resolveIsolation({}, ctx({ harness: 'codex' }));
    expect(mount(r, '/home/fleet/.codex')?.mode).toBe('rw');
    expect(mount(r, '/home/fleet/.agents')?.mode).toBe('ro');
    expect(mount(r, '/home/fleet/.claude')).toBeUndefined();
    expect(mount(r, '/home/fleet/.claude.json')).toBeUndefined();
  });

  it('mounts harness-declared additional writable directories', () => {
    const r = resolveIsolation({}, ctx({ harness: 'codex', additionalWriteDirs: ['/data/shared'] }));
    expect(mount(r, '/data/shared')?.mode).toBe('rw');
  });

  it('does not duplicate cwd when it equals the state dir (cwd fallback)', () => {
    const sd = '/home/fleet/.ours-fleet/agents/Dev';
    const r = resolveIsolation({}, ctx({ runCwd: sd }));
    expect(srcs(r).filter(s => s === sd)).toHaveLength(1);
  });

  it('exposes read-only system dirs and scratch tmpfs', () => {
    const r = resolveIsolation({}, ctx());
    expect(r.system).toContain('/usr');
    expect(r.tmpfs).toContain('/tmp');
  });
});

describe('resolveIsolation blocklist (isolation teeth)', () => {
  it('never mounts host secrets or the key store or sibling agent dirs', () => {
    const r = resolveIsolation(
      { fs: { write: ['/home/fleet/work/repo'] } }, ctx());
    const sensitive = [
      '/home/fleet/.ssh', '/home/fleet/.aws', '/home/fleet/.ours',
      '/home/fleet/fleet.yaml', '/home/fleet/fleet.d',
      '/home/fleet/.ours-fleet/agents/OtherAgent',
    ];
    for (const p of sensitive) expect(srcs(r)).not.toContain(p);
  });

  it('names the sensitive paths in blocklist for observability', () => {
    const r = resolveIsolation({}, ctx());
    expect(r.blocklist).toContain('/home/fleet/.ssh');
    expect(r.blocklist).toContain('/home/fleet/.aws');
    expect(r.blocklist).toContain('/home/fleet/.ours');
    expect(r.blocklist).toContain(join('/home/fleet/.ours-fleet/agents')); // siblings root
  });
});

describe('resolveIsolation fs extras and secrets', () => {
  it('adds fs.write rw and fs.read ro binds', () => {
    const r = resolveIsolation(
      { fs: { write: ['/data/rw'], read: ['/opt/toolchains'] } }, ctx());
    expect(mount(r, '/data/rw')?.mode).toBe('rw');
    expect(mount(r, '/opt/toolchains')?.mode).toBe('ro');
  });

  it('parses host:container secret pairs into ro mounts', () => {
    const r = resolveIsolation(
      { secrets: ['/host/gh_token:/run/secrets/gh_token'] }, ctx());
    const m = mount(r, '/host/gh_token');
    expect(m?.dst).toBe('/run/secrets/gh_token');
    expect(m?.mode).toBe('ro');
  });
});
