import { describe, it, expect } from 'vitest';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
import { resolveIsolation } from '../src/isolation/policy.js';
import type { WrapContext, IsolationConfig } from '../src/isolation/types.js';
import type { Exec } from '../src/exec.js';

const ctx: WrapContext = {
  stateDir: '/home/fleet/.ours-fleet/agents/Dev',
  runCwd: '/home/fleet/work/repo',
  home: '/home/fleet',
};

const wrap = (cfg: IsolationConfig, argv = ['claude', '--model', 'x', '--remote-control', 'Dev']) =>
  makeBubblewrapBackend().wrap(argv, resolveIsolation(cfg, ctx), ctx);

/** True if `flag src dst` appears as consecutive tokens. */
const hasTriple = (a: string[], flag: string, src: string, dst = src) => {
  for (let i = 0; i + 2 < a.length; i++)
    if (a[i] === flag && a[i + 1] === src && a[i + 2] === dst) return true;
  return false;
};

describe('bubblewrap wrap() argv', () => {
  it('produces bwrap … -- <argv> preserving the original command tail', () => {
    const a = wrap({});
    expect(a[0]).toBe('bwrap');
    const dd = a.lastIndexOf('--');
    expect(dd).toBeGreaterThan(0);
    expect(a.slice(dd + 1)).toEqual(['claude', '--model', 'x', '--remote-control', 'Dev']);
  });

  it('includes hardening flags (die-with-parent, userns, proc, dev, chdir)', () => {
    const a = wrap({});
    expect(a).toContain('--die-with-parent');
    expect(a).toContain('--unshare-user');
    expect(hasTriple(a, '--proc', '/proc') || a.includes('--proc')).toBe(true);
    expect(a).toContain('--dev');
    expect(hasTriple(a, '--chdir', ctx.runCwd, ctx.runCwd) || (a.includes('--chdir') && a.includes(ctx.runCwd))).toBe(true);
  });

  it('exposes read-only system dirs and scratch tmpfs', () => {
    const a = wrap({});
    expect(hasTriple(a, '--ro-bind-try', '/usr')).toBe(true);
    expect(a).toContain('--tmpfs');
    expect(a).toContain('/tmp');
  });

  it('hard-binds state dir and cwd read-write', () => {
    const a = wrap({});
    expect(hasTriple(a, '--bind', ctx.stateDir)).toBe(true);
    expect(hasTriple(a, '--bind', ctx.runCwd)).toBe(true);
  });

  it('best-effort binds Claude config rw', () => {
    const a = wrap({});
    expect(hasTriple(a, '--bind-try', '/home/fleet/.claude')).toBe(true);
    expect(hasTriple(a, '--bind-try', '/home/fleet/.claude.json')).toBe(true);
  });

  it('adds fs.read as ro and fs.write as rw binds', () => {
    const a = wrap({ fs: { read: ['/opt/tc'], write: ['/data/rw'] } });
    expect(hasTriple(a, '--ro-bind-try', '/opt/tc')).toBe(true);
    expect(hasTriple(a, '--bind-try', '/data/rw')).toBe(true);
  });

  it('mounts secrets read-only at their container path', () => {
    const a = wrap({ secrets: ['/host/tok:/run/secrets/tok'] });
    expect(hasTriple(a, '--ro-bind-try', '/host/tok', '/run/secrets/tok')).toBe(true);
  });

  it('never binds blocklisted host paths (exact-token check)', () => {
    const a = wrap({ fs: { write: ['/home/fleet/work/repo'] } });
    // state dir IS present (required); the key store /home/fleet/.ours (a prefix of
    // it) and other secrets must not appear as their own bind tokens.
    expect(a).toContain('/home/fleet/.ours-fleet/agents/Dev');
    for (const p of ['/home/fleet/.ssh', '/home/fleet/.aws', '/home/fleet/.ours',
      '/home/fleet/fleet.yaml', '/home/fleet/fleet.d', '/home/fleet/.docker'])
      expect(a).not.toContain(p);
  });

  it('unshares net for network: deny', () => {
    expect(wrap({ network: 'deny' })).toContain('--unshare-net');
  });

  it('keeps host net for network: broker (messaging preserved; broker hardening is Phase 4)', () => {
    expect(wrap({ network: 'broker' })).not.toContain('--unshare-net');
  });

  it('keeps host net for network: allow', () => {
    expect(wrap({ network: 'allow' })).not.toContain('--unshare-net');
  });
});

describe('bubblewrap available()', () => {
  const fakeExec = (versionCode: number, smokeCode: number): Exec => async (cmd, args) => {
    if (args.includes('--version')) return { stdout: 'bubblewrap 0.11.1\n', stderr: '', code: versionCode };
    return { stdout: '', stderr: smokeCode ? 'userns denied' : '', code: smokeCode };
  };

  it('ok when bwrap --version and the userns smoke both succeed', async () => {
    const r = await makeBubblewrapBackend(fakeExec(0, 0)).available();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('0.11.1');
  });

  it('not ok when bwrap is missing (code 127)', async () => {
    const r = await makeBubblewrapBackend(fakeExec(127, 0)).available();
    expect(r.ok).toBe(false);
  });

  it('not ok when the userns smoke test fails', async () => {
    const r = await makeBubblewrapBackend(fakeExec(0, 1)).available();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/userns|smoke|denied/i);
  });
});
