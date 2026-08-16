---
name: spawn-ours-agent
description: Spawn and configure a new ours-fleet agent from Codex, with a permanent or temporary lifetime and a tmux or ACP session. Use when the user asks to spawn an agent, create a fleet role, start a background agent, delegate work to another Codex session, choose its model, session, or permissions, or create a subagent with its own ours identity and console.
---

# Spawn an ours-fleet agent

Use the `ours-fleet` CLI to create the role. Do not simulate a subagent inside
the current conversation.

## 1. Read the installed CLI reference — this step is not optional

```sh
ours-fleet docs
ours-fleet doctor --harness codex
```

`ours-fleet docs` from the INSTALLED CLI is authoritative for supported session
backends, permissions, and flags. This skill ships with a plugin and the CLI is
upgraded separately, so where the two differ the installed reference wins. Stop
at a failed required doctor check.

## 2. Understand the two permission traps before you choose anything

Both traps produce the same symptom: an agent that does less than its briefing
told it to and reports no error, because the refusal happened inside the harness
with no console attached to see it.

**Trap 1 — a mode that suppresses the prompt without granting the action.** On
Claude Code this is `dontAsk`, which hides the permission prompt and still
refuses the action; it is why neutral `--approval allow` maps to
`bypassPermissions` rather than to the mode whose name sounds milder. On Codex
the same shape applies to native approval: only `never` reaches the tools
without a console, and `on-request` becomes a refusal when nobody can answer.
Judge a native mode by what it grants, not by how permissive its name sounds.

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

| Neutral intent | Native settings | Meets the floor? |
| --- | --- | --- |
| `--approval allow --filesystem workspace` | `approval=never sandbox=workspace-write` | yes |
| `--approval allow --filesystem read-only` | `approval=never sandbox=read-only` | no — no `write-state`, no `workspace-edit` |
| `--approval ask` | `approval=on-request` | no — `read-state` only |
| `--approval deny` | `approval=on-request` | no — `read-state` only |

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
  plainly. That role cannot do its job, and doctor will fail it. Reduce the job
  or get the authorization; do not paper over it with a mode that only hides
  the prompt.

Never choose `--filesystem unrestricted`, `--sandbox danger-full-access`, or a
native `--permission-mode` override without the user asking for it by name and
understanding what it grants. `harness_options` wins over the neutral block at
launch, so stating intent in both places and disagreeing is how a role runs on
settings nobody chose — `ours-fleet config` and `doctor` print a
`permission conflict: <Name>` line when that happens.

## 4. Resolve the rest of the role design

Ask only for choices not already supplied:

- **Lifetime:** permanent (supervised, restartable, survives reboot) or
  temporary (detached supervisor, removed on exit/reboot).
- **Session:** `tmux` or `acp`; both lifetimes support both.
- **Name:** `[A-Za-z0-9_-]+`; confirm it is absent from `ours-fleet config` and
  `ours-fleet ls`.
- **Mission and working directory.**
- **Bio:** public 1–3 sentence card describing scope and when peers should
  engage this role.
- **Persona:** local operating contract covering mandate, quality bar,
  boundaries, and escalation. Use the writing-agent-bios skill when available.
- **Coordinator:** optionally announce readiness to an existing ours identity.
- **Native Codex mail monitoring:** explicitly ask whether to arm it. Pass the
  legacy `--monitor` consent flag only after a clear yes. This is distinct from
  fleet YAML `monitor.mode: fleet|native`, which chooses the wake owner.

Codex-native controls, offered when relevant:

- model: launcher default or `--model <id>`
- native approval: `--permission-mode untrusted|on-request|never`
- native sandbox: `--sandbox read-only|workspace-write|danger-full-access`
- launcher: `auto` (preferred), `ours-codex`, or `codex`
- profile: `--profile <name>`
- search: `--search`
- arbitrary config: repeatable `--codex-config key=value`
- additional writable roots: repeatable `--add-dir <path>`

## 5. Materialize approved profile text

Use `apply_patch` to write the approved bio and persona to uniquely named files
under `/tmp`. Do not interpolate untrusted text into a shell heredoc.

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

Build an argument array from the approved choices. Permanent, unattended:

```sh
ours-fleet spawn Worker --harness codex --launcher auto \
  --session <tmux|acp> \
  --mission "Own the worker implementation" --cwd /absolute/project \
  --bio-file /tmp/worker-bio.md --persona-file /tmp/worker-persona.md \
  --approval allow --filesystem workspace --unattended deny \
  --isolation-file /tmp/worker-isolation.yaml \
  --coordinator Coordinator
```

Permanent, attended — a human will answer its prompts:

```sh
ours-fleet spawn Worker --harness codex --launcher auto \
  --session <tmux|acp> \
  --mission "Own the worker implementation" --cwd /absolute/project \
  --bio-file /tmp/worker-bio.md --persona-file /tmp/worker-persona.md \
  --approval ask --filesystem workspace --unattended wait
```

Add `--temp` for a temporary role; it can also use `--session acp`.
Pass the legacy `--monitor` flag only after consent to arm Codex's native
monitor. It does not select the wake owner; `monitor.mode` does that in YAML.
Pass model, profile, search, config, and additional directories exactly as
approved. Do not persist secrets in `--codex-config` or fleet YAML; use the
role's `env` configuration for environment-based credentials.

## 8. Verify the real session

```sh
ours-fleet doctor --harness codex
ours-fleet peek <Name> 60
ours-fleet status <Name>
```

Read doctor's `permissions: <Name>` and `unattended floor: <Name>` lines for the
role you just created. `permissions:` shows the neutral intent and the native
settings it translated to; the floor line lists what the role actually grants,
or names what is missing. A failure there means the role will silently do less
than its briefing says — fix the permissions rather than starting it.

For ACP, `status` must report `backend: acp`, `alive: true`, and a running/idle
readiness. For a temporary tmux role, the pane is authoritative. Confirm that
Codex loaded its briefing and reached identity binding. First use can display
Codex authorization prompts for ours MCP tools.
Surface those prompts to the user; do not grant persistent trust without their
explicit approval. Use `ours-fleet send <Name> --key <choice>` only for tmux and
only for the authorization scope the user approved; ACP permissions are answered
through `ours-fleet attach`.

If monitoring was approved, confirm the console reports `arm_monitor` success.
Under native Codex, expect the role to surface the `ours-codex` recommendation
before offering the blocking foreground fallback.

## 9. Hand off oversight

Treat the spawned role as a ward. Use the `oversee-agents` skill for immediate
checks and interventions. State clearly whether ongoing timed oversight is
actually armed or still requires manual checks.
