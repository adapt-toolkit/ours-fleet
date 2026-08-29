import { useEffect, useState } from 'react';
import { api, idempotencyKey } from './api';
import { blankResource, parseResourceDraft, RESOURCE_KINDS, stableResources,
  type ResourceKind, type TypedResource } from './resource-edit-model';

type Listing = { type: 'resources'; digest: string; resources: TypedResource[] };
export function ResourceEditors() {
  const [listing, setListing] = useState<Listing>(); const [kind, setKind] = useState<ResourceKind>('Role');
  const [text, setText] = useState(() => JSON.stringify(blankResource('Role'), null, 2));
  const [error, setError] = useState('');
  const load = () => api.post<{ ok: boolean; result?: Listing; error?: { message: string } }>('/api/v1/management',
    { version: 1, requestId: 'browser', command: { operation: 'resource.list' } })
    .then(value => { if (!value.ok || !value.result) throw new Error(value.error?.message); setListing(value.result); });
  useEffect(() => { void load().catch(reason => setError((reason as Error).message)); }, []);
  const create = async () => {
    try {
      const resource = parseResourceDraft(text); const response = await api.post<any>('/api/v1/management',
        { version: 1, requestId: 'browser', command: { operation: 'resource.create', resource,
          expectedDigest: listing?.digest ?? '' } }, { 'idempotency-key': idempotencyKey() });
      if (!response.ok) throw new Error(response.error.message); await load(); setError('');
    } catch (reason) { setError((reason as Error).message); }
  };
  return <section className="panel"><h2>Typed resources</h2>
    <p>Roles are inert behavior definitions, Brains are runtime definitions, and Agents bind one of each.</p>
    {error && <div className="banner error">{error}</div>}
    <label>New resource kind<select value={kind} onChange={event => { const next = event.target.value as ResourceKind;
      setKind(next); setText(JSON.stringify(blankResource(next), null, 2)); }}>
      {RESOURCE_KINDS.map(value => <option key={value}>{value}</option>)}</select></label>
    <textarea aria-label="Typed resource JSON" value={text} onChange={event => setText(event.target.value)} rows={16} />
    <button className="primary" onClick={() => void create()}>Create {kind}</button>
    <ul>{stableResources(listing?.resources ?? []).map(resource =>
      <li key={`${resource.kind}:${resource.id}`}><b>{resource.kind}</b> {resource.id}</li>)}</ul>
  </section>;
}
