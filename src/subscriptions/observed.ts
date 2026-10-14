import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { OBSERVED_USAGE_FILE } from './store.js';

const WINDOW_LABELS: Record<string, { label: string; mins?: number }> = {
  five_hour: { label: '5h', mins: 300 },
  seven_day: { label: 'weekly', mins: 10_080 },
  seven_day_opus: { label: 'weekly · Opus', mins: 10_080 },
  seven_day_sonnet: { label: 'weekly · Sonnet', mins: 10_080 },
};

/**
 * Persist the Claude subscription rate-limit snapshot an agent session just
 * received (SDK `rate_limit_event`, forwarded by claude-agent-acp as
 * `usage_update._meta["_claude/rateLimit"]`). Only numbers and window names
 * are kept. The web backend attributes it to the agent's pinned profile.
 */
export function recordClaudeRateLimit(stateDir: string, info: unknown, now = new Date()): boolean {
  if (!info || typeof info !== 'object') return false;
  const raw = info as {
    unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }>;
    rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown;
  };
  const entries: Array<[string, { utilization?: unknown; resetsAt?: unknown }]> = raw.unifiedWindows && typeof raw.unifiedWindows === 'object'
    ? Object.entries(raw.unifiedWindows)
    : typeof raw.rateLimitType === 'string' ? [[raw.rateLimitType, raw]] : [];
  const windows = [];
  for (const [id, w] of entries) {
    if (!/^[a-z0-9_]{1,40}$/.test(id) || !w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const known = WINDOW_LABELS[id];
    windows.push({
      id, label: known?.label ?? id.replace(/_/g, ' '),
      usedPercent: Math.round(Math.max(0, w.utilization) * 1000) / 10,
      windowMins: known?.mins,
      resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : undefined,
    });
  }
  if (!windows.length) return false;
  try {
    replaceFileAtomically(join(stateDir, OBSERVED_USAGE_FILE),
      `${JSON.stringify({ windows, observedAt: now.toISOString(), source: 'agent' })}\n`, 0o600);
    return true;
  } catch { return false; }
}
