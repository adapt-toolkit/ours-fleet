import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPrivateFile } from '@ours.network/sdk/connector';
import { readClientProfile } from '../client-profile.js';

export type NotificationTarget = { kind: 'agent'; agentId: string } | { kind: 'task' | 'task-deleted'; taskId: string };
export interface NotificationInput { eventId: string; title: string; body: string; target: NotificationTarget; anchor?: { kind: 'fleet-message'; messageId: string }; taskId?: string | null; }
interface Entry { id: string; value: unknown; payload?: NotificationInput; targetVersion?: 1; }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const domainId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
/** Only the closed typed contract is sent; any other payload is never sent or converted. */
export function isNotificationInput(value: unknown): value is NotificationInput {
  if (!object(value) || !closed(value, ['eventId', 'title', 'body', 'target', 'anchor', 'taskId'])
    || !text(value.eventId, 512) || !text(value.title, 160) || !text(value.body, 512) || !object(value.target)) return false;
  const target = value.target;
  if (target.kind === 'agent') { if (!closed(target, ['kind', 'agentId']) || !domainId(target.agentId)) return false; }
  else if (target.kind === 'task' || target.kind === 'task-deleted') {
    if (!closed(target, ['kind', 'taskId']) || !domainId(target.taskId) || (value.taskId !== undefined && value.taskId !== target.taskId)) return false;
  } else return false;
  if (value.taskId !== undefined && value.taskId !== null && !domainId(value.taskId)) return false;
  return value.anchor === undefined || (target.kind === 'agent' && object(value.anchor)
    && closed(value.anchor, ['kind', 'messageId']) && value.anchor.kind === 'fleet-message' && text(value.anchor.messageId, 1024) && !/[\x00-\x1f\x7f]/.test(value.anchor.messageId));
}
const has = (entry: Entry, key: string) => Object.hasOwn(entry, key);
// An entry is sent only when its frozen payload is the closed typed contract or, with no payload
// field at all, it carries the current version marker. Any present payload or operation that is
// not the typed contract is never projected or sent.
const supported = (entry: Entry) => !has(entry, 'operation')
  && (has(entry, 'payload') ? isNotificationInput(entry.payload) : entry.targetVersion === 1);
export interface ProducerConfig {
  /** Service base URL. With a gateway credential it is the server gateway's notifications route. */
  origin: string;
  token: string;
  /** Daemon API credential that authenticates this client to the server gateway. */
  gatewayCredential?: string;
}
type ProfileLocation = { serverUrl: string; expectedInstanceId: string; credentialPath: string };
function defaultProfile(): ProfileLocation | undefined {
  try { return readClientProfile(); } catch { return undefined; }
}
/** The installer delivers the producer credential beside the profile credential, bound to that server installation. */
export const PRODUCER_CREDENTIAL_FILE = 'notifications-producer.json';
const loopback = (url: URL) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
export function producerConfig(env: NodeJS.ProcessEnv = process.env, profile: () => ProfileLocation | undefined = defaultProfile,
  warn: (message: string) => void = () => {}): ProducerConfig | undefined {
  const origin = env.OURS_NOTIFICATIONS_ORIGIN, token = env.OURS_NOTIFICATIONS_PRODUCER_TOKEN;
  if (origin || token) {
    if (!origin || !token || token.length < 32) throw new Error('notifications producer requires origin and scoped token');
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('invalid notification service origin');
    if (url.protocol === 'http:' && !loopback(url)) throw new Error('notification credentials require HTTPS or loopback');
    return { origin, token };
  }
  const selected = profile();
  if (!selected) return;
  const file = join(dirname(selected.credentialPath), PRODUCER_CREDENTIAL_FILE);
  if (!existsSync(file)) return;
  // Reasons are fixed text: parser and file errors can quote the secret-bearing contents.
  let reason = 'it is not a private owner-only file';
  try {
    const text = readPrivateFile(file, 4096).toString('utf8');
    reason = 'it is not valid producer JSON';
    const bound = JSON.parse(text);
    reason = 'it belongs to another server installation';
    if (!bound || bound.schema !== 1 || bound.serverUrl !== selected.serverUrl || bound.expectedInstanceId !== selected.expectedInstanceId) throw new Error();
    reason = 'its credential is invalid';
    if (typeof bound.token !== 'string' || bound.token.length < 32) throw new Error();
    reason = 'the server requires HTTPS or loopback';
    const server = new URL(selected.serverUrl);
    if (server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback(server))) throw new Error();
    reason = 'the client credential is unreadable';
    const gatewayCredential = readPrivateFile(selected.credentialPath, 4096).toString('utf8').trim();
    return { origin: selected.serverUrl.replace(/\/$/, '') + '/notifications', token: bound.token, gatewayCredential };
  } catch {
    warn(`Notifications are not produced: ${file} is unusable (${reason}). Re-run the installer to repair it.`);
    return;
  }
}

/** Durable producer queue. Service dedupe makes crash-after-acceptance replay safe. */
export class NotificationOutbox {
  private entries: Entry[];
  cursor?: number;
  checkpoint?: unknown;
  private running?: Promise<void>;
  private retired=false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly file: string, private readonly config: ProducerConfig,
    private readonly project: (value: unknown, id: string) => Promise<NotificationInput>,
    private readonly warn: (message: string) => void = () => {}) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { entries: [] };
    // Only the current state shape is read; anything else is refused and left unchanged on disk.
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Array.isArray(saved.entries)) throw new Error('Unsupported notification outbox state');
    this.entries = saved.entries;
    this.cursor = saved.cursor;
    this.checkpoint = saved.checkpoint;
    this.timer = setInterval(() => { void this.drain(); }, 3000); this.timer.unref();
  }
  private persist(entries: Entry[], cursor = this.cursor, checkpoint = this.checkpoint): void {
    const tmp = this.file + '.tmp', fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ entries, cursor, checkpoint })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const dir = openSync(dirname(this.file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    this.entries = entries; this.cursor = cursor; this.checkpoint = checkpoint;
  }
  advance(cursor: number): void { this.persist(this.entries, cursor); }
  saveCheckpoint(checkpoint: unknown): void { this.persist(this.entries, this.cursor, checkpoint); }
  enqueue(id: string, value: unknown, cursor = this.cursor): boolean {
    if(this.retired)return false;
    if (this.entries.some(e => e.id === id)) { if (cursor !== this.cursor) this.advance(cursor!); return true; }
    if (this.entries.filter(supported).length >= 2000) return false;
    this.persist([...this.entries, { id, value, targetVersion: 1 }], cursor);
    return true;
  }
  drain(): Promise<void> {
    if(this.retired)return Promise.resolve();
    return this.running ??= this.drainOnce().finally(() => { this.running = undefined; });
  }
  private async drainOnce(): Promise<void> {
    let attempts = 0;
    for (const entry of [...this.entries]) {
      if (!supported(entry)) continue;
      if (attempts >= 32) break;
      if(this.retired)break;
      try {
        const value = entry.payload ?? await this.project(entry.value, entry.id);
        if (!isNotificationInput(value)) continue;
        attempts++;
        // Freeze the canonical projection before any network attempt. A crash
        // after service acceptance must replay the identical dedupe payload.
        if (!entry.payload) this.persist(this.entries.map(e => e.id === entry.id ? { ...e, payload: value } : e));
        const response = await fetch(this.config.origin + '/api/v1/send', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { ...(this.config.gatewayCredential
            ? { 'X-Ours-Api-Token': this.config.gatewayCredential, 'X-Ours-Notifications-Producer': this.config.token }
            : { Authorization: `Bearer ${this.config.token}` }), 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('notification service rejected event');
        this.persist(this.entries.filter(e => e.id !== entry.id));
      } catch { this.warn('Notification producer delivery pending; retrying from durable outbox'); break; }
    }
  }
  /** Wait for the current send before clearing queued sends and retiring its target. */
  async retire():Promise<void>{this.retired=true;clearInterval(this.timer);await this.running;this.persist(this.entries.filter(entry => !supported(entry)));}
  async close(): Promise<void> { clearInterval(this.timer); await this.running; }
}
