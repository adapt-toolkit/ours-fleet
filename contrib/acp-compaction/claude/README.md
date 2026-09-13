# Claude ACP compaction adapter

This directory is a standalone, source-based distribution of the reviewed
compaction patch and both terminal-fencing corrections. It uses public ACP SDK
types and the existing runtime lifecycle. It changes no globally installed
adapter or package.

## Acquire, apply, build, and test

Requires network access to GitHub/npm, `git`, `tar`, `npm`, a POSIX shell, and
Node 22.12+, 24.x, or 26+. Run from the Fleet checkout:

```sh
node contrib/acp-compaction/claude/prepare.mjs /absolute/isolated/claude-compaction
```

Choose a new or empty target directory. The command verifies the archive,
lockfile, patch, and dependency pins; checks and applies the cumulative patch
without a git index; installs target-local dependencies with lifecycle scripts
disabled; builds/types; checks lint and formatting; and runs the deterministic
lifecycle and adapter prompt-routing tests.

Successful output includes `source/`, `validation.log`, `validation.json`, and
`run-adapter.sh`. A failure preserves its logs and creates no successful
validation receipt. Use another empty target after correcting a failure. No
model prompt, release, global installation, or deployment is performed. This
package directory can be copied elsewhere before running; it has no dependency
on a local research checkout. Archive hash mismatch requires review rather than
silently trusting a new download.

## Launch from Fleet

Set these fields on an otherwise valid Claude Code role:

```yaml
harness: claude-code
session: acp
session_options:
  acp:
    command: ["/absolute/isolated/claude-compaction/run-adapter.sh"]
```

Check the built adapter without starting a model:

```sh
/absolute/isolated/claude-compaction/run-adapter.sh --version
```

Expected version: `0.76.0`. The launcher speaks stdio ACP and preserves Fleet's
working directory and existing authentication/permission environment. Moving
the whole target is supported; update the role's command path afterward.

Use the basic custom-command path. Fleet rejects `harness_options.plugins`,
`harness_options.mcp_servers`, and `harness_options.mcp_servers_only` with a
custom Claude ACP command because those options depend on its bundled adapter
metadata contract. This package does not bypass that check. Normal role fields
and permissions still apply; no broad permission override is included.

## Pins, provenance, and license

- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- Base commit: `4deace40379a62eb642559454930af4c590b3d49`, package `0.76.0`.
- Reviewed cumulative result: `b1c35b3e624f3ba6a9c466fd5f402fcfda100a20`.
- Included development commits: `0d8c7ab` (negotiated lifecycle), `9840cb7`
  (persistent ID fencing), `b1c35b3` (distinct terminal UUID alias fencing).
- Dependencies: ACP SDK `1.4.0`, Claude Agent SDK `0.3.257`; exact transitive
  dependencies and npm integrity hashes come from the unchanged upstream lock.
- `adapter.patch` is one complete base-to-reviewed source diff, with all tests
  and documentation. Archive, patch, and lockfile SHA256 values are recorded in
  `manifest.json`; no development checkout or commit object is needed to apply.
- Upstream and derivative patch: Apache-2.0; `LICENSE.upstream` retains the
  upstream license. The acquired source preserves provenance/copyright notices.
  Other npm dependencies retain their respective licenses.

## Coverage limits

Object-valued v1 `clientCapabilities.session.compaction` enables structured
updates. Missing, null, and malformed capabilities retain the legacy output.
Runtime start UUIDs identify compactions; explicit success/boundary and failure
signals retain the active ID. Terminal-only outcomes are supported. The
negotiated lifecycle sends no summaries, raw errors, or context metadata.

Observed start, terminal-message, duplicate, and enrichment UUIDs remain fenced
across resets. Old observed aliases cannot reopen an entity or close a later
attempt. Unseen start UUIDs allow retries. IDs and aliases share a 1,024-entry
capacity without eviction: new entities are suppressed at capacity, a body-free
warning is emitted once, and summary suppression remains active. Existing
active entities can still terminalize. Start a fresh adapter process/session to
restore lifecycle visibility after capacity exhaustion; ordinary turn resets
preserve the producer's ID fences. Never-observed UUIDs cannot be associated
with an earlier attempt solely from this stream; no such guarantee is claimed.

Safety metadata remains `completion_only`, `guardedCancel: false`. Stream loss
or reset never manufactures safe cancellation or successful completion. Fleet
must reconcile unresolved starts and keep automatic messages queue-only until a
usable prompt boundary. No exhaustive runtime mutation, live forced compaction,
older installed adapter, or ACP v2 conformance claim is made. See `VALIDATION.md`
for the packaged-command test evidence.
