export interface LivePollerOptions {
  intervalMs: number;
  run(signal: AbortSignal): Promise<void>;
  visible?(): boolean;
  onError?(error: unknown): void;
  setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  /** Disable the internal one-shot timer when an owning runtime supplies cadence. */
  autoSchedule?: boolean;
}

/**
 * A single-flight, visibility-aware polling loop. Results remain the caller's
 * responsibility; the AbortSignal and generation checks prevent a stopped or
 * replaced loop from publishing late work.
 */
export class LivePoller {
  private active = false;
  private running = false;
  private queued = false;
  private generation = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private lastError = '';
  private readonly visible: () => boolean;
  private readonly setTimer: NonNullable<LivePollerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<LivePollerOptions['clearTimer']>;

  constructor(private readonly options: LivePollerOptions) {
    this.visible = options.visible ?? (() => true);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.trigger();
  }

  trigger(): void {
    if (!this.active || !this.visible()) return;
    if (this.running) { this.queued = true; return; }
    if (this.timer) { this.clearTimer(this.timer); this.timer = undefined; }
    void this.poll(this.generation);
  }

  visibilityChanged(): void {
    if (!this.active) return;
    if (!this.visible()) {
      if (this.timer) { this.clearTimer(this.timer); this.timer = undefined; }
      return;
    }
    this.trigger();
  }

  stop(): void {
    this.active = false;
    this.queued = false;
    this.generation++;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation || !this.visible()) return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.options.run(controller.signal);
      if (!this.active || generation !== this.generation || controller.signal.aborted) return;
      this.lastError = '';
    } catch (error) {
      if (!this.active || generation !== this.generation || controller.signal.aborted) return;
      const message = (error as Error)?.message ?? String(error);
      if (message !== this.lastError) this.options.onError?.(error);
      this.lastError = message;
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.running = false;
      if (!this.active || generation !== this.generation) return;
      if (this.queued) {
        this.queued = false;
        this.trigger();
      } else if (this.visible() && this.options.autoSchedule !== false) {
        this.timer = this.setTimer(() => {
          this.timer = undefined;
          this.trigger();
        }, this.options.intervalMs);
      }
    }
  }
}
