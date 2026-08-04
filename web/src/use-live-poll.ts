import { useCallback, useEffect, useRef } from 'react';
import { LivePoller } from './live-poller';

export function useLivePoll(
  run: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
  enabled = true,
  intervalMs = 5_000,
): () => void {
  const runRef = useRef(run);
  const errorRef = useRef(onError);
  runRef.current = run;
  errorRef.current = onError;
  const pollerRef = useRef<LivePoller | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const poller = new LivePoller({
      intervalMs, autoSchedule: false,
      visible: () => document.visibilityState !== 'hidden',
      run: signal => runRef.current(signal),
      onError: error => errorRef.current(error),
    });
    pollerRef.current = poller;
    let timer: ReturnType<typeof setInterval> | undefined;
    const startCadence = () => {
      if (timer || document.visibilityState === 'hidden') return;
      timer = setInterval(() => poller.trigger(), intervalMs);
    };
    const stopCadence = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const visibility = () => {
      poller.visibilityChanged();
      if (document.visibilityState === 'hidden') stopCadence();
      else startCadence();
    };
    document.addEventListener('visibilitychange', visibility);
    poller.start();
    startCadence();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      stopCadence();
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [enabled, intervalMs]);

  return useCallback(() => pollerRef.current?.trigger(), []);
}
