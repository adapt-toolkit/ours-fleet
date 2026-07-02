---
name: spawn-ours-agent
description: Spawn a new ours-fleet agent (permanent fleet role or temporary background agent) from inside a session. Use when the user says "spawn ours agent", "spawn an agent", "create a fleet agent", "start a background agent", or asks for a new subagent that should live in its own tmux session.
---

# Spawn an ours-fleet agent

You are about to create a new long-lived agent in its own tmux session, managed by
`ours-fleet`. Follow these steps in order.

## 1. Temporary or permanent?

Ask the requester (skip only if they already said):

- **Permanent** — written to `~/fleet.d/<Name>.yaml`, supervised (auto-restart,
  survives reboot). For roles that should stay.
- **Temporary** — plain tmux, auto-cleaned when it exits, gone on reboot. For
  one-off background work. Killed by you or the coordinator when done.

## 2. Pick a name

`<Name>` must match `[A-Za-z0-9_-]+` (it becomes the tmux + service name). Check it
is free: `ours-fleet config` must not list it and `ours-fleet ls` must not show it.

## 3. Co-draft bio and persona

Draft WITH the requester, iterating until they approve:

- **Bio** — the public card peers and coordinators see (1–3 sentences: who this
  agent is, what to ask it for).
- **Persona** — the local operating contract (boundaries, quality bar, how it
  works, when it escalates).

Write them to temp files to avoid shell-quoting problems:

```bash
cat > /tmp/spawn-bio.md <<'EOF'
<approved bio>
EOF
cat > /tmp/spawn-persona.md <<'EOF'
<approved persona>
EOF
```

## 4. Spawn

Permanent (announce it to yourself if you are its coordinator):

```bash
ours-fleet spawn <Name> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md \
  [--harness claude-code] [--cwd <dir>] [--coordinator <YourRoleName>]
```

Temporary:

```bash
ours-fleet spawn --temp <Name> \
  --mission "<one-line mission>" \
  --bio-file /tmp/spawn-bio.md --persona-file /tmp/spawn-persona.md
```

## 5. Verify

```bash
ours-fleet peek <Name> 30     # console snapshot — it should be booting its briefing
ours-fleet status <Name>      # permanent roles: unit state
```

## 6. Arm oversight

The spawner babysits its subagent. Ask the requester for a check interval
(default **5m**), then follow the **oversee-agents** skill for `<Name>` at that
interval. If you set `--coordinator <YourRoleName>`, the new agent will announce
itself to you on boot.
