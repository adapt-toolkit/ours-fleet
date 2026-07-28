---
name: oversee-agents
description: Keep an eye on ours-fleet agents you spawned or were assigned, across tmux or ACP sessions. Inspect state, unstick agents through ours-fleet controls, and escalate consequential choices. Use when the user or your persona/briefing says "keep an eye on X", "oversee agents", "watch agents", or right after spawning an agent.
---

# Oversee ours-fleet agents

Your wards are subagents — you own their liveness. Run `ours-fleet docs` when
you need the installed backend-specific controls.

```sh
ours-fleet status <Name>
ours-fleet peek <Name> [lines]
ours-fleet logs <Name>
ours-fleet send <Name> "<text>"
ours-fleet send <Name> --key <K>      # tmux only
ours-fleet attach <Name>              # tmux or ACP interactive control
```

## 1. Determine your assignment

Wards and intervals come from any of:
- an explicit request ("keep an eye on Alice and Bob every 5 minutes"),
- your briefing's **## Oversight assignments** section,
- your persona text,
- an agent you just spawned (default interval 5m).

## 2. Arm the loop

Schedule a repeating check every N minutes using your harness's mechanism
(scheduled wake-ups or a persistent background monitor). One tick = check every
ward once. Keep the loop armed across restarts — re-arm it right after re-binding
your identity.

## 3. Each tick: peek and judge

Run `ours-fleet peek <Name>` per ward and classify the console:

| Console shows | Action |
|---|---|
| Permission prompt or trust dialog | Answer only within already-authorized scope. Use `send --key` for tmux or the `/permit` control shown by ACP `attach`. |
| A question the agent asked its (absent) user | Answer with what you know of the mission: `ours-fleet send <Name> "<answer>"`. |
| Crashed to a shell prompt / error text | Investigate (`ours-fleet logs <Name>`); for permanent roles `ours-fleet restart <Name>`; report to the owner. |
| Idle with work still assigned | Nudge: `ours-fleet send <Name> "Status? Continue with <task> or declare BLOCKED."` |
| Actively working / healthy | Nothing. Do not interrupt. |

## 4. Escalate when unsure

If the resolution would make a decision that is not yours (spending, deleting,
publishing, changing scope), do NOT press through it — message the owner or
coordinator over ours messaging (`send_message`) with the session snapshot and your
recommendation.

## 5. Log

Append notable interventions (ward, what was stuck, what you did) to your
WORKLOG so the history survives restarts.
