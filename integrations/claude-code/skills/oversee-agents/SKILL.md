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

## 3. One console command is not a liveness verdict

This is the mistake that gets busy agents killed. `peek` and `send` tell you what
happened to YOUR REQUEST. Only one of their outcomes is evidence that the agent
is gone. Each tick, run BOTH — they answer different questions:

```sh
ours-fleet status <Name>     # is the role supervised and alive?
ours-fleet peek <Name>       # what is on its console right now?
```

Read the result you actually got:

- **queued** — the session accepted the prompt for '<Name>'; a turn already running is not a failure. → Nothing. Do not resend, and do not read the absence of a reply as a stall — check progress with: ours-fleet peek <Name>
- **timeout** — '<Name>' did not answer in time; a busy agent looks exactly like this. Check: ours-fleet status <Name> → Treat delivery as UNCERTAIN — the request may already have been acted on, so do not resend it blindly.
- **rejected** — '<Name>' is running and refused the request. → Fix the request, not the agent. A refusal is proof of life.
- **control-unavailable** — this says nothing about whether '<Name>' is alive — its control plane did not answer; check: ours-fleet status <Name> → Read the role logs as well. The control plane and the agent are separate things, and one being unreachable is not evidence about the other.
- **backend** — this is a transport failure, not evidence that '<Name>' is gone; check: ours-fleet status <Name> → Investigate the transport, not the agent.
- **offline** — '<Name>' is confirmed offline. → This is the ONLY result that justifies a restart on its own: ours-fleet restart <Name> for a permanent role. Read the logs first.

Never translate any other result into "dead". `ours-fleet` prints the same
liveness note the CLI derived the result from, so quote what it said rather than
paraphrasing it as "not running".

## 4. Judge the console content

Once you know the role is alive, classify what the console actually shows:

| Console shows | Action |
|---|---|
| Permission prompt or trust dialog | Answer only within already-authorized scope. Use `send --key` for tmux or the `/permit` control shown by ACP `attach`. |
| A question the agent asked its (absent) user | Answer with what you know of the mission: `ours-fleet send <Name> "<answer>"`. |
| Crashed to a shell prompt / error text | Investigate (`ours-fleet logs <Name>`); restart a permanent role only once `status` confirms it is offline. |
| Idle with work still assigned | Nudge: `ours-fleet send <Name> "Status? Continue with <task> or declare BLOCKED."` |
| Actively working / healthy | Nothing. Do not interrupt, and do not mistake a long turn for a stall. |

## 5. Escalate when unsure

If the resolution would make a decision that is not yours (spending, deleting,
publishing, changing scope), do NOT press through it — message the owner or
coordinator over ours messaging (`send_message`) with the session snapshot and your
recommendation.

## 6. Log

Append notable interventions (ward, what was stuck, what you did) to your
WORKLOG so the history survives restarts.
