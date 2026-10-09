# Permanent-member migration to one Fleet service

This is a deployment runbook, not evidence of a deployment or physical reboot.
The isolated tests are `test/legacy-permanent-migration.test.ts`. Native Linux
and macOS calls are injected; no live services are changed by that test.

Migration inspects only configured permanent names with matching `.identity`
and `.config-path`. It preserves identity, `.session-id`, `.booted`, runtime
journals and room admission. It does not enumerate and adopt arbitrary native
instances, remove the shared legacy template, or create a new conversation.

On Linux, machine-readable effective `ExecStart` must be exactly Node plus a
Fleet CLI, `_run`, and the configured name (or the direct Fleet executable).
An older CLI path is allowed when its regular installed package identifies
`@ours.network/fleet` and binds `ours-fleet` to `dist/cli.js`. The loaded
fragment and each template/instance drop-in must be bounded regular files in
the expected user-unit namespace. Their hashes are recorded before retirement.
Ambiguous command quoting, extra arguments, foreign fragments, unsupported
hooks and uncertain native probes abort instead of guessing ownership.

Operator hooks remain operator-owned. A pure `ExecStart=` override can be
proven through the effective command. For shared/instance `ExecStartPre`,
integer `TimeoutStartSec`/`RestartSec`, and simple `Environment` settings,
preflight requires matching explicit directives under
`~/.config/systemd/user/ours-fleet.service.d/`. Product code does not copy a
script or drop-in into that directory. Unsupported/custom directives require
operator review; matching only the file name does not bypass the check.

The known `~/bin/ours-fleet-wait-ready` gate checks Docker health for daemon,
Cowork and gateway. Fleet's own daemon readiness wait is not equivalent.
An operator choosing to preserve this gate on the common parent must account
for its wider scope: tasks and temporary members also wait for this gate at
parent boot, and a failed gate holds the whole Fleet down. Preserve its reset
`ExecStartPre=` line and command, `TimeoutStartSec=270`, `RestartSec=15`, and any
applicable environment settings in the explicit parent drop-in. Keep that
drop-in across future installs; generated unit updates leave it untouched.
Different per-agent environments cannot silently become one parent environment.

All requested roles pass read-only preflight before any receipt or native
mutation. `prepareParent` then ensures the common parent is running without
restarting an existing parent. Immediately before native retirement, migration
rechecks proofs and, when operator settings exist, verifies the parent's
loaded effective readiness, timeout, restart and environment settings. It then
disables only the proven old Linux instance, or unloads/removes the proven
macOS plist. Exact native inactivity/MainPID absence and absence of the old
Fleet-home runner are required before central registration.

Linux enabled units retain **boot intent** as desired `running`, including
enabled inactive/failed units. Disabled inactive units remain untouched;
disabled active units require operator resolution. On macOS a stopped or
unloaded proven plist transfers desired `stopped`. A later stopped catalog
record remains stopped when a registration reply is lost and migration retries.

## Failure and retry

Before deployment, inspect the requested roles, package paths, service overrides
and parent override directory. For `OPERATOR_DROPIN_REQUIRED`, explicitly
preserve the named setting on the parent, reload the user manager, ensure the
parent is active with the intended settings, and retry the same Fleet operation.
For unsupported hooks or conflicting per-agent settings, resolve the conflict
as an operator before retrying. There is no default dropped-hooks acknowledgement.
Do not describe partial migration as a completed one-service deployment.

A preflight failure changes no requested native role. A later runtime failure
can occur after an earlier member has been adopted; the already-running parent
continues supervising its registered members. Receipts outside the old native
paths distinguish `prepared`, `native-retired`, and `registered`. Re-run with
the same identities/configuration to finish pending members. A new Fleet CLI
release can finish an interrupted receipt; the receipt retains the original
legacy CLI and native artifact hashes rather than pinning the invoking release.
Do not delete receipts to bypass a native conflict, changed file or surviving
process. Restore or explicitly reconcile the recorded proof first. Linux
process checks exclude the same name in a different Fleet home; unreadable
matching process ownership fails closed. The macOS process fallback is more
conservative and its real-host behavior remains unqualified.

## Controlled rollback

Do not start legacy native instances alongside catalog members. Stop the common
parent and prove its managed generations/process groups absent first. Preserve
an offline backup of catalog, receipts, private agent state, and operator
drop-ins. Restore the prior known-good Fleet release and the operator-reviewed
legacy units/plists. Enable only the intended running roles; preserve deliberate
stopped roles and all existing identity/conversation files. Keep the central
parent disabled while legacy supervision is active. Re-entering central mode
requires reconciliation of the retained catalog/receipts and exact native
absence before restarting managed members. This is an operator recovery
procedure; automated downgrade, live rollback, linger/boot ordering and macOS
launchd have not been physically qualified by the injected migration tests.
