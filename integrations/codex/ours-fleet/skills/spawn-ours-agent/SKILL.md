---
name: spawn-ours-agent
description: Spawn and configure a new ours-fleet agent from Codex, either as a supervised persistent role or a temporary tmux agent. Use when the user asks to spawn an agent, create a fleet role, start a background agent, delegate work to another Codex session, choose its model or permissions, or create a subagent that should have its own ours identity and console.
---

# Spawn an ours-fleet agent

Use the `ours-fleet` CLI to create the role. Do not simulate a subagent inside
the current conversation.

## 1. Check the host

Run:

```sh
ours-fleet doctor --harness codex
```

Stop at a failed required check. Explain that `ours-codex` is preferred for
background mail wake and native `codex` is the supported fallback.

## 2. Resolve the role design

Ask only for choices not already supplied:

- **Lifetime:** permanent (supervised, restartable, survives reboot) or
  temporary (one tmux session, removed on exit).
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

Offer Codex controls when relevant; otherwise use safe defaults:

- model: launcher default or `--model <id>`
- approval: `untrusted`, `on-request`, or `never`
- sandbox: `read-only`, `workspace-write`, or `danger-full-access`
- launcher: `auto` (preferred), `ours-codex`, or `codex`
- profile: `--profile <name>`
- search: `--search`
- arbitrary config: repeatable `--codex-config key=value`
- additional writable roots: repeatable `--add-dir <path>`

Default to `--harness codex --launcher auto --sandbox workspace-write
--permission-mode on-request`. Never select `danger-full-access` or `never`
without explicit user direction.

## 3. Materialize approved profile text

Use `apply_patch` to write the approved bio and persona to uniquely named files
under `/tmp`. Do not interpolate untrusted text into a shell heredoc.

## 4. Spawn

Build an argument array from the approved choices. Permanent example:

```sh
ours-fleet spawn Worker --harness codex --launcher auto \
  --mission "Own the worker implementation" --cwd /absolute/project \
  --bio-file /tmp/worker-bio.md --persona-file /tmp/worker-persona.md \
  --sandbox workspace-write --permission-mode on-request \
  --coordinator Coordinator
```

Add `--temp` for a temporary role and `--monitor` only after monitoring consent.
Pass model, profile, search, config, and additional directories exactly as
approved. Do not persist secrets in `--codex-config` or fleet YAML; use the
role's `env` configuration for environment-based credentials.

## 5. Verify the real session

Run:

```sh
ours-fleet peek <Name> 60
ours-fleet status <Name>
```

For a temporary role, status may not have a system service; the tmux console is
authoritative. Confirm that Codex loaded its briefing and reached identity
binding. First use can display Codex authorization prompts for ours MCP tools.
Surface those prompts to the user; do not grant persistent trust without their
explicit approval. Use `ours-fleet send <Name> --key <choice>` only for the
authorization scope the user approved.

If monitoring was approved, confirm the console reports `arm_monitor` success.
Under native Codex, expect the role to surface the `ours-codex` recommendation
before offering the blocking foreground fallback.

## 6. Hand off oversight

Treat the spawned role as a ward. Use the `oversee-agents` skill for immediate
checks and interventions. State clearly whether ongoing timed oversight is
actually armed or still requires manual checks.
