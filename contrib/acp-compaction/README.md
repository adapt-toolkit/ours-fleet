# ACP compaction adapters

This directory contains the adapter and Python SDK changes used by Fleet's ACP
compaction consumer. It includes reviewable patches, immutable upstream pins,
licenses, and setup and test commands. No unpublished checkout is required.
Fleet's normal install continues to use its released adapter dependencies; select
a prepared adapter explicitly to enable the corresponding producer.

Automatic monitor and owner-channel ingress queues until the active prompt settles,
including with legacy adapters. It does not depend on lifecycle coverage. Fleet
consumes negotiated standard `session/update` compaction events, discards summaries,
and records one timeline entity per session/compaction ID. An observed active
compaction defers ordinary Stop without sending or scheduling cancellation.

## Prepare an adapter

Use Node.js 22.12+, 24.x, or 26+, Python 3.11 and `uv` for Hermes, Git,
a POSIX shell, and network access for
pinned upstream sources and package dependencies. Each preparation command writes
only to its selected new target and installs dependencies there. Existing runtime
credentials remain a separate requirement; preparation does not launch a live
agent or access a model provider.

From the Fleet checkout:

```sh
npm ci
npm run build
node contrib/acp-compaction/codex/prepare.mjs /absolute/path/to/prepared-codex
node contrib/acp-compaction/claude/prepare.mjs /absolute/path/to/prepared-claude
python3 contrib/acp-compaction/hermes/setup.py --target /absolute/path/to/prepared-hermes
```

Prepare only the adapters you intend to use. Consult each directory's README for
its exact pins, validation commands, launcher, and cached-source options:

- [Codex](codex/README.md): native compaction item translation and legacy fallback.
- [Claude](claude/README.md): structured SDK lifecycle, ID and terminal deduplication.
- [Hermes](hermes/README.md): turn ownership/finalization fixes and committed compaction outcomes.
- [Python SDK](python-sdk/README.md): licensed source, typed unstable protocol support,
  and a deterministic wheel build.

## Select the prepared producer in Fleet

For an ACP role, set `session: acp` and `session_options.acp.command` to the
prepared launcher using an argv array. For example, after the Codex setup:

```yaml
session: acp
session_options:
  acp:
    command: [/absolute/path/to/prepared-codex/run-adapter.sh]
```

Use the precise launcher and environment settings from the chosen adapter's README.
The launchers and their dependencies must be visible in the role's configured
filesystem isolation. A native `codex-app-server` session does not run an ACP
adapter and does not enable this lifecycle producer.

Hermes additionally verifies the exact reviewed Git artifact and matching SDK
source; changing a version label does not bypass its compatibility checks. Its
provider, selected role home, and plugin restrictions still apply. Custom Claude
commands retain Fleet's restrictions on bundled-only plugin/MCP options.

Owner notices remain optional:

```yaml
owner_channel:
  # Keep the role's existing identity, owners, and other channel settings.
  compaction_notices: true
```

Notices go only to the authenticated owner who initiated the active request.
Replay and terminal-only history do not generate a start notification.

## Coverage and recovery

These producers implement an unstable ACP contract, not a guarantee of complete
runtime coverage. All three producers report completion-only coverage. Codex forwards
observed native starts where available; missing starts are never synthesized. Claude exposes the structured lifecycle supplied by its pinned SDK,
with bounded duplicate tracking. No adapter advertises atomic guarded cancellation.
The per-adapter reports distinguish deterministic protocol tests from live provider
execution. Full live automatic/manual compaction conformance is not claimed.

If a producer omits a terminal event, Fleet records an unknown end and recovers the
adapter generation. Unknown started deliveries are retained for operator
reconciliation rather than replayed. Reverting the optional producer selection
keeps queue-only delivery intact. Preserve `.monitor-ingress.json`, owner ingress
journals, and `.owner-channel-compactions.json` across rollback; deleting them
loses the evidence used to prevent duplicate work or notices.

A watchdog-owned cancellation RPC error retains the process for operator attention
with failed readiness (`ACP_STALL_OPERATOR_REQUIRED`), while rejecting new prompt
dispatch. Previously admitted mail remains queued on disk. After inspecting the diagnostic state, an operator can explicitly run
`ours-fleet restart ROLE` (or the existing managed recovery control for that role); a synchronized
successor drains never-dispatched hints without requiring another message. Generic
RPC failures, lost transport, and missing compaction terminals still use bounded
adapter retirement.
