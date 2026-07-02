---
name: oversee-agents
description: Keep an eye on ours-fleet agents you spawned or were assigned - periodically peek into their tmux consoles, unstick them (answer prompts, approve dialogs, nudge) via ours-fleet send, escalate only when unsure. Use when the user or your persona/briefing says "keep an eye on X", "oversee agents", "watch agents", or right after spawning an agent.
---

# Oversee ours-fleet agents

Your wards are subagents — you own their liveness. The core gives you two
primitives; the judgment is yours.

```bash
ours-fleet peek <Name> [lines]        # console snapshot (default 40 lines)
ours-fleet send <Name> "<text>"       # type into its console (+ Enter)
ours-fleet send <Name> --key <K>      # raw key: Escape, Up, C-c, "1", ...
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
| Permission prompt, trust dialog, numbered menu ("1. Yes…") | Answer it directly: `ours-fleet send <Name> --key 1` (or the right key/text). Prefer the safe affirmative that unblocks the task the agent was assigned. |
| A question the agent asked its (absent) user | Answer with what you know of the mission: `ours-fleet send <Name> "<answer>"`. |
| Crashed to a shell prompt / error text | Investigate (`ours-fleet logs <Name>`); for permanent roles `ours-fleet restart <Name>`; report to the owner. |
| Idle with work still assigned | Nudge: `ours-fleet send <Name> "Status? Continue with <task> or declare BLOCKED."` |
| Actively working / healthy | Nothing. Do not interrupt. |

## 4. Escalate when unsure

If the resolution would make a decision that is not yours (spending, deleting,
publishing, changing scope), do NOT press through it — message the owner or
coordinator over ours messaging (`send_message`) with the pane snapshot and your
recommendation.

## 5. Log

Append notable interventions (ward, what was stuck, what you did) to your
WORKLOG so the history survives restarts.
