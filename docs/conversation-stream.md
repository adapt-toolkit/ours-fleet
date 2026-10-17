# Conversation event stream (wire version 1)

`GET /api/v1/roles/:id/conversation/events?expectedGeneration=GENERATION&after=CURSOR`
uses the existing Fleet route boundary, including `/fleet/api/v1/...` through the
prefix gateway. Use authenticated `fetch`, then read the response body. Cookies
work for standalone and same-origin frame access; the hosted App sends its current
workspace access bearer in `Authorization`. Query parameters are data, never
credentials. `after` is a nonnegative safe integer; generation is required.
No new WebSocket path, controller lease, notification acknowledgement, work
submission, or read receipt is introduced.

## Framing

Content type is `text/event-stream; charset=utf-8`, with `Cache-Control: no-store`
and `X-Accel-Buffering: no`. Every frame is exactly:

```text
event: conversation
data: {"version":1,"type":"TYPE","payload":...}

```

The six logical types are:

- `role`: complete public role replacement (`roleId`, `roleRevision`,
  `roleLifetime`, `availability`, `health`, optional backend/fallback/failure).
  Local state paths are omitted. This ordering is independent of session state.
- `ledger`: either a single durable conversation event, or a coverage marker
  `{coveredThrough:number}`. All events covered by a marker precede it. Replay
  can legitimately advance coverage without visible events. Never advance a
  recovery cursor from maximum rendered event sequence alone.
- `ready`: `{sessionGeneration,stateRevision,ledgerBarrier,coveredThrough,
  capability:"complete",authorizedUntil}`. The coherent initial snapshot arrives
  as a preceding `state` record, keeping its full 16 MiB payload budget. Hold
  initial state/replay as provisional until matching ready; validate generation,
  stateRevision and ledgerBarrier against the staged state and coverage against
  delivered replay. Only successful private replay certifies `coveredThrough`;
  the snapshot barrier alone does not. Disconnect between state and ready must
  not publish live initial state or advance the certified cursor. Reconnect with
  same-generation certified coverage. State revision and event sequence differ.
- `state`: complete conversation observation replacement, including
  `sessionGeneration`, `stateRevision` and `ledgerBarrier`. Do not merge it as a
  patch or use its barrier as coverage.
- `resync`: `{reason,retry,capability}`. Clear partial assembly and resynchronize
  explicitly or enter supported fallback. Temporary role read/watch failure is
  retryable; a fresh observer can recover after repair. `retry:false` alone does
  not establish permanent incapability on older servers. Explicit unsupported
  capability or persistent oversize remains supported fallback without tight reconnects. `capability` is
  `degraded`, except `auth-expired` below.
- `keepalive`: `{at:number}`. Transport liveness only; it cannot certify role,
  session, replay, or private-control health.

A large logical payload uses `start`, ordered `chunk`, then `commit` frames,
without the `payload` field:

```json
{"version":1,"type":"start","id":"3","recordType":"state","totalBytes":1048576,"generation":"g","revision":7}
{"version":1,"type":"chunk","id":"3","index":0,"data":"a slice of the serialized payload JSON"}
{"version":1,"type":"commit","id":"3","totalBytes":1048576,"generation":"g","revision":7}
```

Chunks contain JSON text, **not base64**. Concatenate `data`, UTF-8 count it,
then JSON-parse only after commit. The optional generation/revision are derived
from payload sessionGeneration/stateRevision or roleRevision;
commit and reconstructed payload must match start. Reject duplicate/out-of-order
chunks, empty chunks, mismatched identities/revisions/lengths, overlapping assemblies, invalid
UTF-8, over-budget frames, and an incomplete end. Never publish partial snapshots.
`ConversationStreamDecoder` implements these framing checks without Node APIs.
It is not a domain reducer: consumers must additionally enforce current workspace,
generation and monotonic state/role revisions before applying records.

## Limits and ownership

Encoded frames, including SSE and JSON overhead, are at most 512 KiB. Payload JSON
is at most 16 MiB; one assembly is allowed at a time. The encoder splits at safe
UTF-16 boundaries into at most 48 Ki code units, so JSON escaping still fits the
encoded-frame bound. The active logical record is streamed progressively while
waiting encoded records are capped at 8 MiB per web connection. A valid 16 MiB
ledger event is sent independently of its coverage marker so the page envelope
does not consume its logical-record budget. Oversize records explicitly degrade.
The writer waits for socket drain before writing another frame; overflow sends a
resync when writable, otherwise closes. Ledger delivery has no batching delay
(therefore no intentional wait beyond the required 50 ms); network backpressure
can delay actual receipt.

The private supervisor separately owns its 8 MiB live replay backlog and writes
64 KiB slices under socket backpressure. The adapter bounds each raw NDJSON line
at 16 MiB plus the maximum computed serialized replay/ready/state/event envelope
(replay has an empty events array; ready omits its null placeholder; coverage uses
`Number.MAX_SAFE_INTEGER`). This admits one exact 16 MiB event;
malformed or oversized passive input closes the stream. The receiving browser
owns its 16 MiB assembly limit. A parsed record, serialized UTF-16 string, encoded
frame, and socket buffers can coexist: these are logical budgets, not an RSS cap.
Aggregate memory scales with connections, as do role watchers and private sockets.
There is no global subscriber cap. HTTP/1 browsers commonly share about six
connections per origin; multiple tabs, pane consumers and voice can exhaust that
pool. Dispose surplus consumers; HTTP/2 deployment and browser pooling vary.

Each web connection owns one role observer, including while the role is missing.
Session describe/follow borrow it. Missing/replaced roles stop the old follow;
reappearance can open another follow, still bound to the requested generation.
Abort, revocation, server shutdown and late connector completion release owners
idempotently. Pane observation does not acquire or release voice's independent
controller. Private heartbeats remain serialized every two seconds; six seconds
without one ends private health even if SSE keepalives continue.

Fleet emits browser keepalives every second. Each App pane/voice attempt independently
bounds opening through complete ready to ten seconds, regardless of incoming activity.
After ready, nonempty byte chunks (including keepalives/comments and partial records)
reset a ten-second silence deadline. Elapsed checks before activity and on browser
visibility/pageshow resume give no hidden grace; suspended code expires at its first
subsequent check. Expiry retires health and aborts the old attempt before bounded
recovery/fallback. These browser clocks do not renew or replace credential deadlines.
Comment-only/blank SSE frames are transport activity and publish no domain record.

## Authentication, fallback and filesystem assumptions

The stream is bound to its **opening** credential deadline. Rotating access lasts
at most five minutes; it is not renewable in place. On `auth-expired`, obtain the
renewed access credential and reconnect using only same-generation certified
coverage. Count this normal auth reconnect separately from degraded operation.
Fixed credentials use their device/sunset deadline. Cookie idle expiry is checked
without updating lastSeenAt, including the exact 30-minute boundary; ordinary
requests still update activity. Absolute expiry and revocation also end streams.
The terminal resync uses `capability:"auth-expired"`, with retry `"authenticate"`
for rotating credentials or `"reauthenticate"` for cookies/fixed credentials.
Actions after expiry must reauthenticate; heartbeats cannot refresh session policy.

`conversation_live_complete` describes current intersection of healthy role
observation and private replay/heartbeat capability. It never certifies requested
history. REST remains for initial latest history, user-requested older pages,
explicit recovery, and older/unsupported/degraded server fallback. Healthy active
consumers must not periodically fetch role details or history.

Active pane and independent voice consumers recover transient transport, temporary observer or
bootstrap failures after their bounded fast attempts: one delayed attempt after 10 seconds,
then 20 seconds, then capped 30 seconds between failed settled attempts. Fallback refresh ticks
do not start probes. Retire/abort the fallback request and timer before recovery takes cursor
ownership; fence late responses without waiting indefinitely for cancellation. Resume only
same-generation certified coverage; otherwise establish a canonical latest baseline. Ordinary
REST progress and identical unsuccessful resync never reset the fast restart budget. Complete
ready ends fallback polling and resets delayed backoff. Pane generation replacement may load a
new baseline; voice generation replacement stops that session until explicit Start, without
transferring controller/provider leases. Auth-required/expired ends automatic reads/probes.


Complete role delivery relies on native directory notifications for fleet config,
role manifests and session files. Qualified native host filesystems are the
intended deployment (macOS local APFS or Linux local filesystems with functional
inotify). Watch errors, unexpected closure, unsupported watching, or invalid
current role reads withdraw completeness. Silent event loss is not detectable
without polling and is not promised away. Docker must expose the same state files
and private socket to the Fleet process, with working directory-change delivery
across the selected bind mount/volume. Docker Desktop host-to-VM mounts, network
filesystems and remote/FUSE mounts require deployment-specific notification tests;
use degraded REST fallback when those assumptions cannot be established. No ACP
library changes are required.

## Admission receipt provenance

Prompt admission responses additionally expose optional `sessionGeneration`: the
original durable admission generation. Both backend session generations are immutable
for the admitting lifetime. Cached receipts retain that generation, and reopened command
indexes derive it from the original `prompt.admitted` event, never a replacement session.
Historical receipts without provable generation leave the field absent.

This permits an explicitly retried pre-change `{text, commandId}` browser draft to settle
only when matching receipt identity and original generation validate against its captured
current owner. Missing/old provenance keeps a visible unresolved draft and its idempotency
ID. Existing generation-bound drafts retain their original fences. `eventCursor` and causal
coverage/inventory settlement remain unchanged; provenance is not a new settlement watermark.

## Cross-repository qualification

`test/web/fixtures/conversation-stack.ts` shares the real HTTP and private-control
stack with the legacy conversation tests and the matching App checkout's optional
`tests/fleet-live-data.integration.mjs`. ACP uses the existing child-process protocol
fixture; native Codex uses the existing app-server protocol driver. Both exercise
actual session, ledger, control adapter, HTTP framing and App decoder/reconciler/UI.
Role availability changes are controlled fixture inputs; this does not qualify native
filesystem event delivery on an arbitrary mount.

Run Fleet's full tests and typecheck after integrated changes. Retain the SSE,
workspace-auth-provenance and workspace-tunnel suites for frame/hosted authentication,
expiry/revocation, delayed-open disposal and bounded slow consumers. App reports
healthy content requests separately from bootstrap, paging, credential reconnect,
explicit recovery and unsupported-host fallback. DOM mutation and fixture latency
measurements have no claim about real-provider inference or physical-device audio.
The App and Fleet changes require coordinated upstream delivery; source qualification
does not establish that installed or serving packages contain them.

## Full resource delivery qualification

Directory, configuration/definitions, previews, provider/status, layout and admitted-operation views share the authenticated ephemeral resource connection with per-view epochs. Complete ready requires the canonical subscribed payload; a heartbeat does not certify a failed upstream watcher. User commands remain HTTP. Controller, voice and selected-daemon health are independent owners. The selected-daemon health deadline passes its cancellation signal through the public SDK selection/request API, cancelling underlying HTTP I/O as well as retiring the result.

The matching App source qualification composes the existing ACP/Codex browser fixture and records sixty-second healthy windows separately from initial/history/recovery/command/health/lease/long-poll traffic. Unit and HTTP producer checks are not proof of every rendered resource combination or installed deployment. Preserve existing room-layout suite sources and qualify released service/dependency versions separately.
