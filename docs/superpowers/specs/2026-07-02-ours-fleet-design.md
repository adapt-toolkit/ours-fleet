# ours-fleet — harness-agnostic fleet of persistent agents

**Date:** 2026-07-02
**Status:** approved design, pre-implementation
**Repo:** `ours-fleet` (new; successor to `a2adapt-fleet` after the a2adapt → ours.network rebrand)

## 1. Purpose

Run a fleet of long-lived, identity-bound agent sessions ("roles") on a host, where
**each role can run in a different agent harness** (Claude Code first; Codex CLI,
Gemini CLI, OpenCode, … later). A role:

- binds an ours.network identity (message it by name over `ours-mcp`),
- lives in a detached tmux console,
- is supervised (auto-restart, survives reboot) by the platform's service manager,
- resumes context across restarts when the harness supports it.

The core is **harness-neutral**; each harness is a thin, typed adapter ("how to run,
which arguments, how to configure"). The core is also **platform-portable**: Linux
(systemd --user) and macOS (launchd LaunchAgent).

Non-goals (v1): cross-user management (`-u` is gone — each user manages their own
fleet), Windows, declarative harness profiles, adapter plugins as separate npm
packages (documented as the graduation path, §6.4).

## 2. Packaging & distribution

- **Core:** npm package **`@ours.network/fleet`**, TypeScript/Node, bin **`ours-fleet`**.
  Matches the ours ecosystem (`@ours.network/mcp`, `@ours.network/tg-connector`).
- **Per-harness integration shims** live in the same repo under `integrations/` and are
  deliberately thin — they contain no fleet logic, only teach the *agent inside a
  harness* to drive the CLI:
  - `integrations/claude-code/` — a Claude Code plugin (listed in
    `ours-claude-marketplace`) carrying two skills: `spawn-ours-agent` and
    `oversee-agents`.
  - future: `integrations/codex/` (AGENTS.md snippet), etc.
- The runtime is **never copied into user dirs** (unlike a2adapt-fleet's
  `~/agents/_run.sh`). Service units exec `ours-fleet _run <Name>`; upgrading =
  `npm i -g @ours.network/fleet` + restart roles.

## 3. Repo layout

```
ours-fleet/
├─ package.json                  @ours.network/fleet → bin: ours-fleet
├─ src/
│  ├─ cli.ts                     command dispatch
│  ├─ config.ts                  fleet.yaml + fleet.d/ merge, ${vars}, defaults, validation
│  ├─ briefing.ts                role → briefing.md (uses adapter vocabulary)
│  ├─ runner.ts                  generic session loop (markers → tmux → wait → exit policy)
│  ├─ spawn.ts                   temp + permanent spawn
│  ├─ doctor.ts                  prereq checks
│  ├─ harness/
│  │  ├─ types.ts                HarnessAdapter, BriefingVocab, ExitPolicy, PrereqReport
│  │  ├─ registry.ts             id → adapter
│  │  └─ claude-code.ts          v1 adapter
│  └─ supervisor/
│     ├─ types.ts                SupervisorBackend
│     ├─ systemd.ts              Linux: --user units + linger
│     ├─ launchd.ts              macOS: LaunchAgent, KeepAlive
│     └─ none.ts                 plain tmux (temp agents, CI tests)
├─ integrations/
│  └─ claude-code/               thin plugin: skills spawn-ours-agent, oversee-agents
├─ examples/fleet.yaml
├─ docs/   README.md   LICENSE
```

## 4. On-disk layout (per user)

```
~/fleet.yaml                 hand-written config — never machine-edited
~/fleet.d/<Name>.yaml        machine-written spawned roles (one file per role)
~/.ours-fleet/
  agents/<Name>/             briefing.md, WORKLOG.md, .session-id, .booted,
                             .identity, .cwd, .exit-status, harness overlay files
  tmp/<Name>/                temp agents — auto-removed when the session exits
  logs/<Name>.log            macOS session logs (Linux uses journald)
```

Config merge order: `fleet.yaml` ← `fleet.d/*.yaml`. A role name appearing twice is a
**hard error**. `ours-fleet config` prints the merged plan with each role's source file.

Identities and roles are **decoupled**: a role binds whatever `identity:` names
(default: the role name). Identities persist in the ours store independently of role
lifecycle — a dead temp agent's identity simply remains, harmlessly. There is no
identity ledger and no `gc` command by design.

## 5. Command surface

```
ours-fleet up [-c FILE] [Name...]         create/start roles (idempotent; staggered boots)
ours-fleet down [-c FILE] [Name...]       stop roles
ours-fleet restart [Name | -c [FILE]]     re-sync config + bounce, RESUMING context
ours-fleet force-restart [Name | -c]      re-sync + bounce FRESH (context wiped)
ours-fleet config [-c FILE]               validate + print merged plan (no side effects)
ours-fleet ls                             list running consoles
ours-fleet attach <Name>                  live console (Ctrl-b d to leave)
ours-fleet peek <Name> [lines]            pane snapshot without attaching
ours-fleet send <Name> "text"             type into the agent's pane (+ Enter)
ours-fleet send <Name> --key <K>          raw key: Escape, Up, C-c, "1", …
ours-fleet logs <Name> [-f]               journald (Linux) / log file (macOS)
ours-fleet status <Name>                  unit/agent state, restart count
ours-fleet spawn [--temp] <Name> [opts]   see §9
ours-fleet rm <Name>                      stop + delete state dir + its fleet.d file
ours-fleet doctor [--harness H]           prereq report
ours-fleet init                           one-time host setup (replaces install.sh)
ours-fleet _run <Name>                    internal: service entrypoint
ours-fleet _run-temp <Name>               internal: temp-agent tmux entrypoint
```

Design deltas vs a2adapt-fleet:

- **No `-u USER`.** Each user self-manages. To host roles under another account,
  become that account (`sudo -iu fleet`) and run `ours-fleet` there. All
  `asf()`/`fctl()` sudo plumbing is deleted.
- **No special coordinator.** `FleetCoordinator` was a dedicated service with a
  curated dir; now a coordinator is just a role. Curated briefings use
  `briefing_file:`. Any role may be named in another role's `coordinator:`.
- `new` is replaced by `spawn` (permanent form writes config; §9).

## 6. Harness abstraction

### 6.1 Adapter interface

```ts
interface HarnessAdapter {
  id: string;                        // "claude-code"
  supportsResume: boolean;           // false → every restart is fresh (logged)
  checkPrereqs(): Promise<PrereqReport>;          // binary present, version, logged in
  validateOptions(opts: unknown): ValidationError[];  // role harness_options schema
  prepareSession(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep>;
      // pre-trust, settings overlays, MCP wiring; returns extra argv/env
  buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume',
              s: SessionState): { argv: string[]; env: Record<string, string> };
  vocabulary: BriefingVocab;         // harness-correct briefing content:
      // tool names (bind/create identity, set_bio/set_persona, send/get messages),
      // the watch command (`ours-mcp watch "<Identity>"`), how to arm a persistent
      // monitor in THIS harness, restart-recovery phrasing
  exitPolicy: ExitPolicy;            // { cleanExitIsFresh: true, fastFailSecs: 20 }
}
```

`runner.ts` owns everything generic: marker files (`.booted`, `.session-id`),
`tmux new-session`, wait-on-pid, and exit interpretation *via* `exitPolicy`
(clean exit → rotate session-id, next boot fresh; resume dying < `fastFailSecs` →
self-heal to fresh; else crash → resume). Adapters never touch tmux or services.

### 6.2 The claude-code adapter (v1)

Reproduces the behavior proven in production by a2adapt-fleet:

- **Launch:** fresh → `claude --remote-control <Name> --session-id <SID> "Read and
  follow <dir>/briefing.md now."`; resume → `claude --remote-control <Name>
  --resume <SID> "<restart prompt>"`. `supportsResume: true`.
- **prepareSession:** pre-trust state dir + cwd in `~/.claude.json`
  (`hasTrustDialogAccepted` etc.); write per-role `--settings` overlay merging
  `harness_options.plugins` ({"name@marketplace": bool}) and the MemPalace master
  switch; compute `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `max_tokens` (% of the 1M
  window, fallback 50) plus `MEMPALACE_*` env.
- **exitPolicy:** `{ cleanExitIsFresh: true, fastFailSecs: 20 }`.
- **Prereq:** `claude` on PATH and logged in.

### 6.3 Harness-neutral vs adapter-owned config

Neutral (core-validated): `harness`, `identity`, `cwd`, `coordinator`, `mission`,
`persona`, `bio`, `briefing_file`, `max_tokens`, `env`, `oversee`.
Adapter-owned: everything under `harness_options:` (opaque to core, validated by
`validateOptions`). A harness that can't honor `max_tokens` warns and ignores it.

### 6.4 Graduation path

If/when third parties want to ship harness support independently, the registry gains
dynamic loading of `@ours.network/fleet-harness-<id>` packages implementing the same
interface. Nothing in v1 blocks this; nothing in v1 pays for it.

## 7. fleet.yaml schema

```yaml
vars:
  work_root: /home/me/work

defaults:
  harness: claude-code
  max_tokens: 500000

roles:
  FleetCoordinator:
    harness: claude-code
    identity: FleetCoordinator          # ours identity to bind (default: role name)
    cwd: ${work_root}
    briefing_file: coordinator.md       # optional curated briefing (else generated)
    persona: |
      …operating contract; published via set_persona…
    bio: |
      …public card; published via set_bio (default: summary of persona)…
    oversee:                            # optional; see §10
      - { role: Alice, interval: 5m }
      - { role: Bob,   interval: 5m }

  Alice:
    coordinator: FleetCoordinator       # announce target on boot
    mission: one-line mission
    env: { FOO: bar }                   # extra session env
    harness_options:                    # adapter-owned (claude-code shown)
      plugins: { "mempalace@mempalace": false }
      mem_palace: false
```

## 8. Supervision backends

```ts
interface SupervisorBackend {
  install(role): void;    // write unit/plist, enable
  start / stop / restart / status / uninstall (name): void;
  logs(name, follow): void;
}
```

- **systemd (Linux):** `fleet-agent@.service` template in
  `~/.config/systemd/user/` (installed by `ours-fleet init`), `Restart=always`,
  `RestartSec=2`, `ExecStart=ours-fleet _run %i`. `init` enables linger;
  `doctor` verifies it.
- **launchd (macOS):** `~/Library/LaunchAgents/network.ours.fleet.<name>.plist`,
  `KeepAlive=true`, `RunAtLoad=true`, stdout/err → `~/.ours-fleet/logs/<Name>.log`.
  Runs after login (macOS has no linger); documented limitation.
- **none:** plain tmux, no unit. Used by temp agents and by CI tests.

Boots are staggered (`FLEET_START_STAGGER`, default 5 s) on `up`/`restart` to avoid
provider rate limits.

## 9. Spawning

### 9.1 Permanent

`ours-fleet spawn <Name> [--harness H] [--mission M] [--identity I] [--cwd D]
[--coordinator C] [--bio-file F] [--persona-file F] [--oversee-interval 5m]`

1. Validate `<Name>` (`[A-Za-z0-9_-]`, unused across merged config).
2. Write `~/fleet.d/<Name>.yaml` with the given fields.
3. Run the equivalent of `up <Name>` (prepare, install unit, start).

Unspawn = `ours-fleet rm <Name>` (also deletes its `fleet.d` file). Interactive TTY
prompts fill any missing fields.

### 9.2 Temporary

`ours-fleet spawn --temp <Name> …` — same identity + briefing + WORKLOG treatment,
but state in `~/.ours-fleet/tmp/<Name>/`, launched via the `none` backend: tmux runs
`ours-fleet _run-temp <Name>`, which launches the harness, waits, and **removes the
dir on exit**. No service, no crash-restart, gone on reboot. The bound identity
persists in the ours store (identities and roles are decoupled; nothing to clean).

### 9.3 From inside a harness — the `spawn-ours-agent` skill

The claude-code integration ships a skill so an agent can execute "spawn ours agent
…" conversationally:

1. Ask: **temporary or permanent?**
2. Co-draft **bio + persona** with the requester (bio = public card, persona =
   operating contract).
3. Write both to temp files; call `ours-fleet spawn [--temp] <Name> --bio-file …
   --persona-file … [--mission …]` (files avoid shell-quoting hazards).
4. **Arm oversight** for the new agent (§10) at the chosen interval (default 5m).

The spawning agent is the subagent's owner: it announces itself as (or delegates to)
the `coordinator:` of the spawned role when permanent.

## 10. Oversight ("keep an eye")

Spawned agents are effectively subagents; their spawner (or any assigned overseer,
e.g. the coordinator) periodically checks that they aren't stuck and unsticks them
directly.

- **Core primitives:** `ours-fleet peek <Name>` (pane snapshot) and
  `ours-fleet send <Name> …` (type into the pane / send raw keys). Same-user tmux —
  no privilege machinery.
- **The judgment loop lives in the overseeing agent, not the core.** Deciding
  "waiting on a permission prompt" vs "thinking" is LLM work. The
  **`oversee-agents` skill** defines the procedure:
  1. Arm a repeating check every N minutes (harness-native scheduling; Claude Code:
     scheduled wake-ups / background monitor).
  2. Each tick, `peek` every ward and judge the pane: stuck on a prompt/menu/trust
     dialog? crashed to a shell? idle with work assigned? looping?
  3. Resolve directly with `send` (answer the prompt, approve, redirect); escalate
     over ours messaging to the owner/coordinator only when unsure.
- **Assignment sources**, all equivalent to the skill:
  - persona free text — "keep an eye on agents Alice and Bob once in 5 minutes";
  - the structured `oversee:` role field, which the briefing generator renders as an
    explicit "## Oversight assignments" section (survives restarts);
  - the tail of a `spawn-ours-agent` run (overseer = spawner, default 5m).

## 11. Briefing generation

`briefing.ts` renders the role template using the adapter's `vocabulary`:
identity bind/create steps (existing-first, mint-if-missing), bio/persona reconcile
+ publish (idempotent — only write on drift), arm the watch monitor
(`ours-mcp watch "<Identity>"` via the harness's persistent-monitor mechanism),
announce to `coordinator:` if set, oversight assignments if any, WORKLOG discipline,
restart-recovery instructions, house rules. `briefing_file:` replaces the generated
body entirely (core still appends the mechanical boot steps so identity binding
never depends on hand-written text).

All wording is ours.network-branded; the word "a2adapt" must not appear anywhere in
the repo, briefings, or generated artifacts.

## 12. Prerequisites & README

README documents per-OS setup:

- **Required:** `node ≥ 20`, `tmux`, the harness CLI for every harness used
  (logged in), `ours-mcp` daemon running (`npm i -g @ours.network/mcp && ours-mcp
  start`) with a root identity created.
- **Linux:** `apt install tmux`; `ours-fleet init` enables linger
  (`loginctl enable-linger`).
- **macOS:** `brew install tmux`; `ours-fleet init` prepares `~/Library/LaunchAgents`;
  note: agents start at login, not at boot.
- `ours-fleet doctor` verifies all of the above and per-harness login state, with
  actionable messages.

Dropped prereqs vs a2adapt-fleet: `python3` + PyYAML (JS YAML lib), `uuidgen`
(`crypto.randomUUID()`), `install.sh` (replaced by `npm i -g` + `ours-fleet init`).

## 13. Error handling

- Duplicate role name across `fleet.yaml`/`fleet.d/` → hard error naming both files.
- Unknown `harness:` → error listing registered adapters.
- Failed prereq for a role's harness at `up` → that role errors, others proceed;
  summary at the end.
- `spawn` name collision → error before any file is written.
- Resume-unsupported harness → warn once at `up`, always boot fresh.
- `send`/`peek`/`attach` on a non-running role → clear "not running; try
  `ours-fleet status <Name>`" message.
- Config parse/validation errors print file:line where possible.

## 14. Testing

- **Unit:** config merge (incl. clash detection, `${vars}`, defaults cascade),
  briefing generation per vocabulary, adapter option validation, exit-policy
  interpretation.
- **Adapter contract test:** a fake `echo`-style harness adapter runs the full
  runner loop under the `none` backend — proves the interface without any real
  harness or systemd (CI-safe).
- **claude-code adapter:** unit-test `prepareSession` artifacts (trust JSON,
  settings overlay, env) against golden files.
- **Manual smoke (documented):** Linux + macOS checklist — `init`, `up` one role,
  reboot survival (Linux), login survival (macOS), `spawn --temp`, `peek`/`send`,
  `rm`.

## 15. License

**FSL-1.1-Apache-2.0** (Functional Source License, converts to Apache-2.0 two years
after each release) — same license as `ours-claude-marketplace`. Copyright 2026
ours.network contributors.

## 16. Decisions log

| Decision | Choice | Why |
|---|---|---|
| v1 harness | Claude Code only; interface designed for more | second adapter proves interface when real |
| Packaging | npm core + thin per-harness shims | matches ours ecosystem; core never depends on a harness |
| Core language | TypeScript/Node | typed adapter contract, testable, drops PyYAML/uuidgen deps |
| Spawn config write | `fleet.d/` include dir | hand-written fleet.yaml never machine-touched |
| Temp agents | full identity, tmux-only, dir auto-clean | reboot/coordinator-kill is the intended lifecycle |
| Identity GC | none (no ledger, no `gc`) | identities and roles are decoupled; persistence is fine |
| Cross-user `-u` | removed | each user self-manages; symmetric Linux/macOS; deletes sudo plumbing |
| macOS | LaunchAgent (own user) | real use case is a laptop; no linger equivalent fought |
| Coordinator | just a role (`briefing_file` for curated text) | removes special-case service + dir |
| Oversight | core = peek/send primitives; loop = skill | stuck-detection is LLM judgment, not core code |
