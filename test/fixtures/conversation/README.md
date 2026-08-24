# Conversation normalizer golden traces

One JSON `session/update` payload per line (the `update` member of a
`session/update` notification), fed through `normalizeSessionUpdate` by
`test/conversation-fixtures.test.ts`.

Provenance: these traces are **synthetic**, hand-derived from the maintained
adapter sources pinned by this repository — `@agentclientprotocol/codex-acp`
1.1.7 (`CodexEventHandler`, `CodexApprovalHandler`) and
`@agentclientprotocol/claude-agent-acp` 0.63.0 (`acp-agent.ts`) — and scrubbed
of anything account- or machine-specific. They document the *shapes* each
adapter emits, including namespaced `_meta`, so normalizer regressions surface
as snapshot diffs.

They are NOT captures of live adapter runs. The real-adapter acceptance matrix
End-to-end compatibility still has to be exercised against the installed pinned binaries in an
isolated workspace with test credentials before release; when that happens,
scrubbed live captures should replace or extend these files.
