# Task workspaces and artifact retention

New Tasks allocate a private workspace at
`$OURS_FLEET_HOME/.ours-fleet/workspaces/tasks/<task-id>` (the user's home is the
default for `OURS_FLEET_HOME`). New standalone Rooms use
`.ours-fleet/workspaces/rooms/<room-id>`. A linked Room shares its Task's workspace.
The absolute path, owner kind/ID and random ownership token are stored in the
record before directory allocation; `.fleet-workspace.json` proves ownership.
The path is visible in Task/Room JSON from both CLI and API. A folder of the same
name without the matching marker is never adopted.

Every newly managed member starts at that exact workspace, including retries.
An explicit template/member `cwd` remains in the sealed input execution plan as
source context, but the owned workspace overrides the effective launch cwd.
Copy or clone required source into the workspace; Fleet does not move or delete
the configured source directory. Briefings explain this rule. Use separate
per-agent branches/directories inside the workspace for concurrent edits.

All execution artifacts, dependency checkouts and worktrees belong inside the
workspace. Clone each repository there first, then use `git worktree add` with
destinations inside the same workspace. Git's native worktree registry is the
registry of record. Fleet audits `.git`, `commondir` and reverse `gitdir` links
before deletion; both the common repository and all registered worktrees must
be inside the workspace. An external repository's worktree inside the workspace,
or an internal repository's worktree outside it, blocks deletion. No broad
`git worktree prune`, branch deletion, reset or modification of unrelated Git
metadata is performed. Removing the owned repositories also removes their
complete internal worktree registries, including dirty and stale owned entries.

| Operation | Workspace and execution artifacts | Member runtime evidence |
| --- | --- | --- |
| Complete, fail, cancel | Retained while Task is recorded | Retained in Fleet recovery archives |
| Linked Room retirement or deletion | Task workspace retained | Retained |
| Internal standalone Room retirement | Room workspace retained | Retained |
| Explicit Task deletion | Removed after member retirement | All proven owned retired launches removed |
| Explicit standalone Room deletion | Removed after member retirement | All proven owned retired launches removed |

Internal room close means retirement, not destructive Task deletion.
The existing CLI `room close ID ID` remains a deprecated alias for explicit
`room delete ID ID`: it deletes standalone room-owned artifacts, but always
retains a linked Task workspace. Its repeated-ID confirmation is unchanged. To remove a Task's
artifacts, explicitly delete the Task. Cancellation is not deletion. Automatic
compatibility cleanup of legacy closed Rooms skips records with owned workspaces.
These choices reconcile close/remove wording with the requirement that completed,
recorded Tasks retain all artifacts.

Fleet's active member state (briefings, logs, session state and WORKLOG) remains
under `.ours-fleet/tmp` while supervisors run, then in
`.ours-fleet/recovery/temporary`. The launch stores the workspace descriptor.
Explicit deletion first proves managed agents retired, then identifies all
matching archived launches, including failed and replaced attempts, using the
workspace descriptor plus role and termination/launch evidence. It preflights
these archives and atomically transfers them to `.fleet-retired-agents` in the
workspace before removal. Unrelated archives are not adopted by a name prefix.
Explicit deletion also erases legacy archives with exact launch/action or room
provenance, matching private supervisor journals and admission/launch descriptors,
and the exact retired-launch rows in the global termination journal. It never
infers ownership from an Agent's shared `cwd`. Artifact removal uses a durable
manifest, ownership fingerprints and per-entry rename/removal checkpoints, so
an interrupted deletion can resume without deleting a replacement at the old path.
Task deletion acceptance receipts exist only during cleanup and are erased after
settlement (including retry after a crash between Task unlink and receipt cleanup).
Shared Fleet command audit and lifecycle delivery ledgers have exactly attributed
target labels, configuration and command arguments removed; unrelated entries are
preserved. Delivery/deduplication metadata and a content-free erased-resource ID
registry remain so a running writer cannot resurrect erased content. Infrastructure
logs without structured ownership, backups, and copies already delivered to other
identities are external retention boundaries; this is not a claim to erase every
external copy.

Provisioning serializes Task operation then Room close locks, including bounded
seat waits, so concurrent retries cannot publish competing members and deletion
cannot race a member launch. Local published Rooms are reused if the Task link
write was interrupted. Workspace allocation publishes a marked staging directory;
restart reuses the durable token. Deletion renames the validated workspace to a
token-specific sibling tombstone before removal. A crash during removal resumes
that exact tombstone; the Task record is unlinked last. Before collecting archives,
Task deletion durably checkpoints verified retirement evidence. Retries verify
any remaining original archive and still refuse replacement live member state
or a recreated identity even after the archive has been consumed. Failed deletion
remains retryable with its recorded error.

Explicit deletion restores missing owner read/write/traversal bits on real
directories inside a proven owned workspace or retired archive before the Git
audit and removal. This handles restrictive artifacts left by tests even when
they belong to the same Unix user. It adds no group/other access, follows no
artifact symlinks, crosses no mounted device boundary, and never changes the
owner. Only Git pointer files that the audit must read may gain owner-read;
hardlinked unreadable pointers are refused to avoid changing an outside alias.
Permission changes target a verified open inode. Readable foreign-UID directories
may be traversed unchanged; missing owner access is never repaired for another
UID. On Linux, traversal and Git pointer reads use pinned directory/file
descriptors, and a detected pathname replacement stops cleanup before descending.
Unreadable entries
use an `O_PATH` descriptor through `/proc/self/fd`; other platforms retain the
error if they cannot open the entry safely. A restricted workspace root is
temporarily accessible to verify its exact ownership marker; failed marker
verification restores its original mode. Partial token-derived deletion
tombstones resume directory cleanup without re-reading already-removed Git
metadata. List, show, and ordinary Git audit do not repair permissions.

An accepted deletion is hidden from ordinary task lists while cleanup settles.
Use `ours-fleet task list --include-deleting --json` (or the API's
`includeDeleting=true`) to include retained cleanup intents, and `task show ID`
to see pending/error/retry information. Disappearance from the ordinary list is
not proof of completed deletion; successful deletion removes the task record
after workspace and member cleanup.
Cowork HTTP transport failures record the RPC method, failing stage and a
bounded error category in the cleanup intent. Credential rejection remains an
explicit `unauthorized` protocol error. Transport diagnostics do not include
request bodies, credentials, URLs or raw exception text, and failed mutations
are never automatically replayed.

Deletion rejects traversal, foreign recorded paths, changed markers and symlinked
workspace ancestors. Ordinary artifact symlinks are unlinked without following
their targets. Git control symlinks and foreign pointers are refused. As with
Fleet's other filesystem lifecycle operations, a hostile same-UID process that
mutates paths during validation requires OS isolation; application checks are
not a security boundary against that process. Fleet enforces launch cwd and
safe deletion; unrestricted agents can still write outside cwd, so the artifact
placement rule also requires agent compliance and/or filesystem isolation.

## Compatibility and limits

Records from before this feature without `workspace` remain unmanaged. Existing
agents retain their cwd and exact briefing/fingerprint so restart matching works.
Fleet never claims an old cwd, an outcome artifact path, or a legacy recovery
archive as owned merely because it was mentioned by a Task. Create a new managed
Task and explicitly copy desired artifacts to migrate; deleting a legacy Task
continues its previous lifecycle and does not delete arbitrary old files.

Changing `OURS_FLEET_HOME` does not silently rebase recorded absolute ownership
paths. Restore the original state root or explicitly migrate records and files
with the supervisors stopped; mismatched paths fail closed. Archive transfer
uses same-filesystem rename and reports a recoverable failure across mounts.

Cowork's remote create operation has no idempotency key in this interface. A crash
after remote creation but before local Room publication is an existing uncertain
remote result; this change deduplicates locally recorded rooms and does not claim
to solve that remote transaction window. Inspect remote room ownership before
retrying ambiguous remote creation. No services or installed Fleet code are
changed by building or testing this feature.


## Broken provisioning and deletion recovery

Deletion accepts every lifecycle state. Missing temporary directories, identities,
remote rooms and already-erased artifacts are settled outcomes. Retry the same
explicit delete after an interruption. A missing local member CID is recovered
only from a matching authenticated seat in the pinned room (exact invite and
role, uniquely matched), or a supervisor journal tied to the selected daemon,
temporary instance and recorded creation action. These sources must agree.
The recovered CID is persisted before retirement consumes the evidence.

A contradictory CID, replacement launch, ambiguous seat, unreadable/corrupt
record, or unreachable authority is not evidence of absence. Cleanup retains its
cursor and reports the conflict instead of deleting an unrelated resource or
claiming complete erasure. An identity with no recoverable authenticated binding
requires restoring its actual ownership evidence; a name-only force removal is
not supported. Room deletion removes the linked Task's dead room/member links and preserves its workspace; use explicit
Task deletion when the request includes the associated Task and its artifacts.


## Retained task agents

Task agents use the common Fleet service and existing runners while remaining
outside the standalone agent roster. Recovery retains their original identity,
private runtime owner, launch, working directory, admitted room and supported
backend conversation. `ours-fleet task recover-members TASK_ID` resumes proven
stopped members or resets their held restart circuit; it never creates identities
or invitations. See [upgrade and rollback](fleet-migration.md) for legacy tasks.

Recovery delivers an undispatched assignment once, continues interrupted work,
and sends no readiness/work prompt to a completed idle conversation. An uncertain
dispatch gets a continuation instead of replaying the assignment. First-session
retry requires proof that no readiness/work was submitted; established session
loss requires restoration of the original context. Task agents require a resumable
harness. Missing ownership, workspace or room evidence keeps recovery held.

Parent shutdown suspends task agents. Explicit member stop terminally releases
the exact saved owner and archives its launch; it does not complete the task.
Finish/cancel/review retain their existing semantics. Task deletion stops and
unregisters only owned members, verifies identity absence and retries cleanup
before erasing task/room/workspace resources. Permanent siblings remain intact.
Standalone CLI/web removal refuses `TASK_MEMBER_IS_TASK_OWNED`; use the owning
task lifecycle. Lost/corrupt task or launch records require restoring original
backup evidence or explicit ownership reconciliation before deletion can finish.

## Owner lifecycle notifications

A task mutation commits its notification event in the same atomic task record as
its effective status. Creation, backlog, provisioning, active, review, done,
cancelled and failed are covered; block/unblock and deletion are effective changes
as well. Editing a description, list, block reason or saga checkpoint is not a
status transition. Each event freezes the task identity, title, old/new status and
navigation route at commit time, so several transitions between delivery polls
remain separate. Legacy records begin emitting on their next actual change and
are not retroactively announced as newly created.

The Fleet manager drains committed task events without requiring the web console
or restarting agents. Its notification producer uses the installation's existing
owner-scoped credential; it grants no agent arbitrary-send capability. Missing
configuration or service failure retains the events. Delivery acknowledgement
runs under the task lock and removes only the accepted event, preserving newer
changes. A corrupt/unreadable task record is isolated with a safe warning, so
other tasks continue. Bounded rotating batches prevent one rejected task from
blocking the entire sender. The built-in `default` task list is unchanged.

Deleting is announced only after its intent commits. Before unlink, settlement
prepares retained pending events plus a stable deleted event outside the task-owned
workspace. The sender admits that retained copy only when the original task record
is absent; an interrupted or failed unlink cannot announce deletion. The final
event opens the task list and includes the removed task's identity. Earlier events
keep their immutable detail routes, which may be absent after explicit deletion.

A service restart or producer crash after acceptance may replay an event; the
Notifications service must retain its acceptance receipts across read/delete to
make that replay harmless. Upgrade Notifications alongside Fleet to obtain this
stronger guarantee. The service's authenticated delivery diagnostics distinguish
provider acceptance, retry, expired subscription and foreground suppression.
Provider acceptance is not evidence of actual phone receipt. iPhone Web Push
requires a supported Home Screen installation and granted device/browser permission;
reopen the workspace to reconcile an expired subscription and explicitly re-enable
permission if it was revoked. Every received push must display a notification to
honor Safari's user-visible push requirement.
