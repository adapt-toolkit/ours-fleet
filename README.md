# ours-fleet

**Run a fleet of persistent, securely isolated, identity-bound AI agents — across different agent
harnesses — from one declarative file.**

## What is this?

An AI coding agent in a terminal dies when you close the laptop. `ours-fleet`
turns such sessions into **roles**: long-lived agents that

- **run through structured managed sessions** behind one provider-neutral
  agent-session interface, which you can inspect or prompt,
- are **supervised** — systemd (Linux) or launchd (macOS) restarts them on crash
  and brings them back after a reboot,
- **resume their context** across restarts (when the harness supports it),
- **bind an ours.network identity**, so you — and every other agent — can message
  them by name over an end-to-end-encrypted channel
  ([ours.network](https://ours.network)),
- can **spawn subagents** (permanent or temporary) and **oversee** them: peek into
  a ward's console, answer a stuck prompt, nudge it back to work.

The fleet uses a v2 manifest plus typed documents: `~/fleet.yaml` holds
fleet-wide operational policy and automation, while `~/fleet/agents`,
`~/fleet/roles`, and `~/fleet/brains` hold bare Agent, Role, and Brain documents.
`ours-fleet up` makes reality match that trusted split source set.

**Harness-agnostic by design.** The core never assumes a specific agent CLI; each
harness is a small adapter (how to launch, how to resume, how to wire config).
**Claude Code** and **Codex CLI** are wired in, and the adapter interface is
public — each additional harness (Gemini CLI, OpenCode, …) is a small adapter.
A single fleet can mix harnesses per role:

```yaml
# ~/fleet/agents/Reviewer.yaml
role: { ref: reviewer }
brain: { inline: { harness: claude-code, session: acp } }

# ~/fleet/agents/Prototyper.yaml
role: { inline: { mission: Build prototypes } }
brain: { inline: { harness: codex, session: codex-app-server } }
```

## How it works

```
~/fleet.yaml + ~/fleet/{agents,agent_templates,roles,brains,room_templates}/*.yaml   your declaration
        │  ours-fleet up
        ▼
briefing.md per role  ──►  agent session adapter  ──►  native app-server or ACP transport
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
| `.owner-channel-state.json` | owner-channel bridge | bounded wire-ID dedupe only; never message/reply plaintext |
| `.owner-channel-message-recovery.json` | owner-channel bridge | mode-0600 body-free message claim journal: wire ID, history sequence, and claim time only |
| `.owner-channel-attachment-recovery.json` | owner-channel bridge | mode-0600 attachment route journal; never filenames, paths, transcript text, or bytes |
| `.owner-channel-binder.lock/`, `.owner-channel-binder.json` | owner-channel supervisor | mode-0600 role/identity + PID/start-marker ownership and release metadata; never mail plaintext or credentials |
| `.session-events.jsonl`, `.control.sock`, `.control-token` | managed session backend | bounded typed console projection and private attachment control |

## Prerequisites

| What | Why | Install |
|---|---|---|
| Node ≥ 20 | runs `ours-fleet` itself | nodejs.org, `apt`, or `brew` |
| Node ≥ 22 | Claude roles using `session: acp` | required by the maintained Claude ACP adapter |
| a harness CLI, logged in | the agent itself | e.g. Claude Code (`claude`) or Codex CLI (`codex`) |
| `ours` CLI + shared daemon | identity + agent-to-agent messaging | `npm i -g @ours.network/cli && ours daemon start` |

Linux only: `ours-fleet init` enables *linger* so roles run without a login session
and survive reboots. macOS: launchd agents start **at login** (no linger
equivalent); logs land in `~/.ours-fleet/logs/`.

## Install

```sh
npm i -g @ours.network/fleet
ours-fleet init      # interactive reviewed defaults + host setup
ours-fleet doctor    # verifies everything above, with actionable messages
```

Native Codex roles use the logged-in Codex CLI's `app-server` command directly.
The maintained Codex and Claude ACP adapters remain bundled optional dependencies
and are resolved internally; users do not install adapter commands or add them to
`PATH`. Explicit `session_options.codex_app_server.command` and
`session_options.acp.command` overrides remain available. On Node 20–21, native
Codex and Codex ACP remain available, while maintained Claude ACP requires Node 22.

Each OS user manages their own fleet — to host roles under a sandboxed account,
become that account and repeat.

## Quickstart

```sh
ours-fleet init               # interactive; reviews and replaces the complete named setup
ours-fleet config             # validates Agents, Roles, Brains, and Room templates
$EDITOR ~/fleet/agents/*.yaml # compose Role + Brain and operational settings
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
ours-fleet spawn Coder --brain codex-fleet --role developer \
  --approval ask --filesystem workspace --coordinator FleetCoordinator
```

Inside a managed role, `ours-fleet spawn` is transparently routed through
that role's live supervisor. `ours-fleet spawn DeveloperX --temp` is the
minimal form: omitted Brain/Role selections, cwd, coordinator, neutral permissions,
and fleet monitor policy inherit from the caller. Identity, environment, owner routing,
room startup, and sensitive inline Brain values do not. Explicit flags win. After
creation succeeds, fleet can deterministically notify
the caller's owner channel with the caller and spawned-role details. This is an
honest-actor convenience and attribution path, not a security boundary; host
shells and deliberately bypassed absolute binaries retain direct behavior.

## Local web console

The interactive console is packaged with `@ours.network/fleet` and binds to
IPv4 loopback by default. Remote or proxy exposure is always explicit:

```sh
npm run build
ours-fleet web
# choose a free port for an isolated test:
ours-fleet web serve --port 0 --no-open
# nginx/TLS terminates at the declared browser origin; fleet remains loopback-bound
ours-fleet web install --public-origin https://fleet.example.com --password-file /secure/fleet-password
# Intentional no-password mode, for example when nginx already authenticates:
ours-fleet web install --public-origin https://fleet.example.com --no-password
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
boundary.

On first setup, the CLI requires an explicit access choice: `--password-file`
or `--pairing` for protected access, or `--no-password` for intentional
unprotected access. `--password-file` stores only a salted scrypt verifier in
the owner-private web state; the source file remains operator-managed. New
browsers sign in and then receive the same rotating HttpOnly trusted-device
credential. `--no-password` is deliberately named and prints a warning: anyone
who can reach that origin can control the fleet.

For nginx on a VPS, keep the default loopback bind and set the exact external
`--public-origin` (scheme, hostname, optional port). nginx should proxy HTTP and
WebSocket upgrades to `127.0.0.1:49271` and provide TLS; rewriting the upstream
Host is not required because the declared browser Origin remains authoritative. To listen beyond
loopback, add an explicit `--bind`; fleet refuses a non-loopback bind without a
public origin. Host and Origin validation use that declaration rather than
trusting forwarded headers. `localhost` and `127.0.0.1` both work in normal
local mode; an unconfigured hostname gets a self-describing HTML page instead
of raw internal Host-header JSON.

The console is installable as a standalone PWA. Its service worker caches only
the data-free offline page and successful content-hashed JavaScript/CSS assets.
HTML stays network-first and no API, authentication, bootstrap, device,
WebSocket, terminal, event, audit, log, session, query-bearing, or error response
is cached. When the local daemon is unavailable, the PWA shows an explicit
offline shell and no stale fleet state.

The console provides evidence-separated inventory and status, ACP activity and
permission controls, redacted logs, typed text send, confirmed lifecycle
actions, and transactional permanent/temporary creation. Identity is fixed to
the role name. Creation uses the authenticated
daemon inventory and reports verified, missing, or unknown evidence. A missing
permanent role identity is created deterministically before launch with local
discovery and auto-accept enabled, then the provisioning lease is released so
the harness only has to bind it. Fleet never silently replaces or force-adopts
an existing identity.

ACP tool diffs are normalized before they enter the durable conversation
ledger. Small diffs retain their existing before/after representation. When an
adapter reports an oversized whole-file snapshot, fleet stores only the changed
region with path, operation, original byte counts, digest, and boundedness
metadata. Each retained changed side is capped at 64 KiB as a UTF-8-safe,
newest-content tail. The tail advances to a line boundary when a complete line
fits. If one logical line alone exceeds the cap, fleet retains its newest
UTF-8-safe suffix and records that it starts mid-line, together with omitted-byte
count and digest. Paths retain at most a 4 KiB suffix with the same explicit
size/digest/omission provenance, and a 320 KiB cap covers the complete normalized
update. An append therefore cannot replay a large historical file while hiding
the current appended text. The live web-console transcript projects only events
from the current runner generation and excludes adapter `session/load` replay;
those replay events remain in the durable ledger with `agent_replay` provenance
for diagnosis and recovery rather than appearing as current work.

For every temporary role, the first-boot instructions call ours MCP
`create_temporary_identity` with the exact assigned name, so the new identity
is owned and cleaned up by that connector session lifecycle. Temporary roles
never bind pre-existing identities or fall back to permanent `create_identity`.
Fleet does not inspect, preserve, or provision an ours identity for temp spawn.
A collision, missing tool, or creation error stops for operator review; fleet
never force-adopts or deletes identity state. Permanent roles are
provisioned by fleet before launch and never delegate normal identity creation
to the harness.

The web console uses structured ACP activity rather than exposing a raw agent terminal.

Security boundaries:

- configured `Host` and `Origin`, CSRF, one-time WebSocket tickets, and explicit
  bind/origin policy are enforced server-side;
- cwd values must resolve beneath configured local roots;
- normal logs are bounded and redacted;
- tests use temporary fleet homes and fake supervisors/identity providers—never
  active role state.

Permanent spawns write a bare Agent document to
`~/fleet/agents/<Name>.yaml`; generated-source ownership is recorded so removal
never deletes an unproven hand-written neighbor. `ours-fleet rm <Name>` unspawns.

The web editor reads and writes the split document model explicitly as
`{manifest, agents}`. Role and Brain presets are visible through Agent refs but
remain read-only. Saves use one aggregate revision over the manifest and all
Agent/Role/Brain sources, validate an exact-stem private staging tree, show a
deterministic redacted diff per document, and hold one manifest-root lock.
Changed/deleted files are backed up together; any partial failure restores every
document or reports the private recovery directory. An unchanged save is a
byte-for-byte no-op and creates no backup. Nested environment, authentication,
invite, and isolation secrets never leave the host.

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
ours-fleet send Worker "continue with the tests, then report"
```

Declare standing assignments in the overseer's bare Agent document (rendered into its
briefing) — or just write "keep an eye on Alice and Bob every 5 minutes" in a
persona; the bundled `oversee-agents` skill defines what that means operationally:

```yaml
role: { ref: coordinator }
brain: { ref: claude-default }
oversee:
  - { agent: Alice, interval: 5m }
  - { agent: Bob,   interval: 5m }
```

## Command reference

```
ours-fleet docs | man                 AI-friendly complete reference
ours-fleet up|down|restart|force-restart [-c FILE] [Name...]
ours-fleet config [-c FILE]         validate + print merged plan
ours-fleet ls | attach | peek | logs [-f] | status <Name>
ours-fleet send <Name> "text"
ours-fleet spawn [--temp] [<Name> | --name <Name>] --brain <ID|inline:{...}> --role <ID|inline:{...}> [--approval ...]
ours-fleet loops validate|list|status
ours-fleet loops reload <Role>
ours-fleet loops run-now|disable|enable <Role> <Loop>
ours-fleet rm <Name>
ours-fleet doctor [--harness H]
ours-fleet version [--json]         build identity, capabilities, installs on PATH
ours-fleet init
```

### Which build am I running?

`--version` prints a semver, and a semver does not identify an artifact: version
bumps land in their own release commit, so a build cut between two releases
carries the previous version while already containing new behaviour. Two installs
on one host once both reported `0.16.0` while disagreeing about whether
`monitor.interrupt: after_tool` was valid.

Every build therefore stamps `dist/build-info.json` with a content-derived build
id, its commit, and the capability tokens the shipped code declares.
`ours-fleet version` prints that identity plus every `ours-fleet` it can see on
`PATH`; `ours-fleet doctor` fails when two of them share a semver but are
different builds, or when the executable on `PATH` is a different artifact from
the one running. Two prefixes holding identical content are not a conflict.
Installs predating the stamp are compared by hashing their `dist/`, so two of
those are still told apart.

A permanent role brought up via `-c custom.yaml` remembers that file (`.config-path`
in its state dir) across supervisor-triggered restarts — systemd/launchd re-invoke the
agent process with no arguments, so without this the role would silently fall back to
the default `~/fleet.yaml` on its very first crash-restart and fail to resolve.

## split configuration field reference

The following is a schematic field inventory, not a single YAML document. Host
settings belong in `~/fleet.yaml`; reusable behavior and harness settings belong
in `~/fleet/roles/<id>.yaml` and `~/fleet/brains/<id>.yaml`; operational fields
belong in `~/fleet/agents/<id>.yaml`.

```text
vars: { work_root: /home/me/work }      # ${var} substitution anywhere below
api_version: ours.network/fleet/v2
start_stagger_ms: 0                     # delay between agent LAUNCHES (host-wide, ms); 0 = no stagger
defaults:
  permissions:                         # common intent, translated by each harness/backend
    approval: ask                       # ask | auto | allow (`deny` is a deprecated alias)
    filesystem: workspace               # read-only | workspace | unrestricted
    unattended: deny                    # deny | wait
  monitor:
    mode: fleet                         # fleet (default) | native
  worklog:                              # built-ins shown; set false to opt out
    max_kb: 1024                        # rotate only above this active-log size
    keep_tail_kb: 256                   # UTF-8 tail; line-aligned when one fits
    max_archives: 12                    # recent beside log; older preserved cold
```

Agent Template document (\`~/fleet/agent_templates/Worker.yaml\`) is inert and reusable:

```yaml
role: { ref: developer }
brain: { ref: claude-default }
permissions: { approval: ask, filesystem: workspace, unattended: deny }
```

Persistent Agent instance (\`~/fleet/agents/Name.yaml\`) either remains a canonical
Role/Brain composition or explicitly reuses a template:

```yaml
template: Worker
overrides:
  cwd: /work/name
  permissions: { approval: allow }
```

Templates never create identities, supervisors, sessions, or lifecycle/status rows.
Map overrides merge recursively; scalars and arrays replace; null deletion is rejected.

Canonical Agent document (\`~/fleet/agents/Name.yaml\`):

```yaml
role: { ref: RoleID }
brain: { ref: BrainID }                  # Brain owns harness/model/session/reasoning
identity: "Display Name"                # ours identity to bind (default: Name)
cwd: ${work_root}/repo                   # where the harness process runs
coordinator: FleetCoordinator            # announce target on boot
```

Additional operational field inventory (schematic, not one YAML document):

```text
    identity: "Display Name"            # ours identity to bind (default: Name)
    cwd: ${work_root}/repo              # where the harness process runs
    coordinator: FleetCoordinator       # announce target on boot
    monitor:
      mode: fleet                       # fleet = ours-fleet supervisor; native = harness monitor
      interrupt: false                  # false queues; true cancels; after_tool steers at an ACP tool boundary
      wake_sources:                     # which daemon events wake the console (default:
        - message_received              #   message_received, file_received,
        - file_received                 #   local_contact_request, pending_message)
      batch_ms: 2000                    # coalesce a burst into one line (default 2000)
      inject: notification              # notification (default) | full (bodies inline; roadmap)
    owner_channel:                      # optional trusted owner ingress; requires a managed session
      identity: "Name Owner Channel"     # dedicated identity; fleet creates it with safe local defaults
      owners: [owner-contact-cid]        # authenticated ours contact IDs, never display names
      agent: managed-agent-cid           # exact role CID allowed to relay messages/files outward
      interrupt: false                  # false queues; true cancels current work first
      progress_interval_ms: 30000        # fleet-generated progress notices; 0 disables
      comments: true                    # relay live "🟡 Live update:" structured commentary (default true);
                                        #   restart baseline for /comments on|off
      attachments:                      # secure inbound documents, images, and voice
        enabled: true
        max_files_per_request: 4         # 1..32; rejected from metadata before retrieval
        max_file_bytes: 10485760         # 10 MiB
        max_request_bytes: 20971520      # 20 MiB total, and >= max_file_bytes
        retention_ms: 86400000           # stale crash cleanup; 1 minute..30 days
    model: claude-fable-5               # launch on a specific model (pass-through id; default: launcher default)
    mission: one line
    persona: |                          # operating contract (published as persona)
    bio: |                              # public card (published as bio)
    briefing_file: curated.md           # replaces the generated narrative
    env: { KEY: value }                 # extra session env
    oversee: [{ agent: X, interval: 5m }]
    harness_options:                    # adapter-owned, adapter-validated
      plugins: { "name@marketplace": false }   # claude-code: plugin overrides
      # mem_palace: false                      # claude-code: disable memory plugin
      # permission_mode: dontAsk               # claude-code: launch permission mode —
      #   one of default | acceptEdits | plan | dontAsk | bypassPermissions
      # Codex ACP compatibility only: native codex-app-server rejects Codex
      # permission overrides here; use the common permissions block above.
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

loops:                                    # trusted local scheduled ACP turns
  coordinator_pass:
    roles: [FleetCoordinator]             # or ["*"] for permanent roles only
    interval: 10m                         # 1m..30d
    initial_delay: 10m                    # default: one full interval; explicit 0s is immediate
    jitter: 30s                           # default 0; less than interval and at most 1h
    enabled: true
    prompt: |
      Review current fleet state once. Unstick only actionable work.
      If nothing material changed, complete silently without an owner report.
```

The v2 loader reads the manifest, then sorted bare Role, Brain, and Agent
documents from its exact stem directory. Duplicate filename-derived IDs are a
hard error. Identities and Agents are decoupled—removing an Agent never deletes
an identity. Role, Brain, and operational ownership are composed explicitly;
there is no generic cross-kind merge. Manifest operational defaults such as
`monitor` and `permissions` merge only within their owning Agent fields.

Every supervised role is a client of the operator-configured ours daemon. Fleet strips the
obsolete, presence-sensitive `OURS_AUTOSTART` variable from ACP harness
processes. `ours-mcp proxy` is client-only and never starts a daemon; operators and explicit
installer/setup flows remain responsible for starting it.

### Rooms and tasks

Init installs editable `single`, `pair`, and `team` definitions under
`~/fleet/room_templates/`, plus every exact-cased Agent, Role, and Brain they
reference. Inspect them with `ours-fleet template list` and
`ours-fleet template show team`. After configuring the authenticated owner below:

```sh
ours-fleet task create --title "Solo task" --template single
ours-fleet task create --title "Reviewed change" --template pair
ours-fleet task create --title "Phased delivery" --template team
```

`ours-fleet init -c /path/custom.yaml` reviews the literal resolved manifest and
`/path/custom/` split directory before doing anything. It requires a TTY and two
default-No confirmations. You select Codex, Claude, or both; then either one explicit
model for every job or explicit development/review/coordination models; then one
Quick/Balanced/Thorough reasoning level (`low`/`medium`/`high`). Catalog entries are
supported IDs, not recommendations or entitlement claims: use `ours-fleet doctor` for
local Codex availability, while Claude entitlement is validated at launch. No
`model_chain` is generated and Fleet never silently substitutes another model.

A successful rerun replaces the complete named manifest and split directory and keeps
a private recovery record of whichever previous target(s) existed. At either confirmation,
N, Enter, Escape, Ctrl-C, Ctrl-D, or EOF cancels. In a picker, Escape, Ctrl-C, Ctrl-D,
or EOF cancels; Enter records the highlighted choice (or continues a non-empty multi-select),
N is ignored, and an empty subscription selection remains blocked. Every cancellation
before the final Yes performs no host setup or config publication. Non-TTY use stops with
the same zero-mutation guarantee. After the final Yes, host integration runs before locked
publication; a hard kill, power loss, or host crash can therefore leave host integration
or private stage/recovery evidence to inspect.
Existing targets and their tree must be owner-private regular files/directories on the
configuration parent's filesystem; symlinks, foreign ownership, unsafe modes, and a
non-owner-controlled parent fail closed before host setup and are rechecked under the
per-setup init lock before publication.

The generated task experiences are fixed consequences, not extra questions: `single`
uses one development Agent; `pair` uses a development Secretary and independent review
Critic; `team` phases coordination Architect, development Developer, and review Tester.
FleetCoordinator uses coordination. Users with the exact generated six-worker legacy
starter set must migrate explicitly: first run `ours-fleet migrate-agent-templates -c FILE`
for a zero-write plan, then review every move/addition/recovery path and rerun with
`--write`. Customized or ambiguous known starters are refused without
mutation; unrelated custom persistent Agents are preserved.

Rooms always use `ours-cowork`; there is no room-provider selector. Configure
the cowork daemon connection and the room owner directly:

```yaml
rooms:
  cowork:
    config: /home/me/.ours-cowork/config.json
  owner:
    expected_cid: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    public_invite_file: /home/me/.ours-fleet/owner-room-invite.txt
  defaults:
    template: team
    attach_owner: true
    close_when_task_done: true

tasks:
  default_room_template: team
  create_mode: start
  close_room_on_done: true
```

Fleet launches each template member with a dedicated one-time Cowork invite.
The generated temporary-agent briefing contains the exact identity name, invite,
Cowork role, and task. The agent creates that identity itself with ours MCP
`create_temporary_identity`, accepts the invite with `add_contact`, and starts
work immediately. Fleet activates the room from Cowork's authenticated seat; there
is no briefing hash, startup ACK, or separate role-briefing readiness gate.

Set `room.anonymous: true` on a room template, or pass `--anonymous` to
`task create`, `task start`, `task work`, or `room create`, to create an
anonymous Cowork room. `--no-anonymous` explicitly overrides an anonymous
template. Fleet records the resolved value before room creation so retries keep
the same choice. Temporary members of an anonymous room are instructed to call
`create_temporary_identity` with `expose_local=false`.

Human task and room results use the same compact Markdown presentation in the
CLI and authenticated owner channel: a short heading, icon-plus-word status,
code-formatted identifiers, bounded summaries, and actionable recovery or error
steps. Untrusted prose is context-escaped and control characters are neutralized;
Messenger-bound results are capped at 3,500 Unicode code points and 12,000 UTF-8
bytes with structural omission notices. `--json` bypasses this presentation layer
and retains the versioned machine schema and serialization order.

Older prerelease files that contain the exact legacy line `provider: cowork`
under `rooms:` still load, but the key is ignored and omitted from resolved
configuration. Remove it when editing the file. Any other legacy value is an
error because fleet must not silently change the requested semantics. The
optional `rooms.owner.provider` setting is separate and defaults to
`messenger-server`.

### Scheduled agent loops

Top-level `loops` schedule literal prompts from trusted local YAML. Enabled targets
must use a managed session (`acp` or `codex-app-server`); temporary roles never inherit loops, including `roles:
["*"]`. Fleet rejects an enabled loop when its explicitly selected base config is
a symlink, is owned by another user, or is group/world writable. Prompts are
bounded and normalized at validation time, but only their size and SHA-256 appear
in `config`, `list`, logs, or durable state.

Each occurrence is idle-only. An owner, console, monitor, or earlier turn already
using the role causes that occurrence to be recorded as `skipped_busy` and
discarded. Missed ticks, races, and failures are likewise recorded once: there is
no backlog, coalescing, catch-up turn, retry-on-idle, or cadence drift. The default
first run is one full interval after startup; set `initial_delay: 0s` explicitly
for an immediate first attempt. Restart recovery marks an in-flight run abandoned,
skips overdue ticks, and resumes the fixed nominal cadence.

Operational state is a mode-0600 `.scheduled-loops.json` in the permanent role's
state directory. `disable` persists across restarts; `enable` cannot override
`enabled: false` in YAML. `reload` re-reads the remembered trusted config through
the authenticated private control socket. Prompt-only edits retain cadence;
schedule or selector changes reset that loop to its configured initial delay.
`run-now` still obeys idle-only admission and returns exit 3 when busy; an
unavailable or uncertain control plane returns exit 2 and is never retried.

A failed state write — a full disk is the case seen in practice — never stops the
manager. The failure is held in memory as `health: failed`, `anomaly:
persist_failed`; the occurrence that could not be checkpointed is recorded as
`skipped_unpersisted` rather than started, since a run that is not on disk is one
a restart would submit twice; and the manager keeps a bounded retry armed (1s
doubling to 60s) so it resumes on its own once writes land. Because that health
flip is itself unwritable, readers do not trust a stored file that has stopped
advancing: `status`, `loops status`, and `doctor` report `stale` — never the
recorded health — once the checkpoint of a role that still has a loop to run is
more than 5 minutes old. A role whose loops are all disabled stops checkpointing
by design and is never called stale. `status` asks the live control socket
whenever it is there, including when the first checkpoint never got written, and
`doctor` fails a running role that has no stored loop state at all.

A scheduled turn has typed internal provenance and no owner authority. It cannot
cancel owner work and its ordinary completion is local only. Material proactive
owner reporting remains possible solely through an already-open authenticated
owner-channel task route; a no-op Coordinator pass should complete silently.

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

**Security meaning.** For native Codex, Fleet translates `ask` → `untrusted`,
`auto` → `on-request`, and `allow` → `never`; users configure only the Fleet
names. `permissions.filesystem` independently maps `read-only` → `read-only`,
`workspace` → `workspace-write`, and `unrestricted` → `danger-full-access`.
Claude maps `ask` to `default`, `auto` to `acceptEdits`, and `allow` to
`bypassPermissions`. Codex ACP retains its adapter-specific coupled modes:
`auto` selects `agent`, while `allow` selects `agent-full-access`.
`dontAsk` suppresses only the *prompt*, not the denial, which is why an
`allow` role previously ran unable to do its job. Legacy `deny` is accepted
only for compatibility and retains its conservative Codex `on-request` /
Claude `plan` translation. `allow` is a real grant — give it deliberately, and keep per-role
[`isolation:`](#agent-isolation) as the outer boundary, which no permission
mode can cross.

ACP exposes agent-specific session mode IDs and `session/set_mode`, but no
portable permission-policy capability. Fleet uses that primitive where an
adapter has a corresponding mode and otherwise translates at the adapter. The
bundled Codex ACP adapter couples approval and sandboxing in its advertised
mode IDs. Consequently, neutral `allow` selects `agent-full-access` and widens
`filesystem: workspace` or `read-only` to `danger-full-access`; neutral `auto`
selects `agent` and uses `workspace-write` even when the neutral filesystem
value differs. An explicit `harness_options.sandbox` still wins and selects its
corresponding ACP preset; explicit native approval overrides also win. Fleet
reports a coupled-mode mismatch as approximate in `config`/`doctor`, and
per-role `isolation:` remains the boundary for an `allow` ACP role. Live session
metadata reports the normalized policy and the exact native mode selected.

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
through the shared agent session. ACP uses live steering when its adapter supports it
and falls back to structured `session/prompt`.
Set `monitor.interrupt: true` on roles where every configured wake should cancel
the active turn before the notification is delivered. This is intentionally
content-blind: the supervisor cannot inspect encrypted message bodies, so all
events selected by `wake_sources` receive the same interrupt policy.
Set `monitor.interrupt: after_tool` when a wake must preserve an in-flight ACP
tool result or pending permission. Fleet waits for terminal ACP tool/update
evidence, then steers the wake without calling `session.cancel`. If the tool is
still active after 120 seconds, or the adapter cannot expose authenticated tool
boundaries/steering, fleet visibly degrades to non-cancelling steering or queued
delivery. Explicit human and control interrupts remain immediate.
The default is `false`: a role that must begin a post-readiness mission
immediately, including second-and-later mail received while it is working, must
set `monitor.mode: fleet` and `monitor.interrupt: true` explicitly. Readiness and
mission delivery still use ordinary ours mail: the role announces readiness,
waits for a body-free `[fleet-monitor]` wake, then calls `get_messages`; fleet
does not inject the mission body through ACP.
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
mechanism (the structured `ours api watch-notifications` JSONL stream for Claude Code,
or the Codex
`arm_monitor`/`foreground_monitor` flow). The old `monitor.enabled: true|false`
form remains accepted as a compatibility alias for `fleet|native`, respectively,
but new configuration should use `mode`.

`inject: full` (pushing message bodies
inline) is on the roadmap and needs two new daemon endpoints; today all
roles deliver `notification` lines and drain via `get_messages`.

ACP stdio remains private to the persistent runner. `send`, `peek`, and the basic
ACP `attach` console use a private, authenticated per-role control socket with
typed replayable events. This is also the stable extension boundary for a richer
console later; no terminal UI is part of the monitor or session backend.

### Trusted owner channel

`owner_channel` adds a second ours identity to a role without changing the
role's normal identity. Fleet creates that dedicated permanent identity when it
is missing, with local exposure and local auto-accept disabled, and releases the
provisioning lease before the supervisor binds it. Connect it to each
owner/controller identity and the managed role identity, put the owners'
immutable contact CIDs in `owners`, and put the managed role identity's exact CID
in `agent`. The channel identity must not be any role identity or another role's
channel identity. Add it to the control plane just like another contact, then
message it directly.

The running supervisor remains the only process which binds that identity.
Rapid supervised restart uses a role-scoped single-binder lease. The old
supervisor closes its MCP proxy and authenticated control socket before
releasing the lease; the replacement waits a bounded five seconds and retries a
daemon bind only when the lease proves that holder was the same role and channel
identity. A foreign, live, or unverifiable holder remains fail-closed and is
never evicted with `force=true`.

If the matching predecessor does not release within that bound, the replacement
asks the predecessor's still-authenticated control socket to emit one fixed
recovery notice. The predecessor uses only its existing latest-owner route (or
the sole configured owner), deduplicates the notice durably by digest, and stores
no notice plaintext. When no unambiguous authenticated owner route exists, no
recipient is guessed: the failure remains in the web console and role logs. The
remote recovery action is `/restart`; repeated failures should be inspected with
`ours-fleet logs <Role>` or the web console.

Operators manage it, and an active agent turn emits bounded updates, through the
role's authenticated Unix control socket:

```sh
ours-fleet owner-channel contact list Coordinator
ours-fleet owner-channel contact invite Coordinator --name Mobile
ours-fleet owner-channel contact add Coordinator --invite-file ./invite.txt --name Mobile
# Or keep invite material out of both argv and a file:
ours-fleet owner-channel contact add Coordinator --invite-stdin

ours-fleet owner-channel owner list Coordinator
ours-fleet owner-channel owner authorize Coordinator <exact-64-hex-contact-cid>
ours-fleet owner-channel owner revoke Coordinator <exact-64-hex-contact-cid>
```

Pairing is deliberately two-step. `contact add` accepts an invite and reports a
pending contact handshake; it never grants authority. After peer verification,
use `contact list` to obtain the immutable CID, then explicitly `owner authorize`
that exact CID. Invite generation prints the invite only to stdout. Acceptance
reads it from stdin or a file, never a process argument.

Configured `owners` are the declared baseline. Authorize/revoke operations add
a bounded dynamic overlay stored beside the role state in mode 0600 and applied
immediately by the already-bound channel. `owner list` shows each CID's
`baseline`/`dynamic` source and whether it is effective. The overlay survives
session/supervisor restart; it stores only CIDs and a bounded action audit—never
invites, message bodies, credentials, or keys. A corrupt overlay fails closed
(no effective owners and no mutation), and the last effective owner cannot be
revoked.

These commands require a running role with `owner_channel` enabled. Missing,
stopped, disabled, draining, and unavailable-MCP targets fail without
starting a second client, binding an identity, or opening a network listener.

The managed agent can use its ordinary ours `send_message` or `send_file` tool to
message the channel identity. Fleet checks that the authenticated sender CID
exactly equals `agent`, then forwards the body/file to a resolved authenticated
owner route. This applies equally to blockers, suggestions, proactive notes, and
ordinary files: there is no model-selected owner recipient. An explicit reply wire
pins a file to that wire's owner; otherwise the latest authenticated owner is used.
A single configured owner is the safe fallback; multiple owners without route
history fail closed instead of guessing or broadcasting. Different devices sharing
one ours identity share one CID, while separate authorized identities naturally
hand off the unscoped route when either sends.

Messages from CIDs which are neither an owner nor the configured agent are never
injected or relayed. Fleet consumes the attempt, does not answer its sender, and
sends the latest owner a bounded warning containing the authenticated sender CID
but none of the attempted body. Repeated warnings use the existing dedupe/rate
guard so hostile mail cannot become a notification amplifier.

An owner request follows one ordered lifecycle on its authenticated source wire:

1. Fleet sends an immediate receipt describing started, queued, or interrupting state.
2. Periodic fleet-generated summaries may report allowlisted ACP activity shapes.
3. On maintained Codex ACP adapters, assistant chunks carrying the exact
   `_meta.codex.phase = "commentary"` marker are automatically batched and forwarded
   on this request's fixed owner CID/source wire, each prefixed with the single
   stable label `🟡 Live update:`. Unknown or absent phases are never
   inferred as commentary; thoughts, tools, permissions, prompts, and raw events are
   excluded by event kind. Older adapters therefore retain final-only behavior.
4. The agent may also send any non-final or out-of-turn message through its
   ordinary ours MCP tool. CID authentication is the message gate; no task ID,
   request ID, phase, reply reference, or routing command is used.
 4. The agent may send a caption and one or more files to the channel identity.
   A reply reference selects the authenticated owner of that exact source wire;
   an uncorrelated group uses the latest authenticated owner (or the sole-owner
   fallback). Fleet resolves that route once, admits every file before emitting
   any part, then sends the caption and files to the same owner on the same route.
 5. Fleet independently emits exactly one final ACP response (or a sanitized
   terminal outcome). Successful owner-request turns send regular files from the
   request outbox afterward, correlated to the same source wire.

Commentary uses a 750 ms latency flush plus paragraph and 1,600-character/6,400-byte
boundaries, with at most 32 updates and 512 in-memory fragment dedupe keys per turn.
The terminal boundary flushes commentary before the final. Replay-marked fragments,
wrong turns, wrong typed origins, missing message IDs, and unsafe/ambiguous content
fail closed. Commentary plaintext buffers and fragment keys are memory-only; bounded
wire-and-batch digests plus sending/delivered/uncertain status are persisted before
transport. Thus reconnect replay and crash recovery never blindly resend the same
batch, while an uncertain in-flight update may be omitted rather than duplicated.
The `🟡 Live update:` label is fleet-authored and applied after those safety
checks, so model content can never remove or forge it, and it is presentation
only — dedupe still keys on the unlabeled batch.

Live comments are configurable. `owner_channel.comments` (default `true`, so an
existing channel keeps relaying exactly as before) is the **restart baseline**.
The deterministic `/comments [status|on|off]` command changes only the running
session's effective value and is deliberately **not** persisted: a restart
returns to the checked-in configuration rather than to an unreviewable state
file that could silently keep an owner's channel quiet. `/comments status`
reports the live value, the baseline, and whether this session's backend emits
live comments at all. Turning comments off suppresses only the labeled messages
— receipts, progress notices, attachments, and the final answer are unaffected.

Fleet chooses the stored latest authenticated owner for every managed-agent
message; the model supplies only text and the channel contact. Relay audit logs
contain hashed wire prefixes and sizes, never bodies. A durable pre-send marker
prevents blind replay after an ambiguous transport outcome. `/interrupt` remains
an owner-only supervisor command and does not change the outbound relay contract.

Managed-agent caption/file groups have one admission and delivery boundary.
Fleet authenticates every group member, fixes one owner route before retrieval,
and validates all selected bytes before sending the caption or any file. A
correlated source wire never falls back to a different owner. Missing routes stay
queued without byte retrieval and produce at most one bounded correlated notice
per running bridge. Policy or admission rejection consumes the entire group and
sends one correlated NACK. Once outbound emission starts, any transport error is
recorded as terminal uncertain delivery: the whole group is consumed and never
blind-retried, because some parts may already have reached the owner.

Background work must not keep an ACP turn open. The agent can finalize, return to
idle, verify the later result on a future wake, and send the result to the same
channel identity with ordinary `send_message`. Fleet applies the same CID gate and
latest-owner routing as it does for an in-turn progress note.

For mobile onboarding, create or accept the contact first, wait until `contact
list` reports it established, then authorize that exact CID. Authorization and
revocation take effect immediately and the bounded mode-0600 CID overlay survives
role/supervisor restarts; update bodies do not. After restart, the supervisor is
still the sole channel binder and deferred unfinished requests retain the normal
at-least-once replay contract.

The two paths are deliberately simultaneous and have different authority:

- Mail to the role's normal `identity` remains peer mail. The content-blind
  `[fleet-monitor]` wake asks the agent to call `get_messages`; the agent sees
  provenance and replies with `send_message`. A colleague's agent cannot become
  an owner by writing instruction-like text.
- Mail to `owner_channel.identity` has two accepted origins. A CID in `owners`
  becomes a `[fleet-owner]` instruction; the exact CID in `agent` becomes a new
  outbound owner message. Every other CID is rejected and warned about without
  reflecting its body. Fleet sends request notices itself, captures the ACP
  turn's final assistant text, and sends that final back to the exact initiating
  owner with `reply_to_wire_id`.

#### Deterministic owner commands

Any owner message whose trimmed text starts with `/` is a command attempt: it is
handled by the fleet supervisor itself and never becomes an agent prompt.
Unknown or malformed commands (wrong arguments included) answer with the help
text instead of being forwarded; messages without a leading `/` reach the agent
unchanged. The registry in `src/owner-channel/commands.ts` is the single source
of truth — `/help` renders exactly that table, so adding an entry there is the
whole registration step for a new command.

| Command | Effect |
| --- | --- |
| `/help` (alias `/commands`) | list all deterministic owner-channel commands |
| `/status` | report the agent's session state |
| `/comments [status\|on\|off]` | report or change relaying of the agent's live `🟡 Live update:` messages for this session (fleet.yaml is the restart baseline) |
| `/interrupt` | cancel the agent's active turn |
| `/clear` | clear the agent's session context |
| `/compact` | compact the agent's session context |
| `/model <model-id>` | switch the model the agent runs on |
| `/restart` | restart the agent, resuming its context |
| `/force-restart` | restart the agent FRESH (context wiped) |
| `/ls` | list running fleet sessions |
| `/peek` | summarize recent session activity (event shapes only, no content) |
| `/worklog` | tail the agent's worklog |
| `/version` | report the fleet version |

Implementation strategies differ but every command is deterministic:

- `/help`, `/status`, `/comments`, `/interrupt`, `/peek`, `/worklog`, and
  `/version` are answered by the supervisor directly. `/peek` deliberately
  reports event *shapes* (kind, tool title, status) and never thought,
  agent-text, or tool output bodies. `/comments` changes only this running
  session; `owner_channel.comments` stays the restart baseline.
- `/clear`, `/compact`, and `/model` deliver the raw slash text to the agent
  harness, but only when the bundled ACP adapter for the role's harness
  verifiably executes that command locally (pinned per harness in
  `HARNESS_LOCAL_COMMANDS`): `claude-code` runs all three as Claude SDK
  builtins; `codex` runs only `/compact` — `/clear` and `/model` are not
  codex-acp builtins and would fall through to the model as an ordinary
  prompt, so they answer with a truthful refusal instead of being forwarded.
  When forwarded, fleet sends a `⏳` acceptance notice and reports the turn's
  outcome on the same wire.
- `/restart` and `/force-restart` confirm to the owner and durably mark the
  message handled FIRST, then invoke the detached `ours-fleet restart` /
  `force-restart` CLI — a successful bounce kills the supervisor process, so
  nothing can be sent afterwards. `/ls` captures the CLI listing.

Commands act only on the role whose channel received them (the restart target
and session are fixed by the channel, never by message content), and the entire
command path sits behind the authenticated owner-CID check: a non-owner sending
`/force-restart` or `/model` is silently ignored exactly like any other
unauthorized mail.

Handled wire IDs are durably bounded for deduplication, while message and
response bodies stay out of fleet state. Before consuming mail, fleet reads the
body-free oldest-first metadata from `listIncomingMessages`, atomically journals
the exact wire/sequence slice (at most 200), and calls `getMessages` with that
exact length. A returned wire/sequence set mismatch fails closed. After a crash,
journaled bodies are loaded only from persistent history with `getHistoryItem`;
the journal is pruned only after the existing durable owner-channel state marks
the wire handled. This provides at-least-once turn delivery without placing
message plaintext in fleet state.

Inbound owner attachments use the same authenticated-CID and exact-wire routing
boundary. Fleet first calls the metadata-only `listIncomingFiles`, groups a
file-only wake or a same-sender reply-linked text caption, and checks the enabled,
count, per-file size, and total-size policy before retrieving any bytes. MIME values,
extensions, file categories, and declared-versus-detected mismatches are metadata,
never rejection criteria. It then calls selective `getFiles` only for the admitted wire IDs. An
unauthorized sender is ignored without retrieval or reply. A rejected authorized
request receives a bounded reason correlated to its file wire.

Retrieved files must be regular, non-symlink paths whose byte count and SHA-256
match typed SDK metadata. Fleet detects recognizable content only to report metadata,
sanitizes traversal/control characters from names, and copies each
file into a random request-scoped directory at mode 0700 with files at mode 0600.
The `[fleet-owner]` turn receives only bounded metadata, the private local paths,
and an explicit daemon transcription result for voice messages. Successful
transcripts are included; `failed` and `unavailable` states are stated plainly so
the agent must use the audio path rather than inventing text.

The legacy `attachments.allowed_mime` key is accepted and ignored so existing
configurations continue to load. It is omitted from resolved configuration and
cannot affect attachment admission.

Request files are removed after final delivery and stale directories are removed
after `retention_ms`. A bounded mode-0600 recovery journal stores only owner CID
and wire routing metadata—never filenames, paths, captions, transcripts, or file
bytes. If a selected file is already read when fleet restarts, fleet resolves
only that journaled wire with `getFileInfo` and retrieves its immutable blob with
`fetchFile`; a claimed managed-agent caption is loaded from message history and
rejoined with its journaled read files before the group is admitted or relayed.
Recovered voice files remain transcript-unavailable and are never sent through
a second transcription attempt. Conversation route state migrates from v1 to a
bounded v2
source-wire index so a correlated group keeps the authenticated owner selected by
its original request even after later owner traffic. Corrupt recovery state disables attachment
admission. The host must run an ours daemon compatible with SDK 2.0.1 whose
typed incoming-file, selective retrieval, and file-fetch operations support
these guarantees; `ours config show --json` reports `sttConfigured` without
revealing provider credentials.

Managed-agent file egress is a separate trust direction. It retains the same
metadata provenance checks, count/per-file/request byte caps, regular-file and
no-symlink reads, actual byte-count/SHA-256 verification, filename sanitization,
private staging, fixed owner routing, and bounded body-free recovery metadata.
It deliberately does not consult `attachments.enabled`; MIME is
still detected during byte validation, but a declared-versus-detected mismatch is
not a deny gate in either direction. Markdown, HTML, octet-stream, unknown extensions,
and normal binaries are therefore routable only across their authenticated direction.
Each outbound file
gets a durable pre-send marker: a failed/ambiguous send becomes `uncertain` and is
not blindly retried, while files not yet attempted remain recoverable after restart.
Logs contain counts and byte totals, never filenames or raw bytes.

Owner channels use the structured agent-session interface for turn-correlated
assistant output and reliable automatic replies.

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
the structured CLI watcher, because a detached process cannot wake a Codex turn. The foreground
wait is re-entered after each handled message; `ours-codex` instead wakes the idle
session through its App Server integration.

The main Codex controls are Brain-owned and also available when spawning:

```yaml
# ~/fleet/brains/codex-review.yaml
harness: codex
session: codex-app-server
model: gpt-5.4
permissions:
  approval: auto
  filesystem: read-only
  unattended: deny
harness_options:
  launcher: auto
  profile: fleet
  monitor: true
  search: true
  add_dirs: [/data/shared]
  config: { model_reasoning_effort: high }
```

`codex-app-server` is the direct Codex transport and the recommended Codex
session type. It streams native items and message phases, maps Codex approval
requests into Fleet permissions, supports turn steering/interrupt, and resumes
the durable Codex thread through Fleet's shared `.session-id` lifecycle.
Configure its authority only through the shared `permissions:` block;
`on-request` and other Codex policy names are internal adapter values.
`session: acp` remains supported as a compatibility fallback and is still the
session type for Claude Code. Existing durable sessions are not assumed portable
between unrelated providers; a failed fast resume is handled by Fleet's normal
bounded fresh-session recovery.

To replace the default launcher for a native Codex role:

```yaml
session_options:
  codex_app_server:
    command: [codex, app-server]
```

The command override is exact: Fleet does not append `--profile`, `--search`, or
`app-server`, so include every required argument in the command itself.

One-off/permanent spawn selects a Brain that owns model, reasoning, native permission,
sandbox, profile, launcher, search, monitor consent, native config, and additional roots.
Use `env.OURS_PORT`/`env.OURS_CONFIG` for a
role-specific ours daemon, or configure the host default in `~/.ours/config.json`.

## Agent isolation

Each role can be sandboxed at the environment level via an `isolation:` block —
**fully additive: a role with no block behaves exactly as before.** The agent's
agent process is wrapped in [bubblewrap](https://github.com/containers/bubblewrap)
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
[`@ours.network/codex`](https://www.npmjs.com/package/@ours.network/codex);
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

WORKLOG rotation is enabled for roles by default with conservative built-ins:

```yaml
worklog:
  max_kb: 1024
  keep_tail_kb: 256
  max_archives: 12
```

Rotation is conservative: a concurrent change aborts the attempt and retries at
a later fleet lifecycle point. The active log retains a bounded UTF-8 tail,
advancing to a line boundary when a complete line fits. If one logical line
alone exceeds the tail budget, its newest suffix remains and
`.worklog-rotation.json` explicitly records the mid-line start and omitted byte
count. It also records SHA-256 digests for the archive and retained live bytes
observed when the manifest is written. The complete prior inode is published
under a collision-safe UTC name.
`max_archives` bounds recent archives beside `WORKLOG.md`; older complete
archives move to `WORKLOG.archives/` and are never deleted. Use `worklog: false` on a role or in
`defaults` to opt out. Archives may contain the same sensitive material as
`WORKLOG.md`. Rotation refuses a symlinked/non-regular live log or a symlinked
cold-archive boundary before replacing the live path, and best-effort removes a
duplicate link left by a detected failure while the original inode is still
available. These are ordinary path/error safeguards, not a security boundary
against a malicious concurrent process with the same Unix authority: intentional
symlink swaps or archive-directory renames between checks are outside the threat
model and require OS-level isolation from that process.

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
