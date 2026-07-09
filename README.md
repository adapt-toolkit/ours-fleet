# ours-fleet

**Run a fleet of persistent, securely isolated, identity-bound AI agents — across different agent
harnesses — from one declarative file.**

## What is this?

An AI coding agent in a terminal dies when you close the laptop. `ours-fleet`
turns such sessions into **roles**: long-lived agents that

- **live in a detached tmux console** you can attach to, peek at, or type into at
  any time,
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
**Claude Code** is wired in, and the adapter interface is public — each
additional harness (Codex CLI, Gemini CLI, OpenCode, …) is a small adapter. A
single fleet can mix harnesses per role:

```yaml
roles:
  Reviewer:                 # runs in Claude Code
    harness: claude-code
  Prototyper:               # (future) runs elsewhere
    harness: codex
```

## How it works

```
~/fleet.yaml + ~/fleet.d/*.yaml           your declaration
        │  ours-fleet up
        ▼
 briefing.md per role  ──►  tmux session  ──►  harness CLI (claude …)
        ▲                        │
 systemd --user / launchd ───────┘   restart on crash, start at boot/login
```

Each role gets a state dir (`~/.ours-fleet/agents/<Name>/`) holding its briefing,
logs, routines, and session markers. On boot the agent reads its briefing: bind
identity, publish bio/persona, arm a mail monitor (`ours-mcp watch`), announce to
its coordinator, work. On crash the supervisor relaunches it and the harness
resumes the same session.

The state dir contract:

| File | Owner | Lifecycle |
|---|---|---|
| `briefing.md` | generated | rewritten on every `up`/`restart`; never hand-edit |
| `WORKLOG.md` | the agent | seeded empty, agent-appended; survives restarts |
| `ROUTINES.md` | operator / agent | **optional** recurring-work instructions; re-read at the start of every wake, hot-editable **without a restart**; absence means "no routines" |
| `.identity`, `.cwd`, `.session-id`, `.booted`, `.exit-status` | supervisor | dot-marker state — session resume and boot bookkeeping |

## Prerequisites

| What | Why | Install |
|---|---|---|
| Node ≥ 20 | runs `ours-fleet` itself | nodejs.org, `apt`, or `brew` |
| tmux | every role's console | `apt install tmux` / `brew install tmux` |
| a harness CLI, logged in | the agent itself | e.g. Claude Code (`claude`) |
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
```

Permanent spawns are written to `~/fleet.d/<Name>.yaml` — your hand-written
`~/fleet.yaml` is **never** machine-edited. `ours-fleet rm <Name>` unspawns.

From inside Claude Code: install the `ours-fleet` plugin (ships in this repo under
`integrations/claude-code`) and say **"spawn ours agent …"** — the agent asks
temp-vs-permanent, co-drafts the bio and persona with you, spawns, and arms
oversight.

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
ours-fleet up|down|restart|force-restart [-c FILE] [Name...]
ours-fleet config [-c FILE]         validate + print merged plan
ours-fleet ls | attach | peek | logs [-f] | status <Name>
ours-fleet send <Name> "text" | --key <K>
ours-fleet spawn [--temp] <Name> [--mission --model --bio-file --persona-file ...]
ours-fleet rm <Name>
ours-fleet doctor [--harness H]
ours-fleet init
```

## fleet.yaml reference

```yaml
vars: { work_root: /home/me/work }      # ${var} substitution anywhere below
defaults:
  harness: claude-code                  # for roles that don't set one
  model: claude-fable-5                 # default model for roles that don't set one (per-role model / --model wins)
  max_tokens: 500000                    # session cap (harness-interpreted)
roles:
  Name:                                 # [A-Za-z0-9_-]+
    harness: claude-code
    identity: "Display Name"            # ours identity to bind (default: Name)
    cwd: ${work_root}/repo              # where the harness process runs
    coordinator: FleetCoordinator       # announce target on boot
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
never deletes an identity.

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
for the reference implementation.

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
