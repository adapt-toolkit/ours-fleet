#!/usr/bin/env node
import { spawn as spawnChild } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { VERSION } from './version.js';
import { agentsRoot, tmpRoot, logsRoot, deriveXdgRuntimeDir } from './paths.js';
import { loadConfig } from './config.js';
import { Tmux } from './tmux.js';
import { pickBackend } from './supervisor/index.js';
import { up, down, restartRoles, rmRole, type OpsDeps } from './ops.js';
import { runOnce, runTemp } from './runner.js';
import { spawnPermanent, spawnTemp, type SpawnOpts } from './spawn.js';
import { doctor } from './doctor.js';
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
  .description('Fleet of persistent, identity-bound AI agents — harness-agnostic, tmux + systemd/launchd.')
  .version(VERSION);

const cOpt = (cmd: Command) => cmd.option('-c, --configuration <file>', 'config file (default: ~/fleet.yaml + ~/fleet.d/)');

const collect = (value: string, previous: string[]) => [...previous, value];

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
  .action(opts => {
    try {
      const cfg = loadConfig(opts.configuration);
      console.log(`config: ${cfg.files.join(' + ') || '(none)'}`);
      for (const r of cfg.roles) {
        console.log(`\n● ${r.name}`);
        console.log(`    harness:     ${r.harness}`);
        console.log(`    identity:    ${r.identity}`);
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

program.command('ls').description('list running tmux consoles')
  .action(async () => { console.log(await new Tmux().list() || '(none)'); });

program.command('attach <name>').description('open the live console (Ctrl-b d to leave)')
  .action(async name => process.exit(await passthrough('tmux', ['attach', '-t', name])));

program.command('peek <name> [lines]').description('pane snapshot without attaching')
  .action(async (name, lines) => {
    try { console.log(await new Tmux().capture(name, lines ? Number(lines) : 40)); }
    catch { die(`'${name}' is not running; try: ours-fleet status ${name}`); }
  });

program.command('send <name> [text...]').description("type into the agent's console")
  .option('--key <key>', 'send a raw key instead (Escape, Up, C-c, ...)')
  .action(async (name, text, opts) => {
    try {
      const tmux = new Tmux();
      if (opts.key) await tmux.sendKey(name, opts.key);
      else if (text?.length) await tmux.sendText(name, text.join(' '));
      else die('nothing to send: give text or --key');
    } catch { die(`'${name}' is not running; try: ours-fleet status ${name}`); }
  });

program.command('logs <name>').description('show the role log').option('-f, --follow', 'follow')
  .action(async (name, opts) => {
    const { cmd, args } = pickBackend().logsArgs(name, opts.follow === true);
    process.exit(await passthrough(cmd, args));
  });

program.command('status <name>').description('unit/agent state')
  .action(async name => { console.log(await pickBackend().status(name)); });

cOpt(program.command('rm <name>').description('stop + delete state dir (+ its fleet.d file if spawned)'))
  .action(async (name, opts) => {
    try { await rmRole(loadConfig(opts.configuration), name, deps()); } catch (e) { die(e); }
  });

cOpt(program.command('spawn <name>').description('spawn a new agent (permanent by default)'))
  .option('--temp', 'temporary: plain tmux, auto-cleaned, gone on reboot')
  .option('--harness <id>', 'harness adapter (default: defaults.harness)')
  .option('--mission <text>', 'one-line mission')
  .option('--identity <name>', 'ours identity to bind (default: role name)')
  .option('--cwd <dir>', 'working directory')
  .option('--coordinator <name>', 'announce target')
  .option('--model <id>', 'model id to launch on (e.g. claude-fable-5); default: launcher default')
  .option('--permission-mode <mode>', 'harness permission mode (Codex: untrusted|on-request|never; Claude: native values)')
  .option('--sandbox <mode>', 'Codex sandbox: read-only|workspace-write|danger-full-access')
  .option('--profile <name>', 'Codex profile file name ($CODEX_HOME/<name>.config.toml)')
  .option('--launcher <mode>', 'Codex launcher: auto|ours-codex|codex (default: auto)')
  .option('--search', 'enable Codex live web search')
  .option('--codex-config <key=value>', 'Codex config override (repeatable)', collect, [])
  .option('--add-dir <dir>', 'additional Codex writable directory (repeatable)', collect, [])
  .option('--monitor', 'explicitly consent to arm this Codex role\'s ours mail monitor')
  .option('--bio-file <file>', 'public bio (file)')
  .option('--persona-file <file>', 'persona / operating contract (file)')
  .action(async (name, opts) => {
    try {
      const o: SpawnOpts = {
        name, temp: opts.temp, harness: opts.harness, mission: opts.mission,
        identity: opts.identity, cwd: opts.cwd, coordinator: opts.coordinator,
        model: opts.model,
        permissionMode: opts.permissionMode, sandbox: opts.sandbox, profile: opts.profile,
        launcher: opts.launcher, search: opts.search,
        codexConfig: parseCodexConfig(opts.codexConfig), addDirs: opts.addDir, monitor: opts.monitor,
        bioFile: opts.bioFile, personaFile: opts.personaFile, configPath: opts.configuration,
      };
      if (o.temp) {
        const dir = await spawnTemp(o, binPath);
        console.log(`spawned temp agent '${name}' (state: ${dir}; gone on exit/reboot)`);
      } else {
        const file = await spawnPermanent(o, deps());
        console.log(`spawned '${name}' (config: ${file})`);
      }
      console.log(`→ watch it: ours-fleet peek ${name}   |   attach: ours-fleet attach ${name}`);
    } catch (e) { die(e); }
  });

cOpt(program.command('doctor').description('prerequisite report'))
  .option('--harness <id>', 'check one harness explicitly')
  .action(async opts => {
    const rep = await doctor({ harness: opts.harness, configPath: opts.configuration });
    for (const c of rep.checks) console.log(`${c.ok ? 'ok  ' : 'MISS'} ${c.name.padEnd(22)} ${c.detail}`);
    process.exit(rep.ok ? 0 : 1);
  });

program.command('init').description('one-time host setup (units, dirs, linger)')
  .action(async () => {
    for (const d of [agentsRoot(), tmpRoot(), logsRoot()]) mkdirSync(d, { recursive: true });
    for (const m of await pickBackend().init(binPath)) console.log(m);
    console.log('\nNext: copy examples/fleet.yaml to ~/fleet.yaml, edit, then: ours-fleet up');
  });

program.command('_run <name>', { hidden: true }).description('internal: supervisor entrypoint')
  .option('-c, --configuration <file>')
  .action(async (name, opts) => {
    try { await runOnce(name, { configPath: opts.configuration }); } catch (e) { die(e); }
  });

program.command('_run-temp <name>', { hidden: true }).description('internal: temp-agent entrypoint')
  .action(async name => {
    try { await runTemp(name); } catch (e) { die(e); }
  });

program.parseAsync(process.argv);
