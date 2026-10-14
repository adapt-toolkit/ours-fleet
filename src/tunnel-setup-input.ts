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

/** Only a minimal one-use v2 grant is allowed in shell arguments. */
export function readTunnelSetupArgument(input: string): string {
  decodeTunnelSetupGrant(input);
  return input;
}

function decodeTunnelSetupGrant(input: string): {version: 2; appOrigin: string; code: string; expiresAt: number} {
  if (!/^[A-Za-z0-9_-]{1,32768}$/.test(input.trim())) throw Error('Invalid tunnel setup payload');
  let grant: any;
  try { grant = JSON.parse(Buffer.from(input.trim(), 'base64url').toString()); }
  catch { throw Error('Invalid tunnel setup payload'); }
  if (grant?.version !== 2 || Object.keys(grant).sort().join(',') !== 'appOrigin,code,expiresAt,version'
    || !['https://app.ours.network', 'https://app.ours-tunnel.com'].includes(grant.appOrigin)
    || !/^[A-Za-z0-9_-]{43}$/.test(grant.code) || !Number.isSafeInteger(grant.expiresAt)
    || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 16 * 60000)
    throw Error('Tunnel setup grant is invalid or expired; get a fresh command from the App');
  return grant;
}

/** Redeem the grant by HTTPS POST; long-lived connector credentials remain off argv and URLs. */
export async function redeemTunnelSetup(input: string, request: typeof fetch = fetch): Promise<WorkspacePayload> {
  if (!/^[A-Za-z0-9_-]{1,32768}$/.test(input.trim())) throw Error('Invalid tunnel setup payload');
  // v1 remains supported exclusively by the private file/stdin CLI transports.
  let version: unknown;
  try { version = JSON.parse(Buffer.from(input.trim(), 'base64url').toString())?.version; } catch {}
  if (version === 1) return decodeWorkspacePayload(input);
  const grant = decodeTunnelSetupGrant(input);
  let response: Response;
  try {
    response = await request(grant.appOrigin + '/account-api/workspace-install-redeem', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Origin: grant.appOrigin }, body: JSON.stringify({ code: grant.code }),
    });
  } catch { throw Error('Could not reach the account service; setup grant redemption may be unconfirmed. Check the App before requesting a fresh command'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(response.status === 410 ? 'Tunnel setup grant expired or was already used; get a fresh command from the App'
      : `Tunnel setup grant redemption failed (HTTP ${response.status}); check the App before retrying`);
  }
  let result: any;
  try { result = await response.json(); } catch { throw Error('Invalid tunnel setup response'); }
  if (typeof result?.payload !== 'string' || !/^[A-Za-z0-9_-]{1,32768}$/.test(result.payload)) throw Error('Invalid tunnel setup response');
  const payload = decodeWorkspacePayload(result.payload);
  if (payload.appOrigin !== grant.appOrigin) throw Error('Tunnel setup response origin mismatch');
  return payload;
}

/** Inspect only public destination metadata; this never consumes a one-use grant. */
export async function inspectTunnelSetup(input:string,request:typeof fetch=fetch):Promise<{workspaceId:string;serverCid:string;appOrigin:string}|undefined> {
  let version:unknown;try{version=JSON.parse(Buffer.from(input.trim(),'base64url').toString()).version;}catch{}
  if(version===1){const p=decodeWorkspacePayload(input);return {workspaceId:p.challenge.workspaceId,serverCid:p.serverCid,appOrigin:p.appOrigin};}
  const grant=decodeTunnelSetupGrant(input);
  let response:Response;try{response=await request(grant.appOrigin+'/account-api/workspace-install-inspect',{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000),headers:{Origin:grant.appOrigin,'Content-Type':'application/json'},body:JSON.stringify({code:grant.code})});}
  catch{throw Error('Could not inspect the account setup command; existing setup and grant preserved');}
  if(response.status===404 || response.status===405){await response.body?.cancel();return;}
  if(!response.ok){await response.body?.cancel();throw Error('Setup command inspection failed; existing setup and grant preserved');}
  let target:any;try{target=await response.json();}catch{throw Error('Invalid setup command inspection response');}
  if(!target || Object.keys(target).sort().join(',')!=='serverCid,workspaceId' || typeof target.workspaceId!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(target.workspaceId) || typeof target.serverCid!=='string' || !/^[a-f0-9]{64}$/i.test(target.serverCid))throw Error('Invalid setup command inspection response');
  return {...target,appOrigin:grant.appOrigin};
}

export function verifyTunnelSetupTarget(target:{workspaceId:string;serverCid:string;appOrigin:string}|undefined,payload:WorkspacePayload):void {
  if(target && (target.workspaceId!==payload.challenge.workspaceId || target.serverCid.toUpperCase()!==payload.serverCid.toUpperCase() || target.appOrigin!==payload.appOrigin))throw Error('Redeemed setup command differs from inspected destination; existing setup preserved');
}
