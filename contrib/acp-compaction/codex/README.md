# Codex ACP compaction adapter

This directory is a standalone, source-based distribution of the reviewed
compaction patch. It uses public ACP SDK types and transport; it does not modify
Fleet's installed adapter or install any package globally.

## Acquire, apply, build, and test

Requires network access to GitHub/npm, `git`, `tar`, `npm`, a POSIX shell, and
Node 22.12+, 24.x, or 26+ (pinned test-runner support). Run from the Fleet checkout:

```sh
node contrib/acp-compaction/codex/prepare.mjs /absolute/isolated/codex-compaction
```

Choose a new or empty target directory. The command verifies the archive,
lockfile, patch, and dependency pins; checks and applies the patch without a git
index; installs local dependencies with lifecycle scripts disabled; builds;
runs TypeScript, SDK wire, lifecycle, initialization, history, and legacy tests;
and checks the native runtime version. It also fetches and hash-verifies the
native outcome evidence listed in `manifest.json`.

Successful output includes `source/`, `validation.log`, `validation.json`,
`run-adapter.sh`, and `codex-runtime.sh`. A failed run leaves its logs in place
and does not produce a successful validation receipt. Use another empty target
after correcting a failure. Nothing is deployed and no model prompt is issued.
The package directory can be copied elsewhere before running; no local research
checkout is needed. Archive hash mismatch fails closed and requires review,
not replacing the expected hash with whatever was downloaded.

## Launch from Fleet

The launcher uses stdio ACP and preserves the caller's working directory. Set
these fields on an otherwise valid Codex role:

```yaml
harness: codex
session: acp
session_options:
  acp:
    command: ["/absolute/isolated/codex-compaction/run-adapter.sh"]
```

The adapter launcher itself sets `CODEX_PATH` to its pinned target-local native
runtime. Fleet's custom-command path does not require an inherited `CODEX_PATH`.
To explicitly inspect the native and adapter versions:

```sh
export CODEX_PATH=/absolute/isolated/codex-compaction/codex-runtime.sh
"$CODEX_PATH" --version
/absolute/isolated/codex-compaction/run-adapter.sh --version
```

Expected versions are native `0.153.4` and adapter `1.11.0`. Keep normal authentication and
role permission configuration; custom commands retain Fleet's existing
conservative permission-mode checks. This package adds no permission override.
The launchers derive paths from their own location; moving the entire target is
supported (update Fleet's command path afterward).

## Pins, provenance, and license

- Upstream: https://github.com/agentclientprotocol/codex-acp
- Base commit: `effb0fe670a49dfbb5071764b5f8a2e3c09e2393`, package `1.11.0`.
- Reviewed cumulative result: `e44fd1dd46e4e4209d96655412d1fc29a14a4e43`.
- Dependencies: ACP SDK `1.4.0`, native Codex `0.153.4`; exact transitive
  dependencies and npm integrity hashes come from the unmodified upstream lock.
- `adapter.patch` is the complete base-to-reviewed source diff, including its
  tests and documentation. Archive, lockfile, patch, and evidence SHA256 values
  are in `manifest.json`.
- Upstream and derivative patch: Apache-2.0; the upstream license is retained in
  `LICENSE.upstream`. Source provenance and copyright notices remain in the
  acquired tree. Other npm dependencies retain their respective licenses.

Native completion evidence is from OpenAI Codex commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (`rust-v0.153.4`, Apache-2.0;
[license](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/LICENSE)).
In `compact.rs`, history replacement at line 379 precedes completion emission
at 393; in `compact_remote.rs`, replacement at 295 precedes completion at 309.
Both source URLs and full-file hashes are pinned in the manifest. This supports
completion of installed compacted history; it does not prove durable fsync or
success of the enclosing prompt or a later post-compaction hook.

## Coverage limits

Only object-valued v1 `clientCapabilities.session.compaction` opts in. Legacy,
null, or malformed capabilities retain existing output. Negotiated synthetic
compaction tools become ID-addressed standard updates, including terminal-only
history; the obsolete ID-less banner is suppressed. Genuine tools remain tools.
No summaries are sent through this lifecycle path.

Safety metadata declares `completion_only` and `guardedCancel: false`. Observed
starts do not establish coverage of every mutation, failure, or cancellation
path. Missing terminals require Fleet reconciliation; they never authorize
automatic cancellation. Historical replay silence and generation fencing are
consumer responsibilities. There is no full runtime, paid live compaction,
older installed adapter, or ACP v2 conformance claim. Runtime overrides outside
the pinned binary have not been validated. See `VALIDATION.md` for packaged-run
evidence.
