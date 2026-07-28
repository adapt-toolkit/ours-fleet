---
name: spawn-ours-agent
description: Spawn and configure an ours-fleet agent from Claude Code, using a permanent or temporary lifetime and a tmux or ACP session. Use when the user says "spawn ours agent", "spawn an agent", "create a fleet agent", "start a background agent", or asks for a separate supervised agent.
---

# Spawn an ours-fleet agent

Use the `ours-fleet` CLI to create the role. Do not simulate a subagent inside
the current conversation.

## 1. Read the installed CLI reference

Run:

```sh
ours-fleet docs
ours-fleet doctor
```

The installed CLI reference is authoritative for supported harnesses, session
backends, common permissions, and flags. Stop at a failed required doctor check.

## 2. Resolve the role design

Ask the requester (skip only if they already said):

- **Permanent** — written to `~/fleet.d/<Name>.yaml`, supervised (auto-restart,
  survives reboot). For roles that should stay.
- **Temporary** — detached supervisor, auto-cleaned when it exits, gone on
  reboot. For one-off background work.
- **Session:** `tmux` (detached interactive TUI) or `acp` (structured session
  with attach/peek/send control). Both lifetimes support both backends.
- **Harness:** `claude-code` or `codex`.
- **Permissions:** prefer common `approval`, `filesystem`, and `unattended`
  intent from `ours-fleet docs`; use harness-native flags only when requested.

Default to `--harness claude-code --session tmux --approval ask --filesystem
workspace --unattended deny`. Never grant `bypassPermissions`, unrestricted
filesystem access, or unattended approval without explicit user authorization.

## 3. Pick a name

`<Name>` must match `[A-Za-z0-9_-]+` (it becomes the role/service name). Check it
is free: `ours-fleet config` must not list it and `ours-fleet ls` must not show it.

## 4. Co-draft bio and persona

Draft WITH the requester, iterating until they approve:

- **Bio** — the public card peers and coordinators see (1–3 sentences: who this
  agent is, what to ask it for).
- **Persona** — the local operating contract (boundaries, quality bar, how it
  works, when it escalates).

Write approved text to uniquely named files under `/tmp` without interpolating
untrusted text into shell commands.

## 5. Spawn

Permanent (announce it to yourself if you are its coordinator):

```sh
ours-fleet spawn <Name> \
  --harness claude-code --session <tmux|acp> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md \
  --approval ask --filesystem workspace --unattended deny \
  [--cwd <dir>] [--coordinator <YourRoleName>]
```

Temporary:

```sh
ours-fleet spawn --temp <Name> \
  --harness claude-code --session <tmux|acp> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md \
  --approval ask --filesystem workspace --unattended deny
```

Pass model, permission, session, and coordinator choices exactly as approved.
Do not persist secrets in fleet YAML.

## 6. Verify

```sh
ours-fleet peek <Name> 60
ours-fleet status <Name>
```

For ACP, `status` must report `backend: acp`, `alive: true`, and a running/idle
readiness. For tmux, the pane is authoritative. Confirm the role loaded its
briefing and reached identity binding. Never answer a permission prompt beyond
the scope already approved by the user.

## 7. Arm oversight

The spawner babysits its subagent. Ask the requester for a check interval
(default **5m**), then follow the **oversee-agents** skill for `<Name>` at that
interval. If you set `--coordinator <YourRoleName>`, the new agent will announce
itself to you on boot.
