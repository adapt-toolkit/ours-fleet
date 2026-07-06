import { realExec, type Exec } from '../exec.js';
import type { IsolationBackend, ResolvedIsolation, WrapContext, NetworkMode } from './types.js';

/**
 * Phase 2 network policy: only `deny` unshares the network namespace. `broker`
 * keeps the host network so ours messaging (a loopback TCP daemon on this host —
 * see the Phase-0 spike) keeps working; hardening `broker` to `--unshare-net` +
 * a loopback forwarder is Phase 4. `allow`/`allowlist` also keep host net.
 */
export function unsharesNet(network: NetworkMode): boolean {
  return network === 'deny';
}

/** Build the `bwrap … -- <argv>` sandbox launcher argv. Pure — no I/O. */
function wrap(argv: string[], policy: ResolvedIsolation, ctx: WrapContext): string[] {
  const out: string[] = [
    'bwrap',
    '--die-with-parent',
    '--unshare-user', '--unshare-ipc', '--unshare-uts', '--unshare-pid',
    '--proc', '/proc',
    '--dev', '/dev',
    '--chdir', ctx.runCwd,
  ];

  // Read-only system dirs (allowlist model): best-effort so a missing /lib64 etc.
  // does not abort the launch.
  for (const s of policy.system) out.push('--ro-bind-try', s, s);
  // Ephemeral scratch.
  for (const t of policy.tmpfs) out.push('--tmpfs', t);

  // Durable + declared binds. State dir and cwd are runner-guaranteed → hard binds
  // (fail loud if absent); everything else is best-effort.
  for (const m of policy.mounts) {
    const hard = m.src === ctx.stateDir || m.src === ctx.runCwd;
    const flag = m.mode === 'rw'
      ? (hard ? '--bind' : '--bind-try')
      : (hard ? '--ro-bind' : '--ro-bind-try');
    out.push(flag, m.src, m.dst);
  }

  if (unsharesNet(policy.network)) out.push('--unshare-net');

  out.push('--', ...argv);
  return out;
}

export function makeBubblewrapBackend(exec: Exec = realExec): IsolationBackend {
  return {
    id: 'bubblewrap',
    async available() {
      const v = await exec('bwrap', ['--version']);
      if (v.code !== 0) return { ok: false, detail: 'bubblewrap (bwrap) not found on PATH' };
      // userns smoke test: a no-op sandbox that actually creates the namespaces.
      const smoke = await exec('bwrap', ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--', 'true']);
      if (smoke.code !== 0)
        return { ok: false, detail: `bwrap userns smoke test failed: ${smoke.stderr.trim() || `exit ${smoke.code}`}` };
      return { ok: true, detail: v.stdout.trim() };
    },
    wrap,
  };
}
