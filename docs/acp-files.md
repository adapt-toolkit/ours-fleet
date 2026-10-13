# Sending files in an ACP chat

Every managed Agent can attach a file to its current ACP chat with the existing
Ours `send_file` tool. No Agent setting turns this on and no export directory is
configured or created:

```json
{"path":"/home/me/project/build/report.pdf"}
```

Omitting `contact` sends to the current ACP chat. Supplying a non-empty contact
keeps ordinary Ours delivery:

```json
{"contact":"Alice","path":"build/report.pdf"}
```

Only an absent contact chooses the chat. Null, empty or whitespace-only contacts,
unknown fields and unknown recipients fail without falling back to chat.
Current-chat sending accepts `path`, optional `filename` and `mime`; inline
base64 and Ours reply fields are unsupported.

Each call makes one attempt. Failures are returned to the agent. There is no
request ID, deduplication, automatic retry or recovery of failed sends. If a user
asks to resend, another tool call makes a new attempt and can produce another
attachment. UUIDs identify stored attachments; the stored SHA-256 checks integrity.
Neither is a retry key.

## Paths

The Agent passes the path of the file it wants to send. Relative paths resolve
from the Agent's working directory; `..`, absolute paths, hidden directories and
symlinked parent directories are all accepted. The file does not have to be
inside the working directory or any particular subtree. It is opened by the
Fleet bridge inside the Agent's own OS sandbox, so the Agent can send exactly
what it can already read.

The file itself must pass ordinary integrity checks, each with its own result:

| Result | Meaning |
| --- | --- |
| `CHAT_FILE_NOT_FOUND` | nothing exists at the path |
| `CHAT_FILE_NOT_READABLE` | the Agent's OS user or sandbox cannot read it |
| `CHAT_FILE_IS_SYMLINK` | the named file is itself a symlink; pass its target |
| `CHAT_FILE_HARDLINKED` | the file has more than one hard link |
| `CHAT_FILE_NOT_REGULAR` | a directory, FIFO, socket or device |
| `FILE_EXCEEDS_20_MIB` | larger than the 20 MiB limit |
| `CHAT_FILE_CHANGED` / `SOURCE_SIZE_CHANGED` | modified while it was being read; finish writing first |
| `CHAT_FILE_REQUIRES_LINUX` | the Agent's bridge is not running on Linux |
| `PRIVATE_STATE_CANNOT_BE_SENT` | Fleet's own credentials, connector profile or stored attachments |

`PRIVATE_STATE_CANNOT_BE_SENT` covers only Fleet's private Ours runtime
directory, its attachment store and the connector profile and credential files,
checked on the provided path before approval and on the opened file's real path
afterwards. It is not configurable and is not a general path policy.

## Supported sessions

Current-chat delivery needs Linux, the managed Ours connector and a Codex or
Claude ACP session with a tracked active turn. Those Agents need no special
`harness_options`, MCP restriction or clean configuration home: inherited and
additional MCP connectors stay as they are, and Fleet's bound bridge is the
`ours` connector as it already is for every managed Agent.

Any other backend still sees the optional `contact`, and omitting it returns a
precise result rather than a missing tool:

```
CURRENT_CHAT_DELIVERY_UNAVAILABLE: sending a file to this chat requires a Codex or Claude ACP session; this Agent runs <harness>/<session>. Pass contact to send through Ours instead
```

Idle, scheduled, steered, cancelled and replaced turns return
`CURRENT_CHAT_DELIVERY_UNAVAILABLE`; a second send while one is in progress
returns `FILE_DELIVERY_BUSY`.

A file is published only for a call that arrives over the Agent's
capability-authenticated bridge and binds to the turn that is live in that
Agent's own session. Connector inventory is not consulted, so unrelated or
similarly named connectors neither enable nor block delivery.

## Permissions

Existing native tool approval and the neutral role permission policy both apply
before bytes are read. With `approval: allow`, a path inside the role's
`filesystem` boundary is allowed automatically; a path outside it is put to the
attached controller like any other out-of-boundary request, and is denied when
nobody is attached and `unattended: deny`. An `ask` decision needs an attached
controller; `deny` refuses with `CURRENT_CHAT_DELIVERY_UNAVAILABLE`, and a
declined request returns `FILE_SEND_DENIED`. A native policy that refuses MCP
execution (including Codex `never` without a native tool allowance) can still
refuse before Fleet receives the call.

## Retired configuration

`file_delivery` is retired. An existing block still loads so manifests need no
edit, and has no effect:

```yaml
file_delivery:
  enabled: false        # ignored: delivery stays available
  directory: deliverables   # ignored: not created, not enforced
```

Remove it at your convenience. Unknown keys inside it are still rejected.

## Storage and download

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
`MANAGED_FILE_DELIVERY_VERSION = 1`. Fleet pins published
`@ours.network/mcp@1.2.0-nightly.13`, which includes it and already treats the
export-directory hint as optional, so default delivery needs no MCP change. An
installed MCP package without the capability fails Agent startup with
`INCOMPATIBLE_MANAGED_FILE_DELIVERY` instead of quietly requiring a contact.
Changes to the MCP pin require clean installed-package qualification without a
built MCP overlay.

The deterministic native fixture (`test/file-delivery-native.integration.mjs`)
uses real ACP adapters, the real managed connector and an isolated daemon. Its
Agent has no `file_delivery` block and no MCP restriction, and it sends a file
from a hidden directory outside the working directory. It then downloads the
generated attachment over the authenticated HTTP route and compares bytes and
SHA-256, after checking that an anonymous and a forged-cookie request are
refused. `FLEET_FILE_NATIVE_VARIANT=connectors` adds unrelated MCP connectors
and requires them to stay usable. A local scripted provider supplies only tool
intents; approval, read, copy, publication and bytes come from the
implementation. It does not qualify external-model inference, deployment or
arbitrary native MCP request-to-ACP tool-call ID mapping. Correlation is the
authenticated bridge and the actual active Fleet turn, which is revoked by
cancellation/steering.
