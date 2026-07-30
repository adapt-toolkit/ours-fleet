import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { LivenessState, SupervisorBackend } from './types.js';

export const UNIT_TEMPLATE = 'ours-fleet-agent@.service';

/**
 * Actionable hint when systemctl cannot reach the user bus. After the cli.ts
 * XDG_RUNTIME_DIR fallback this branch stays reachable only when
 * /run/user/<uid> itself is missing — i.e. linger is off and no session is
 * active — so pointing at linger is the correct first hint. (#9)
 */
export const busHint = (stderr: string): string =>
  /user scope bus|XDG_RUNTIME_DIR/.test(stderr)
    ? `\nhint: no user runtime dir — enable linger: sudo loginctl enable-linger ${userInfo().username}` +
      `\n      (if linger is already on: export XDG_RUNTIME_DIR=/run/user/$(id -u))`
    : '';
export const unitFor = (name: string) => `ours-fleet-agent@${name}.service`;

/**
 * systemd's own ActiveState vocabulary, classified. `activating` covers
 * `auto-restart` — the unit is mid-restart, not stopped, so its context stands.
 * `deactivating`/`reloading` still have a process. Only `inactive` and `failed`
 * are definite stops. Anything systemd did not report is `unknown`.
 */
export function classifyActiveState(activeState: string): LivenessState {
  switch (activeState) {
    case 'active': case 'activating': case 'reloading': case 'deactivating': return 'running';
    case 'inactive': case 'failed': return 'stopped';
    default: return 'unknown';
  }
}

export function makeSystemdBackend(exec: Exec = realExec): SupervisorBackend {
  const ctl = (...args: string[]) => exec('systemctl', ['--user', ...args]);
  return {
    id: 'systemd',

    async init(binPath: string) {
      const msgs: string[] = [];
      const unitDir = join(home(), '.config', 'systemd', 'user');
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, UNIT_TEMPLATE), `[Unit]
Description=ours-fleet agent %i
After=default.target

[Service]
Type=simple
ExecStart=${binPath} _run %i
# The RUNNER owns the child-session restart loop, with a counted, backed-off
# circuit breaker (3.2). systemd must only recover the runner PROCESS crashing —
# Restart=always here would resume the uncounted two-second relaunch loop, and
# would also restart a runner that is deliberately holding a failing agent down.
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`);
      msgs.push(`installed ${join(unitDir, UNIT_TEMPLATE)}`);
      await ctl('daemon-reload');
      const linger = await exec('loginctl', ['enable-linger', userInfo().username]);
      msgs.push(linger.code === 0
        ? 'linger enabled (roles survive logout + reboot)'
        : `warning: could not enable linger (${linger.stderr.trim() || 'permission'}) — run: sudo loginctl enable-linger ${userInfo().username}`);
      return msgs;
    },

    async install(name) {
      // Ask FIRST whether this unit was already enabled, so a rollback can tell
      // "we registered this" from "it was already here" (6.2).
      const before = await ctl('is-enabled', unitFor(name));
      const alreadyEnabled = before.stdout.trim() === 'enabled';
      const r = await ctl('enable', '--now', unitFor(name));
      if (r.code !== 0) throw new Error(`systemctl enable --now ${unitFor(name)} failed: ${r.stderr.trim()}${busHint(r.stderr)}`);
      return alreadyEnabled
        ? { created: false, detail: `${unitFor(name)} was already enabled` }
        : { created: true, detail: `enabled ${unitFor(name)}` };
    },
    async start(name) { await ctl('start', unitFor(name)); },
    async stop(name) {
      const r = await ctl('stop', unitFor(name));
      if (r.code !== 0) throw new Error(`systemctl stop ${unitFor(name)} failed: ${r.stderr.trim()}${busHint(r.stderr)}`);
    },
    async restart(name) {
      const r = await ctl('restart', unitFor(name));
      if (r.code !== 0) throw new Error(`systemctl restart ${unitFor(name)} failed: ${r.stderr.trim()}${busHint(r.stderr)}`);
    },
    async status(name) {
      const r = await ctl('status', unitFor(name), '--no-pager');
      return r.stdout || r.stderr;
    },
    async liveness(name) {
      // `show --value` is machine-readable and stable; `status` prose is not.
      const r = await ctl('show', '-p', 'ActiveState', '-p', 'SubState', '--value', unitFor(name));
      const [activeState = '', subState = ''] = r.stdout.trim().split('\n').map(l => l.trim());
      if (!activeState) return {
        state: 'unknown',
        detail: `systemctl show ${unitFor(name)} failed: ${r.stderr.trim() || `exit ${r.code}`}${busHint(r.stderr)}`,
      };
      return {
        state: classifyActiveState(activeState),
        detail: subState ? `${activeState} (${subState})` : activeState,
      };
    },
    async uninstall(name) {
      const before = await ctl('is-enabled', unitFor(name));
      const wasEnabled = before.stdout.trim() === 'enabled';
      await ctl('disable', '--now', unitFor(name));     // idempotent
      return wasEnabled
        ? { removed: true, detail: `disabled ${unitFor(name)}` }
        : { removed: false, detail: `${unitFor(name)} was not enabled` };
    },
    logsArgs(name, follow) {
      return { cmd: 'journalctl', args: ['--user', '-u', unitFor(name), ...(follow ? ['-f'] : ['-n', '200'])] };
    },
  };
}
