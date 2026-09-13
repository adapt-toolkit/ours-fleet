# Packaged-command validation

Validated 2026-09-13 on Linux x64 with Node 22.23.1 and npm 10.9.8, using only
this package directory and a new empty target. No prior source checkout,
global adapter, or git commit/index operation was used.

```sh
node contrib/acp-compaction/codex/prepare.mjs "$TARGET"
```

The packaged command exited 0. Its recorded steps were:

- Download immutable upstream archive; verify archive and lockfile SHA256.
- Verify cumulative patch SHA256; `git apply --check` and `git apply` succeed.
- `npm ci --ignore-scripts --no-audit --no-fund`; installed package versions match
  ACP SDK 1.4.0 and native Codex 0.153.4.
- Fetch both native outcome source files at the pinned commit and verify hashes.
- `npm run build` and `npm run typecheck`: passed.
- Focused lifecycle, initialize, history, and public SDK transport suite:
  **35 passed**.
- Native compaction/deprecated-banner legacy regression selection:
  **2 passed, 103 skipped**.
- Generated native runtime launcher `--version`: **codex-cli 0.153.4**.

The precise test argv are in `manifest.json`; each run creates its own complete
`validation.log` and `validation.json` under the selected target. The latter is
written only after every command succeeds.

Additional package checks passed: missing target gives usage/nonzero exit;
nonempty target is rejected without changing a sentinel or directory contents;
modified patch is rejected before target creation. Moving the complete prepared
target to a directory containing spaces preserved both the adapter's `--version`
(1.11.0) and native runtime's `--version` (0.153.4).

No live model compaction, provider execution, ACP v2 coverage, native filesystem
durability, or behavior of an arbitrary runtime override was tested. The SDK
transport tests use real client/agent connections over in-memory NDJSON streams
with deterministic native event injection.
