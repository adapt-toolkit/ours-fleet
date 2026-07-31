import { mkdirSync, statSync } from 'node:fs';
import { appendFile, chmod, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import { safeLine } from '../application/errors.js';

export interface AuditEvent {
  at?: string;
  requestId?: string;
  browser?: string;
  roleId?: string;
  action: string;
  result: string;
  errorCode?: string;
  latencyMs?: number;
  bytes?: number;
  digest?: string;
}

export class AuditSink {
  readonly dir: string;
  private readonly file: string;
  private readonly memory: AuditEvent[] = [];
  degraded?: string;
  constructor(dir = join(stateRoot(), 'web', 'audit')) {
    this.dir = dir;
    this.file = join(dir, 'audit.jsonl');
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (error) { this.degraded = (error as Error).message; }
  }
  async record(event: AuditEvent): Promise<void> {
    const safe: AuditEvent = {
      at: event.at ?? new Date().toISOString(),
      requestId: event.requestId, browser: event.browser?.slice(0, 12),
      roleId: event.roleId, action: safeLine(event.action, 128),
      result: safeLine(event.result, 128), errorCode: event.errorCode,
      latencyMs: event.latencyMs, bytes: event.bytes, digest: event.digest,
    };
    this.memory.push(safe);
    if (this.memory.length > 1_000) this.memory.shift();
    if (this.degraded) return;
    try {
      try {
        if (statSync(this.file).size > 2 * 1024 * 1024)
          await rename(this.file, join(this.dir, `audit-${Date.now()}.jsonl`));
      } catch { /* first write */ }
      await appendFile(this.file, JSON.stringify(safe) + '\n', { mode: 0o600 });
      await chmod(this.file, 0o600);
      await this.prune();
    } catch (error) { this.degraded = (error as Error).message; }
  }
  list(limit = 200): AuditEvent[] { return this.memory.slice(-Math.min(limit, 1_000)).reverse(); }
  private async prune(): Promise<void> {
    const files = (await readdir(this.dir)).filter(file => /^audit-\d+\.jsonl$/.test(file)).sort();
    for (const file of files.slice(0, -10)) await unlink(join(this.dir, file)).catch(() => undefined);
  }
}
