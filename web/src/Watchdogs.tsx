import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api';
import {
  alertNote, nextRunLabel, runDuration, watchdogChip, watchdogLine,
  type RunListEntryView, type WatchdogReportView, type WatchdogSummaryView,
} from './watchdog-presentation';

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

export function WatchdogDetail({ api, name, onBack }: { api: ApiClient; name: string; onBack(): void }) {
  const [runs, setRuns] = useState<RunListEntryView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [report, setReport] = useState<WatchdogReportView>();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Reset everything the moment the watchdog changes, before the async fetch below lands —
  // otherwise the previous watchdog's history/report would flash under the new heading.
  useEffect(() => {
    setRuns([]); setSelectedRunId(''); setReport(undefined); setError(''); setCopied(false);
    let cancelled = false;
    void api.get<{ runs: RunListEntryView[] }>(`/api/v1/watchdogs/${encodeURIComponent(name)}/reports?limit=50`)
      .then(body => {
        if (cancelled) return;
        setRuns(body.runs);
        setSelectedRunId(body.runs[0]?.runId ?? '');
      })
      .catch(reason => { if (!cancelled) setError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [api, name]);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    setReport(undefined);
    void api.get<WatchdogReportView>(
      `/api/v1/watchdogs/${encodeURIComponent(name)}/reports/${encodeURIComponent(selectedRunId)}`,
    ).then(value => { if (!cancelled) setReport(value); })
      .catch(reason => { if (!cancelled) setError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [api, name, selectedRunId]);

  const copyJson = () => {
    if (!report || !navigator.clipboard) return;
    navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1_500);
    }).catch(reason => setError((reason as Error).message));
  };

  const now = new Date();

  return <div className="content watchdog-detail">
    <button className="back" onClick={onBack}>← Back to watchdogs</button>
    {error && <div className="banner error">{error}</div>}
    <div className="watchdog-detail-layout">
      <div className="panel run-history">
        <h2>Run history</h2>
        <div className="role-table">
          <div className="role-row heading">
            <span>Run</span><span>When</span><span>Duration</span><span>Status</span><span>Counts</span>
          </div>
          {runs.map(run => <button key={run.runId}
            className={`role-row${run.runId === selectedRunId ? ' active' : ''}`}
            onClick={() => setSelectedRunId(run.runId)}>
            <span><strong>{run.runId}</strong></span>
            <span><strong>{relativeTime(run.startedAt, now)}</strong></span>
            <span><strong>{runDuration(run)}</strong></span>
            <span className={`status-chip ${runChip(run.status)}`}><i aria-hidden="true" />{run.status}</span>
            <span><strong>{run.summary.checked}/{run.summary.healthy}/{run.summary.idle}/{run.summary.anomalies}</strong></span>
          </button>)}
          {!runs.length && <div className="empty">No runs recorded yet.</div>}
        </div>
      </div>
      {report && <div className="panel watchdog-report">
        <div className="watchdog-report-head">
          <h2>Run {report.run_id}</h2>
          <span className={`status-chip ${runChip(report.status)}`}><i aria-hidden="true" />{report.status}</span>
          <button className="secondary" onClick={copyJson} disabled={!navigator.clipboard}>
            {copied ? 'Copied!' : 'Copy JSON'}
          </button>
        </div>
        {report.status === 'error'
          ? <div className="watchdog-error">
            <p className="warning">{report.error}</p>
            {report.tail && <pre>{report.tail}</pre>}
          </div>
          : <div className="watchdog-roles">
            {report.roles.map(finding => <WatchdogFindingRow key={finding.role} finding={finding} report={report} />)}
            {!report.roles.length && <div className="empty">No roles checked in this run.</div>}
          </div>}
      </div>}
    </div>
  </div>;
}

function WatchdogFindingRow({ finding, report }: { finding: WatchdogReportView['roles'][number]; report: WatchdogReportView }) {
  const healthy = finding.status === 'healthy' || finding.status === 'idle';
  const note = alertNote(finding, report);
  return <div className="watchdog-role">
    <div className="watchdog-role-head">
      <span className={`status-chip ${healthy ? 'ready' : 'attention'}`}><i aria-hidden="true" />{finding.status}</span>
      <strong>{finding.role}</strong>
      {finding.reason && <span className="muted">{finding.reason}</span>}
    </div>
    {!healthy && <p className="watchdog-role-detail">expected: healthy — observed: {finding.status}: {finding.reason}</p>}
    {!healthy && note && <p className="watchdog-role-note">{note}</p>}
    {!!finding.evidence?.length && <details>
      <summary>Evidence ({finding.evidence.length})</summary>
      <ul>{finding.evidence.map((ev, index) => <li key={index}>[{ev.source}] {ev.detail} ({ev.observed_at})</li>)}</ul>
    </details>}
  </div>;
}

function runChip(status: 'ok' | 'anomalies' | 'error'): 'ready' | 'attention' {
  return status === 'ok' ? 'ready' : 'attention';
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
