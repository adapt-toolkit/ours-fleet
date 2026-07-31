#!/usr/bin/env node
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { VERSION } from './version.js';
import { agentDir, agentsRoot, tmpRoot, logsRoot, deriveXdgRuntimeDir, watchdogsRoot } from './paths.js';
import { loadConfig } from './config.js';
import type { YamlMode } from './config-yaml.js';
import { formatDuration } from './duration.js';
import { resolvedPlan } from './resolved-plan.js';
import { Tmux, tmuxArgs } from './tmux.js';
import { pickBackend } from './supervisor/index.js';
import { up, down, restartRoles, rmRole, type OpsDeps } from './ops.js';
import { readRestartLedger, runSupervised, runTemp } from './runner.js';
import { executeWatchdogRun, runWatchdogAgent } from './watchdog/run.js';
import { readSchedulerState, runScheduler, type WatchdogSchedulerState } from './watchdog/scheduler.js';
import { WatchdogServiceManager } from './watchdog/service.js';
import {
  acquireRunLock, latestReport, listRuns, readReport, releaseRunLock, reportsDir, type RunListEntry,
} from './watchdog/store.js';
import type { WatchdogReport } from './watchdog/report.js';
import {
  lastProvenance, spawnDryRun, spawnPermanent, spawnTemp, type SpawnOpts,
} from './spawn.js';
import { stringify } from 'yaml';
import { resolvedRolePlan } from './resolved-plan.js';
import { formatProvenance } from './creation.js';
import { doctor } from './doctor.js';
import { allWarnings, analyzeFleetPermissions, formatNative } from './permissions.js';
import { AI_DOCS } from './docs.js';
import {
  controlRequest, controlSocketPath, followControl, livenessNote,
} from './session/control.js';
import { SessionControlError } from './session/types.js';
import type { SessionEvent } from './session/types.js';
import { startWebConsole } from './web/runtime.js';
import { requestWebControl } from './web/control.js';
import { WebServiceManager } from './web/service.js';
import './harness/claude-code.js';   // registers the claude-code adapter
import './harness/codex.js';         // registers the codex adapter

// sudo/su shells lack XDG_RUNTIME_DIR, breaking every systemctl/journalctl
// --user child (supervisor commands, logs, doctor). Derive it before dispatch. (#9)
deriveXdgRuntimeDir();

const binPath = (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();

const deps = (): OpsDeps => ({
  backend: pickBackend(),
  binPath,
  log: l => console.log(l),
  watchdogService: new WatchdogServiceManager(),
});

const die = (e: unknown): never => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); };

/** Exec a child with our stdio (logs/attach). */
const passthrough = (cmd: string, args: string[]) =>
  new Promise<number>(resolve => {
    const c = spawnChild(cmd, args, { stdio: 'inherit' });
    c.on('exit', code => resolve(code ?? 1));
  });

const program = new Command()
  .name('ours-fleet')
  .description('Fleet of persistent, identity-bound AI agents — selectable harness and tmux/ACP sessions.')
  .enablePositionalOptions()
  .version(VERSION);

const cOpt = (cmd: Command) => cmd.option('-c, --configuration <file>', 'config file (default: ~/fleet.yaml + ~/fleet.d/)');

const collect = (value: string, previous: string[]) => [...previous, value];

program.command('docs')
  .alias('man')
  .description('print the complete AI-friendly command and configuration reference')
  .action(() => { process.stdout.write(AI_DOCS); });

function acpStateDir(name: string): string | undefined {
  const permanent = agentDir(name);
  if (existsSync(controlSocketPath(permanent))) return permanent;
  const temp = agentDir(name, true);
  if (existsSync(controlSocketPath(temp))) return temp;
  return undefined;
}

function renderSessionEvent(event: SessionEvent): void {
  switch (event.kind) {
    case 'agent_text': process.stdout.write(event.text ?? ''); break;
    case 'thought': break;
    case 'tool_call':
    case 'tool_update':
      console.log(`\n[${event.kind}] ${event.title ?? event.toolCallId ?? ''} ${event.status ?? ''}`.trimEnd());
      break;
    case 'permission':
      if (event.status === 'completed') {
        // A settled request. Automatic decisions are the ones nobody saw happen,
        // so peek/attach must show what was decided and which policy decided it.
        console.log(`\n[permission ${event.permissionId}] ${event.title ?? ''}`.trimEnd());
        console.log(`  ${event.decisionSource ?? 'manual'} decision: ${event.decision ?? 'unknown'}`
          + `${event.optionId ? ` (${event.optionId})` : ''}`
          + `${event.policy ? ` via ${event.policy}` : ''}`);
        if (event.reason) console.log(`  reason: ${event.reason}`);
        break;
      }
      console.log(`\n[permission ${event.permissionId}] ${event.title ?? ''}`);
      for (const option of event.options ?? [])
        console.log(`  ${option.optionId}: ${option.name} (${option.kind})`);
      console.log('  respond: /permit <permission-id> <option-id>');
      break;
    case 'turn_stop': console.log(`\n[turn stopped: ${event.stopReason ?? 'unknown'}]`); break;
    case 'error': console.error(`\n[error] ${event.text ?? ''}`); break;
    case 'state': break;
  }
}

function parseCodexConfig(values: string[] | undefined): Record<string, string | number | boolean> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const raw of values) {
    const i = raw.indexOf('=');
    if (i < 1) throw new Error(`invalid --codex-config '${raw}'; expected key=value`);
    const key = raw.slice(0, i);
    const value = raw.slice(i + 1);
    if (value === 'true' || value === 'false') out[key] = value === 'true';
    else if (value.trim() !== '' && Number.isFinite(Number(value))) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

cOpt(program.command('config').description('validate + print the merged plan (no side effects)'))
  .option('--json', 'emit the stable, versioned, secret-safe resolved plan')
  .option('--yaml-mode <mode>', 'non-plain YAML policy: compat|strict', 'compat')
  .action(opts => {
    try {
      if (!['compat', 'strict'].includes(opts.yamlMode))
        throw new Error(`invalid --yaml-mode '${opts.yamlMode}'; allowed: compat, strict`);
      const cfg = loadConfig(opts.configuration, { yamlMode: opts.yamlMode as YamlMode });
      if (opts.json) {
        for (const diagnostic of cfg.diagnostics) console.error(`warning: ${diagnostic.message}`);
        process.stdout.write(`${JSON.stringify(resolvedPlan(cfg), null, 2)}\n`);
        return;
      }
      console.log(`config: ${cfg.files.join(' + ') || '(none)'}`);
      for (const diagnostic of cfg.diagnostics) console.log(`warning: ${diagnostic.message}`);
      const analyses = analyzeFleetPermissions(cfg.roles);
      for (const r of cfg.roles) {
        const perms = analyses.find(a => a.role === r.name);
        console.log(`\n● ${r.name}`);
        console.log(`    harness:     ${r.harness}`);
        console.log(`    session:     ${r.session}`);
        console.log(`    monitor:     ${r.monitor.mode}`
          + (r.monitor.mode === 'fleet' ? ` (interrupt=${r.monitor.interrupt})` : ''));
        console.log(`    identity:    ${r.identity}`);
        console.log(`    permissions: approval=${r.permissions.approval} `
          + `filesystem=${r.permissions.filesystem} unattended=${r.permissions.unattended}`);
        if (perms?.supported)
          console.log(`    native:      ${formatNative(perms.native)}`
            + `${perms.exact ? '' : ' (not an exact representation)'}`);
        console.log(`    source:      ${r.sourceFile}`);
        if (r.cwd) console.log(`    cwd:         ${r.cwd}`);
        if (r.model) console.log(`    model:       ${r.model}`);
        if (r.harness_options && Object.keys(r.harness_options).length)
          console.log(`    options:     ${JSON.stringify(r.harness_options)}`);
        if (r.coordinator) console.log(`    coordinator: ${r.coordinator}`);
        if (r.mission) console.log(`    mission:     ${r.mission.split('\n')[0]}`);
        if (r.oversee?.length) console.log(`    oversees:    ${r.oversee.map(o => `${o.role}@${o.interval}`).join(', ')}`);
        if (r.isolation) {
          const iso = r.isolation;
          const caps = [
            iso.resources?.mem && `mem=${iso.resources.mem}`,
            iso.resources?.cpu && `cpu=${iso.resources.cpu}`,
            iso.resources?.pids !== undefined && `pids=${iso.resources.pids}`,
          ].filter(Boolean).join(',') || 'none';
          console.log(`    isolation:   backend=${iso.backend ?? 'auto'} net=${iso.network ?? 'broker'} `
            + `on_unavailable=${iso.on_unavailable ?? 'warn'} caps=${caps}`);
        }
        for (const w of perms ? allWarnings(perms) : []) console.log(`    warning:     ${w}`);
      }
      if (cfg.watchdogs.length) {
        console.log('watchdogs:');
        for (const w of cfg.watchdogs) {
          console.log(`● ${w.name}${w.enabled ? '' : '  (disabled)'}`);
          console.log(`  every ${formatDuration(w.intervalMs)} -> ${w.coordinator}`);
          console.log(`  harness:  ${w.harness} (${w.session})${w.model ? `, model: ${w.model}` : ''}`);
          console.log(`  identity: ${w.identity}`);
          console.log(`  watch:    ${w.watch.join(', ')}`);
          if (w.promptFile) console.log(`  focus:    ${w.promptFile}`);
        }
      }
    } catch (e) { die(e); }
  });

cOpt(program.command('up [names...]').description('create/start every role (or just the named ones)'))
  .action(async (names, opts) => {
    try { await up(loadConfig(opts.configuration), names, deps(), opts.configuration); } catch (e) { die(e); }
  });

cOpt(program.command('down [names...]').description('stop roles'))
  .action(async (names, opts) => {
    try { await down(loadConfig(opts.configuration), names, deps()); } catch (e) { die(e); }
  });

cOpt(program.command('restart [names...]').description('re-sync config + bounce, RESUMING context'))
  .action(async (names, opts) => {
    try { await restartRoles(loadConfig(opts.configuration), names, deps(), 'keep', opts.configuration); } catch (e) { die(e); }
  });

cOpt(program.command('force-restart [names...]').description('re-sync + bounce FRESH (context wiped)'))
  .action(async (names, opts) => {
    try { await restartRoles(loadConfig(opts.configuration), names, deps(), 'fresh', opts.configuration); } catch (e) { die(e); }
  });

program.command('ls').description('list running fleet sessions')
  .action(async () => {
    // Each session has its own tmux server (#32), so there is no single server
    // to ask: the known role names ARE the list of servers to poll.
    const names: string[] = [];
    const acp: string[] = [];
    for (const root of [agentsRoot(), tmpRoot()]) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        names.push(name);
        const stateDir = joinPath(root, name);
        if (!existsSync(controlSocketPath(stateDir))) continue;
        try {
          const response = await controlRequest(stateDir, { command: 'status' }, 2_000);
          if (response.ok && (response.result as { alive?: boolean } | undefined)?.alive)
            acp.push(`${name}: acp`);
        } catch { /* ignore stale sockets */ }
      }
    }
    const tmux = await new Tmux().list(names);
    console.log([tmux, ...acp].filter(Boolean).join('\n') || '(none)');
  });

program.command('attach <name>').description('open the live console (Ctrl-b d to leave)')
  .action(async name => {
    const stateDir = acpStateDir(name);
    if (!stateDir) process.exit(await passthrough('tmux', tmuxArgs(name, ['attach', '-t', name])));
    try {
      const { socket, send } = await followControl(stateDir, message => {
        if ('event' in message) renderSessionEvent(message.event as SessionEvent);
        const result = message.result as { events?: SessionEvent[] } | undefined;
        for (const event of result?.events ?? []) renderSessionEvent(event);
        if (message.ok === false) console.error(`[control] ${String(message.error ?? 'request failed')}`);
      });
      console.log(`[attached to ${name} via ACP; type a prompt, /permit …, /interrupt, or /detach]`);
      const input = createInterface({ input: process.stdin });
      input.on('line', line => {
        if (line === '/detach') { input.close(); socket.end(); return; }
        if (line === '/interrupt') { send({ command: 'interrupt' }); return; }
        const permit = line.match(/^\/permit\s+(\S+)\s+(\S+)$/);
        if (permit) {
          send({ command: 'respond_permission', permissionId: permit[1], optionId: permit[2] });
          return;
        }
        if (line.trim()) send({ command: 'submit_prompt', text: line });
      });
      await new Promise<void>(resolve => socket.once('close', resolve));
    } catch (e) { die(e); }
  });

/** Classify a raw tmux failure: only "no such session" proves the pane is gone. */
const asControlError = (e: unknown): SessionControlError => {
  if (e instanceof SessionControlError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new SessionControlError(
    /can't find session|no server running|session not found/i.test(message) ? 'offline' : 'backend',
    message);
};

/**
 * Report what actually went wrong, then say what it proves about the agent.
 * The old handler replaced every failure — timeouts, socket errors, refusals —
 * with "is not running", which is how an overseer came to restart busy agents.
 */
const controlFailure = (name: string, action: string, e: unknown, extra = ''): string => {
  const err = asControlError(e);
  return `${action} ${name}: ${err.message}\n  ${livenessNote(err.kind, name)}${extra}`;
};

program.command('peek <name> [lines]').description('pane snapshot without attaching')
  .action(async (name, lines) => {
    try {
      const stateDir = acpStateDir(name);
      if (stateDir) {
        const response = await controlRequest(stateDir, { command: 'follow', since: 0 });
        if (!response.ok)
          throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'peek failed');
        const events = (response.result as { events?: SessionEvent[] } | undefined)?.events ?? [];
        for (const event of events.slice(-(lines ? Number(lines) : 40))) renderSessionEvent(event);
      } else {
        console.log(await new Tmux().capture(name, lines ? Number(lines) : 40));
      }
    }
    catch (e) { die(controlFailure(name, 'peek', e)); }
  });

program.command('send <name> [text...]').description("type into the agent's console")
  .option('--key <key>', 'send a raw key instead (Escape, Up, C-c, ...)')
  .action(async (name, text, opts) => {
    const stateDir = acpStateDir(name);
    if (stateDir && opts.key) die('--key is available only for tmux sessions');
    if (!stateDir && !opts.key && !text?.length) die('nothing to send: give text or --key');
    if (stateDir && !text?.length) die('nothing to send: give text');
    try {
      if (stateDir) {
        // Returns on queue acceptance: a turn already running is not a failure.
        const response = await controlRequest(
          stateDir, { command: 'submit_prompt', text: text.join(' ') });
        if (!response.ok)
          throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'prompt rejected');
        const queued = response.result as { queuedBehind?: number } | undefined;
        console.log(queued?.queuedBehind
          ? `queued for ${name} behind ${queued.queuedBehind} running turn(s)`
          : `queued for ${name}`);
      } else if (opts.key) await new Tmux().sendKey(name, opts.key);
      else await new Tmux().sendText(name, text.join(' '));
    } catch (e) {
      die(controlFailure(name, 'send', e, asControlError(e).kind === 'timeout'
        ? '\n  The prompt may already have been delivered — do not assume it was lost.'
        : ''));
    }
  });

program.command('logs <name>').description('show the role log').option('-f, --follow', 'follow')
  .action(async (name, opts) => {
    const { cmd, args } = pickBackend().logsArgs(name, opts.follow === true);
    process.exit(await passthrough(cmd, args));
  });

program.command('status <name>').description('unit/agent state')
  .action(async name => {
    console.log(await pickBackend().status(name));
    // A held-down role looks like a healthy running unit from the outside — the
    // runner is alive on purpose. Say so, with the reason and when (3.2).
    const ledger = readRestartLedger(agentDir(name));
    if (ledger.circuit === 'open')
      console.log(`HELD DOWN since ${ledger.openedAt ?? ledger.updatedAt} after `
        + `${ledger.consecutiveImmediateFailures} immediate failures: ${ledger.lastReason}`
        + `\n  release it with: ours-fleet restart ${name}`);
    else if (ledger.consecutiveImmediateFailures > 0)
      console.log(`restarts: ${ledger.consecutiveImmediateFailures} consecutive immediate `
        + `failures, next delay ${ledger.nextDelayMs}ms (${ledger.lastReason})`);
    const modelStatus = joinPath(agentDir(name), '.model-status');
    if (existsSync(modelStatus)) {
      try {
        const status = JSON.parse(readFileSync(modelStatus, 'utf8')) as {
          declaredModel?: string; effectiveModel?: string; heldDown?: boolean;
        };
        console.log(`model: declared=${status.declaredModel} effective=${status.effectiveModel}`
          + `${status.heldDown ? ' HELD DOWN (chain exhausted)' : ' (runtime drift)'}`);
      } catch { console.log('model: recovery status unreadable (fail-closed)'); }
    }
    const worklog = joinPath(agentDir(name), 'WORKLOG.md');
    if (existsSync(worklog)) console.log(`worklog: ${statSync(worklog).size} bytes`);
    const stateDir = acpStateDir(name);
    if (stateDir) {
      try {
        const response = await controlRequest(stateDir, { command: 'status' }, 2_000);
        if (response.ok) console.log(`session: ${JSON.stringify(response.result)}`);
      } catch { console.log('session: acp control unavailable'); }
    }
  });

/** A watchdog is addressable if it's still configured, or its store dir survives config removal. */
function watchdogKnown(name: string, configPath?: string): boolean {
  try {
    if (loadConfig(configPath).watchdogs.some(w => w.name === name)) return true;
  } catch { /* config missing/broken: fall through to the store check */ }
  return existsSync(joinPath(watchdogsRoot(), name));
}

function renderHeldDownLine(state: WatchdogSchedulerState): string | undefined {
  if (!state.heldDown) return undefined;
  return `HELD DOWN since ${state.heldSince ?? 'unknown'} after ${state.consecutiveFailures} `
    + `consecutive failures: ${state.lastError ?? 'unknown error'}`;
}

/** errorReport() rides a bounded diagnostic tail as an extra key outside WatchdogReport proper (spec: acceptance 9). */
type ReportWithTail = WatchdogReport & { tail?: string };

/** Full human rendering of one report: header, held-down warning, counts, then non-healthy roles + evidence. */
function renderReport(report: WatchdogReport, heldState: WatchdogSchedulerState): string {
  const lines: string[] = [`● ${report.watchdog} — run ${report.run_id} (${report.status})`];
  const held = renderHeldDownLine(heldState);
  if (held) lines.push(held);
  const s = report.summary;
  lines.push(`  checked=${s.checked} healthy=${s.healthy} idle=${s.idle} anomalies=${s.anomalies}`);
  if (report.error) lines.push(`  error: ${report.error}`);
  for (const role of report.roles) {
    if (role.status === 'healthy') continue;
    lines.push(`  ${role.role}  ${role.status}  ${role.reason ?? ''}`.trimEnd());
    for (const ev of role.evidence ?? []) lines.push(`    - [${ev.source}] ${ev.detail} (${ev.observed_at})`);
    if (role.alerted) {
      const alert = report.alerts.find(a => a.role === role.role);
      lines.push(`    alerted -> ${alert?.coordinator ?? '?'}`);
    }
  }
  const tail = (report as ReportWithTail).tail;
  if (report.status === 'error' && tail) {
    lines.push('  --- output tail ---');
    for (const l of tail.split('\n')) lines.push(`  ${l}`);
  }
  return lines.join('\n');
}

function renderRunDuration(startedAt: string, finishedAt: string): string {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished)
    ? formatDuration(Math.max(0, finished - started)) : '-';
}

/** `--list` table: run-id, started, duration, status, checked/healthy/idle/anomalies, [error]. */
function renderRunList(entries: RunListEntry[]): string {
  const header = ['run-id'.padEnd(18), 'started'.padEnd(22), 'duration'.padEnd(8),
    'status'.padEnd(10), 'checked/healthy/idle/anomalies', 'error'].join('  ');
  const rows = entries.map(e => {
    const s = e.summary;
    const cols = [
      e.runId.padEnd(18), (e.startedAt || '-').padEnd(22),
      renderRunDuration(e.startedAt, e.finishedAt).padEnd(8), e.status.padEnd(10),
      `${s.checked}/${s.healthy}/${s.idle}/${s.anomalies}`.padEnd(31),
    ];
    if (e.error) cols.push(e.error);
    return cols.join('  ').trimEnd();
  });
  return [header, ...rows].join('\n');
}

cOpt(program.command('watchdog-run <name>')
  .description('run one watchdog check now, foreground, same storage as the scheduler'))
  .action(async (name: string, opts: { configuration?: string }) => {
    try {
      const cfg = loadConfig(opts.configuration);
      const wd = cfg.watchdogs.find(w => w.name === name);
      if (!wd) throw new Error(`unknown watchdog '${name}'`);
      if (!acquireRunLock(name)) throw new Error(`watchdog '${name}' is already running (run lock held)`);
      try {
        const { report, storedPath } = await executeWatchdogRun(wd, {
          binPath, log: l => console.log(l), cfg,
        });
        console.log(`stored: ${storedPath}`);
        console.log(renderReport(report, readSchedulerState(name)));
      } finally { releaseRunLock(name); }
    } catch (e) { die(e); }
  });

cOpt(program.command('watchdog-report <name> [runId]')
  .description('show a watchdog run report: latest by default, a specific run by id, --list, or --json'))
  .option('--list', 'list runs instead of showing one')
  .option('--json', 'print the stored report file bytes unmodified')
  .action((name: string, runId: string | undefined, opts: { configuration?: string; list?: boolean; json?: boolean }) => {
    try {
      if (!watchdogKnown(name, opts.configuration)) throw new Error(`unknown watchdog '${name}'`);

      if (opts.list) {
        // --list has no single stored file to echo byte-for-byte, so --json here can't
        // mean "raw stored bytes" the way it does for a single report. Contract: emit
        // machine-readable run metadata instead (JSON.stringify of listRuns()'s
        // RunListEntry[], wrapped in { runs }) — the single-report --json path below is
        // unaffected and still prints the exact stored bytes.
        if (opts.json) {
          console.log(JSON.stringify({ runs: listRuns(name) }, null, 2));
          return;
        }
        const held = renderHeldDownLine(readSchedulerState(name));
        if (held) console.log(held);
        console.log(renderRunList(listRuns(name)));
        return;
      }

      const report = runId !== undefined ? readReport(name, runId) : latestReport(name);
      if (!report) {
        throw new Error(runId !== undefined
          ? `watchdog '${name}': no such run '${runId}'`
          : `watchdog '${name}' has no reports`);
      }

      if (opts.json) {
        console.log(readFileSync(joinPath(reportsDir(name), `${runId ?? report.run_id}.json`), 'utf8'));
        return;
      }

      console.log(renderReport(report, readSchedulerState(name)));
    } catch (e) { die(e); }
  });

cOpt(program.command('rm <name>').description('stop + delete state dir (+ its fleet.d file if spawned)'))
  .action(async (name, opts) => {
    try { await rmRole(loadConfig(opts.configuration), name, deps()); } catch (e) { die(e); }
  });

cOpt(program.command('spawn <name>').description('spawn a new agent (permanent by default)'))
  .option('--temp', 'temporary: detached supervisor, auto-cleaned, gone on reboot')
  .option('--harness <id>', 'harness adapter (default: defaults.harness)')
  .option('--session <backend>', 'session backend: tmux|acp (default: defaults.session or tmux)')
  .option('--mission <text>', 'one-line mission')
  .option('--mission-file <path>', 'UTF-8 mission text (mutually exclusive with --mission)')
  .option('--identity <name>', 'ours identity to bind (default: role name)')
  .option('--cwd <dir>', 'working directory')
  .option('--coordinator <name>', 'announce target')
  .option('--model <id>', 'model id to launch on (e.g. claude-fable-5); default: launcher default')
  .option('--permission-mode <mode>', 'harness permission mode (Codex: untrusted|on-request|never; Claude: native values)')
  .option('--approval <mode>', 'common approval intent: ask|allow|deny')
  .option('--filesystem <mode>', 'common filesystem intent: read-only|workspace|unrestricted')
  .option('--unattended <mode>', 'permission behavior without a console: deny|wait')
  .option('--sandbox <mode>', 'Codex sandbox: read-only|workspace-write|danger-full-access')
  .option('--profile <name>', 'Codex profile file name ($CODEX_HOME/<name>.config.toml)')
  .option('--launcher <mode>', 'Codex launcher: auto|ours-codex|codex (default: auto)')
  .option('--search', 'enable Codex live web search')
  .option('--codex-config <key=value>', 'Codex config override (repeatable)', collect, [])
  .option('--add-dir <dir>', 'additional Codex writable directory (repeatable)', collect, [])
  .option('--monitor', 'legacy: consent to arm Codex\'s native monitor (wake owner is monitor.mode in YAML)')
  .option('--bio-file <file>', 'public bio (file)')
  .option('--persona-file <file>', 'persona / operating contract (file)')
  .option('--isolation-file <path>', 'file holding an isolation: mapping (same schema as fleet.yaml)')
  .option('--dry-run', 'validate and print without reserving or creating anything')
  .option('--json', 'with --dry-run, emit a stable secret-safe JSON result')
  .action(async (name, opts) => {
    try {
      const o: SpawnOpts = {
        name, temp: opts.temp, harness: opts.harness, session: opts.session, mission: opts.mission,
        missionFile: opts.missionFile,
        identity: opts.identity, cwd: opts.cwd, coordinator: opts.coordinator,
        model: opts.model,
        permissionMode: opts.permissionMode, approval: opts.approval,
        filesystem: opts.filesystem, unattended: opts.unattended,
        sandbox: opts.sandbox, profile: opts.profile,
        launcher: opts.launcher, search: opts.search,
        codexConfig: parseCodexConfig(opts.codexConfig), addDirs: opts.addDir, monitor: opts.monitor,
        bioFile: opts.bioFile, personaFile: opts.personaFile,
        isolationFile: opts.isolationFile, configPath: opts.configuration,
        dryRun: opts.dryRun, json: opts.json,
      };
      if (o.json && !o.dryRun) throw new Error('--json is currently valid only with --dry-run');
      if (o.dryRun) {
        const result = spawnDryRun(o);
        if (o.json) {
          process.stdout.write(`${JSON.stringify({
            schemaVersion: result.schemaVersion,
            warning: result.warning,
            roleDocument: result.roleDocument,
            resolvedRole: resolvedRolePlan(result.resolvedRole),
          }, null, 2)}\n`);
        } else {
          console.log(`# dry-run: ${result.warning}`);
          process.stdout.write(stringify(result.roleDocument));
        }
        return;
      }
      if (o.temp) {
        const dir = await spawnTemp(o, binPath);
        console.log(`spawned temp agent '${name}' (state: ${dir}; gone on exit/reboot)`);
      } else {
        const file = await spawnPermanent(o, deps());
        console.log(`spawned '${name}' (config: ${file})`);
      }
      // The same provenance that was persisted, so what the operator reads now
      // and what a reviewer reads later cannot disagree (6.6).
      if (lastProvenance) {
        console.log(`  created by ${lastProvenance.command} v${lastProvenance.fleetVersion} `
          + `at ${lastProvenance.createdAt} (${lastProvenance.lifetime})`);
        for (const line of formatProvenance(lastProvenance)) console.log(line);
      }
      console.log(`→ watch it: ours-fleet peek ${name}   |   attach: ours-fleet attach ${name}`);
    } catch (e) { die(e); }
  });

cOpt(program.command('doctor').description('prerequisite report'))
  .option('--harness <id>', 'check one harness explicitly')
  .option('--yaml-mode <mode>', 'non-plain YAML policy: compat|strict', 'compat')
  .action(async opts => {
    if (!['compat', 'strict'].includes(opts.yamlMode))
      die(`invalid --yaml-mode '${opts.yamlMode}'; allowed: compat, strict`);
    const rep = await doctor({
      harness: opts.harness,
      configPath: opts.configuration,
      yamlMode: opts.yamlMode as YamlMode,
    });
    for (const c of rep.checks) console.log(`${c.ok ? 'ok  ' : 'MISS'} ${c.name.padEnd(22)} ${c.detail}`);
    process.exit(rep.ok ? 0 : 1);
  });

program.command('init').description('one-time host setup (units, dirs, linger)')
  .action(async () => {
    for (const d of [agentsRoot(), tmpRoot(), logsRoot()]) mkdirSync(d, { recursive: true });
    for (const m of await pickBackend().init(binPath)) console.log(m);
    console.log('\nNext: copy examples/fleet.yaml to ~/fleet.yaml, edit, then: ours-fleet up');
  });

const webCommand = cOpt(program.command('web').description('start or open the secure localhost fleet web console'))
  .enablePositionalOptions()
  .option('--port <port>', 'loopback service port (default: 49271)', value => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid port');
    return port;
  })
  .option('--no-open', 'do not open a browser automatically')
  .action(async opts => {
    try {
      const manager = new WebServiceManager();
      for (const line of await manager.install(binPath, opts.port ?? 49_271, opts.configuration))
        process.stdout.write(line + '\n');
      await manager.start();
      if (opts.open !== false) {
        await requestWebControlWhenReady('open');
        process.stdout.write('Trusted-browser pairing opened locally.\n');
      } else process.stdout.write('Web service started; run `ours-fleet web open` to pair a browser.\n');
    } catch (e) { die(e); }
  });

const webPort = (command: Command) => cOpt(command)
  .option('--port <port>', 'loopback service port (default: 49271)', value => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid port');
    return port;
  });

const webServe = cOpt(webCommand.command('serve').description('run the web console in the foreground'))
  .option('--port <port>', 'loopback port (default: 49271; 0 chooses a free port)', value => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('invalid port');
    return port;
  });

webServe
  .option('--no-open', 'do not open a browser automatically')
  .action(async opts => {
    try {
      const consoleServer = await startWebConsole({
        configPath: opts.configuration, port: opts.port,
        open: opts.open !== false, binPath,
        log: line => process.stderr.write(line + '\n'),
      });
      process.stdout.write(`ours-fleet web listening on ${consoleServer.address}\n`);
      process.stdout.write(opts.open !== false
        ? 'Trusted-browser pairing opened locally.\n'
        : 'Run `ours-fleet web open` on this computer to pair a browser.\n');
      const shutdown = async () => { await consoleServer.close(); process.exit(0); };
      process.once('SIGINT', () => { void shutdown(); });
      process.once('SIGTERM', () => { void shutdown(); });
    } catch (e) { die(e); }
  });

webPort(webCommand.command('install').description('install or update the owner web service'))
  .action(async opts => {
    try {
      for (const line of await new WebServiceManager().install(
        binPath, opts.port ?? 49_271, opts.configuration)) process.stdout.write(line + '\n');
    } catch (e) { die(e); }
  });

for (const [name, description] of [
  ['start', 'start the installed owner web service'],
  ['stop', 'stop the owner web service'],
  ['restart', 'restart the owner web service'],
] as const) webCommand.command(name).description(description).action(async () => {
  try {
    await new WebServiceManager()[name]();
    process.stdout.write(`Web service ${{ start: 'started', stop: 'stopped', restart: 'restarted' }[name]}.\n`);
  }
  catch (e) { die(e); }
});

webCommand.command('status').description('show native web service status')
  .action(async () => {
    try { process.stdout.write(await new WebServiceManager().status() + '\n'); }
    catch (e) { die(e); }
  });

webCommand.command('uninstall').description('stop and uninstall the owner web service')
  .action(async () => {
    try { process.stdout.write(await new WebServiceManager().uninstall() + '\n'); }
    catch (e) { die(e); }
  });

webCommand.command('open').description('securely open or re-pair a browser with the running console')
  .action(async () => {
    try {
      await requestWebControl('open');
      process.stdout.write('Trusted-browser pairing opened locally.\n');
    } catch (e) { die(e); }
  });

webCommand.command('revoke-all').description('revoke all trusted browsers and active web sessions')
  .action(async () => {
    try {
      await requestWebControl('revoke-all');
      process.stdout.write('Revoked all trusted browsers and active web sessions.\n');
    } catch (e) { die(e); }
  });

async function requestWebControlWhenReady(command: 'open' | 'revoke-all'): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await requestWebControl(command, undefined, 500); return; }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 125)); }
  }
  throw last;
}

program.command('_run <name>', { hidden: true }).description('internal: supervisor entrypoint')
  .option('-c, --configuration <file>')
  .action(async (name, opts) => {
    // The supervised loop, not a single session: restart policy lives here now,
    // where it can count across attempts (3.2).
    try { await runSupervised(name, { configPath: opts.configuration }); } catch (e) { die(e); }
  });

program.command('_run-temp <name>', { hidden: true }).description('internal: temp-agent entrypoint')
  .action(async name => {
    try { await runTemp(name); } catch (e) { die(e); }
  });

program.command('_run-watchdog <name>', { hidden: true })
  .description('internal: one watchdog agent run (no cleanup — parent harvests)')
  .action(async name => {
    try { await runWatchdogAgent(name); } catch (e) { die(e); }
  });

cOpt(program.command('_run-watchdogs', { hidden: true }))
  .description('internal: the watchdog scheduler process')
  .action(async (opts: { configuration?: string }) => {
    try {
      let stop = false;
      process.on('SIGTERM', () => { stop = true; });
      await runScheduler(opts.configuration, {
        now: () => new Date(), sleep: ms => new Promise(r => setTimeout(r, ms)),
        log: l => console.log(l), binPath, shouldStop: () => stop,
      });
    } catch (e) { die(e); }
  });

program.parseAsync(process.argv);
