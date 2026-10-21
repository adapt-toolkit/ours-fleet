import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonicalJson } from '../canonical-json.js';
import type { LayoutInstance } from './layout.js';
import type { LayoutControlRequest } from './layout-control.js';

export type LayoutBindingRequest = Omit<LayoutControlRequest, 'instance'> & { roomId?: string; roomRole?: string };
export const LAYOUT_BINDING_ACTIONS = ['verify', 'join', 'assign'] as const;
export const localLayoutReference = ({ remote: _remote, ...instance }: LayoutInstance): LayoutInstance => instance;

/** Initial support is the same-host, separate-OS-user use case from #194. */
export function layoutBindingOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('cross-Fleet bindings require an explicit loopback HTTP origin');
  return url.origin;
}

export async function callRemoteLayoutBinding(
  instance: LayoutInstance, request: LayoutBindingRequest,
  daemonInstanceId: string, fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const remote = instance.remote!;
  if (!LAYOUT_BINDING_ACTIONS.includes(request.action as typeof LAYOUT_BINDING_ACTIONS[number]))
    throw Error('cross-Fleet bindings allow only verify, join and assign');
  if (remote.daemon_instance_id !== daemonInstanceId) throw Error('cross-Fleet binding requires the same daemon instance');
  const origin = layoutBindingOrigin(remote.url);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(remote.grant_id) || !isAbsolute(remote.credential_file)) throw Error('invalid cross-Fleet binding');
  const stat = lstatSync(remote.credential_file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid()) || stat.size > 256)
    throw Error('untrusted cross-Fleet credential file');
  const token = readFileSync(remote.credential_file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('invalid cross-Fleet credential');
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/layout-bindings/${remote.grant_id}/control`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...request, instance: localLayoutReference(instance), daemonInstanceId }),
    });
  } catch { throw Error('cross-Fleet control unavailable; operation outcome may be unknown'); }
  // Remote errors are not trusted presentation data and may contain private request bytes.
  if (!response.ok) throw Error(`cross-Fleet binding rejected (${response.status})`);
  let result: { instance?: LayoutInstance; result?: unknown };
  try { result = await response.json(); } catch { throw Error('invalid cross-Fleet control response'); }
  if (!result || typeof result !== 'object') throw Error('invalid cross-Fleet control response');
  if (canonicalJson(result.instance) !== canonicalJson(localLayoutReference(instance)))
    throw Error('cross-Fleet instance proof changed');
  return result.result;
}
