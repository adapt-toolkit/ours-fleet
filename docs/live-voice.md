# Live voice managed-session boundary

App Live voice sends transcripts through existing ACP managed sessions and reads the actual agent conversation. Updated ACP and native Codex supervisors advertise `generation_bound_prompts`, `idle_bound_prompts` and `targeted_voice_interrupt`; `/api/v1/roles/:id/voice-capabilities` authenticates the browser and reports whether all are present.

`submit_voice_prompt` accepts `requireIdle: true`. Receipt replay precedes the idle check so retrying a lost acknowledgment does not create a second prompt or fail just because the first is running. New admission checks generation and idle/queue/tool/permission state inside the existing turn arbiter before queuing. Unrelated work is never interrupted to make room.

`interrupt_voice_v2` requires a command ID, expected session generation and exact prompt ID. A matching active prompt uses normal managed-session cancellation; a settled or different prompt is a harmless no-op. A stale generation is rejected. Receipts are idempotent and conflicting reuse of an interrupt command is rejected. The browser's `/interrupt` route selects this path only when the complete target is present, with no legacy unbound fallback.

Authenticated CSRF-protected `POST /api/v1/roles/:id/live-presence` takes `{ expectedSessionGeneration }`, validates the current generation before attaching `followConversation`, and streams NDJSON readiness/heartbeats. The HTTP connection owns one attended controller until disconnect. Close, generation change, auth expiry, slow consumer or attach failure detach it. The browser's ordinary workspace fetch supports this stream without provider credentials in a URL. Existing ACP permission expiry and controller detach grace remain in force.

The daemon/App changes and configuration instructions live in the corresponding `ours-app/docs/live-voice.md` and `ours-sdk` Live voice documentation. The daemon owns the OpenAI key and 60-second Realtime credential minting; Fleet never receives the provider key.

Coverage includes actual ACP/control-socket busy/retry/targeted-cancel tests, native Codex transport tests, authenticated presence-boundary tests and the App native browser/audio integration with separate Codex/Claude ACP protocol fixtures. Provider inference and physical-device acceptance are separate operator checks.
