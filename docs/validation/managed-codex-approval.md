# Managed Codex messaging approval (#193)

A managed Codex role with portable `approval: allow`, `filesystem: workspace`,
`unattended: deny`, and explicit `harness_options.sandbox: workspace-write` previously
reported messaging capability but could not call its messaging tools. Codex returned
`MCP tool call requires approval, but approval policy is never`.

The fix generates `approval_mode: approve` for exactly `current_identity`,
`get_messages`, `list_history`, `list_contacts`, and `send_message`. Complete managed
transport and policy travel together in native config and `CODEX_CONFIG`. The existing
Fleet app-server proxy restores per-tool policy after ACP's transport conversion on
`thread/start` and `thread/resume`, only for `FLEET_OURS_MANAGED=1`.

No server-wide approval default is added. Existing per-tool fields (including output
limits), other tools/servers/config, transport, descriptor identity binding, and sandbox
survive the merge. Absent or explicitly disabled connectors stay untouched; explicit
inherited-MCP disabling wins. Portable ask/auto/deny/unspecified roles get no generated
preapprovals. The verified ACP path remains Fleet's bundled adapter; arbitrary custom
ACP commands are outside the qualification.

## Upstream verification (2026-09-27)

- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  documents `mcp_servers.<id>.tools.<tool>.approval_mode`.
- [Codex source schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json),
  inspected blob `d90893534340c00857691c469835d2e94b3a3b5a`, defines
  `RawMcpServerConfig.tools` → `McpServerToolConfig`, with `approval_mode` and
  `output_token_limit`. The approval enum includes `approve`.
- Fleet's pinned `@agentclientprotocol/codex-acp` 1.10.0 replaces the
  `mcp_servers` parent in `createSessionConfig`; `createMcpSeverConfig` carries only
  command/args/env or HTTP URL/headers. Independently inspected current upstream 1.13.1
  retains that behavior. Both new and resumed sessions use that conversion.
- Actual Codex 0.157.1 accepts the schema and executes the managed test below.

## Bounded managed-session validation

`test/managed-codex-approval.integration.mjs` starts a private local daemon, a local
HTTP gateway, and a temporary bound identity via `prepareManagedAgent`. It launches
Fleet's real `CodexAgentSessionAdapter` / `AcpSession`, ACP 1.10.0, and an explicitly
selected real Codex 0.157.1 executable. Only the model provider is scripted: a local
Responses endpoint emits code-mode tool intents; actual Codex decides approval and
executes tools through the real managed bridge. No operator tool result is substituted.

The fixture uses a new private root, a dummy model credential, explicit provider config,
and dead outbound HTTP(S) proxies with a loopback bypass. It needs no production
identity, room, model account, or service restart. It retains artifacts in the supplied
root, rejects root reuse, and bounds execution to 120 seconds. Keep roots short enough
for Unix-domain socket paths and under an owner-controlled directory; daemon credentials
require safe non-group-writable ancestry. No credential checks are weakened.

After `npm ci` and `npm run build`, use an explicit task-owned root and executable:

```sh
node test/managed-codex-approval.integration.mjs after /absolute/new/root /absolute/codex
```

For baseline comparison, copy the same fixture into a checkout of prerelease
`e720586890943d424840f0f9b96d0ac5051d8a6c`, build that checkout, and use `before`
with a separate new root. The `before` mode asserts the regression; it is expected to
exit successfully only when the exact failure is observed.

| Check | Baseline | Fixed |
| --- | --- | --- |
| Fresh: five permitted tools | Five exact approval denials | Five `isError:false` results |
| Same-thread resume: five permitted tools | Five exact approval denials | Five `isError:false` results |
| `set_bio` negative control, both turns | Denied | Denied; no backend mutation dispatched |
| Recipient receives both messages with authenticated managed sender CID | No messages | Verified |
| Executed approval / sandbox | `never` / `workspaceWrite` | `never` / `workspaceWrite` |
| Start/resume connector transport and descriptor | Preserved | Preserved, with exactly five policies |
| Server-wide approval default | Absent | Absent |

The process-boundary request tap and `summary.json` capture the checked policy,
identity, results, and backend method paths. The fixture never writes descriptor
capabilities, daemon credentials, or identity key material into its summary.

The initial local fixture needed two corrections before qualification: current gateway
profiles require `serverUrl`, and ACP resume resolves the provider from `config/read`.
An early unqualified run tried OpenAI with its dummy key and received 401; that run is
excluded. The passing fixture pins its private provider for both new and resumed
sessions. This tests approval/dispatch, not external-provider behavior or deployment.
