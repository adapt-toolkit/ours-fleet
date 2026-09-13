# Repository-contained Python ACP compatibility backport

This bundle provides the narrow, reviewed draft compaction types and standard `session/update` serialization required by the sibling Hermes build. It is unpublished and installed only through the explicit isolated setup. No installed/global SDK is patched.

## Exact source and artifact

- Baseline distribution: `agent-client-protocol==0.9.0`, upstream https://github.com/agentclientprotocol/python-sdk.
- `original/acp`: all 30 original Python/type-marker files; `original-manifest.json` records their exact SHA-256 hashes and sizes. The source was captured from the 0.9.0 distribution; no upstream Git commit was recorded, so none is claimed. These content hashes are the authoritative baseline identity.
- `src/acp`: the complete patched source, including all unchanged baseline files.
- `proposed-compaction-sdk.patch`: the five-file reviewable unified patch. `verify_source.py` checks every original hash, applies the patch in a temporary directory, and compares its result to the bundled source.
- `packaging/baseline-dist-info`: original distribution metadata, entry points and [MIT license](packaging/baseline-dist-info/licenses/LICENSE), preserved in the wheel.
- Version: `0.9.0+ours.compaction1`.
- Deterministic wheel SHA-256: `c71ebab39ef7f779135cc93bb00bf434dcaf1740e6e54849062f9546d69d152c`.
- Full patched source manifest digest: `945a8c8c26e214e1fad043fc308026e54b5ade5c3ce636f9bb82255c44998866`. Fleet computes this independently from the installed SDK's files before accepting the custom Hermes build.

Build and verify from any working directory:

```sh
python3 path/to/python-sdk/verify_source.py
python3 path/to/python-sdk/build_artifact.py --output /path/to/new-wheel-directory
```

The builder uses only Python's standard library, sorted archive members, fixed timestamps/modes and regenerated RECORD hashes. Output must match the pinned wheel hash. `requirements-artifact.txt` can be used with `uv pip install --python ISOLATED_PYTHON --no-deps --no-index --require-hashes --find-links WHEEL_DIRECTORY -r REQUIREMENTS_FILE`. The sibling [Hermes setup](../hermes/README.md) performs this install only in its new target and provisions runtime dependencies separately.

## Contract and scope

The wire contract is the v1 unstable session-compaction RFD/schema snapshot identified as revision `bcb9d7e` in the approved design. The supplied research snapshot had no Git metadata, so this abbreviation is a recorded design reference rather than an independently verified full revision. The custom source, patch and executable contract tests are fully bundled and hash-pinned; no research workspace is required to build or run them.

The backport preserves typed `session.compaction` negotiation; adds `compaction_update` and `compaction_summary_chunk` to the existing discriminated notification union and public interfaces; preserves future string statuses and explicit-null patch fields; and enforces the draft status/summary/error constraints. Standard `session/update` remains the only transport name. Legacy malformed/unknown variants remain rejected, and the global legacy serializer is unchanged.

This is a narrow backport, not regeneration of every unrelated unstable feature. It does not add configOptions or optional deserialize-default/skip-invalid tolerances. It contains no producer, coverage claim, cancellation control, or summary-generation logic. Hermes emits only terminal ID/status fields after positive typed negotiation.

`tests/test_compaction_compat.py` exercises actual initialization routers, AgentSideConnection, serialization, and receiving client router through an in-memory transport. The sibling `hermes/test.py` runs all 26 cases against the installed wheel before downstream lifecycle suites.
