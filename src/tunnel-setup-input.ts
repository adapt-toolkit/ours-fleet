import { lstatSync, readFileSync } from 'node:fs';
import { decodeWorkspacePayload, type WorkspacePayload } from './workspace-enrollment.js';

/** Read the same private-file transport as enrollment, without consuming the grant. */
export function readTunnelSetupFile(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 32768)
    throw Error('Setup payload requires an owned private regular file (chmod 600)');
  return readFileSync(file, 'utf8');
}

export async function readTunnelSetupStdin(input: AsyncIterable<Buffer | string> = process.stdin): Promise<string> {
  let value = '';
  for await (const chunk of input) {
    value += chunk.toString();
    if (Buffer.byteLength(value) > 32768) throw Error('Tunnel setup payload is too large');
  }
  return value;
}

/** The v2 grant scopes redemption to one workspace; connector credentials stay off argv and URLs. */
export async function redeemTunnelSetup(input: string, request: typeof fetch = fetch): Promise<WorkspacePayload> {
  if (!/^[A-Za-z0-9_-]{1,32768}$/.test(input.trim())) throw Error('Invalid tunnel setup payload');
  let grant: any;
  try { grant = JSON.parse(Buffer.from(input.trim(), 'base64url').toString()); }
  catch { throw Error('Invalid tunnel setup payload'); }
  if (grant?.version === 1) return decodeWorkspacePayload(input);
  if (grant?.version !== 2 || !['https://app.ours.network', 'https://app.ours-tunnel.com'].includes(grant.appOrigin)
    || !/^[A-Za-z0-9_-]{43}$/.test(grant.code) || !Number.isSafeInteger(grant.expiresAt)
    || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 16 * 60000)
    throw Error('Tunnel setup grant is invalid or expired; download a fresh file from the App');
  let response: Response;
  try {
    response = await request(grant.appOrigin + '/account-api/workspace-install-redeem', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Origin: grant.appOrigin }, body: JSON.stringify({ code: grant.code }),
    });
  } catch { throw Error('Could not reach the account service; setup grant redemption may be unconfirmed. Check the App before requesting a fresh file'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(response.status === 410 ? 'Tunnel setup grant expired or was already used; download a fresh file from the App'
      : `Tunnel setup grant redemption failed (HTTP ${response.status}); check the App before retrying`);
  }
  let result: any;
  try { result = await response.json(); } catch { throw Error('Invalid tunnel setup response'); }
  if (typeof result?.payload !== 'string' || !/^[A-Za-z0-9_-]{1,32768}$/.test(result.payload)) throw Error('Invalid tunnel setup response');
  const payload = decodeWorkspacePayload(result.payload);
  if (payload.appOrigin !== grant.appOrigin) throw Error('Tunnel setup response origin mismatch');
  return payload;
}
