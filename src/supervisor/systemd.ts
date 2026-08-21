import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { home } from '../paths.js';
import { realExec, type Exec, type ExecResult } from '../exec.js';
import type { Liveness, LivenessState, SupervisorBackend } from './types.js';

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

/** Quote a systemd unit argument and escape its specifier marker. */
const unitArg = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

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

/**
 * Ask the unit what state it is actually in.
 *
 * `show --value` is machine-readable and stable across versions; `status`
 * prose is not, and neither — as it turns out — is an exit code. Shared by
 * `liveness` and by `install`'s start verification so the two cannot disagree
 * about what "running" means.
 */
async function probeLiveness(
  ctl: (...args: string[]) => Promise<ExecResult>, name: string,
): Promise<Liveness> {
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
}

export function makeSystemdBackend(exec: Exec = realExec): SupervisorBackend {
  const ctl = (...args: string[]) => exec('systemctl', ['--user', ...args]);
  return {
    id: 'systemd',

    async init(binPath: string) {
      const msgs: string[] = [];
      const unitDir = join(home(), '.config', 'systemd', 'user');
      // Lingering user units often start before a login shell imports its PATH.
      // Pin the Node runtime and persist the install-time PATH so the runner and
      // structured operator CLI resolve the same tools after reboot.
      const servicePath = [...new Set([
        dirname(process.execPath),
        ...(process.env.PATH ?? '').split(delimiter),
      ].filter(Boolean))].join(delimiter);
      // Same reason as PATH, for the other thing a lingering unit cannot inherit:
      // WHICH ours daemon this fleet was set up against.
      //
      // ours-fleet resolves its daemon from OURS_CONFIG / OURS_PORT / OURS_STATE_DIR
      // and otherwise falls back to ~/.ours and port 3050 (src/monitor.ts). A host
      // set up against a non-default daemon — the installer's multi-daemon profiles
      // do exactly this — passes that selection to `ours-fleet init` in the
      // environment, and it died there: nothing persisted it, so every runner
      // systemd started at boot resolved the default daemon again, and on a host
      // where only the non-default daemon exists that is a daemon that is not there.
      //
      // ONLY OURS_CONFIG is baked, deliberately. It names which daemon, and leaves
      // that daemon's own config file authoritative for port and state directory, so
      // a later edit to it still wins. Baking OURS_PORT/OURS_STATE_DIR would freeze
      // those into a unit file that outranks the config for ever after — the failure
      // mode @ours.network/cli avoids for the same reason (packages/cli/src/
      // service.ts: "The port is deliberately NOT baked").
      //
      // Absent from init's environment ⇒ no line, and the unit is byte-for-byte what
      // it has always been. This teaches fleet nothing about installer profiles; it
      // persists the selection fleet was initialised with.
      const unitEnv = ['PATH=' + servicePath];
      if (process.env.OURS_CONFIG) unitEnv.push('OURS_CONFIG=' + process.env.OURS_CONFIG);
      const environmentLines = unitEnv
        .map(value => `Environment="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`)
        .join('\n');
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, UNIT_TEMPLATE), `[Unit]
Description=ours-fleet agent %i
After=default.target

[Service]
Type=simple
${environmentLines}
ExecStart=${unitArg(process.execPath)} ${unitArg(binPath)} _run %i
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
      // Undo only what WE enabled. A unit that was already enabled belongs to
      // whoever enabled it, and rollback may never remove that (6.2).
      const undo = async () => { if (!alreadyEnabled) await ctl('disable', '--now', unitFor(name)); };
      if (r.code !== 0) {
        // `enable --now` is enable THEN start, so a non-zero result can arrive
        // with the symlink already written. Throwing then means `install` never
        // returns `{created: true}`, the creation transaction records nothing,
        // and a spawn that failed at registration leaves an enabled unit behind.
        await undo();
        throw new Error(`systemctl enable --now ${unitFor(name)} failed: ${r.stderr.trim()}${busHint(r.stderr)}`);
      }

      // THE EXIT CODE IS NOT THE SIGNAL, so the start is verified rather than
      // assumed.
      //
      // Measured on systemd 255: `systemctl --user enable --now` whose START
      // half fails returns **0** and reports the failed job only as prose on
      // stderr, while a bare `start` of the same unit returns 1. Trusting the
      // code there means a spawn reports success while the role's unit sits
      // enabled and dead — the exact failure this release exists to remove,
      // inside the command that creates the role.
      //
      // Asking the unit its own ActiveState is version-independent: it does not
      // care whether this systemd propagates a start failure into the exit
      // code, so it is correct both on versions that do and versions that do
      // not. Only a DEFINITE stop counts. An unanswerable probe is `unknown`
      // and must never be read as a failed start (1.1) — the unit may be
      // perfectly fine and the bus merely unreachable.
      const live = await probeLiveness(ctl, name);
      if (live.state === 'stopped') {
        await undo();
        throw new Error(
          `systemctl enable --now ${unitFor(name)} reported success but the unit is not running `
          + `(${live.detail}); systemctl exited 0, which on this version does not report a failed `
          + `start. Check: systemctl --user status ${unitFor(name)}`);
      }
      return alreadyEnabled
        ? { created: false, detail: `${unitFor(name)} was already enabled (${live.detail})` }
        : { created: true, detail: `enabled ${unitFor(name)} (${live.detail})` };
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
    liveness(name) { return probeLiveness(ctl, name); },
    async inspect(name) {
      const live = await probeLiveness(ctl, name);
      return { backend: 'systemd' as const, ...live, nativeState: live.detail.split(/\s/)[0] };
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
