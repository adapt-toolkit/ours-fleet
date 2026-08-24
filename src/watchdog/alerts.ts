import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchdogDir } from './store.js';
import type { WatchdogReport, WatchdogRoleStatus } from './report.js';
import type { WatchManifest } from './briefing.js';

/**
 * Severity ordering, lowest to highest (must match the briefing contract's alert-rules
 * sentence verbatim, src/watchdog/briefing.ts): healthy = idle (0) < unknown (1) < stale (2)
 * < blocked = unreachable (3) < off_briefing (4).
 */
export const WATCHDOG_STATUS_RANK: Record<WatchdogRoleStatus, number> = {
  healthy: 0, idle: 0, unknown: 1, stale: 2, blocked: 3, unreachable: 3, off_briefing: 4,
};

export interface OpenFinding { role: string; status: WatchdogRoleStatus; since: string; lastAlertedAt: string | null }
export interface AlertLedger { version: 1; open: Record<string, OpenFinding>; heldDownAlerted: boolean }

function emptyLedger(): AlertLedger {
  return { version: 1, open: {}, heldDownAlerted: false };
}

function ledgerPath(name: string): string {
  return join(watchdogDir(name), 'alerts.json');
}

/** Missing or corrupt ledger file yields a clean empty ledger rather than throwing. */
export function readLedger(name: string): AlertLedger {
  try {
    return JSON.parse(readFileSync(ledgerPath(name), 'utf8')) as AlertLedger;
  } catch {
    return emptyLedger();
  }
}

export function writeLedger(name: string, l: AlertLedger): void {
  const path = ledgerPath(name);
  writeFileSync(path, JSON.stringify(l, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * An `error`-status report carries no role evidence, so the ledger
 * is returned unchanged. For each finding with rank > 0: an existing open entry keeps its
 * `since` and updates `status` on escalation/de-escalation; a new one opens with `since = now`.
 * Any role reported `healthy`/`idle` closes (deletes) its open entry. Every role named in
 * `report.alerts` gets `lastAlertedAt = now`. Roles absent from the report keep their entries —
 * a watchdog with a narrowed `watch:` set doesn't silently resolve findings it never inspected.
 * Never mutates `l` — always returns a new ledger object.
 */
export function reconcileLedger(l: AlertLedger, report: WatchdogReport, now: Date): AlertLedger {
  if (report.status === 'error') return l;

  const open: Record<string, OpenFinding> = { ...l.open };
  const nowIso = now.toISOString();

  for (const finding of report.roles) {
    const rank = WATCHDOG_STATUS_RANK[finding.status];
    if (rank > 0) {
      const existing = open[finding.role];
      open[finding.role] = {
        role: finding.role,
        status: finding.status,
        since: existing ? existing.since : nowIso,
        lastAlertedAt: existing ? existing.lastAlertedAt : null,
      };
    } else {
      delete open[finding.role];
    }
  }

  for (const alert of report.alerts) {
    if (open[alert.role]) open[alert.role] = { ...open[alert.role], lastAlertedAt: nowIso };
  }

  return { ...l, open };
}

/** Ledger open findings and cooldown in the shape carried by watch.json's `digest` field. */
export function computeDigest(l: AlertLedger, cooldownMs: number, now: Date): WatchManifest['digest'] {
  return {
    cooldown_ms: cooldownMs,
    open: Object.values(l.open).map(f => ({
      role: f.role,
      status: f.status,
      since: f.since,
      realert_after: f.lastAlertedAt ? new Date(new Date(f.lastAlertedAt).getTime() + cooldownMs).toISOString() : null,
    })),
  };
}
