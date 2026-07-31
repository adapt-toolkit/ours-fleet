import { lstatSync, readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import { realExec } from '../exec.js';
import { logsRoot } from '../paths.js';
import type { SupervisorBackend } from '../supervisor/types.js';
import { unitFor } from '../supervisor/systemd.js';
import { ROLE_NAME_RE } from '../config.js';
import { FleetError } from './errors.js';
import type { LogPage, LogRecord } from './types.js';

const STANDARD_REDACTIONS: RegExp[] = [
  /\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi,
  /\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\bours_[A-Za-z0-9_-]{16,}\b/g,
];

export function redactLogLine(input: string, patterns: RegExp[] = []): {
  text: string; redactionApplied: boolean;
} {
  let text = input.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 16 * 1024);
  const before = text;
  for (const pattern of [...STANDARD_REDACTIONS, ...patterns.slice(0, 20)])
    text = text.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}[REDACTED]`);
  return { text, redactionApplied: text !== before };
}

export interface RoleLogSource { tail(limit: number, cursor?: string): Promise<LogPage> }

const MONITOR_STREAM_HICCUP = /^monitor degraded:\s*stream hiccup\s*\((.+)\)\s*$/;

/**
 * Presentation-only compaction for noisy historical monitor transport hiccups.
 * Exact reason and adjacency are part of the key: a different or intervening
 * record always starts a new run. Source journal/file records are untouched.
 */
export function compactMonitorStreamHiccups(records: LogRecord[]): LogRecord[] {
  const result: LogRecord[] = [];
  for (let index = 0; index < records.length;) {
    const first = records[index];
    const match = MONITOR_STREAM_HICCUP.exec(first.text);
    if (!match) {
      result.push(first);
      index++;
      continue;
    }
    const reason = match[1];
    let end = index + 1;
    while (end < records.length) {
      const candidate = MONITOR_STREAM_HICCUP.exec(records[end].text);
      if (!candidate || candidate[1] !== reason) break;
      end++;
    }
    if (end - index === 1) {
      result.push(first);
    } else {
      const last = records[end - 1];
      result.push({
        at: first.at,
        text: 'monitor degraded: stream hiccup',
        cursor: last.cursor,
        redactionApplied: records.slice(index, end).some(record => record.redactionApplied),
        compacted: {
          kind: 'monitor_stream_hiccup', reason, count: end - index,
          firstAt: first.at, lastAt: last.at,
        },
      });
    }
    index = end;
  }
  return result;
}

export class StructuredLogService {
  private readonly cursorKey = randomBytes(32);
  constructor(
    private readonly backend: SupervisorBackend,
    private readonly exec: Exec = realExec,
  ) {}

  source(roleId: string): RoleLogSource {
    if (!ROLE_NAME_RE.test(roleId)) throw new FleetError('invalid_request', 'invalid role id');
    return { tail: (limit, cursor) => this.tail(roleId, limit, cursor) };
  }

  private async tail(roleId: string, requested: number, cursor?: string): Promise<LogPage> {
    const limit = Math.min(Math.max(requested, 1), 1_000);
    const args = this.backend.id === 'systemd'
      ? {
          cmd: 'journalctl',
          args: ['--user', '-u', unitFor(roleId), '-o', 'json', '--no-pager', '-n', String(limit)],
        }
      : this.backend.logsArgs(roleId, false);
    if (!['journalctl', 'tail', 'tmux'].includes(args.cmd))
      throw new FleetError('capability_unavailable', 'log backend is unsupported');
    const result = await this.exec(args.cmd, args.args);
    if (result.code !== 0)
      throw new FleetError('backend_failure', `log query failed with exit ${result.code}`);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean).slice(-limit);
    const parsed = lines.map((line, index): LogRecord => {
      let text = line;
      let at: string | undefined;
      if (this.backend.id === 'systemd') {
        try {
          const json = JSON.parse(line) as { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: unknown; __CURSOR?: unknown };
          text = typeof json.MESSAGE === 'string' ? json.MESSAGE : line;
          if (typeof json.__REALTIME_TIMESTAMP === 'string') {
            const micros = Number(json.__REALTIME_TIMESTAMP);
            if (Number.isFinite(micros)) at = new Date(micros / 1000).toISOString();
          }
        } catch { /* preserve the bounded raw line */ }
      }
      const redacted = redactLogLine(text);
      return {
        at, ...redacted,
        cursor: this.cursor(`${roleId}:${index}:${line.length}`),
      };
    });
    const records = compactMonitorStreamHiccups(parsed);
    return {
      records, nextCursor: records.at(-1)?.cursor,
      truncated: lines.length >= limit || Boolean(cursor && !this.validCursor(cursor)),
    };
  }

  private cursor(value: string): string {
    const body = Buffer.from(value).toString('base64url');
    const tag = createHmac('sha256', this.cursorKey).update(body).digest('base64url').slice(0, 16);
    return `${body}.${tag}`;
  }
  private validCursor(cursor: string): boolean {
    const [body, tag] = cursor.split('.');
    return Boolean(body && tag && this.cursor(Buffer.from(body, 'base64url').toString()).split('.')[1] === tag);
  }
}

/** Bounded launchd file reader used by tests and diagnostics. */
export function readKnownRoleLog(roleId: string, limit = 200): LogPage {
  if (!ROLE_NAME_RE.test(roleId)) throw new FleetError('invalid_request', 'invalid role id');
  const path = join(logsRoot(), `${roleId}.log`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new Error('unsafe or oversized log file');
    const records = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit)
      .map(line => ({ ...redactLogLine(line) }));
    return { records, truncated: stat.size > 512 * 1024 };
  } catch (error) {
    throw new FleetError('backend_failure', `could not read role log: ${(error as Error).message}`);
  }
}
