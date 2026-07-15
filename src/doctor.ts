import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { realExec, type Exec } from './exec.js';
import { loadConfig } from './config.js';
import { getAdapter } from './harness/registry.js';
import { agentDir, home, deriveXdgRuntimeDir } from './paths.js';
import { resolveIsolation } from './isolation/policy.js';
import { makeBubblewrapBackend } from './isolation/bubblewrap.js';
import type { PrereqCheck, PrereqReport } from './harness/types.js';

/** Which cgroup-v2 controllers are delegated to this user manager (advisory). */
function cgroupDelegationDetail(): string {
  try {
    const uid = process.getuid?.() ?? 0;
    const c = readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/cgroup.controllers`, 'utf8').split(/\s+/);
    const has = (n: string) => (c.includes(n) ? 'yes' : 'no');
    return `memory=${has('memory')} pids=${has('pids')} cpu=${has('cpu')}` +
      (c.includes('cpu') ? '' : ' — cpu caps degrade to a warning (one-time: Delegate=cpu)');
  } catch { return 'unknown (not cgroup-v2 or no delegation info)'; }
}

/** Host-level + per-harness prerequisite report with actionable messages. */
export async function doctor(
  opts: { harness?: string; configPath?: string } = {},
  exec: Exec = realExec,
  platform: NodeJS.Platform = process.platform,
): Promise<PrereqReport> {
  const checks: PrereqCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node', ok: major >= 20,
    detail: major >= 20 ? `v${process.versions.node}` : `v${process.versions.node} — need >= 20`,
  });

  const tmux = await exec('tmux', ['-V']);
  checks.push({
    name: 'tmux', ok: tmux.code === 0,
    detail: tmux.code === 0 ? tmux.stdout.trim() : 'not found — apt install tmux / brew install tmux',
  });

  const mcp = await exec('ours-mcp', ['--version']);
  checks.push({
    name: 'ours-mcp', ok: mcp.code === 0,
    detail: mcp.code === 0 ? mcp.stdout.trim() : 'not found — npm i -g @ours.network/mcp',
  });
  if (mcp.code === 0) {
    const st = await exec('ours-mcp', ['status']);
    checks.push({
      name: 'ours-mcp daemon', ok: st.code === 0,
      detail: st.code === 0 ? 'running' : 'not running — start it with: ours-mcp start',
    });
  }

  if (platform === 'linux') {
    const user = userInfo().username;
    const linger = await exec('loginctl', ['show-user', user, '--property=Linger']);
    const ok = linger.code === 0 && linger.stdout.includes('Linger=yes');
    checks.push({
      name: 'linger', ok,
      detail: ok ? 'enabled (roles survive logout/reboot)'
        : `not enabled — run: ours-fleet init (or: sudo loginctl enable-linger ${user})`,
    });

    // systemctl --user needs $XDG_RUNTIME_DIR/bus. The cli entry point derives
    // it from /run/user/<uid> when possible (#9), so a failure here means the
    // user manager itself is unreachable — sudo/su shell with linger off.
    const xdg = deriveXdgRuntimeDir();
    checks.push({
      name: 'user bus', ok: !!xdg,
      detail: xdg
        ? `XDG_RUNTIME_DIR=${xdg}`
        : `no XDG_RUNTIME_DIR and /run/user/<uid> missing — systemctl --user cannot reach the user manager; enable linger: sudo loginctl enable-linger ${user}`,
    });
  }

  // Isolation reporting (AC-9). Backend availability is advisory — isolation is
  // opt-in per role (OQ-1), so a missing bwrap must not fail doctor for fleets that
  // don't use it. Only a role that DECLARES isolation and cannot get it under
  // `strict` is a hard failure.
  const roles = loadConfigSafe(opts.configPath);
  const bw = await makeBubblewrapBackend(exec).available();
  checks.push({
    name: 'isolation: bubblewrap', ok: true,
    detail: bw.ok
      ? `available — ${bw.detail}`
      : `not available: ${bw.detail} (only needed for roles declaring isolation:)`,
  });
  if (platform === 'linux')
    checks.push({ name: 'isolation: cgroup delegation', ok: true, detail: cgroupDelegationDetail() });
  for (const r of roles.filter(r => r.isolation)) {
    const stateDir = agentDir(r.name);
    const policy = resolveIsolation(r.isolation!, {
      stateDir, runCwd: r.cwd ?? stateDir, home: home(), harness: r.harness,
      additionalWriteDirs: r.harness === 'codex'
        ? ((r.harness_options as { add_dirs?: string[] } | undefined)?.add_dirs ?? [])
        : [],
    });
    const caps = [
      policy.resources.mem && `mem=${policy.resources.mem}`,
      policy.resources.cpu && `cpu=${policy.resources.cpu}`,
      policy.resources.pids !== undefined && `pids=${policy.resources.pids}`,
    ].filter(Boolean).join(',') || 'none';
    const wantsBwrap = policy.backend === 'auto' || policy.backend === 'bubblewrap';
    let ok = true, detail: string;
    if (policy.backend === 'none') detail = 'backend=none (explicitly un-sandboxed)';
    else if (wantsBwrap && bw.ok) detail = `backend=bubblewrap net=${policy.network} caps=${caps}`;
    else if (wantsBwrap && policy.onUnavailable === 'strict') {
      ok = false; detail = 'WILL REFUSE to launch (strict): bubblewrap unavailable';
    } else if (wantsBwrap) detail = `degraded->un-isolated (warn): bubblewrap unavailable; caps=${caps} still apply`;
    else detail = `backend=${policy.backend} (not yet implemented)`;
    checks.push({ name: `isolation: ${r.name}`, ok, detail });
  }

  const harnesses = opts.harness
    ? [opts.harness]
    : [...new Set(roles.map(r => r.harness))];
  for (const h of harnesses) {
    try {
      const rep = await getAdapter(h).checkPrereqs();
      checks.push(...rep.checks.map(c => ({ ...c, name: `${h}: ${c.name}` })));
    } catch (e) {
      checks.push({ name: h, ok: false, detail: (e as Error).message });
    }
  }

  return { ok: checks.every(c => c.ok), checks };
}

function loadConfigSafe(configPath?: string) {
  try { return loadConfig(configPath).roles; } catch { return []; }
}
