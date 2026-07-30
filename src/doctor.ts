import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { realExec, type Exec } from './exec.js';
import { loadConfig, type ResolvedRole } from './config.js';
import { getAdapter, productionAdapters } from './harness/registry.js';
import { analyzeFleetPermissions, formatNative } from './permissions.js';
import { resolveBundledAcpAgent } from './harness/acp-agent.js';
import { agentDir, home, deriveXdgRuntimeDir } from './paths.js';
import { resolveIsolation } from './isolation/policy.js';
import { makeBubblewrapBackend } from './isolation/bubblewrap.js';
import {
  authResolutionHint, resolveEndpoint,
  type DaemonEndpoint, type FetchLike,
} from './monitor.js';
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

interface MonitorProfile {
  endpoint: DaemonEndpoint;
  roles: string[];
}

/** Resolve and deduplicate the effective daemon profiles used by monitored roles. */
function resolveMonitorProfiles(roles: ResolvedRole[]): MonitorProfile[] {
  const profiles: MonitorProfile[] = [];
  for (const role of roles.filter(r => r.monitor?.enabled)) {
    const endpoint = resolveEndpoint({ ...process.env, ...(role.env ?? {}) });
    const token = endpoint.headers['x-ours-api-token'];
    const existing = profiles.find(p =>
      p.endpoint.origin === endpoint.origin
      && p.endpoint.headers['x-ours-api-token'] === token);
    if (existing) existing.roles.push(role.name);
    else profiles.push({ endpoint, roles: [role.name] });
  }
  return profiles;
}

/** Host-level + per-harness prerequisite report with actionable messages. */
export async function doctor(
  opts: { harness?: string; configPath?: string } = {},
  exec: Exec = realExec,
  platform: NodeJS.Platform = process.platform,
  fetchImpl: FetchLike = (u, i) => globalThis.fetch(u, i) as unknown as ReturnType<FetchLike>,
): Promise<PrereqReport> {
  const checks: PrereqCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node', ok: major >= 20,
    detail: major >= 20 ? `v${process.versions.node}` : `v${process.versions.node} — need >= 20`,
  });

  // The configuration is a checked prerequisite in its own right. A config the
  // `config` command rejects must fail here too, with the same cause — while the
  // host checks below still run, because they are what the operator needs next.
  const loaded = loadConfigResult(opts.configPath);
  const roles = loaded.ok ? loaded.roles : [];
  checks.push(loaded.ok
    ? { name: 'config', ok: true, detail: loaded.files.join(' + ') || '(none — no fleet.yaml or fleet.d)' }
    : { name: 'config', ok: false, detail: loaded.error });
  checks.push(loaded.ok
    ? { name: 'roles', ok: true, detail: `${roles.length} configured` }
    : { name: 'roles', ok: false, detail: 'unknown — the configuration did not load' });

  if (roles.length === 0 || roles.some(role => (role.session ?? 'tmux') === 'tmux')) {
    const tmux = await exec('tmux', ['-V']);
    checks.push({
      name: 'tmux', ok: tmux.code === 0,
      detail: tmux.code === 0 ? tmux.stdout.trim() : 'not found — apt install tmux / brew install tmux',
    });
  }

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

  // Per-role permission translation (2.3). Rendered from the same analysis the
  // `config` command prints, so the two commands cannot disagree.
  for (const analysis of analyzeFleetPermissions(roles)) {
    if (!analysis.supported) {
      checks.push({
        name: `permissions: ${analysis.role}`, ok: false,
        detail: analysis.warnings.join('; '),
      });
      continue;
    }
    const p = analysis.permissions;
    const summary = `approval=${p.approval} filesystem=${p.filesystem} unattended=${p.unattended}`
      + ` -> ${formatNative(analysis.native)}`;
    checks.push({
      name: `permissions: ${analysis.role}`, ok: true,
      detail: analysis.warnings.length
        ? `${summary} — ${analysis.warnings.join('; ')}`
        : `${summary} (exact)`,
    });

    // The floor is checked BEFORE start (2.1): an under-permissioned unattended
    // role never reports its own failure, because the denial happens inside the
    // harness with nobody attached to see it.
    const floor = analysis.floor!;
    checks.push({
      name: `unattended floor: ${analysis.role}`,
      ok: floor.meets || analysis.floorSeverity !== 'fail',
      detail: floor.meets
        ? `grants ${analysis.capabilities!.join(', ')}`
        : `MISSING ${floor.missing.join(', ')} — with unattended=${p.unattended} these requests will `
          + `${p.unattended === 'deny' ? 'be denied silently' : 'block the turn'}; `
          + `grants only ${analysis.capabilities!.join(', ') || '(nothing)'}`,
    });
  }

  // Isolation reporting (AC-9). Backend availability is advisory — isolation is
  // opt-in per role (OQ-1), so a missing bwrap must not fail doctor for fleets that
  // don't use it. Only a role that DECLARES isolation and cannot get it under
  // `strict` is a hard failure.
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

  // Monitor daemon-API reachability (design §5): only when a role is supervised.
  // /state-dir is unauthenticated (liveness); /identities exercises the token so a
  // shared-mode misconfig (401) surfaces here rather than as a silent deaf monitor.
  const monitorProfiles = resolveMonitorProfiles(roles);
  for (const profile of monitorProfiles) {
    const { endpoint } = profile;
    const checkName = monitorProfiles.length === 1
      ? 'monitor: daemon API'
      : `monitor: daemon API (${profile.roles.join(', ')})`;
    let ok = false, detail: string;
    try {
      const live = await fetchImpl(`${endpoint.origin}/state-dir`, {});
      if (!live.ok) {
        detail = `daemon on :${endpoint.port} answered /state-dir with HTTP ${live.status} — not the ours daemon?`;
      } else {
        const auth = await fetchImpl(`${endpoint.origin}/identities`, { headers: endpoint.headers });
        if (auth.status === 401)
          detail = `reachable on :${endpoint.port} but the API token was rejected (401) — ` +
            authResolutionHint(endpoint);
        else if (!auth.ok)
          detail = `reachable on :${endpoint.port} but /identities returned HTTP ${auth.status}`;
        else {
          ok = true;
          detail = `reachable on :${endpoint.port}, authorized — supervisor wake stream available`;
        }
      }
    } catch (e) {
      detail = `unreachable on :${endpoint.port} — monitored roles run degraded until it is up ` +
        `(start it: ours-mcp start) [${(e as Error)?.message ?? e}]`;
    }
    checks.push({ name: checkName, ok, detail });
  }

  // A broken config resolves no roles and therefore no harnesses. Without a
  // fallback the AI CLI prerequisites would simply vanish from the report at
  // exactly the moment the operator is trying to work out what is wrong.
  const harnesses = opts.harness
    ? [opts.harness]
    : loaded.ok
      ? [...new Set(roles.map(r => r.harness))]
      : productionAdapters();
  for (const h of harnesses) {
    try {
      const rep = await getAdapter(h).checkPrereqs();
      checks.push(...rep.checks.map(c => ({ ...c, name: `${h}: ${c.name}` })));
    } catch (e) {
      checks.push({ name: h, ok: false, detail: (e as Error).message });
    }
  }
  for (const role of roles.filter(role => role.session === 'acp')) {
    const configured = role.session_options?.acp?.command;
    const bundled = configured == null
      ? role.harness === 'codex'
        ? resolveBundledAcpAgent(
            '@agentclientprotocol/codex-acp', 'codex-acp', 'codex-acp')
        : role.harness === 'claude-code'
          ? resolveBundledAcpAgent(
              '@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', 'claude-agent-acp')
          : undefined
      : undefined;
    const command = Array.isArray(configured)
      ? configured[0]
      : typeof configured === 'string'
        ? configured.trim().split(/\s+/)[0]
        : role.harness === 'codex'
          ? 'codex-acp'
          : role.harness === 'claude-code'
            ? 'claude-agent-acp'
            : '';
    if (!command) {
      checks.push({
        name: `acp: ${role.name}`, ok: false,
        detail: `harness '${role.harness}' has no default ACP agent; set session_options.acp.command`,
      });
      continue;
    }
    if (bundled?.bundled) {
      checks.push({
        name: `acp: ${role.name}`, ok: true,
        detail: `${command} bundled with ours-fleet`,
      });
      continue;
    }
    const result = await exec('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command]);
    checks.push({
      name: `acp: ${role.name}`,
      ok: result.code === 0,
      detail: result.code === 0
        ? `${command} available`
        : `${command} not found or failed — install the ACP adapter or set session_options.acp.command`,
    });
  }

  return { ok: checks.every(c => c.ok), checks };
}

/**
 * Loading the configuration either works or fails for a stated reason. The old
 * `loadConfigSafe()` swallowed the reason and returned `[]`, which is
 * indistinguishable from a valid fleet with no roles — so doctor reported a
 * clean bill of health for a configuration `ours-fleet config` refuses outright.
 */
type ConfigLoad =
  | { ok: true; roles: ResolvedRole[]; files: string[] }
  | { ok: false; error: string };

function loadConfigResult(configPath?: string): ConfigLoad {
  try {
    const cfg = loadConfig(configPath);
    return { ok: true, roles: cfg.roles, files: cfg.files };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
