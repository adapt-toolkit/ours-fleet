import { randomUUID } from 'node:crypto';
import { attachOursClient } from '@ours.network/sdk/client';
import { readPrivateFile } from '@ours.network/sdk/connector';
import type { ExplicitClientProfile } from '../client-profile.js';
import { CoworkProtocolError, CoworkUnavailableError } from './cowork-adapter.js';

const TRANSPORT_CODES = new Set(['EACCES', 'ENOENT', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
/** Failure kinds a dependency still starting (or restarting) produces. */
const RETRYABLE_KINDS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'timeout']);
/** Statuses a reverse proxy answers with while its upstream is not serving. */
const GATEWAY_UNAVAILABLE = new Set([502, 503, 504]);
/** Media type only, never parameters; anything unusual collapses to a fixed label. */
function safeContentType(response: Response): string {
  const value = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,40}$/.test(value) ? value : 'unknown type';
}
function safeFailureKind(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'timeout';
  for (const value of [error, error instanceof Error ? error.cause : undefined]) {
    if (!value || typeof value !== 'object') continue;
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_CODES.has(code)) return code;
    const name = (value as { name?: unknown }).name;
    if (name === 'TimeoutError') return 'timeout';
    if (name === 'AbortError') return 'aborted';
  }
  return 'transport_error';
}

function safeOperation(method: string): string {
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(method) ? method : 'management';
}

/** Same RPC protocol as the local socket; never replay a possibly delivered mutation. */
export async function coworkHttpCall(profile: ExplicitClientProfile, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const id = randomUUID();
  const signal = AbortSignal.timeout(timeoutMs);
  const body = JSON.stringify({ version: 1, id, method, params });
  if (Buffer.byteLength(body) > 1024 * 1024) throw new CoworkProtocolError(method, 'request exceeded 1 MiB');
  let stage = 'server verification';
  try {
    const client = await attachOursClient({ endpoint: profile.endpoint, expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath, sessionMode: 'external', leaseToken: `fleet-cowork-check-${id}`, env: {}, requestSignal: signal });
    stage = 'verification cleanup';
    await client.close();
    stage = 'credential read';
    const token = readPrivateFile(profile.credentialPath, 4096).toString('utf8').trim();
    stage = 'management request';
    const response = await fetch(profile.serverUrl + '/cowork/management/rpc', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', 'x-ours-api-token': token },
      body,
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new CoworkProtocolError(method, 'server credential was rejected', 'unauthorized');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CoworkProtocolError(method, 'empty HTTP response');
    stage = 'management response';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) throw new CoworkProtocolError(method, 'response exceeded 4 MiB');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    // Status and media type, never the body: a proxy page may echo request data.
    const shape = `HTTP ${response.status}, ${safeContentType(response)}`;
    let rpc: Record<string, unknown> | undefined;
    let malformed = false;
    try { rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { malformed = true; }
    if (malformed || !rpc || Array.isArray(rpc) || rpc.version !== 1 || rpc.id !== id
        || Object.hasOwn(rpc, 'result') === Object.hasOwn(rpc, 'error')) {
      // A gateway whose Cowork upstream is still starting answers with its own
      // error page. That is unavailability, not a Cowork protocol violation; a
      // well-formed RPC error under the same status keeps its meaning below.
      if (GATEWAY_UNAVAILABLE.has(response.status))
        throw new CoworkUnavailableError(
          `Cowork HTTP ${safeOperation(method)} failed: gateway answered ${shape} without an RPC response`,
          { retryable: true });
      throw new CoworkProtocolError(method,
        `server returned ${malformed ? 'malformed JSON' : 'an invalid RPC response'} (${shape})`);
    }
    if (Object.hasOwn(rpc, 'error')) {
      const error = rpc.error as { code?: unknown; message?: unknown } | null;
      if (!error || typeof error.code !== 'string' || typeof error.message !== 'string')
        throw new CoworkProtocolError(method, 'server returned an invalid RPC error');
      throw new CoworkProtocolError(method, error.message, error.code);
    }
    if (!response.ok) throw new CoworkProtocolError(method, `management answered HTTP ${response.status}`);
    return rpc.result;
  } catch (error) {
    if (error instanceof CoworkProtocolError || error instanceof CoworkUnavailableError) throw error;
    // Durable cleanup records retain only .message. Keep the RPC step and a
    // bounded allowlisted category there, never raw URLs, credentials or cause text.
    const kind = safeFailureKind(error, signal);
    throw new CoworkUnavailableError(`Cowork HTTP ${safeOperation(method)} failed during ${stage} (${kind})`,
      { cause: error, retryable: stage !== 'credential read' && RETRYABLE_KINDS.has(kind) });
  }
}
