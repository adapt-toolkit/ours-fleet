# HANDOFF — ours-fleet stability release

Branch `stability/release-fixes` in a worktree at `/tmp/impl1-fleet-stability`, cut from
prerelease at `5648ccb`. Written by Implementer-1 for whoever continues this.

**Never push, merge, tag or publish.** This gets reviewed against IMPLEMENTATION.md first.
The spec is `IMPLEMENTATION.md` (untracked, in the worktree root). Build only what it lists.

## How to work here

```
npm install                 # once
npx tsc -p tsconfig.json --noEmit
npx vitest run              # ~30s; use `timeout 400` — a bad test can spin a fake clock
```
One commit per fix, message naming the fix, tests in the same commit. Run the suite before
calling anything done. Report to Coordinator over ours messaging (identity `Implementer-1`).

Baseline before any work: **339 passed**.

## Done

| Fix | Commit | Suite after |
| --- | --- | --- |
| 1.1 typed supervisor liveness (`up` cannot discard a live session) | `c08fbf4` | 357 |
| 1.2 ACP refusal outcomes preserved through delivery and startup | `5f214d3` | 366 |
| 1.3 visible, one-shot unattended permission denial | `960da7d` | 373 |
| 1.4 health cannot pass an invalid configuration | `47cd585` | 386 |
| 1.5 accurate, prompt `peek`/`send`/`down` failures | `19d7b5c` | 397 |
| 1.6 real exit classification for both backends | `e0b7248` | 410 |
| 1.8 self-healing, timestamped monitor status | `7032254` | 416 |
| 2.3 translation warning channel made live | `d6ffa71` | 439 |
| 2.1 neutral `allow` actually allows + unattended floor | `75d91f1` | 454 |
| 2.4 warn when native overrides contradict neutral intent | `68e4a49` | 468 |
| 3.2 backoff + durable fast-failure circuit breaker | `ead5572` | 484 |
| 5.2 forbidden-path enforcement | `e058036` | 502 |

Sections 1, 2 and 3 are complete; section 4 is in progress (5.2 done, 5.1 next).

## Remaining, in spec dependency order

1. **5.1** shared harness credentials read-only
2. **6.1** locked, atomic Claude pre-trust
3. **6.4** one atomic reservation for role and identity names
4. **7.3** guarantee identity existence before launch
5. **6.2** roll back every failed creation stage
6. **6.3** `spawn --isolation-file` (the ONE approved new operator input)
7. **6.6** persist creation provenance
8. **7.1** correct the spawn skill
9. **7.2** stop using one console command as a liveness verdict
10. **7.4** document never-prompt failure and the capability floor

Nothing is part-way done. Every commit above is complete with its tests.

## Rulings from Coordinator (do not re-litigate)

- **1.3 shared option-selection helper.** Fixing it also changed the ALLOW path
  (`allow_always` now genuinely preferred over `allow_once`). Approved; must be NAMED in the
  final report, not buried in the diff.
- **1.6 `.exit-status` became a JSON record.** Approved — internal state, not operator input.
  Backward compatibility with the bare-number format is required AND tested; name the tests in
  the final report: `test/runner.test.ts` → "still reads a bare number left by a pre-upgrade
  pane" and "a legacy bare-number record drives the same decision".
- **`src/permissions.ts` as a new file** (spec allowed config.ts or a new file). Approved.
- **2.1 floor severity.** FAIL on `unattended: deny`, WARN on `unattended: wait`. Approved
  explicitly — "do not change it to fail-both, the distinction is the point".
- **2.1 what `dontAsk` grants.** Judged on what the native mode really grants, not on how
  permissive its name sounds. Approved.
- **2.1 THE FLOOR LIST — PENDING THE OWNER.** The spec describes the floor in prose; I rendered
  it as six named capabilities in `UNATTENDED_FLOOR`, `src/permissions.ts`:
  `read-state, write-state, messaging, monitor, workspace-edit, status-commands`.
  Coordinator approved it as my reading and escalated it to the owner, because doctor now
  ENFORCES it. If the owner reads the prose differently, it is one constant.
- **2.4 `permissionsDeclared`.** Internal field on `ResolvedRole`; not a config key. Needed so a
  single source of permission intent stays quiet. Approved.

## Output changes to report (no operator input changed)

Under the owner's rule these are not UX changes — nothing an operator TYPES moved. Report them
anyway so he is not surprised:

- `ours-fleet config` gains `permissions:` and `native:` lines per role, plus `warning:` lines.
- `ours-fleet doctor` gains `config`, `roles`, `permissions: <Role>`, `unattended floor: <Role>`
  and `permission conflict: <Role>` checks, and now exits non-zero on an invalid config.
- `ours-fleet status` gains a `HELD DOWN since …` line for a tripped circuit breaker.
- `peek`/`send` failures print the real error plus a liveness note instead of "is not running".
- `.monitor-status` is now one line per active cause, each ISO-timestamped.
- `.exit-status` is now a JSON record (legacy bare number still read).
- New file per role: `.restart-ledger.json`.
- `ours-fleet config` now REFUSES a role whose isolation asks for a forbidden mount (5.2).
  That is a refusal-behaviour change, which the release rule allows; a config that used to
  load and silently mount `~/.ssh` now fails by role and path.

## The unit-file upgrade question (Coordinator raised it before 3.2 — answered)

**Question.** 3.2 moves restart policy out of the service managers. Existing hosts have unit
files on disk carrying `Restart=always RestartSec=2`. Does the new breaker coexist with them,
are they rewritten on upgrade, and if they are incompatible does that need saying?

**Answer: they coexist safely, and no operator has to type anything new.**

- Containment does not depend on the unit's restart policy. When the breaker opens, the runner
  process **stays alive** and polls its ledger. There is no exited process for systemd or
  launchd to restart, so an old `Restart=always` unit has nothing to act on and the held-down
  state is not a lie.
- The new runner never exits cleanly in production (`runSupervised` loops until `shouldStop`,
  which is undefined outside tests). So the one case where `Restart=always` and
  `Restart=on-failure` differ — restarting after a clean exit — cannot arise.
- If the runner PROCESS itself crashes, both old and new units restart it; the fresh runner
  reads the ledger, sees `circuit: open`, and holds down without starting a child. Verified by
  test: "stays held down without starting another child".
- **launchd** rewrites its plist on every `install()`, i.e. on every `ours-fleet up`, so the new
  `KeepAlive{SuccessfulExit:false}` lands automatically.
- **systemd** writes its template only in `init()`, reached only by `ours-fleet init`. An
  existing host keeps `Restart=always RestartSec=2` until the operator re-runs `ours-fleet init`
  — an EXISTING command, so the workflow rule is not crossed. Until they do, behaviour is
  already correct per the points above; the template change is a correctness/clarity
  improvement, not a prerequisite.

**Not verified:** the systemd/launchd half is reasoned from unit semantics and from reading
`src/supervisor/*.ts`. It has NOT been exercised against a real systemd user manager — that
belongs in the soak (release check 3).

**Deliberately not done:** making `ours-fleet up` rewrite the systemd template so the change
lands without `init`. It would work and changes nothing an operator types, but it is not in the
spec. Flagged rather than built.

## Found and deliberately left alone

- `ours-fleet send` reports success when a console has not accepted the input — Coordinator says
  this is already open with the owner and explicitly OUT of scope. Leave it.
- The existing systemd test asserted `Restart=always` with `toContain`, which would have passed
  on the string appearing in a comment. Changed to an anchored line match while touching 3.2.

## Not verified (carry into the final report verbatim)

- **Zero-approval startup against the real `claude` and `codex` CLIs** — soak check 9; needs a
  host with both installed and logged in. What IS verified is the equivalent path through the
  real ACP fixture (`test/runner.test.ts` → "a floor-compliant role starts with ZERO permission
  prompts"). These are not the same claim; do not merge them.
- **All 13 release soak checks.** None have been run. This branch has unit/integration tests
  only.
- Real bubblewrap sandbox behaviour (relevant to 5.1/5.2 when they are built).

## Test-harness notes for a successor

- `test/fixtures/acp-agent.mjs` is a real ACP agent used by several suites. Modes:
  prompt text `refuse`/`cancel`/`block <ms>`/`permission`/`permission twice`; env
  `ACP_FIXTURE_STOP_REASON`, `ACP_FIXTURE_EXIT_AFTER`, `ACP_FIXTURE_EXIT_CODE`,
  `ACP_FIXTURE_ALWAYS_PERMISSION`.
- `test/registry.test.ts` exports `fakeAdapter`, which every other suite registers. Adding a
  REQUIRED adapter method means updating it there.
- 3.2's tests drive `runSupervised` with an injected `attempt` function and a fake clock. The
  loop holds down forever by design, so a test world MUST stop on `circuit === 'open'` or it
  spins.
