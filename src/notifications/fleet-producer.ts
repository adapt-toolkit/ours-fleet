import { observeFleetResources } from '../application/resource-observer.js';
import { roomsDir } from '../rooms-tasks/room-state.js';
import { cleanupDir, drainNotificationTargetCleanup, notificationAgentId, hasPendingNotificationTargetCleanup } from './target-cleanup.js';
import { closeSync, existsSync, lstatSync, openSync, readSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NotificationOutbox, type ProducerConfig } from './outbox.js';
import type { ConversationEventV1 } from '../session/conversation-types.js';

interface Checkpoint { segment: string; offset: number; prompts: string[]; discarding?: boolean; messages?: Record<string, string>; }
/** Unlike a UI inventory, unread classification must not treat unreadable records as absence. */
function taskRoleAssociations():Map<string,string>{
  const dir=roomsDir(),result=new Map<string,string>();let files:string[];
  try{files=readdirSync(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error;}
  for(const name of files.filter(name=>name.endsWith('.json'))){
    const file=join(dir,name),stat=lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1024*1024)throw Error('Unreadable room association');
    const room=JSON.parse(readFileSync(file,'utf8'));
    if(!room || typeof room.room_id!=='string' || !Array.isArray(room.member_seats))throw Error('Invalid room association');
    if(room.task_id===undefined)continue;
    if(typeof room.task_id!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(room.task_id))throw Error('Invalid task association');
    for(const seat of room.member_seats){
      if(typeof seat.role_name!=='string')throw Error('Invalid member association');
      if(result.has(seat.role_name) && result.get(seat.role_name)!==room.task_id)throw Error('Ambiguous task association');
      result.set(seat.role_name,room.task_id);
    }
  }
  return result;
}
// Records queued by earlier releases for this role, under the event ID they derived from the
// ledger: `<role>:<session generation (randomUUID(), a version 4 UUID)>:<sequence>`. The value is exactly {}
// (no message link), or { taskId?, url } where url is one of the two forms those releases wrote,
// with the message ID encoded by encodeURIComponent. Only that canonical serialization is read
// back; anything else is retained.
const generationSequence = /^:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:([1-9][0-9]*)$/;
export const legacyRecord = (roleId: string) => (value: unknown, id: string) => {
  const sequence = id.startsWith(roleId) ? generationSequence.exec(id.slice(roleId.length))?.[1] : undefined;
  if (!sequence || !Number.isSafeInteger(Number(sequence)) || id.length > 512) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { taskId, url, ...rest } = value as Record<string, unknown>, role = encodeURIComponent(roleId);
  if (Object.keys(rest).length) return;
  if (!Object.keys(value).length) return {};
  if (typeof url !== 'string' || (taskId !== undefined && taskId !== null && !(typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(taskId)))) return;
  const prefix = [`/fleet/chats?chat=${role}&detail=1#fleet-message-`, `/fleet/chats/agents/${role}#fleet-message-`].find(prefix => url.startsWith(prefix));
  if (!prefix) return;
  const encoded = url.slice(prefix.length);
  let messageId: string;
  try { messageId = decodeURIComponent(encoded); if (encodeURIComponent(messageId) !== encoded) return; } catch { return; }
  if (!messageId.trim() || messageId.length > 1024 || /[\x00-\x1f\x7f]/.test(messageId)) return;
  return { ...(taskId === undefined ? {} : { taskId }), anchor: { kind: 'fleet-message', messageId } };
};
/** Read durable supervisor ledgers without restarting agents or attaching a
 * conversation controller. Each tick reads at most 256 KiB per role, from its
 * checkpoint; it never loads a complete transcript or requests model history. */
export class FleetNotificationProducer {
  private readonly queues = new Map<string, NotificationOutbox>();
  private readonly observation = new AbortController();
  private continuation?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly existing = new Set<string>();
  private cleanup?: Promise<void>;
  constructor(private readonly roots: string[], private readonly stateDir: string,
    private readonly config: ProducerConfig, private readonly warn: (line: string) => void = () => {}) {
    observeFleetResources({ retryWatchFailures: true, roots, paths:[...roots,roomsDir(),cleanupDir()] }, state => {
      if (state.health === 'healthy') this.poll();
      else this.warn('Notification discovery observation unavailable; checkpoint retained');
    }, this.observation.signal);
    for (const root of roots) for (const name of this.names(root)) this.existing.add(join(root, name));
    this.poll();
  }
  private names(root: string): string[] {
    try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(d.name)).map(d => d.name); }
    catch { return []; }
  }
  poll(): void {
    if (this.stopped) return;
    this.cleanup ??= drainNotificationTargetCleanup(this.config,undefined,undefined,{beforeDelete:async(target)=>{
      const name=notificationAgentId(target);
      if(!name || !/^[A-Za-z0-9_-]+$/.test(name))return false;
      // A recreated or retained role still has a valid target. Filesystem errors cannot prove removal.
      for(const root of this.roots){try{lstatSync(join(root,name));return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      for(const root of this.roots){
        const roleDir=join(root,name),queue=this.queues.get(roleDir);
        if(queue){await queue.retire();this.queues.delete(roleDir);}
        else {
          const file=join(this.stateDir,createHash('sha256').update(roleDir).digest('hex')+'.json');
          if(existsSync(file)){
            const queue=new NotificationOutbox(file,this.config,async()=>{throw Error('retired target');},undefined,legacyRecord(name));
            try{await queue.retire();}finally{await queue.close();}
          }
        }
      }
      return true;
    }}).catch(()=>{}).finally(()=>{this.cleanup=undefined;
      try{if(hasPendingNotificationTargetCleanup())this.resume(3000);}catch{}
    });
    let taskRoles:Map<string,string>|undefined;
    try{taskRoles=taskRoleAssociations();}
    catch{this.warn('Notification task association unavailable; delivering unclassified events');}
    for (const root of this.roots) for (const roleId of this.names(root)) {
      const roleDir = join(root, roleId), dir = join(roleDir, '.conversation');
      try {
        if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) continue;
        const segments = readdirSync(dir).filter(n => /^events-\d{6}\.jsonl$/.test(n) && !lstatSync(join(dir, n)).isSymbolicLink()).sort();
        if (!segments.length) continue;
        let outbox = this.queues.get(roleDir);
        if (!outbox) {
          const key = createHash('sha256').update(roleDir).digest('hex');
          outbox = new NotificationOutbox(join(this.stateDir, key + '.json'), this.config,
            async (value, eventId) => ({ eventId, title: `${roleId}: agent completed`, body: 'Your agent finished responding. Open the chat to view the result.',
              ...(value as object), target: { kind: 'agent', agentId: roleId } }), this.warn, legacyRecord(roleId));
          if (!outbox.checkpoint) {
            const segment = this.existing.has(roleDir) ? segments.at(-1)! : segments[0];
            outbox.saveCheckpoint({ segment, offset: this.existing.has(roleDir) ? statSync(join(dir, segment)).size : 0, prompts: [] });
          }
          this.queues.set(roleDir, outbox);
        }
        const saved = outbox.checkpoint as Checkpoint;
        const current = { ...saved, prompts: [...saved.prompts], messages: { ...saved.messages } };
        let index = segments.indexOf(current.segment);
        if (index < 0) { this.warn('Notification ledger segment unavailable; checkpoint retained'); continue; }
        const file = join(dir, current.segment), size = statSync(file).size;
        if (size < current.offset) { this.warn('Notification ledger truncated; checkpoint retained'); continue; }
        if (size === current.offset && index < segments.length - 1) {
          current.segment = segments[++index]; current.offset = 0;
        }
        const fd = openSync(join(dir, current.segment), 'r'), buffer = Buffer.alloc(256 * 1024);
        let count: number;
        try { count = readSync(fd, buffer, 0, buffer.length, current.offset); } finally { closeSync(fd); }
        if (current.offset + count < statSync(join(dir, current.segment)).size || index < segments.length - 1) this.resume();
        let position = 0;
        while (position < count) {
          const end = buffer.indexOf(10, position);
          if (end < 0 || end >= count) {
            // Oversized model/media events are irrelevant to prompt/completion
            // correlation. Skip in bounded chunks; retain partial small lines.
            if (current.discarding || (position === 0 && count === buffer.length)) {
              current.offset += count - position; current.discarding = true;
              this.warn('Notification observer skipping oversized ledger record');
            }
            break;
          }
          if (current.discarding) {
            current.offset += end - position + 1; position = end + 1; current.discarding = false; continue;
          }
          const event = JSON.parse(buffer.subarray(position, end).toString('utf8')) as ConversationEventV1;
          if (event.schemaVersion !== 1 || event.roleId !== roleId) throw new Error('invalid ledger event');
          const prompt = `${event.sessionGeneration}:${event.promptId}`;
          if (event.kind === 'prompt.admitted' && event.promptId && ['browser', 'owner_admin_console', 'owner_channel'].includes(event.source ?? '')) {
            if (!current.prompts.includes(prompt)) current.prompts.push(prompt);
          }
          if (['message.chunk', 'message.replace'].includes(event.kind) && event.promptId && event.messageId && current.prompts.includes(prompt)) current.messages[prompt] = event.messageId;
          if (event.kind === 'turn.completed' && event.promptId && current.prompts.includes(prompt)) {
            if (!outbox.enqueue(`${roleId}:${event.sessionGeneration}:${event.seq}`, { ...(taskRoles?{taskId:taskRoles.get(roleId)??null}:{}), anchor: { kind: 'fleet-message', messageId: current.messages[prompt] ?? event.promptId } })) {this.resume(1000);break;}
            current.prompts = current.prompts.filter(p => p !== prompt); delete current.messages[prompt];
          }
          current.offset += end - position + 1; position = end + 1;
        }
        if (current.segment !== saved.segment || current.offset !== saved.offset) outbox.saveCheckpoint(current);
      } catch {
        this.warn('Notification ledger admission pending; checkpoint will replay');
        // Retained, not-yet-admitted ledger work needs its own next-due wake;
        // the outbox sender can retry only events that were already admitted.
        this.resume(1000);
      }
    }
  }
  private resume(delay = 0) {
    if (this.continuation || this.stopped) return;
    this.continuation = setTimeout(() => { this.continuation = undefined; this.poll(); }, delay);
    this.continuation.unref();
  }
  async drain(): Promise<void> { await Promise.all([...this.queues.values()].map(q => q.drain())); }
  async close(): Promise<void> { this.stopped = true; this.observation.abort(); clearTimeout(this.continuation); await this.cleanup; await Promise.all([...this.queues.values()].map(q => q.close())); }
}
