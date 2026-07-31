import { useMemo, useState } from 'react';
import { api, idempotencyKey } from './api';

type Form = {
  name: string; harness: 'codex' | 'claude-code'; model: string;
  session: 'acp' | 'tmux'; cwd: string; lifetime: 'permanent' | 'temporary';
  mission: string; coordinator: string; approval: 'ask' | 'allow' | 'deny';
  filesystem: 'read-only' | 'workspace' | 'unrestricted'; unattended: 'deny' | 'wait';
  bio: string; persona: string; highRiskAcknowledged: boolean; openAfterCreate: boolean;
  reuseExistingIdentityAcknowledged: boolean; unverifiedIdentityAcknowledged: boolean;
};
const initial: Form = {
  name: '', harness: 'codex', model: '', session: 'acp', cwd: '',
  lifetime: 'permanent', mission: '', coordinator: '', approval: 'ask',
  filesystem: 'workspace', unattended: 'deny', bio: '', persona: '',
  highRiskAcknowledged: false, openAfterCreate: true,
  reuseExistingIdentityAcknowledged: false, unverifiedIdentityAcknowledged: false,
};

export function CreateRole({ onClose, onCreated }: {
  onClose(): void; onCreated(role: string, path?: string): void;
}) {
  const [form, setForm] = useState(initial);
  const [preview, setPreview] = useState<any>();
  const [action, setAction] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useMemo(() => ({
    name: form.name, harness: form.harness,
    model: form.model || undefined, session: form.session, cwd: form.cwd || undefined,
    lifetime: form.lifetime, mission: form.mission || undefined,
    coordinator: form.coordinator || undefined,
    permissions: { approval: form.approval, filesystem: form.filesystem, unattended: form.unattended },
    bio: form.bio || undefined, persona: form.persona || undefined,
    highRiskAcknowledged: form.highRiskAcknowledged,
    reuseExistingIdentityAcknowledged: form.reuseExistingIdentityAcknowledged,
    unverifiedIdentityAcknowledged: form.unverifiedIdentityAcknowledged,
    openAfterCreate: form.openAfterCreate,
  }), [form]);
  const change = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm(current => ({ ...current, [key]: value }));
    setPreview(undefined); setError('');
  };
  const review = async () => {
    setBusy(true);
    try { setPreview(await api.post('/api/v1/roles/preview', request)); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const next: any = await api.post('/api/v1/roles',
        { request, previewHash: preview.previewHash },
        { 'Idempotency-Key': idempotencyKey() });
      setAction(next);
      const poll = async () => {
        const latest: any = await api.get(`/api/v1/creation-actions/${next.actionId}`);
        setAction(latest);
        if (['session_reachable', 'attention', 'launched_unconfirmed'].includes(latest.state))
          onCreated(latest.roleId, latest.openPath);
        else if (!['failed', 'rollback_incomplete'].includes(latest.state))
          setTimeout(() => void poll(), 400);
      };
      setTimeout(() => void poll(), 300);
    } catch (reason) { setError((reason as Error).message); setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation">
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <div className="modal-head"><div><span className="eyebrow">transactional workflow</span><h2 id="create-title">Create role session</h2></div>
        <button className="icon" onClick={onClose} aria-label="Close">×</button></div>
      {!action ? <div className="wizard">
        <fieldset><legend>Identity</legend><div className="form-grid">
          <label>Role / session name<input value={form.name} onChange={e => change('name', e.target.value)} placeholder="Researcher" /></label>
          <label>Derived identity <small>fixed to role name</small><input value={form.name} readOnly aria-readonly="true" placeholder="Researcher" /></label>
          <label className="wide">Mission<input value={form.mission} onChange={e => change('mission', e.target.value)} /></label>
          <label>Coordinator<input value={form.coordinator} onChange={e => change('coordinator', e.target.value)} /></label>
        </div></fieldset>
        <fieldset><legend>Runtime</legend><div className="form-grid">
          <label>Harness<select value={form.harness} onChange={e => change('harness', e.target.value as Form['harness'])}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
          <label>Session<select value={form.session} onChange={e => change('session', e.target.value as Form['session'])}><option value="acp">ACP activity</option><option value="tmux">tmux terminal</option></select></label>
          <label>Model<input value={form.model} onChange={e => change('model', e.target.value)} placeholder="adapter default" /></label>
          <label>Lifetime<select value={form.lifetime} onChange={e => change('lifetime', e.target.value as Form['lifetime'])}><option value="permanent">Permanent</option><option value="temporary">Temporary — gone on exit/reboot</option></select></label>
          <label className="wide">Working directory <small>blank uses private role state</small><input value={form.cwd} onChange={e => change('cwd', e.target.value)} placeholder="/absolute/existing/path" /></label>
        </div></fieldset>
        <fieldset><legend>Neutral permissions</legend><div className="form-grid three">
          <label>Approval<select value={form.approval} onChange={e => change('approval', e.target.value as Form['approval'])}><option>ask</option><option>deny</option><option>allow</option></select></label>
          <label>Filesystem<select value={form.filesystem} onChange={e => change('filesystem', e.target.value as Form['filesystem'])}><option>workspace</option><option>read-only</option><option>unrestricted</option></select></label>
          <label>Unattended<select value={form.unattended} onChange={e => change('unattended', e.target.value as Form['unattended'])}><option>deny</option><option>wait</option></select></label>
        </div>{(form.approval === 'allow' || form.filesystem === 'unrestricted') &&
          <label className="risk"><input type="checkbox" checked={form.highRiskAcknowledged} onChange={e => change('highRiskAcknowledged', e.target.checked)} />
            I understand the adapter’s elevated native permission translation.</label>}</fieldset>
        <fieldset><legend>Profile</legend><div className="form-grid">
          <label>Public bio<textarea value={form.bio} onChange={e => change('bio', e.target.value)} /></label>
          <label>Local persona<textarea value={form.persona} onChange={e => change('persona', e.target.value)} /></label>
        </div></fieldset>
        {preview && <div className="review"><h3>Effective plan</h3>
          <dl>{Object.entries(preview.effective).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'default')}</dd></div>)}</dl>
          {preview.warnings?.map((warning: string) => <p className="warning" key={warning}>△ {warning}</p>)}
          {preview.prerequisites?.map((item: string) => <p className="error" key={item}>× {item}</p>)}
          {preview.identityBootstrap?.existingIdentity === 'verified' && !form.reuseExistingIdentityAcknowledged &&
            <label className="risk"><input type="checkbox" checked={false} onChange={() => change('reuseExistingIdentityAcknowledged', true)} />
              Reuse the existing local identity named {form.name}.</label>}
          {preview.identityBootstrap?.existingIdentity === 'unknown' && !form.unverifiedIdentityAcknowledged &&
            <label className="risk"><input type="checkbox" checked={false} onChange={() => change('unverifiedIdentityAcknowledged', true)} />
              Continue although identity existence could not be verified.</label>}
          <p className="muted">Binding is completed by the harness from its generated first-boot briefing; this console does not claim host-side identity creation.</p>
        </div>}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button>
          {!preview ? <button className="primary" disabled={busy || !form.name} onClick={() => void review()}>{busy ? 'Reviewing…' : 'Review effective plan'}</button>
            : <button className="primary" disabled={busy || preview.prerequisites?.length} onClick={() => void create()}>{busy ? 'Creating…' : 'Create atomically'}</button>}</div>
      </div> : <div className="progress">
        <h3>{action.roleId}</h3><p>Creation continues if this browser disconnects.</p>
        {action.stages.map((stage: any, index: number) => <div className="stage" key={`${stage.stage}-${index}`}><i /> <span><strong>{stage.stage.replaceAll('_', ' ')}</strong><small>{stage.detail || new Date(stage.at).toLocaleTimeString()}</small></span></div>)}
        {action.error && <div className="banner error">{action.error.message}</div>}
      </div>}
    </section>
  </div>;
}
