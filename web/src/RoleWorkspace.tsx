import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, idempotencyKey } from './api';

const TerminalView = lazy(() => import('./TerminalView').then(module => ({ default: module.TerminalView })));

export function RoleWorkspace({ roleId, onBack }: { roleId: string; onBack(): void }) {
  const [detail, setDetail] = useState<any>();
  const [tab, setTab] = useState<'overview' | 'activity' | 'terminal' | 'logs' | 'diagnostics'>('overview');
  const [output, setOutput] = useState<any>();
  const [logs, setLogs] = useState<any>();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    const value = await api.get(`/api/v1/roles/${encodeURIComponent(roleId)}`);
    setDetail(value);
  }, [roleId]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 1_000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (tab === 'activity') void api.get(`/api/v1/roles/${encodeURIComponent(roleId)}/output?limit=200`).then(setOutput);
    if (tab === 'logs') void api.get(`/api/v1/roles/${encodeURIComponent(roleId)}/logs?limit=200`).then(setLogs);
  }, [roleId, tab]);
  if (!detail) return <div className="content">Loading role evidence…</div>;
  const { role, status, capabilities } = detail;
  const action = async (name: string) => {
    const confirmation = name === 'restart_fresh' ? prompt(`Type ${roleId} to clear context`) ?? '' : undefined;
    const receipt: any = await api.post(`/api/v1/roles/${roleId}/actions`, {
      action: name, actionId: idempotencyKey(), confirmation,
    });
    setNotice(`${name.replaceAll('_', ' ')} accepted · ${receipt.actionId.slice(0, 8)}`);
  };
  const send = async () => {
    try {
      const receipt: any = await api.post(`/api/v1/roles/${roleId}/input`, { text });
      setNotice(receipt.detail); setText('');
      setTimeout(() => tab === 'activity' && api.get(`/api/v1/roles/${roleId}/output?limit=200`).then(setOutput), 400);
    } catch (reason) { setNotice((reason as Error).message); }
  };
  return <div className="workspace">
    <button className="back" onClick={onBack}>← Fleet</button>
    <div className="workspace-summary"><span className={`hero-state ${status.overall}`}><i />{status.overall}</span>
      <span>{role.lifetime}</span><span>{role.config?.harness}</span><span>{status.session.backend}</span>
      <small>observed {new Date(status.observedAt).toLocaleTimeString()}</small></div>
    <div className="tabs" role="tablist">
      {(['overview', 'activity', 'terminal', 'logs', 'diagnostics'] as const).map(name =>
        <button key={name} className={tab === name ? 'active' : ''} disabled={name === 'terminal' && !capabilities.terminal.available}
          onClick={() => setTab(name)}>{name}{name === 'terminal' && !capabilities.terminal.available ? ' · unavailable' : ''}</button>)}
    </div>
    {notice && <div className="banner info">{notice}</div>}
    {tab === 'overview' && <div className="dashboard-grid">
      <Evidence title="Supervisor" state={status.supervisor.liveness} rows={{ backend: status.supervisor.backend, evidence: status.supervisor.detail }} />
      <Evidence title="Session" state={status.session.readiness} rows={{ reachability: status.session.reachability, evidence: status.session.evidence, error: status.session.lastError }} />
      <Evidence title="Monitor" state={status.monitor.health} rows={{ mode: status.monitor.mode, stale: status.monitor.stale, detail: status.monitor.detail }} />
      <Evidence title="Restart circuit" state={status.restart.circuit} rows={{ failures: status.restart.consecutiveImmediateFailures, reason: status.restart.lastReason }} />
      <div className="panel wide"><h2>Safe actions</h2><div className="actions">
        {capabilities.lifecycle.start && <button onClick={() => void action('start')}>Start</button>}
        {capabilities.lifecycle.stop && <button onClick={() => void action('stop')}>Stop</button>}
        {capabilities.lifecycle.restartResume && <button onClick={() => void action('restart_resume')}>Restart & resume</button>}
        {capabilities.lifecycle.restartFresh && <button className="danger" onClick={() => void action('restart_fresh')}>Fresh restart…</button>}
      </div></div>
    </div>}
    {tab === 'activity' && <div className="activity-layout"><div className="activity panel">
      <h2>{status.session.backend === 'acp' ? 'Structured activity' : 'Recent pane output'}</h2>
      {output?.text && <pre>{output.text}</pre>}
      {output?.events?.map((event: any) => <article className={`event ${event.kind}`} key={event.seq}>
        <small>#{event.seq} · {event.kind.replaceAll('_', ' ')}</small>
        <p>{event.text || event.title || event.status || event.stopReason}</p>
        {event.kind === 'permission' && event.options?.map((option: any) =>
          <button key={option.optionId} onClick={() => void api.post(`/api/v1/roles/${roleId}/permissions/${event.permissionId}`, { optionId: option.optionId })}>{option.name}</button>)}
      </article>)}</div>
      {capabilities.input.text && <div className="composer panel"><h3>Send text</h3><textarea value={text} onChange={e => setText(e.target.value)} placeholder="Prompt the live session…" />
        <button className="primary" disabled={!text.trim()} onClick={() => void send()}>Send</button>
        {capabilities.input.interrupt && <button className="danger" onClick={() => confirm('Interrupt the active ACP turn?') && void api.post(`/api/v1/roles/${roleId}/interrupt`, {})}>Interrupt turn</button>}
        <small>Acceptance is not completion. Timeouts remain uncertain.</small></div>}</div>}
    {tab === 'terminal' && <Suspense fallback={<div className="panel">Loading terminal runtime…</div>}>
      <TerminalView roleId={roleId} />
    </Suspense>}
    {tab === 'logs' && <div className="panel log-panel"><h2>Redacted logs</h2><p className="muted">Raw export is disabled.</p>
      {logs?.records?.map((record: any, index: number) => <LogLine record={record} key={index} />)}</div>}
    {tab === 'diagnostics' && <div className="panel"><h2>Capabilities & problems</h2><pre>{JSON.stringify(capabilities, null, 2)}</pre>
      {[...role.problems, ...status.problems].map((problem: any, index: number) => <p className="warning" key={index}>{problem.detail}</p>)}</div>}
  </div>;
}

function LogLine({ record }: { record: any }) {
  if (record.compacted?.kind === 'monitor_stream_hiccup') return <pre>
    {record.text} ({record.compacted.reason}) — {record.compacted.count} consecutive occurrences
    {record.compacted.firstAt ? ` · first ${record.compacted.firstAt}` : ''}
    {record.compacted.lastAt ? ` · last ${record.compacted.lastAt}` : ''}
    {record.redactionApplied ? '  [redacted]' : ''}
  </pre>;
  return <pre>{record.at ? `${record.at} ` : ''}{record.text}{record.redactionApplied ? '  [redacted]' : ''}</pre>;
}

function Evidence({ title, state, rows }: { title: string; state: string; rows: Record<string, unknown> }) {
  return <div className="panel evidence"><div><h2>{title}</h2><strong>{state}</strong></div><dl>{Object.entries(rows).filter(([, value]) => value !== undefined).map(([key, value]) =>
    <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></div>;
}
