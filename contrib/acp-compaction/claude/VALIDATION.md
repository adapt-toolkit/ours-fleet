# Packaged-command validation

Validated 2026-09-13 on Linux x64 with Node 22.23.1 and npm 10.9.8, using only
this package directory and a new empty target. No prior source checkout,
global adapter, or git commit/index operation was used.

```sh
node contrib/acp-compaction/claude/prepare.mjs "$TARGET"
```

The packaged command exited 0. Its recorded steps were:

- Download immutable upstream archive; verify archive and lockfile SHA256.
- Verify cumulative patch SHA256; `git apply --check` and `git apply` succeed.
- `npm ci --ignore-scripts --no-audit --no-fund`; installed package versions match
  ACP SDK 1.4.0 and Claude Agent SDK 0.3.257.
- `npm run build`: passed (TypeScript).
- `npm run check`: lint and repository formatting passed.
- `npm exec --offline -- vitest run src/context-compaction.test.ts
  src/tests/acp-agent.test.ts -t 'compaction|compact'`:
  **32 passed, 471 skipped**.

This includes negotiated lifecycle and legacy output, terminal-only outcomes,
distinct retry IDs, duplicate start fencing, reset persistence, stale terminal
UUID aliases, duplicate/enrichment aliases, and bounded ID/alias capacity. The
adapter prompt/status routing fixture uses distinct opening/terminal UUIDs.

The precise argv are in `manifest.json`; each run creates its own complete
`validation.log` and `validation.json` under the selected target. The latter is
written only after every command succeeds.

Additional package checks passed: missing target gives usage/nonzero exit;
nonempty target is rejected without changing a sentinel or directory contents;
modified patch is rejected before target creation. Moving the complete prepared
target to a directory containing spaces preserved adapter `--version` (0.76.0).

No live model compaction, provider execution, ACP v2, or complete runtime
mutation/rollback coverage was tested. Tests exercise the real lifecycle and
existing deterministic adapter prompt-routing fixture, not a live Claude query.
Never-observed UUID correlation remains outside the proven contract.
