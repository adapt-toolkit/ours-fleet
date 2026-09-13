# Packaged build verification

Verified 2026-09-13 on Linux with Python 3.11.15. Commands ran from this Fleet checkout against a **new temporary target**, using an existing upstream repository only as a read-only Git cache. Python dependencies were provisioned by the packaged default setup, not borrowed from a live Hermes environment.

```sh
python3 contrib/acp-compaction/hermes/setup.py --target "$TARGET" --source "$UPSTREAM_CACHE"
python3 contrib/acp-compaction/hermes/test.py --target "$TARGET"
python3 contrib/acp-compaction/python-sdk/build_artifact.py --output "$SECOND_WHEEL_DIRECTORY"
npx vitest run test/hermes-compatibility.test.ts
npx tsc -p tsconfig.json
node contrib/acp-compaction/hermes/verify-fleet.mjs "$TARGET"
```

Results:

- Baseline checkout, cumulative patch applicability, bundle verification, and patch/bundle diff equivalence succeeded.
- SDK baseline manifest validation and clean patch application reproduced every bundled patched source file.
- Two independent wheel builds matched byte for byte, SHA-256 `c71ebab39ef7f779135cc93bb00bf434dcaf1740e6e54849062f9546d69d152c`.
- Hash-required SDK installation completed only in the new target's Python environment.
- SDK: **26 passed**, actual initialization/notification routers and serializer.
- Hermes: **226 passed across 25 files**, including actual turn ownership, busy rejection, model/command serialization, cancellation settlement, automatic/manual compaction success/failure/abort, and both post-commit diagnostic regressions.
- Fleet compatibility: **29 passed**. The new acceptance regression failed before the verifier change; dirty, mixed, missing-digest and tampered-digest cases reject.
- TypeScript compilation succeeded.
- The actual verifier accepted the exact clean `89c309efb8feb95dfb7d0898a35a76a6faa659f4` checkout, standard generated launcher, SDK local version and source digest.
- A deliberate modification to the **temporary target's** installed `acp/schema.py` made the actual verifier reject with a source-digest mismatch. Restoring the bytes restored acceptance. No ACP session was launched for this check.

The runtime producer's coverage remains `completion_only`; no native-path expansion, synthesized starts, summary leakage, or automatic-cancellation safety claim was added. Tests use deterministic provider responses and temporary databases; they do not claim live provider validation. Dependency acquisition may require network/cache access; only the reviewed custom artifact is fully hash-locked by this bundle.
