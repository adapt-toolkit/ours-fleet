# Fleet 2.0.0 (major release)

This release promotes the validated `prerelease` line to `main` as a major
release of Fleet and its skill plugins. Versions are produced by the `main`
version-bump job from the merge commit's Conventional Commits subject; they are
not written by hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/fleet` | 1.1.5 | 2.0.0 |
| `@ours.network/fleet-claude-code` | 1.1.5 | 2.0.0 |
| `@ours.network/fleet-codex` | 1.1.5 | 2.0.0 (with its `.codex-plugin` manifest) |

## Dependencies

- `@ours.network/sdk` 5.0.0, `@ours.network/cli` 4.0.0 and
  `@ours.network/mcp` 2.0.0 (exact pins; previously nightly builds)
- development: `@ours.network/daemon` 5.0.0

## Breaking changes

- Built on the SDK 5, CLI 4 and MCP suite 2 major releases.
- Fleet now provisions the agent identity and ours MCP in the supervisor and
  owns the native harness setup for the task workflow.
- Conversation, resource and notification updates are delivered over
  canonical routes and server-sent events.

## Features promoted from prerelease

- Task supervisors are retained and task context resumes in place; owners are
  notified of committed task lifecycle changes.
- Built-in agent self-reminders and durable completion notifications.
- Live voice prompts and cancellation are bound to managed sessions.
- Claude/Codex subscription profiles, login, health and usage API.
- ACP chat file delivery by default.
- Verified current GPT and Claude Brain presets and a gated engineering
  starter (Engineer + Critic pair).
