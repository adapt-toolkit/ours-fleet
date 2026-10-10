import { acknowledgeTaskNotification, pendingTaskNotifications } from '../rooms-tasks/task-state.js';
import type { ProducerConfig } from './outbox.js';

/** The Fleet manager owns this sender even when the web console is stopped.
 * Events are already durable in their owning task commit, so no second outbox
 * admission/crash window is needed. A failed task does not block other tasks. */
export class TaskNotificationProducer {
  private readonly timer: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private offset = 0;
  private stopped = false;
  private readonly shutdown = new AbortController();
  constructor(private readonly config: ProducerConfig, private readonly warn: (line: string) => void = () => {},
    private readonly request: typeof fetch = fetch) {
    this.timer = setInterval(() => { void this.drain(); }, 3000);
    this.timer.unref();
    void this.drain();
  }
  drain(): Promise<void> {
    return this.running ??= this.drainOnce().catch(() => {
      this.warn('Task notification snapshot unavailable; committed events retained');
    }).finally(() => { this.running = undefined; });
  }
  private async drainOnce(): Promise<void> {
    if (this.stopped) return;
    const pending = pendingTaskNotifications(this.warn);
    if (!pending.length) return;
    const start = this.offset % pending.length;
    const batch = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 32);
    this.offset = start + batch.length;
    for (let index = 0; index < batch.length; index += 4) {
      if (this.stopped) break;
      await Promise.all(batch.slice(index, index + 4).map(async task => {
        for (const event of task.events.slice(0, 32)) {
          if (this.stopped) break;
          try {
            const response = await this.request(this.config.origin + '/api/v1/send', {
              method: 'POST', redirect: 'error', signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10_000)]),
              headers: { ...(this.config.gatewayCredential
                ? { 'X-Ours-Api-Token': this.config.gatewayCredential, 'X-Ours-Notifications-Producer': this.config.token }
                : { Authorization: `Bearer ${this.config.token}` }), 'Content-Type': 'application/json' },
              body: JSON.stringify(event),
            });
            await response.body?.cancel();
            if (!response.ok) {
              this.warn(`Task notification delivery pending (HTTP ${response.status}); committed event retained`);
              break;
            }
            acknowledgeTaskNotification(task.taskId, event.eventId);
          } catch {
            this.warn('Task notification delivery pending; committed event retained');
            break;
          }
        }
      }));
    }
  }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.shutdown.abort(); await this.running; }
}
