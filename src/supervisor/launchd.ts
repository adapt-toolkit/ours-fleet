import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { home, logsRoot } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { SupervisorBackend } from './types.js';

export const labelFor = (name: string) => `network.ours.fleet.${name}`;

/**
 * What `launchctl print` said about a job, parsed ONCE so that the two questions
 * asked of it cannot drift apart. They are not the same question:
 *
 * - `liveness` asks "does this role's context still exist" — a loaded job counts,
 *   including one waiting between KeepAlive restarts (1.1);
 * - `install` asks "did the job I just bootstrapped actually START" — for which a
 *   job that is loaded, not running, and has already exited once is a failure.
 *
 * On systemd one `ActiveState` answers both. Here the answers differ, so what is
 * shared is the READING of launchd's output, not its classification.
 */
export interface LaunchdJob {
  /** `launchctl print` exited 0 — the job is loaded in the domain. */
  loaded: boolean;
  /** launchd's own `state = …`, e.g. `running`, `waiting`, `not running`. */
  state?: string;
  /**
   * `last exit code|status|reason = …`. Present only once the program has RUN
   * and exited — which is what separates "died" from "has not started yet".
   */
  lastExit?: string;
  /** The domain has no such service: a definite negative, not a failed probe. */
  notFound: boolean;
  /** Why the probe itself could not be read, when it could not. */
  failure?: string;
}

/**
 * The spelling of the last-exit line is not stable across macOS releases
 * (`last exit code`, `last exit status`, `last exit reason`), so match the
 * family rather than one member. This is the load-bearing signal in
 * `classifyStart`, so it errs towards NOT matching: an unrecognised spelling
 * yields `unknown`, never a false failure.
 */
const LAST_EXIT_RE = /^\s*last exit (?:code|status|reason)\s*=\s*(.+?)\s*$/mi;
const STATE_RE = /^\s*state\s*=\s*(.+?)\s*$/m;
const agentsDir = () => join(home(), 'Library', 'LaunchAgents');
const plistPath = (name: string) => join(agentsDir(), `${labelFor(name)}.plist`);

function plist(name: string, binPath: string): string {
  const log = join(logsRoot(), `${name}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${labelFor(name)}</string>
  <key>ProgramArguments</key>
  <array><string>${binPath}</string><string>_run</string><string>${name}</string></array>
  <!-- The runner owns the child-session restart loop (3.2). launchd must only
       recover the runner PROCESS crashing: a bare KeepAlive would resume the
       uncounted relaunch loop and restart a deliberately held-down agent. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

/**
 * Did the job we just bootstrapped actually start?
 *
 * `launchctl bootstrap` exits 0 once the job is LOADED. With `RunAtLoad` the
 * program then starts asynchronously, so a zero exit is a statement about the
 * load, not about the program — the same shape of lie that `systemctl enable
 * --now` tells on systemd 255, where the exit code is 0 and the unit is dead.
 *
 * Only a DEFINITE stop counts as a failed start, exactly as on systemd:
 *
 * - not loaded at all, though bootstrap said it worked → definite;
 * - loaded, `state` is not running, AND launchd already has an exit status for
 *   it → it ran and died → definite;
 * - loaded and running, or waiting for a KeepAlive restart, or not running with
 *   nothing exited yet (it simply has not been spawned yet — the asynchrony
 *   RunAtLoad introduces) → NOT a failure;
 * - an unreadable probe → `unknown`, never a failure (1.1). launchd may be fine
 *   and the tool merely unable to answer.
 */
export function classifyStart(job: LaunchdJob): { started: 'yes' | 'no' | 'unknown'; detail: string } {
  if (job.notFound)
    return { started: 'no', detail: 'the service is not loaded in the domain' };
  if (!job.loaded)
    return { started: 'unknown', detail: job.failure ?? 'launchctl print could not be read' };
  // Deliberately narrow: only launchd's own `not running` is read as stopped.
  // Any state this does not recognise falls through to "started", because a
  // wrong guess here rolls back a role that is in fact fine.
  const stopped = job.state !== undefined && /^not running$/i.test(job.state.trim());
  if (stopped && job.lastExit !== undefined)
    return { started: 'no', detail: `state = ${job.state}, last exit = ${job.lastExit}` };
  if (stopped)
    return { started: 'unknown', detail: `state = ${job.state}, but nothing has exited yet` };
  return { started: 'yes', detail: job.state ? `state = ${job.state}` : 'loaded' };
}

export function makeLaunchdBackend(exec: Exec = realExec, uid: number = process.getuid?.() ?? 501): SupervisorBackend {
  const domain = `gui/${uid}`;

  /** Read `launchctl print` once; both callers classify it for their own question. */
  const printJob = async (name: string): Promise<LaunchdJob> => {
    const r = await exec('launchctl', ['print', `${domain}/${labelFor(name)}`]);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) return {
      loaded: false,
      notFound: /could not find service|no such process/i.test(out),
      failure: `launchctl print ${labelFor(name)} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
    };
    return {
      loaded: true,
      notFound: false,
      state: STATE_RE.exec(r.stdout)?.[1],
      lastExit: LAST_EXIT_RE.exec(r.stdout)?.[1],
    };
  };

  return {
    id: 'launchd',

    async init() {
      mkdirSync(agentsDir(), { recursive: true });
      mkdirSync(logsRoot(), { recursive: true });
      return [
        `LaunchAgents dir ready: ${agentsDir()}`,
        'note: launchd agents start at login (macOS has no linger equivalent)',
      ];
    },

    async install(name, binPath) {
      mkdirSync(agentsDir(), { recursive: true });
      mkdirSync(logsRoot(), { recursive: true });
      // The plist's prior existence is the record of whether we created this.
      const existed = existsSync(plistPath(name));
      writeFileSync(plistPath(name), plist(name, binPath));
      await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]); // best-effort refresh
      // Undo only what WE wrote. A plist that was already there belongs to
      // whoever put it there, and rollback may never remove it (6.2).
      const undo = async () => {
        if (existed) return;
        await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]);
        rmSync(plistPath(name), { force: true });
      };
      const r = await exec('launchctl', ['bootstrap', domain, plistPath(name)]);
      if (r.code !== 0) {
        // The plist is already on disk, carrying RunAtLoad. Throwing here means
        // `install` never returns `{created: true}`, so the creation transaction
        // records nothing and its rollback removes nothing — and a spawn that
        // failed at registration leaves a launch artifact behind (6.2). Undo our
        // own partial write before throwing, and only when WE wrote it.
        await undo();
        throw new Error(`launchctl bootstrap ${labelFor(name)} failed: ${r.stderr.trim()}`);
      }

      // THE EXIT CODE IS NOT THE SIGNAL — the launchd half of the same fix made
      // for systemd in 4023e72.
      //
      // `bootstrap` exits 0 when the job is LOADED. `RunAtLoad` then starts the
      // program asynchronously, so a zero exit says nothing about whether the
      // program ran: "bootstrap exits 0, job immediately dead" is available on
      // macOS for the same reason "enable --now exits 0, unit dead" is on
      // systemd 255. Trusting it means `ours-fleet spawn` reports a created role
      // whose job is loaded and not running.
      //
      // A failed start takes the SAME rollback path as a failed bootstrap, so
      // nothing is left behind either way.
      const start = classifyStart(await printJob(name));
      if (start.started === 'no') {
        await undo();
        throw new Error(
          `launchctl bootstrap ${labelFor(name)} reported success but the job is not running `
          + `(${start.detail}); bootstrap exits 0 once the job is loaded, which does not report a `
          + `failed start. Check: launchctl print ${domain}/${labelFor(name)}`);
      }
      return existed
        ? { created: false, detail: `${labelFor(name)} was already installed (${start.detail})` }
        : { created: true, detail: `installed ${labelFor(name)} (${start.detail})` };
    },
    async start(name) {
      const r = await exec('launchctl', ['bootstrap', domain, plistPath(name)]);
      if (r.code !== 0) await exec('launchctl', ['kickstart', `${domain}/${labelFor(name)}`]);
    },
    async stop(name) {
      const r = await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]);
      if (r.code !== 0) throw new Error(`launchctl bootout ${labelFor(name)} failed: ${r.stderr.trim()}`);
    },
    async restart(name) {
      const r = await exec('launchctl', ['kickstart', '-k', `${domain}/${labelFor(name)}`]);
      if (r.code !== 0) throw new Error(`launchctl kickstart ${labelFor(name)} failed: ${r.stderr.trim()}`);
    },
    async status(name) {
      const r = await exec('launchctl', ['print', `${domain}/${labelFor(name)}`]);
      if (r.code !== 0) return `not loaded (${labelFor(name)})`;
      return r.stdout.split('\n').slice(0, 12).join('\n');
    },
    async liveness(name) {
      const job = await printJob(name);
      // Loaded. `state = waiting` is a KeepAlive service between restarts —
      // still supervised, so its context stands. Unchanged by the install-time
      // start check above, which asks a different question of the same output.
      if (job.loaded)
        return { state: 'running', detail: job.state ? `loaded (state = ${job.state})` : 'loaded' };
      if (job.notFound) return { state: 'stopped', detail: `not loaded (${labelFor(name)})` };
      return { state: 'unknown', detail: job.failure ?? `launchctl print ${labelFor(name)} failed` };
    },
    async inspect(name) {
      const job = await printJob(name);
      if (job.loaded) return {
        backend: 'launchd' as const, state: 'running' as const,
        nativeState: job.state, detail: job.state ? `loaded (state = ${job.state})` : 'loaded',
      };
      if (job.notFound) return {
        backend: 'launchd' as const, state: 'stopped' as const,
        nativeState: 'not-loaded', detail: `not loaded (${labelFor(name)})`,
      };
      return {
        backend: 'launchd' as const, state: 'unknown' as const,
        detail: job.failure ?? `launchctl print ${labelFor(name)} failed`,
      };
    },
    async uninstall(name) {
      const existed = existsSync(plistPath(name));
      await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]);   // idempotent
      rmSync(plistPath(name), { force: true });
      return existed
        ? { removed: true, detail: `removed ${labelFor(name)}` }
        : { removed: false, detail: `${labelFor(name)} was not installed` };
    },
    logsArgs(name, follow) {
      const log = join(logsRoot(), `${name}.log`);
      return { cmd: 'tail', args: follow ? ['-f', log] : ['-n', '200', log] };
    },
  };
}
