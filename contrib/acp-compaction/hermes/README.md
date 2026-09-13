# Reviewed Hermes ACP compaction build

This directory contains **all Hermes changes** for the Fleet-owned pending queue and negotiated terminal lifecycle, including the final post-commit truth correction. It is an opt-in isolated build, not a global package replacement.

## Reproduce from this checkout

Requirements: Git, Python 3.10+ for the scripts, `uv`, Bash, and network access to acquire upstream Hermes and locked Python dependencies. The runtime is Python 3.11. Linux is tested. The scripts never edit an existing target or live Hermes installation.

From the Fleet repository root:

```sh
python3 contrib/acp-compaction/hermes/setup.py --target "$PWD/.local/hermes-compaction"
python3 contrib/acp-compaction/hermes/test.py --target "$PWD/.local/hermes-compaction"
npm ci
npm run build
node contrib/acp-compaction/hermes/verify-fleet.mjs "$PWD/.local/hermes-compaction"
```

Use any **new** target directory. For offline source acquisition, add `--source /path/to/cached/hermes-agent`; the cache is read only and need only contain the pinned upstream baseline. Dependency installation uses the upstream `uv.lock` and uv's normal cache/index. `--prepare-only` acquires and verifies the source and builds the wheel without provisioning Python dependencies. Full setup requires dependencies to be available in cache or from their configured indexes; it does not promise an air-gapped dependency mirror.

The launcher is `TARGET/bin/hermes-acp`. Configure its absolute path as the sole element of the Fleet role's `session_options.acp.command` array. Fleet validates the exact clean reviewed commit, custom SDK version and SDK source digest; arbitrary wrappers, dirty source, mixed baseline/custom SDK combinations and altered SDK source remain rejected. Verification reads metadata and source hashes; it does not start a session or load Hermes user configuration. No service restart or deployment is performed.

Setup installs the upstream locked base runtime into `TARGET/hermes/venv`, then installs only the reviewed hash-pinned SDK and pinned pytest tooling in that environment. Do not run a later `uv sync --extra acp` against this target: the upstream stable extra pins SDK 0.9.0. Recreate the target with this script to restore the reviewed pairing. This is not a complete cross-platform dependency mirror; the custom source and artifact bytes are pinned and self-contained.

## Provenance

- Upstream: https://github.com/NousResearch/hermes-agent
- Baseline: `d15ed4445207dda418b984e8bda0f68f48b8c6f3` (Hermes 0.21.1).
- Reviewed final commit: `89c309efb8feb95dfb7d0898a35a76a6faa659f4`.
- `provenance.json` records every included commit and the cumulative patch hash.
- `hermes-compaction.patch` is the complete readable baseline-to-final diff.
- `reviewed.bundle` contains those five commits with the baseline as a prerequisite, preserving the exact clean artifact identity without creating new commits. Setup checks clean patch applicability and exact diff equivalence before checkout.
- `UPSTREAM-LICENSE` preserves Hermes' MIT license.
- The sibling [Python SDK bundle](../python-sdk/README.md) supplies the custom dependency, source provenance and license. No separate private checkout or previously built wheel is required.

The immutable reviewed commit includes a historical prototype document with a local review-artifact path. That path is provenance only; these repository-contained instructions supersede its setup directions.

## Behavior and limits

Fleet owns pending automatic deliveries. Hermes rejects concurrent prompts with an explicit recoverable busy error instead of acknowledging work that has not executed. Turn ownership survives finalization failures and cancellation settlement. Mutating slash commands and model changes share the ownership guard. `/queue` executes synchronously when idle and rejects while busy; explicit `/steer` remains an operator action.

Typed v1 `clientCapabilities.session.compaction: {}` enables standard `session/update` terminal events containing only ID and status. Legacy clients receive no draft events. The advertised safety metadata is `completion_only` with `guardedCancel: false`. Native paths and no-ops outside the observed local lifecycle remain unobserved; there is no complete-coverage or automatic-interruption safety claim. Fleet must continue queueing automatic messages until the active prompt settles.

Actual durable commit outcomes survive later diagnostic/output exceptions, while those original errors still propagate. Precommit failure, abort and rollback do not become successful completion. The producer emits no summaries, synthetic starts or control RPC. Tests run the real adapter/compressor/temporary database paths with deterministic provider responses; they do not contact models.

`test.py` writes SDK and Hermes results under `TARGET/evidence`. See [verification evidence](EVIDENCE.md) for the clean packaged run.
