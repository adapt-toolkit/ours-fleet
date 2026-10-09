# Central supervisor recovery qualification

After `npm ci` and `npm run build`, run:

```sh
TMPDIR=/tmp node test/fleet-manager-recovery.integration.mjs
```

The gate creates an isolated SDK daemon and Fleet home. It uses the default
Fleet child spawn, production `_run-managed`, `runTemp`/`runSupervised`,
`runOnce`, saved owner leases, admission and real control IPC. ACP replies and
Cowork management RPCs are fixture seams; this is not a provider-session test.
The fixture never installs a native service or operates on host agent state.

The ACP wire assertions cover initial assignment once, interruption followed
by one continuation, completed idle with no new prompt, uncertain dispatch
with an explicit briefing pointer, and first-session backend-ID loss before
an established conversation. TERM/KILL of the parent preserve task CID,
daemon, logical instance, launch, admitted room and ACP session. Each member
has exactly one production worker per observed generation and its real
control socket remains responsive after recovery.

Permanent members retain the existing readiness/continuity prompt pair and
conversation ID. Parent TERM or KILL causes child IPC shutdown and an orderly
permanent owner release, so the next start renews its logical runtime instance.
The gate separately kills a direct permanent supervisor abruptly: that path
retains its logical instance. These two shutdown mechanisms have different
instance behavior; neither observation qualifies physical reboot.

Task/room deletion runs the real settlement saga with the parent up and down.
The gate injects lost responses after saved-owner release, between SDK removal
and CID verification, and after verification before artifact erasure. Retrying
must finish deletion without changing the permanent catalog or SDK identity
row. Layout retirement uses the actual owned-layout helper and erasure saga;
a borrowed permanent instance remains untouched. Live finite and task workers'
operator stops must leave a released owner journal that deletion can consume.

`MEMBER_RUNTIME_RETIREMENT_SOURCE_MISSING` means a task-supervised seat still
has an identity but neither its live launch directory nor the exact archive
for its recorded launch ID is available. Deletion stops before releasing an
unproven owner or removing the identity. Restore the original launch evidence
from the operator's backup, preserving its recorded launch/action/CID and
private owner records, then retry task deletion. If that evidence cannot be
restored, reconcile ownership explicitly; do not fabricate evidence, create a
replacement identity, redeem the original invite again or erase the private
runtime to force completion.

The only production writer of `.temp-stop-request.json` is
`stopTempSupervisor`, which writes `reason: operator-stop`. Its callers are
standalone non-task temporary removal (`ops.ts`), task launch rollback (`spawn.ts`), owned layout
retirement, task deletion, and managed room closure. Each requests deliberate
retirement. `requestedTempStopReason` accepts only `operator-stop`; other reason
values are ignored. Parent TERM/KILL/IPC shutdown does not write this file. The
gate suspends and then explicitly retires the same task member to prove both
branches. Failed launches without a published CID stay held rather than guessing
ownership; the gate reattaches the same production runtime/seat/action without
creating a second identity, then exercises the real room saga's original CID
recovery and exact retirement. This runtime-layer retry does not qualify an
automatic `task start` handover of a lost or archived launch.

Standalone task-member removal is refused by the shared CLI/web admission check.
Web preview refuses before confirmation or copying a removal archive. Retire
task-owned members through the owning task lifecycle. A missing/corrupt task
record keeps this refusal in place; restore the original task/room and exact
launch/runtime evidence from backup before retrying `task delete ID ID`. Without
restorable evidence there is no automatic cleanup path; explicit ownership
reconciliation is required, without fabricated proof or replacement identities.

Native Linux readiness, linger and boot ordering, physical reboot, macOS
launchd, migration of the live host, and real provider sessions remain outside
this gate. The migration/deployment preconditions and running legacy-member
limitations are described in `central-supervisor-migration.md`.
