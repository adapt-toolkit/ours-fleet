import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IsolationPolicyError, canonicalPath, mountConflict, resolveIsolation,
} from '../src/isolation/policy.js';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
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

describe('forbidden-path enforcement (5.2)', () => {
  // A real directory tree, so canonicalisation (and symlinks) are exercised
  // rather than mocked. The forbidden set is derived from `home` and from the
  // agents root, so both must be real paths under the temp home.
  let home: string;
  let agentsRoot: string;
  let stateDir: string;
  let siblingDir: string;
  let workDir: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'ours-fleet-iso-')));
    agentsRoot = join(home, '.ours-fleet', 'agents');
    stateDir = join(agentsRoot, 'Dev');
    siblingDir = join(agentsRoot, 'Other');
    workDir = join(home, 'work', 'repo');
    for (const d of [stateDir, siblingDir, workDir, join(home, '.ssh'), join(home, '.ours')])
      mkdirSync(d, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const live = (over: Partial<WrapContext> = {}): WrapContext =>
    ({ stateDir, runCwd: workDir, home, harness: 'claude-code', ...over });

  const refuse = (cfg: Parameters<typeof resolveIsolation>[0], over: Partial<WrapContext> = {}) =>
    (() => { try { resolveIsolation(cfg, live(over)); return null; }
             catch (e) { return e as Error; } })();

  it('refuses an EXACT forbidden path', () => {
    const e = refuse({ fs: { write: [join(home, '.ssh')] } });
    expect(e).toBeInstanceOf(IsolationPolicyError);
    expect(e!.message).toContain('.ssh');
    expect(e!.message).toContain(' is the forbidden path');
  });

  it('refuses a DESCENDANT of a forbidden path', () => {
    const e = refuse({ fs: { read: [join(home, '.ssh', 'id_ed25519')] } });
    expect(e!.message).toContain('is inside the forbidden path');
  });

  it('refuses a PARENT that would expose a forbidden descendant', () => {
    // $HOME names nothing forbidden, but it contains ~/.ssh and ~/.ours.
    const e = refuse({ fs: { write: [home] } });
    expect(e!.message).toContain('would expose the forbidden path');
  });

  it('refuses a SYMLINK alias of a forbidden path, and says what it resolved to', () => {
    const alias = join(home, 'work', 'keys');
    symlinkSync(join(home, '.ssh'), alias);
    const e = refuse({ fs: { read: [alias] } });
    expect(e).toBeInstanceOf(IsolationPolicyError);
    expect(e!.message).toContain(alias);
    expect(e!.message).toContain('resolves to');
    expect(e!.message).toContain(join(home, '.ssh'));
  });

  it('refuses a Codex add_dirs entry the same way', () => {
    const e = refuse({}, { harness: 'codex', additionalWriteDirs: [join(home, '.ours')] });
    expect(e).toBeInstanceOf(IsolationPolicyError);
    expect(e!.message).toContain('.ours');
  });

  it('refuses a secret whose SOURCE is forbidden', () => {
    const e = refuse({ secrets: [`${join(home, '.ssh', 'id_rsa')}:/run/secrets/key`] });
    expect(e!.message).toContain('source');
    expect(e!.message).toContain('.ssh');
  });

  it('refuses a secret whose DESTINATION lands on a forbidden path', () => {
    const e = refuse({ secrets: [`${join(workDir, 'key')}:${join(home, '.ssh', 'authorized_keys')}`] });
    expect(e!.message).toContain('destination');
    expect(e!.message).toContain('.ssh');
  });

  it("permits the role's OWN state dir, which sits inside the forbidden agents root", () => {
    const r = resolveIsolation({}, live());
    expect(r.mounts.some(m => m.src === stateDir)).toBe(true);
  });

  it('does NOT permit a sibling agent state dir', () => {
    const e = refuse({ fs: { read: [siblingDir] } });
    expect(e).toBeInstanceOf(IsolationPolicyError);
    expect(e!.message).toContain('Other');
  });

  it('does NOT permit the agents root itself, which would expose every sibling', () => {
    const e = refuse({ fs: { write: [agentsRoot] } });
    expect(e).toBeInstanceOf(IsolationPolicyError);
  });

  it('still allows ordinary paths', () => {
    const r = resolveIsolation(
      { fs: { write: [join(home, 'work', 'data')], read: ['/opt/reference'] } }, live());
    expect(r.mounts.some(m => m.src === join(home, 'work', 'data'))).toBe(true);
    expect(r.mounts.some(m => m.src === '/opt/reference')).toBe(true);
  });

  it('keeps the blocklist on the resolved policy for diagnostics', () => {
    const r = resolveIsolation({}, live());
    expect(r.blocklist).toContain(join(home, '.ssh'));
    expect(r.blocklist).toContain(agentsRoot);
  });

  it('no forbidden path can reach the final bwrap argv', () => {
    // Everything that resolves is safe by construction; prove the argv agrees.
    // Compared as PATHS, not substrings — `~/.ours` is a substring of
    // `~/.ours-fleet` and an unrelated directory, which is precisely why the
    // implementation compares with a separator rather than startsWith alone.
    const r = resolveIsolation({ fs: { write: [join(home, 'work', 'data')] } }, live());
    const argv = makeBubblewrapBackend().wrap(['claude'], r, live());

    // Only BIND flags expose host content. `--tmpfs`, `--proc` and `--dev`
    // cover a path with something empty, which hides it rather than sharing it.
    const BIND = new Set(['--bind', '--bind-try', '--ro-bind', '--ro-bind-try']);
    const bound: string[] = [];
    for (let i = 0; i < argv.length; i++)
      if (BIND.has(argv[i])) bound.push(argv[i + 1], argv[i + 2]);
    expect(bound.length).toBeGreaterThan(0);

    for (const token of bound) {
      if (canonicalPath(token) === canonicalPath(stateDir)) continue;   // the allowed exception
      for (const forbidden of r.blocklist)
        expect(mountConflict(canonicalPath(token), canonicalPath(forbidden)),
          `${token} vs ${forbidden}`).toBeNull();
    }
  });

  it('the path comparison is not a substring match', () => {
    // The regression this guards: `~/.ours` (forbidden) vs `~/.ours-fleet`.
    expect(mountConflict('/home/u/.ours-fleet', '/home/u/.ours')).toBeNull();
    expect(mountConflict('/home/u/.ours/keys', '/home/u/.ours')).toBe('descendant');
    expect(mountConflict('/home/u', '/home/u/.ours')).toBe('parent');
    expect(mountConflict('/home/u/.ours', '/home/u/.ours')).toBe('exact');
  });

  it('canonicalises a path whose leading components exist but whose tail does not', () => {
    const missing = join(workDir, 'not-created-yet', 'deep');
    expect(canonicalPath(missing)).toBe(missing);
  });
});
