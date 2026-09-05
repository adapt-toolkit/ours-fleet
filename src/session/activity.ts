import type { SessionActivity } from './types.js';

/**
 * How long after the agent's last session update it still counts as working.
 *
 * FLEET-002: a wake delivered by ACP steering answers `startedNewTurn` and runs
 * an entire turn that fleet never receives a `session/prompt` response for (ACP
 * has no turn-end session update), so `readiness` stays `idle` throughout. Tool
 * reservations and update recency are the only activity evidence fleet holds.
 * The trade-off is deliberate and one-directional: at worst a role reads busy
 * for one window after it genuinely stopped, instead of reading ready — or
 * being classified stalled — while it is executing tools.
 */
export const ACTIVITY_WINDOW_MS = 60_000;

export type ActivityState = 'active' | 'quiet' | 'unobservable';

export interface ObservedActivity {
  state: ActivityState;
  activeToolCalls?: number;
  lastUpdateAt?: string;
}

/**
 * Classify agent-side activity. `unobservable` is NOT `quiet`: absent evidence
 * must never be reported as "doing nothing".
 */
export function classifyActivity(
  activity: SessionActivity | undefined, now: number = Date.now(),
): ObservedActivity {
  if (!activity) return { state: 'unobservable' };
  const lastUpdate = activity.lastUpdateAt ? Date.parse(activity.lastUpdateAt) : NaN;
  const recent = Number.isFinite(lastUpdate) && now - lastUpdate <= ACTIVITY_WINDOW_MS;
  return {
    state: activity.activeToolCalls > 0 || recent ? 'active' : 'quiet',
    activeToolCalls: activity.activeToolCalls,
    ...(activity.lastUpdateAt ? { lastUpdateAt: activity.lastUpdateAt } : {}),
  };
}

/**
 * One operator-facing line that never lets turn occupancy pose as liveness:
 * the readiness value is labelled as the turn field it is, and the activity
 * verdict is stated separately with the evidence behind it.
 */
export function describeSessionState(
  readiness: string | undefined, activity: SessionActivity | undefined,
  now: number = Date.now(),
): string {
  const observed = classifyActivity(activity, now);
  const evidence: string[] = [];
  if (observed.activeToolCalls) evidence.push(`${observed.activeToolCalls} tool calls in flight`);
  if (observed.lastUpdateAt) {
    const age = Math.max(0, Math.round((now - Date.parse(observed.lastUpdateAt)) / 1000));
    if (Number.isFinite(age)) evidence.push(`last agent update ${age}s ago`);
  }
  const detail = observed.state === 'unobservable'
    ? 'no agent-side evidence on this backend'
    : evidence.join(', ') || 'no updates yet';
  return `turn: ${readiness ?? 'unknown'} (turn occupancy only) | activity: ${observed.state} (${detail})`;
}
