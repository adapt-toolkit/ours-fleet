# PR #99 — Compliance Matrix

Spec: `ours-fleet-rooms-tasks-ux-spec-prerelease-20260823.md`

Ownership boundary: Fleet owns task lifecycle, template resolution, agent roles, deterministic commands. Cowork owns rooms, seats, invites, messages, archives. Messenger Server owns owner UI/identity.

| Spec Section | Requirement | Status | Source / Test Reference | Notes |
|---|---|---|---|---|
| §5.3 (line 200) | Doctor: cowork socket reachability | Implemented + Tested | `src/doctor.ts:146-163` / `test/doctor.test.ts:853` | Hard fail if unreachable |
| §5.3 (line 202) | Doctor: owner CID shape (64-hex) | Implemented + Tested | `src/doctor.ts:165-170` / `test/doctor.test.ts:822` | Exact 64-hex match |
| §5.3 (line 204) | Doctor: invite presence (never content) | Implemented + Tested | `src/doctor.ts:172-179` / `test/doctor.test.ts:832,843` | Checks presence only; plaintext never logged |
| §5.3 (line 206) | Doctor: template validity + role_ref | Implemented + Tested | `src/doctor.ts:181-197` / `test/doctor.test.ts:862` | Warns on unresolvable role_ref |
| §5.3 (line 208) | Doctor: default template resolution | Implemented + Tested | `src/doctor.ts:199-211` / `test/doctor.test.ts:871,881` | Validates default template exists |
| §5.3 (line 210) | Doctor: shared-daemon / cowork config path | Implemented + Tested | `src/doctor.ts:213-223` / `test/doctor.test.ts:904` | Validates cowork config coherence |
| §5.3 (line 212) | Doctor: hard prerelease capability check | Implemented + Tested | `src/doctor.ts:225-243` / `test/doctor.test.ts:914` | listRooms RPC probe |
| §5.3 bonus | Doctor: stale task/room cross-references | Implemented + Tested | `src/doctor.ts:245-268` / `test/doctor.test.ts:890` | Warn-level, not hard fail |
| §6 (line 220) | Split config: rooms section with unknown-key rejection | Implemented + Tested | `src/rooms-tasks/config.ts:66` / `test/rooms-tasks.test.ts:613,636` | rejectUnknown() on all sections |
| §6 (line 222) | Split config: tasks section | Implemented + Tested | `src/rooms-tasks/config.ts:66`, `types.ts:196-201` / `test/rooms-tasks.test.ts:675` | TASKS_KEYS enforced |
| §6 (line 224) | Split config: room_templates section | Implemented + Tested | `src/rooms-tasks/config.ts:66`, `types.ts:203` / `test/rooms-tasks.test.ts:745` | TEMPLATE_KEYS enforced |
| §7.1 (line 260) | TaskRecord: task_id, title, state, origin, created_at, idempotency_key | Implemented + Tested | `src/rooms-tasks/types.ts:51-69` / `test/rooms-tasks.test.ts:157+` | All required fields present |
| §7.1 (line 264) | TaskRecord: brief, brief_file | Implemented + Tested | `src/rooms-tasks/types.ts:54-55`, `task-state.ts:56-57,75-76` / `test/owner-channel-commands.test.ts:507` | Multi-line brief supported |
| §7.1 (line 266) | TaskRecord: template (TaskTemplateRef) | Implemented + Tested | `src/rooms-tasks/types.ts:58`, `task-state.ts:58,78` / `test/rooms-tasks.test.ts:411` | name@version + content_hash |
| §7.1 (line 268) | TaskRecord: no_room flag | Implemented + Tested | `src/rooms-tasks/types.ts:59`, `task-state.ts:62,79` / `test/owner-channel-commands.test.ts:495,519` | Skips room provisioning |
| §7.1 (line 270) | TaskRecord: room_id, room_identity_cid | Implemented | `src/rooms-tasks/types.ts:60-61`, `task-state.ts:190-200` | Set post-provisioning |
| §7.1 (line 272) | TaskRecord: member_roles | Implemented | `src/rooms-tasks/types.ts:62`, `task-state.ts:202-207` | TaskMemberRole[] |
| §7.1 (line 274) | TaskRecord: blocked, outcome, timestamps | Implemented + Tested | `src/rooms-tasks/types.ts:57,68,65-67`, `task-state.ts:131-145` / `test/rooms-tasks.test.ts:298+` | block/unblock tested |
| §7.2 (line 280) | Task lifecycle: backlog → provisioning → active → review → done | Implemented + Tested | `src/rooms-tasks/task-state.ts:37-45` / `test/rooms-tasks.test.ts:210+` | VALID_TRANSITIONS enforced |
| §7.2 (line 282) | Task lifecycle: cancelled from backlog/provisioning/active/review | Implemented + Tested | `src/rooms-tasks/task-state.ts:38-41`, `types.ts:21` / `test/rooms-tasks.test.ts:247+` | TASK_CANCELLABLE_STATES |
| §7.2 (line 284) | Task lifecycle: failed from provisioning/active/review | Implemented + Tested | `src/rooms-tasks/task-state.ts:39-41` / `test/rooms-tasks.test.ts:263+` | With error message |
| §7.2 (line 286) | Task lifecycle: start=false → backlog | Implemented + Tested | `src/rooms-tasks/task-state.ts:71` / `test/owner-channel-commands.test.ts:519` | --backlog flag |
| §8 (line 300) | RoomOrchestrationRecord: room_id, room_name, state, saga, created_at | Implemented + Tested | `src/rooms-tasks/types.ts:110-126`, `room-state.ts:36-53` / `test/rooms-tasks.test.ts:411+` | Full saga cursor |
| §8 (line 302) | RoomOrchestrationRecord: goal field | Implemented + Tested | `src/rooms-tasks/types.ts:114`, `room-state.ts:30,43` / `test/owner-channel-commands.test.ts:679` | Multi-line goal supported |
| §8 (line 304) | RoomOrchestrationRecord: template_snapshot | Implemented + Tested | `src/rooms-tasks/types.ts:116`, `room-state.ts:33,46` / `test/owner-channel-commands.test.ts:657` | Frozen at creation time |
| §8 (line 306) | Room saga phases | Implemented | `src/rooms-tasks/types.ts:76-85`, `room-state.ts:78-89` | persist_intent → … → completed/failed |
| §8 (line 308) | Room provisioning_detail | Implemented | `src/rooms-tasks/types.ts:94-101,118` | waiting_cowork, owner_cid_mismatch, etc. |
| §8 (line 310) | Room member seats | Implemented + Tested | `src/rooms-tasks/types.ts:102-108`, `room-state.ts:128-136` / `test/rooms-tasks.test.ts:492` | pending/active/removed |
| §8 (line 312) | Room owner seat + invite fingerprint | Implemented + Tested | `src/rooms-tasks/room-state.ts:116-126` / `test/rooms-tasks.test.ts:485` | SHA-256 fingerprint only |
| §8 (line 314) | Room close | Implemented + Tested | `src/rooms-tasks/room-state.ts:148-155` / `test/rooms-tasks.test.ts:515+` | Idempotent close |
| §9.1 (line 339) | CLI: `fleet template show <name>` | Implemented | `src/rooms-tasks/cli.ts:128+` | --json supported |
| §9.1 (line 341) | CLI: `fleet template list` | Implemented | `src/rooms-tasks/cli.ts:128+` | Merged builtin + custom |
| §9.2 (line 345) | CLI: `fleet task create` | Implemented + Tested | `src/rooms-tasks/cli.ts:201+` / `test/owner-channel-commands.test.ts:495+` | --brief, --brief-file, --template |
| §9.2 (line 347) | CLI: `fleet task list` | Implemented | `src/rooms-tasks/cli.ts:201+` | --state filter, --json |
| §9.2 (line 349) | CLI: `fleet task show <id>` | Implemented | `src/rooms-tasks/cli.ts:201+` | --json |
| §9.2 (line 350) | CLI: `fleet task create --no-room` | Implemented + Tested | `src/rooms-tasks/cli.ts:211` / `test/owner-channel-commands.test.ts:495` | Wired to task-state |
| §9.2 (line 352) | CLI: `fleet task start/block/unblock/review/done/cancel` | Implemented | `src/rooms-tasks/cli.ts:201+` | All lifecycle commands |
| §9.3 (line 364) | CLI: `fleet room create` | Implemented + Tested | `src/rooms-tasks/cli.ts:512+` / `test/owner-channel-commands.test.ts:657` | --template, --goal, --brief |
| §9.3 (line 366) | CLI: `fleet room list` | Implemented | `src/rooms-tasks/cli.ts:512+` | --state filter, --json |
| §9.3 (line 368) | CLI: `fleet room show <id>` | Implemented | `src/rooms-tasks/cli.ts:512+` | --json |
| §9.3 (line 370) | CLI: `fleet room close <id>` | Implemented | `src/rooms-tasks/cli.ts:512+` | |
| §10.2 (line 390) | Owner-channel: `/task create <title>` | Implemented + Tested | `src/owner-channel/commands.ts:256` / `test/owner-channel-commands.test.ts:495+` | Newline-aware arg parsing |
| §10.2 (line 393) | Owner-channel: multi-line brief (lines after first) | Implemented + Tested | `src/owner-channel/commands.ts:233,256` / `test/owner-channel-commands.test.ts:507,519` | trailingLines extracted |
| §10.2 (line 396) | Owner-channel: `/task list` | Implemented + Tested | `src/owner-channel/commands.ts:279` / `test/owner-channel-commands.test.ts` | |
| §10.2 (line 398) | Owner-channel: `/task show <id>` | Implemented + Tested | `src/owner-channel/commands.ts:303` / `test/owner-channel-commands.test.ts` | |
| §10.2 (line 400) | Owner-channel: `/task start/block/unblock/review/done/cancel` | Implemented + Tested | `src/owner-channel/commands.ts:308-353` / `test/owner-channel-commands.test.ts` | All subcommands |
| §10.2 (line 406) | Owner-channel: `/room create <name>` with multi-line goal | Implemented + Tested | `src/owner-channel/commands.ts:425` / `test/owner-channel-commands.test.ts:679` | goal from trailingLines |
| §10.2 (line 408) | Owner-channel: `/room create --template=<name>` | Implemented + Tested | `src/owner-channel/commands.ts:425` / `test/owner-channel-commands.test.ts:657,672` | resolveTemplate + snapshot |
| §10.2 (line 410) | Owner-channel: `/room list` | Implemented + Tested | `src/owner-channel/commands.ts:450` / `test/owner-channel-commands.test.ts` | |
| §10.2 (line 412) | Owner-channel: `/room show/close/recover` | Implemented + Tested | `src/owner-channel/commands.ts:461-474` / `test/owner-channel-commands.test.ts` | |
| §10.2 (line 414) | Owner-channel: `/template show/list` | Implemented + Tested | `src/owner-channel/commands.ts:536,541` / `test/owner-channel-commands.test.ts` | |
| §10.3 (line 419) | Immediate feedback format | Implemented | `src/owner-channel/commands.ts` | Structured reply messages |
| §12 (line 471) | Security: invite plaintext never persisted (SHA-256 fingerprint only) | Implemented + Tested | `src/rooms-tasks/config.ts:39` / `test/rooms-tasks.test.ts:578,774` | fingerprint() returns hex SHA-256 |
| §12 (line 473) | Security: invite redacted in validated config | Implemented + Tested | `src/rooms-tasks/config.ts:102` / `test/rooms-tasks.test.ts:578` | `public_invite: '[REDACTED]'` |
| §12 (line 475) | Security: owner CID pinning (exact 64-hex) | Implemented + Tested | `src/rooms-tasks/config.ts:91-94` / `test/rooms-tasks.test.ts:558-575` | Lowercase-normalized, rejects short/invalid |
| §12 (line 477) | Security: unknown config keys rejected | Implemented + Tested | `src/rooms-tasks/config.ts:36` / `test/rooms-tasks.test.ts:613,636,675,745` | rejectUnknown() on all sections |
| Templates | Built-in templates: development-team, research-decision | Implemented + Tested | `src/rooms-tasks/templates.ts:41` / `test/rooms-tasks.test.ts:47+` | name@version resolution |
| Templates | Template snapshot with content_hash | Implemented + Tested | `src/rooms-tasks/templates.ts:51` / `test/rooms-tasks.test.ts:144` | Frozen at room creation |
| Templates | Custom template override of builtins | Implemented + Tested | `src/rooms-tasks/templates.ts:55,77` / `test/rooms-tasks.test.ts:68+` | override_builtin flag |

## Excluded (not ours-fleet-owned)

| Spec Section | Requirement | Owner | Justification |
|---|---|---|---|
| §10.4 | Messenger room appearance (name, avatar, topic) | ours-messenger-server | TARGET/BLOCKED — Messenger Server owns room presentation |
| §11 | Direct room interaction (send messages, files, read) | ours-cowork | Cowork owns room content and messaging |
| §13 | Room seats, invites, membership management | ours-cowork | Cowork owns membership lifecycle |
| §14 | Web mapping / public URLs | Future scope | Explicitly deferred in spec |
| §8 (runtime) | Actual cowork RPC calls (createRoom, addMember, etc.) | ours-cowork | Fleet stores orchestration records; cowork executes room operations |
