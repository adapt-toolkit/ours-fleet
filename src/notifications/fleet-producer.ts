import { roomsDir } from '../rooms-tasks/room-state.js';
import { drainNotificationTargetCleanup } from './target-cleanup.js';
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
/** Read durable supervisor ledgers without restarting agents or attaching a
 * conversation controller. Each tick reads at most 256 KiB per role, from its
 * checkpoint; it never loads a complete transcript or requests model history. */
export class FleetNotificationProducer {
  private readonly queues = new Map<string, NotificationOutbox>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly existing = new Set<string>();
  private cleanup?: Promise<void>;
  constructor(private readonly roots: string[], private readonly stateDir: string,
    private readonly config: ProducerConfig, private readonly warn: (line: string) => void = () => {}) {
    for (const root of roots) for (const name of this.names(root)) this.existing.add(join(root, name));
    this.poll();
    this.timer = setInterval(() => this.poll(), 1000); this.timer.unref();
  }
  private names(root: string): string[] {
    try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(d.name)).map(d => d.name); }
    catch { return []; }
  }
  poll(): void {
    this.cleanup ??= drainNotificationTargetCleanup(this.config,undefined,undefined,{beforeDelete:async(url)=>{
      const name=new URL(url,'https://ours.invalid').searchParams.get('chat');
      if(!name || !/^[A-Za-z0-9_-]+$/.test(name))return false;
      // A recreated or retained role still has a valid target. Filesystem errors cannot prove removal.
      for(const root of this.roots){try{lstatSync(join(root,name));return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      for(const root of this.roots){
        const roleDir=join(root,name),queue=this.queues.get(roleDir);
        if(queue){await queue.retire();this.queues.delete(roleDir);}
        else {
          const file=join(this.stateDir,createHash('sha256').update(roleDir).digest('hex')+'.json');
          if(existsSync(file)){
            const queue=new NotificationOutbox(file,this.config,async()=>{throw Error('retired target');});
            try{await queue.retire();}finally{await queue.close();}
          }
        }
      }
      return true;
    }}).catch(()=>{}).finally(()=>{this.cleanup=undefined;});
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
              url: `/fleet/chats?chat=${encodeURIComponent(roleId)}&detail=1`, ...(value as object) }), this.warn);
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
            if (!outbox.enqueue(`${roleId}:${event.sessionGeneration}:${event.seq}`, { ...(taskRoles?{taskId:taskRoles.get(roleId)??null}:{}), url: `/fleet/chats?chat=${encodeURIComponent(roleId)}&detail=1#fleet-message-${encodeURIComponent(current.messages[prompt] ?? event.promptId)}` })) break;
            current.prompts = current.prompts.filter(p => p !== prompt); delete current.messages[prompt];
          }
          current.offset += end - position + 1; position = end + 1;
        }
        if (current.segment !== saved.segment || current.offset !== saved.offset) outbox.saveCheckpoint(current);
      } catch { this.warn('Notification ledger admission pending; checkpoint will replay'); }
    }
  }
  async drain(): Promise<void> { await Promise.all([...this.queues.values()].map(q => q.drain())); }
  async close(): Promise<void> { clearInterval(this.timer); await this.cleanup; await Promise.all([...this.queues.values()].map(q => q.close())); }
}
