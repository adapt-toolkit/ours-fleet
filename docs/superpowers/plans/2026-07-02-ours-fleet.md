# ours-fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@ours.network/fleet` — a TypeScript npm package (`ours-fleet` CLI) that runs a fleet of persistent, identity-bound agent sessions across harnesses (Claude Code v1), per the approved spec `docs/superpowers/specs/2026-07-02-ours-fleet-design.md`.

**Architecture:** Harness-neutral core (config merge, briefing generation, tmux runner, supervision) + typed `HarnessAdapter` per harness + `SupervisorBackend` per platform (systemd/launchd/none). Thin Claude Code plugin ships two skills (`spawn-ours-agent`, `oversee-agents`) that drive the CLI.

**Tech Stack:** Node ≥ 20, TypeScript (ESM/NodeNext), `yaml`, `commander`, `vitest`.

## Global Constraints

- Node engine floor: `>=20`. ESM only (`"type": "module"`, NodeNext resolution, `.js` import suffixes).
- The string `a2adapt` MUST NOT appear anywhere in the repo (code, docs, briefings).
- License: `FSL-1.1-Apache-2.0` (text already at `/tmp/fsl-license.txt`; copyright 2026 ours.network contributors).
- Package `@ours.network/fleet`, bin `ours-fleet`, repo `adapt-toolkit/ours-fleet`.
- Only runtime deps: `yaml`, `commander`. Tests: `vitest`. No bundler — plain `tsc`.
- All state under `~/.ours-fleet/`; config at `~/fleet.yaml` + `~/fleet.d/*.yaml`; `~` overridable via `OURS_FLEET_HOME` (tests rely on this).
- Role names: `[A-Za-z0-9_-]+`. Duplicate role across config files = hard error naming both files.
- TDD: every task = failing test → minimal impl → pass → commit.

---

### Task 1: Package scaffold

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `src/version.ts`, `test/version.test.ts`.

**Interfaces:** Produces the build/test toolchain every later task uses (`npm test`, `npm run build`).

- [ ] **Step 1: Write files**

`package.json`:
```json
{
  "name": "@ours.network/fleet",
  "version": "0.1.0",
  "description": "Harness-agnostic fleet of persistent, identity-bound AI agents. Declarative fleet.yaml, tmux consoles, systemd/launchd supervision, ours.network messaging.",
  "type": "module",
  "license": "FSL-1.1-Apache-2.0",
  "repository": { "type": "git", "url": "https://github.com/adapt-toolkit/ours-fleet.git" },
  "bin": { "ours-fleet": "dist/cli.js" },
  "main": "dist/index.js",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": { "commander": "^12.1.0", "yaml": "^2.5.0" },
  "devDependencies": { "@types/node": "^20.14.0", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "rootDir": "src", "declaration": true, "strict": true,
    "esModuleInterop": true, "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

`.gitignore`: `node_modules/`, `dist/`, `*.tgz`.
`LICENSE`: copy `/tmp/fsl-license.txt`, set Licensor/copyright line to "ours.network contributors" year 2026.

`src/version.ts`:
```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const VERSION: string = require('../package.json').version;
```

`test/version.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';
describe('version', () => { it('is semver', () => expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)); });
```

- [ ] **Step 2:** `npm install` then `npm test` → PASS; `npm run build` → clean.
- [ ] **Step 3:** Commit `chore: scaffold @ours.network/fleet package`.

---

### Task 2: Paths module

**Files:** Create `src/paths.ts`, `test/paths.test.ts`.

**Interfaces (Produces):**
```ts
home(): string                 // $OURS_FLEET_HOME or os.homedir()
stateRoot(): string            // <home>/.ours-fleet
agentsRoot(): string           // <stateRoot>/agents
tmpRoot(): string              // <stateRoot>/tmp
logsRoot(): string             // <stateRoot>/logs
agentDir(name: string, temp?: boolean): string
defaultConfigPath(): string    // <home>/fleet.yaml
fleetDDir(): string            // <home>/fleet.d
```

- [ ] **Step 1: Failing test** (`test/paths.test.ts`): with `process.env.OURS_FLEET_HOME = '/x'`, expect `stateRoot()==='/x/.ours-fleet'`, `agentDir('A')==='/x/.ours-fleet/agents/A'`, `agentDir('A', true)==='/x/.ours-fleet/tmp/A'`, `defaultConfigPath()==='/x/fleet.yaml'`, `fleetDDir()==='/x/fleet.d'`. Restore env in `afterEach`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3: Implement**
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
export const home = () => process.env.OURS_FLEET_HOME ?? homedir();
export const stateRoot = () => join(home(), '.ours-fleet');
export const agentsRoot = () => join(stateRoot(), 'agents');
export const tmpRoot = () => join(stateRoot(), 'tmp');
export const logsRoot = () => join(stateRoot(), 'logs');
export const agentDir = (name: string, temp = false) => join(temp ? tmpRoot() : agentsRoot(), name);
export const defaultConfigPath = () => join(home(), 'fleet.yaml');
export const fleetDDir = () => join(home(), 'fleet.d');
```
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat: state/config path resolution`.

---

### Task 3: Config loading & merge

**Files:** Create `src/config.ts`, `test/config.test.ts`.

**Interfaces (Produces):**
```ts
export interface OverseeEntry { role: string; interval: string }
export interface RoleConfig {
  harness?: string; identity?: string; cwd?: string; coordinator?: string;
  mission?: string; persona?: string; bio?: string; briefing_file?: string;
  max_tokens?: number; autocompact_pct?: number;
  env?: Record<string, string>; oversee?: OverseeEntry[];
  harness_options?: Record<string, unknown>;
}
export interface ResolvedRole extends RoleConfig {
  name: string; harness: string; identity: string; sourceFile: string;
}
export interface FleetConfig {
  roles: ResolvedRole[]; vars: Record<string, string>;
  defaults: Record<string, unknown>; files: string[];
}
export class ConfigError extends Error {}
export function loadConfig(configPath?: string): FleetConfig;
export function findRole(cfg: FleetConfig, name: string): ResolvedRole; // throws ConfigError
```

Behavior locked in: base file = `configPath ?? defaultConfigPath()` (missing default → empty base; missing explicit → error). `fleet.d/*.yaml` (sorted) ALWAYS merged; drop-ins may only contain `roles:` (else error). `${var}` substitution from base `vars:` applied to all string fields, recursively. `role.harness ?? defaults.harness ?? 'claude-code'`; `identity ?? name`; `max_tokens ?? defaults.max_tokens`. Name regex + duplicate detection (error names both files). Unknown role keys → `ConfigError` listing allowed keys.

- [ ] **Step 1: Failing tests** covering: merge of base+dropin; duplicate name error mentions both file paths; `${vars}` substitution in `cwd`/`persona`; defaults cascade for `harness`/`max_tokens`; identity defaults to name; bad name `foo bar` rejected; unknown key `persnoa` rejected with allowed-keys list; drop-in with `vars:` rejected; explicit missing `-c` path throws. Use `mkdtemp` + `OURS_FLEET_HOME`.
- [ ] **Step 2:** FAIL. **Step 3: Implement** (complete):
```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { defaultConfigPath, fleetDDir } from './paths.js';
// (interfaces as above)
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const ROLE_KEYS = ['harness','identity','cwd','coordinator','mission','persona','bio',
  'briefing_file','max_tokens','autocompact_pct','env','oversee','harness_options'];

function deepSub(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map(x => deepSub(x, vars));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(x, vars)]));
  return v;
}

export function loadConfig(configPath?: string): FleetConfig {
  const base = configPath ?? defaultConfigPath();
  const files: string[] = [];
  const docs: { file: string; doc: Record<string, unknown> }[] = [];
  if (existsSync(base)) { docs.push({ file: base, doc: (parse(readFileSync(base, 'utf8')) ?? {}) as any }); files.push(base); }
  else if (configPath) throw new ConfigError(`config not found: ${base}`);
  const dd = fleetDDir();
  if (existsSync(dd)) for (const f of readdirSync(dd).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort()) {
    const p = join(dd, f); const doc = (parse(readFileSync(p, 'utf8')) ?? {}) as any;
    const extra = Object.keys(doc).filter(k => k !== 'roles');
    if (extra.length) throw new ConfigError(`${p}: fleet.d files may only define roles: (found: ${extra.join(', ')})`);
    docs.push({ file: p, doc }); files.push(p);
  }
  const baseDoc = docs.length && docs[0].file === base ? docs[0].doc : {};
  const vars = (baseDoc.vars ?? {}) as Record<string, string>;
  const defaults = (baseDoc.defaults ?? {}) as Record<string, unknown>;
  const seen = new Map<string, string>(); const roles: ResolvedRole[] = [];
  for (const { file, doc } of docs) {
    for (const [name, raw] of Object.entries((doc.roles ?? {}) as Record<string, RoleConfig | null>)) {
      if (!NAME_RE.test(name)) throw new ConfigError(`${file}: invalid role name '${name}' (allowed: [A-Za-z0-9_-])`);
      if (seen.has(name)) throw new ConfigError(`role '${name}' defined in both ${seen.get(name)} and ${file}`);
      seen.set(name, file);
      const r = deepSub(raw ?? {}, vars) as RoleConfig;
      const bad = Object.keys(r).filter(k => !ROLE_KEYS.includes(k));
      if (bad.length) throw new ConfigError(`${file}: role '${name}' has unknown key(s) ${bad.join(', ')}; allowed: ${ROLE_KEYS.join(', ')}`);
      roles.push({ ...r, name, sourceFile: file,
        harness: r.harness ?? (defaults.harness as string) ?? 'claude-code',
        identity: r.identity ?? name,
        max_tokens: r.max_tokens ?? (defaults.max_tokens as number | undefined) });
    }
  }
  return { roles, vars, defaults, files };
}
export function findRole(cfg: FleetConfig, name: string): ResolvedRole {
  const r = cfg.roles.find(r => r.name === name);
  if (!r) throw new ConfigError(`no such role '${name}' in ${cfg.files.join(', ') || 'config'}`);
  return r;
}
```
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: fleet.yaml + fleet.d config loading and merge`.

---

### Task 4: Harness types + registry

**Files:** Create `src/harness/types.ts`, `src/harness/registry.ts`, `test/registry.test.ts`.

**Interfaces (Produces):**
```ts
// types.ts
import type { ResolvedRole } from '../config.js';
export interface PrereqCheck { name: string; ok: boolean; detail: string }
export interface PrereqReport { ok: boolean; checks: PrereqCheck[] }
export interface RoleDirs { stateDir: string; runCwd: string }
export interface SessionState { sessionId: string }
export interface SessionPrep { argv: string[]; env: Record<string, string> }
export interface Launch { argv: string[]; env: Record<string, string> }
export interface BriefingVocab {
  bindTool: string; createTool: string; setBioTool: string; setPersonaTool: string;
  currentIdentityTool: string; sendTool: string; getMessagesTool: string;
  watchCommand(identity: string): string;
  monitorInstruction(identity: string): string;
  launchNote(name: string): string;
  restartPrompt(identity: string, worklogPath: string): string;
}
export interface ExitPolicy { cleanExitIsFresh: boolean; fastFailSecs: number }
export interface ValidationError { path: string; message: string }
export interface HarnessAdapter {
  id: string; supportsResume: boolean;
  checkPrereqs(): Promise<PrereqReport>;
  validateOptions(opts: unknown): ValidationError[];
  prepareSession(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep>;
  buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume', s: SessionState, prep: SessionPrep): Launch;
  vocabulary: BriefingVocab;
  exitPolicy: ExitPolicy;
}
// registry.ts
export function registerAdapter(a: HarnessAdapter): void;
export function getAdapter(id: string): HarnessAdapter;   // throws listing known ids
export function knownAdapters(): string[];
```

- [ ] **Step 1: Failing test:** register a minimal fake adapter (`id:'fake'`), `getAdapter('fake')` returns it; `getAdapter('nope')` throws message containing `fake`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement registry with a module-level `Map`, error: `` `unknown harness 'x'; registered: ${[...map.keys()].join(', ')}` ``.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: HarnessAdapter interface and registry`.

---

### Task 5: Briefing generator

**Files:** Create `src/briefing.ts`, `test/briefing.test.ts`.

**Interfaces:** Consumes `ResolvedRole`, `BriefingVocab`. Produces:
```ts
export function generateBriefing(role: ResolvedRole, vocab: BriefingVocab,
  opts: { stateDir: string; worklogPath: string; briefingBody?: string }): string;
```
`briefingBody` (from `briefing_file`) replaces the narrative sections; the mechanical
"Do these NOW" boot steps, oversight, WORKLOG, restart, house-rules sections are ALWAYS appended (spec §11).

- [ ] **Step 1: Failing tests:** generated text contains: role name header; identity bind step with `vocab.bindTool` and identity quoted; mint-if-missing step with `createTool`; `set_bio`/`set_persona` reconcile steps (bio-verbatim variant when `bio` set, summary variant when not); monitor instruction from vocab; announce step iff `coordinator` set (with the "no coordinator" fallback otherwise); `## Oversight assignments` section listing `Alice` + `5m` + peek/send procedure iff `oversee` set; WORKLOG path; restart section containing `vocab.watchCommand(identity)`; house rules; when `briefingBody` given, body text present and template Charter absent; string `a2adapt` absent.
- [ ] **Step 2:** FAIL. **Step 3: Implement** — assemble a `string[]` of lines mirroring `run-role.sh:write_briefing` but ours-branded and vocab-driven:
```ts
// key structure (complete in code):
// # <name> — Role Briefing
// You are **<name>** (ours identity: **<identity>**), a persistent agent on this host.
// [cwd note] [## Charter <persona>] [## Bio <bio>] [## Mission <mission>]   <- or briefingBody instead
// ## Do these NOW, in order
// 1 launchNote; 2 bind (bindTool, force=true, mint with createTool if missing);
// 3 reconcile via currentIdentityTool; 4 setBioTool (verbatim|summary); 5 setPersonaTool;
// 6 monitorInstruction; 7 announce to coordinator via sendTool | owner-driven fallback;
// 8 await mail (getMessagesTool)
// [## Oversight assignments: per entry "- <role> — every <interval>"; procedure:
//   each tick run `ours-fleet peek <role>`, judge stuck/crashed/idle, resolve with
//   `ours-fleet send <role> ...`, escalate over ours messaging only if unsure]
// ## Durable log (worklogPath)
// ## On restart (re-bind, re-arm watchCommand, continue from WORKLOG)
// ## House rules (no broad rm -rf; declared stop states)
```
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: vocab-driven briefing generator`.

---

### Task 6: Exec + tmux wrappers

**Files:** Create `src/exec.ts`, `src/tmux.ts`, `test/tmux.test.ts`.

**Interfaces (Produces):**
```ts
// exec.ts
export interface ExecResult { stdout: string; stderr: string; code: number }
export type Exec = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;
export const realExec: Exec;                      // execFile, never rejects; ENOENT → code 127
export const shq: (s: string) => string;          // POSIX single-quote escape
// tmux.ts
export class Tmux {
  constructor(exec?: Exec);
  has(name): Promise<boolean>; newSession(name, cwd, shellCommand): Promise<void>;
  kill(name): Promise<void>; capture(name, lines?): Promise<string>;
  panePid(name): Promise<number | null>; list(): Promise<string>;
  sendText(name, text): Promise<void>;            // send-keys -l text, then Enter
  sendKey(name, key): Promise<void>;
}
```

- [ ] **Step 1: Failing tests** with a recording fake `Exec`: `newSession` issues `['new-session','-d','-s',N,'-c',CWD,CMD]`; `sendText('A','hi')` issues `-l` literal then `Enter`; `capture` slices last N lines; `panePid` parses first line int; `shq("a'b")` round-trips; failing `new-session` (code 1) throws with stderr included.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (realExec via `execFile` with 10 MB maxBuffer; numeric `err.code` else 127/1). All tmux methods `this.exec('tmux', [...])`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: exec + tmux wrappers`.

---

### Task 7: claude-code adapter

**Files:** Create `src/harness/claude-code.ts`, `test/claude-code.test.ts`.

**Interfaces:** Consumes Task 4 types; registers itself via `registerAdapter`. Exports `claudeCodeAdapter: HarnessAdapter` and (for tests) `pretrust(dir: string): void`, `autocompactPct(role): number`.

Locked behavior (spec §6.2): `harness_options` schema `{ plugins?: Record<string,boolean>; mem_palace?: boolean; mem_palace_midsession_autosave?: boolean }` (unknown keys → ValidationError). `autocompactPct` = `role.autocompact_pct` else `round(max_tokens/1_000_000*100)` clamped 1–100, else 50. `prepareSession`: pretrust `stateDir` + `runCwd` into `<home>/.claude.json` (`hasTrustDialogAccepted`, `hasCompletedProjectOnboarding`, `projectOnboardingSeenCount≥1`); overlay `<stateDir>/.settings-overlay.json` `{"enabledPlugins":{…}}` from `plugins` + `mem_palace:false → "mempalace@mempalace": false` (no keys → no file, no argv); env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MEMPALACE_HOOKS_AUTO_SAVE=false`, `MEMPALACE_MIDSESSION_AUTOSAVE`, `MEMPALACE_DISABLED=true` iff mem_palace false. `buildLaunch`: fresh → `['claude',...prep.argv,'--remote-control',name,'--session-id',sid,'Read and follow <stateDir>/briefing.md now.']`; resume → `--resume sid` + `vocabulary.restartPrompt(identity, worklog)`. `exitPolicy {cleanExitIsFresh:true, fastFailSecs:20}`; `supportsResume:true`. `checkPrereqs`: `claude --version` (ok+version | missing). Vocabulary: tools `choose_identity/create_identity/set_bio/set_persona/current_identity/send_message/get_messages`; `watchCommand = ours-mcp watch "<id>"`; restartPrompt = `Session restarted. Re-bind your ours identity now (choose_identity name "<id>" force=true), re-arm your monitor (ours-mcp watch "<id>"), then continue from <worklog>. Do not re-run whatever crashed you.`

- [ ] **Step 1: Failing tests:** pct derivation (500000→50, autocompact_pct wins, clamp, default 50); pretrust JSON written/merged without clobbering other projects; overlay written only when needed and argv gains `--settings <path>`; env matrix incl. `MEMPALACE_DISABLED`; fresh/resume argv exact; validateOptions rejects `{plugin: {}}` typo; restartPrompt contains no `a2adapt`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement per above (fs + JSON merge; `home()` from paths).
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: claude-code harness adapter`.

---

### Task 8: Supervisor backends

**Files:** Create `src/supervisor/types.ts`, `systemd.ts`, `launchd.ts`, `none.ts`, `index.ts`; `test/supervisor.test.ts`.

**Interfaces (Produces):**
```ts
export interface SupervisorBackend {
  id: 'systemd' | 'launchd' | 'none';
  init(binPath: string): Promise<string[]>;              // messages; writes template/dirs, linger
  install(name: string, binPath: string): Promise<void>; // enable --now / bootstrap plist
  start(name): Promise<void>; stop(name): Promise<void>; restart(name): Promise<void>;
  status(name): Promise<string>; uninstall(name): Promise<void>;
  logsArgs(name, follow: boolean): { cmd: string; args: string[] };  // exec'd by CLI with stdio inherit
}
export function pickBackend(exec?: Exec, platform?: NodeJS.Platform): SupervisorBackend; // darwin→launchd, linux→systemd; OURS_FLEET_SUPERVISOR=none override
```
systemd: unit `ours-fleet-agent@.service` in `~/.config/systemd/user/` with `ExecStart=<binPath> _run %i`, `Restart=always`, `RestartSec=2`, `TimeoutStopSec=15`, `WantedBy=default.target`; `init` also `daemon-reload` + `loginctl enable-linger $USER` (failure → warning message, not error). Unit name for role N: `ours-fleet-agent@N.service`.
launchd: label `network.ours.fleet.<name>`, plist in `~/Library/LaunchAgents/` (ProgramArguments `[binPath,'_run',name]`, KeepAlive, RunAtLoad, StandardOut/ErrorPath `logsRoot()/<name>.log`); install = write plist + `launchctl bootstrap gui/<uid> <plist>`; stop = `launchctl bootout gui/<uid>/<label>`; start = bootstrap; restart = `launchctl kickstart -k gui/<uid>/<label>`; status = `launchctl print` first 5 lines; logs = `tail -f`.
none: tmux-only (start = error "temp/none roles are started by spawn"; stop = `tmux kill-session`; status = has-session).

- [ ] **Step 1: Failing tests** (recording fake Exec, `OURS_FLEET_HOME` tmp): systemd `install('A', '/u/l/b/ours-fleet')` → `systemctl --user enable --now ours-fleet-agent@A.service`; `init` writes unit file containing `ExecStart=/u/l/b/ours-fleet _run %i` and calls daemon-reload; launchd `install` writes plist containing label + binPath and calls bootstrap with `gui/<uid>`; `pickBackend(undefined,'darwin').id==='launchd'`, `'linux'`→systemd, env override→none.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: systemd/launchd/none supervision backends`.

---

### Task 9: Runner (session loop)

**Files:** Create `src/runner.ts`, `test/runner.test.ts`.

**Interfaces (Produces):**
```ts
export interface RunnerDeps { tmux: Tmux; isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>; now(): number; log(line: string): void }
export function buildPaneCommand(launch: Launch, roleEnv: Record<string,string>|undefined,
  exitStatusPath: string): string;   // env K=V… argv… ; echo $? > exit-status  (shq-escaped)
export async function runOnce(name: string, opts: { temp?: boolean; configPath?: string },
  deps?: Partial<RunnerDeps>): Promise<void>;
export async function runTemp(name: string): Promise<void>; // runOnce(temp) then rm -rf tmp dir
```
`runOnce` flow (exactly `_run.sh` generalized): resolve role — permanent: `findRole(loadConfig(configPath), name)`; temp: read `<tmpdir>/role.yaml` (written by spawn). Ensure `.session-id` (crypto.randomUUID), read `.booted`; `mode = booted && adapter.supportsResume ? 'resume' : 'fresh'`; on fresh, touch `.booted`. `prepareSession` → `buildLaunch` → pane command via `buildPaneCommand` (merged env: prep.env + launch.env + role.env; PATH passthrough) → `tmux.kill` stale → `tmux.newSession(name, runCwd, cmd)` → poll `panePid` (40 × 250 ms) → wait `isAlive` loop (2 s) → read `.exit-status`; apply `adapter.exitPolicy`: code 0 && cleanExitIsFresh → rotate sid + rm `.booted`; resume && elapsed < fastFailSecs → rotate + rm `.booted` (self-heal); else keep (crash → resume next).

- [ ] **Step 1: Failing tests** with fake tmux/isAlive/sleep/now and a fake registered adapter (`id:'fake'`, `supportsResume:true`, canned launch): fresh boot creates `.booted` + `.session-id` and pane cmd contains `--session-id`-equivalent fake args + `; echo $? >`; clean exit (write `.exit-status`=0 before liveness ends) rotates sid and clears `.booted`; fast-failing resume (elapsed 5 s < 20) rotates; slow crash keeps `.booted`; `buildPaneCommand` escapes spaces/quotes via `shq`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: generic supervised session runner`.

---

### Task 10: Lifecycle ops (up/down/restart/rm/apply)

**Files:** Create `src/ops.ts`, `test/ops.test.ts`.

**Interfaces (Produces):**
```ts
export interface OpsDeps { backend: SupervisorBackend; binPath: string;
  sleep(ms: number): Promise<void>; log(line: string): void }
export function applyRole(role: ResolvedRole, opts: { fresh?: boolean; temp?: boolean }): string;
  // mkdir state dir; write .identity/.cwd; ensure .session-id + WORKLOG.md;
  // regenerate briefing.md (uses adapter vocabulary; briefing_file read+embedded);
  // fresh → rm .booted/.session-id/.exit-status; returns stateDir
export async function up(cfg: FleetConfig, names: string[], deps: OpsDeps): Promise<void>;
  // per role (stagger FLEET_START_STAGGER, default 5s): applyRole; if unit inactive rm .booted;
  // backend.install(name, binPath)
export async function down(cfg, names, deps): Promise<void>;
export async function restartRoles(cfg, names, deps, mode: 'keep'|'fresh'): Promise<void>;
export async function rmRole(cfg, name, deps): Promise<void>;
  // backend.uninstall; rm -rf agentDir; if role.sourceFile under fleet.d → unlink it
```

- [ ] **Step 1: Failing tests** (fake backend recording calls, fake adapter, tmp home): `applyRole` writes briefing/identity/worklog and preserves existing `.session-id` on keep, clears on fresh; `up` staggers (fake sleep records) and calls `install` per role; `rmRole` deletes the fleet.d file for a spawned role but NOT `~/fleet.yaml` for a base role; `down` stops each.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: declarative lifecycle operations`.

---

### Task 11: Spawn + doctor

**Files:** Create `src/spawn.ts`, `src/doctor.ts`, `test/spawn.test.ts`, `test/doctor.test.ts`.

**Interfaces (Produces):**
```ts
// spawn.ts
export interface SpawnOpts { name: string; temp?: boolean; harness?: string; mission?: string;
  identity?: string; cwd?: string; coordinator?: string; bioFile?: string; personaFile?: string;
  overseeInterval?: string }
export function writeSpawnRoleFile(o: SpawnOpts): string;      // → ~/fleet.d/<Name>.yaml (yaml.stringify)
export async function spawnPermanent(o: SpawnOpts, deps: OpsDeps): Promise<void>; // clash-check → write → up
export async function spawnTemp(o: SpawnOpts, tmux: Tmux, binPath: string): Promise<void>;
  // build ResolvedRole in-memory; mkdir tmp dir; write role.yaml snapshot + briefing + WORKLOG;
  // tmux.newSession(name, tmpdir, `<binPath> _run-temp <name>`)
// doctor.ts
export async function doctor(opts: { harness?: string; configPath?: string }, exec: Exec):
  Promise<PrereqReport>;  // node>=20, tmux -V, ours-mcp --version + `ours-mcp status`,
                          // adapter.checkPrereqs per harness used in config (or --harness),
                          // linux: loginctl linger; darwin: LaunchAgents dir writable
```

- [ ] **Step 1: Failing tests:** `writeSpawnRoleFile` output parses back to a role with mission/bio/persona read from files; `spawnPermanent` refuses an existing role name before writing anything; `spawnTemp` writes `role.yaml` + briefing in `tmp/<name>` and launches tmux with `_run-temp`; `doctor` with fake exec reports missing tmux as `ok:false` with install hint, daemon-down `ours-mcp status` (code 1) as failure.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: spawn (permanent + temp) and doctor`.

---

### Task 12: CLI + example config

**Files:** Create `src/cli.ts`, `src/index.ts` (re-exports), `examples/fleet.yaml`, `test/cli.test.ts`.

**Interfaces:** Consumes everything prior. Commander program `ours-fleet` wiring (spec §5): `up|down|restart|force-restart [-c] [names…]`, `config [-c]` (merged plan print incl. per-role source file + harness), `ls`, `attach <n>` (execvp tmux attach), `peek <n> [lines]`, `send <n> [text…] [--key K]`, `logs <n> [-f]`, `status <n>`, `spawn` (flags per SpawnOpts + interactive TTY prompts for missing name/kind), `rm <n>`, `doctor [--harness]`, `init`, hidden `_run <n>` / `_run-temp <n>`. `binPath` self-resolution: `process.argv[1]`. `init` = `backend.init(binPath)` + create state dirs + print next steps.

`examples/fleet.yaml`: the §7 schema example verbatim (coordinator + Alice with oversee, env, harness_options), commented.

- [ ] **Step 1: Failing test:** build then run `node dist/cli.js config -c examples/fleet.yaml` (with `OURS_FLEET_HOME` tmp) via `realExec` — exit 0, stdout lists both roles with `harness: claude-code` and source file; `node dist/cli.js doctor` exits 0/1 without crashing; `--help` lists `spawn` and `send`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement `cli.ts`. **Step 4:** PASS (runs `npm run build` first). **Step 5:** Commit `feat: ours-fleet CLI`.

---

### Task 13: Claude Code integration plugin (skills)

**Files:** Create `integrations/claude-code/.claude-plugin/plugin.json`, `integrations/claude-code/skills/spawn-ours-agent/SKILL.md`, `integrations/claude-code/skills/oversee-agents/SKILL.md`.

**Interfaces:** None consumed by core. `plugin.json`: `{ "name": "ours-fleet", "description": "Spawn and oversee ours-fleet agents from inside Claude Code", "version": "0.1.0" }`.

- [ ] **Step 1: Write `spawn-ours-agent/SKILL.md`** — frontmatter (name, description with trigger phrases "spawn ours agent", "spawn an agent", "create a fleet agent"); body: the §9.3 procedure — (1) ask temporary vs permanent; (2) co-draft bio (public card) + persona (operating contract) with the requester, iterating until approved; (3) write both to temp files; (4) run `ours-fleet spawn [--temp] <Name> --bio-file <f> --persona-file <f> [--mission …] [--harness …] [--coordinator <own role name if permanent>]`; (5) verify with `ours-fleet status/peek`; (6) invoke the oversee-agents skill for the new agent (ask interval, default 5m). Include exact command examples and the name-charset rule.
- [ ] **Step 2: Write `oversee-agents/SKILL.md`** — frontmatter (triggers: "keep an eye on", "oversee agents", "watch agents"); body: the §10 loop — parse assignment (from request, persona text, or briefing "Oversight assignments"); every N minutes (harness scheduling: background monitor/scheduled wake-up) run `ours-fleet peek <Name>` per ward; judgment table (stuck on prompt/menu/trust dialog → answer via `ours-fleet send <Name> "text"` or `--key`; crashed to shell → report + `ours-fleet restart <Name>` suggestion; idle with work → nudge; healthy → nothing); escalate over ours messaging (`send_message`) when unsure; log actions to WORKLOG.
- [ ] **Step 3:** Validate: `claude plugin validate integrations/claude-code` → OK.
- [ ] **Step 4:** Commit `feat: claude-code integration plugin (spawn + oversee skills)`.

---

### Task 14: README, docs, release smoke

**Files:** Create `README.md`; Modify `docs/` (link spec); Create `.github/workflows/ci.yml` (optional if time allows: node 20/22 matrix, `npm ci && npm run build && npm test`).

- [ ] **Step 1: Write README.md** with sections, in order: (1) **What is this?** — plain-language explanation: a fleet manager for persistent AI agents; what a role is (identity-bound, tmux console, supervised, resumes); why (always-on agents that message each other over ours.network, survive reboots, spawn and oversee subagents); harness-agnostic pitch + supported harnesses table (claude-code ✅, others "planned"); (2) **How it works** — 10-line architecture sketch (fleet.yaml → adapters → tmux + systemd/launchd), diagram of one role's lifecycle; (3) **Prerequisites** — table per OS: node ≥20, tmux (`apt install tmux` / `brew install tmux`), harness CLI logged in, `ours-mcp` daemon (`npm i -g @ours.network/mcp && ours-mcp start`, root identity); (4) **Install** — `npm i -g @ours.network/fleet && ours-fleet init && ours-fleet doctor`; (5) **Quickstart** — copy `examples/fleet.yaml` to `~/fleet.yaml`, edit, `ours-fleet up`, `ls/attach/peek`; (6) **Spawning agents** (CLI + from-inside-Claude-Code via the plugin, temp vs permanent); (7) **Oversight** (peek/send + the skill); (8) **Command reference** (the §5 table); (9) **fleet.yaml reference** (§7 fields, defaults, fleet.d semantics); (10) **macOS notes** (login-not-boot, logs location); (11) **License** (FSL-1.1-Apache-2.0 blurb + donate link like the marketplace README).
- [ ] **Step 2: Full check:** `npm run build && npm test` all green; `grep -ri a2adapt . --exclude-dir=node_modules --exclude-dir=.git` → empty; `npm pack --dry-run` lists dist/README/LICENSE only.
- [ ] **Step 3:** Commit `docs: README (what/why/install/quickstart) + CI`.

---

## Self-review notes

- Spec coverage: §2→T1/T13, §3→T1–12 layout, §4→T2/T3, §5→T12, §6→T4/T7, §7→T3/T12, §8→T8, §9→T11/T13, §10→T5/T6(send)/T13, §11→T5, §12→T14/T11(doctor), §13→T3/T4/T10 errors, §14→per-task tests, §15→T1 LICENSE. Gaps: none found.
- Type consistency: `SessionPrep` threaded into `buildLaunch` (T4 sig includes `prep` — matches T7/T9 usage). `OpsDeps.binPath` used by T8 `install`/T10/T11. `agentDir(name, temp)` consistent T2/T9/T11.
