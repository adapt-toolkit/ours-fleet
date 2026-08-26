# Role, Brain, and Agent architecture

Status: approved specification. Repository implementation is authorized; live
migration, deploy, merge, publish, restart, service/process/identity changes, and
room mutations are outside that authorization.

Base: `adapt-toolkit/ours-fleet` commit `8272b2f` (`origin/main` as present on
2026-08-26). Normative terms MUST, MUST NOT, SHOULD, and MAY have their usual
RFC 2119 meanings.

## 1. Goals and invariants

Fleet separates three concepts:

- A **Role** is inert behavior: public bio, local persona, mission/operating
  contract, and declared capabilities. It has no identity, Brain, process,
  session, permissions, or lifecycle.
- A **Brain** is an inert execution template defined by exactly four fields:
  `harness`, `model`, `effort`, and `session`. It has no identity, behavior,
  permissions, or lifecycle.
- An **Agent** is one resolved Role, one resolved Brain, one Identity, and its
  lifecycle and permissions. Persistent and temporary Agents use the same
  resolver and runtime record.

Creating, updating, deleting, or loading a Role or Brain MUST have zero identity,
process, service, room, or roster side effects. Only an explicit Agent lifecycle
operation or room/task provisioning may reserve an identity or start a Brain.

Identifiers are explicit, immutable, type-scoped, case-sensitive ASCII matching
`[A-Za-z0-9_-]+`. APIs use exact identifiers and MUST NOT Unicode-normalize or
case-fold them. `display_name` is optional, mutable presentation. Filenames have
no identity semantics.

## 2. Filesystem configuration

The default layout is:

```text
fleet.yaml
fleet.conf.d/
  brains.d/
    smartass.yaml
    cheap.yaml
  roles.d/
    secretary.yaml
    critic.yaml
  agents.d/
    coordinator.yaml
  room-templates.d/
    paired-review.yaml
  rooms.d/
    default.yaml
  tasks.d/
    default.yaml
```

`fleet.yaml` becomes a bootstrap and global-policy document. It contains
`schema_version: 2`, optional `config_dir`, and global sections such as `policy`,
`adapters`, `watchdogs`, `loops`, and bootstrap owner routing. It MUST NOT contain
Role, Brain, Agent, room-template, room-policy, or task-policy definitions, nor
composition defaults. Reusable room templates live in `room-templates.d`;
losslessly migrated room and task defaults live in singleton resources
`RoomsPolicy/default` and `TasksPolicy/default` in `rooms.d/default.yaml` and
`tasks.d/default.yaml`.

Configured resources are definitions and policy only. Active task backlog, room
CIDs and seats, provisioning sagas, receipts, and other room/task instances remain
runtime state. This version deliberately defines no declarative Task or Room
instance resource kind.

`config_dir` defaults to bootstrap-relative `fleet.conf.d`. A relative value is
resolved against the bootstrap directory. An absolute value is allowed. Fleet
canonicalizes the bootstrap, directory, and every candidate; rejects symlinks in
any traversed component, traversal outside the selected directory, non-regular
files, device/FIFO/socket entries, and changed file identity during loading.

Discovery is exactly one level deep in the six typed directories. Only `.yaml`
and `.yml` regular files are candidates. Basenames are ordered by bytewise lexical
order, independent of locale. Other entries are ignored with a diagnostic;
symlink candidates are errors. Each file contains exactly one resource. Empty or
multi-document YAML and unknown fields are errors. Resource byte and aggregate
limits are global policy.

Fleet reads all bytes into one candidate snapshot, parses every resource, checks
schema and duplicate IDs within each type, resolves the entire reference graph,
and asks adapters to validate all Brain combinations before publishing the
snapshot. Diagnostics include exact file and JSON-style field path. Any error
rejects the whole candidate. No reconciliation or launch occurs from a rejected
candidate. A successful snapshot has a digest over bootstrap bytes plus ordered
`(type, canonical relative path, bytes)` tuples.

### 2.1 Role file

```yaml
kind: Role
version: 1
id: Secretary
display_name: Secretary
spec:
  bio: Public description and when to engage this role.
  persona: Local behavioral contract and boundaries.
  mission: Default operating mission.
  capabilities: [deliberation, implementation]
```

`bio`, `persona`, and `mission` are bounded strings; `capabilities` is a bounded,
duplicate-free list of stable tokens. Role files reject identity, harness, model,
effort, session, permission, environment, process, and lifecycle fields.

### 2.2 Brain file and BrainRef

```yaml
kind: Brain
version: 1
id: cheap
display_name: Cheap Claude
spec:
  harness: claude-code
  model: claude-haiku
  effort: low
  session: acp
```

A Brain resource has all and only the four `spec` fields. All four are non-empty
stable strings. `session: acp` is the only session type implemented by this
version. Effort is first-class, not hidden in harness options, and the selected
adapter validates and translates it.

Every Brain selection uses exactly one of these mutually exclusive shapes:

```yaml
brain: { template: cheap }
```

```yaml
brain:
  harness: codex
  model: gpt-5.6-sol
  effort: high
  session: acp
```

Partial inline forms, unknown templates, extra fields, and `template` combined
with inline fields are errors. A template cannot be patched; recomposition selects
another template or supplies another complete inline Brain.

Adapter implementation settings are global bootstrap policy, for example
`adapters.codex.acp`. They MUST NOT add Brain-defining fields or behavior and MUST
NOT be accepted in Brain, Agent, room, or task resources. The effective adapter
policy revision and digest are captured in the resolved AgentPlan for recovery.

### 2.3 Persistent Agent file

```yaml
kind: Agent
version: 1
id: coordinator
display_name: Coordinator
spec:
  role: Coordinator
  brain: { template: smartass }
  identity:
    name: VPSCoordinator
    ownership: existing
  lifecycle: persistent
  permissions:
    approval: allow
    filesystem: workspace
    unattended: wait
```

`agents.d` contains only explicit persistent declarations. An Agent adds identity,
lifecycle, permissions, supervision, isolation, owner-routing, monitoring, worklog,
and scheduling policy as defined by their own typed sub-schemas. It MUST NOT add
behavior, harness/session options, or partial Brain fields. `lifecycle` in this
directory is always `persistent`; a different value is an error.

Portable runtime policy is grouped under an exact-key-validated `runtime` wrapper
with the only allowed sub-blocks `supervision`, `isolation`, `owner_channel`,
`monitoring`, `worklog`, and `scheduling`. Each sub-block has its own closed typed
schema; neither the wrapper nor a sub-block is an extension bag. Permissions and
lifecycle remain first-class Agent fields. Adapter commands, session options,
harness-native options, and environment injection are forbidden here.

Temporary Agents use the identical composition and AgentPlan schema, but originate
from a direct start or room/task member and use `lifecycle: temporary`. They are
runtime records, not silently persisted into `agents.d`.

Identity policy distinguishes `existing`, `create_persistent`, and
`create_temporary`. Resolution and durable AgentPlan persistence occur before
identity creation. A created identity records Fleet ownership. Retirement closes
only Fleet-owned temporary identities automatically; persistent or externally
owned identities require their explicit policy. Brain shutdown and supervisor
cleanup are idempotent and do not imply identity deletion.

### 2.4 Room template and singleton policy files

Each reusable template is one `RoomTemplate` resource. Its payload `spec.version`
preserves the legacy template version independently of the top-level resource
schema version:

```yaml
kind: RoomTemplate
version: 1
id: paired-review
spec:
  version: 1
  description: Paired implementation and review
  room: { quiet_membership: true, anonymous: false }
  contract: Secretary writes; Critic reviews every material change.
  members:
    - { slot: secretary, role: Secretary, count: 1, brain: { template: smart } }
    - { slot: critic, role: Critic, count: 1, brain: { template: smart } }
```

Room policy is exactly one `RoomsPolicy/default` resource. Its typed `cowork`,
authenticated `owner`, and `defaults` fields are the lossless destination for the
legacy bootstrap `rooms` block; it is policy, never a live room record:

```yaml
kind: RoomsPolicy
version: 1
id: default
spec:
  cowork: { config: /etc/ours/cowork.yaml }
  owner: { provider: ours, expected_cid: "<64-hex CID>", role: Owner }
  defaults: { template: paired-review, attach_owner: true, close_when_task_done: true }
```

Task policy is exactly one `TasksPolicy/default` resource and is the lossless
destination for legacy task creation, template, completion, and retention policy:

```yaml
kind: TasksPolicy
version: 1
id: default
spec:
  default_room_template: paired-review
  create_mode: backlog
  close_room_on_done: true
  retain_completed_for: 7d
```

Policy defaults may contain a complete Brain selection and partial permissions
where their schemas allow them. They never create a Brain template or runtime
instance. Unknown policy keys and any non-`default` singleton ID are errors.

## 3. Room and task composition

Built-in and configured templates describe prototypes, never configured Agents:

```yaml
members:
  - slot: secretary
    role: Secretary
    brain: { template: cheap }
    count: 1
    permissions: { approval: allow }
  - slot: critic
    role: Critic
    brain:
      harness: codex
      model: gpt-5.6-sol
      effort: high
      session: acp
    count: 1
```

The same member shape is used by standalone rooms, tasks, templates, and direct
temporary-agent starts. Heterogeneous members are supported. Nothing requires a
matching persistent Agent.

Selection precedence for explicit member composition is:

1. an explicit task member or explicit standalone-room member;
2. a room member supplied by the task;
3. the selected template member.

At the winning layer, `role` is required and exactly one value is allowed.
Duplicate declarations at the same layer are errors. A Brain is selected as one
atomic value: an explicit `{template}` or complete inline Brain wins; it is never
field-patched. When an authenticated managed Agent creates another Agent, room, or
task and the request omits Brain, the child inherits the creator's complete resolved
Brain snapshot. Static persistent Agents and operations with no authenticated Agent
creator MUST provide a complete Brain; there is no hidden bootstrap default and a
missing creator context is an error. Inheritance never creates or updates a named
Brain template.

Per-member `permissions` is the canonical partial
permission overlay used by templates, standalone rooms, tasks, and direct temporary
starts. Other allowlisted Agent policy overrides use the same named fields as Agent
composition; they cannot modify Role or Brain. This intentionally migrates legacy
template `overrides` and the earlier draft's `policy.permissions` wrapper to one
direct composition shape. Legacy template `role` display text is discarded;
`role_ref` maps to canonical `role`. A template payload's existing `version` is
preserved as `spec.version` (distinct from top-level resource schema `version`).

Permission inheritance is per field, with exact precedence from strongest to
weakest: explicit member/operation, task or room default, template member,
authenticated creator snapshot. A field still missing after those layers is an
error. Explicit values always win within the caller's authorization ceiling.
Role, Identity, lifecycle, and Owner authority never inherit from a creator.

The default delegation ceiling is the creator's effective policy. The partial
orders are `ask ≤ auto ≤ allow`, `read-only ≤ workspace ≤ unrestricted`, and
`deny ≤ wait`. A child request broader than the creator is forbidden unless the
authenticated Owner has pre-authorized a narrowly scoped proxy capability. That
capability, its scope, and the Owner authorization evidence MUST be present in the
request, immutable AgentPlan, and receipt. Every inherited value records its source
Agent ID, source plan generation/digest, policy revision, and resolution layer;
explicit values record the requesting principal and operation. Missing caller
context, stale creator generation, or unverifiable proxy provenance fails before
any identity, process, room, or roster side effect.

Instance context is append-only and bounded:

```yaml
role_context:
  mission_append: Work only on task T.
  persona_append: Deliberate with the Critic before material changes.
```

Fleet combines definition text, then template context, room context, and task/member
context in that order, using the fixed separator `\n\n--- instance context ---\n\n`.
Each append and the final effective field has a configured byte limit. Replacement
is forbidden; `bio` and `capabilities` are definition-only.

Before any side effect, resolution persists an immutable AgentPlan containing:
resource IDs; source file revisions and snapshot digest; full effective Role;
resolved four-field Brain; adapter policy revision/digest; identity and ownership;
effective Agent policy; lifecycle; room/task/slot membership; and a plan digest.
Editing a Role, Brain, template, or policy never mutates a running AgentPlan.
Restart-resume uses its plan. Applying new definitions requires an explicit
reconfigure/restart operation that produces a new plan generation.

## 4. Body–Brain session boundary

The existing ACP semantics in `src/session/types.ts`, `src/session/acp.ts`, the
conversation event ledger, mutation kernel, and control route are the source of
truth. The implementation will refine them into an implementation-neutral
`BodyBrainSession`; it will not invent a reduced abstraction based on tmux.

The contract provides:

- `start(plan, generation)` and `restore(reference, recovery, generation)`;
- `submit(input, origin, clientRequestId)` returning admission separately from a
  correlated terminal result (`sessionId`, `promptId`, `turnId`);
- an ordered, cursor-addressable normalized event stream for text, thoughts,
  plans, tool activity, permissions, usage, state, completion, errors, and
  unsupported updates;
- cooperative cancel/interrupt with a deadline and explicit forced-termination
  fallback, cancellation source, and outcome;
- snapshots separating readiness/admission, activity evidence, process liveness,
  terminal state, and normalized failure reason;
- permission decision correlation and generation fencing;
- idempotent `retire()` and process cleanup.

Admission (`accepted`, `queued`, `deferred`, `interrupted`) is not completion.
Terminal outcomes remain `completed`, `refused`, `cancelled`, `failed`, or
`inconclusive`. Events are monotonically sequenced and replayable. Stale generation
commands and events cannot affect the current session.

Persist only the adapter ID, opaque session reference, protocol version, plan and
generation digests, last committed event cursor, active correlation IDs, and safe
recovery metadata. Never persist bearer credentials or provider-private process
state. Restore either resumes the exact compatible session or returns a normalized
reason such as `reference_missing`, `adapter_incompatible`, `protocol_mismatch`,
`agent_exited`, `corrupt_recovery`, or `resume_rejected`; it never silently creates
a fresh session. A separate explicit fresh-start operation advances generation.

`BrainAdapter` declares supported harness/session/model/effort combinations,
validates a resolved Brain, maps the AgentPlan into its launch, and creates or
restores `BodyBrainSession`. Codex-over-ACP and Claude-Code-over-ACP implement this
interface. Harness-specific mode, model/effort translation, MCP transport,
permission metadata, environment, command, and ACP quirks stay inside adapters.
Body, room/task, supervisor, CLI, REST, Messenger, and web code MUST NOT branch on
Codex versus Claude.

Adapter conformance tests run the same suite for both adapters: start, restore,
prompt admission/correlation, ordered streaming and terminal result, permissions
and tool events, cooperative/forced cancellation, process exit/error normalization,
generation fencing, and idempotent retirement. Body contract tests use a fake
adapter and assert no harness-specific branching.

## 5. Shared management kernel and surfaces

One application kernel owns validation, repository mutation, planning,
authorization inputs, orchestration, and audit records for Role, Brain, Agent,
task, room, template, and member-composition operations. CLI, REST, Messenger, and
web are transport/presentation adapters only; they MUST NOT edit YAML or orchestrate
independently.

Resource operations are `list`, `show`, `create`, `update`, and `delete` for Roles
and Brains; persistent Agents add those operations plus `start`, `stop`,
`restart-resume`, `restart-fresh`, `reconfigure`, and `retire`. Task/room operations
retain their lifecycle actions and add explicit resolved member composition to
create/show/plan. Definitions and runtime instances are always separate fields in
inventory and doctor output.

The stable machine envelope is:

```json
{
  "schema_version": 1,
  "operation_id": "...",
  "resource_version": "sha256:...",
  "data": {},
  "warnings": []
}
```

Failures replace `data` with `error: {code, message, field_path, resource_id,
retryable, details}`. Codes include `invalid`, `not_found`, `already_exists`,
`conflict`, `in_use`, `unauthorized`, `forbidden`, `unsupported`, and
`unavailable`. Ordering and JSON serialization are deterministic.

Mutations require an idempotency key and, for update/delete/reconfigure, expected
resource version (REST `If-Match`; equivalent CLI/Messenger/web field). Repeating
the same key and canonical request returns the recorded result; reuse with a
different request is `conflict`. Lifecycle mutations create durable operation
records. Create never overwrites. Update uses atomic replacement under a config
lock. Delete of a referenced definition or an Agent with a live operation is
`in_use`; replacement must be an explicit atomic plan.

Local CLI and authenticated web sessions map to an audited local Owner actor.
REST/web authorize before kernel invocation. Messenger accepts management commands
only from configured authenticated Owner CIDs, never display names, and records the
CID. All surfaces return the same kernel code and resolved representation; prose
may wrap but not change it.

Outputs redact invites/tokens, secret environment values, credential-bearing
adapter policy, control paths, and provider-private metadata. `plan` and `doctor`
show Role/Brain definitions separately from Agent instances, resolved four Brain
fields, source IDs/revisions and plan digest, but use policy-approved path labels
instead of sensitive absolute paths.

The web configuration editor becomes typed resource editors backed by kernel
operations; raw whole-`fleet.yaml` mutation is not the Role/Brain/Agent path.
Equivalent kernel contract tests invoke CLI boundary, REST handlers, Messenger
commands, and web service boundary and compare canonical outcomes, error codes,
versions, ordering, redaction, idempotency, and conflicts.

## 6. Atomic application and lifecycle

Configuration publication and runtime reconciliation are separate transactions.
Publishing a valid ConfigSnapshot changes desired definitions only and is inert.
An explicit `apply` computes a deterministic plan against observed Agents. It
records operation and AgentPlans before side effects, launches in stable Agent-ID
order, and records each result. Failure does not pretend the external world rolled
back; it stops further starts, compensates only newly Fleet-owned temporary state,
and exposes a resumable operation. Already-running Agents keep their prior plans.

Agent start order is: authorize and deduplicate; load one snapshot; resolve and
adapter-validate; reserve operation and persist AgentPlan; reserve/create identity;
start supervisor and Brain; establish messaging; mark ready. Retirement reverses
runtime ownership safely: reject new inputs, cancel/settle turn, retire Brain,
stop supervisor/monitor, release or close identity per ownership, and mark terminal.
Every stage is idempotent and generation-fenced.

## 7. Migration and compatibility

`ours-fleet config migrate-role-brain-agent` is dry-run by default. It reads legacy
`fleet.yaml` plus lexical `fleet.d`, validates current semantics, and proposes a
bootstrap plus typed files in a new staging directory. `--write` atomically renames
that directory only when the target does not exist and every output validates.
It never overwrites, deletes, starts, stops, or changes identities/services.

For each legacy `roles.<name>` it deterministically proposes:

1. a Role containing behavior fields;
2. a complete Brain containing harness, model, translated first-class effort, and
   session, deduplicated only when all four canonical fields match;
3. a persistent Agent preserving explicit identity/lifecycle/permissions/runtime
   policy only when the legacy entry was a configured persistent Agent;
4. updated room templates that compose Role and Brain prototypes, without requiring
   the proposed persistent Agent.

Generated names, source mapping, warnings, conflicts, and content digests appear in
a manifest. Re-running against unchanged input produces byte-identical output.
Existing targets, ambiguous effort translation, missing models, unsupported adapter
combinations, duplicate/colliding IDs, and fields without a safe destination are
reported without output application.

Any legacy `session: tmux`, tmux session option, tmux-only state, or omitted session
whose legacy meaning is tmux is a hard migration error: `tmux sessions are no longer
supported; choose session: acp and a validated harness/model/effort combination`.
Fleet MUST NOT silently reinterpret it. Runtime loading of schema v1 after the
transition reports the migration command; schema v2 never defaults a Brain field.

Tmux support is removed coherently: `src/tmux.ts`, `src/session/tmux.ts`, runner and
session-control branches, backend probing/status/capabilities, CLI/web terminal,
configuration variants/defaults, supervisor/doctor/recovery logic, tests,
dependencies, packaging, examples, and docs. No parallel legacy orchestration
remains.

## 8. Authorized implementation sequence

1. Add v2 schemas, secure typed loader, immutable ConfigSnapshot/AgentPlan, and
   migration dry-run tests. No runtime switch yet.
2. Extract BodyBrainSession from existing ACP semantics; add adapter registry,
   Codex ACP and Claude ACP adapters, fake adapter, and conformance tests.
3. Replace Role-centric spawn/runtime records with Agent resolution and remove tmux.
4. Convert room/task templates and provisioning to common member composition and
   snapshotting; update built-ins.
5. Add the shared resource/operation kernel and route CLI, REST, Messenger, and web
   through it; replace raw definition editing.
6. Update doctor, resolved plan, migration command, docs/examples/packaging; delete
   obsolete paths and run unit, integration, parity, and end-to-end suites.

No phase may launch from partially valid configuration. Compatibility shims may
read legacy input only for migration; they may not form a second live runtime.

## 9. Required verification

- Role/Brain CRUD and configuration load produce zero identity, child process,
  supervisor service, or roster calls.
- Lexical multi-file loading, explicit IDs, duplicate/case behavior, malformed and
  multi-document YAML, symlinks/traversal/non-regular files, exact source paths,
  aggregate limits, broken references, incompatible Brains, and atomic rejection.
- Brain template vs inline union: complete success; partial, ambiguous, extra-field,
  unknown-template, unsupported effort/session/combination failures.
- One Role with multiple Brains, multiple Roles with one Brain, and mixed Codex/
  Claude rooms; snapshot stability after editing every source definition/policy.
- Pair, single, and team rooms launch temporary Agents from prototypes while no
  persistent Agent of those names exists.
- Identity ownership, start failure compensation, restore/restart generation,
  cancellation, and retirement without leaked processes or unintended identity
  deletion.
- Migration dry-run, no overwrite, byte-identical rerun, deterministic conflicts,
  field mapping, legacy tmux rejection, and unchanged live host state.
- Cross-surface canonical contract parity for all Role/Brain/Agent/task/room/member
  operations, including auth, ordering, redaction, idempotency, and stale conflicts.
- Codex and Claude ACP adapter conformance for the full Body–Brain contract.

## 10. Current-state audit appendix

The inventory was performed read-only against base `8272b2f` before this spec was
written. The implementation phase MUST repeat the search at its chosen base.

| Surface | Current evidence | Required change |
|---|---|---|
| Config/schema/load | `src/config.ts`, `src/config-yaml.ts`, `src/paths.ts` load `fleet.yaml` + lexical flat `fleet.d/*.yaml`; `RoleConfig` mixes all three concepts and defaults session to tmux. | Secure v2 bootstrap + typed graph loader; no composition defaults. |
| Rendering/doctor | `src/resolved-plan.ts`, `src/doctor.ts`, `src/model-env.ts`, isolation and permissions code consume `ResolvedRole`. | Render definitions vs AgentPlan/instances; validate effective Brain through adapter. |
| Spawn/identity/persistence | `src/spawn.ts`, `src/creation.ts`, `src/temp-lifecycle.ts`, `src/provenance.ts`, `src/runner.ts` create runnable “roles” and branch by session backend. | One Agent resolver/plan and ownership-aware lifecycle. |
| Session boundary | `src/session/types.ts`, `acp.ts`, `control.ts`, event/conversation store, arbiter and application mutation services contain ACP-derived semantics; `src/session/tmux.ts` weakens them. | Extract BodyBrainSession without losing admission, event, cancellation, permission, activity, and recovery semantics; remove tmux. |
| Harness adapters | `src/harness/types.ts`, `registry.ts`, `codex.ts`, `claude-code.ts`, `acp-agent.ts` mix generic launch preparation and backend branches. | BrainAdapter registry with first-class effort and ACP implementations. |
| Rooms/tasks | `src/rooms-tasks/types.ts`, `config.ts`, `templates.ts`, `provision.ts`; built-ins use `role_ref`; `TaskRoomApplicationService.validateTemplates()` checks `cfg.roles`. | Common RoleRef + complete BrainRef member resolver; immutable AgentPlan snapshots. |
| CLI | `src/cli.ts`, `src/rooms-tasks/cli.ts`, spawn and lifecycle services expose role-instance commands and separate task/room paths. | Thin adapters over shared typed operations and envelopes. |
| REST/web server | `src/web/server.ts` exposes `/api/v1/roles`, lifecycle/session routes, tasks, and whole configuration preview/save. | Versioned Role/Brain/Agent resources and shared member operations. |
| Web UI/config | `web/src/CreateRole.tsx`, `RoleWorkspace.tsx`, `TopologyEditor.tsx`, `FleetSetup.tsx`; `src/web/fleet-config-service.ts` edits one file with revision locking. | Typed definition/instance views and per-resource concurrency through kernel. |
| Messenger | `src/owner-channel/commands.ts`, `channel.ts`, fleet operations, and task-room service adapt Owner commands unevenly. | CID-authorized thin command adapter with full parity. |
| Application services | `src/application/fleet-query-service.ts`, role repository/creation/removal/command/session-control, task-room service partly unify surfaces but remain Role/backend-centric. | One resource/query/lifecycle kernel; eliminate transport-specific mutation. |
| Supervisor/status/logs | `src/supervisor/*`, application status/capabilities/log services, watchdog and loops infer tmux or control ACP. | AgentPlan-based ACP-only supervision and normalized status. |
| Tests/docs/examples | `test/*`, web tests, `README.md`, `examples/fleet.yaml`, integrations and package metadata encode roles-as-agents and tmux variants. | Replace with inertness, loader, resolver, parity, adapter conformance, migration, and E2E coverage above. |

## 11. Authorization boundary

The specification and its recorded amendments were approved by an instruction
authenticated as the configured Owner. That instruction authorizes repository-only
implementation in the isolated worktree, with Critic review before each material
landing. It does not authorize live configuration migration, identity/service/
process/room mutation, merge, publication, deployment, or restart. Those remain
separate Owner approvals. The approved ten-phase detailed implementation plan is
normative where it supplies more operational detail; this document governs the
architecture and invariants, and contradictions MUST stop implementation for joint
resolution rather than choosing a convenient interpretation.
