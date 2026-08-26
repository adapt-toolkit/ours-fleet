# Role, Brain, and Agent — detailed implementation plan

Status: repository implementation approved by authenticated Owner CID
`0941EDDA3F0027484D7E2752D613AF666D147461960E4FA0A608EB5A0759F6DA` in room
message `01m0z4xegggyt2evsmzh3j5gvc`, after directing the amendments recorded here.
This approval excludes live migration, deploy, merge, publish, restart, service
change, and live identity/process/room mutation.
Repository base inspected: `8272b2f0e1a60728dd6193cead54ae43fb9e1385`.

## Executive review

Fleet will replace the current runnable `RoleConfig` concept with three explicit
concepts. A **Role** is inert behavior. A **Brain** is inert execution identity,
defined by exactly `harness`, `model`, `effort`, and `session`. An **Agent** is a
resolved Role + Brain + Identity intent + harness-neutral permissions and
lifecycle. Definitions never launch or create identities.

The implementation proceeds in ten phases:

1. add typed Role/Brain/Agent configuration and crash-safe graph commits;
2. make Agent permissions first-class and adapter-translated;
3. extract the ACP-derived Body–Brain session contract;
4. conform Codex ACP and Claude Code ACP adapters to it;
5. cut runtime orchestration over to resolved Agent plans;
6. convert room/task members to Role + Brain composition;
7. put all management behind one application kernel and expose every surface;
8. issue durable deterministic receipts for every write and route supervised
   Agent writes through a scoped typed proxy;
9. remove tmux and migrate only ACP-capable legacy configuration;
10. complete parity, recovery, packaging, documentation, and end-to-end proof.

The central cutover rule is: do not ship two live orchestration architectures.
New components may be built behind repository-only tests, but the runnable switch
from legacy roles/tmux to Agent/ACP is one coherent cutover. Live configuration,
identities, services, rooms, publishing, and deployment require separate approval.

## Target contracts

### Configuration resources

`fleet.yaml` becomes a schema-v2 bootstrap containing only host-global settings:
`schema_version`, optional `config_dir`, global `policy`, `adapters`, watchdogs,
loops, and owner routing. It cannot define/default Role, Brain, Agent, room, or
task composition. `config_dir` defaults to bootstrap-relative `fleet.conf.d`.

```text
fleet.conf.d/
  roles.d/*.yaml
  brains.d/*.yaml
  agents.d/*.yaml
  room-templates.d/*.yaml
  rooms.d/default.yaml
  tasks.d/default.yaml
```

Every file contains one resource with `kind`, `version`, immutable `id`, optional
mutable `display_name`, and `spec`. IDs are type-scoped, case-sensitive ASCII
`[A-Za-z0-9_-]+`; filenames are descriptive only.

`room-templates.d` stores one reusable room template per file. The existing
bootstrap `rooms:` and `tasks:` policy blocks move losslessly to singleton typed
resources `RoomsPolicy/default` and `TasksPolicy/default`. Active task backlog,
room CID/seats/saga, receipts, and other orchestration records remain runtime
state; this refactor does not invent declarative task/room instance kinds.

```yaml
kind: Role
version: 1
id: Secretary
spec:
  bio: Public description.
  persona: Local operating contract.
  mission: Default mission.
  capabilities: [implementation, deliberation]
```

Role rejects identity, runtime, permission, and lifecycle fields. Instance
context may only append bounded `mission_append` and `persona_append` strings in
the fixed order template → room → task/member. Replacement, bio overrides, and
capability overrides are errors. The resolver uses one fixed separator and stores
the resulting effective Role.

```yaml
kind: Brain
version: 1
id: cheap
spec:
  harness: claude-code
  model: claude-haiku
  effort: low
  session: acp
```

Brain `spec` has all and only those four non-empty fields. Every Brain selection
is exactly `{template: id}` XOR a complete inline object containing all four
fields. Template plus inline fields, partial inline objects, extra keys, unknown
templates, unsupported effort/session values, and adapter-incompatible
combinations fail validation. A template is never patched; a caller selects a
different complete Brain.

```yaml
kind: Agent
version: 1
id: coordinator
spec:
  role: Coordinator
  brain: {template: smart}
  identity: {name: VPSCoordinator, ownership: existing}
  lifecycle: persistent
  permissions:
    approval: allow
    filesystem: workspace
    unattended: wait
```

Persistent Agents live in `agents.d`; temporary Agents use the same schema in a
runtime request/record. Agent may contain identity intent, lifecycle,
permissions, supervision, isolation, owner channel, monitoring, worklog, and
scheduling policy. It cannot contain behavior or harness-specific Brain options.
Static persistent Agents and direct Owner creation without an authenticated Agent
creator must specify a complete Brain and complete permission policy; there are no
hidden global composition defaults.

Identity is deliberately two-stage. The pre-side-effect AgentPlan records
`IdentityIntent` (`existing`, `create_persistent`, or `create_temporary`, requested
name, ownership policy), not an invented CID. After verified creation/binding,
runtime state records an `IdentityBinding` with authenticated CID and provenance.
A receipt must distinguish requested identity from confirmed binding.

Global `adapters.<harness>.<session>` policy holds implementation settings such as
ACP command selection. These settings do not become Brain fields, but the
effective adapter-policy revision/digest is captured in AgentPlan for reproducible
restore.

### Deterministic graph loading and mutation

The loader canonicalizes bootstrap, config directory, and candidates; rejects
symlinks in traversed components, path escapes, non-regular files, multi-document
YAML, unknown keys, changed file identity during read, per-file/aggregate size
violations, and duplicate logical IDs. It scans one level in bytewise lexical
basename order, reads all bytes, parses and validates the entire reference graph,
and adapter-validates every Brain before publishing one immutable ConfigSnapshot.
Diagnostics include exact source file and field path. Any error rejects the whole
candidate and triggers no reconciliation.

The bootstrap plus visible typed directories are the complete configuration source
of truth; there is no hidden selected generation. Fleet readers and writers use
one cross-process graph lock beside the bootstrap (shared for read, exclusive for
mutation/recovery). Its revision/digest covers `fleet.yaml` and all typed resources.
Whenever a kernel transaction touches either, it stages every changed file beside
its target, fsyncs them, validates the complete proposed graph, then writes and
fsyncs one transaction journal beside the bootstrap containing before/after
hashes, staged paths, backup paths, and phase. Under the exclusive lock Fleet backs
up affected originals, performs deterministic atomic renames, fsyncs each affected
directory, validates the visible graph, marks the journal committed, then removes
staging/backups and journal. A crash leaves a journal;
before any subsequent read, startup recovery takes the exclusive lock and either
finishes forward when every remaining staged/visible hash matches the manifest or
restores the complete old set from backups. Hash mismatch fails closed for manual
repair. Thus a Fleet reader observes wholly old or wholly new state.

Hand-edited files are never ignored: an atomic single-file editor becomes visible
on the next read. The loader fingerprints every file before/after its bounded read
and rejects a changing snapshot. Multi-file authoring SHOULD use the kernel
transaction command; an external editor that exposes an intermediate invalid graph
causes validation failure and zero reconciliation until the graph is valid. Kernel
mutation rechecks lstat/file hashes immediately before backup/rename and validates
after commit; any observed mismatch aborts or restores and fails closed. The lock
cannot coordinate a non-cooperating editor, so a narrow TOCTOU window remains and
concurrent manual edits during a kernel transaction are unsupported. Documentation
directs operators to `config edit/apply`, or to stop Fleet writers before manual
multi-file changes; it does not promise impossible exclusion.

AgentPlan is persisted before side effects and contains resource/source revisions,
ConfigSnapshot digest, full effective Role, resolved four-field Brain, effective
adapter-policy digest, IdentityIntent, permissions/lifecycle, membership, plan
generation, and plan digest. Running plans do not drift when definitions change;
reconfiguration creates a new generation explicitly.

### Agent permissions

The public Agent permission policy remains harness-neutral: approval behavior,
filesystem boundary, unattended behavior, plus only future neutral fields accepted
by schema version. `src/permissions.ts` owns normalization. Each Brain adapter
implements deterministic validation and translation to its native Codex/Claude
mode. Validation returns the portable policy and redacted native interpretation;
unsupported or contradictory combinations are configuration errors before launch.

The resolved permission policy and native-mode descriptor are stored in AgentPlan
and shown in confirmations. Secrets and provider-private metadata are not. Runtime
permission requests still cross the Body–Brain boundary with stable IDs; the body
applies Agent policy or an authenticated Owner decision. Role and Brain never
carry permission policy.

### Managed creation inheritance

Managed creation has deterministic creator inheritance so callers need not repeat
their own execution configuration. Resolution layers, highest priority first, are:
explicit member/operation input; explicit task/room default; template member; the
authenticated creator Agent's resolved snapshot; otherwise a missing-context
error. Brain is atomic at every layer: omission inherits, while an explicit value
is one named template or one complete inline four-field Brain and replaces the
lower layer wholesale. An explicit inline Brain is ad-hoc for the child; it does
not persist a named Brain without a separate `brain.create` write.

Permissions use the same layers but overlay per neutral field, yielding a complete
policy. The plan records provenance for the Brain and each permission field. The
neutral delegation order is `ask ≤ auto ≤ allow`, `read-only ≤ workspace ≤
unrestricted`, and `deny ≤ wait` for unattended behavior. The default delegation
ceiling is the authenticated creator's effective policy. Any broader field needs
a pre-authorized Owner proxy capability whose ceiling is recorded in the request,
AgentPlan, audit, and receipt. Role, Identity, lifecycle, and Owner authority never
inherit. A static persistent Agent, direct Owner request without Agent context, or
prototype invoked without its required creator context fails unless Brain and all
permission fields are explicit.

### Body–Brain session contract

The contract is extracted from the strong semantics already present in
`src/session/types.ts`, `src/session/acp.ts`, conversation events/store, arbiter,
control, and application session mutations. It does not inherit tmux limitations.

`BodyBrainSession` supports start and exact restore, prompt submission, ordered
event subscription/replay, permission response, interrupt/cancel, snapshot, and
idempotent retire. Start/restore uses an AgentPlan digest and monotonically
increasing generation. Every command and event carries generation fencing so a
stale process cannot mutate the replacement session.

Prompt admission is separate from terminal result. Admission reports accepted,
queued, deferred, or interrupted and supplies stable session/prompt/turn IDs.
Terminal outcome is completed, refused, cancelled, failed, or inconclusive.
Normalized monotonic events cover message/thought/plan chunks, tool lifecycle,
permission requested/resolved, usage, readiness/activity, turn completion,
session lifecycle, errors, and explicitly unsupported updates. Cursor replay is
bounded and integrity-checked.

Snapshots separate readiness/admission, activity evidence, process liveness,
terminal state, active prompt/turn, pending permission ID, and normalized failure
reason. Cancellation first sends cooperative ACP cancel, waits a bounded deadline,
then terminates the adapter process if necessary and records source/outcome. A
forced termination never reports ordinary completion.

Persisted recovery metadata is implementation-neutral: adapter ID, opaque session
reference, protocol version, plan/generation digests, committed event cursor,
active correlation IDs, and safe recovery facts. It excludes credentials and
provider-private process state. Restore resumes that exact compatible reference or
returns a normalized reason (`reference_missing`, `adapter_incompatible`,
`protocol_mismatch`, `agent_exited`, `corrupt_recovery`, `resume_rejected`). It
never silently starts fresh; fresh start is an explicit generation advance.

`BrainAdapter` validates Brain + permissions + global adapter policy, prepares a
launch, and starts/restores `BodyBrainSession`. Codex/Claude model, effort, native
permission mode, MCP/config transport, environment, command resolution, and ACP
quirks remain inside their adapters. No body, supervisor, room/task, CLI, REST,
Messenger, or web code branches on harness name.

### Shared mutations, receipts, and managed proxy

One application kernel owns global-policy, Role/Brain/Agent/task/room/template/
member queries and mutations. CLI, REST, Messenger, web, and managed-Agent proxy
are adapters. Raw YAML editing and surface-specific orchestration are removed for
these resources.

Definition deletion is non-cascading. Deleting a Role, Brain, or template that is
referenced by any current Agent, template, task, room, or other candidate graph
resource returns conflict with bounded referrers. A definition referenced only by
self-contained immutable runtime/history snapshots may be deleted from desired
configuration, but snapshot/audit provenance and digests remain. Multi-resource
replacement plus deletion is one validated graph transaction. Agent retirement
and Agent-definition deletion are separate operations; retirement follows identity
and process ownership, while deletion only changes desired configuration.

Every mutation has a canonical request, authenticated actor, idempotency key,
request hash, optional expected resource version, operation ID, and durable
`WriteReceipt`. The receipt acceptance boundary is an authenticated, authorized,
schema-valid mutation intent. Malformed or unauthenticated traffic is rejected and
audited but is not a domain write receipt. Before execution the kernel durably
writes `accepted`; transitions
are monotonic: `accepted → running → succeeded | failed | uncertain`. Reuse of an
idempotency key with the same actor/request hash returns the prior receipt; a
different request is conflict. `succeeded` means the domain mutation is durable
and its stated postcondition evidence holds—not merely process acceptance.
`uncertain` means execution may have committed but evidence is insufficient; retry
reconciles by operation ID/postcondition instead of replaying blindly.

Receipt includes schema version, operation/actor/surface, resource kind/ID/version,
plan/config digest where applicable, timestamps, state, redacted result/error, and
postcondition evidence. Agent-create receipts show requested and confirmed
Identity separately, resolved Brain, portable/native permission mode, lifecycle,
and AgentPlan digest. Room/task receipts show stable IDs and bounded resolved
member summaries (Agent ID, Role ID, four Brain fields, permission summary,
Identity binding state) plus full plan digest/link rather than an unbounded dump.

Owner delivery is a separate durable outbox keyed by operation ID + destination +
receipt revision. Each relayed receipt transition and its outbox row commit in one
SQLite transaction, so there is no crash gap between operation truth and enqueue.
Startup also reconciles any historical receipt revision lacking its required row.
Delivery is at-least-once; relay retries do not re-execute the operation, and
receivers deduplicate the stable key. Outbox state (`pending`, `delivered`,
`failed`) never changes operation truth. Owner-facing confirmation is deterministic
rendering of the receipt, never Agent-authored prose.

Receipt retention is explicit global policy. Full terminal receipt, evidence, and
delivered outbox payload default to 365 days (configurable upward); compaction then
keeps an immutable idempotency/audit tombstone indefinitely with actor scope,
idempotency-key hash, request hash, operation/resource IDs and versions, terminal
truth, plan/config digests, timestamps, and audit pointer. Delivered outbox bodies
may be compacted, but delivery key/state remains. GC never removes a tombstone or
makes an old idempotency key executable as a new request.

The current spawn-only `fleet_spawn` control becomes an allowlisted typed
`fleet_write` request union. The supervisor derives the calling Agent from its
bound session/AgentPlan, never from request text or `OURS_FLEET_PROXY_*` env (which
remains routing only). It issues a short-lived supervisor credential scoped to
Agent ID, generation, allowed operations, and expiry; the control socket checks
peer ownership, credential, generation, payload schema, and capability before
calling the kernel. No arbitrary binary arguments or shell execution are exposed.

This prevents sibling or stale Agents from claiming another caller, but an
unisolated process running as the same OS user may still inspect same-user state;
the plan does not overclaim OS isolation. Stronger protection relies on the
existing isolation boundary and restrictive socket/token modes. Audit and doctor
must report degraded isolation. Owner-channel relay remains supervisor-owned.

### Surface parity matrix

All entries call the named shared kernel command family. `R` is query access; `W`
is mutation access; `—` is intentionally unavailable. CLI authorization is the
local operator boundary; REST/web use the authenticated local Owner session;
Messenger uses authenticated configured Owner CID; managed proxy uses the
supervisor-derived Agent ID, generation credential, and capability allowlist.
Every W supplies idempotency key and expected version where applicable and returns
the canonical WriteReceipt or stable kernel error. Every R returns the same
canonical, redacted, deterministically ordered representation.

| Operation family (kernel command) | CLI | REST | Messenger | Web | Managed proxy |
|---|---:|---:|---:|---:|---:|
| Global policy (`policy.get|update`) | R/W | R/W | R/W | R/W | explicit allowlist only |
| Role CRUD (`role.*`) | R/W | R/W | R/W | R/W | allowlisted W |
| Brain CRUD (`brain.*`) | R/W | R/W | R/W | R/W | allowlisted W |
| Template CRUD (`template.*`) | R/W | R/W | R/W | R/W | allowlisted W |
| Agent CRUD (`agent.*`) | R/W | R/W | R/W | R/W | allowlisted W |
| Agent lifecycle (`agent.start|stop|restart|retire|reconfigure`) | R/W | R/W | R/W | R/W | allowlisted W |
| Task and task-list operations (`task.*`, `task_list.*`) | R/W | R/W | R/W | R/W | allowlisted W |
| Room/member operations (`room.*`, `member.*`) | R/W | R/W | R/W | R/W | allowlisted W |
| Inventory/resolved plans/status (`query.*`) | R | R | R | R | scoped R |
| Receipt lookup/stream (`receipt.*`) | R | R | R | R | own/scoped R |

The default managed-proxy allowlist is deny-all and is granted per Agent policy;
it never derives authority from the availability of a CLI command. Destructive
operations retain explicit confirmation fields in the canonical request. Surface
adapters may improve prose, prompts, or HTTP status but cannot change the command,
authorization decision, receipt, error code, or resolved result.

## Ten implementation phases

### Phase 1 — domain and configuration

Code seams: `src/config.ts`, `config-yaml.ts`, `paths.ts`, `rooms-tasks/config.ts`,
atomic-file utilities, resolved-plan and doctor.

1. Add versioned resource/BrainRef/IdentityIntent/AgentPlan types and strict
   validators without enabling runtime use.
2. Implement secure typed discovery including room templates and singleton
   RoomsPolicy/TasksPolicy, complete-graph validation, source-aware diagnostics,
   immutable snapshot digest, and adapter validation hook.
3. Implement visible-directory staging/journal/backups, shared/exclusive lock,
   forward-or-rollback crash recovery, optimistic revisions, and plan rendering.
4. Add unit/fault-injection tests for ordering, duplicates, malformed input,
   symlinks/path traversal, partial writes, fsync/rename crash points, stale writes,
   atomic bootstrap-plus-resource replacement, non-cooperating editor races,
   referential delete conflicts/atomic replacements, and zero identity/process/
   service calls for Role/Brain operations.

Exit: a valid v2 graph resolves deterministically and invalid/corrupt candidates
cannot become visible or cause side effects.

### Phase 2 — permission model

Code seams: `src/permissions.ts`, `config.ts`, `harness/types.ts`, Codex/Claude
adapter permission helpers, resolved plan and doctor.

1. Define versioned neutral Agent permission schema and normalization.
2. Move native translation/validation behind adapter methods; make effort equally
   first-class and reject unsupported Brain/permission combinations.
3. Record redacted portable/native resolution in AgentPlan and presentation.
4. Test the cross-product of harness/model/effort/session/permissions, including
   deterministic errors and parity between validation and actual launch inputs.

Exit: one Agent policy deterministically produces the native mode or fails before
launch; Role/Brain remain permission-free.

### Phase 3 — Body–Brain interface

Code seams: `src/session/types.ts`, `acp.ts`, arbiter, events, conversation store,
control, `src/application/session-mutations.ts` and session-control.

1. Freeze normalized state/event/admission/result/failure/recovery types based on
   current ACP behavior and add generation to commands/events.
2. Define `BodyBrainSession` and a deterministic fake adapter; preserve ordered
   event ledger, permissions, and replay.
3. Move body/control/mutation consumers onto the interface while ACP remains the
   tested reference implementation.
4. Test admission versus completion, IDs, ordering, permission correlation,
   cancellation escalation, stale generations, crash/restore, corrupt metadata,
   and idempotent retire.

Exit: body behavior is fully contract-tested against a fake Brain with no tmux or
harness assumptions.

### Phase 4 — Codex and Claude ACP adapters

Code seams: `src/harness/{types,registry,codex,claude-code,acp-agent}.ts`,
`src/session/acp.ts`, model-env and isolation runtime.

1. Separate shared ACP transport/session logic from adapter launch and translation.
2. Implement Codex and Claude adapters for model, effort, permission mode,
   environment/MCP/session metadata, start, exact restore, and normalized failures.
3. Remove harness checks from callers and register adapters by `(harness, session)`.
4. Run identical conformance suites for start/restore, prompt/events, permissions,
   cancel/force, exit/error, generation fencing, recovery, and retirement.

Exit: both adapters pass one suite and all external code sees only BrainAdapter and
BodyBrainSession.

### Phase 5 — Agent runtime cutover

Code seams: `src/{spawn,runner,creation,temp-lifecycle,provenance}.ts`, application
role repository/creation/removal/status/capabilities, `src/supervisor/`, monitor,
watchdog, loops, owner channel, isolation.

1. Replace runnable ResolvedRole inputs with resolved AgentPlan and runtime record;
   replace `inheritCallerSpawnDefaults` with the shared resolver for managed child
   Agents: atomic Brain inheritance, per-field permission overlay/provenance,
   no-caller completeness, and delegation-ceiling enforcement.
2. Persist plan before identity intent is executed; record verified IdentityBinding
   afterward. Make launch/retire/recovery stages idempotent and generation-fenced.
3. Unify temporary/persistent paths; lifetime changes supervision/identity cleanup,
   not schema. Never delete externally owned identity automatically.
4. Update supervisor backends including `supervisor/none`, status/doctor, monitor,
   watchdogs, loops, owner routing, model recovery, logs, and provenance.
5. Fault-test every stage before/after identity creation, Brain start, messaging,
   readiness, cancellation, and retirement; verify compensation never crosses
   ownership boundary, creator provenance survives restart, escalation/no-context
   requests fail, and no process/identity leaks remain.

Exit: every runnable unit is an AgentPlan; definitions are inert and restart uses
the recorded generation until explicit reconfigure.

### Phase 6 — room/task composition

Code seams: `src/rooms-tasks/{types,config,templates,provision,room-state,task-state,
member-startup,close}.ts` and `src/application/task-room-service.ts`.

1. Replace `role_ref`/runtime override model with RoleRef, optional managed BrainRef,
   partial Agent permission policy, and append-only role context at template, room,
   and task/member.
2. Implement explicit member/operation > task/room default > template member >
   authenticated creator precedence. Resolve Brain atomically, overlay permissions
   per field, enforce delegation ceiling, record provenance, and reject ambiguity
   or missing creator context.
3. Persist resolved member AgentPlans and Identity intent/binding transitions before
   provisioning; preserve saga recovery and ownership-aware retirement.
4. Update built-in pair/single/team templates so no persistent Agent is required.
5. Test one Role/multiple Brains, multiple Roles/one Brain, mixed Codex/Claude,
   every inheritance layer, explicit/inherited permission mixes, no-caller failure,
   escalation rejection/Owner ceiling, Role/Identity non-inheritance, snapshot
   stability, partial provisioning recovery, and close races.

Exit: heterogeneous rooms/tasks launch only composed temporary Agents and resume
from their persisted plans.

### Phase 7 — shared management kernel and surfaces

Code seams: `src/application/`, `src/cli.ts`, `rooms-tasks/cli.ts`,
`src/owner-channel/commands.ts`, `src/web/server.ts`, web API/UI/config services.

1. Define shared query/mutation commands, stable errors, authorization input,
   optimistic versions, idempotency, canonical ordering, and redaction.
2. Implement typed global-policy get/update, Role/Brain/Agent CRUD/lifecycle, and
   task/room/template/member operations once in the kernel. Policy update uses the
   same graph transaction, authorization, expected revision, receipt, and redaction.
3. Route CLI, REST, authenticated Owner Messenger, and web services through it;
   delete direct YAML and surface-specific orchestration for these resources.
4. Replace whole-file web editing with typed resource editors and a definite typed
   global-policy editor backed by `policy.get|update`.
5. Contract-test equivalent success/error/conflict/idempotency/redaction results at
   each surface boundary.

Exit: no surface can produce a different domain result for the same actor/request.

### Phase 8 — durable write receipts and managed-Agent proxy

Code seams: `src/fleet-proxy.ts`, `runner.ts`, `session/control.ts`, application
command/task-room services, owner-channel channel/notices/state, web events/audit.

1. Add durable operation/receipt store and monotonic transition/reconciliation
   logic; persist accepted before execution and evidence before terminal state.
2. Make every kernel write create a receipt, including failures and uncertainty;
   add bounded resource-specific confirmation projections showing inherited versus
   explicit Brain/permission provenance, delegation ceiling/capability, and the
   fact that Role/Identity were selected independently rather than inherited.
3. Add durable relay outbox, retry/dedup, independent delivery state, and recovery.
4. Replace `fleet_spawn` with authenticated capability-scoped `fleet_write` union;
   issue/revoke generation credentials in supervisor, pass supervisor-derived
   creator snapshot and pre-authorized ceiling to the kernel, and keep request/env
   caller or ceiling claims non-authoritative.
5. Route proxy calls through the same kernel and relay receipt projections through
   supervisor owner channel. Remove prose-as-proof paths.
6. Crash/fault-test before/after operation commit and outbox enqueue/delivery,
   idempotency reuse/conflict, uncertain reconciliation, stale credential/generation,
   payload/env creator or ceiling forgery, unauthorized/escalating operation,
   inherited/explicit receipt rendering,
   oversized composition, retention compaction/tombstones, and unisolated-mode
   warnings.

Exit: every write has one durable truth independent of transport, and Agent-issued
writes cannot bypass authorization, receipts, or confirmation.

### Phase 9 — tmux removal and migration

Code seams: `src/tmux.ts`, `session/tmux.ts`, runner/control/status/capabilities,
supervisor/none, terminal bridge/UI, config/doctor, tests, dependencies, examples,
integrations, exports and packaging.

1. Build `config migrate-role-brain-agent` as dry-run by default. Produce a staged
   v2 bootstrap/resources/manifest deterministically; `--write` only when target is
   absent and candidate fully validates. Never overwrite or touch live state.
2. Split ACP-capable legacy roles into Role, Brain, and explicit persistent Agent;
   update templates to prototypes. Record source mappings/digests and make reruns
   byte-identical.
3. Hard-error on explicit/implicit tmux semantics with actionable ACP selection
   guidance; never infer an ACP model/effort/session replacement.
4. Delete tmux code, backend probes/status, terminal routes/UI, config options and
   defaults, recovery semantics, dependencies, tests, docs and package exports.
5. Test no-overwrite, collisions, ambiguous effort, unsupported adapters,
   idempotency, abandoned staging recovery, hard tmux errors, and zero live effects.

Exit: repository has one ACP runtime architecture and a safe, deterministic path
for ACP-capable legacy configuration only.

### Phase 10 — system proof, docs, and release readiness

1. Complete unit/integration/E2E coverage across typed loading, inertness, adapter
   conformance, Agent lifecycle, heterogeneous rooms/tasks, receipt/proxy recovery,
   migration, and cross-surface parity.
2. Update README, examples, integrations, web views, CLI help, Messenger help,
   doctor/resolved plan, watchdog/loops, install/pack tests, package exports, and
   release notes to describe only Role/Brain/Agent + ACP.
3. Run static checks, full tests, integration packaging, and explicit searches for
   remaining `role_ref`, roles-as-agents, tmux, direct resource YAML mutation, and
   unreceipted write paths; classify any intentional remnants.
4. Produce migration/cutover report, test evidence, known limitations, and deploy
   runbook. Do not deploy, publish, restart, or migrate the host.

Exit: code, tests, docs, packaging, and surfaces agree; review evidence is ready for
separate merge and deployment decisions.

## Commit, recovery, and review strategy

Repository commits should follow the ten phases, but intermediate commits before
the cutover remain non-runnable scaffolding or tests. A feature gate must not expose
a second production orchestrator. The cutover commit changes all runtime callers
to Agent/ACP and removes legacy dispatch; later cleanup deletes unreachable code.

Before every external side effect, durable state contains the intended plan,
operation ID, ownership, and compensation boundary. Recovery examines durable
postconditions rather than assuming a failed process means a failed mutation.
Compensation may retire only resources proven created and owned by that operation.
No rollback deletes a pre-existing or externally owned identity, room, or Agent.

Review checkpoints:

- after phases 1–2: schema, graph transaction, permission-resolution approval;
- after phases 3–4: Body–Brain and adapter conformance approval;
- before phase-5 cutover: AgentPlan/recovery/ownership audit;
- after phases 6–8: composition, surface parity, receipt/proxy threat review;
- before phase 9: migration fixtures and explicit tmux-error wording approval;
- after phase 10: full evidence review, followed by separate merge/deploy approval.

## Key risks and resolved choices

- **Partial multi-file state:** eliminated by immutable generations and atomic
  committed pointer, not a series of per-file renames.
- **Definition drift:** running AgentPlan snapshots never change implicitly.
- **Identity overclaim/deletion:** intent and authenticated binding are distinct;
  cleanup follows recorded ownership.
- **Permission divergence:** neutral policy has one adapter translation used by
  validation, launch, plan, doctor, and receipt.
- **Harness leakage:** conformance boundary prevents body/surface branches.
- **Duplicate or missing writes:** request-hash idempotency, durable receipts,
  postcondition reconciliation, and separate relay outbox.
- **Proxy impersonation:** supervisor-derived caller, scoped generation credential,
  peer checks, allowlisted union; degraded same-user isolation is reported honestly.
- **Silent tmux conversion:** forbidden; migration stops for explicit or implicit
  tmux semantics.
- **Parallel architectures:** forbidden in released runtime; repository scaffolding
  converges on one coherent cutover.

## Approval scope

The authenticated Owner approval recorded in the header authorizes repository
implementation of this amended plan. It does not authorize live host migration,
identity/service/room mutation, merge, publish, deployment, or restart; those remain
separate decisions.
