# Retained task members

Permanent and task-created members share one Fleet OS service: a systemd user
service on Linux or a LaunchAgent on macOS. The parent reads a private member
catalog and launches the existing agent runner and SDK runtime; Fleet creates no
new per-task native service. Tasks stay outside the configured standalone roster.
Explicit supervisor mode `none` retains manual recovery after process loss.

Open task members keep their temporary external identity lifetime, private
runtime owner, cwd, launch, room admission and supported backend conversation.
Parent shutdown suspends these retained members. Explicit temporary-member stop,
terminal retirement and deletion remain retirement operations. Counted restart
limits hold failing members without rotating conversations. Missing or conflicting
ownership/context fails closed.

A private body-free cursor distinguishes original assignment pending, interrupted
work and completed idle conversation. Recovery delivers pending original work,
continues interrupted work without replaying the assignment, and leaves completed
idle sessions without another readiness/work prompt. A session not yet established
may retry only with proof that no readiness or work was submitted. Established
session loss remains held. Remote dispatch and local persistence are not atomic;
an uncertain initial dispatch gets a continuation with the briefing path.

`task recover-members` validates the task, workspace, supervisor/action, private
owner/runtime, backend context and retained room readiness. It resumes proven
stopped members or resets a held circuit. Running legacy transient members report
`migration_pending` without mutation and have not acquired boot durability.
Stopped single-room members require verified in-place adoption; legacy layout
members without durable ownership require reconciliation. Recovery never
provisions a replacement identity or invitation.

Task deletion stops and unregisters the exact owned catalog member, then releases
its saved runtime owner after seat/launch/action/CID checks. Identity removal,
absence verification and artifact erasure are retryable. Permanent agents and the
shared parent remain registered. Legacy native service retirement uses separately
retained ownership receipts, exact unit/plist hashes and native/process absence
checks; lost temporary state never bypasses this proof.

Upgrade requires explicit `ours-fleet init` and preservation of operator readiness
hooks on the common parent. Parent restart affects all members; permanent agents
retain their existing readiness/continuity prompts and may receive a new private
runtime instance after orderly release. Managed `stop` persists across reboot.
Non-resumable temporary members retire on parent shutdown, and managed native
supervision refuses a custom Fleet home. See the
[migration, legacy task and rollback runbook](central-supervisor-migration.md).

## Qualification boundaries

| Check | Required evidence | Limit |
| --- | --- | --- |
| Parent and legacy migration | Isolated Linux/macOS files and injected manager calls; exact owner/native absence and operator hook checks | No physical boot or live native service migration |
| Default parent lifecycle | Real parent/default worker spawn through existing runner, isolated daemon and SDK owner, ACP protocol fixture | No authenticated provider or live Cowork service |
| Task recovery and cleanup | Original/interrupted/idle cursor cases, TERM/KILL, parent-up/down deletion, layout retirement and retry faults at one integrated source head | Qualification results must identify their exact source head |
| Harness context retention | Runner, ACP and native transport tests | Protocol fixtures rather than provider conversations |
| Standalone roster | Fleet metadata and App companion PR | Explicit task-member inspection stays available |

This document describes acceptance criteria and scope; the PR records actual
results. Physical reboot, linger/boot ordering, macOS launchd on a real host,
live host migration and real provider sessions remain unqualified. No deployment,
merge or Owner acceptance follows from source/test qualification.
