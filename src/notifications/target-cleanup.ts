import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { producerConfig, type ProducerConfig } from './outbox.js';
export const cleanupDir = () => join(stateRoot(), 'notifications', 'removed-targets');
/** Only the canonical agent namespace can authorize role-target cleanup. */
export function notificationAgentId(path: string): string | null {
  try {
    if (typeof path !== 'string' || /[\\\x00-\x20]|%(?:2f|5c|00|0[ad])/i.test(path)) return null;
    const match = /^\/fleet\/chats\/agents\/([^/?#]+)(?:[?#]|$)/.exec(path);
    if (!match) return null;
    const url = new URL(path, 'https://ours.invalid');
    if (['source', 'chat', 'task', 'detail'].some(key => url.searchParams.has(key))) return null;
    const id = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch { return null; }
}
/** Queue only after the owning lifecycle has established deletion, never on a failed inventory read. */
export async function retireNotificationTarget(url: string, config = producerConfig(), dir = cleanupDir(), request: typeof fetch = fetch): Promise<void> {
  if (!config) return;
  mkdirSync(dir, {recursive: true, mode: 0o700});
  replaceFileAtomically(join(dir, createHash('sha256').update(url).digest('hex') + '.json'), JSON.stringify({url}) + '\n', 0o600);
  await drainNotificationTargetCleanup(config, dir, request, {retain: true});
}
/** Persisted retries also run from the ordinary web notification producer after restart. */
export async function drainNotificationTargetCleanup(config: ProducerConfig, dir = cleanupDir(), request: typeof fetch = fetch, options: {retain?: boolean; beforeDelete?: (url:string)=>Promise<boolean>} = {}): Promise<void> {
  if (!existsSync(dir)) return;
  let attempts = 0;
  for (const file of readdirSync(dir).filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
    if (attempts >= 32) break;
    try {
      const path = join(dir, file), value = JSON.parse(readFileSync(path, 'utf8')) as {url: string};
      if (!notificationAgentId(value.url)) continue;
      attempts++;
      if(options.beforeDelete && !(await options.beforeDelete(value.url))){rmSync(path,{force:true});continue;}
      const response = await request(config.origin + '/api/v1/delete-target', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {...(config.gatewayCredential ? {'X-Ours-Api-Token': config.gatewayCredential, 'X-Ours-Notifications-Producer': config.token} : {Authorization: `Bearer ${config.token}`}), 'Content-Type': 'application/json'}, body: JSON.stringify(value)});
      await response.body?.cancel();
      if (!response.ok) break;
      if(!options.retain)rmSync(path, {force: true});
    } catch { break; /* No credentials or response bodies are included in logs. */ }
  }
}
