# Hermes native conformance fixture

Run the installed Hermes artifact and actual ours connector with isolated homes, state, identities, and deterministic local inference:

```sh
HERMES_ACP_INTEGRATION_REQUIRED=1 npx vitest run test/hermes-acp-integration.test.ts test/hermes-edit-permissions.test.ts test/hermes-isolation.test.ts
```

Normal test runs skip this suite. `HERMES_ACP_INTEGRATION=1` opts in; `HERMES_ACP_INTEGRATION_REQUIRED=1` enables it and never silently skips unavailable artifacts. Select an installation through `HERMES_ACP_TEST_SOURCE` and `HERMES_ACP_TEST_EXECUTABLE`; defaults are the current user's `.hermes/hermes-agent` and its `venv/bin/hermes-acp`. Actual messaging additionally needs installed ours CLI and MCP package entrypoints, configurable through `HERMES_ACP_TEST_OURS_CLI` and `HERMES_ACP_TEST_OURS_MCP`; defaults use `.local/lib/node_modules/@ours.network/{cli,mcp}/dist/cli.js`.

Tested Hermes: clean commit `d15ed4445207dda418b984e8bda0f68f48b8c6f3`, Hermes 0.21.1, Python ACP SDK 0.9.0, protocol 1. Actual local messaging was verified with ours CLI 2.7.2, daemon 3.7.2/protocol 2, ours-mcp 1.0.0, and client SDK 3.7.0.

The fixture refuses source-checkout `.env` by metadata without reading its values. The Hermes environment is explicit, with isolated HOME/HERMES_HOME/cwd and dummy provider credentials. The separate ours daemon uses its own temporary config/state, an empty identity list, a fixture Human root followed by its fixture agent, and broker `ws://127.0.0.1:1`. The authenticated same-daemon exchange stays local; no operator identity, room or daemon is selected. Children are terminated and reaped before deleting their homes.

Seven integration tests cover:

- Native initialization, advertised model/modes, actual model A→B provider requests, fresh IDs and retained home data.
- Cancellation of a pending real provider stream.
- Dangerous-terminal denial and approval, verified by actual filesystem effects.
- The unmodified native 60-second approval expiry; a late approval cannot execute the expired operation and a subsequent prompt succeeds.
- Actual Fleet adapter preparation, compatibility checks, startup validation, fresh transport and authoritative Brain A→B models.
- Actual `mcp__ours__current_identity` and `mcp__ours__send_message` use through Hermes's default `tool_call` bridge. The receiving fixture Owner asserts message body and authenticated sender CID.
- Failure-soft MCP registration: startup connects, but an observed attempt to use the missing connector exposes a tool error.

The provider fixture also handles nonstream title generation and model metadata GET. Arbitrary fixture models need at least 64K context; it sets 131072. Requests, tool names and provider-visible tool results are available through fixture accessors.

Native MCP bridge nuance: this artifact emits an ACP `tool_call` start named for the actual MCP tool, but an observed bridged call omitted `tool_call_update` completion. The fixture proves use via actual provider-visible tool result and authenticated daemon receipt. Fleet releases pending tool tracking at owned turn end; Hermes does not support `after_tool` monitoring. Neither a configured name nor a model statement is treated as evidence of availability.

This file alone does not prove full r9 acceptance. Fleet-controller pending-state timeout/late-answer cleanup, write_file/patch mode behavior, permission coverage of the standard toolset, and enforcing filesystem isolation have separate tests. No terminal test implies universal mediation of browser, memory, skills, delegation or MCP actions. Shipping must run all required native suites with skips forbidden.

`hermes-edit-permissions.test.ts` checks native edit modes and standard enabled tool
names. `hermes-isolation.test.ts` runs real Linux bubblewrap with explicit runtime
read mounts, verifies a project write and a denied outside read-only write, and
fails required conformance on an unsupported platform. Shared Fleet permission
cleanup and late-answer handling are covered by `acp-permission-lifecycle.test.ts`;
the Hermes session tests assert its 50-second timeout configuration.
