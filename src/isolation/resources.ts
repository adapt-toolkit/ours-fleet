import { readFileSync } from 'node:fs';
import type { IsolationResources } from './types.js';

export interface ResourceArgs { argv: string[]; warnings: string[] }

/**
 * Build the `systemd-run --user --scope -p … --` prefix that caps the pane's
 * cgroup-v2 scope. Composed OUTSIDE the sandbox wrap (§5.3/§5.4): because tmux
 * panes are children of the shared tmux server rather than the per-role unit, the
 * only reliable per-agent limit is a transient scope at the pane itself.
 *
 * mem/pids are always enforced (their controllers are delegated to `--user` by
 * default). cpu degrades to a warning when the cpu controller is not delegated.
 */
export function resourceArgs(res: IsolationResources, cpuDelegated: boolean): ResourceArgs {
  const props: string[] = [];
  const warnings: string[] = [];

  // MemorySwapMax=0 makes MemoryMax a hard OOM bound: without it, on a host with
  // swap the overflow spills to swap instead of being killed, so the cap is soft
  // and a rogue agent could exhaust host swap.
  if (res.mem) props.push(`MemoryMax=${res.mem}`, `MemorySwapMax=0`);
  if (res.pids !== undefined) props.push(`TasksMax=${res.pids}`);
  if (res.cpu) {
    const pct = Math.round(parseFloat(res.cpu) * 100);
    if (!Number.isFinite(pct)) {
      warnings.push(`ignoring unparseable cpu value '${res.cpu}'`);
    } else if (!cpuDelegated) {
      warnings.push(
        `cpu cap '${res.cpu}' cores requested but the cpu cgroup controller is not delegated; ` +
        `enforcing mem/pids only (see doctor: one-time Delegate=cpu). CPUQuota skipped.`);
    } else {
      props.push(`CPUQuota=${pct}%`);
    }
  }

  if (props.length === 0) return { argv: [], warnings };
  const argv = ['systemd-run', '--user', '--scope'];
  for (const p of props) argv.push('-p', p);
  argv.push('--');
  return { argv, warnings };
}

/** Whether the cpu cgroup-v2 controller is delegated to this user manager. */
export function cpuControllerDelegated(read: (p: string) => string = p => readFileSync(p, 'utf8')): boolean {
  // The user manager's own cgroup lists the controllers delegated to it.
  const uid = process.getuid?.() ?? 0;
  const candidates = [
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/cgroup.controllers`,
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
  ];
  for (const p of candidates) {
    try { if (read(p).split(/\s+/).includes('cpu')) return true; } catch { /* try next */ }
  }
  return false;
}
