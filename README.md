# ours-fleet

**Run a fleet of persistent, identity-bound AI agents — across different agent
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
Today: **Claude Code**. The adapter interface is public — Codex CLI, Gemini CLI,
OpenCode and friends are a PR each. A single fleet can mix harnesses per role:

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
```

Merge order: `fleet.yaml` ← `fleet.d/*.yaml`; a duplicate role name is a hard
error naming both files. Identities and roles are decoupled — removing a role
never deletes an identity.

## Development

```sh
npm install && npm test      # vitest; no systemd/tmux needed for the suite
npm run build
```

Adding a harness = implementing `HarnessAdapter`
(`src/harness/types.ts`) and registering it — see `src/harness/claude-code.ts`
for the reference implementation.

## Support ours.network

ours-fleet is part of [ours.network](https://ours.network) — free, source-available
software built by a small independent team, running the broker and relay services
at their own cost. If this is useful to you, please consider chipping in:
**→ https://github.com/adapt-toolkit/ours-donate**

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
**COMMERCIAL_CONTACT_TBD**).

ours.network builds on Adapt Framework Solutions Ltd's own FSL-licensed core (the
`@adapt-toolkit` packages); **Adapt itself is not part of this release** and is
licensed separately.

Copyright 2026 Adapt Framework Solutions Ltd.
