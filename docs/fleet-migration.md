# Upgrade to one Fleet service

Permanent and task agents share one systemd user service on Linux or one
LaunchAgent on macOS. Install the package and explicitly run `ours-fleet init`;
package installation alone does not migrate services. New task/temporary launches
refuse `FLEET_SERVICE_NOT_INSTALLED` until init succeeds. Native supervision uses
the OS user's home; a custom `OURS_FLEET_HOME` is refused. Manual/isolated fleets
can use `OURS_FLEET_SUPERVISOR=none` without boot recovery.

Before init, back up Fleet configuration, private member/runtime/session state,
task/room records and native units/plists. Preserve operator readiness commands,
timeout/restart settings and environment in the common parent's explicit
systemd drop-ins (`~/.config/systemd/user/ours-fleet.service.d/`). Conflicting
per-agent settings need operator resolution. Migration does not copy scripts or
silently discard hooks. Resolve `OPERATOR_DROPIN_REQUIRED` or `UNSUPPORTED_DROPIN`,
reload the user manager, verify its effective settings, then retry.

Init preflights configured permanent agents, retires only their proven old native
services and registers them after exact old-process absence. `up NAME` migrates
only NAME. Existing identity and conversation files remain in place. On Linux,
enabled legacy roles transfer running boot intent, including enabled inactive
roles; disabled inactive roles remain untouched. macOS stopped roles stay stopped.
Interrupted transfers retain receipts; retry with the original state instead of
deleting proof or starting old and new supervisors together.

The parent starts existing agent runners. Adding a member does not restart it.
Restarting the parent affects every managed agent. Permanent agents resume their
conversation with their existing readiness/continuity prompts and may receive a
new private runtime instance after orderly release. Task agents retain their
original identity, runtime owner and conversation. Managed stop persists across
parent restart/reboot. Non-resumable temporary agents retire on parent shutdown.

## Existing tasks

Running pre-upgrade transient task members remain untouched and report
`migration_pending`; init does not make them durable. Clean legacy shutdown or
explicit temporary stop releases/archives them. After abrupt process loss,
`ours-fleet task recover-members TASK_ID` can adopt a stopped single-room member
only with its original owner, identity, launch, workspace, conversation and room
admission intact and exact process absence proven. Missing/mismatched evidence
and unmarked legacy layouts require reconciliation. There is no automatic live
handover: let old work retire normally, or preserve and inspect its original
state before a controlled transition. Do not create replacement identities,
redeem invitations again or fabricate ownership records to force recovery.

## Rollback

Stop the common parent and prove all managed process groups absent. Preserve an
offline backup of catalog, receipts, private state and operator drop-ins. Restore
the prior Fleet release and reviewed legacy units/plists, enabling only intended
running agents. Keep the common parent disabled while legacy supervision runs.
Re-entering central mode requires retained-proof reconciliation and old-process
absence. Physical reboot/boot ordering, real macOS launchd and live host migration
have not been qualified by the isolated process and injected native tests.
