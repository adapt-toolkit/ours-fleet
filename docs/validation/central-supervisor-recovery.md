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

Native Linux readiness, linger and boot ordering, physical reboot, macOS
launchd, migration of the live host, and real provider sessions remain outside
this gate. The migration/deployment preconditions and running legacy-member
limitations are described in `central-supervisor-migration.md`.
