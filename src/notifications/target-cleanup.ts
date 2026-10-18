import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { producerConfig, type ProducerConfig } from './outbox.js';
export const cleanupDir = () => join(stateRoot(), 'notifications', 'removed-targets');
export type AgentTarget = { kind: 'agent'; agentId: string };
/** Only a closed agent identity authorizes this producer's role-target cleanup. */
export function notificationAgentId(target: unknown): string | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const value = target as Record<string, unknown>;
  return Object.keys(value).every(key => ['kind', 'agentId'].includes(key)) && value.kind === 'agent'
    && typeof value.agentId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value.agentId) ? value.agentId : null;
}
export function hasPendingNotificationTargetCleanup(dir = cleanupDir()): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).some(file => {
    try { const value = JSON.parse(readFileSync(join(dir, file), 'utf8')); return !!value && typeof value === 'object' && Object.keys(value).length === 1 && !!notificationAgentId(value.target); }
    catch (error) { return !(error instanceof SyntaxError); }
  });
}
/** Queue only after the owning lifecycle has established deletion, never on a failed inventory read. */
export async function retireNotificationTarget(target: AgentTarget, config = producerConfig(), dir = cleanupDir(), request: typeof fetch = fetch): Promise<void> {
  if (!config) return;
  if (!notificationAgentId(target)) throw new Error('Invalid notification target');
  mkdirSync(dir, {recursive: true, mode: 0o700});
  replaceFileAtomically(join(dir, createHash('sha256').update(JSON.stringify({kind: 'agent', agentId: target.agentId})).digest('hex') + '.json'), JSON.stringify({target}) + '\n', 0o600);
  await drainNotificationTargetCleanup(config, dir, request, {retain: true});
}
/** Persisted retries also run from the ordinary web notification producer after restart. */
export async function drainNotificationTargetCleanup(config: ProducerConfig, dir = cleanupDir(), request: typeof fetch = fetch, options: {retain?: boolean; beforeDelete?: (target:AgentTarget)=>Promise<boolean>} = {}): Promise<void> {
  if (!existsSync(dir)) return;
  let attempts = 0;
  for (const file of readdirSync(dir).filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
    if (attempts >= 32) break;
    const path = join(dir, file);
    let value: {target: AgentTarget};
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !notificationAgentId(value.target)) continue;
    try {
      attempts++;
      if(options.beforeDelete && !(await options.beforeDelete(value.target))){rmSync(path,{force:true});continue;}
      const response = await request(config.origin + '/api/v1/delete-target', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {...(config.gatewayCredential ? {'X-Ours-Api-Token': config.gatewayCredential, 'X-Ours-Notifications-Producer': config.token} : {Authorization: `Bearer ${config.token}`}), 'Content-Type': 'application/json'}, body: JSON.stringify(value)});
      await response.body?.cancel();
      if (!response.ok) break;
      if(!options.retain)rmSync(path, {force: true});
    } catch { break; /* No credentials or response bodies are included in logs. */ }
  }
}
