import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDir, fleetDDir } from './paths.js';
import type { FleetConfig, ResolvedRole } from './config.js';
import { findRole } from './config.js';
import { getAdapter } from './harness/registry.js';
import { generateBriefing } from './briefing.js';
import type { SupervisorBackend } from './supervisor/types.js';

export interface OpsDeps {
  backend: SupervisorBackend;
  binPath: string;
  log(line: string): void;
}

// Launch staggering now lives at the harness-launch point (the runner's start
// gate, driven by `start_stagger_ms`), so it covers systemd host-boot too — not
// just the `up`/`restart` command loop below. The old in-loop FLEET_START_STAGGER
// sleep is retired; `up`/`restart` fire installs promptly and the gate spaces the
// resulting launches.

/** Materialize a role's state dir from config: briefing + markers. Returns the dir. */
export function applyRole(
  role: ResolvedRole, opts: { fresh?: boolean; temp?: boolean; configPath?: string } = {},
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
): Promise<void> {
  for (const role of selectRoles(cfg, names)) {
    const dir = applyRole(role, { configPath });
    // If the role isn't running, boot fresh so it reads the briefing we just wrote.
    const status = await deps.backend.status(role.name).catch(() => '');
    if (!/running|active \(/.test(status)) rmSync(join(dir, '.booted'), { force: true });
    await deps.backend.install(role.name, deps.binPath);
    deps.log(`↑ up: ${role.name} (harness: ${role.harness}, identity: ${role.identity}${role.cwd ? `, cwd: ${role.cwd}` : ''})`);
  }
}

export async function down(cfg: FleetConfig, names: string[], deps: OpsDeps): Promise<void> {
  for (const role of selectRoles(cfg, names)) {
    try { await deps.backend.stop(role.name); deps.log(`■ stopped ${role.name}`); }
    catch { deps.log(`  (could not stop ${role.name} — maybe not running)`); }
  }
}

/** Re-sync from config + bounce. mode 'keep' resumes context; 'fresh' wipes it. */
export async function restartRoles(
  cfg: FleetConfig, names: string[], deps: OpsDeps, mode: 'keep' | 'fresh', configPath?: string,
): Promise<void> {
  for (const role of selectRoles(cfg, names)) {
    applyRole(role, { fresh: mode === 'fresh', configPath });
    await deps.backend.restart(role.name);
    deps.log(mode === 'fresh'
      ? `↻ ${role.name} — force-restarted (FRESH — context cleared, briefing reloaded)`
      : `↻ ${role.name} — restarted (resumes; briefing re-synced)`);
  }
}

/** Stop + forget a role: unit, state dir, and its fleet.d file when spawned. */
export async function rmRole(cfg: FleetConfig, name: string, deps: OpsDeps): Promise<void> {
  const role = findRole(cfg, name);
  await deps.backend.uninstall(name);
  rmSync(agentDir(name), { recursive: true, force: true });
  if (role.sourceFile.startsWith(fleetDDir() + '/')) {
    unlinkSync(role.sourceFile);
    deps.log(`removed ${role.sourceFile}`);
  }
  deps.log(`removed '${name}' (its ours identity is left intact)`);
}
