import { userInfo } from 'node:os';
import { realExec, type Exec } from './exec.js';
import { loadConfig } from './config.js';
import { getAdapter } from './harness/registry.js';
import type { PrereqCheck, PrereqReport } from './harness/types.js';

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
  }

  const harnesses = opts.harness
    ? [opts.harness]
    : [...new Set(loadConfigSafe(opts.configPath).map(r => r.harness))];
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
