# Retained task members

Open task members keep their temporary external identity lifetime and private
runtime owner. They use separate task supervisor services instead of configured
standalone agent entries. Linux units are enabled for the user default target
with linger; macOS LaunchAgents run at user login. Explicit supervisor mode
`none` remains detached and requires manual recovery after process loss.

The supervisor resumes the retained role snapshot, cwd, launch and backend
conversation. Ordinary stop suspends the managed runtime; it does not release
the identity or archive the member. The counted restart circuit persists and
never rotates task conversations to escape a failing resume. Saved ACP sessions
must support load/resume, and native resume must return the same thread ID.
Missing or conflicting ownership/context fails closed.

`task recover-members` is an explicit operator recovery path for admitted members.
It validates the task, workspace token, supervisor/action, private owner/runtime,
backend context and exact retained room readiness. It resumes stopped services
or resets a held circuit. Running legacy transient members report
`migration_pending` without mutation; stopped single-room members require verified
in-place adoption. Legacy layout members without durable ownership require
reconciliation. A recovery never provisions a replacement identity or invitation.

Boot-service intent is checkpointed on the seat or owned layout participant
before spawn and copied to deletion cursors. Service ownership is recorded
outside temporary state before installation, with
the original task/action/launch and a hash of the complete unit/plist. Cleanup
validates this proof before disabling or removing the service and deletes the
proof last. Lost temporary state and already-absent identities do not bypass
service retirement; a lost layout run with retained service proof blocks deletion.
Legacy launches with no boot-service evidence retain transient compatibility.
Existing lifecycle retirement remains terminal; terminal tasks are
not automatically relaunched.

## Qualification boundaries

| Check | Evidence | Limit |
| --- | --- | --- |
| Boot-service configuration | Isolated Linux/macOS files and injected manager calls; systemd syntax verification | No actual host boot, systemd install or launchd bootstrap |
| Supervisor process loss | Actual overlapping processes, SIGTERM, SIGKILL and successor launch | Injected harness attempt |
| Identity owner and daemon restart | Actual isolated daemon and SDK external lease; member process replacement and isolated daemon restart | Seat observation and conversation bytes are fixtures; no actual Cowork service or authenticated harness |
| Harness context retention | Runner, ACP and native transport tests | Protocol fixtures rather than provider conversations |
| Default standalone roster | Fleet configured-role/default-list regressions | Explicit temporary inspection remains supported; App Agents filtering requires its companion PR |

No deployed-service change, physical reboot or live task relaunch is part of
this source qualification. Owner acceptance and rollout are separate.
