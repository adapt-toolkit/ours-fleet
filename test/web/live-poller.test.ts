import { describe, expect, it, vi } from 'vitest';
import { LivePoller } from '../../web/src/live-poller.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('LivePoller', () => {
  it('uses a five-second completion cadence and never overlaps requests', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let calls = 0;
    const poller = new LivePoller({ intervalMs: 5_000, run: async () => {
      calls++;
      await new Promise<void>(resolve => { release = resolve; });
    }});
    poller.start();
    await flush();
    poller.trigger();
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(1);
    release();
    await flush();
    vi.advanceTimersByTime(4_999);
    expect(calls).toBe(2); // one queued manual refresh, still single-flight
    poller.stop();
    vi.useRealTimers();
  });

  it('pauses while hidden and refreshes immediately when visible', async () => {
    vi.useFakeTimers();
    let visible = false;
    let calls = 0;
    const poller = new LivePoller({ intervalMs: 5_000, visible: () => visible,
      run: async () => { calls++; } });
    poller.start();
    vi.advanceTimersByTime(20_000);
    expect(calls).toBe(0);
    visible = true;
    poller.visibilityChanged();
    await flush();
    expect(calls).toBe(1);
    poller.stop();
    vi.useRealTimers();
  });

  it('runs again on the normal interval after a successful request', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const poller = new LivePoller({ intervalMs: 5_000, run: async () => { calls++; } });
    poller.start(); await flush();
    expect(calls).toBe(1);
    vi.advanceTimersByTime(5_000); await flush();
    expect(calls).toBe(2);
    poller.stop();
    vi.useRealTimers();
  });

  it('aborts on stop and deduplicates repeated errors until recovery', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let attempt = 0;
    let stoppedSignal: AbortSignal | undefined;
    let hold = false;
    const poller = new LivePoller({ intervalMs: 5_000,
      run: async signal => {
        stoppedSignal = signal;
        if (attempt++ < 2) throw new Error('offline');
        if (hold) await new Promise<void>(() => undefined);
      },
      onError: error => errors.push((error as Error).message),
    });
    poller.start(); await flush();
    vi.advanceTimersByTime(5_000); await flush();
    expect(errors).toEqual(['offline']);
    vi.advanceTimersByTime(5_000); await flush(); // recovery clears the error key
    hold = true;
    poller.trigger(); await flush();
    poller.stop();
    expect(stoppedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
