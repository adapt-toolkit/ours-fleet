import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api';
import { nextRunLabel, watchdogChip, watchdogLine, type WatchdogSummaryView } from './watchdog-presentation';

export function WatchdogsView({ api, onSelect }: { api: ApiClient; onSelect: (name: string) => void }) {
  const [watchdogs, setWatchdogs] = useState<WatchdogSummaryView[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const body = await api.get<{ watchdogs: WatchdogSummaryView[] }>('/api/v1/watchdogs');
      setWatchdogs(body.watchdogs);
      setError('');
    } catch (reason) { setError((reason as Error).message); }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const now = new Date();

  return <div className="content">
    {error && <div className="banner error">{error}</div>}
    <div className="role-table">
      <div className="role-row heading">
        <span>Watchdog</span><span>Interval</span><span>Coordinator</span><span>Last run</span><span>Next run</span>
      </div>
      {watchdogs.map(w => <button className="role-row" key={w.name} onClick={() => onSelect(w.name)}>
        <span className="role-name"><span className={`status-chip ${watchdogChip(w)}`}>
          <i aria-hidden="true" />{chipLabel(watchdogChip(w))}</span>
          <span><strong>{w.name}</strong><small>{watchdogLine(w)}</small></span>
          <em>every {formatInterval(w.intervalMs)}</em></span>
        <span><strong>{formatInterval(w.intervalMs)}</strong></span>
        <span><strong>{w.coordinator}</strong></span>
        <span><strong>{w.lastRunAt ? relativeTime(w.lastRunAt, now) : 'never'}</strong></span>
        <span><strong>{nextRunLabel(w, now)}</strong></span>
      </button>)}
      {!watchdogs.length && <div className="empty">No watchdogs configured.</div>}
    </div>
  </div>;
}

function chipLabel(chip: 'ready' | 'attention' | 'offline'): string {
  return chip === 'ready' ? 'Ready' : chip === 'attention' ? 'Attention' : 'Offline';
}

/** Tiny local duration formatter — kept web-side (self-contained), not shared with src/duration.ts. */
function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(ms / 86_400_000);
  return `${days}d`;
}

function relativeTime(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diffMs / 86_400_000);
  return `${days}d ago`;
}
