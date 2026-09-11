# Hermes owner comments and self-improvement notices

## User-visible behavior

Reuse the existing owner-channel `/comments [status|on|off]` command, batching,
label, limits, authorization and delivery. The additional messages go only to
the authenticated owner of the originating request. There is no new channel,
command, service or database. Ordinary assistant text and final answers remain
unchanged; text may appear both in a comment and in the ordinary response.

Hermes supplies two existing callbacks: `interim_assistant_callback` for model
commentary, and `background_review_callback` for the self-improvement summary
that can report a patched skill. Model commentary is optional model output, not
a periodic heartbeat. Tool events are not converted into model commentary.

## Wire contract

Fleet proposes `clientCapabilities._meta.hermes.messagePhases = 1` when the
configured harness is Hermes. A supporting server acknowledges exactly version
1 in `agentCapabilities._meta.hermes.messagePhases`. Without acknowledgment,
Fleet keeps the existing behavior and reports no Hermes message-phase support.

Each `session/prompt` supplies `_meta.hermes.turnId`, an opaque Fleet prompt
UUID. It contains no owner CID or prompt text. Hermes captures this token and
the ACP connection in its callbacks. Each additional notification is:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "messageId": "hermes:<unique UUID>",
  "content": {"type": "text", "text": "Checking the skill."},
  "_meta": {"hermes": {
    "messagePhases": 1,
    "phase": "commentary",
    "source": "assistant",
    "turnId": "<original Fleet prompt UUID>"
  }}
}
```

`source` is exactly `assistant` or `background_review`. Unmarked ordinary text
retains its existing semantics. Missing/unknown tokens, malformed or conflicting
metadata, oversized notices and replay are dropped before generic attribution.

## Code changes

Hermes `acp_adapter/events.py` builds additional notifications. `server.py`
negotiates the extension, installs both callbacks for a prompt, and restores
them in `finally` before draining another prompt. Additional callbacks never
change `cbs.streamed` or suppress a final answer. `agent/background_review.py`
snapshots the callback before the worker starts, including an explicit `None`:
a review must not discover a later request's destination at completion time.

Fleet `src/session/acp.ts` records a bounded prompt-token to owner-origin map
before submitting a prompt. Recognized Hermes notices take an early path before
normal text accumulation, steering occupancy, progress tracking and generic
ledger attribution. They become existing `agent_text` events with
`messagePhase: commentary`, a message ID, original turn/origin and
`commentarySource`. Additional bodies are redacted in durable diagnostics.
The normal response keeps its existing storage policy.

`src/owner-channel/channel.ts` retains the corresponding original owner/wire
route and a session listener after completion. Background notices reuse the
commentary send helper and never select the current/latest owner. Early notices
between queue admission and listener installation are recovered from the bounded
live event buffer, using the same replay/correlation/dedupe checks. Final and
review sends share the original request's outbound queue. Toggle, authorization,
expiry and shutdown are rechecked immediately before sending.

Both route maps hold at most 128 entries for one hour from admission/start.
They are memory-only and expire or disappear on session restart. There is no
cross-restart recovery, offline retry or fallback route. Shutdown unsubscribes
and waits for outstanding sends using the existing bounded close path.

Codex-backed Hermes may previously have displayed commentary through its legacy
thought fallback. Installing the first-class commentary consumer removes that
fallback duplication; real reasoning/analysis and ordinary response text remain
unchanged. This is a classification change, not a change to the model's answer.

## Verification and review checkpoints

1. Hermes tests first reproduce missing capability/callback wiring and a late
   review being misrouted after its callback is replaced, including captured
   `None`. Implement the callback bridge and run the real-router, background
   review and existing ACP suites with `scripts/run_tests.sh`.
2. Fleet ACP fixture tests first reproduce missing negotiation and review text
   leaking into the next turn's output. Test actual JSON-RPC input, strict
   metadata types, original-owner attribution and on-disk redaction; retain
   existing Codex/legacy coverage.
3. Owner-channel tests first reproduce missing post-final delivery, early
   delivery loss and review/final overlap. Test both owners, unknown/replayed
   notices, toggle/revocation/expiry while queued, capacity and shutdown.
4. Run a deterministic cross-repository stdio probe using the real Hermes ACP
   server/router and Fleet adapter. Stub only provider/tool side effects and
   the owner transport. Produce A's review during B, preserving A's owner and
   B's ordinary output. This proves transport/adapter integration, not live
   provider generation quality or daemon delivery.
5. Independent review checks the combined implementation against this contract;
   resolve findings before opening the linked Hermes and Fleet PRs.

No direct `skill_manage` parsing is required for self-improvement summaries.
Normal in-turn skill operations already have ACP tool start/update and diff
content. Detecting a verified applied mutation is a separate concern: a staged
write can currently render `completed`/`Skill updated`, so those presentation
fields alone do not prove a write was committed.
