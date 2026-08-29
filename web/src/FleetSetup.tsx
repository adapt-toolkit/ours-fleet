import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

type Model = Record<string, any>;
export type ConfigRead = {
  path: string; exists: boolean; firstRun: boolean; revision: string; model: Model; redactions: string[];
};
type Preview = {
  valid: true; revision: string; normalizedModel: Model; diff: string;
  impact: { required: boolean; roles: string[]; watchdogScheduler: boolean; scheduledLoops: boolean; summary: string };
  preflight: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
};

const entries = (value: unknown) => Object.entries((value && typeof value === 'object' ? value : {}) as Model);
type ModelOption = { id: string; label: string; reasoningEfforts: string[]; defaultReasoningEffort?: string; source: string };
type Catalogs = Record<string, ModelOption[]>;

export function FleetSetup({ initial, onSaved }: { initial: ConfigRead; onSaved(next: ConfigRead): void }) {
  const [model, setModel] = useState<Model>(() => structuredClone(initial.model));
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  useEffect(() => {
    const controller = new AbortController();
    void api.get<any>('/api/v1/creation-capabilities', controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalogs(Object.fromEntries(
        (value.harnesses ?? []).map((harness: any) => [harness.id, harness.modelOptions ?? []])));
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  const roles = useMemo(() => entries(model.roles), [model]);
  const update = (fn: (draft: Model) => void) => setModel(value => {
    const draft = structuredClone(value); fn(draft); return draft;
  });
  const review = async () => {
    setBusy(true); setError('');
    try {
      const value = await api.post<Preview>('/api/v1/configuration/preview', { revision: initial.revision, model });
      setPreview(value); setModel(value.normalizedModel); setStep(3);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const value = await api.post<Preview & { saved: true; newRevision: string; backup?: string }>(
        '/api/v1/configuration/save', { revision: initial.revision, model });
      onSaved({ ...initial, exists: true, firstRun: false, revision: value.newRevision, model: value.normalizedModel });
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="content setup-entry">
    <div className="setup-hero"><div><span className="eyebrow">safe fleet configuration</span>
      <h2>{initial.firstRun ? 'Build your first fleet' : 'Configure the fleet'}</h2>
      <p>Design the fleet, validate it with the same parser used at launch, review a redacted diff, then save atomically.</p></div>
      <div className="setup-safety"><strong>No implicit restart</strong><span>Save creates a recovery backup. Secret environment values remain hidden.</span></div>
    </div>
    <ol className="setup-steps" aria-label="Setup progress">
      {['Defaults', 'Agents', 'Automation', 'Review'].map((name, index) =>
        <li key={name} className={step === index ? 'active' : step > index ? 'done' : ''}>{index + 1}<span>{name}</span></li>)}
    </ol>
    <div className="mode-switch" role="group" aria-label="Configuration detail level">
      <button className={!advanced ? 'active' : 'secondary'} onClick={() => setAdvanced(false)}>Basic</button>
      <button className={advanced ? 'active' : 'secondary'} onClick={() => setAdvanced(true)}>Advanced</button>
      <span>Basic asks one short decision at a time. Advanced reveals permission, override, and automation tuning.</span>
    </div>
    {error && <div className="banner error">{error}</div>}
    <div className="panel setup-panel">
      {step === 0 && <Defaults model={model} catalogs={catalogs} advanced={advanced} update={update} />}
      {step === 1 && <Agents roles={roles} advanced={advanced} update={update} />}
      {step === 2 && <Automation model={model} roles={roles.map(([name]) => name)} advanced={advanced} update={update} />}
      {step === 3 && preview && <Review preview={preview} />}
      <div className="setup-actions">
        {step > 0 && <button className="secondary" onClick={() => setStep(value => value - 1)} disabled={busy}>Back</button>}
        <span />
        {step < 2 && <button className="primary" onClick={() => setStep(value => value + 1)}>Continue</button>}
        {step === 2 && <button className="primary" onClick={() => void review()} disabled={busy}>{busy ? 'Validating…' : 'Validate & review'}</button>}
        {step === 3 && <button className="primary" onClick={() => void save()} disabled={busy || !preview}>{busy ? 'Saving…' : 'Save fleet.yaml'}</button>}
      </div>
    </div>
  </div>;
}

function Defaults({ model, catalogs, advanced, update }: { model: Model; catalogs: Catalogs; advanced: boolean; update(fn: (draft: Model) => void): void }) {
  const defaults = model.defaults ?? {};
  const permissions = defaults.permissions ?? {};
  const field = (key: string, value: string) => update(draft => {
    draft.defaults ??= {}; if (value) draft.defaults[key] = value; else delete draft.defaults[key];
  });
  const harness = defaults.harness ?? 'claude-code';
  const options = catalogs[harness] ?? [];
  const selected = options.find(option => option.id === defaults.model);
  const effort = harness === 'codex' ? defaults.harness_options?.config?.model_reasoning_effort : defaults.harness_options?.effort;
  const setEffort = (value: string) => update(draft => {
    draft.defaults ??= {}; draft.defaults.harness_options ??= {};
    if (harness === 'codex') {
      draft.defaults.harness_options.config ??= {};
      if (value) draft.defaults.harness_options.config.model_reasoning_effort = value;
      else delete draft.defaults.harness_options.config.model_reasoning_effort;
    } else if (value) draft.defaults.harness_options.effort = value;
    else delete draft.defaults.harness_options.effort;
  });
  return <><h3>1. Choose how agents run</h3><p className="muted">This becomes the starting point for every agent. Existing sessions are not restarted by saving.</p>
    <div className="decision-note"><strong>Session model</strong><span>ACP gives structured activity through the selected harness adapter. Pick an exact catalog model, or let the harness resolve its default when a new session launches.</span></div>
    <div className="form-grid three">
      <label>Harness<select value={harness} onChange={event => field('harness', event.target.value)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
      <label>Session<select value={defaults.session ?? 'acp'} onChange={event => field('session', event.target.value)}><option value="acp">ACP</option></select></label>
      <label>Model<select aria-label="Fleet model" value={selected?.id ?? ''} onChange={event => { field('model', event.target.value); const next = options.find(option => option.id === event.target.value); setEffort(next?.defaultReasoningEffort ?? ''); }}>
        <option value="">Use harness default (resolved at launch)</option>{options.map(option => <option value={option.id} key={option.id}>{option.label} — {option.id}</option>)}</select></label>
      <label>Reasoning effort<select aria-label="Fleet reasoning effort" value={effort ?? ''} onChange={event => setEffort(event.target.value)}><option value="">Model default</option>{(selected?.reasoningEfforts ?? []).map(value => <option key={value}>{value}</option>)}</select></label>
      {advanced && <label>Custom model ID<input value={defaults.model ?? ''} placeholder="exact vendor model ID" onChange={event => field('model', event.target.value)} /></label>}
      {advanced && (['approval', 'filesystem', 'unattended'] as const).map(key => <label key={key}>{key}<select value={permissions[key] ?? (key === 'filesystem' ? 'workspace' : key === 'unattended' ? 'deny' : 'ask')} onChange={event => update(draft => {
        draft.defaults ??= {}; draft.defaults.permissions ??= {}; draft.defaults.permissions[key] = event.target.value;
      })}>{(key === 'approval' ? ['ask', 'auto', 'allow'] : key === 'filesystem' ? ['read-only', 'workspace', 'unrestricted'] : ['deny', 'wait']).map(value => <option key={value}>{value}</option>)}</select></label>)}
    </div></>;
}

function Agents({ roles, advanced, update }: { roles: Array<[string, any]>; advanced: boolean; update(fn: (draft: Model) => void): void }) {
  const add = () => update(draft => { draft.roles ??= {}; let n = 1; while (draft.roles[`Agent${n}`]) n++; draft.roles[`Agent${n}`] = {}; });
  return <><div className="section-title"><div><h3>2. Name the agents and give each a job</h3><p className="muted">Example: Researcher — “Find primary sources and summarize evidence.” Saving adds configuration; it does not restart running agents.</p></div><button className="secondary" onClick={add}>＋ Add agent</button></div>
    <div className="entity-list">{roles.map(([name, role]) => <div className="entity-card" key={name}>
      <div className="form-grid three">
        <label>Name<input value={name} onChange={event => update(draft => { const next = event.target.value; if (!next || next === name) return; draft.roles[next] = draft.roles[name]; delete draft.roles[name]; })} /></label>
        {advanced && <label>Coordinator<input value={role.coordinator ?? ''} onChange={event => update(draft => { draft.roles[name].coordinator = event.target.value || undefined; })} /></label>}
        {advanced && <label>Model override<input value={role.model ?? ''} placeholder="Inherit" onChange={event => update(draft => { if (event.target.value) draft.roles[name].model = event.target.value; else delete draft.roles[name].model; })} /></label>}
        <label className="wide">Mission<textarea value={role.mission ?? ''} onChange={event => update(draft => { draft.roles[name].mission = event.target.value; })} /></label>
        {advanced && <label>Oversee roles<input value={(role.oversee ?? []).map((item: any) => item.role).join(', ')} placeholder="Researcher, Reviewer" onChange={event => update(draft => { draft.roles[name].oversee = event.target.value.split(',').map((value: string) => value.trim()).filter(Boolean).map((target: string) => ({ role: target, interval: '5m' })); })} /></label>}
      </div><button className="text-button danger" onClick={() => update(draft => { delete draft.roles[name]; })}>Remove</button>
    </div>)}</div>{!roles.length && <div className="empty compact">Add at least one agent to start a fleet.</div>}</>;
}

function Automation({ model, roles, advanced, update }: { model: Model; roles: string[]; advanced: boolean; update(fn: (draft: Model) => void): void }) {
  const addWatchdog = () => update(draft => { draft.watchdogs ??= {}; let n = 1; while (draft.watchdogs[`watch${n}`]) n++; draft.watchdogs[`watch${n}`] = { coordinator: roles[0] ?? '', watch: roles, interval: '10m' }; });
  const addLoop = () => update(draft => { draft.loops ??= {}; let n = 1; while (draft.loops[`loop${n}`]) n++; draft.loops[`loop${n}`] = { roles: roles.slice(0, 1), interval: '10m', prompt: 'Review current work and act on the next concrete step.' }; });
  return <><div className="section-title"><div><h3>3. Add automation only if you need it</h3><p className="muted">Most first fleets can skip this. Watchdogs inspect health; loops send a recurring prompt. Both begin after the scheduler reloads the saved configuration.</p></div><div><button className="secondary" onClick={addWatchdog}>＋ Watchdog</button> <button className="secondary" onClick={addLoop}>＋ Loop</button></div></div>
    <div className="entity-list">{entries(model.watchdogs).map(([name, item]) => <AutomationCard key={`w-${name}`} kind="watchdog" name={name} item={item} update={update} />)}
      {entries(model.loops).map(([name, item]) => <AutomationCard key={`l-${name}`} kind="loop" name={name} item={item} update={update} />)}</div>
    {!advanced && <p className="decision-note">Switch to Advanced to tune intervals, target lists, and prompts after adding automation.</p>}
    {!entries(model.watchdogs).length && !entries(model.loops).length && <div className="empty compact">Automation is optional. Continue to review when ready.</div>}</>;
}

function AutomationCard({ kind, name, item, update }: { kind: 'watchdog' | 'loop'; name: string; item: any; update(fn: (draft: Model) => void): void }) {
  const block = kind === 'watchdog' ? 'watchdogs' : 'loops';
  return <div className="entity-card"><span className="eyebrow">{kind}</span><div className="form-grid three">
    <label>Name<input value={name} readOnly /></label>
    <label>Interval<input value={item.interval ?? '10m'} onChange={event => update(draft => { draft[block][name].interval = event.target.value; })} /></label>
    <label>{kind === 'watchdog' ? 'Watch roles' : 'Target roles'}<input value={(kind === 'watchdog' ? item.watch : item.roles ?? []).join(', ')} onChange={event => update(draft => { draft[block][name][kind === 'watchdog' ? 'watch' : 'roles'] = event.target.value.split(',').map((value: string) => value.trim()).filter(Boolean); })} /></label>
    {kind === 'watchdog' ? <label>Coordinator<input value={item.coordinator ?? ''} onChange={event => update(draft => { draft.watchdogs[name].coordinator = event.target.value; })} /></label>
      : <label className="wide">Prompt<textarea value={item.prompt ?? ''} onChange={event => update(draft => { draft.loops[name].prompt = event.target.value; })} /></label>}
  </div><button className="text-button danger" onClick={() => update(draft => { delete draft[block][name]; })}>Remove</button></div>;
}

function Review({ preview }: { preview: Preview }) {
  return <><h3>Review before save</h3><div className={`preflight ${preview.preflight.ok ? 'ok' : 'failed'}`}>
    <strong>{preview.preflight.ok ? 'Preflight passed' : 'Preflight needs attention'}</strong>
    <span>{preview.impact.summary}</span></div>
    <details open><summary>Exact redacted diff</summary><pre className="config-diff">{preview.diff || 'No changes.'}</pre></details>
    <details><summary>Doctor checks ({preview.preflight.checks.length})</summary><ul className="check-list">{preview.preflight.checks.map(check => <li key={check.name} className={check.ok ? 'ok' : 'failed'}><strong>{check.name}</strong> — {check.detail}</li>)}</ul></details></>;
}
