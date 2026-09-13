# Fleet integration validation

The change is ported onto Fleet `main` commit
`9add3db892e29fd3fe0b5d4d44af84617f33d5f7`. It does not depend on the earlier
unpublished native-backend baseline.

Validation on Linux, 2026-09-13:

- Fleet backend/web typechecking and configured build passed.
- ACP protocol, delivery, permissions, conversation and current-main watchdog
  suites: 252 tests passed across nine files.
- Real watchdog/operator-hold → durable monitor → resumed successor regression:
  one test passed; the successor executes the saved hint once without new mail.
- Owner, attachments, commands, notifications, monitor, configuration and
  scheduled-work tests passed. The final owner-channel suite includes 84 tests,
  covering both session-recovery and operator-held ingress.
- Runner, native Codex, conversation storage/control/stream, UI and monitor
  journal regressions passed. The final configured runner/owner/Hermes
  compatibility run passed 225 tests across three files.
- Hermes compatibility: 29 tests passed; actual packaged-artifact inspection
  accepted the clean reviewed pair and rejected modified installed SDK source.
- `git diff --check` passed. `npm pack --dry-run --ignore-scripts` includes all
  required compaction package artifacts, including the Hermes bundle and SDK source,
  without dependency directories or Python caches.

The initial port exposed a watchdog cancellation-error regression: generic RPC
retirement conflicted with current main's operator-attention behavior. The fix
retains that process with failed readiness and fences new dispatch. Generic RPC,
transport-loss and missing-compaction-terminal paths still retire the adapter.
The existing runner test and a new durable-successor regression pass. One
concurrent normal-watchdog test timed out; isolated and complete watchdog-subset
reruns passed with its original timeout, and the final complete runner suite
passed. No timeout or assertion was relaxed.

Producer reproducibility evidence lives with each portable package:
[Codex](codex/VALIDATION.md), [Claude](claude/VALIDATION.md), and
[Hermes/SDK](hermes/EVIDENCE.md). These deterministic tests do not claim live
provider compaction or complete lifecycle coverage.
