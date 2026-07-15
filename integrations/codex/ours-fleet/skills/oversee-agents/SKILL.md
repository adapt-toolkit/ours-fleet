---
name: oversee-agents
description: Inspect, monitor, and unstick ours-fleet agents from Codex using their tmux consoles and supervisor state. Use when the user asks to keep an eye on agents, oversee spawned roles, check agent status, babysit a subagent, resolve a fleet prompt, or when Codex has just spawned a role and should verify its progress.
---

# Oversee ours-fleet agents

Use fleet state and console output as evidence:

```sh
ours-fleet ls
ours-fleet peek <Name> [lines]
ours-fleet status <Name>
ours-fleet logs <Name>
ours-fleet send <Name> "<text>"
ours-fleet send <Name> --key <key>
```

## Establish scope

Identify wards from the user's request, the current role briefing, or agents
just spawned. Confirm the desired check interval when ongoing oversight is
requested; default to five minutes only after the user agrees.

This plugin does not add a timer or Claude Code's generic scheduled background
monitor. Before promising recurring checks, identify an explicit timer/recurring
monitor tool that is actually available in the current Codex session. The ours
mail monitor is event-driven and does not provide five-minute timer wakeups. If
no real timer tool is present, say that the interval cannot be armed: offer
active foreground observation or manual checks instead. Never say “I created a
recurring monitor” based only on this skill. For durable operation, recommend a
supervised coordinator role and message-driven wake through `ours-codex`, while
remaining clear that messages—not elapsed time—wake it.

## On each check

Peek once and classify the evidence:

- **Active and progressing:** leave it alone.
- **Codex MCP authorization prompt:** surface the requested tool and scope.
  Session-only approval is safer for tests; persistent approval requires the
  user's explicit authorization.
- **Permission or trust dialog:** choose only an option already authorized by
  the role's mission and permission policy.
- **Question waiting for an absent user:** answer only from known mission
  context; otherwise escalate.
- **Idle with unfinished work:** ask for status and direct it to continue or
  declare `BLOCKED`.
- **Crash or shell prompt:** inspect logs, diagnose, then restart permanent
  roles with `ours-fleet restart <Name>` when safe.
- **Completed temporary role:** report the result and let its supervisor clean
  up; stop checking it.

Never approve spending, deletion, publication, credential access, scope
expansion, `danger-full-access`, or persistent plugin trust on the user's
behalf. Escalate with the relevant pane snapshot and a concrete recommendation.

Append material interventions to the current coordinator's durable worklog when
one exists. Report the ward, observed state, action taken, and next check.
