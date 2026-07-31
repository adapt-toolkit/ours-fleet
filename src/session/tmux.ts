import type { Tmux } from '../tmux.js';
import { randomUUID } from 'node:crypto';
import { SessionControlError, turnResult } from './types.js';
import type {
  ExitRecord, QueuedPrompt, SessionEvent, SessionHandle, SessionSnapshot, TurnResult,
} from './types.js';

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

  async queuePrompt(text: string): Promise<QueuedPrompt> {
    if (!this.isAlive())
      throw new SessionControlError('offline', `tmux pane for '${this.name}' is offline`);
    try {
      await this.tmux.sendText(this.name, text);
    } catch (error) {
      throw new SessionControlError('backend', (error as Error)?.message ?? String(error));
    }
    // Keystrokes carry no terminal result: tmux cannot tell us how the turn ended.
    return {
      promptId: randomUUID(),
      queuedBehind: 0,
      completion: Promise.resolve(turnResult(true, 'inconclusive')),
    };
  }

  async submitPrompt(text: string): Promise<TurnResult> {
    try {
      return await (await this.queuePrompt(text)).completion;
    } catch (error) {
      if (error instanceof SessionControlError) return turnResult(false, 'failed', error.message);
      throw error;
    }
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

  /**
   * A tmux pane's exit is only visible through the record its shell wrapper
   * writes; the runner owns that file and classifies it. Nothing observable
   * from here, so say `null` rather than guess.
   */
  exitResult(): ExitRecord | null {
    return null;
  }

  async close(): Promise<void> {
    await this.tmux.kill(this.name);
  }
}
