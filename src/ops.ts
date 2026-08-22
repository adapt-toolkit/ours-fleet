import {
  chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { agentDir, fleetDDir, watchdogsRoot } from './paths.js';
import type { FleetConfig, ResolvedRole } from './config.js';
import { findRole } from './config.js';
import type { ResolvedWatchdog } from './watchdog/config.js';
import { getAdapter } from './harness/registry.js';
import { generateBriefing } from './briefing.js';
import { resetRestartLedger } from './runner.js';
import type { InstallOutcome as BackendInstallOutcome, SupervisorBackend } from './supervisor/types.js';
import {
  archiveTempState, stopTempSupervisor, tempSupervisorLiveness,
} from './temp-lifecycle.js';
import { realExec, type Exec } from './exec.js';
import {
  daemonIdentityProvisioner, reconcilePermanentRoleIdentities,
  type IdentityProvisioner,
} from './creation.js';

/** An install outcome tagged with the role it belongs to. */
export interface InstallOutcome extends BackendInstallOutcome { role: string }

export interface OpsDeps {
  backend: SupervisorBackend;
  binPath: string;
  log(line: string): void;
  /** Process/service inspection for exact temporary-supervisor lifecycle commands. */
  exec?: Exec;
  /** Test seam for exact detached-supervisor signaling/liveness. */
  kill?(pid: number, signal: NodeJS.Signals | 0): void;
  sleep?(ms: number): Promise<void>;
  /** Permanent identity reconciliation seam; temporary roles never use this lifecycle. */
  identityProvisioner?: IdentityProvisioner;
  /**
   * Called the INSTANT a registration is created, before anything else can
   * fail. A creation transaction that learns about registrations only from
   * `up()`'s return value learns nothing when `up()` throws — and the service
   * it just registered is then invisible to rollback (6.2). Optional: plain
   * `ours-fleet up` has no transaction to tell.
   */
  onInstalled?(outcome: InstallOutcome): void;
  /**
   * Optional: supervises the single watchdog-scheduler process (Task 10).
   * Absent for callers that predate watchdogs — `up`/`down` must never throw
   * just because this hook is missing.
   */
  watchdogService?: {
    /** `changed` is true when the unit/plist content itself differs from what's on disk (or was absent). */
    install(binPath: string, configPath?: string): Promise<{ changed: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Bounces an already-running scheduler so a config change actually reaches it — `start()` is a no-op on an active unit. */
    restart(): Promise<void>;
    supervised(): boolean;
  };
}

// Launch staggering now lives at the harness-launch point (the runner's start
// gate, driven by `start_stagger_ms`), so it covers systemd host-boot too — not
// just the `up`/`restart` command loop below. The old in-loop FLEET_START_STAGGER
// sleep is retired; `up`/`restart` fire installs promptly and the gate spaces the
// resulting launches.

/** Materialize a role's state dir from config: briefing + markers. Returns the dir. */
export function applyRole(
  role: ResolvedRole,
  opts: {
    fresh?: boolean; temp?: boolean; configPath?: string;
    identityGuarantee?: 'verified' | 'created' | 'unverified';
  } = {},
): string {
  const adapter = getAdapter(role.harness);
  const errs = adapter.validateOptions(role.harness_options);
  if (errs.length)
    throw new Error(`role '${role.name}': ` + errs.map(e => `${e.path}: ${e.message}`).join('; '));
  const dir = agentDir(role.name, opts.temp === true);
  mkdirSync(dir, { recursive: true });
  // systemd's shared unit template invokes `_run <name>` on every restart with no
  // -c (see supervisor/systemd.ts) — record which config this permanent role was
  // brought up from so the supervised process can reload the SAME file instead of
  // silently falling back to the default ~/fleet.yaml. Temp roles snapshot their
  // whole resolved role into role.yaml instead and don't need this.
  if (!opts.temp) writeFileSync(join(dir, '.config-path'), (opts.configPath ?? '') + '\n');
  writeFileSync(join(dir, '.identity'), role.identity + '\n');
  if (role.cwd) writeFileSync(join(dir, '.cwd'), role.cwd + '\n');
  if (!existsSync(join(dir, '.session-id'))) writeFileSync(join(dir, '.session-id'), randomUUID() + '\n');
  if (!existsSync(join(dir, 'WORKLOG.md'))) writeFileSync(join(dir, 'WORKLOG.md'), '');
  const briefingBody = role.briefing_file ? readFileSync(role.briefing_file, 'utf8') : undefined;
  writeFileSync(join(dir, 'briefing.md'), generateBriefing(role, adapter.vocabulary, {
    stateDir: dir, worklogPath: join(dir, 'WORKLOG.md'),
    routinesPath: join(dir, 'ROUTINES.md'), briefingBody,
    identityGuarantee: opts.identityGuarantee,
    temporaryIdentity: opts.temp === true,
  }));
  if (opts.fresh)
    for (const f of ['.booted', '.session-id', '.exit-status']) rmSync(join(dir, f), { force: true });
  return dir;
}

function selectRoles(cfg: FleetConfig, names: string[]): ResolvedRole[] {
  return names.length ? names.map(n => findRole(cfg, n)) : cfg.roles;
}

/** Create/start roles declaratively. Idempotent; active roles keep their context. */
export async function up(
  cfg: FleetConfig, names: string[], deps: OpsDeps, configPath?: string,
  identityGuarantee?: 'verified' | 'created' | 'unverified',
): Promise<InstallOutcome[]> {
  const outcomes: InstallOutcome[] = [];
  for (const role of selectRoles(cfg, names)) {
    const guarantee = await reconcilePermanentRoleIdentities(
      role, deps.identityProvisioner ?? daemonIdentityProvisioner(), deps.log, identityGuarantee);
    const dir = applyRole(role, { configPath, identityGuarantee: guarantee });
    // Only a *definite* stop boots fresh so the role reads the briefing we just
    // wrote. A running, restarting, or unprobeable role keeps its context —
    // guessing "stopped" from an unanswered probe silently discards a live
    // conversation.
    // An explicit operator `up` is the sanctioned way to release a held-down
    // role: the still-alive runner polls this file and resumes (3.2).
    resetRestartLedger(dir);
    const live = await deps.backend.liveness(role.name)
      .catch(e => ({ state: 'unknown' as const, detail: e instanceof Error ? e.message : String(e) }));
    if (live.state === 'stopped') rmSync(join(dir, '.booted'), { force: true });
    else if (live.state === 'unknown')
      deps.log(`  ! ${role.name}: liveness unknown, keeping session context — ${live.detail}`);
    // Report what each install actually did, so a creation transaction can undo
    // only the registrations IT made (6.2). Announced immediately as well as
    // returned: a later role in this same loop can throw, and the registrations
    // already made must still be undoable.
    const outcome = { ...await deps.backend.install(role.name, deps.binPath), role: role.name };
    if (outcome.created) deps.onInstalled?.(outcome);
    outcomes.push(outcome);
    deps.log(`↑ up: ${role.name} (harness: ${role.harness}, identity: ${role.identity}${role.cwd ? `, cwd: ${role.cwd}` : ''})`);
  }
  await reconcileWatchdogScheduler(cfg, deps, configPath);
  return outcomes;
}

const WATCHDOG_FINGERPRINT_FILE = '.config-fingerprint';

/** Deterministic JSON: object keys sorted recursively, so key-insertion order never affects the hash. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort()
        .reduce<Record<string, unknown>>((acc, k) => { acc[k] = (v as Record<string, unknown>)[k]; return acc; }, {});
    }
    return v;
  });
}

/** sha256 over the resolved enabled-watchdog set, stable regardless of config source order (finding #4). */
function watchdogFingerprint(enabled: ResolvedWatchdog[]): string {
  const sorted = [...enabled].sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(stableStringify(sorted)).digest('hex');
}

function fingerprintPath(): string {
  return join(watchdogsRoot(), WATCHDOG_FINGERPRINT_FILE);
}

function readStoredFingerprint(): string | undefined {
  try { return readFileSync(fingerprintPath(), 'utf8').trim(); } catch { return undefined; }
}

function writeFingerprint(fingerprint: string): void {
  mkdirSync(watchdogsRoot(), { recursive: true, mode: 0o700 });
  writeFileSync(fingerprintPath(), fingerprint + '\n', { mode: 0o600 });
  chmodSync(fingerprintPath(), 0o600);   // mkdirSync/writeFileSync's mode is masked by umask; force it
}

/**
 * Install/start (or stop) the single supervised watchdog-scheduler process
 * (Task 10) to match the config's enabled watchdogs. Runs on every `up`,
 * including a named `up <Role>` — cheap and idempotent, and the alternative
 * (only reconciling on a whole-fleet `up`) would leave a newly-enabled
 * watchdog unscheduled until the next bare `up`. Never throws: a scheduler
 * hiccup must not fail the role installs that already succeeded.
 *
 * Restarts ONLY when something the scheduler actually needs to pick up
 * changed (finding #4): an unconditional `restart()` on every `up` —
 * including a named `up <SomeUnrelatedRole>` — interrupted whatever the
 * scheduler was mid-run (a 15s stop timeout can kill a long check without a
 * report). Two independent signals decide: `svc.install()`'s own `changed`
 * (the unit/plist content — binPath/configPath — differs), and a config
 * fingerprint over the resolved enabled-watchdog set (sha256, stored at
 * `<watchdogsRoot>/.config-fingerprint`) — needed because interval/watch/etc.
 * never appear in the unit content itself (the unit just re-execs `-c
 * <configPath>`), so `install()` alone can never see them change. Either
 * signal true -> restart(); neither -> the idempotent start() (a no-op if
 * already active, otherwise brings up a stopped unit).
 */
async function reconcileWatchdogScheduler(cfg: FleetConfig, deps: OpsDeps, configPath?: string): Promise<void> {
  const svc = deps.watchdogService;
  if (!svc) return;
  const enabled = cfg.watchdogs.filter(w => w.enabled);
  try {
    // Check supervised() before any stop (final review #3): on an
    // unsupervised platform/config, the scheduler was never installed, so
    // stopping it is not just a no-op — on Linux, stop() throws for a unit
    // that was never loaded. A watchdog-less fleet must not see that
    // failure surface as a spurious "! watchdogs scheduler: ..." warning.
    if (!enabled.length) {
      if (svc.supervised()) await svc.stop();
      return;
    }
    if (!svc.supervised()) {
      deps.log("! watchdogs configured but OURS_FLEET_SUPERVISOR=none — run 'ours-fleet _run-watchdogs' in the foreground");
      return;
    }
    const { changed: unitChanged } = await svc.install(deps.binPath, configPath);
    const fingerprint = watchdogFingerprint(enabled);
    const fingerprintChanged = readStoredFingerprint() !== fingerprint;
    if (unitChanged || fingerprintChanged) {
      // restart(), not start(): start() is a no-op on an already-active unit,
      // so a config change (new/changed watchdogs) would never reach a
      // scheduler that's already running (final review #4).
      await svc.restart();
      deps.log(`↑ watchdogs scheduler (${enabled.map(w => w.name).join(', ')})`);
    } else {
      // Idempotent: a no-op on an already-active unit, but still brings up a
      // stopped one (e.g. the scheduler crashed and systemd gave up retrying).
      await svc.start();
    }
    writeFingerprint(fingerprint);
  } catch (e) {
    deps.log(`  ! watchdogs scheduler: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function down(cfg: FleetConfig, names: string[], deps: OpsDeps): Promise<void> {
  const roles = names.length ? names.map(name => cfg.roles.find(role => role.name === name)) : cfg.roles;
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    const requested = names[index];
    if (!role && requested && /^[A-Za-z0-9_-]+$/.test(requested)
        && existsSync(agentDir(requested, true))) {
      try {
        const outcome = await stopTempSupervisor(requested, { exec: deps.exec ?? realExec });
        deps.log(`■ ${outcome === 'stopped' ? 'stopping' : 'stopped'} temporary role ${requested}`);
      } catch (e) {
        deps.log(`  ! could not stop temporary role ${requested}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    if (!role) throw new Error(`no such role '${requested}'`);
    // Never swallow the backend's reason. "maybe not running" hid real stop
    // failures — a wedged unit, an unreachable user bus — behind a guess.
    try { await deps.backend.stop(role.name); deps.log(`■ stopped ${role.name}`); }
    catch (e) {
      deps.log(`  ! could not stop ${role.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Only a whole-fleet `down` (no names) stops the scheduler — stopping one
  // named role is not a decision to stop watching the others (tolerate
  // absence/errors: a never-installed scheduler must not fail `down`).
  // supervised() gates the call itself (final review #3): on an
  // unsupervised platform/config there is nothing installed to stop, and
  // Linux's stop() throws for a unit that was never loaded.
  if (names.length === 0 && deps.watchdogService?.supervised()) {
    try { await deps.watchdogService.stop(); }
    catch (e) {
      deps.log(`  ! could not stop watchdogs scheduler: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Re-sync from config + bounce. mode 'keep' resumes context; 'fresh' wipes it. */
export async function restartRoles(
  cfg: FleetConfig, names: string[], deps: OpsDeps, mode: 'keep' | 'fresh', configPath?: string,
): Promise<void> {
  for (const role of selectRoles(cfg, names)) {
    const guarantee = await reconcilePermanentRoleIdentities(
      role, deps.identityProvisioner ?? daemonIdentityProvisioner(), deps.log);
    const dir = applyRole(role, {
      fresh: mode === 'fresh', configPath, identityGuarantee: guarantee,
    });
    resetRestartLedger(dir);                    // explicit restart closes the circuit
    await deps.backend.restart(role.name);
    deps.log(mode === 'fresh'
      ? `↻ ${role.name} — force-restarted (FRESH — context cleared, briefing reloaded)`
      : `↻ ${role.name} — restarted (resumes; briefing re-synced)`);
  }
}

/** Stop + forget a role: unit, state dir, and its fleet.d file when spawned. */
export async function rmRole(cfg: FleetConfig, name: string, deps: OpsDeps): Promise<void> {
  const temporaryDir = /^[A-Za-z0-9_-]+$/.test(name) ? agentDir(name, true) : '';
  const configured = cfg.roles.find(role => role.name === name);
  if (!configured && temporaryDir && existsSync(temporaryDir)) {
    const lifecycleDeps = { exec: deps.exec ?? realExec, ...(deps.kill ? { kill: deps.kill } : {}) };
    const stopOutcome = await stopTempSupervisor(name, lifecycleDeps);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let liveness: Awaited<ReturnType<typeof tempSupervisorLiveness>> =
      stopOutcome === 'already-stopped' ? 'stopped' : 'unknown';
    // The supervisor normally archives itself. A detached fallback may keep
    // running after SIGTERM, so directory age or a fixed delay is never
    // cleanup authority: poll exact ownership and archive only after a proven
    // stop. Unknown and still-running both fail closed with evidence in place.
    for (let i = 0; i < 50 && existsSync(temporaryDir) && liveness !== 'stopped'; i++) {
      liveness = await tempSupervisorLiveness(temporaryDir, lifecycleDeps);
      if (liveness === 'stopped') break;
      if (i < 49) await sleep(100);
    }
    if (existsSync(temporaryDir) && liveness !== 'stopped')
      throw new Error(
        `temporary role '${name}' supervisor is ${liveness}; refusing to archive live or ambiguous state`);
    const archived = existsSync(temporaryDir)
      ? archiveTempState(name, 'operator-stop', 'retired',
          'operator removal completed after supervisor liveness was proven stopped; evidence preserved')
      : undefined;
    deps.log(`removed temporary role '${name}'`
      + `${archived ? `; evidence archived at ${archived}` : '; supervisor archived its evidence'}`);
    return;
  }
  const role = findRole(cfg, name);
  await deps.backend.uninstall(name);
  rmSync(agentDir(name), { recursive: true, force: true });
  if (role.sourceFile.startsWith(fleetDDir() + '/')) {
    unlinkSync(role.sourceFile);
    deps.log(`removed ${role.sourceFile}`);
  }
  deps.log(`removed '${name}' (its ours identity is left intact)`);
}
