# Sending files in an ACP chat

An opted-in managed Agent uses the existing Ours `send_file` tool:

```json
{"path":"deliverables/report.pdf"}
```

Omitting `contact` sends to the current ACP chat. Supplying a non-empty contact
keeps ordinary Ours delivery:

```json
{"contact":"Alice","path":"deliverables/report.pdf"}
```

Only an absent contact chooses the chat. Null, empty or whitespace-only contacts,
unknown fields and unknown recipients fail without falling back to chat. Outside
opt-in, contact remains required. Current-chat sending accepts `path`, optional
`filename` and `mime`; inline base64 and Ours reply fields are unsupported.

Each call makes one attempt. Failures are returned to the agent. There is no
request ID, deduplication, automatic retry or recovery of failed sends. If a user
asks to resend, another tool call makes a new attempt and can produce another
attachment. UUIDs identify stored attachments; the stored SHA-256 checks integrity.
Neither is a retry key.

Set this on the Agent definition, not manifest defaults or a Brain:

```yaml
file_delivery:
  enabled: true
  directory: deliverables
```

The tool description advertises this directory and the 20 MiB limit to the Agent.
The directory is a non-hidden subtree of the Agent's working directory. Both
routes interpret relative paths from that working directory; absolute paths keep
their usual meaning. Chat sending additionally enforces the export directory.
The Agent should finish writing the file before calling `send_file`. Symlinks,
hardlinks, hidden/credential paths, changed files and files over 20 MiB fail.

Initial support requires Linux, the managed Ours connector, a stock Codex or
Claude ACP adapter, and a tracked active turn. Idle, scheduled, steered, cancelled,
replaced and unsupported sessions cannot export. Existing native tool approval
and the neutral role permission policy both apply before bytes are read. An
`ask` decision needs an attached controller; `deny` refuses. A native policy that
refuses MCP execution (including Codex `never` without a native tool allowance)
can still refuse before Fleet receives the call.

Codex requires native runtime 0.159.0 or newer and Fleet's managed App Server
proxy. Before each turn, its public exact-thread, paginated MCP inventory must
show a connected managed `ours` with the expected optional-contact schema.
Ours aliases, filtered aliases, ambiguous identity, failed discovery and an
incompatible schema make the turn unavailable. Unrelated identified tools are
preserved. Explicitly disabled Ours is rejected before replacement. Inherited
TOML MCP settings, including project/profile sources, are conservatively
unsupported until their disabling semantics can be qualified before replacement.
Use a clean Codex configuration home for this initial opt-in.

Claude ACP 0.63.0's installed wrapper has no public same-session inventory RPC. Initial
support therefore requires an operator's explicit restricted MCP configuration:

```yaml
harness_options:
  mcp_servers_only: true
  mcp_servers:
    ours: { command: ours-mcp, args: [proxy] }
```

Fleet replaces that connector with its bound bridge. Additional explicit MCP
servers and custom ACP commands are unsupported for this feature. Default-off
Agents retain their existing configuration.

Successful sends copy complete bytes into private immutable storage and append a
server-origin `file.attached` event containing the actual session generation,
ACP session and managed turn. One export can run at a time. Cancellation or
steering before publication revokes it; cancellation after publication does not
undo it. Unpublished stored bytes are never replayed or republished. Storage is
bounded to 100 files and 200 MiB per role incarnation, including incomplete and
orphaned copies. Exhausted storage fails; no automatic recovery is performed.

The App renders persisted file cards from these typed events. HTML and images
also download as files. Downloads require authentication, the matching role
incarnation, a published conversation event and intact bytes. Deleted, missing,
changed or orphaned artifacts return unavailable. Remote workspaces fetch bytes
using their existing device credential, limit the read to 20 MiB and prevent
saving after a workspace change.

## Release prerequisite and qualification

This source requires the companion MCP implementation's
`MANAGED_FILE_DELIVERY_VERSION = 1`. Fleet's current published MCP pin does not
include it: opt-in fails closed on that package. Publish a qualifying MCP build
and repin Fleet's manifest and lock exactly before shipping the feature. Local
integration tests use the task-owned built MCP package only.

The deterministic native fixture uses real ACP adapters, the real managed
connector and an isolated daemon. A local scripted provider supplies only tool
intents; approval, read, copy, publication and bytes come from the implementation.
It does not qualify external-model inference, deployment or arbitrary native
MCP request-to-ACP tool-call ID mapping. Correlation is the authenticated bridge
and the actual active Fleet turn, which is revoked by cancellation/steering.
