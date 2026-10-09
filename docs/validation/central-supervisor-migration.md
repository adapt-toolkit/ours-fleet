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
`@ours.network/fleet` and binds `ours-fleet` to `dist/cli.js`. A standard launcher
symlink may resolve one level into that regular installed entry point; the
receipt records launcher and target paths. A different absolute regular
executable Node path is allowed. The loaded
fragment and each template/instance drop-in must be bounded regular files in
the expected user-unit namespace. Their hashes are recorded before retirement.
Ambiguous command quoting, extra arguments, foreign fragments, unsupported
hooks and uncertain native probes abort instead of guessing ownership.

Operator hooks remain operator-owned. A pure `ExecStart=` override can be
proven through the effective command. For shared/instance `ExecStartPre`,
integer `TimeoutStartSec`/`RestartSec`, `StartLimitIntervalSec`, `Restart`, and simple `Environment` settings,
preflight requires matching explicit directives under
`~/.config/systemd/user/ours-fleet.service.d/`. Product code does not copy a
script or drop-in into that directory. Unsupported/custom directives require
operator review; matching only the file name does not bypass the check.

The known `~/bin/ours-fleet-wait-ready` gate checks Docker health for daemon,
Cowork and gateway. Fleet's own daemon readiness wait is not equivalent.
An operator choosing to preserve this gate on the common parent must account
for its wider scope: tasks and temporary members also wait for this gate at
parent boot, and a failed gate holds the whole Fleet down. Preserve its existing
`ExecStartPre` command, `TimeoutStartSec=270`, `RestartSec=15`, `Restart=on-failure`,
`[Unit] StartLimitIntervalSec=0`, and any
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
An enabled agent previously stopped with `ours-fleet stop X` starts during Linux
migration. After migration, `stop` persists across parent restart and reboot.
These are deliberate changes from native enabled-unit boot behavior.
Readiness commands are generic operator-owned paths; migration does not read or
execute their scripts. Once registered, later operator edits to parent drop-ins
and readiness scripts do not invalidate completed adoption.

## Upgrade and migration trigger

This release requires a deliberate host transition. Package installation has no
postinstall service mutation, and Fleet has no automatic upgrade/self-update
command that runs init. Merely replacing the package leaves legacy roles running
on their installed entry points; task and temporary creation through the new CLI
is unavailable until `ours-fleet init` succeeds. It returns
`FLEET_SERVICE_NOT_INSTALLED: run ours-fleet init`, including the task-start
provisioning blocker/action in CLI and JSON output. Treat this as a deployment
precondition: schedule the package upgrade and explicit init together, preserve
operator parent drop-ins first, then verify the installed parent before accepting
new task/temp work. An uninitialised new CLI does not rewrite/install the parent
as a side effect of member creation.

`ours-fleet init` explicitly preflights and adopts all configured permanent roles
and retained task-service transfers. It can restart those agents as the native
owners retire. `up X` inspects/adopts only X and does not migrate unrelated
permanents or sweep legacy task services. A newly created catalog membership
never restarts an already running parent. Pending recorded transfers can finish
at parent boot; boot does not rediscover deliberately removed members.

Managed OS supervision currently uses the OS user's home only. A custom
`OURS_FLEET_HOME` with the real OS backend refuses `FLEET_SERVICE_HOME_CONFLICT`;
use explicit `OURS_FLEET_SUPERVISOR=none` for isolated/manual fleets. Do not
attempt to share one global native service among different managed Fleet homes.

One parent restart affects all members. Permanent agents preserve their shipped
restart behaviour: same identity CID/backend conversation and readiness plus
continuity prompts; an orderly shutdown releases their private runtime and the
next start creates its successor instance. A killed parent disconnects IPC and
requests orderly worker shutdown, so this path may also release the permanent
runtime. Directly killing a legacy runner is a different shutdown path. Task
members retain their original runtime instance, owner, admission and session;
completed idle tasks get no repeated assignment, and interrupted work gets a
short continuation notice. Plain non-resumable temporaries retire on shutdown.
These differences are explicit lifecycle behaviour, not a physical-reboot or
live-host migration qualification.

## Failure and retry

Before deployment, inspect the requested roles, package paths, service overrides
and parent override directory. For `OPERATOR_DROPIN_REQUIRED`, explicitly
preserve the named setting on the parent, reload the user manager, ensure the
parent is active with the intended settings, and retry the same Fleet operation.
For `UNSUPPORTED_DROPIN`, inspect the named directive and arrange its equivalent
ordering/environment in an operator-owned parent drop-in. Unsupported directives
must then be removed from the legacy drop-in under operator control before retry.
Resolve conflicting per-agent settings through explicit role/common-parent
configuration review. There is no default dropped-hooks acknowledgement.
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
