import { randomUUID } from 'node:crypto';
import { attachOursClient } from '@ours.network/sdk/client';
import { readPrivateFile } from '@ours.network/sdk/connector';
import type { ExplicitClientProfile } from '../client-profile.js';
import { CoworkProtocolError, CoworkUnavailableError } from './cowork-adapter.js';

/** Same RPC protocol as the local socket; never replay a possibly delivered mutation. */
export async function coworkHttpCall(profile: ExplicitClientProfile, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const id = randomUUID();
  const signal = AbortSignal.timeout(timeoutMs);
  const body = JSON.stringify({ version: 1, id, method, params });
  if (Buffer.byteLength(body) > 1024 * 1024) throw new CoworkProtocolError(method, 'request exceeded 1 MiB');
  try {
    const client = await attachOursClient({ endpoint: profile.endpoint, expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath, sessionMode: 'external', leaseToken: `fleet-cowork-check-${id}`, env: {}, requestSignal: signal });
    await client.close();
    const token = readPrivateFile(profile.credentialPath, 4096).toString('utf8').trim();
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
    let rpc: Record<string, unknown>;
    try { rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CoworkProtocolError(method, 'server returned malformed JSON'); }
    if (!rpc || Array.isArray(rpc) || rpc.version !== 1 || rpc.id !== id
        || Object.hasOwn(rpc, 'result') === Object.hasOwn(rpc, 'error'))
      throw new CoworkProtocolError(method, 'server returned an invalid RPC response');
    if (Object.hasOwn(rpc, 'error')) {
      const error = rpc.error as { code?: unknown; message?: unknown } | null;
      if (!error || typeof error.code !== 'string' || typeof error.message !== 'string')
        throw new CoworkProtocolError(method, 'server returned an invalid RPC error');
      throw new CoworkProtocolError(method, error.message, error.code);
    }
    if (!response.ok) throw new CoworkProtocolError(method, `management answered HTTP ${response.status}`);
    return rpc.result;
  } catch (error) {
    if (error instanceof CoworkProtocolError) throw error;
    throw new CoworkUnavailableError('Cowork HTTP management failed; check the selected server and credential', { cause: error });
  }
}
