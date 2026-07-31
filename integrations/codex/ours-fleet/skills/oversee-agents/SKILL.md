---
name: oversee-agents
description: Inspect, monitor, and unstick ours-fleet agents from Codex using their tmux or ACP session controls and supervisor state. Use when the user asks to keep an eye on agents, oversee spawned roles, check agent status, babysit a subagent, resolve a fleet prompt, or when Codex has just spawned a role and should verify its progress.
---

# Oversee ours-fleet agents

Use fleet state and console output as evidence:

```sh
ours-fleet docs
ours-fleet ls
ours-fleet peek <Name> [lines]
ours-fleet status <Name>
ours-fleet logs <Name>
ours-fleet send <Name> "<text>"
ours-fleet send <Name> --key <key>
```

Text `send`, `peek`, and `attach` work for tmux and ACP. Raw `send --key` is
tmux-only; use the `/permit` control shown by ACP `attach` for ACP permissions.

## Establish scope

Identify wards from the user's request, the current role briefing, or agents
just spawned. Confirm the desired check interval when ongoing oversight is
requested; default to five minutes only after the user agrees.

This plugin does not add a timer or a generic scheduled background monitor.
Before promising recurring checks, identify an explicit timer/recurring monitor
tool that is actually available in the current Codex session. The ours mail
monitor is event-driven and does not provide five-minute timer wakeups. If no
real timer tool is present, say that the interval cannot be armed: offer active
foreground observation or manual checks instead. Never say “I created a
recurring monitor” based only on this skill. For durable operation, recommend a
supervised coordinator role and message-driven wake through `ours-codex`, while
remaining clear that messages—not elapsed time—wake it.

## One console command is not a liveness verdict

This is the mistake that gets busy agents killed. `peek` and `send` tell you what
happened to YOUR REQUEST. Only one of their outcomes is evidence that the agent
is gone. On each check run BOTH — they answer different questions:

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

## Judge the console content

Once you know the role is alive, classify the evidence:

- **Active and progressing:** leave it alone. A long turn is not a stall.
- **Codex MCP authorization prompt:** surface the requested tool and scope.
  Session-only approval is safer for tests; persistent approval requires the
  user's explicit authorization.
- **Permission or trust dialog:** choose only an option already authorized by
  the role's mission and permission policy.
- **Question waiting for an absent user:** answer only from known mission
  context; otherwise escalate.
- **Idle with unfinished work:** ask for status and direct it to continue or
  declare `BLOCKED`.
- **Crash or shell prompt:** inspect logs and diagnose. Restart a permanent role
  with `ours-fleet restart <Name>` only once `status` confirms it is offline.
- **Completed temporary role:** report the result and let its supervisor clean
  up; stop checking it.

Never approve spending, deletion, publication, credential access, scope
expansion, `danger-full-access`, or persistent plugin trust on the user's
behalf. Escalate with the relevant pane snapshot and a concrete recommendation.

Append material interventions to the current coordinator's durable worklog when
one exists. Report the ward, observed state, action taken, and next check.
