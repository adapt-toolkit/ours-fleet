import { realExec, type Exec } from './exec.js';

/** Thin tmux wrapper; all session handling in the core goes through this. */
export class Tmux {
  constructor(private exec: Exec = realExec) {}

  async has(name: string): Promise<boolean> {
    return (await this.exec('tmux', ['has-session', '-t', name])).code === 0;
  }

  async newSession(name: string, cwd: string, shellCommand: string): Promise<void> {
    const r = await this.exec('tmux', ['new-session', '-d', '-s', name, '-c', cwd, shellCommand]);
    if (r.code !== 0) throw new Error(`tmux new-session '${name}' failed (${r.code}): ${r.stderr.trim()}`);
  }

  async kill(name: string): Promise<void> {
    await this.exec('tmux', ['kill-session', '-t', name]); // best-effort
  }

  async capture(name: string, lines = 40): Promise<string> {
    const r = await this.exec('tmux', ['capture-pane', '-t', name, '-p']);
    if (r.code !== 0) throw new Error(`tmux capture-pane '${name}' failed: ${r.stderr.trim()}`);
    const all = r.stdout.replace(/\n+$/, '').split('\n');
    return all.slice(-lines).join('\n');
  }

  async panePid(name: string): Promise<number | null> {
    const r = await this.exec('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}']);
    if (r.code !== 0) return null;
    const pid = parseInt(r.stdout.trim().split('\n')[0], 10);
    return Number.isFinite(pid) ? pid : null;
  }

  async list(): Promise<string> {
    const r = await this.exec('tmux', ['ls']);
    return r.code === 0 ? r.stdout.trimEnd() : '';
  }

  async sendText(name: string, text: string): Promise<void> {
    let r = await this.exec('tmux', ['send-keys', '-t', name, '-l', text]);
    if (r.code !== 0) throw new Error(`tmux send-keys '${name}' failed: ${r.stderr.trim()}`);
    r = await this.exec('tmux', ['send-keys', '-t', name, 'Enter']);
    if (r.code !== 0) throw new Error(`tmux send-keys Enter '${name}' failed: ${r.stderr.trim()}`);
  }

  async sendKey(name: string, key: string): Promise<void> {
    const r = await this.exec('tmux', ['send-keys', '-t', name, key]);
    if (r.code !== 0) throw new Error(`tmux send-keys '${name}' failed: ${r.stderr.trim()}`);
  }
}
