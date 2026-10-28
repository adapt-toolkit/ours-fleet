import { observeFleetResources } from '../application/resource-observer.js';
import { cleanupDir, drainNotificationTargetCleanup, notificationAgentId, hasPendingNotificationTargetCleanup } from './target-cleanup.js';
import { closeSync, existsSync, lstatSync, openSync, readSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { NotificationOutbox, type ProducerConfig } from './outbox.js';
import type { ConversationEventV1 } from '../session/conversation-types.js';
import { readSessionOwnership, validOwnerTask } from '../session/session-ownership.js';

/** `bindings`: session generation → its launch's task (null for a non-task role), from `session.ownership`.
 * Saved in the same atomic checkpoint as the offset that passed the binding, so it survives restart and rotation. */
interface Checkpoint { segment: string; offset: number; prompts: string[]; discarding?: boolean; messages?: Record<string, string>; bindings?: Record<string, string | null>; }
const MAX_BINDINGS = 16;
const BATCH_BYTES = 256 * 1024;
const TURN_ROLES = 4, TURN_MS = 8;
const RUNTIME_FILES = new Set(['.session-ownership.json', '.monitor-status', '.monitor-state.json', '.notify-cursor', '.session-events.jsonl', '.session-events.jsonl.1', '.subscription-usage.json']);
function bind(bindings: Record<string, string | null>, event: ConversationEventV1): void {
  const payload = event.payload as { launchId?: unknown; taskId?: unknown } | undefined;
  const taskId = payload?.taskId;
  if (!(payload?.launchId === null || typeof payload?.launchId === 'string') || !(taskId === null || validOwnerTask(taskId))
    || (taskId !== null && payload?.launchId === null)) return;
  bindings[event.sessionGeneration] = taskId;
  const keys = Object.keys(bindings);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_BINDINGS))) delete bindings[key];
}
/** Startup skips earlier history, where a live generation's binding may lie: seed from the durable sidecar, keyed by
 * exact generation. An absent sidecar is legacy history (generations stay unknown); an unreadable or invalid one is
 * unavailable evidence and returns undefined, so the caller holds its checkpoint instead of emitting unowned work. */
function seedBindings(roleDir: string): Record<string, string | null> | undefined {
  try { return Object.fromEntries(Object.entries(readSessionOwnership(roleDir)).map(([generation, owner]) => [generation, owner.taskId])); }
  catch { return undefined; }
}

/** Read durable supervisor ledgers without restarting agents or attaching a
 * conversation controller. Each tick reads at most 256 KiB per role, from its
 * checkpoint; it never loads a complete transcript or requests model history. */
export class FleetNotificationProducer {
  private readonly queues = new Map<string, NotificationOutbox>();
  private readonly observation = new AbortController();
  private continuation?: ReturnType<typeof setTimeout>;
  private continuationAt = Infinity;
  private readonly dirty = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private discoveryNeeded = true;
  private stopped = false;
  private readonly existing = new Map<string, Checkpoint | null>();
  private cleanup?: Promise<void>;
  constructor(private readonly roots: string[], private readonly stateDir: string,
    private readonly config: ProducerConfig, private readonly warn: (line: string) => void = () => {}) {
    let healthy = true;
    observeFleetResources({ retryWatchFailures: true, roots, paths:[...roots,cleanupDir()],
      onInvalidated:path=>this.accept(path) }, state => {
      if (state.health !== 'healthy') {
        healthy = false;
        this.warn('Notification discovery observation unavailable; checkpoint retained');
        return;
      }
      if (!healthy || this.dirty.size || this.discoveryNeeded) {
        // Unknown wakes and watch reinstallation advance coverage without a
        // pathname. Keep one conservative discovery pass for those barriers.
        if (!healthy) this.discoveryNeeded = true;
        healthy = true; this.resume();
      }
    }, this.observation.signal);
    // Freeze startup history boundaries before deferring any role's content
    // work. Later appends/segments must not become part of the ignored history.
    // This pass reads directory/file metadata only, never ledger contents.
    for (const root of roots) for (const name of this.names(root)) {
      const roleDir = join(root, name), dir = join(roleDir, '.conversation');
      try {
        if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) continue;
        const segment = this.segments(dir).at(-1);
        if (segment) this.existing.set(roleDir, {segment, offset:statSync(join(dir, segment)).size, prompts:[]});
      } catch { this.existing.set(roleDir, null); }
    }
    this.poll();
  }
  private names(root: string): string[] {
    try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(d.name)).map(d => d.name); }
    catch { return []; }
  }
  private segments(dir: string): string[] {
    return readdirSync(dir).filter(n => /^events-\d{6}\.jsonl$/.test(n) && !lstatSync(join(dir, n)).isSymbolicLink()).sort();
  }
  poll(): void {
    if (this.stopped) return;
    this.discoveryNeeded = true;
    this.flush();
  }
  private accept(path?: string): boolean {
    if (path === undefined) { this.discoveryNeeded = true; return true; }
    for (const root of this.roots) {
      const local = relative(resolve(root), path), parts = local.split(sep);
      if (local === '..' || local.startsWith('..' + sep)) continue;
      if (parts.length === 2 && RUNTIME_FILES.has(parts[1])) return false;
      if (parts.length >= 2 && parts[1] === '.conversation') {
        if (parts.length <= 3) { this.dirty.add(join(root, parts[0])); return true; }
      }
      // Role replacement, unknown paths and metadata retain discovery. Room
      // association and target-cleanup paths take the same conservative route.
      this.discoveryNeeded = true; return true;
    }
    this.discoveryNeeded = true; return true;
  }
  private flush(): void {
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
            const queue=new NotificationOutbox(file,this.config,async()=>{throw Error('retired target');});
            try{await queue.retire();}finally{await queue.close();}
          }
        }
      }
      return true;
    }}).catch(()=>{}).finally(()=>{this.cleanup=undefined;
      try{if(hasPendingNotificationTargetCleanup())this.resume(3000);}catch{}
    });
    if (this.discoveryNeeded) {
      this.discoveryNeeded = false;
      for (const root of this.roots) for (const name of this.names(root)) this.dirty.add(join(root, name));
    }
    // A turn reads at most four 256KiB batches (1MiB). The time bound is checked
    // between roles; a synchronous filesystem operation cannot be preempted.
    const started = performance.now(); let roles = 0;
    for (const roleDir of this.dirty) {
      if (roles >= TURN_ROLES || (roles && performance.now() - started >= TURN_MS)) break;
      if ((this.retryAt.get(roleDir) ?? 0) > Date.now()) continue;
      this.dirty.delete(roleDir); this.retryAt.delete(roleDir); roles++;
      this.scanRole(roleDir, started + TURN_MS);
    }
    if (this.dirty.size) {
      let next = Infinity;
      for (const roleDir of this.dirty) next = Math.min(next, this.retryAt.get(roleDir) ?? Date.now());
      this.resume(Math.max(0, next - Date.now()));
    }
  }
  private scanRole(roleDir: string, deadline: number): void {
      const roleId = basename(roleDir), dir = join(roleDir, '.conversation');
      try {
        if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return;
        const segments = this.segments(dir);
        if (!segments.length) return;
        let outbox = this.queues.get(roleDir);
        if (!outbox) {
          const key = createHash('sha256').update(roleDir).digest('hex');
          outbox = new NotificationOutbox(join(this.stateDir, key + '.json'), this.config,
            async (value, eventId) => ({ eventId, title: `${roleId}: agent completed`, body: 'Your agent finished responding. Open the chat to view the result.',
              ...(value as object), target: { kind: 'agent', agentId: roleId } }), this.warn);
          this.queues.set(roleDir, outbox);
        }
        if (!outbox.checkpoint) {
          const initial = this.existing.get(roleDir);
          if (initial === null) throw Error('Notification startup ledger boundary unavailable');
          // History before the startup boundary is skipped, but the live generation's binding may lie in it:
          // seed it from the role's durable ownership sidecar.
          if (initial) {
            const bindings = seedBindings(roleDir);
            if (!bindings) { this.warn('Notification ownership evidence unavailable; ledger admission held'); this.retryAt.set(roleDir, Date.now() + 30_000); this.dirty.add(roleDir); return; }
            outbox.saveCheckpoint({ ...initial, bindings });
          } else outbox.saveCheckpoint({segment:segments[0], offset:0, prompts:[]});
        }
        const saved = outbox.checkpoint as Checkpoint;
        const current = { ...saved, prompts: [...saved.prompts], messages: { ...saved.messages }, bindings: { ...saved.bindings } };
        let index = segments.indexOf(current.segment);
        if (index < 0) { this.warn('Notification ledger segment unavailable; checkpoint retained'); return; }
        const file = join(dir, current.segment), size = statSync(file).size;
        if (size < current.offset) { this.warn('Notification ledger truncated; checkpoint retained'); return; }
        let remaining = size - current.offset;
        while (remaining === 0 && index < segments.length - 1) {
          current.segment = segments[++index]; current.offset = 0;
          remaining = statSync(join(dir, current.segment)).size;
        }
        if (remaining === 0) {
          if (current.segment !== saved.segment) outbox.saveCheckpoint(current);
          return; // Latest EOF: no ledger open, allocation or read.
        }
        const fd = openSync(join(dir, current.segment), 'r'), buffer = Buffer.alloc(Math.min(BATCH_BYTES, remaining));
        let count: number;
        try { count = readSync(fd, buffer, 0, buffer.length, current.offset); } finally { closeSync(fd); }
        let position = 0, blocked = false, admitted = false, unavailable = false, sidecar: Record<string, string | null> | undefined;
        while (position < count) {
          const end = buffer.indexOf(10, position);
          if (end < 0 || end >= count) {
            // Oversized model/media events are irrelevant to prompt/completion
            // correlation. Skip in bounded chunks; retain partial small lines.
            if (current.discarding || (position === 0 && count === BATCH_BYTES)) {
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
          if (event.kind === 'session.ownership') bind(current.bindings, event);
          if (event.kind === 'prompt.admitted' && event.promptId && ['browser', 'owner_admin_console', 'owner_channel'].includes(event.source ?? '')) {
            if (!current.prompts.includes(prompt)) current.prompts.push(prompt);
          }
          if (['message.chunk', 'message.replace'].includes(event.kind) && event.promptId && event.messageId && current.prompts.includes(prompt)) current.messages[prompt] = event.messageId;
          if (event.kind === 'turn.completed' && event.promptId && current.prompts.includes(prompt)) {
            // Task association only from this generation's own binding: a task, null (non-task role), or unknown (omitted).
            // A generation bound before this checkpoint (an older checkpoint, or startup history) is recovered from the
            // durable sidecar by exact generation; other generations are never relabelled.
            // Unavailable sidecar evidence holds the checkpoint before this completion: nothing unowned is emitted.
            if (!Object.hasOwn(current.bindings, event.sessionGeneration)) {
              sidecar ??= seedBindings(roleDir);
              if (!sidecar) { unavailable = true; break; }
              if (Object.hasOwn(sidecar, event.sessionGeneration)) current.bindings[event.sessionGeneration] = sidecar[event.sessionGeneration];
            }
            const binding = Object.hasOwn(current.bindings, event.sessionGeneration) ? { taskId: current.bindings[event.sessionGeneration] } : {};
            if (!outbox.enqueue(`${roleId}:${event.sessionGeneration}:${event.seq}`, { ...binding, anchor: { kind: 'fleet-message', messageId: current.messages[prompt] ?? event.promptId } })) {blocked=true;break;}
            admitted = true;
            current.prompts = current.prompts.filter(p => p !== prompt); delete current.messages[prompt];
          }
          current.offset += end - position + 1; position = end + 1;
          if (performance.now() >= deadline) break;
        }
        if (current.segment !== saved.segment || current.offset !== saved.offset) outbox.saveCheckpoint(current);
        // Prompt only after both completion and checkpoint have been durably recorded.
        if (admitted) outbox.prompt();
        if (unavailable) this.warn('Notification ownership evidence unavailable; ledger admission held');
        if (blocked || unavailable) {
          // Corrupt evidence needs an operator repair: re-check it slowly rather than spin.
          this.retryAt.set(roleDir, Date.now() + (unavailable ? 30_000 : 1000)); this.dirty.add(roleDir);
        } else if ((current.segment !== saved.segment || current.offset !== saved.offset)
          && (current.offset < statSync(join(dir, current.segment)).size || index < segments.length - 1)) this.dirty.add(roleDir);
      } catch {
        this.warn('Notification ledger admission pending; checkpoint will replay');
        // Retained, not-yet-admitted ledger work needs its own next-due wake;
        // the outbox sender can retry only events that were already admitted.
        this.retryAt.set(roleDir, Date.now() + 1000); this.dirty.add(roleDir);
      }
  }
  private resume(delay = 0) {
    if (this.stopped) return;
    const at = Date.now() + delay;
    if (this.continuation && this.continuationAt <= at) return;
    clearTimeout(this.continuation); this.continuationAt = at;
    this.continuation = setTimeout(() => { this.continuation = undefined; this.continuationAt = Infinity; this.flush(); }, delay);
    this.continuation.unref();
  }
  async drain(): Promise<void> { await Promise.all([...this.queues.values()].map(q => q.drain())); }
  async close(): Promise<void> { this.stopped = true; this.observation.abort(); clearTimeout(this.continuation); await this.cleanup; await Promise.all([...this.queues.values()].map(q => q.close())); }
}
