import { readPrivateFile } from '@ours.network/sdk/connector';

/**
 * Minimal HTTP adapter for the daemon's lease-free identity reads
 * (`GET /identities/<name>/contacts-activity|history`, ours-sdk
 * docs/identity-reads.md). Kept local so Fleet does not need a newer SDK client;
 * the shapes are the daemon contract verbatim. The ordinary workspace client
 * credential is reread on every request. No identity is ever bound.
 */
export interface IdentityRef {
  identity: string;
  expectedCid: string;
  expectedProducerGeneration?: string;
}
export interface SourcePosition { protocolVersion: 1; producerGeneration: string; position: number }
export interface ContactRootClaim { root_cid: string; root_name: string; role_id: string }
export interface ContactsActivity {
  identity: { name: string; cid: string };
  source: SourcePosition;
  contacts: Array<{ name: string; container_id: string }>;
  roots: Record<string, ContactRootClaim>;
  activity: Record<string, { at: string } | { unavailable: true }>;
}
export interface IdentityHistoryPage {
  identity: { name: string; cid: string };
  source: SourcePosition;
  items: Array<Record<string, unknown> & { seq: number; wire_id: string }>;
  next_cursor: number | null;
}

export class IdentityReadError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

export interface IdentityReader {
  contactsActivity(ref: IdentityRef, signal?: AbortSignal): Promise<ContactsActivity>;
  history(ref: IdentityRef & { peer_cid: string; before_seq?: number; limit?: number }, signal?: AbortSignal): Promise<IdentityHistoryPage>;
}

export function createIdentityReader(options: { endpoint: string; credentialPath: string; fetchImpl?: typeof fetch }): IdentityReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.endpoint.replace(/\/+$/, '');
  async function get<T>(name: string, kind: 'contacts-activity' | 'history', query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const response = await fetchImpl(`${base}/identities/${encodeURIComponent(name)}/${kind}?${params}`, {
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000),
      headers: { 'x-ours-api-token': readPrivateFile(options.credentialPath, 4096).toString('utf8').trim() },
    });
    let json: unknown;
    try { json = await response.json(); }
    catch { throw new IdentityReadError(response.status, undefined, `${kind}: non-JSON response (HTTP ${response.status})`); }
    if (response.ok) return json as T;
    const error = (json as { error?: unknown })?.error;
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      throw new IdentityReadError(response.status, typeof code === 'string' ? code : undefined, `${kind}: ${String(message ?? code)}`);
    }
    throw new IdentityReadError(response.status, undefined, `${kind}: ${String(error ?? `HTTP ${response.status}`)}`);
  }
  return {
    contactsActivity: (ref, signal) => get(ref.identity, 'contacts-activity',
      { expectedCid: ref.expectedCid, expectedProducerGeneration: ref.expectedProducerGeneration }, signal),
    history: (ref, signal) => get(ref.identity, 'history', {
      peer_cid: ref.peer_cid, before_seq: ref.before_seq, limit: ref.limit,
      expectedCid: ref.expectedCid, expectedProducerGeneration: ref.expectedProducerGeneration,
    }, signal),
  };
}
