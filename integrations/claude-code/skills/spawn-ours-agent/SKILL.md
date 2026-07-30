---
name: spawn-ours-agent
description: Spawn and configure an ours-fleet agent from Claude Code, using a permanent or temporary lifetime and a tmux or ACP session. Use when the user says "spawn ours agent", "spawn an agent", "create a fleet agent", "start a background agent", or asks for a separate supervised agent.
---

# Spawn an ours-fleet agent

Use the `ours-fleet` CLI to create the role. Do not simulate a subagent inside
the current conversation.

## 1. Read the installed CLI reference — this step is not optional

```sh
ours-fleet docs
ours-fleet doctor
```

`ours-fleet docs` from the INSTALLED CLI is authoritative for supported
harnesses, session backends, permissions, and flags. This skill ships with a
plugin and the CLI is upgraded separately, so where the two differ the installed
reference wins. Stop at a failed required doctor check.

## 2. Understand the two permission traps before you choose anything

Both traps produce the same symptom: an agent that does less than its briefing
told it to and reports no error, because the refusal happened inside the harness
with no console attached to see it.

**Trap 1 — a mode that suppresses the prompt without granting the action.**
Claude's `dontAsk` hides the permission prompt and still refuses the action. It
reads like a grant and is not one. This is why neutral `--approval allow` maps
to `bypassPermissions`, which genuinely permits what the role was authorized to
do. Nothing else is elevated: `ask` stays on Claude's default mode and `deny`
maps to `plan`.

**Trap 2 — the unattended capability floor.** A role with no console cannot
answer a permission request, so the request is refused. `ours-fleet` checks each
role's resolved permissions against a fixed floor before launch:

- `read-state` — read its briefing, ROUTINES.md, and WORKLOG.md
- `write-state` — append its WORKLOG and its own state files
- `messaging` — bind its identity, send and receive ours mail
- `monitor` — arm and observe its mail monitor
- `workspace-edit` — edit and test files in its working directory
- `status-commands` — run the inspection commands its briefing prescribes

`ours-fleet config` and `ours-fleet doctor` report this per role as
`unattended floor: <Name>`. Under `--unattended deny` a shortfall FAILS doctor,
because those requests will be denied silently. Under `--unattended wait` it
warns, because a human can still attach and answer.

What this means in practice, on this harness:

| Neutral intent | Native mode | Meets the floor? |
| --- | --- | --- |
| `--approval allow --filesystem workspace` | `bypassPermissions` | yes |
| `--approval allow --filesystem read-only` | `bypassPermissions` | no — no `write-state`, no `workspace-edit` |
| `--approval ask` | Claude's default | no — `read-state` only |
| `--approval deny` | `plan` | no — `read-state` only |
| `harness_options.permission_mode: dontAsk` | `dontAsk` | no — `read-state`, `status-commands` |

## 3. Choose permissions from the job, not from a default

There is no safe blanket default. Ask what the role has to do and whether the
user authorizes it, then pick:

- **It must work with nobody watching** (the usual reason to spawn a fleet
  role): it needs `--approval allow --filesystem workspace`. That is a real
  grant, so get the user's explicit authorization for it, and confine the role
  with `--isolation-file` rather than by withholding permissions it needs.
  Use `--unattended deny` so the role never blocks on an unanswerable request.
- **A human will attach and answer prompts**: `--approval ask --filesystem
  workspace --unattended wait`. Doctor warns that the floor is unmet — that
  warning is correct and expected; the role will block until someone answers.
- **The user will not authorize `allow`, and nobody will attend it**: say so
  plainly. That role cannot do its job, and doctor will fail it. Reduce the
  job or get the authorization; do not paper over it with `dontAsk`.

Never choose `--filesystem unrestricted`, `harness_options.permission_mode:
bypassPermissions` written directly, or `dontAsk` without the user asking for
it by name and understanding what it grants.

## 4. Pick a name

`<Name>` must match `[A-Za-z0-9_-]+` (it becomes the role/service name). Check it
is free: `ours-fleet config` must not list it and `ours-fleet ls` must not show it.

## 5. Co-draft bio and persona

Draft WITH the requester, iterating until they approve:

- **Bio** — the public card peers and coordinators see (1–3 sentences: who this
  agent is, what to ask it for).
- **Persona** — the local operating contract (boundaries, quality bar, how it
  works, when it escalates).

Write approved text to uniquely named files under `/tmp` without interpolating
untrusted text into shell commands.

## 6. Confine the role at creation, not later

`--isolation-file <path>` supplies the role's sandbox policy at creation, so the
FIRST launch is already confined. A role that only gains `isolation:` on a later
`up` ran unsandboxed until then. The file holds exactly the `isolation:` mapping
documented in `ours-fleet docs` and nothing else:

```yaml
network: deny
fs:
  read: [/opt/reference]
resources:
  mem: 2G
```

An invalid file is rejected before anything is created — no config, no state
directory, no identity reservation. This is the right control for a role that
needs `--approval allow`: isolation is the outer boundary a permission mode
cannot cross.

## 7. Spawn

Permanent, unattended (announce it to yourself if you are its coordinator):

```sh
ours-fleet spawn <Name> \
  --harness claude-code --session <tmux|acp> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md \
  --approval allow --filesystem workspace --unattended deny \
  --isolation-file /tmp/spawn-isolation.yaml \
  [--cwd <dir>] [--coordinator <YourRoleName>]
```

Permanent, attended — a human will answer its prompts:

```sh
ours-fleet spawn <Name> \
  --harness claude-code --session <tmux|acp> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md \
  --approval ask --filesystem workspace --unattended wait
```

Temporary — add `--temp`; it supports both session backends:

```sh
ours-fleet spawn --temp <Name> \
  --harness claude-code --session <tmux|acp> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md \
  --approval allow --filesystem workspace --unattended deny
```

Pass model, permission, session, and coordinator choices exactly as approved.
Do not persist secrets in fleet YAML.

## 8. Verify

```sh
ours-fleet doctor
ours-fleet peek <Name> 60
ours-fleet status <Name>
```

Read doctor's `permissions: <Name>` and `unattended floor: <Name>` lines for the
role you just created. `permissions:` shows the neutral intent and the native
settings it translated to; the floor line lists what the role actually grants,
or names what is missing. A failure there means the role will silently do less
than its briefing says — fix the permissions rather than starting it.

For ACP, `status` must report `backend: acp`, `alive: true`, and a running/idle
readiness. For tmux, the pane is authoritative. Confirm the role loaded its
briefing and reached identity binding. Never answer a permission prompt beyond
the scope already approved by the user.

## 9. Arm oversight

The spawner babysits its subagent. Ask the requester for a check interval
(default **5m**), then follow the **oversee-agents** skill for `<Name>` at that
interval. If you set `--coordinator <YourRoleName>`, the new agent will announce
itself to you on boot.
