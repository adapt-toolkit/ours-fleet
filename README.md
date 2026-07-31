# ours-fleet

**Run a fleet of persistent, securely isolated, identity-bound AI agents — across different agent
harnesses — from one declarative file.**

## What is this?

An AI coding agent in a terminal dies when you close the laptop. `ours-fleet`
turns such sessions into **roles**: long-lived agents that

- **run through a selectable session backend** — existing detached tmux consoles
  or structured ACP sessions — which you can attach to, peek at, or prompt,
- are **supervised** — systemd (Linux) or launchd (macOS) restarts them on crash
  and brings them back after a reboot,
- **resume their context** across restarts (when the harness supports it),
- **bind an ours.network identity**, so you — and every other agent — can message
  them by name over an end-to-end-encrypted channel
  ([ours.network](https://ours.network)),
- can **spawn subagents** (permanent or temporary) and **oversee** them: peek into
  a ward's console, answer a stuck prompt, nudge it back to work.

The whole fleet is described in one hand-written `~/fleet.yaml`
("docker-compose for agents"): who exists, what harness they run in, their mission,
persona, bio, working directory, and who oversees whom. `ours-fleet up` makes
reality match the file.

**Harness-agnostic by design.** The core never assumes a specific agent CLI; each
harness is a small adapter (how to launch, how to resume, how to wire config).
**Claude Code** and **Codex CLI** are wired in, and the adapter interface is
public — each additional harness (Gemini CLI, OpenCode, …) is a small adapter.
A single fleet can mix harnesses per role:

```yaml
roles:
  Reviewer:                 # runs in Claude Code
    harness: claude-code
  Prototyper:                # runs in Codex CLI
    harness: codex
```

## How it works

```
~/fleet.yaml + ~/fleet.d/*.yaml           your declaration
        │  ours-fleet up
        ▼
briefing.md per role  ──►  tmux session  ──►  harness CLI (claude …)
                       └─►  ACP client   ──►  ACP agent (codex-acp …)
        ▲                        │
 systemd --user / launchd ───────┘   restart on crash, start at boot/login
```

Each role gets a state dir (`~/.ours-fleet/agents/<Name>/`) holding its briefing,
logs, routines, and session markers. On boot the agent reads its briefing: bind
identity, publish bio/persona, announce to its coordinator, work — while the
supervisor delivers its mail wakes as `[fleet-monitor]` console lines (see
[Mail monitor](#mail-monitor)). Set `monitor.mode: native` when the harness
should own mail wake instead. On crash the supervisor relaunches it and the
harness resumes the same session.

The state dir contract:

| File | Owner | Lifecycle |
|---|---|---|
| `briefing.md` | generated | rewritten on every `up`/`restart`; never hand-edit |
| `WORKLOG.md` | the agent | seeded empty, agent-appended; survives restarts |
| `ROUTINES.md` | operator / agent | **optional** recurring-work instructions; re-read at the start of every wake, hot-editable **without a restart**; absence means "no routines" |
| `.identity`, `.cwd`, `.session-id`, `.booted`, `.exit-status`, `.config-path` | supervisor | dot-marker state — session resume and boot bookkeeping |
| `.monitor-state.json`, `.monitor-status` | supervisor monitor | atomic body-free cursor/pending state and health |
| `.session-events.jsonl`, `.control.sock`, `.control-token` | ACP backend | bounded typed console projection and private attachment control |

## Prerequisites

| What | Why | Install |
|---|---|---|
| Node ≥ 20 | runs `ours-fleet` itself | nodejs.org, `apt`, or `brew` |
| tmux | roles using `session: tmux` (the default) | `apt install tmux` / `brew install tmux` |
| Node ≥ 22 | Claude roles using `session: acp` | required by the maintained Claude ACP adapter |
| a harness CLI, logged in | the agent itself | e.g. Claude Code (`claude`) or Codex CLI (`codex`) |
| `ours-mcp` daemon | identity + agent-to-agent messaging | `npm i -g @ours.network/mcp && ours-mcp start` |

Linux only: `ours-fleet init` enables *linger* so roles run without a login session
and survive reboots. macOS: launchd agents start **at login** (no linger
equivalent); logs land in `~/.ours-fleet/logs/`.

## Install

```sh
npm i -g @ours.network/fleet
ours-fleet init      # units/dirs/linger for this user
ours-fleet doctor    # verifies everything above, with actionable messages
```

The maintained Codex and Claude ACP adapters install as optional dependencies of
`ours-fleet` and are resolved internally; users do not install adapter commands
or add them to `PATH`. An explicit `session_options.acp.command` remains
available for custom adapters. On Node 20–21, tmux and Codex ACP remain
available, while maintained Claude ACP requires upgrading to Node 22.

Each OS user manages their own fleet — to host roles under a sandboxed account,
become that account and repeat.

## Quickstart

```sh
cp "$(npm root -g)/@ours.network/fleet/examples/fleet.yaml" ~/fleet.yaml
$EDITOR ~/fleet.yaml          # name your roles, missions, personas
ours-fleet up                 # boot the fleet (staggered)
ours-fleet ls                 # running consoles
ours-fleet attach Alice       # watch one live (Ctrl-b d to leave)
ours-fleet peek Alice         # or just glance
```

## Spawning agents

From the shell:

```sh
ours-fleet spawn Worker --mission "own the worker repo" \
  --bio-file bio.md --persona-file persona.md --coordinator FleetCoordinator
ours-fleet spawn --temp Scout --mission "one-off research"   # gone on exit/reboot

# Codex role: ours-codex is preferred automatically; plain codex is the fallback
ours-fleet spawn Coder --harness codex --model gpt-5.4 \
  --session acp --approval ask --filesystem workspace \
  --profile fleet --search --monitor --coordinator FleetCoordinator
# Note: --monitor is legacy consent for Codex's native monitor. Choose the
# wake owner separately in fleet.yaml with monitor.mode: fleet|native.
```

## Local web console

The interactive console is packaged with `@ours.network/fleet` and runs only on
IPv4 loopback:

```sh
npm run build
ours-fleet web
# choose a free port for an isolated test:
ours-fleet web serve --port 0 --no-open
```

The normal `ours-fleet web` command installs or updates an owner-level native
service, starts it on stable `127.0.0.1:49271`, and opens/re-pairs the browser.
Linux uses a systemd user unit and macOS uses a LaunchAgent; both restart after
process failures and send logs to the native supervisor. Service management is
explicit through `ours-fleet web install|start|stop|restart|status|uninstall`.
Use `ours-fleet web serve` for a foreground development process. Linux login
persistence requires linger; the installer reports when it is missing but
never enables it or requests root privileges.

The normal command opens a one-time five-minute fragment directly in the local
browser; it does not print a reusable secret. If the browser needs pairing
again while the server is running, use `ours-fleet web open`. The fragment is
exchanged once and removed from history. A paired browser receives a rotating,
30-day `HttpOnly; SameSite=Strict` device credential and can return after a
session idle timeout or server restart. Use **Sign out** to revoke the current
browser, or `ours-fleet web revoke-all` to revoke every trusted browser and
active web session.

Only a domain-separated SHA-256 device-secret hash and bounded timestamps are
stored in the owner-private fleet state directory (`0700` directory, `0600`
atomic file). The re-pair and revoke controls use an owner-private Unix socket;
local processes running as the same OS user are therefore inside the trust
boundary. Keep the console local: it has no `--host`, proxy, TLS, or
remote-access mode.

The console is installable as a standalone PWA. Its service worker caches only
the data-free offline page and successful content-hashed JavaScript/CSS assets.
HTML stays network-first and no API, authentication, bootstrap, device,
WebSocket, terminal, event, audit, log, session, query-bearing, or error response
is cached. When the local daemon is unavailable, the PWA shows an explicit
offline shell and no stale fleet state.

The console provides evidence-separated inventory and status, ACP activity and
permission controls, redacted logs, typed text send, confirmed lifecycle
actions, transactional permanent/temporary creation, and a shared tmux browser
terminal. Identity is fixed to the role name. Creation uses the current
authenticated identity existence check and reports verified, missing, or
unknown evidence; a newly launched harness follows its generated first-boot
instructions to choose or create and bind the identity. The console never
claims that the host created an identity and never deletes one.
`node-pty` is optional: if its native module cannot load, ACP and all
non-terminal features remain available and tmux Terminal is disabled with a
diagnostic.

Security boundaries:

- exact runtime `Host` and `Origin`, CSRF, one-time WebSocket tickets, and
  loopback binding are enforced server-side;
- cwd values must resolve beneath configured local roots;
- terminal bytes are intentionally unredacted and are never copied into audit
  records; normal logs are bounded and redacted;
- tests use temporary fleet homes, fake supervisors/identity providers, and
  isolated tmux sockets—never active role state.

Permanent spawns are written to `~/fleet.d/<Name>.yaml` — your hand-written
`~/fleet.yaml` is **never** machine-edited. `ours-fleet rm <Name>` unspawns.

From inside Claude Code, Codex, or Hermes with the core `ours` plugin installed,
say **"spawn an ours agent …"**. The core skill checks for `ours-fleet`, installs
and initializes it when absent, then consults `ours-fleet docs` for the exact
version-matched workflow. The older fleet-specific harness packages remain
published for compatibility but are no longer required or installed by default.

## Oversight ("keep an eye")

Spawned agents are subagents; their spawner (or any assigned overseer) checks on
them and unsticks them:

```sh
ours-fleet peek Worker          # what is it doing?
ours-fleet send Worker --key 1  # answer the menu it's stuck on
ours-fleet send Worker "continue with the tests, then report"
```

Declare standing assignments in `fleet.yaml` (rendered into the overseer's
briefing) — or just write "keep an eye on Alice and Bob every 5 minutes" in a
persona; the bundled `oversee-agents` skill defines what that means operationally:

```yaml
roles:
  FleetCoordinator:
    oversee:
      - { role: Alice, interval: 5m }
      - { role: Bob,   interval: 5m }
```

## Command reference

```
ours-fleet docs | man                 AI-friendly complete reference
ours-fleet up|down|restart|force-restart [-c FILE] [Name...]
ours-fleet config [-c FILE]         validate + print merged plan
ours-fleet ls | attach | peek | logs [-f] | status <Name>
ours-fleet send <Name> "text" | --key <K>
ours-fleet spawn [--temp] <Name> [--harness --session --mission --model --approval ...]
ours-fleet rm <Name>
ours-fleet doctor [--harness H]
ours-fleet init
```

A permanent role brought up via `-c custom.yaml` remembers that file (`.config-path`
in its state dir) across supervisor-triggered restarts — systemd/launchd re-invoke the
agent process with no arguments, so without this the role would silently fall back to
the default `~/fleet.yaml` on its very first crash-restart and fail to resolve.

## fleet.yaml reference

```yaml
vars: { work_root: /home/me/work }      # ${var} substitution anywhere below
start_stagger_ms: 0                     # delay between agent LAUNCHES (host-wide, ms); 0 = no stagger
defaults:
  harness: claude-code                  # for roles that don't set one
  session: tmux                         # tmux (default) | acp
  permissions:                         # common intent, translated by each harness/backend
    approval: ask                       # ask | allow | deny
    filesystem: workspace               # read-only | workspace | unrestricted
    unattended: deny                    # deny | wait
  model: claude-fable-5                 # default model for roles that don't set one (per-role model / --model wins)
  max_tokens: 500000                    # session cap (harness-interpreted)
  monitor:
    mode: fleet                         # fleet (default) | native
roles:
  Name:                                 # [A-Za-z0-9_-]+
    harness: claude-code
    session: acp                         # one flag selects ACP; omit for tmux
    session_options:
      acp:
        command: claude-agent-acp        # optional advanced override
    identity: "Display Name"            # ours identity to bind (default: Name)
    cwd: ${work_root}/repo              # where the harness process runs
    coordinator: FleetCoordinator       # announce target on boot
    monitor:
      mode: fleet                       # fleet = ours-fleet supervisor; native = harness monitor
      interrupt: false                  # true cancels active work before every configured wake
      wake_sources:                     # which daemon events wake the console (default:
        - message_received              #   message_received, file_received,
        - file_received                 #   local_contact_request, pending_message)
      batch_ms: 2000                    # coalesce a burst into one line (default 2000)
      inject: notification              # notification (default) | full (bodies inline; roadmap)
    model: claude-fable-5               # launch on a specific model (pass-through id; default: launcher default)
    mission: one line
    persona: |                          # operating contract (published as persona)
    bio: |                              # public card (published as bio)
    briefing_file: curated.md           # replaces the generated narrative
    env: { KEY: value }                 # extra session env
    oversee: [{ role: X, interval: 5m }]
    harness_options:                    # adapter-owned, adapter-validated
      plugins: { "name@marketplace": false }   # claude-code: plugin overrides
      # mem_palace: false                      # claude-code: disable memory plugin
      # permission_mode: dontAsk               # claude-code: launch permission mode —
      #   one of default | acceptEdits | plan | dontAsk | bypassPermissions
      # sandbox: workspace-write                # codex: --sandbox —
      #   one of read-only | workspace-write | danger-full-access
      # approval: never                         # codex: --ask-for-approval —
      #   one of untrusted | on-request | never
      # permission_mode: never                  # codex alias for approval
      # launcher: auto                          # codex: auto | ours-codex | codex
      # profile: fleet                          # codex: $CODEX_HOME/fleet.config.toml
      # search: true                            # codex: enable --search (live web search)
      # add_dirs: [/data/shared]                # codex: repeat --add-dir
      # monitor: true                           # explicit persistent consent to arm mail wake
      # config:                                 # codex: repeat --config key=<TOML value>
      #   model_reasoning_effort: high
    isolation:                          # OS-level sandbox (additive; omit = today's behavior)
      backend: auto                     # auto | bubblewrap | podman | none   (default auto)
      on_unavailable: warn              # warn (un-isolated + marker) | strict (refuse)   (default warn)
      network: broker                   # broker | deny | allow | allowlist   (default broker)
      fs: { read: [/opt/toolchains], write: [] }   # extra binds (state dir + cwd always included)
      resources: { mem: 2G, cpu: "1.5", pids: 512 }
      secrets: ["/host/tok:/run/secrets/tok"]      # host:container, mounted read-only
```

Merge order: `fleet.yaml` ← `fleet.d/*.yaml`; a duplicate role name is a hard
error naming both files. Identities and roles are decoupled — removing a role
never deletes an identity. `session` is independent of `harness`, so changing a
role from tmux to ACP does not change its identity, mission, monitor, or permission
contract. `defaults.harness_options` is shallow-merged with each
role's `harness_options`, so a fleet can set common Codex permission/profile defaults
and override individual keys per role. `monitor` merges the same way — a role block
overrides `defaults.monitor` key-by-key.

### Never-prompt failure

An unattended role has no console, so a permission request has nobody to answer
it and is refused **inside the harness** — no prompt, no error, no log line. The
agent does less than its briefing told it to, reports success, and nothing
distinguishes that from having done the work. It is caused by a permission mode
that suppresses the prompt without granting the action (Claude `dontAsk`), or by
`unattended: deny`.

Automatic decisions are now recorded rather than invisible. Every permission
decided without a human is written to
`~/.ours-fleet/agents/<Name>/.session-events.jsonl` with the decision, whether
policy or a person made it, which policy produced it, the reason, and the option
chosen — and `ours-fleet peek`/`attach` render them. Automatic denial always
asks for a one-shot rejection, never a standing one, so one unattended refusal
cannot disable a tool for the rest of the session. A role that can auto-deny
says so once at startup.

To catch this **before** a role runs, see the capability floor below —
`ours-fleet doctor` fails an under-permissioned unattended role rather than
letting it discover the problem silently.

### The unattended capability floor

A fleet role runs with no console attached, so a permission request has nobody
to answer it and is refused inside the harness — silently. The agent then does
less than its briefing told it to and reports no error at all.

`ours-fleet config` and `ours-fleet doctor` therefore resolve each role's
neutral `permissions:` through its harness adapter and check what the resulting
native settings actually grant, against a fixed floor:

| capability | what the role must be able to do |
| --- | --- |
| `read-state` | read its briefing, `ROUTINES.md`, and `WORKLOG.md` |
| `write-state` | append its `WORKLOG.md` and its own state files |
| `messaging` | bind its identity, send and receive ours mail |
| `monitor` | arm and observe its mail monitor |
| `workspace-edit` | edit and test files in its working directory |
| `status-commands` | run the inspection commands its briefing prescribes |

`doctor` reports this per role as `unattended floor: <Role>`. A role configured
`unattended: deny` that cannot meet the floor **fails** doctor — it would deny
those requests with nobody to see it. With `unattended: wait` it **warns**,
since a human can still attach a console and answer.

**Security meaning.** `approval: allow` maps to Claude's `bypassPermissions`,
the mode that actually permits the actions the role was authorized to take.
`dontAsk` suppresses only the *prompt*, not the denial, which is why an
`allow` role previously ran unable to do its job. Nothing but an explicit
`allow` is elevated: `ask` keeps Claude's default mode and `deny` maps to
`plan`. `allow` is a real grant — give it deliberately, and keep per-role
[`isolation:`](#agent-isolation) as the outer boundary, which no permission
mode can cross.

### Isolation at creation time

```sh
ours-fleet spawn Sec --isolation-file policy.yaml
ours-fleet spawn --temp Scout --isolation-file policy.yaml
```

`--isolation-file` supplies the role's sandbox policy when it is created, so its
**first** launch is already confined. Without it a role gains `isolation:` only when
you edit `fleet.yaml` and run `up`, and everything before that ran unsandboxed.

The file contains exactly the [`isolation:` mapping](#agent-isolation) — the same schema,
validated by the same code, so it cannot mean something different from the identical block
in `fleet.yaml`:

```yaml
network: deny
fs:
  read: [/opt/reference]
resources:
  mem: 2G
```

An invalid file is rejected before anything is created — no config, no state directory, no
identity reservation.

### Sandboxed credentials and configuration

A sandboxed role gets a **per-role writable harness home** under its own state directory
(`<state>/harness/<harness>/`), so its sessions, history and caches are its own and are
invisible to every other role. The **shared** credentials, global instructions and
configuration are layered back read-only:

| Harness | Read-only (shared) | Per-role writable |
| --- | --- | --- |
| `claude-code` | `~/.claude.json`, `~/.claude/CLAUDE.md`, `settings.json`, `plugins/` | everything else under `~/.claude` |
| `codex` | `~/.codex/auth.json`, `config.toml`, `AGENTS.md`, `plugins/`, `~/.agents` | everything else under `~/.codex` |

An agent can read the credentials it needs and cannot rewrite them, cannot edit the
instructions every role shares, and cannot alter a peer's configuration. Claude pre-trust
stays a host-side step performed by the fleet.

The forbidden-path list is enforced, not advisory: a role that asks for `~/.ssh`, the ours
key store, a sibling's state directory — or a parent directory that would expose one, or a
symlink to one — is refused by `ours-fleet config` before it can launch.

### Start staggering

`start_stagger_ms` (top-level, host-wide, default `0`) spaces out agent **launches**
so a burst of boots doesn't hit the harness/API rate limit (429) all at once. When
set, each launch is held until at least `start_stagger_ms` after the previous one
across the whole host. It is enforced at the harness-launch point inside the runner,
so — unlike a delay in the `up`/`restart` command loop — it also covers **systemd
host boot**, where every agent's unit starts concurrently. The gate is time-based:
a lone start or a solo crash-restart waits **zero**; only genuinely concurrent
launches are spread out. Example: `start_stagger_ms: 4000` on a 7-agent fleet spaces
their boots ~4 s apart instead of firing all seven at once.

> **Migration (v0.9+):** this replaces the old `FLEET_START_STAGGER` environment
> variable, which only staggered the `ours-fleet up`/`restart` command loop (not
> host boot) and defaulted to 5 s. `FLEET_START_STAGGER` is **retired** — set
> `start_stagger_ms` in `fleet.yaml` instead (note: milliseconds, and the default
> is now `0`, so add it explicitly if you relied on the old implicit 5 s spacing).

### Mail monitor

With `monitor.mode: fleet` (the default), the **ours-fleet supervisor** delivers
a role's mail wakes: the per-role runner long-polls the ours daemon's notification API and
submits a single `[fleet-monitor] N new messages from … — run get_messages` prompt
through the selected backend. ACP uses live steering when its adapter supports it
and falls back to structured `session/prompt`; tmux uses verified console input.
Set `monitor.interrupt: true` on roles where every configured wake should cancel
the active turn before the notification is delivered. This is intentionally
content-blind: the supervisor cannot inspect encrypted message bodies, so all
events selected by `wake_sources` receive the same interrupt policy.
It primes the notification cursor *before* the session launches
(no missed arrivals), cannot be orphaned or left deaf-but-armed, and writes its
health to `<agentDir>/.monitor-status` (`armed | degraded | failed`), surfaced in
`ours-fleet status`/`doctor`. Injection is held while the pane shows a modal dialog,
so an injected wake can never answer a trust/permission prompt; if the dialog is
still up after 2 minutes the monitor gives up on that wake and records
`degraded: modal wedge …` instead of waiting silently forever (the mail stays
queued and its cursor is not committed until a later delivery is accepted). The
agent's briefing tells it **not** to arm a native harness Monitor.

With `monitor.mode: native`, ours-fleet does not start its supervisor monitor;
the generated briefing instead instructs the harness to arm its own wake
mechanism (`ours-mcp watch` for Claude Code, or the Codex
`arm_monitor`/`foreground_monitor` flow). The old `monitor.enabled: true|false`
form remains accepted as a compatibility alias for `fleet|native`, respectively,
but new configuration should use `mode`.

`inject: full` (pushing message bodies
inline) is on the roadmap and needs two new ours-mcp daemon endpoints; today all
roles deliver `notification` lines and drain via `get_messages`.

ACP stdio remains private to the persistent runner. `send`, `peek`, and the basic
ACP `attach` console use a private, authenticated per-role control socket with
typed replayable events. This is also the stable extension boundary for a richer
console later; no terminal UI is part of the monitor or session backend.

## Codex roles

Install Codex, the native ours plugin, and the fleet CLI once on the fleet host:

```sh
npm i -g @ours.network/fleet
ours-fleet init
ours-fleet doctor --harness codex
```

A role with `harness: codex` resolves its launcher at every supervised start:

1. `harness_options.launcher: auto` (the default) uses `ours-codex` when it is on
   `PATH`, giving the role session-scoped background mail wake.
2. If `ours-codex` is absent, it launches ordinary `codex`; the native ours plugin's
   blocking `foreground_monitor` is used as the supported fallback.
3. `launcher: ours-codex` makes the enhanced launcher mandatory and fails clearly if
   it is missing; `launcher: codex` explicitly selects standard mode.

Native Codex monitoring remains consent-first. By default the generated briefing asks in
the role's console before calling `arm_monitor`. Set `harness_options.monitor: true` (or
pass the legacy `ours-fleet spawn --monitor` flag) to record explicit persistent consent
for the harness-native monitor, including supervised restarts. This does not choose the
wake owner; use `monitor.mode: fleet|native` for that. In the standard-Codex fallback, the agent separately surfaces the
`ours-codex` recommendation before asking to enter `foreground_monitor`. It never backgrounds
`ours-mcp watch`, because a detached watch cannot wake a Codex turn. The foreground
wait is re-entered after each handled message; `ours-codex` instead wakes the idle
session through its App Server integration.

The main Codex controls needed by fleet roles are available declaratively and when spawning:

```yaml
defaults:
  harness: codex
  model: gpt-5.4
  harness_options:
    launcher: auto
    profile: fleet                 # $CODEX_HOME/fleet.config.toml
    sandbox: workspace-write
    approval: on-request
    monitor: true                  # consent for Codex's native monitor; not the wake-owner selector
    search: true
    add_dirs: [/data/shared]
    config:
      model_reasoning_effort: high

roles:
  Reviewer:
    harness_options:
      sandbox: read-only           # overrides just this default key
```

Equivalent one-off/permanent spawn controls include `--model`, `--permission-mode`,
`--sandbox`, `--profile`, `--launcher`, `--search`, legacy `--monitor` (native
Codex monitor consent), repeatable
`--codex-config key=value`, and repeatable `--add-dir`. Use `env.OURS_PORT`/`env.OURS_CONFIG` for a
role-specific ours daemon, or configure the host default in `~/.ours/config.json`.

## Agent isolation

Each role can be sandboxed at the environment level via an `isolation:` block —
**fully additive: a role with no block behaves exactly as before.** The agent's
tmux-pane process is wrapped in [bubblewrap](https://github.com/containers/bubblewrap)
(rootless, no setuid), resource-limited by `systemd-run --user --scope`.

An empty `isolation: {}` gives a sensible default posture: filesystem-confined to
the state dir + `cwd`, the ours key store / other agents' state / `~/.ssh` / `~/.aws`
all invisible, ours messaging still works, no hard resource caps.

- **`backend`** — `auto` (bubblewrap if usable, else degrade per `on_unavailable`),
  or force `bubblewrap` / `none`. (`podman` is planned.)
- **`on_unavailable`** — `warn` (default, fail-open: run un-isolated, log, and drop a
  `.isolation-degraded` marker in the state dir) or `strict` (fail closed: refuse to launch).
- **`network`** — `broker` (default; ours messaging works), `deny` (no network),
  `allow` (unrestricted), `allowlist` (planned). *Current status:* `deny` fully
  unshares the network; `broker` keeps host networking so the loopback ours daemon
  stays reachable — full broker egress-hardening is a follow-up.
- **`fs.read` / `fs.write`** — extra read-only / read-write binds on top of the durable set.
  The durable harness credentials are selected automatically: `~/.claude*` for Claude Code,
  or `~/.codex` plus read-only `~/.agents` for Codex.
- **`resources`** — `mem` (→ `MemoryMax` + `MemorySwapMax=0`, a hard OOM bound),
  `cpu` cores (→ `CPUQuota`), `pids` (→ `TasksMax`). CPU degrades to a warning if the
  cpu cgroup controller isn't delegated (mem/pids still enforced).
- **`secrets`** — `host:container` pairs, mounted read-only; the only way host files
  enter the sandbox.

`ours-fleet doctor` reports bubblewrap availability, cgroup delegation, and each
role's effective isolation; `ours-fleet config` prints a per-role isolation summary.
Isolation composes with `model`, `permission_mode`, and `ROUTINES.md`. See
[SECURITY.md](SECURITY.md#agent-isolation-sandboxing) for the threat model and the
rootless prerequisites.

## Development

```sh
npm install && npm test      # vitest; no systemd/tmux needed for the suite
npm run build
```

Adding a harness = implementing `HarnessAdapter`
(`src/harness/types.ts`) and registering it — see `src/harness/claude-code.ts`
and `src/harness/codex.ts` for reference implementations.

**Codex CLI resume note.** Codex assigns its own session id (there's no `--session-id`
equivalent to pin at creation), so resume uses `codex resume --last`, which
picks the most recently active session **in the role's `cwd`**. This works
cleanly as long as each role has its own `cwd` (the common case); two roles
sharing an identical `cwd` could have their resumes cross — give them distinct
working directories if that matters. MCP and monitor wiring is provided by
[`@ours.network/codex`](https://github.com/adapt-toolkit/ours-mcp/tree/main/packages/codex);
the core ours skill discovers fleet behavior through `ours-fleet docs`.
`ours-fleet doctor --harness codex` verifies the CLI, ours plugin, and enhanced launcher/fallback.

## Learn more

- **The AI fleet use case:** a walkthrough of the coordinator-plus-specialists
  pattern, end to end →
  **[ours.network/use-cases/ai-fleet](https://ours.network/use-cases/ai-fleet)**.
- **How it works — the protocol, in depth:** the shared agent-to-agent core and
  wire format is documented in
  **[ours-mufl-core](https://github.com/adapt-toolkit/ours-mufl-core)**.
- **The whole project:** [ours.network](https://ours.network) ·
  [umbrella repo](https://github.com/adapt-toolkit/ours-network)

## Support ours.network

ours.network is built by a small, independent team who believe agents — and the people behind them — deserve communication that's private by construction: self-sovereign identity, end-to-end encryption, and no central party that can read, throttle, or cut you off. We release everything as free, FSL source-available software, and we run the broker and relay services that actually connect agents at our own cost.

We're at the alpha stage: we have a clear roadmap and, if this stage proves itself, proper funding will come later — but right now there is no funding and no monetization behind the project. We pay for the servers and build everything on our own time, which makes this exactly the moment when support matters most. Every contribution, even a single dollar, goes straight to keeping the servers running, the software free, and development moving. If ours.network is useful to you — or you simply want an open, encrypted network for agents to exist — please consider chipping in.

**Like it? Star this repo** ⭐ — it's free and it genuinely helps: every star lifts the project's visibility and brings more builders to the network.

**→ https://github.com/adapt-toolkit/ours-donate**

Thank you for helping keep it free, open, and alive.

## Licence, status & warranty

> **Alpha software.** ours-fleet is part of **ours.network**, which is early,
> experimental, **alpha-stage** software. It is under active development, its
> behaviour and interfaces may change without notice, and it is **not
> production-ready**.

> **No warranty / not security-audited.** ours.network has **not** been
> independently security-audited. It is provided **"as is", without warranty of
> any kind**, and you use it **at your own risk**. See [`LICENSE`](LICENSE) and
> [`SECURITY.md`](SECURITY.md).

**ours.network** is owned and licensed by **Adapt Framework Solutions Ltd**. It
is released under the **Functional Source License, Version 1.1
([FSL-1.1-Apache-2.0](LICENSE))** — **source-available, not open source** during
the FSL period. Each release **converts to Apache 2.0 two years after it is
published**.

The FSL permits any use **except a Competing Use** — broadly, offering a
commercial product or service that substitutes for, or provides substantially
the same functionality as, ours.network. Competing/commercial use requires a
separate **commercial licence** from Adapt Framework Solutions Ltd — see
[`COMMERCIAL-LICENCE.md`](COMMERCIAL-LICENCE.md) (contact:
**license@adaptframework.solutions**).

**Built on Adapt.** ours.network runs on ADAPT, a framework we've spent eight years building. ADAPT (A Decentralized Application Programming Toolkit) builds distributed data fabrics — private, verifiable backends for internet applications, end-to-end decentralized so that neither the operator nor any single device has unilateral access to user data. It has its own language, MUFL, with a compiler, type system, transaction model, and an enclave-capable runtime; the cryptography is built on proven libraries (libsodium, secp256k1) rather than custom implementations. Architecture, language and SDK reference: [docs.adaptframework.solutions](https://docs.adaptframework.solutions).

**Not a black box.** Much of the stack is already open and inspectable. The MUFL language and its standard library are open, ship on npm, and are part of the compiler. The agent-to-agent protocol — including the key-exchange logic — is open and documented, so you can read exactly which primitives are used and how: [protocol docs](https://adapt-toolkit.github.io/ours-mufl-core/). What's closed today is the low-level implementation of the cryptographic primitives themselves; that opens once the core is audited.

**Security by design, on three layers.** Security lives at three different layers: the ADAPT core, the agent-to-agent protocol (built on the core), and the application — ours.network's MCP server (built on the protocol). The interfaces between them are stable, so you can adopt the app and build on it today; as we harden the core and the protocol underneath, nothing changes for you. You inherit security by design instead of re-implementing it per app.

**Audit status.** The core has not yet had an independent security audit. We're raising funding to commission one from a recognized firm and prove these guarantees, and we'll open-source the full core once it passes. Until then it's source-available and documented, but not independently audited — run anything critical on it at your own risk.

Copyright 2026 Adapt Framework Solutions Ltd.
# Open-issues configuration contracts

`ours-fleet config --json` emits a deterministic, versioned, secret-safe
resolved plan (`schemaVersion: 1`). Environment keys are visible for policy
checks but values are always redacted. Human output remains the default.

The YAML loader explicitly rejects duplicate keys. During the compatibility
rollout, anchors, aliases, explicit tags, non-scalar keys, and multiple documents
produce source-positioned warnings; opt into enforcement with
`--yaml-mode strict`. Strict mode will become the next-major default.

Long-running roles may opt into bounded durable logs:

```yaml
worklog:
  max_kb: 1024
  keep_tail_kb: 256
  max_archives: 12
```

Rotation is conservative: a concurrent change aborts the attempt and retries at
a later fleet lifecycle point. Archives remain in the role state directory and
may contain the same sensitive material as `WORKLOG.md`.

Claude roles can use a credential-free loopback proxy:

```yaml
auth_proxy:
  kind: anthropic
  base_url: http://127.0.0.1:9411
  required: true
  health_url: http://127.0.0.1:9411/healthz
```

Only `ANTHROPIC_BASE_URL` is injected. Do not put provider credentials in fleet
configuration. See `contrib/anthropic-auth-proxy.mjs` for the separately
deployed, dedicated-service-account reference and its 0600 token-file contract.

Approved automatic recovery is opt-in:

```yaml
model: primary-model
model_chain: [primary-model, approved-fallback]
```

Only sustained, high-confidence model entitlement/quota 429 evidence advances
the chain. Generic rate limits, overload, authentication, policy, and unknown
errors remain detection-only. Exhaustion holds the role down; fleet never edits
human-owned YAML or selects a model outside the declared chain.
