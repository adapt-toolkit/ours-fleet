# Owner turn admission during task startup

Fleet monitor prompts wait behind an active authenticated Owner console turn.
The configured interrupt/steer policy continues to apply to other prompt sources,
and an explicit targeted Owner interrupt keeps its existing behavior.

The arbiter uses a typed active prompt source exposed by both session backends;
snapshots contain no prompt body. ACP also checks the current source when an
after-tool wait actually delivers, because its original turn can have ended and
an Owner turn can have started during that wait.

Regression coverage includes real ACP adapter/control socket fixtures with a
blocked task-member spawn request that times out while snapshots remain
responsive. Interrupt and after-tool monitor policies each queue one wake after
the Owner turn, without cancellation or a session-generation change. A delayed
boundary test replaces the original ordinary turn with an Owner turn before wake
delivery. The native backend test retains an Owner permission wait, queues its
monitor wake, and checks that explicit targeted Owner cancellation still works.

## Incident evidence and limits

A bounded read-only investigation of the 2026-10-08 22:25:30–22:28:30 UTC
startup window observed 28 `control socket: write EPIPE` journal entries in one
short burst at 22:26:55, followed by a turn-stop record at 22:26:57 whose typed
cancellation source was `fleet-monitor`. Task member services started afterward.
The task later reported active/ready without a relaunch. A second startup around
22:40 also reported `control_unavailable` before active/ready; no voice disconnect
was reported for that second event.

These observations support protecting active Owner turns from background monitor
cancellation. They do not establish the cause of the EPIPE burst, the browser
voice transport disconnect, or the readiness timeout. This change is a tested
admission guard; it does not claim incident resolution or deployed behavior.
No live service restart, host reboot, or task relaunch was used for diagnosis.
