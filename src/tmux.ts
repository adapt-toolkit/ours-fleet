import { realExec, type Exec } from './exec.js';

/** Socket-name prefix for every tmux server this fleet starts. */
export const TMUX_SOCKET_PREFIX = 'ours-fleet-';

/**
 * The tmux socket a session lives on — ONE SERVER PER SESSION (#32).
 *
 * Without `-L`, every role's pane lands on the single default tmux server. That
 * server is a child of whichever role happened to start it first, so it sits in
 * that role's unit cgroup: stopping that one unit takes down every other role's
 * pane with it. A per-session socket puts each role's server in its own unit,
 * which is what makes `stop` local to the role being stopped.
 *
 * Role names are `[A-Za-z0-9_-]+` (config.ts), so this is always a usable
 * socket filename.
 */
export const tmuxSocket = (session: string): string => `${TMUX_SOCKET_PREFIX}${session}`;

/**
 * Address a tmux command at that session's own server. EVERY tmux invocation in
 * this repository must go through here — one that forgets `-L` silently talks to
 * the shared default server and re-creates #32.
 */
export const tmuxArgs = (session: string, args: string[]): string[] =>
  ['-L', tmuxSocket(session), ...args];

/** Thin tmux wrapper retained only for supervisor=none process containment. */
export class Tmux {
  constructor(private exec: Exec = realExec) {}

  async has(name: string): Promise<boolean> {
    return (await this.exec('tmux', tmuxArgs(name, ['has-session', '-t', name]))).code === 0;
  }

  async newSession(name: string, cwd: string, shellCommand: string): Promise<void> {
    const r = await this.exec(
      'tmux', tmuxArgs(name, ['new-session', '-d', '-s', name, '-c', cwd, shellCommand]));
    if (r.code !== 0) throw new Error(`tmux new-session '${name}' failed (${r.code}): ${r.stderr.trim()}`);
  }

  /**
   * Best-effort kill. Returns whether a session was actually there to destroy —
   * the caller needs that to tell "we tore this session down" apart from "the
   * program inside it exited on its own".
   */
  async kill(name: string): Promise<boolean> {
    return (await this.exec('tmux', tmuxArgs(name, ['kill-session', '-t', name]))).code === 0;
  }

}
