import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, idempotencyKey } from './api';
import { CreateRole } from './CreateRole';
import { RoleWorkspace } from './RoleWorkspace';

type FleetItem = {
  role: {
    id: string; lifetime: string; configured: boolean;
    config?: { harness: string; session: string; mission?: string; model?: string };
    problems: Array<{ detail: string }>;
  };
  status: {
    overall: string; observedAt: string;
    supervisor: { liveness: string };
    session: { backend: string; reachability: string; readiness: string; evidence: string; pendingPermissionId?: string };
    monitor: { health: string };
    restart: { circuit: string };
    problems: Array<{ detail: string }>;
  };
  capabilities: Record<string, unknown>;
};

export function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState<FleetItem[]>([]);
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'fleet' | 'attention' | 'audit'>('fleet');
  const [creating, setCreating] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'polling'>('connecting');
  const [meta, setMeta] = useState<{ version?: string; auditDegraded?: string }>();

  const refresh = useCallback(async () => {
    try {
      const [fleet, serverMeta] = await Promise.all([
        api.get<{ roles: FleetItem[] }>('/api/v1/roles'),
        api.get<{ version: string; auditDegraded?: string }>('/api/v1/meta'),
      ]);
      setItems(fleet.roles);
      setMeta(serverMeta);
      setError('');
    } catch (reason) { setError((reason as Error).message); }
  }, []);

  useEffect(() => {
    void api.bootstrap().then(async () => {
      setReady(true);
      await refresh();
    }).catch(reason => setError((reason as Error).message));
  }, [refresh]);

  useEffect(() => {
    if (!ready) return;
    let socket: WebSocket | undefined;
    let cancelled = false;
    void api.post<{ ticket: string }>('/api/v1/ws-tickets', { purpose: 'events' }).then(({ ticket }) => {
      if (cancelled) return;
      socket = new WebSocket(`ws://${location.host}/api/v1/events`, 'ours-fleet-events.v1');
      socket.onopen = () => socket?.send(JSON.stringify({ ticket }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.kind === 'ready') setConnection('live');
        else void refresh();
      };
      socket.onclose = () => setConnection('polling');
    }).catch(() => setConnection('polling'));
    const timer = setInterval(() => void refresh(), selected ? 1_000 : 3_000);
    return () => { cancelled = true; socket?.close(); clearInterval(timer); };
  }, [ready, refresh, selected]);

  useEffect(() => {
    if (matchMedia('(display-mode: standalone)').matches) return;
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);

  const shown = useMemo(() => items.filter(item => {
    const text = `${item.role.id} ${item.role.config?.mission ?? ''} ${item.status.overall}`.toLowerCase();
    return text.includes(filter.toLowerCase())
      && (view !== 'attention' || ['attention', 'offline', 'unknown'].includes(item.status.overall));
  }).sort((a, b) => {
    const attention = (item: FleetItem) => ['attention', 'offline', 'unknown'].includes(item.status.overall) ? 0 : 1;
    return attention(a) - attention(b) || a.role.id.localeCompare(b.role.id);
  }), [filter, items, view]);

  if (!ready) return <main className="auth-screen">
    <div className="brand-mark">O</div>
    <h1>ours fleet</h1>
    <p>{error || 'Securing this local session…'}</p>
  </main>;

  return <div className="shell">
    <aside>
      <div className="brand"><span>O</span><div><strong>ours</strong><small>fleet console</small></div></div>
      <nav aria-label="Primary">
        {(['fleet', 'attention', 'audit'] as const).map(name =>
          <button className={view === name ? 'active' : ''} key={name} onClick={() => {
            setView(name); setSelected('');
          }}>
            <span>{name === 'fleet' ? '◫' : name === 'attention' ? '△' : '≡'}</span>{name}
            {name === 'attention' && <b>{items.filter(item => ['attention', 'offline', 'unknown'].includes(item.status.overall)).length}</b>}
          </button>)}
      </nav>
      <div className="sidebar-foot"><i className={connection} /> {connection}
        <small>v{meta?.version}</small></div>
    </aside>
    <section className="main">
      <header>
        <div>
          <span className="eyebrow">{selected ? 'role workspace' : view}</span>
          <h1>{selected || (view === 'attention' ? 'Needs attention' : view === 'audit' ? 'Audit trail' : 'Your fleet')}</h1>
        </div>
        <div className="header-actions">
          {installPrompt && <button className="secondary" onClick={() => {
            void installPrompt.prompt(); setInstallPrompt(undefined);
          }}>Install app</button>}
          <button className="secondary" onClick={() => void refresh()}>Refresh</button>
          <button className="secondary" onClick={() => void api.logout().finally(() => location.reload())}>Sign out</button>
          <button className="primary" onClick={() => setCreating(true)}>＋ Create role</button>
        </div>
      </header>
      {meta?.auditDegraded && <div className="banner warning">Audit degraded: {meta.auditDegraded}</div>}
      {error && <div className="banner error">{error}</div>}
      {selected
        ? <RoleWorkspace roleId={selected} onBack={() => setSelected('')} />
        : view === 'audit'
          ? <AuditView />
          : <div className="content">
            <div className="toolbar">
              <input aria-label="Filter roles" placeholder="Filter roles, missions, state…" value={filter}
                onChange={event => setFilter(event.target.value)} />
              <span>{shown.length} roles</span>
            </div>
            <div className="role-table">
              <div className="role-row heading">
                <span>Role</span><span>Runtime</span><span>Evidence</span><span>Monitor</span><span>Observed</span>
              </div>
              {shown.map(item => <button className="role-row" key={item.role.id} onClick={() => setSelected(item.role.id)}>
                <span className="role-name"><i className={`state ${item.status.overall}`} />
                  <span><strong>{item.role.id}</strong><small className="mission-summary"
                    title={item.role.config?.mission}>{item.role.config?.mission || 'No mission summary'}</small></span>
                  <em>{item.role.lifetime}</em></span>
                <span><strong>{item.role.config?.harness ?? 'unknown'}</strong><small>{item.status.session.backend} · {item.role.config?.model ?? 'default model'}</small></span>
                <span><strong>{sessionLabel(item.status.session)}</strong>
                  <small>{serviceLabel(item.status.supervisor.liveness)} · {item.status.session.evidence}</small></span>
                <span><strong>{item.status.monitor.health}</strong><small>{item.status.restart.circuit === 'open' ? 'circuit open' : 'circuit closed'}</small></span>
                <span><strong>{new Date(item.status.observedAt).toLocaleTimeString()}</strong><small>open →</small></span>
              </button>)}
              {!shown.length && <div className="empty">No roles match this view.</div>}
            </div>
          </div>}
    </section>
    {creating && <CreateRole onClose={() => setCreating(false)} onCreated={(role, path) => {
      setCreating(false); void refresh(); setSelected(role);
      if (path) history.replaceState(null, '', path);
    }} />}
  </div>;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

function sessionLabel(session: FleetItem['status']['session']): string {
  if (session.reachability === 'online') return `live · ${session.readiness}`;
  if (session.reachability === 'offline') return 'offline';
  return 'unknown';
}

function serviceLabel(liveness: string): string {
  return liveness === 'running' ? 'service active'
    : liveness === 'stopped' ? 'service inactive' : 'service unknown';
}

function AuditView() {
  const [records, setRecords] = useState<Array<Record<string, string>>>([]);
  useEffect(() => { void api.get<{ records: Array<Record<string, string>> }>('/api/v1/audit').then(value => setRecords(value.records)); }, []);
  return <div className="content"><div className="panel"><h2>Security & action metadata</h2>
    <p className="muted">Prompt text, terminal bytes, credentials, and log content are never recorded here.</p>
    <div className="audit-list">{records.map((record, index) =>
      <div key={index}><time>{new Date(record.at).toLocaleString()}</time><strong>{record.action}</strong><span>{record.result}</span></div>)}</div>
  </div></div>;
}
