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

/** Thin tmux wrapper; all session handling in the core goes through this. */
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

  async capture(name: string, lines = 40): Promise<string> {
    const r = await this.exec('tmux', tmuxArgs(name, ['capture-pane', '-t', name, '-p']));
    if (r.code !== 0) throw new Error(`tmux capture-pane '${name}' failed: ${r.stderr.trim()}`);
    const all = r.stdout.replace(/\n+$/, '').split('\n');
    return all.slice(-lines).join('\n');
  }

  async panePid(name: string): Promise<number | null> {
    const r = await this.exec('tmux', tmuxArgs(name, ['list-panes', '-t', name, '-F', '#{pane_pid}']));
    if (r.code !== 0) return null;
    const pid = parseInt(r.stdout.trim().split('\n')[0], 10);
    return Number.isFinite(pid) ? pid : null;
  }

  /**
   * List the live sessions among `names`, asking each server in turn.
   * There is no fleet-wide `tmux ls` any more: a session per server means the
   * caller says which sessions to ask about. A server that is not running
   * answers non-zero and contributes nothing.
   */
  async list(names: readonly string[]): Promise<string> {
    const lines: string[] = [];
    for (const name of names) {
      const r = await this.exec('tmux', tmuxArgs(name, ['ls']));
      if (r.code === 0 && r.stdout.trim()) lines.push(r.stdout.trimEnd());
    }
    return lines.join('\n');
  }

  async sendText(name: string, text: string): Promise<void> {
    let r = await this.exec('tmux', tmuxArgs(name, ['send-keys', '-t', name, '-l', text]));
    if (r.code !== 0) throw new Error(`tmux send-keys '${name}' failed: ${r.stderr.trim()}`);
    r = await this.exec('tmux', tmuxArgs(name, ['send-keys', '-t', name, 'Enter']));
    if (r.code !== 0) throw new Error(`tmux send-keys Enter '${name}' failed: ${r.stderr.trim()}`);
  }

  async sendKey(name: string, key: string): Promise<void> {
    const r = await this.exec('tmux', tmuxArgs(name, ['send-keys', '-t', name, key]));
    if (r.code !== 0) throw new Error(`tmux send-keys '${name}' failed: ${r.stderr.trim()}`);
  }
}
