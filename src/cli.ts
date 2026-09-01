#!/usr/bin/env node
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { VERSION } from './version.js';
import { INIT_COMPLETION_GUIDANCE } from './init-guidance.js';
import { migrateLegacyStarterPresets, migratePackagedRoleDefaults } from './preset-migration.js';
import {
  executeInitWizard, isInteractiveTerminal, publishSetup, TerminalPrompter,
} from './init-wizard.js';
import {
  analyzeInstalls, buildInfo, buildLabel, discoverInstalls, runningLabel,
} from './provenance.js';
import { agentDir, agentsRoot, tmpRoot, logsRoot, deriveXdgRuntimeDir, defaultConfigPath } from './paths.js';
import { findRole, loadConfig, ROLE_NAME_RE, type AgentSelection } from './config.js';
import type { YamlMode } from './config-yaml.js';
import { formatDuration } from './duration.js';
import { redactSensitive, resolvedPlan } from './resolved-plan.js';
import { pickBackend } from './supervisor/index.js';
import { up, down, type OpsDeps } from './ops.js';
import { readRestartLedger, runSupervised, runTemp } from './runner.js';
import { executeWatchdogRun, runWatchdogAgent } from './watchdog/run.js';
import { readSchedulerState, resetSchedulerState, runScheduler, type WatchdogSchedulerState } from './watchdog/scheduler.js';
import { partitionRestartNames } from './watchdog/config.js';
import { WatchdogServiceManager } from './watchdog/service.js';
import {
  acquireRunLock, latestReport, listRuns, readReport, releaseRunLock, reportsDir, type RunListEntry,
} from './watchdog/store.js';
import type { WatchdogReport } from './watchdog/report.js';
import { watchdogAddressable } from './watchdog/query.js';
import { lastProvenance, type SpawnOpts } from './spawn.js';
import { stringify } from 'yaml';
import { resolvedRolePlan } from './resolved-plan.js';
import { creationBuildNote, formatProvenance, readProvenance } from './creation.js';
import { doctor } from './doctor.js';
import {
  allWarnings, analyzeFleetPermissions, effectivePermissionMode, formatNative,
} from './permissions.js';
import { AI_DOCS } from './docs.js';
import { classifyActivity, describeSessionState } from './session/activity.js';
import type { SessionActivity } from './session/types.js';
import {
  controlRequest, controlSocketPath, followControl, livenessNote,
} from './session/control.js';
import { SessionControlError } from './session/types.js';
import type { SessionEvent } from './session/types.js';
import { readScheduledLoops, storedLoopHealth } from './loops/state.js';
import type { LoopActionResult } from './loops/manager.js';
import type {
  OwnerChannelManagementRequest, OwnerChannelManagementResult,
} from './owner-channel/channel.js';
import { startWebConsole } from './web/runtime.js';
import { requestWebControl } from './web/control.js';
import { WebServiceManager } from './web/service.js';
import { WebAccessStore, passwordAccess, validatePublicOrigin } from './web/access.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV, type ManagedFleetSpawnResult,
} from './fleet-proxy.js';
import {
  beginFleetAuditCollection, consumeFleetAuditCollection, FleetCliExit,
  type FleetAuditAttempt, type FleetCommandOutcomeClass,
} from './fleet-command-audit.js';
import './harness/claude-code.js';   // registers the claude-code adapter
import './harness/codex.js';         // registers the codex adapter
import { registerTemplateCommands, registerTaskCommands, registerRoomCommands } from './rooms-tasks/cli.js';
import { RoleCreationService } from './application/role-creation-service.js';
import { RoleRemovalService } from './application/role-removal-service.js';
import { RoleRepository } from './application/role-repository.js';
import { FleetQueryService } from './application/fleet-query-service.js';
import {
  executeRestartBatch, RoleLifecycleService,
} from './application/role-command-service.js';

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

const roleLifecycle = (configPath: string | undefined, operationDeps: OpsDeps) => {
  const repository = new RoleRepository({ configPath });
  const query = new FleetQueryService({ repository, supervisor: operationDeps.backend });
  return new RoleLifecycleService({ repository, ops: operationDeps, configPath,
    status: async roleId => (await query.detail(roleId)).status });
};

const die = (e: unknown): never => {
  console.error(String(e instanceof Error ? e.message : e)); throw new FleetCliExit(1);
};

/** Exec a child with our stdio (logs/attach). */
const passthrough = (cmd: string, args: string[]) =>
  new Promise<number>(resolve => {
    const c = spawnChild(cmd, args, { stdio: 'inherit' });
    c.on('exit', code => resolve(code ?? 1));
  });

const program = new Command()
  .name('ours-fleet')
  .description('Fleet of persistent, identity-bound AI agents — canonical Brain + Role definitions over ACP sessions.')
  .enablePositionalOptions()
  .exitOverride()
  .version(VERSION);

const cOpt = (cmd: Command) => cmd.option('-c, --configuration <file>', 'manifest (default: ~/fleet.yaml; documents under ~/fleet/)');

const collect = (value: string, previous: string[]) => [...previous, value];

program.command('docs')
  .alias('man')
  .description('print the complete AI-friendly command and configuration reference')
  .action(() => { process.stdout.write(AI_DOCS); });

// `--version` prints the semver alone, because scripts parse it. Semver cannot
// identify an artifact — two installs on one host once reported 0.16.0 and
// disagreed about `monitor.interrupt: after_tool` — so the full identity of the
// executable answering, and of every other install it can see, lives here.
program.command('version')
  .description('build identity, capabilities, and every ours-fleet install on this host')
  .option('--json', 'emit the machine-readable build report')
  .action(opts => {
    const info = buildInfo();
    const installs = discoverInstalls();
    const running = installs.find(i => i.running);
    const skew = analyzeInstalls(installs);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ...info,
        packageRoot: running?.packageRoot,
        executable: binPath,
        node: process.versions.node,
        platform: process.platform,
        installs: installs.map(i => ({
          packageRoot: i.packageRoot,
          version: i.version,
          buildId: i.build?.buildId ?? null,
          capabilities: i.build?.capabilities ?? null,
          bin: i.bin ?? null,
          running: i.running,
        })),
        skew,
      }, null, 2)}\n`);
      return;
    }
    console.log(runningLabel());
    if (info.commit) console.log(`  commit:       ${info.commit.slice(0, 12)}${info.dirty ? ' (dirty tree)' : ''}`);
    if (info.builtAt) console.log(`  built:        ${info.builtAt}`);
    console.log(`  executable:   ${binPath}`);
    if (running) console.log(`  package root: ${running.packageRoot}`);
    console.log(`  node:         v${process.versions.node} on ${process.platform}`);
    console.log(`  capabilities: ${info.capabilities.join(', ') || '(none declared)'}`);
    for (const i of installs.filter(i => i.pathIndex !== undefined))
      console.log(`  on PATH:      ${i.bin} -> ${buildLabel(i)}`);
    for (const s of skew) console.error(`${s.severity}: ${s.message}`);
  });

function acpStateDir(name: string): string | undefined {
  const permanent = agentDir(name);
  if (existsSync(controlSocketPath(permanent))) return permanent;
  const temp = agentDir(name, true);
  if (existsSync(controlSocketPath(temp))) return temp;
  return undefined;
}

const CONTACT_CID_RE = /^[A-Fa-f0-9]{64}$/;
const OWNER_REQUEST_ID_RE = /^[a-f0-9]{64}$/;
const MAX_INVITE_BYTES = 48 * 1024;
const MAX_OWNER_UPDATE_BYTES = 1_024;

function ownerChannelStateDir(roleName: string, configuration?: string): string {
  const role = findRole(loadConfig(configuration), roleName);
  if (role.session !== 'acp')
    throw new Error(`role '${roleName}' uses session '${role.session}', but owner-channel management requires ACP`);
  if (!role.owner_channel)
    throw new Error(`role '${roleName}' has no owner_channel configured`);
  const stateDir = acpStateDir(roleName);
  if (!stateDir)
    throw new Error(`role '${roleName}' is stopped or its authenticated ACP control socket is unavailable`);
  return stateDir;
}

async function manageOwnerChannel(
  role: string, configuration: string | undefined,
  ownerChannel: OwnerChannelManagementRequest,
): Promise<OwnerChannelManagementResult> {
  const response = await controlRequest(
    ownerChannelStateDir(role, configuration), { command: 'owner_channel_manage', ownerChannel });
  if (!response.ok)
    throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'owner-channel request failed');
  return response.result as OwnerChannelManagementResult;
}

function assertContactCid(cid: string): void {
  if (!CONTACT_CID_RE.test(cid)) throw new Error('contact CID must be exactly 64 hexadecimal characters');
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

function parseAgentSelection(raw: string | undefined, kind: 'brain' | 'role'): AgentSelection | undefined {
  if (raw === undefined) return undefined;
  if (ROLE_NAME_RE.test(raw)) return { ref: raw };
  if (!raw.startsWith('inline:'))
    throw new Error(`invalid --${kind}; use a declared ID or inline:{...}`);
  let value: unknown;
  try { value = JSON.parse(raw.slice('inline:'.length)); }
  catch { throw new Error(`invalid --${kind} inline mapping`); }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`invalid --${kind} inline mapping`);
  return { inline: value as Record<string, unknown> };
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
      // Which artifact resolved this plan. Two installs can share a semver and
      // disagree about what fleet.yaml means; the plan below is only true of this one.
      console.log(`build:  ${runningLabel()}`);
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
        if (r.owner_channel)
          console.log(`    owner ch:    ${r.owner_channel.identity} `
            + `(${r.owner_channel.owners.length} authorized sender(s), `
            + `interrupt=${r.owner_channel.interrupt})`);
        console.log(`    permissions: approval=${r.permissions.approval} `
          + `filesystem=${r.permissions.filesystem} unattended=${r.permissions.unattended}`);
        if (perms?.supported)
          console.log(`    native:      ${formatNative(perms.native)}`
            + `${perms.exact ? '' : ' (not an exact representation)'}`);
        console.log(`    source:      ${r.sourceFile}`);
        if (r.cwd) console.log(`    cwd:         ${r.cwd}`);
        if (r.model) console.log(`    model:       ${r.model}`);
        if (r.effort) console.log(`    effort:      ${r.effort}`);
        if (r.harness_options && Object.keys(r.harness_options).length)
          console.log(`    options:     ${JSON.stringify(redactSensitive(r.harness_options))}`);
        if (r.coordinator) console.log(`    coordinator: ${r.coordinator}`);
        if (r.mission) console.log(`    mission:     ${r.mission.split('\n')[0]}`);
        if (r.oversee?.length) console.log(`    oversees:    ${r.oversee.map(o => `${o.agent}@${o.interval}`).join(', ')}`);
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
          console.log(`● ${w.name}${w.enabled ? '' : '  (disabled)'}`
            + `${readSchedulerState(w.name).heldDown ? '  (held down)' : ''}`);
          console.log(`  every ${formatDuration(w.intervalMs)} -> ${w.coordinator}`);
          console.log(`  harness:  ${w.harness} (${w.session})${w.model ? `, model: ${w.model}` : ''}`);
          console.log(`  identity: ${w.identity}`);
          console.log(`  watch:    ${w.watch.join(', ')}`);
          if (w.promptFile) console.log(`  focus:    ${w.promptFile}`);
          if (w.isolation) console.log(`  isolation: ${JSON.stringify(w.isolation)}`);
        }
      }
      if (cfg.loops.length) {
        console.log('loops:');
        for (const loop of cfg.loops) {
          console.log(`● ${loop.name}${loop.enabled ? '' : '  (disabled)'}`);
          console.log(`  every ${formatDuration(loop.intervalMs)} initial=${formatDuration(loop.initialDelayMs)} jitter=${formatDuration(loop.jitterMs)}`);
          console.log(`  roles: ${loop.roleNames.join(', ')}`);
          console.log(`  prompt: ${loop.promptBytes} bytes sha256=${loop.promptHash.slice(0, 12)}`);
        }
      }
    } catch (e) { die(e); }
  });

cOpt(program.command('up [names...]').description('create/start every role (or just the named ones)'))
  .action(async (names, opts) => {
    try { await up(loadConfig(opts.configuration), names, deps(), opts.configuration); } catch (e) { die(e); }
  });

cOpt(program.command('down [names...]').description('stop configured roles or exact named temporary roles'))
  .action(async (names, opts) => {
    try { await down(loadConfig(opts.configuration), names, deps()); } catch (e) { die(e); }
  });

cOpt(program.command('restart [names...]').description('re-sync config + bounce, RESUMING context'))
  .action(async (names: string[], opts) => {
    try {
      const cfg = loadConfig(opts.configuration);
      // Watchdog names can't collide with role names (config validation
      // guarantees dispatch is unambiguous), so a name matching a configured
      // watchdog is always a release, never a role restart. Release each
      // named watchdog directly instead of handing it to restartRoles, which
      // only knows about roles and would reject it as unknown (3.2 release path).
      const { watchdogNames, roleNames } = partitionRestartNames(cfg, names);
      for (const wn of watchdogNames) {
        resetSchedulerState(wn);
        console.log(`released watchdog '${wn}' — scheduler resumes on its next poll`);
      }
      // Bare `restart` (no names) restarts every role — that meaning must
      // survive even though filtering an empty array also yields [].
      if (names.length === 0 || roleNames.length > 0) {
        const operationDeps = deps();
        const lifecycle = roleLifecycle(opts.configuration, operationDeps);
        await executeRestartBatch(lifecycle, { roleIds: roleNames, mode: 'keep', config: cfg });
      }
    } catch (e) { die(e); }
  });

cOpt(program.command('force-restart [names...]').description('re-sync + bounce FRESH (context wiped)'))
  .action(async (names, opts) => {
    try {
      const cfg = loadConfig(opts.configuration);
      const operationDeps = deps();
      const lifecycle = roleLifecycle(opts.configuration, operationDeps);
      await executeRestartBatch(lifecycle, { roleIds: names, mode: 'fresh', config: cfg });
    } catch (e) { die(e); }
  });

cOpt(program.command('ls').description('list running declared persistent Agent sessions'))
  .action(async (opts: { configuration?: string }) => {
    const acp: string[] = [];
    const cfg = loadConfig(opts.configuration);
    for (const { name } of cfg.roles) {
        const stateDir = agentDir(name);
        if (!existsSync(controlSocketPath(stateDir))) continue;
        try {
          const response = await controlRequest(stateDir, { command: 'status' }, 2_000);
          const result = response.result as
            { alive?: boolean; activity?: SessionActivity } | undefined;
          if (response.ok && result?.alive) {
            // Activity, not readiness: an idle-readiness role may be running a
            // steered wake turn (FLEET-002), so `ls` reports what was observed.
            const observed = classifyActivity(result.activity);
            acp.push(`${name}: acp${observed.state === 'active' ? ' (working)'
              : observed.state === 'quiet' ? ' (no recent agent activity)' : ''}`);
          }
        } catch { /* ignore stale sockets */ }
    }
    console.log(acp.join('\n') || '(none)');
  });

program.command('attach <name>').description('open the live console (Ctrl-b d to leave)')
  .action(async name => {
    const stateDir = acpStateDir(name);
    if (!stateDir) throw new SessionControlError('offline', 'agent session is offline');
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

/** Preserve typed control failures and classify only definite missing-session errors as offline. */
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
      } else throw new SessionControlError('offline', 'agent session is offline');
    }
    catch (e) { die(controlFailure(name, 'peek', e)); }
  });

program.command('send <name> [text...]').description("type into the agent's console")
  .action(async (name, text, opts) => {
    const stateDir = acpStateDir(name);
    if (!text?.length) die('nothing to send: give text');
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
      } else throw new SessionControlError('offline', 'agent session is offline');
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

cOpt(program.command('status <name>').description('declared persistent Agent unit/session state'))
  .action(async (name, opts: { configuration?: string }) => {
    findRole(loadConfig(opts.configuration), name);
    console.log(await pickBackend().status(name));
    // A role outlives the artifact that created it. If a different build is
    // reporting now, its settings may resolve differently than at creation.
    const created = readProvenance(agentDir(name));
    const buildNote = created && creationBuildNote(created);
    if (buildNote) console.log(`build: ${buildNote}`);
    // A held-down role looks like a healthy running unit from the outside — the
    // runner is alive on purpose. Say so, with the reason and when.
    const ledger = readRestartLedger(agentDir(name));
    if (ledger.circuit === 'open')
      console.log(`HELD DOWN since ${ledger.openedAt ?? ledger.updatedAt} after `
        + `${ledger.consecutiveImmediateFailures} immediate failures: ${ledger.lastReason}`
        + `\n  release it with: ours-fleet restart ${name}`);
    else if (ledger.consecutiveImmediateFailures > 0)
      console.log(`restarts: ${ledger.consecutiveImmediateFailures} consecutive immediate `
        + `failures, next delay ${ledger.nextDelayMs}ms (${ledger.lastReason})`);
    // A kill the supervisor never saw leaves no other trace here. Say it out
    // loud rather than letting the absence of a failure streak read as "fine".
    if (ledger.lastTermination?.class === 'abrupt')
      console.log(`last termination: ABRUPT — the previous supervisor run (started `
        + `${ledger.lastTermination.runStartedAt ?? 'unknown'}) died without an orderly exit; `
        + `observed ${ledger.lastTermination.observedAt}`
        + `\n  abrupt terminations recorded: ${ledger.abruptTerminations ?? 1}`
        + `\n  cause (signal / OOM-kill): journalctl --user -u ours-fleet-agent@${name}.service`);
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
        if (response.ok) {
          const snapshot = response.result as {
            readiness?: string; activity?: SessionActivity;
          };
          console.log(`session: ${JSON.stringify(response.result)}`);
          // `readiness` is turn occupancy, never an activity claim: a steered
          // wake turn runs to completion with readiness pinned at `idle`
          // (FLEET-002). Say which question each field answers.
          console.log(describeSessionState(snapshot.readiness, snapshot.activity));
        }
      } catch { console.log('session: acp control unavailable'); }
    }
    // Loop health is asked of the live manager first: when its state writes are
    // failing it is the ONLY source that can say so — the stored file is frozen
    // at whatever it last managed to record, which is why a role with every loop
    // dead still reported `healthy` for 2h51m. The probe cannot be conditional on
    // there being a stored file either: a manager whose very first checkpoint hit
    // ENOSPC never wrote one, and it is precisely the one worth asking.
    let loopState = readScheduledLoops(agentDir(name));
    let loopEvidence = 'stored';
    const loopControl = permanentLoopControlDir(name);
    if (loopControl) {
      try {
        const response = await controlRequest(loopControl, { command: 'loop_status' }, 2_000);
        if (response.ok) { loopState = response.result as typeof loopState; loopEvidence = 'live'; }
      } catch { /* stored evidence stays honest */ }
    }
    if (loopState) {
      const values = Object.values(loopState.loops);
      const enabled = values.filter(loop => loop.enabled && !loop.operatorDisabled).length;
      const next = values.filter(loop => loop.enabled && !loop.operatorDisabled)
        .map(loop => Date.parse(loop.nextDueAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const verdict = storedLoopHealth(loopState, Date.now());
      const health = loopEvidence === 'live' ? loopState.health : verdict.health;
      console.log(`loops: ${enabled} enabled${next ? `, next ${formatDuration(Math.max(0, next - Date.now()))}` : ''}, ${health}`
        + (loopEvidence === 'stored' && verdict.stale
          ? ` (no state update for ${formatDuration(verdict.ageMs)}; last recorded ${verdict.recorded})` : '')
        + (loopState.anomaly ? ` anomaly=${loopState.anomaly}` : '')
        + ` evidence=${loopEvidence}`);
    }
  });

const loopsCommand = program.command('loops')
  .description('validate, inspect, and control strict idle-only scheduled agent loops');

function loopFailure(error: unknown, json: boolean, code = 1): void {
  const err = error instanceof SessionControlError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({
    schemaVersion: 1, ok: false,
    error: { kind: err?.kind ?? 'invalid', message, retrySafe: err?.kind !== 'timeout' },
  }));
  else console.error(message);
  process.exitCode = code;
}

function permanentLoopControlDir(role: string): string | undefined {
  const dir = agentDir(role);
  return existsSync(controlSocketPath(dir)) ? dir : undefined;
}

cOpt(loopsCommand.command('validate').description('validate loop config and expanded ACP targets'))
  .option('--json', 'emit stable JSON')
  .action(opts => {
    try {
      const cfg = loadConfig(opts.configuration);
      const result = { schemaVersion: 1, ok: true, loops: cfg.loops.length,
        pairs: cfg.roles.reduce((sum, role) => sum + (role.loops?.length ?? 0), 0) };
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`valid: ${result.loops} loop(s), ${result.pairs} resolved role pair(s)`);
    } catch (error) { loopFailure(error, opts.json === true); }
  });

cOpt(loopsCommand.command('list').description('list redacted resolved loop definitions'))
  .option('--role <role>', 'filter to one permanent role')
  .option('--json', 'emit stable JSON')
  .action(opts => {
    try {
      const cfg = loadConfig(opts.configuration);
      if (opts.role) findRole(cfg, opts.role);
      const values = cfg.loops.filter(loop => !opts.role || loop.roleNames.includes(opts.role)).map(loop => ({
        name: loop.name, selectors: loop.selectors, roles: loop.roleNames,
        enabled: loop.enabled, intervalMs: loop.intervalMs, initialDelayMs: loop.initialDelayMs,
        jitterMs: loop.jitterMs, prompt: { bytes: loop.promptBytes, sha256: loop.promptHash },
        sourceFile: loop.sourceFile,
      }));
      if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, loops: values }));
      else for (const loop of values)
        console.log(`${loop.name} ${loop.enabled ? 'enabled' : 'disabled'} every=${formatDuration(loop.intervalMs)} roles=${loop.roles.join(',')} prompt=${loop.prompt.bytes}B/${loop.prompt.sha256.slice(0, 12)}`);
    } catch (error) { loopFailure(error, opts.json === true); }
  });

function selectLoopConfig(configuration: string | undefined, roleName: string, loopName?: string) {
  const cfg = loadConfig(configuration);
  const role = findRole(cfg, roleName);
  const definitions = role.loops ?? [];
  if (loopName && !definitions.some(loop => loop.name === loopName))
    throw new Error(`role '${roleName}' has no scheduled loop '${loopName}'`);
  return { role, definitions };
}

function renderLoopRows(role: string, state: ReturnType<typeof readScheduledLoops>, loop?: string): string[] {
  if (!state) return [];
  return Object.entries(state.loops).filter(([name]) => !loop || name === loop).map(([name, item]) =>
    `${role}/${name} ${item.enabled && !item.operatorDisabled ? 'enabled' : 'disabled'} `
      + `${item.activeRunId ? 'running' : 'idle'} next=${item.nextDueAt} last=${item.lastOutcome ?? 'never'} `
      + `counts=${item.counts.started}/${item.counts.completed}/${item.counts.failed} `
      + `skip=${item.counts.skipped}(busy=${item.counts.skippedBusy},missed=${item.counts.skippedMissed})`
      + (item.missedGap
        ? ` gap=${item.missedGap.count}@${item.missedGap.fromAt}..${item.missedGap.throughAt}`
        : ''));
}

cOpt(loopsCommand.command('status [role] [loop]').description('show live or stored loop state'))
  .option('--json', 'emit stable JSON')
  .action(async (roleName, loopName, opts) => {
    try {
      const cfg = loadConfig(opts.configuration);
      const roles = roleName ? [findRole(cfg, roleName)] : cfg.roles.filter(role => role.loops?.length);
      if (roleName && loopName) selectLoopConfig(opts.configuration, roleName, loopName);
      const results = [];
      for (const role of roles) {
        let state = readScheduledLoops(agentDir(role.name));
        let evidence = 'stored';
        const live = permanentLoopControlDir(role.name);
        if (live) try {
          const response = await controlRequest(live, { command: 'loop_status' }, 2_000);
          if (response.ok) { state = response.result as typeof state; evidence = 'live'; }
        } catch { /* stored evidence remains honest; timeout is not offline */ }
        // Stored evidence is only as current as the last write that landed.
        const verdict = state && evidence === 'stored' ? storedLoopHealth(state, Date.now()) : undefined;
        results.push({
          role: role.name, evidence, state,
          health: verdict ? verdict.health : state?.health ?? null,
          staleMs: verdict?.stale ? verdict.ageMs : null,
        });
      }
      if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, roles: results }));
      else {
        const rows = results.flatMap(result => renderLoopRows(result.role, result.state, loopName)
          .map(row => `${row} evidence=${result.evidence} health=${result.health}`
            + (result.staleMs === null ? '' : ` stale=${formatDuration(result.staleMs)}`)));
        console.log(rows.join('\n') || '(no scheduled loop state)');
      }
    } catch (error) { loopFailure(error, opts.json === true); }
  });

cOpt(loopsCommand.command('reload <role>').description('reload trusted scheduled-loop config in a live ACP role'))
  .option('--json', 'emit stable JSON')
  .action(async (roleName, opts) => {
    try {
      const { role } = selectLoopConfig(opts.configuration, roleName);
      if (role.session !== 'acp') throw new Error(`role '${roleName}' is not ACP-compatible`);
      const stateDir = permanentLoopControlDir(roleName);
      if (!stateDir) throw new SessionControlError('control-unavailable',
        `role '${roleName}' has no live authenticated ACP control socket`);
      const response = await controlRequest(stateDir, { command: 'reload_config' });
      if (!response.ok)
        throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'config reload failed');
      const result = response.result as { changed: boolean; loops: number };
      if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, ok: true, role: roleName, ...result }));
      else console.log(`${roleName}: ${result.changed ? 'reloaded' : 'unchanged'} (${result.loops} loops)`);
    } catch (error) {
      loopFailure(error, opts.json === true,
        error instanceof SessionControlError
          && ['timeout', 'control-unavailable'].includes(error.kind) ? 2 : 1);
    }
  });

for (const command of ['run-now', 'disable', 'enable'] as const) {
  cOpt(loopsCommand.command(`${command} <role> <loop>`)
    .description(`${command} one trusted configured loop through the live private control socket`))
    .option('--json', 'emit stable JSON')
    .action(async (roleName, loopName, opts) => {
      try {
        const { role, definitions } = selectLoopConfig(opts.configuration, roleName, loopName);
        if (role.session !== 'acp') throw new Error(`role '${roleName}' is not ACP-compatible`);
        const definition = definitions.find(loop => loop.name === loopName)!;
        if (command === 'enable' && !definition.enabled)
          throw new Error(`loop '${loopName}' is disabled in YAML; edit the config before enabling it`);
        const stateDir = permanentLoopControlDir(roleName);
        if (!stateDir) throw new SessionControlError('control-unavailable',
          `role '${roleName}' has no live authenticated ACP control socket`);
        const response = await controlRequest(stateDir, {
          command: command === 'run-now' ? 'loop_run_now'
            : command === 'disable' ? 'loop_disable' : 'loop_enable',
          loop: loopName,
        });
        if (!response.ok)
          throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'loop control failed');
        const result = response.result as LoopActionResult;
        if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, ok: true, role: roleName, loop: loopName, ...result }));
        else console.log(`${roleName}/${loopName}: ${result.state}${result.runId ? ` ${result.runId}` : ''}`);
        if (command === 'run-now' && result.state !== 'started') process.exitCode = 3;
      } catch (error) {
        loopFailure(error, opts.json === true,
          error instanceof SessionControlError
            && ['timeout', 'control-unavailable'].includes(error.kind) ? 2 : 1);
      }
    });
}

const ownerChannelCommand = program.command('owner-channel')
  .description('manage owner routing and task-correlated reports through a running role supervisor')
  .addHelpText('after', '\nPairing is two-step: establish a contact first, then explicitly authorize its exact CID.');
const ownerContactCommand = ownerChannelCommand.command('contact')
  .description('establish contacts without granting owner authority');
const ownerAuthorizationCommand = ownerChannelCommand.command('owner')
  .description('manage the effective owner CID set (separate from contacts)');
const ownerTaskCommand = ownerChannelCommand.command('task')
  .description('register and report bounded follow-up work correlated to an authenticated owner request');

cOpt(ownerTaskCommand.command('open <Role> <active-request-id>')
  .description('register a durable follow-up task during the exact active owner request'))
  .action(async (role, requestId, opts) => {
    try {
      if (!OWNER_REQUEST_ID_RE.test(requestId))
        throw new Error('owner task request ID must be exactly 64 lowercase hexadecimal characters');
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'task_open', requestId,
      });
      if (result.action !== 'task_open') throw new Error('unexpected owner-channel response');
      console.log(`Owner task ${result.taskId} opened; expires ${result.expiresAt}.`);
    } catch (e) { die(e); }
  });

cOpt(ownerTaskCommand.command('report <Role> <task-id>')
  .description('send a proactive follow-up to the task\'s stored authenticated origin')
  .requiredOption('--phase <phase>', 'progress, done, or blocked')
  .requiredOption('--message-stdin', 'read the one-line report body from stdin'))
  .action(async (role, taskId, opts) => {
    try {
      if (!OWNER_REQUEST_ID_RE.test(taskId))
        throw new Error('owner task ID must be exactly 64 lowercase hexadecimal characters');
      const phase = String(opts.phase);
      if (!['progress', 'done', 'blocked'].includes(phase))
        throw new Error('owner task report phase must be progress, done, or blocked');
      const message = readFileSync(0, 'utf8');
      if (Buffer.byteLength(message) > MAX_OWNER_UPDATE_BYTES)
        throw new Error(`owner task report input exceeds ${MAX_OWNER_UPDATE_BYTES} bytes`);
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'task_report', taskId, phase: phase as 'progress' | 'done' | 'blocked', message,
      });
      if (result.action !== 'task_report') throw new Error('unexpected owner-channel response');
      console.log(`Owner task report ${result.sequence} delivered; task ${result.state}.`);
    } catch (e) { die(e); }
  });

cOpt(ownerChannelCommand.command('update <Role> <request-id>')
  .description('send one bounded agent-authored update for an active owner request')
  .requiredOption('--phase <phase>', 'working, approval, or blocked')
  .requiredOption('--message-stdin', 'read the one-line update body from stdin'))
  .action(async (role, requestId, opts) => {
    try {
      if (!OWNER_REQUEST_ID_RE.test(requestId))
        throw new Error('owner update request ID must be exactly 64 lowercase hexadecimal characters');
      const phase = String(opts.phase);
      if (!['working', 'approval', 'blocked'].includes(phase))
        throw new Error('owner update phase must be working, approval, or blocked');
      const message = readFileSync(0, 'utf8');
      if (Buffer.byteLength(message) > MAX_OWNER_UPDATE_BYTES)
        throw new Error(`owner update input exceeds ${MAX_OWNER_UPDATE_BYTES} bytes`);
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'request_update', requestId,
        phase: phase as 'working' | 'approval' | 'blocked', message,
      });
      if (result.action !== 'request_update') throw new Error('unexpected owner-channel response');
      console.log(`Owner update ${result.sequence} delivered.`);
    } catch (e) { die(e); }
  });

cOpt(ownerContactCommand.command('list <Role>')
  .description('list established/pending contacts using safe identity metadata only'))
  .action(async (role, opts) => {
    try {
      const result = await manageOwnerChannel(role, opts.configuration, { action: 'contact_list' });
      if (result.action !== 'contact_list') throw new Error('unexpected owner-channel response');
      if (!result.contacts.length) { console.log('(no contacts)'); return; }
      console.log('CID\tNAME\tSTATUS\tKIND\tHUMAN');
      for (const contact of result.contacts) console.log([
        contact.cid, contact.name, contact.status, contact.kind ?? '', contact.human?.name ?? '',
      ].join('\t'));
    } catch (e) { die(e); }
  });

cOpt(ownerContactCommand.command('invite <Role>')
  .description('generate an invite on the already-bound owner channel')
  .option('--name <label>', 'optional contact label'))
  .action(async (role, opts) => {
    try {
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'contact_invite', ...(opts.name ? { name: String(opts.name) } : {}),
      });
      if (result.action !== 'contact_invite') throw new Error('unexpected owner-channel response');
      // Invite material is intentionally the only stdout content.
      process.stdout.write(result.invite + '\n');
    } catch (e) { die(e); }
  });

cOpt(ownerContactCommand.command('add <Role>')
  .description('accept an invite without granting owner authority')
  .option('--invite-file <path>', 'read invite material from a file')
  .option('--invite-stdin', 'read invite material from stdin')
  .option('--name <label>', 'optional contact label'))
  .action(async (role, opts) => {
    try {
      if (Boolean(opts.inviteFile) === Boolean(opts.inviteStdin))
        throw new Error('choose exactly one of --invite-file <path> or --invite-stdin');
      const invite = readFileSync(opts.inviteStdin ? 0 : String(opts.inviteFile), 'utf8').trim();
      if (!invite) throw new Error('invite input is empty');
      if (Buffer.byteLength(invite) > MAX_INVITE_BYTES)
        throw new Error(`invite input exceeds ${MAX_INVITE_BYTES} bytes`);
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'contact_add', invite, ...(opts.name ? { name: String(opts.name) } : {}),
      });
      if (result.action !== 'contact_add') throw new Error('unexpected owner-channel response');
      console.log('Invite accepted; contact establishment is pending peer verification.');
      console.log('No owner authority was granted. After the contact is established, authorize its exact CID separately.');
    } catch (e) { die(e); }
  });

cOpt(ownerAuthorizationCommand.command('list <Role>')
  .description('show baseline/dynamic source and effective authorization state'))
  .action(async (role, opts) => {
    try {
      const result = await manageOwnerChannel(role, opts.configuration, { action: 'owner_list' });
      if (result.action !== 'owner_list') throw new Error('unexpected owner-channel response');
      if (!result.integrity.ok)
        console.error('warning: owner authorization overlay is corrupt; effective authorization is fail-closed');
      console.log('CID\tSOURCE\tEFFECTIVE');
      for (const owner of result.owners)
        console.log(`${owner.cid}\t${owner.source}\t${owner.effective ? 'yes' : 'no'}`);
    } catch (e) { die(e); }
  });

cOpt(ownerAuthorizationCommand.command('authorize <Role> <contact-cid>')
  .description('authorize an exact CID which is already an established contact'))
  .action(async (role, cid, opts) => {
    try {
      assertContactCid(cid);
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'owner_authorize', cid,
      });
      if (result.action !== 'owner_authorize') throw new Error('unexpected owner-channel response');
      console.log(`Authorized owner ${result.owner.cid} (${result.owner.source}).`);
    } catch (e) { die(e); }
  });

cOpt(ownerAuthorizationCommand.command('revoke <Role> <contact-cid>')
  .description('revoke an exact effective owner CID; the last owner is protected'))
  .action(async (role, cid, opts) => {
    try {
      assertContactCid(cid);
      const result = await manageOwnerChannel(role, opts.configuration, {
        action: 'owner_revoke', cid,
      });
      if (result.action !== 'owner_revoke') throw new Error('unexpected owner-channel response');
      console.log(`Revoked owner ${result.owner.cid} (${result.owner.source}).`);
    } catch (e) { die(e); }
  });

/**
 * A watchdog is addressable if it's still configured, or its store dir survives
 * config removal. The name-shape check runs BEFORE any filesystem lookup
 * A hostile `name` (path separators, '..', etc.) must never
 * reach `join(watchdogsRoot(), name)` — treated as simply unknown, same as
 * store.ts's own `watchdogDir` choke-point guard (defense in depth).
 */
function watchdogKnown(name: string, configPath?: string): boolean {
  let configured: string[] = [];
  try {
    configured = loadConfig(configPath).watchdogs.map(w => w.name);
  } catch { /* config missing/broken: fall through to the store check */ }
  return watchdogAddressable(name, configured);
}

function renderHeldDownLine(state: WatchdogSchedulerState): string | undefined {
  if (!state.heldDown) return undefined;
  return `HELD DOWN since ${state.heldSince ?? 'unknown'} after ${state.consecutiveFailures} `
    + `consecutive failures: ${state.lastError ?? 'unknown error'}`;
}

/** errorReport() carries a bounded diagnostic tail as an extra key outside WatchdogReport proper. */
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

cOpt(program.command('rm <name>').description('stop + remove a role (temporary evidence is archived)'))
  .action(async (name, opts) => {
    try {
      await new RoleRemovalService({ configPath: opts.configuration, ops: deps() }).removeDirect({
        actor: { kind: 'local_control', surface: 'cli' }, role: name,
      });
    } catch (e) { die(e); }
  });

cOpt(program.command('spawn [name]').description('spawn a new agent (permanent by default)'))
  .option('--name <name>', 'agent name (alternative to the positional name)')
  .option('--brain <selection>', 'Brain ID or inline:{...} definition')
  .option('--role <selection>', 'Role ID or inline:{...} definition')
  .option('--temp', 'temporary: independent transient supervisor, archived on retirement, gone on reboot')
  .option('--identity <name>', 'ours identity to bind (default: Agent name)')
  .option('--cwd <dir>', 'working directory')
  .option('--coordinator <name>', 'announce target')
  .option('--approval <mode>', 'fleet permission mode: ask|auto|allow (Codex ACP allow selects agent-full-access; deny is deprecated)')
  .option('--filesystem <mode>', 'common filesystem intent: read-only|workspace|unrestricted')
  .option('--unattended <mode>', 'permission behavior without a console: deny|wait')
  .option('--isolation-file <path>', 'file holding an isolation: mapping (same schema as fleet.yaml)')
  .option('--dry-run', 'validate and print without reserving or creating anything')
  .option('--json', 'with --dry-run, emit a stable secret-safe JSON result')
  .action(async (name, opts) => {
    try {
      const roleName = String(name ?? opts.name ?? '');
      if (!roleName) throw new Error('agent name is required (positional or --name)');
      if (name && opts.name && name !== opts.name)
        throw new Error(`positional agent name conflicts with --name`);
      const o: SpawnOpts = {
        name: roleName, temp: opts.temp,
        brain: parseAgentSelection(opts.brain, 'brain'), role: parseAgentSelection(opts.role, 'role'),
        identity: opts.identity, cwd: opts.cwd, coordinator: opts.coordinator,
        approval: opts.approval,
        filesystem: opts.filesystem, unattended: opts.unattended,
        isolationFile: opts.isolationFile, configPath: opts.configuration,
        dryRun: opts.dryRun, json: opts.json,
      };
      if (o.json && !o.dryRun) throw new Error('--json is currently valid only with --dry-run');
      const creationDeps = deps();
      const creation = new RoleCreationService({ configPath: opts.configuration,
        ops: creationDeps, binPath, journal: false });
      if (o.dryRun) {
        const result = creation.previewSpawn({ origin: 'direct', options: o }).preview;
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
      const proxyStateDir = process.env[FLEET_PROXY_STATE_DIR_ENV];
      if (proxyStateDir) {
        // Paths entered in the agent shell belong to that shell's cwd, not the
        // supervisor process. Normalize before crossing the control boundary.
        for (const key of ['isolationFile'] as const) {
          if (o[key]) o[key] = resolvePath(o[key]!);
        }
        const response = await controlRequest(
          proxyStateDir, { command: 'fleet_spawn', spawn: o }, 10 * 60_000);
        if (!response.ok)
          throw new SessionControlError(response.kind ?? 'backend', response.error ?? 'managed spawn failed');
        const result = response.result as ManagedFleetSpawnResult;
        const expectedCaller = process.env[FLEET_PROXY_CALLER_ENV];
        if (expectedCaller && result.caller !== expectedCaller)
          throw new Error(`fleet proxy caller mismatch: expected '${expectedCaller}', got '${result.caller}'`);
        console.log(`spawned ${result.lifetime} agent '${result.role}' through `
          + `${result.caller}'s fleet proxy (state: ${result.statePath})`);
        console.log(`  ${result.harness}/${result.session}`
          + `${result.model ? ` model=${result.model}` : ''}`
          + (result.permissionMode
            ? `; permission=${result.permissionMode.fleetMode} native=${result.permissionMode.nativeMode}`
            : '') + '; '
          + `monitor=${result.monitor.mode} interrupt=${result.monitor.interrupt}`);
        if (result.inherited.length)
          console.log(`  inherited omitted defaults from ${result.caller}: ${result.inherited.join(', ')}`);
        console.log(`→ watch it: ours-fleet peek ${result.role}   |   attach: ours-fleet attach ${result.role}`);
        return;
      }
      const created = await creation.createDirect(o);
      const plannedPermissionMode = effectivePermissionMode(created.plan.preview.resolvedRole);
      if (o.temp) {
        const dir = created.statePath;
        console.log(`spawned temp agent '${roleName}' (state: ${dir}; gone on exit/reboot)`);
      } else {
        const file = created.statePath;
        console.log(`spawned '${roleName}' (config: ${file})`);
      }
      // The same provenance that was persisted, so what the operator reads now
      // and what a reviewer reads later cannot disagree.
      if (lastProvenance) {
        console.log(`  created by ${lastProvenance.command} `
          + `v${lastProvenance.fleetVersion}+${lastProvenance.fleetBuild} `
          + `at ${lastProvenance.createdAt} (${lastProvenance.lifetime})`);
        for (const line of formatProvenance(lastProvenance)) console.log(line);
      }
      console.log(`  permission=${plannedPermissionMode.fleetMode} `
        + `native=${plannedPermissionMode.nativeMode}`);
      console.log(`→ watch it: ours-fleet peek ${roleName}   |   attach: ours-fleet attach ${roleName}`);
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
    if (!rep.ok) throw new FleetCliExit(1);
  });

cOpt(program.command('init').description('interactively add missing Fleet defaults while preserving existing configuration'))
  .action(async (opts: { configuration?: string }) => {
    const configuration = opts.configuration ?? defaultConfigPath();
    if (!isInteractiveTerminal(process.stdin, process.stdout))
      die('ours-fleet init requires an interactive terminal; no host setup ran and no configuration changed');
    try {
      const result = await executeInitWizard(
        new TerminalPrompter(process.stdin, process.stdout), configuration, {
          async hostSetup() {
            for (const d of [agentsRoot(), tmpRoot(), logsRoot()]) mkdirSync(d, { recursive: true });
            for (const message of await pickBackend().init(binPath)) console.log(message);
          },
          publish: publishSetup,
        },
      );
      if (!result) {
        console.log('Fleet setup cancelled. No host setup ran and no configuration changed.');
        return;
      }
      const prior = result.manifestExisted && result.rootExisted ? 'manifest and split configuration'
        : result.manifestExisted ? 'manifest only'
          : result.rootExisted ? 'split configuration only' : 'no previous targets';
      console.log(`${result.replacedExisting ? 'Preserved existing files and added missing defaults to' : 'Created'} Fleet setup: ${result.configPath} and ${result.splitRoot}`);
      console.log(`Previous targets: ${prior}.`);
      console.log(`Private recovery record: ${result.recoveryPath}`);
      console.log(INIT_COMPLETION_GUIDANCE);
    } catch (error) { die(error); }
  });

cOpt(program.command('migrate-agent-templates')
  .description('dry-run the exact legacy starter split; add --write to apply atomically')
  .option('--write', 'apply the reviewed migration and retain a private recovery backup'))
  .action((opts: { configuration?: string; write?: boolean }) => {
    try {
      const result = migrateLegacyStarterPresets(opts.configuration ?? defaultConfigPath(), { write: opts.write });
      console.log(result.write ? 'Applied legacy starter migration.' : 'Dry run only; no files were changed.');
      for (const move of result.moves) console.log(`Move ${move.from} -> ${move.to}`);
      for (const addition of result.additions) console.log(`Add ${addition}`);
      console.log(`Staging path: ${result.stagingPath}`);
      console.log(`Recovery backup: ${result.backupPath}`);
      if (!result.write) console.log('Re-run with --write to apply this exact migration class.');
    } catch (error) { die(error); }
  });

cOpt(program.command('migrate-role-defaults')
  .description('dry-run adoption of exact revision-3 role defaults; add --write to apply atomically')
  .option('--write', 'apply the reviewed migration and retain a private recovery backup'))
  .action((opts: { configuration?: string; write?: boolean }) => {
    try {
      const result = migratePackagedRoleDefaults(opts.configuration ?? defaultConfigPath(), { write: opts.write });
      console.log(result.write ? 'Applied packaged role-default migration.' : 'Dry run only; no files were changed.');
      for (const path of result.removals) console.log(`Remove ${path}`);
      for (const path of result.replacements) console.log(`Replace ${path}`);
      for (const path of result.additions) console.log(`Add ${path}`);
      for (const path of result.preserved) console.log(`Preserve customized ${path}`);
      console.log(`Staging path: ${result.stagingPath}`);
      console.log(`Recovery backup: ${result.backupPath}`);
      if (!result.write) console.log('Re-run with --write to adopt only these exact recognized defaults.');
    } catch (error) { die(error); }
  });

const webCommand = cOpt(program.command('web').description('start or open the secure localhost fleet web console'))
  .enablePositionalOptions()
  .option('--port <port>', 'loopback service port (default: 49271)', value => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid port');
    return port;
  })
  .option('--no-open', 'do not open a browser automatically')
  .option('--bind <address>', 'explicit listen address (default: 127.0.0.1)')
  .option('--public-origin <url>', 'browser origin served by an explicit reverse proxy')
  .option('--password-file <path>', 'configure password protection from an owner-readable file')
  .option('--no-password', 'intentionally configure an unprotected control panel')
  .option('--pairing', 'configure trusted-browser pairing mode')
  .action(async opts => {
    try {
      const accessNotice = configureWebAccess(opts);
      const manager = new WebServiceManager();
      for (const line of await manager.install(binPath, opts.port ?? 49_271, opts.configuration, {
        bind: opts.bind, publicOrigin: opts.publicOrigin,
      }))
        process.stdout.write(line + '\n');
      if (accessNotice) process.stdout.write(accessNotice + '\n');
      await manager.start();
      if (opts.open !== false) {
        await requestWebControlWhenReady('open');
        process.stdout.write('Control-panel authentication opened in the browser.\n');
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
  .option('--bind <address>', 'explicit listen address (default: 127.0.0.1)')
  .option('--public-origin <url>', 'browser origin served by an explicit reverse proxy')
  .option('--password-file <path>', 'configure password protection from an owner-readable file')
  .option('--no-password', 'intentionally configure an unprotected control panel')
  .option('--pairing', 'configure trusted-browser pairing mode')
  .action(async opts => {
    try {
      const accessNotice = configureWebAccess(opts);
      const consoleServer = await startWebConsole({
        configPath: opts.configuration, port: opts.port,
        open: opts.open !== false, binPath, bind: opts.bind, publicOrigin: opts.publicOrigin,
        log: line => process.stderr.write(line + '\n'),
      });
      if (accessNotice) process.stdout.write(accessNotice + '\n');
      process.stdout.write(`ours-fleet web listening on ${consoleServer.address}\n`);
      process.stdout.write(opts.open !== false
        ? 'Control-panel authentication opened in the browser.\n'
        : 'Run `ours-fleet web open` to authenticate a browser.\n');
      const shutdown = async () => { await consoleServer.close(); process.exit(0); };
      process.once('SIGINT', () => { void shutdown(); });
      process.once('SIGTERM', () => { void shutdown(); });
    } catch (e) { die(e); }
  });

webPort(webCommand.command('install').description('install or update the owner web service'))
  .option('--bind <address>', 'explicit listen address (default: 127.0.0.1)')
  .option('--public-origin <url>', 'browser origin served by an explicit reverse proxy')
  .option('--password-file <path>', 'configure password protection from an owner-readable file')
  .option('--no-password', 'intentionally configure an unprotected control panel')
  .option('--pairing', 'configure trusted-browser pairing mode')
  .action(async opts => {
    try {
      const accessNotice = configureWebAccess(opts);
      for (const line of await new WebServiceManager().install(
        binPath, opts.port ?? 49_271, opts.configuration,
        { bind: opts.bind, publicOrigin: opts.publicOrigin })) process.stdout.write(line + '\n');
      if (accessNotice) process.stdout.write(accessNotice + '\n');
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
      process.stdout.write('Control-panel authentication opened in the browser.\n');
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

function configureWebAccess(opts: {
  passwordFile?: string; password?: boolean; pairing?: boolean; publicOrigin?: string;
}): string | undefined {
  if (opts.publicOrigin) validatePublicOrigin(opts.publicOrigin);
  const noPassword = opts.password === false;
  const choices = [Boolean(opts.passwordFile), noPassword, Boolean(opts.pairing)].filter(Boolean).length;
  if (choices > 1) throw new Error('choose only one of --password-file, --no-password, or --pairing');
  const store = new WebAccessStore();
  if (opts.passwordFile) {
    const password = readFileSync(realpathSync(opts.passwordFile), 'utf8').replace(/[\r\n]+$/, '');
    store.write(passwordAccess(password));
    return 'Access mode: password protected (only a salted scrypt verifier is stored).';
  }
  if (noPassword) {
    store.write({ version: 1, mode: 'none' });
    return 'WARNING: unprotected mode enabled; anyone who can reach the configured origin can control the fleet.';
  }
  if (opts.pairing) {
    store.write({ version: 1, mode: 'pairing' });
    return 'Access mode: trusted-browser pairing.';
  }
  if (!existsSync(store.path)) throw new Error(
    'first web setup requires an explicit access choice: use --password-file <path> '
    + 'or --pairing for protection, or --no-password only for intentional unprotected access',
  );
  return undefined;
}

// ── rooms & tasks ──────────────────────────────────────────────────────────
registerTemplateCommands(program, cOpt);
registerTaskCommands(program, cOpt);
registerRoomCommands(program, cOpt);

program.command('_run <name>', { hidden: true }).description('internal: supervisor entrypoint')
  .option('-c, --configuration <file>')
  .action(async (name, opts) => {
    // The supervised loop, not a single session: restart policy lives here now,
    // where it can count across attempts.
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

async function parseFleetCli(): Promise<void> {
  const spawnIndex = process.argv.indexOf('spawn');
  if (spawnIndex >= 0 && process.argv.slice(spawnIndex + 1).some(arg =>
    arg === '--harness' || arg.startsWith('--harness=') || arg === '--model' || arg.startsWith('--model='))) {
    console.error('error: --harness and --model were removed; select a Brain with --brain');
    throw new FleetCliExit(1);
  }
  try { await program.parseAsync(process.argv); }
  catch (error) {
    const commander = error as { code?: string; exitCode?: number };
    if (commander.exitCode === 0) return;
    if (typeof commander.exitCode === 'number') throw new FleetCliExit(
      commander.exitCode, 'validation', 'not_started');
    throw error;
  }
}

async function runFleetCli(): Promise<void> {
  const stateDir = process.env[FLEET_PROXY_STATE_DIR_ENV];
  const caller = process.env[FLEET_PROXY_CALLER_ENV];
  if (!stateDir || !caller) { await parseFleetCli(); return; }
  const requestId = randomUUID();
  let attempt: FleetAuditAttempt;
  const begun = await controlRequest(stateDir, {
    command: 'fleet_audit_begin', audit: { requestId, argv: process.argv.slice(2) },
  });
  if (!begun.ok) throw new SessionControlError(begun.kind ?? 'rejected', begun.error ?? 'fleet command audit refused');
  attempt = begun.result as FleetAuditAttempt;
  if (attempt.caller !== caller)
    throw new SessionControlError('rejected', `fleet audit caller mismatch: expected '${caller}', got '${attempt.caller}'`);
  let exitCode = 0;
  let outcomeClass: FleetCommandOutcomeClass = 'success';
  let effect: 'not_started' | 'completed' | 'unknown' = 'completed';
  beginFleetAuditCollection();
  if (attempt.classification.decision !== 'allow') {
    exitCode = 1; outcomeClass = 'denied'; effect = 'not_started';
    console.error(`fleet supervisor proxy ${attempt.classification.decision}: ${attempt.classification.command}`);
  } else {
    const originalExit = process.exit;
    process.exit = ((code?: number) => { throw new FleetCliExit(code ?? 0); }) as never;
    try { await parseFleetCli(); }
    catch (error) {
      exitCode = error instanceof FleetCliExit ? error.exitCode : 1;
      outcomeClass = error instanceof FleetCliExit ? error.outcomeClass : 'runtime';
      effect = error instanceof FleetCliExit ? error.effect : 'unknown';
      if (!(error instanceof FleetCliExit)) console.error(error instanceof Error ? error.message : String(error));
    } finally { process.exit = originalExit; }
  }
  const metadata = consumeFleetAuditCollection();
  if (metadata.failure) {
    outcomeClass = metadata.failure.class; effect = metadata.failure.effect;
  }
  const finished = await controlRequest(stateDir, { command: 'fleet_audit_finish', audit: {
    correlationId: attempt.correlationId, class: outcomeClass, exitCode, effect,
    ...(metadata.resourceIds ? { resourceIds: metadata.resourceIds } : {}),
    ...(metadata.presentations ? { presentations: metadata.presentations } : {}),
  } });
  if (!finished.ok)
    throw new SessionControlError(finished.kind ?? 'backend', finished.error ?? `audit delivery failed after execution; effect status=${effect}`);
  process.exitCode = exitCode;
}

void runFleetCli().catch(error => {
  if (!(error instanceof FleetCliExit))
    console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof FleetCliExit ? error.exitCode : 1;
});
