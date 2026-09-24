# Corroborated task readiness and safe recovery

Tracks #183. Lifecycle intent is durable; readiness is a current observation.

## Acceptance criteria
1. Establish sanitized root cause with isolated reproducer.
2. Task readiness reflects actual room seats and supervisor availability, including degraded cases.
3. Retained-context recovery avoids duplicate sessions and preserves evidence.
4. Regression/unit and CLI integration tests prove behavior.
5. Independent Critic design/code/security review with exact commits.
6. Sanitized upstream issue and linked fix PR, with Owner human QA pending and no production mutation/merge/deploy.

## Design and usage simulation

`task start` on a completed active room observes current evidence without restarting
provisioning. `task show` separates lifecycle from readiness. Current Cowork room
identity/state, exact member CID and role, recorded supervisor launch generation,
supervisor liveness and authenticated session status must agree before ready.
Readiness probes are bounded and read-only. Missing or inconsistent evidence gives
`degraded`, fixed diagnostics and coordinator recovery guidance. It is not evidence
that a timed-out agent is dead. Running, idle and awaiting-permission live sessions
are available; starting and failed sessions are not ready. Incomplete provisioning
continues as `in_progress` using existing continuation behavior.

All provisioning outcome consumers await the same observation, including create,
start, work alias, detached workers and owner messages. Task lifecycle and original
member records are unchanged by observation. Extra/replacement seats never substitute
for the exact expected CID. Repeated/concurrent starts never respawn, recover invites,
adopt replacement identities, or copy archived identity state into live directories.
Additional single-member incident evidence reinforces the same backend-neutral failure.
Untracked same-role seats are reported without inferred adoption; Owner/observer seats
are not replacements. Recovery handover preserves verified old/new provenance privately.
A new inbox does not backfill history: page scoped history to the end, authenticate
historical Owner instructions and compare completed actions/replies before resuming;
uncertainty requires clarification rather than replay.

Recovery consists of detection/guardrails and a documented coordinator procedure to
inspect retained context and existing replacements before a deliberate new session.
Automatic replacement/rebinding is not part of this change.

The independent Critic accepted gates 2–3 with constraints: bound latency, sanitize
errors, preserve genuine provisioning continuation, correlate exact generations,
cover all ready labels, and prove absence of duplicate/mutating effects.

## Threat baseline

Assets: identity binding, launch ownership, retained private context, room membership.
Inputs: durable local metadata, authenticated Cowork management RPC, authenticated
session control RPC. No new listener, credential or mutation authority. Do not infer
ownership from counts/display names or socket-file existence. Recheck launch identity
after probes. Whitelist diagnostics; transport errors, briefing text, control tokens,
paths and session lastError are not copied into readiness diagnostics. Invalid role
names must not traverse outside the temporary state root. Unknown liveness fails
closed without authorizing cleanup or replacement. Existing archives remain private.

## Acceptance-to-test map

- AC1: `task-readiness.test.ts`: synthetic active/launched member with removed seat.
- AC2: same suite: healthy, busy, permission wait; absent/mismatched room, removed or
  mismatched seat, failed/unknown supervisor, dead/unavailable session, launch race,
  invalid role, Owner-seat loss, partial two-member loss, untracked/extra seats and sanitized diagnostic cases.
- AC3: same suite plus CLI integration: repeated/concurrent active starts with existing
  replacement, retained archive byte preservation, no provisioning/mutation calls.
- AC4: `task-readiness-cli.test.ts`: real command/service with isolated state and local
  socket fixtures, healthy authenticated control, absent control and bounded timeout, JSON and human output. Owner commands await the same observation. Relevant existing task/owner suites.
  Red tests committed first; mutate 1–3 critical checks, observe failures, restore.
- AC5: manual gate 6 exact-head independent code/tests/security review, dependency
  audit and public-diff secret scan; gate 9 per-criterion evidence audit.
- AC6: manual gate 9 verify issue/PR linkage and sanitized published content.
  Human QA: Owner exercises isolated fixture/CLI flow and accepts; pending until then.

## Delivery gates

0–3 complete: isolated branch, scope, threat baseline, design challenge and usage
simulation. 4: spec committed before implementation. 5: test-first coverage, cleanup
and three caught mutations (room CID, launch generation, live control); final relevant
suite 636 passed, zero failed, one optional Cowork-checkout-dependent close test
skipped. Typecheck passes; all 30 readiness unit cases pass after mutation restoration.
6: independent exact-head review pending. 7–8: implementation and docs committed.
9: evidence audit and Owner human QA pending. 10: issue + PR only. 11–12: no merge/deploy/runtime mutation
authorized. Keep private host details and room messages outside this repository.
