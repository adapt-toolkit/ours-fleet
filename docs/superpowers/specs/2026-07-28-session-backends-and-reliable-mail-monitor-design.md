# Fleet Session Backends and Reliable Mail Monitor Design

**Date:** 2026-07-28  
**Status:** Accepted for prerelease implementation  
**Targets:** `ours-fleet`, `ours-mcp`, native Codex and Claude integrations, ACP v1

## Summary

Add a transport-independent session layer to `ours-fleet`, selected with one
declarative `session` setting:

```yaml
defaults:
  session: tmux

roles:
  Reviewer:
    harness: codex
    session: acp
```

`harness` continues to select the agent implementation, such as Codex or Claude.
`session` selects how the fleet runner owns and communicates with that agent:

- `tmux` runs the existing interactive harness CLI in a detached tmux session.
- `acp` runs an ACP agent adapter as a child process and controls it through
  stable ACP v1 JSON-RPC.

Move mail monitoring to a durable, transport-neutral state machine. The ours
daemon remains the authority for notification events and unread state. A
session-specific delivery adapter turns a pending wake into either a tmux prompt
or an ACP `session/prompt`.

Do not create a third independent implementation of notification polling.
Extract or publish the harness-neutral pieces currently spread between
`ours-mcp`'s native Codex watcher and `ours-fleet`'s supervisor monitor so native
Codex, fleet tmux, and fleet ACP share:

- daemon profile resolution;
- notification filtering;
- cursor and pending-wake persistence;
- backlog recovery;
- retry and health semantics.

The first implementation must fix reliability defects in both existing monitor
paths before ACP becomes a supported unattended fleet backend.

## Goals

- Select tmux or ACP with one fleet setting and one spawn flag.
- Preserve the independent `harness` selection.
- Deliver every relevant ours wake at least once until the target session
  explicitly accepts the prompt.
- Use the configured ours `identity`, never the fleet role name, for notification
  routing.
- Keep notification events and persisted wake state body-free.
- Share monitor behavior across native Codex, fleet tmux, and fleet ACP.
- Replace pane-text inference with structured lifecycle events wherever the
  selected backend supports them.
- Keep current tmux roles backward compatible.
- Preserve `send`, `peek`, status, supervision, and oversight across both session
  backends.
- Introduce common permission intent, including at least approval behavior and
  filesystem authority, while retaining harness-native escape hatches.
- Make failures externally visible and actionable rather than leaving a
  deaf-but-armed session.

## Non-goals

- Replacing systemd or launchd supervision.
- Making ACP v2 a release dependency. ACP v2 is draft; the initial target is
  stable ACP v1.
- Removing tmux or the interactive harness CLIs.
- Making native Codex `ours-codex` depend on `ours-fleet`.
- Treating control-plane traffic monitoring as mail wake monitoring.
- Putting message bodies in notification logs, monitor state, prompts, or
  health files.
- Automatically approving tool calls merely because a turn was monitor-created.
- Claiming exact behavioral parity between Claude Code CLI and the Claude Agent
  SDK adapter.
- Silently mapping incompatible native permission modes.
- Supporting multiple simultaneously active prompt turns in one fleet role.

## Terminology

- **Harness**: the coding agent implementation, such as Codex or Claude.
- **Session backend**: the mechanism by which `ours-fleet` owns and communicates
  with a harness: `tmux` or `acp`.
- **Wake source**: the ours daemon notification and unread APIs.
- **Wake delivery**: submitting the fixed monitor instruction to the current
  agent session.
- **Observed cursor**: the highest daemon notification cursor durably copied into
  local pending state.
- **Delivered cursor**: the highest cursor whose pending wake was explicitly
  accepted by the session backend.
- **Native monitor**: a harness integration outside `ours-fleet`, currently
  Claude's Monitor tool or the `ours-codex` App Server watcher.
- **Fleet monitor**: the supervisor-owned monitor in `ours-fleet`.

## Existing Systems

### Ours daemon

`ours-mcp/packages/core/src/index.ts` supplies two complementary, authenticated,
body-free surfaces:

- `GET /identities/<identity>/notifications?since=<cursor|tip>` provides bounded
  long polling over the daemon-owned `notifications.log`.
- `GET /unread` returns the current unread message and file summary from
  `unread.json`.

The notification cursor is a byte offset. When a cursor is beyond a truncated
log, the daemon resets it to zero and replays from the beginning. Fresh `tip`
requests return the current end without replaying old events.

The notification log includes both actionable arrival events and operational
observability events. Actionable wake events are:

- `message_received`;
- `file_received`;
- `local_contact_request`;
- `pending_message`.

`ours-mcp watch` correctly whitelists these events. Consumers of the raw HTTP
endpoint must apply the same classification or an explicitly configured subset.

### Native Claude monitor

Claude Code uses its native background Monitor tool to run:

```text
ours-mcp watch <identity>
```

The command primes at the notification tip and writes one body-free stdout line
per actionable arrival. Claude's Monitor turns stdout into a session wake. The
Claude `SessionStart` hook separately surfaces unread backlog.

This path delegates session readiness, turn scheduling, and wake delivery to
Claude Code. The ours code owns only the body-free source command and backlog
hook.

Limitations:

- Monitor arming state is owned by Claude Code, not ours.
- Fleet supervision cannot inspect a structured delivery acknowledgement.
- The file fallback has weaker guarantees than the daemon API.
- The Claude hook currently reads the state directory directly, unlike the
  Codex hook and fleet monitor, which use the daemon API.

### Native Codex monitor

The approved native Codex design lives at:

```text
ours-mcp/docs/superpowers/specs/
  2026-07-15-codex-plugin-live-mail-monitor-design.md
```

The shipped live path consists of:

- `ours-codex`, which starts Codex App Server and a remote standard TUI;
- `MonitorWatcher`, which long-polls the ours daemon;
- `ControlServer`, which receives authenticated arm, disarm, binding, and status
  commands;
- monitor MCP tools;
- lifecycle hooks;
- a fixed, body-free wake prompt sent through App Server `turn/start`.

This is the closest existing implementation to the proposed ACP backend because
it uses structured turn operations rather than terminal keystrokes.

### Fleet tmux monitor

`ours-fleet/src/monitor.ts` long-polls the same daemon endpoint, coalesces events,
and injects a fixed line into a tmux pane. It then infers:

- whether a modal is open;
- whether Enter submitted the line;
- whether a turn is running;
- whether a turn ended in an API error;

from captured terminal text.

The monitor is started and stopped by `runOnce` with the tmux pane process.

## Findings in the Current Implementations

The following are requirements-driving findings, not optional cleanup.

### Fleet monitor findings

#### F1. Role name is used instead of identity

The runner creates the monitor with `name`, and the monitor requests:

```text
/identities/<role-name>/notifications
```

For a role whose `identity` differs from its role name, the wrong stream is
watched. Notification routing must use `role.identity`.

#### F2. Cursor is committed before delivery is accepted

The fleet monitor persists the response cursor before tmux delivery. A modal
give-up or unverified injection therefore removes that wake from the retry path.
Unread mail remains recoverable, but the agent may receive no further wake.

#### F3. Delivery exceptions can terminate monitoring

Composer clearing and tmux send operations can reject outside a recovery
boundary. The agent continues running while its monitor task can die.

#### F4. Capture failure can look like delivery success

`safeCapture` returns an empty pane on error. The verification logic interprets
the absence of the injected line as successful submission.

#### F5. Pane heuristics are harness-specific

Modal, running, and API-error patterns primarily describe current Claude Code
rendering but are used by a shared monitor.

#### F6. Polling and delivery are serialized

A modal wait or turn observation blocks notification polling. The daemon stream
is durable, but latency and health freshness degrade.

### Native Codex findings

#### N1. Active user-turn queue can remain stuck

`MonitorWatcher.#wake` sets `queued` when a user turn is active. The
`turn/completed` notification handler checks `pending`, not `queued`, so mail
arriving during an ordinary user turn may never start a wake turn unless another
event arrives.

#### N2. Raw HTTP events are not filtered

`MonitorWatcher.pollOnce` wakes on any non-empty `events` array. The daemon log
also contains migration, receipt, persistence, and E2E observability events.
Native Codex can therefore wake for non-mail events that `ours-mcp watch`
correctly suppresses.

#### N3. Authentication failure leaves control state armed

The watcher marks its private `authFailed` flag and stops, but the
`ControlServer` state is not disarmed and `monitor_status` can continue reporting
the identity as armed.

#### N4. Control and watcher state are split

`monitor-state.mjs` and `MonitorWatcher` maintain separate turn and pending flags.
Watcher cursor state is written to `cursor.json`; control state is written to
`state.json`. The state machine transitions for notification arrival, turn start,
turn completion, and errors are not used by the live watcher.

#### N5. Persisted state is written but not restored

The watcher saves cursor state, but the launcher does not load it. The approved
design describes watcher restart recovery, while the shipped watcher runs
in-process and is not restarted within a bounded budget.

#### N6. Watcher failures are swallowed

The subscription effect starts the watcher with a detached promise whose
rejection is ignored. `lastError` is not updated and the control state is not
degraded.

#### N7. Permission requests are automatically declined

The launcher answers every App Server request containing `requestApproval` with
`decline`. This does not preserve the approved design's normal visible approval
behavior and can make wake turns fail differently from user-created turns.

#### N8. App Server transport differs from the approved boundary

The approved design specifies a private Unix socket and explicitly excludes the
experimental WebSocket listener. The shipped launcher opens App Server on a
random loopback TCP WebSocket port. Loopback is not a per-user security boundary,
and free-port selection introduces a bind race.

#### N9. Arm may claim an unset binding

The shipped state machine permits `arm(identity)` to set an otherwise absent
binding. The approved design requires the requested identity to be currently
bound to the MCP session. This weakens correctness and can start a wake turn in a
session that cannot drain that identity's messages.

### Shared daemon findings

#### D1. Notification log is durable but append failure is best-effort

`appendNotifyLog` logs an error and continues. `unread.json` is refreshed
separately from authoritative packet state, so unread recovery remains available
when notification append fails, but low-latency wake is lost.

#### D2. Notification and unread updates are not one transaction

For message and file arrivals, the notification is appended before unread
refresh. A watcher can receive the event and start a turn before `/unread`
reflects it. The agent's `get_messages` authority is packet state, so message
delivery remains correct, but monitoring must not use `/unread` as an immediate
acknowledgement of a just-observed event.

#### D3. Notification cursors are transport offsets

Byte offsets are appropriate for this append-only local API but must remain
opaque to session backends. No ACP or tmux component should derive meaning from
cursor arithmetic.

## Design Principles

1. The ours daemon owns messages, unread state, notification events, and event
   cursors.
2. The monitor client owns durable wake intent, not message bodies.
3. A session backend owns prompt acceptance and turn lifecycle.
4. Observing an event is not the same as delivering a wake.
5. Delivery is at-least-once; duplicate fixed wake prompts are acceptable.
6. Only one active turn is allowed per role.
7. Mail arriving during an active turn remains durably pending.
8. Permission behavior is identical for user and wake turns.
9. Failure state must be queryable without reading logs.
10. tmux and ACP are peers behind one interface; neither is embedded in the
    harness adapter.

## Proposed Architecture

```text
selected ours daemon
├── notifications(identity, cursor)
└── unread(identity)
          │
          ▼
DurableWakeMonitor
├── profile + identity
├── observed cursor
├── delivered cursor
├── relevant event summary
├── pending wake
├── retry state
└── structured health
          │
          ▼
SessionHandle.submitPrompt(fixedWakePrompt)
          │
          ├── TmuxSessionHandle
          │     └── harness-specific terminal driver
          │
          └── AcpSessionHandle
                └── ACP session/prompt + explicit StopReason
```

### Repository ownership

`ours-mcp` should own a reusable, harness-neutral monitor client module. Two
acceptable packaging choices are:

1. a documented export from `@ours.network/mcp`, such as
   `@ours.network/mcp/monitor-client`; or
2. a small new package, such as `@ours.network/monitor-client`.

The module owns:

- daemon profile resolution;
- authenticated notification and unread clients;
- actionable-event classification;
- durable monitor state schema and atomic store;
- poll, backlog, coalescing, and retry state machine;
- health snapshots.

It must not depend on Codex, Claude, tmux, ACP, systemd, or launchd.

`@ours.network/codex` supplies an App Server delivery adapter and its consent
tools.

`ours-fleet` supplies tmux and ACP session backends and maps monitor lifecycle to
role supervision.

If publishing a shared package would block the first fix, `ours-fleet` may
temporarily keep its HTTP client, but it must implement the same serialized state
schema and conformance tests. Permanent source duplication is not accepted.

## Fleet Configuration

### Session backend

Add `session` to role and defaults:

```yaml
defaults:
  session: tmux

roles:
  Alice:
    harness: claude-code
    session: tmux

  Reviewer:
    harness: codex
    session: acp
```

Allowed values:

- `tmux`;
- `acp`.

Resolution:

```text
role.session
  ?? defaults.session
  ?? "tmux"
```

The default remains `tmux` for backward compatibility.

Add:

```text
ours-fleet spawn <name> --session tmux|acp
```

The persisted fleet drop-in uses the top-level `session` field. It must not store
this choice in `harness_options`.

### Backend-specific options

Advanced settings live under a separate map:

```yaml
session_options:
  acp:
    command: codex-acp
  tmux:
    boot_grace_ms: 15000
```

Only keys supported by the selected backend are validated. `command` is an
advanced override; normal users select only `session`.

### Compatibility matrix

Initial supported combinations:

| Harness | tmux command | ACP agent |
|---|---|---|
| `codex` | `codex` or `ours-codex` | `codex-acp` |
| `claude-code` | `claude` | `claude-agent-acp` |

ACP support is capability-gated. A missing ACP agent is a clear `doctor` failure
for an ACP role, not an automatic fallback to tmux. Silent backend fallback
would change interaction and permission behavior.

## Session Interfaces

```ts
export type SessionBackendId = 'tmux' | 'acp';

export interface SessionStartContext {
  role: ResolvedRole;
  stateDir: string;
  runCwd: string;
  mode: 'fresh' | 'resume';
  sessionId?: string;
  environment: Record<string, string>;
}

export interface TurnResult {
  accepted: boolean;
  outcome:
    | 'completed'
    | 'refused'
    | 'cancelled'
    | 'failed'
    | 'inconclusive';
  detail?: string;
}

export interface SessionSnapshot {
  backend: SessionBackendId;
  alive: boolean;
  readiness: 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'failed';
  activeTurn: boolean;
  lastOutput?: string;
  lastError?: string;
}

export interface SessionHandle {
  readonly backend: SessionBackendId;
  readonly sessionId: string;

  waitUntilReady(): Promise<void>;
  snapshot(): Promise<SessionSnapshot>;
  submitPrompt(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  waitForExit(): Promise<SessionExit>;
  close(): Promise<void>;
}

export interface SessionBackend {
  readonly id: SessionBackendId;
  checkPrereqs(role: ResolvedRole): Promise<PrereqReport>;
  start(context: SessionStartContext): Promise<SessionHandle>;
}
```

The runner must not call tmux directly after this interface is introduced.

### Harness adapter changes

`HarnessAdapter` continues to own harness semantics:

- briefing vocabulary;
- model and native option validation;
- fresh/resume behavior;
- terminal launch description;
- ACP agent description and session configuration translation;
- exit policy.

It does not own process supervision or monitor polling.

Suggested additions:

```ts
interface HarnessAdapter {
  // existing fields
  terminal(role, mode, state, prep): Launch;
  acp?(role, mode, state, prep): AcpLaunch;
  translatePermissions(common: CommonPermissions): NativePermissionConfig;
}
```

## ACP Backend

### Protocol target

Use stable ACP v1 through the official TypeScript SDK. During initialization:

- negotiate protocol version;
- persist advertised agent capabilities;
- use `session/new` for fresh roles;
- prefer `session/resume` when advertised;
- otherwise use `session/load` when advertised;
- rotate to a fresh session when neither recovery method is supported or when
  configured recovery fails fast.

The ACP process is a child of the fleet runner. The runner owns stdin, stdout,
stderr, termination, and restart behavior.

### Prompt serialization

The backend maintains one FIFO prompt queue per role. It never sends a second
`session/prompt` while the first remains unresolved.

Mail arriving during a user prompt only marks the monitor pending. When the
current prompt returns its `StopReason`, the fixed wake prompt is submitted.

ACP request cancellation is used for explicit fleet interruption. Session close
is used only when the agent advertises it.

### MCP configuration

ACP session creation should pass the selected ours MCP server explicitly. This
reduces dependence on harness-specific plugin discovery inside ACP adapters.

The same daemon profile selected for the monitor must be supplied to the MCP
server. The ACP agent and monitor may not resolve different ports, tokens, or
state directories.

### ACP event log

Persist a bounded, body-safe transcript projection for `peek` and status:

- user prompt summaries;
- agent text;
- tool names and statuses;
- permission request state;
- turn stop reason;
- errors;
- token usage when supplied.

Do not persist tool arguments or results by default because they may contain
message bodies or secrets. A future opt-in debug mode may use a separately
documented redaction policy.

## Tmux Backend

The first refactor wraps existing tmux launch, liveness, capture, send, and
shutdown behavior behind `SessionHandle`.

### Harness-specific terminal drivers

Move pane interpretation out of `monitor.ts`:

```ts
interface TerminalDriver {
  readiness(pane: string): SessionReadiness;
  clearComposer(): Promise<void>;
  submit(text: string): Promise<SubmissionResult>;
  classifyTurn(pane: string): TurnResult | 'running' | 'unknown';
}
```

Claude and Codex may provide different drivers. An unknown TUI version must
degrade to `inconclusive`, never fabricate successful delivery.

### Submission acknowledgement

The tmux backend cannot provide ACP-grade acknowledgement. It must nevertheless
distinguish:

- capture failed;
- text still present in composer;
- text submitted and turn observed;
- terminal offline;
- modal or permission prompt blocking input;
- inconclusive redraw.

Only `text submitted and turn observed` sets `accepted: true`.

Capture failure is a retryable error, not success.

## Durable Wake Monitor

### State schema

Each role stores one atomic body-free state document:

```json
{
  "version": 1,
  "identity": "Alice",
  "profileKey": "http://127.0.0.1:3050",
  "observedCursor": "1234",
  "deliveredCursor": "1190",
  "pending": {
    "firstCursor": "1190",
    "lastCursor": "1234",
    "eventTypes": ["message_received", "file_received"],
    "count": 3,
    "firstObservedAt": "2026-07-28T10:00:00.000Z",
    "attempts": 1,
    "lastAttemptAt": "2026-07-28T10:00:02.000Z"
  },
  "lastPollAt": "2026-07-28T10:00:03.000Z",
  "lastDeliveryAt": "2026-07-28T09:59:00.000Z",
  "lastError": null,
  "status": "armed"
}
```

Cursor values are serialized as strings and treated as opaque.

State writes use same-directory temporary files, mode `0600`, fsync where
available, and atomic rename. The containing role/runtime directory is mode
`0700`.

### Status values

- `starting`;
- `armed`;
- `pending`;
- `delivering`;
- `degraded`;
- `failed`;
- `disarmed`;
- `session_offline`.

The status API and CLI also expose timestamps, pending count, attempt count, and
the last sanitized error.

### First start

1. Resolve and authenticate the selected daemon profile.
2. Request notification `tip`.
3. Persist the returned cursor as `observedCursor`.
4. Query `/unread`.
5. If the configured identity has unread messages or files, create one pending
   bootstrap wake.
6. Start long polling from the primed cursor.

This closes the gap between tip priming and backlog inspection without replaying
the entire historical log.

### Resume or monitor restart

1. Load state only when its identity and selected profile match the current
   role.
2. Restore any pending wake before polling.
3. Poll from `observedCursor`.
4. Query `/unread` once.
5. If unread exists and no wake is pending, enqueue a bootstrap wake.

Never overwrite a valid persisted cursor with `tip` merely because the runner
restarted.

### Poll flow

1. Long-poll from `observedCursor`.
2. Validate response shape and cursor.
3. Filter events through the configured actionable wake-source set.
4. Merge relevant events into the pending wake.
5. Persist the new observed cursor and pending wake atomically.
6. Signal the independent delivery loop.
7. Immediately issue the next long poll.

Irrelevant events still advance `observedCursor`; they do not create a pending
wake.

### Delivery flow

1. Wait for a pending wake and a live, idle session.
2. Mark state `delivering` and persist the attempt.
3. Submit a fixed prompt containing no event-controlled fields.
4. On explicit acceptance:
   - advance `deliveredCursor` to the pending wake's `lastCursor`;
   - clear that pending range;
   - preserve any newer events merged during delivery as a new pending wake;
   - record outcome and timestamp.
5. On rejection, modal, permission wait, transport error, or inconclusive
   acknowledgement:
   - keep the pending wake;
   - record a sanitized error;
   - retry with bounded exponential backoff.

Polling never waits for delivery.

### Coalescing

Coalescing changes only prompt frequency. It never changes cursor durability.

Use:

- a short configurable batch window;
- one pending wake while a turn is active;
- one follow-up wake after the active turn completes if unread remains pending.

No notification batch is discarded because a modal lasted too long.

### Fixed wake prompt

Use plugin-owned text without sender, filename, IDs, body, or other event fields:

> New ours mail may be available for the identity already bound to this session.
> Follow the ours skill, call get_messages and get_files as appropriate, handle
> unread items within the current authority and permission boundaries, then
> return to the assigned role.

The exact prompt is versioned and tested as a constant.

### Delivery completion

Prompt completion is not proof that mail was handled. The monitor's guarantee is
that the wake prompt was accepted, not that every tool call succeeded.

After a completed wake turn, query `/unread`:

- no unread: clear health warnings;
- unread remains: enqueue another wake with bounded repetition;
- permission/refusal failure: keep pending and degrade;
- repeated completed turns with unchanged unread: degrade as
  `mail_not_draining` and stop hot-looping.

Use an unchanged-unread fingerprint made only from body-free counts and IDs.

## Repairing Native Codex

Before extracting shared code, bring native Codex into conformance:

1. Use one state machine for control, cursor, pending wake, turn lifecycle, and
   errors.
2. Filter raw daemon events with the shared actionable-event classifier.
3. On authentication loss, atomically disarm and expose failure through
   `monitor_status`.
4. Process `queued` on completion of any active turn, not only a watcher-created
   turn.
5. Load persisted session-local state on watcher restart.
6. Implement the documented bounded watcher restart budget or remove the claim.
7. Route watcher errors back into control state.
8. Preserve normal permission handling. Do not blanket-decline approval
   requests.
9. Use a private Unix socket transport when supported. If Codex requires
   loopback WebSocket, document it as a security exception, add a capability
   token or equivalent authentication, and remove the contradictory claim.
10. Require an actual bound identity before arming.
11. Add concurrency tests for:
    - arrival during a user turn;
    - arrival during a watcher turn;
    - multiple arrivals before completion;
    - turn failure;
    - watcher restart after cursor persistence;
    - auth loss and recovery;
    - observability-only event batches.

Native Codex and fleet ACP may share the fixed wake state machine, but their
delivery adapters remain separate: App Server versus ACP.

## Permission Model

### Common configuration

Add a top-level common intent:

```yaml
permissions:
  approval: ask
  filesystem: workspace
  unattended: deny
```

Allowed values:

`approval`:

- `ask`: request a human decision when the harness supports it;
- `deny`: never escalate beyond the configured sandbox;
- `allow`: automatically allow requests within the configured common boundary.

`filesystem`:

- `read-only`;
- `workspace`;
- `unrestricted`.

`unattended`:

- `deny`;
- `wait`.

Default:

```yaml
permissions:
  approval: ask
  filesystem: workspace
  unattended: deny
```

`unattended: wait` may leave a role awaiting a person but must surface
`awaiting_permission`; it may not report the role as idle.

### Translation

Adapters translate common intent to native configuration and return:

```ts
interface PermissionTranslation {
  native: Record<string, unknown>;
  exact: boolean;
  warnings: string[];
}
```

Codex can normally represent approval and sandbox separately.

Claude's native permission modes are not an exact two-axis model. For example,
`acceptEdits`, `dontAsk`, and `bypassPermissions` express different policies but
do not form a direct matrix with Codex sandbox modes. When translation is not
exact:

- require explicit harness-native configuration; or
- emit a validation warning and rely on fleet OS isolation for the filesystem
  boundary.

Never silently treat Claude `bypassPermissions` as equivalent to workspace-only
autonomy.

### Native escape hatch

Keep `harness_options` for native controls. If common and native values conflict,
configuration fails with both paths named. Native options do not silently
override common security intent.

### ACP permission requests

The ACP client implements `session/request_permission`.

- `approval: deny`: respond with denial.
- `approval: allow`: allow only when the requested action remains inside the
  common filesystem boundary and fleet isolation policy.
- `approval: ask`: forward the request to the role control socket.

If no human control client is attached:

- `unattended: deny` responds with denial;
- `unattended: wait` keeps the request pending and marks status accordingly.

Fleet OS isolation is an outer boundary. Neither ACP nor harness permission
translation may expand it.

### Tmux permissions

In tmux mode, native harness dialogs remain visible and are answered through
`attach` or `send --key`. The monitor does not type into a permission dialog.
The session snapshot must mark `awaiting_permission` when the terminal driver can
identify it.

## Role Control Socket

ACP stdio belongs to the persistent runner, while `ours-fleet send` and `peek`
run in short-lived CLI processes. Add one private per-role Unix control socket.

Commands:

- `status`;
- `snapshot`;
- `submit_prompt`;
- `respond_permission`;
- `interrupt`;
- `follow`;
- `shutdown` for the owning supervisor only.

The protocol is versioned JSONL with:

- a mode-`0700` parent directory;
- a mode-`0600` socket where supported;
- a random capability token stored mode `0600`;
- bounded line and response sizes;
- role and session ownership checks;
- request IDs and timeouts.

For tmux roles, the runner translates control commands to tmux operations. For
ACP roles, it translates them to ACP calls. This makes CLI commands and oversight
transport-neutral.

### Frontend boundary and future Toad integration

The session backend and the interactive frontend are separate concerns:

- the session backend owns the harness process and its ACP or terminal
  transport;
- the role control socket is the only supported attachment boundary;
- `ours-fleet attach` is the first control-socket frontend;
- third-party interfaces are adapters over the same control protocol.

This distinction is required for Toad compatibility. Toad is an ACP client: it
spawns an ACP agent command and exclusively owns that process's stdin and
stdout. It does not currently attach to an ACP agent process already owned by a
different client. Therefore the fleet runner and Toad cannot both directly own
the same Codex or Claude ACP subprocess.

Do not make Toad the fleet process supervisor, and do not expose or transfer the
runner's ACP stdio streams. Either approach would couple monitor reliability and
role lifetime to one UI process.

Instead, keep the control protocol rich enough for an additive ACP facade:

```text
Toad
  └── spawns: ours-fleet acp-attach <role>
                 └── authenticated role control socket
                        └── persistent SessionHandle
                               └── Codex/Claude ACP agent
```

The future `acp-attach` command acts as an ACP agent toward Toad and as a control
client toward the already-running fleet role. It maps:

- ACP `session/new` or `session/load` to attachment and snapshot recovery;
- ACP `session/prompt` to `submit_prompt`;
- ACP `session/cancel` to `interrupt`;
- fleet structured events to ACP `session/update`;
- ACP permission responses to `respond_permission`.

To support this without later architectural changes, the first control protocol
must:

- use stable typed event kinds rather than pre-rendered terminal strings;
- include monotonically increasing event sequence numbers and bounded replay;
- preserve turn IDs, tool-call IDs, permission IDs, and stop reasons;
- separate one optional controller lease from any number of read-only followers;
- reject stale permission responses and concurrent prompt ownership explicitly;
- negotiate protocol version and capabilities;
- keep rendering outside the runner.

The event stream may remain redacted as specified above. Toad can display tool
names, lifecycle, diffs explicitly supplied as safe structured content, and
agent text without needing raw tool arguments or results.

Implementing the ACP facade is intentionally deferred from the first MR. It is a
bounded integration after the control socket exists, but implementing it before
that boundary would require a premature ACP multiplexer and materially enlarge
the initial reliability change.

## CLI Behavior

### `ls`

List fleet roles from supervisor state, not only tmux sessions. Include backend:

```text
Reviewer  active  acp   codex
Alice     active  tmux  claude-code
```

### `send`

Submit through the role control socket. Text is queued when a turn is active.
Raw `--key` remains tmux-only and fails clearly for ACP.

### `peek`

- tmux: pane snapshot through the backend.
- ACP: bounded redacted event-log projection.

### `attach`

- tmux: existing `tmux attach`.
- ACP: a fleet streaming client over `follow`, with prompt and permission input.

An initial ACP release may provide `follow` before a full-screen attach UI, but
it may not claim feature parity until permission responses and prompt submission
are supported.

### `status`

Combine:

- supervisor status;
- session backend snapshot;
- monitor structured health;
- pending permission state;
- isolation degradation.

### `doctor`

Check tmux only when at least one selected role uses tmux or the user explicitly
requests it.

For ACP roles, check:

- ACP SDK availability;
- harness ACP agent command;
- initialization and advertised capabilities;
- authentication readiness;
- selected ours daemon profile;
- monitor API and unread API.

Doctor does not create a lasting agent session.

## Supervision and Recovery

### tmux

Retain the current systemd/launchd runner and tmux child lifecycle. Session ID
rotation rules remain adapter-controlled.

### ACP

The runner directly owns the ACP agent child:

- child exit resolves `waitForExit`;
- runner shutdown sends ACP cancellation/close when supported;
- then sends `SIGTERM`;
- after a bounded grace, sends `SIGKILL`;
- no orphan ACP process may survive the runner;
- stderr is captured in supervisor logs;
- non-ACP stdout is a protocol failure.

Persist the ACP session ID returned by the agent, not a fleet-generated
substitute.

On restart:

1. initialize a new ACP connection;
2. resume when advertised;
3. otherwise load when advertised;
4. otherwise start fresh and inject the restart briefing;
5. restore the durable pending wake independently of conversation recovery.

Session recovery failure must not clear monitor pending state.

## Security and Privacy

- Notification and unread APIs remain authenticated.
- Monitor state contains no message body.
- Fixed wake prompts contain no event-controlled fields.
- ACP transcript projection is redacted by default.
- Control and session sockets are private to the fleet OS user.
- Loopback TCP alone is not accepted as an authentication boundary.
- Permission responses are scoped to the current request and configured policy.
- Monitor-created turns use the same sandbox and approvals as user turns.
- Daemon tokens are never written into status or logs.
- Profile identity includes origin and a non-secret token fingerprint so state
  cannot be reused against a different daemon accidentally.
- A role identity change atomically disarms the previous monitor, clears its
  cursor/pending state, and requires explicit configuration or consent before
  arming the new identity.

## Backward Compatibility

- Missing `session` means `tmux`.
- Existing `harness_options` remain accepted.
- Existing `monitor:` blocks retain their defaults and event selection.
- Existing tmux command behavior remains available.
- `.monitor-status` may remain as a human-readable compatibility summary, derived
  from the new structured state.
- Old temp role snapshots without `session` resolve to tmux.
- No existing role is silently converted to ACP.

## Migration

### Phase 1: Correctness without ACP

- Fix role identity routing.
- Add durable pending wake state.
- Split poll and delivery loops.
- Make tmux capture failure non-success.
- Catch delivery errors.
- Add structured monitor health.
- Repair native Codex findings N1-N9.
- Establish shared conformance fixtures for daemon event filtering.

### Phase 2: Session abstraction

- Introduce `SessionBackend` and `SessionHandle`.
- Wrap all current tmux behavior.
- Move CLI `send`, `peek`, status, and monitor delivery to the interface.
- Add the role control socket.
- Keep output and behavior unchanged for tmux roles.

### Phase 3: ACP experimental backend

- Add `session: acp`.
- Implement Codex ACP first because native Codex already proves structured
  externally started turns.
- Add capability-gated resume and close.
- Add structured permission handling.
- Add ACP event-log projection and CLI follow.

### Phase 4: Claude ACP

- Validate Claude Agent SDK adapter behavior against required fleet features:
  MCP server injection, session recovery, permissions, working directories,
  additional roots, hooks/skills equivalence, and context persistence.
- Document known behavioral differences from Claude Code CLI.
- Enable only after the same monitor and session conformance suites pass.

### Phase 5: Shared defaults

- Keep tmux as the default through at least one stable ACP release.
- Consider ACP as the recommended backend for unattended roles only after soak
  metrics show no increase in missed wakes, stuck permissions, or failed session
  recovery.

## Test Strategy

### Shared monitor contract tests

Run the same tests against native Codex, fleet tmux, and fleet ACP delivery
adapters:

- tip prime followed by backlog inspection;
- event between tip and unread query;
- message arrival;
- file arrival;
- local introduction;
- queued pending message;
- observability-only batch;
- burst coalescing;
- arrival during user turn;
- arrival during wake turn;
- transport failure before acceptance;
- crash after cursor persistence and before delivery;
- restart with pending state;
- log rotation/reset;
- daemon restart;
- authentication loss;
- identity change;
- unread remains unchanged after a completed wake;
- no bodies in state, prompt, status, or logs.

### Session backend contract tests

Every backend must pass:

- fresh start;
- resume or documented fresh fallback;
- readiness;
- serialized prompts;
- active-turn queueing;
- explicit interrupt;
- permission request;
- child/session exit;
- runner shutdown;
- snapshot and status;
- control-socket send and peek.

### Native Codex regression tests

Add tests that currently fail:

- queued wake is delivered after an unrelated user turn completes;
- `e2e_app_recv` without an actionable event does not wake;
- `401` makes status failed/disarmed;
- watcher rejection updates status;
- persisted cursor and pending wake restore;
- approval request follows configured policy rather than blanket decline;
- bound identity is required by `arm`.

### Fleet tmux regression tests

Add tests that currently fail:

- role name differs from identity;
- `capture` failure does not acknowledge delivery;
- `sendText` rejection retains pending wake;
- modal timeout retains and retries pending wake;
- polling continues while delivery is blocked;
- Codex pane is not parsed with Claude-only patterns.

### ACP integration tests

Against each supported ACP adapter:

- initialize and capability negotiation;
- new session;
- resume/load where advertised;
- fixed wake prompt;
- streamed session updates;
- StopReason classification;
- permission request round trip;
- cancellation;
- session close;
- process crash and recovery;
- ours MCP tools available in the session.

Live tests are opt-in locally and required in release CI against pinned minimum
and current adapter versions.

## Observability

Expose per role:

- session backend and harness;
- session readiness;
- monitor status;
- last successful notification poll;
- observed cursor presence, without interpreting its value;
- pending wake count and age;
- delivery attempts;
- last accepted wake;
- last turn outcome;
- unread-drain health;
- pending permission age;
- sanitized last error.

Recommended counters:

- notification batches observed;
- actionable events observed;
- wakes coalesced;
- wake submissions attempted;
- wake submissions accepted;
- duplicate wake submissions;
- wake turns completed/refused/failed;
- monitor reconnects;
- session recoveries;
- permission requests allowed/denied/timed out.

No metric labels contain identity names, contact names, filenames, message IDs, or
bodies by default.

## Acceptance Criteria

The design is complete when:

1. `session: tmux|acp` and `--session` select the backend without changing
   `harness`.
2. Existing roles default to tmux.
3. A role whose name differs from its ours identity watches the identity.
4. Relevant events remain pending across injection failure and runner restart.
5. Polling continues while delivery is blocked.
6. ACP wake delivery uses `session/prompt` and explicit completion, with no
   terminal injection.
7. Mail arriving during any active turn triggers a later wake.
8. Native Codex filters non-actionable daemon events.
9. Authentication loss cannot leave any monitor reporting armed.
10. User and monitor-created turns share permission policy.
11. `send`, `peek`, status, and permission responses work for ACP roles through
    the control socket.
12. Common permissions are validated and translation ambiguity is visible.
13. No persisted monitor or ACP diagnostic artifact contains message bodies.
14. Shared conformance tests pass for native Codex, fleet tmux, and fleet ACP.

## Open Questions for Review

1. **Shared package location:** export monitor-client primitives from
   `@ours.network/mcp`, or publish a dedicated package?
   - Recommendation: dedicated small package if release coupling is acceptable;
     otherwise a documented core subpath export.
2. **ACP attach UI:** is a streaming line UI sufficient for the first release,
   or is full-screen parity required?
   - Recommendation: ship `follow` plus prompt/permission input first, and label
     full-screen attach as follow-up. Keep the stream frontend-neutral so a
     later `ours-fleet acp-attach <role>` facade can expose the running role to
     Toad without changing the runner or monitor.
3. **Unattended approval default:** deny immediately or wait?
   - Recommendation: `deny`, because an invisible indefinite permission wait
     looks like a healthy but stuck role.
4. **Native Codex transport:** does the supported Codex floor now provide a
   private Unix App Server transport?
   - Recommendation: capability-test it. If unavailable, explicitly document and
     authenticate loopback WebSocket rather than claiming a Unix boundary.
5. **Common Claude permission translation:** which combinations are officially
   supported without warnings?
   - Recommendation: keep mappings conservative and treat fleet OS isolation as
     the enforceable filesystem boundary.
6. **Monitor consent in declarative fleets:** does `monitor.enabled: true`
   constitute persistent owner consent for both backends?
   - Recommendation: yes for fleet-managed roles, while interactive native
     sessions retain per-session consent.

## Source References

Primary local implementation references:

- `ours-fleet/src/monitor.ts`
- `ours-fleet/src/runner.ts`
- `ours-fleet/src/harness/types.ts`
- `ours-fleet/src/harness/codex.ts`
- `ours-fleet/src/harness/claude-code.ts`
- `ours-mcp/packages/core/src/index.ts`
- `ours-mcp/packages/core/src/cli.ts`
- `ours-mcp/packages/codex/src/watcher.mjs`
- `ours-mcp/packages/codex/src/monitor-state.mjs`
- `ours-mcp/packages/codex/src/control-server.mjs`
- `ours-mcp/packages/codex/src/app-server-client.mjs`
- `ours-mcp/packages/codex/src/launcher.mjs`
- `ours-mcp/packages/codex/src/monitor-mcp.mjs`
- `ours-mcp/packages/codex/src/hooks/runner.mjs`
- `ours-mcp/packages/claude-code/src/hooks/runner.ts`
- `ours-mcp/docs/superpowers/specs/2026-07-15-codex-plugin-live-mail-monitor-design.md`

Protocol references:

- ACP v1 prompt lifecycle and StopReason:
  `https://agentclientprotocol.com/protocol/v1/prompt-turn`
- ACP v1 session creation, load, resume, and close:
  `https://agentclientprotocol.com/protocol/v1/session-setup`
- ACP v1 session configuration:
  `https://agentclientprotocol.com/protocol/v1/session-config-options`
- ACP v1 stdio transport:
  `https://agentclientprotocol.com/protocol/v1/transports`
- Official TypeScript SDK:
  `https://github.com/agentclientprotocol/typescript-sdk`
- Codex ACP adapter:
  `https://github.com/agentclientprotocol/codex-acp`
- Claude Agent ACP adapter:
  `https://github.com/agentclientprotocol/claude-agent-acp`
