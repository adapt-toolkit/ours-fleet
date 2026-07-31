import { formatDuration } from '../duration.js';
import type { ResolvedWatchdog } from './config.js';
import type { BriefingVocab } from '../harness/types.js';

/** One entry in `watch.json`'s `roles` array — where to find a watched role's state. */
export interface WatchManifestRole { name: string; stateDir: string }

/**
 * The fixed run manifest a watchdog run reads at `manifestPath` (7.3 §3, Task 7 writes it,
 * Task 12+ digest reads it back). It carries everything the run needs to identify itself in
 * report.json (`watchdog`, `run_id`, `started_at`) plus the suppression digest that makes
 * alerting idempotent across runs.
 */
export interface WatchManifest {
  watchdog: string; run_id: string; coordinator: string; started_at: string;
  roles: WatchManifestRole[];
  digest: { cooldown_ms: number; open: Array<{ role: string; status: string; since: string; realert_after: string | null }> };
}

export interface WatchdogBriefingOpts {
  wd: ResolvedWatchdog;
  manifestPath: string;
  reportPath: string;
  vocabulary: BriefingVocab;
  /** What spawn actually established about the watchdog's ours identity (7.3, decision 3). */
  identityGuarantee: 'verified' | 'created' | 'unverified';
  /** Raw prompt_file content, appended as extra focus — never a replacement (owner decision 1). */
  promptFocus?: string;
}

/**
 * Render a watchdog run's fixed contract (briefing.md-equivalent for a one-shot clean-context
 * run): bind, observe-only rules, procedure, status vocabulary, evidence rules, alert rules,
 * report schema, and — if the watchdog configures one — an appended prompt_file focus.
 *
 * The contract is fixed for every watchdog (spec §5: "The schema is fixed for every watchdog,
 * including ones with a prompt_file; the override adds focus, never fields"), so every section
 * below is unconditional except the identity-guarantee wording and the trailing focus append.
 */
export function generateWatchdogBriefing(opts: WatchdogBriefingOpts): string {
  const { wd, manifestPath, reportPath, vocabulary: v, identityGuarantee: guarantee } = opts;
  const L: string[] = [];

  // 1. Header + bind instructions (mirrors src/briefing.ts:43-57; mint on first run when the
  // identity was not verified when this watchdog was created).
  L.push(`# Watchdog run: ${wd.name} (ours identity: ${wd.identity})`, '');
  L.push(`You are a fresh, one-shot inspection agent for the **${wd.name}** watchdog. You carry`);
  L.push('no memory from any previous run — this run stands alone, and nothing you learn here');
  L.push('persists past writing your report.');
  L.push('', '## 1. Bind your identity');
  L.push(`Call the **${v.bindTool}** tool with name "${wd.identity}" force=true (search the`);
  L.push('deferred tool registry first if needed).');
  if (guarantee === 'unverified') {
    L.push(`- This identity was NOT verified when this watchdog was configured, so it may not`);
    L.push(`  exist yet. If binding reports no such identity, call **${v.createTool}** name`);
    L.push(`  "${wd.identity}" once to mint it on this first run, then you are bound. Re-binding`);
    L.push('  your OWN identity is always allowed.');
  } else {
    L.push(`- It was ${guarantee === 'created' ? 'created' : 'verified to exist'} when this`);
    L.push('  watchdog was configured, so binding should succeed. If it unexpectedly reports no');
    L.push(`  such identity, call **${v.createTool}** name "${wd.identity}" once and report the`);
    L.push('  discrepancy — something removed it since.');
  }

  // 2. Observe-only rules, verbatim (spec §1).
  L.push('', '## 2. Observe-only — non-negotiable');
  L.push(
    'You observe and report. You never restart, stop, spawn or remove a role, never answer a ' +
    'pending permission, never edit a workspace or fleet.yaml, and never approve anything on the ' +
    "owner's behalf. You do exactly three things: run read-only inspections, send at most one " +
    'message to your coordinator, and write one report.json.',
  );

  // 3. Procedure.
  L.push('', '## 3. Procedure');
  L.push(`1. Read \`${manifestPath}\` (watch.json). It is JSON with this shape:`);
  L.push('   ```json');
  L.push('   {');
  L.push(`     "watchdog": "${wd.name}", "run_id": "...", "coordinator": "${wd.coordinator}",`);
  L.push('     "started_at": "...",');
  L.push('     "roles": [{ "name": "Alice", "stateDir": "/home/.../agents/Alice" }],');
  L.push('     "digest": { "cooldown_ms": 3600000, "open": [');
  L.push('       { "role": "Alice", "status": "blocked", "since": "...", "realert_after": "..." }');
  L.push('     ] }');
  L.push('   }');
  L.push('   ```');
  L.push('   Use its `watchdog`, `run_id` and `started_at` values verbatim in your report — do not');
  L.push('   invent your own.');
  L.push('2. For each entry in `roles`, gather evidence — read-only, nothing written outside your');
  L.push('   own report — from two sources:');
  L.push("   - Files under that role's `stateDir`: `briefing.md`, `WORKLOG.md` (size/mtime),");
  L.push('     `.worklog-rotation.json`, `.monitor-status`, `.monitor-owner`, `.restart-ledger.json`,');
  L.push('     `.exit-status`, `.model-status`, `.isolation-degraded`.');
  L.push('   - The sanctioned commands: `ours-fleet status <Role>`, `ours-fleet peek <Role>`,');
  L.push('     `ours-fleet logs <Role>`, `ours-fleet config`. No other `ours-fleet` subcommand is');
  L.push('     available to you, and none would be honoured even if invoked.');
  L.push('3. If a command fails, times out, or the control plane is otherwise unanswerable for a');
  L.push('   role, that role degrades to `unknown` — never guess `healthy`. `unknown` means the');
  L.push('   evidence is insufficient, not that the role is fine.');

  // 4. Status vocabulary — spec §4 definitions, verbatim where quoted.
  L.push('', '## 4. Status vocabulary (fixed)');
  L.push(`interval = ${formatDuration(wd.intervalMs)} — thresholds below are multiples of this.`);
  L.push('');
  L.push('- `healthy` — alive, on-briefing, recent progress.');
  L.push('- `idle` — alive, nothing assigned or nothing to do. Not an anomaly.');
  L.push('- `stale` = no worklog append and no console progress for ≥ 3 intervals.');
  L.push('- `blocked` = waiting on a permission/prompt/modal longer than one interval.');
  L.push('- `off_briefing` — activity contradicts the briefing (wrong repo, out-of-scope work,');
  L.push('  ignored routine).');
  L.push('- `unreachable` = configured and enabled but not running.');
  L.push(
    '- `unknown` — evidence insufficient (e.g. control plane unanswered); unknown is never ' +
    'reported as healthy.',
  );

  // 5. Evidence rules.
  L.push('', '## 5. Evidence rules');
  L.push('Every non-`healthy` entry carries a one-sentence `reason` and at most 3 `evidence`');
  L.push('items (`{source, detail, observed_at}`), each ≤280 characters. Never include env');
  L.push('values, tokens, file contents beyond quoted evidence, or a full pane dump — quote only');
  L.push('the specific line(s) that support the finding.');

  // 6. Alert rules — spec §5 rules 1-4, plus the digest-authoritative sentence, verbatim.
  L.push('', '## 6. Alert rules');
  L.push('1. Alert on a finding that is **new** (role+status not open) or **escalated** (e.g.');
  L.push('   `stale` → `blocked`).');
  L.push('2. Re-alert an unchanged open finding only after `alert_cooldown`.');
  L.push('3. Send one **resolved** notice when an open finding returns to `healthy`.');
  L.push('4. One message per run, listing all qualifying findings — never one message per role.');
  L.push('');
  L.push(
    'the suppression digest in watch.json is authoritative: alert only on findings that are new ' +
    '(role not in digest.open), escalated (higher severity than the digest entry), or past ' +
    'realert_after; send one resolved notice when a digest-open role is now healthy; ONE message ' +
    `per run listing all qualifying findings, sent with **${v.sendTool}** to "${wd.coordinator}"; ` +
    'set alerted:true and add an alerts[] entry for each. If nothing qualifies, send nothing.',
  );

  // 7. Report schema — spec §5 example, plus the write-order sentence, verbatim.
  L.push('', '## 7. Write your report');
  L.push('`report.json` has this fixed schema (`schema_version` is always the literal `1`;');
  L.push('`status` is `ok` when every role is `healthy`/`idle`, `anomalies` when any role is not,');
  L.push('and you never set `error` yourself — that field is for the scheduler):');
  L.push('```json');
  L.push('{');
  L.push('  "schema_version": 1,');
  L.push(`  "watchdog": "${wd.name}",`);
  L.push('  "run_id": "<run_id from watch.json>",');
  L.push('  "started_at": "<started_at from watch.json>",');
  L.push('  "finished_at": "2026-07-31T11:51:12Z",');
  L.push('  "status": "anomalies",');
  L.push('  "summary": { "checked": 4, "healthy": 2, "idle": 1, "anomalies": 1 },');
  L.push('  "roles": [');
  L.push('    { "role": "Bob", "status": "healthy" },');
  L.push('    {');
  L.push('      "role": "Alice",');
  L.push('      "status": "blocked",');
  L.push('      "reason": "Waiting on a trust dialog for 34 minutes with no progress.",');
  L.push('      "evidence": [');
  L.push('        { "source": "status", "detail": "session.readiness=awaiting_permission",');
  L.push('          "observed_at": "2026-07-31T11:50:31Z" },');
  L.push('        { "source": "worklog", "detail": "WORKLOG.md unchanged since 11:16Z",');
  L.push('          "observed_at": "2026-07-31T11:50:33Z" }');
  L.push('      ],');
  L.push('      "alerted": true');
  L.push('    }');
  L.push('  ],');
  L.push('  "alerts": [');
  L.push('    { "role": "Alice", "code": "blocked", "coordinator": "FleetCoordinator",');
  L.push('      "sent_at": "2026-07-31T11:51:10Z" }');
  L.push('  ],');
  L.push('  "error": null');
  L.push('}');
  L.push('```');
  L.push(`Write the report to \`${reportPath}\` (your cwd) as your LAST action — writing it ends`);
  L.push('the run. Send your coordinator message BEFORE writing report.json.');

  // 8. Appended prompt_file focus — extra emphasis only, contract stays non-negotiable.
  if (opts.promptFocus) {
    L.push('', '## Extra focus (from prompt_file)', '');
    L.push(opts.promptFocus);
    L.push(
      '',
      'The extra focus adds emphasis only. The report schema, the observe-only rules and the ' +
      'alert rules above are unchanged and non-negotiable.',
    );
  }

  return L.join('\n') + '\n';
}
