---
name: spawn-ours-agent
description: Spawn and configure a new ours-fleet agent from Codex, with a permanent or temporary lifetime and a tmux or ACP session. Use when the user asks to spawn an agent, create a fleet role, start a background agent, delegate work to another Codex session, choose its model, session, or permissions, or create a subagent with its own ours identity and console.
---

# Spawn an ours-fleet agent

Use the `ours-fleet` CLI to create the role. Do not simulate a subagent inside
the current conversation.

## 1. Check the host

Run:

```sh
ours-fleet docs
ours-fleet doctor --harness codex
```

Treat `ours-fleet docs` from the installed CLI as authoritative for supported
session backends, common permissions, and flags. Stop at a failed required
doctor check.

## 2. Resolve the role design

Ask only for choices not already supplied:

- **Lifetime:** permanent (supervised, restartable, survives reboot) or
  temporary (detached supervisor, removed on exit/reboot).
- **Session:** `tmux` or `acp`; both permanent and temporary roles support both.
- **Name:** `[A-Za-z0-9_-]+`; confirm it is absent from `ours-fleet config` and
  `ours-fleet ls`.
- **Mission and working directory.**
- **Bio:** public 1–3 sentence card describing scope and when peers should
  engage this role.
- **Persona:** local operating contract covering mandate, quality bar,
  boundaries, and escalation. Use the writing-agent-bios skill when available.
- **Coordinator:** optionally announce readiness to an existing ours identity.
- **Mail monitoring:** explicitly ask whether to arm it. Pass `--monitor` only
  after a clear yes. This consent persists in the role configuration.

Prefer common permission intent:

- approval: `--approval ask|allow|deny`
- filesystem: `--filesystem read-only|workspace|unrestricted`
- unattended ACP behavior: `--unattended deny|wait`

Offer Codex-native controls when relevant:

- model: launcher default or `--model <id>`
- native approval: `--permission-mode untrusted|on-request|never`
- native sandbox: `--sandbox read-only|workspace-write|danger-full-access`
- launcher: `auto` (preferred), `ours-codex`, or `codex`
- profile: `--profile <name>`
- search: `--search`
- arbitrary config: repeatable `--codex-config key=value`
- additional writable roots: repeatable `--add-dir <path>`

Default to `--harness codex --session tmux --launcher auto --approval ask
--filesystem workspace --unattended deny`. Never select unrestricted access,
`danger-full-access`, `never`, or common `allow` without explicit user direction.

## 3. Materialize approved profile text

Use `apply_patch` to write the approved bio and persona to uniquely named files
under `/tmp`. Do not interpolate untrusted text into a shell heredoc.

## 4. Spawn

Build an argument array from the approved choices. Permanent example:

```sh
ours-fleet spawn Worker --harness codex --launcher auto \
  --session <tmux|acp> \
  --mission "Own the worker implementation" --cwd /absolute/project \
  --bio-file /tmp/worker-bio.md --persona-file /tmp/worker-persona.md \
  --approval ask --filesystem workspace --unattended deny \
  --coordinator Coordinator
```

Add `--temp` for a temporary role; it can also use `--session acp`.
Pass `--monitor` only after monitoring consent.
Pass model, profile, search, config, and additional directories exactly as
approved. Do not persist secrets in `--codex-config` or fleet YAML; use the
role's `env` configuration for environment-based credentials.

## 5. Verify the real session

Run:

```sh
ours-fleet peek <Name> 60
ours-fleet status <Name>
```

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

## 6. Hand off oversight

Treat the spawned role as a ward. Use the `oversee-agents` skill for immediate
checks and interventions. State clearly whether ongoing timed oversight is
actually armed or still requires manual checks.
