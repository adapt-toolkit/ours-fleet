import type { Tmux } from '../tmux.js';
import type { SessionEvent, SessionHandle, SessionSnapshot, TurnResult } from './types.js';

/** SessionHandle adapter for the existing tmux transport. */
export class TmuxSession implements SessionHandle {
  readonly backend = 'tmux' as const;

  constructor(
    private readonly name: string,
    readonly pid: number,
    private readonly tmux: Tmux,
    private readonly processAlive: (pid: number) => boolean,
  ) {}

  isAlive(): boolean {
    return this.processAlive(this.pid);
  }

  snapshot(): SessionSnapshot {
    return {
      backend: 'tmux',
      alive: this.isAlive(),
      readiness: this.isAlive() ? 'idle' : 'failed',
    };
  }

  async submitPrompt(text: string): Promise<TurnResult> {
    if (!this.isAlive()) return { accepted: false, outcome: 'failed', detail: 'tmux pane is offline' };
    await this.tmux.sendText(this.name, text);
    return { accepted: true, outcome: 'inconclusive' };
  }

  async interrupt(): Promise<void> {
    await this.tmux.sendKey(this.name, 'C-c');
  }

  respondPermission(): boolean {
    return false;
  }

  eventsSince(): SessionEvent[] {
    return [];
  }

  subscribe(): () => void {
    return () => {};
  }

  setControllerAttached(): void {}

  async close(): Promise<void> {
    await this.tmux.kill(this.name);
  }
}
