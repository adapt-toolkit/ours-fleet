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
| 5.2 forbidden-path enforcement | `994cbd0` | 502 |
| (audit) anchor directive assertions in generated files | `338e220` | 502 |
| 5.1 shared harness credentials read-only | `6ece53d` | 514 |
| 6.1 locked, atomic Claude pre-trust | `030a402` | 526 |
| (5.1) make the sandbox skip loud | `a8e33a4` | 526 |
| 6.4 atomic role + identity reservation | `c7eccb9` | 533 |
| 7.3 guarantee identity existence before launch | `f759a35` | 545 |
| 6.2 roll back every failed creation stage | `b077947` | 554 |
| 6.3 `spawn --isolation-file` | `312ce61` | 565 |
| 6.6 persist creation provenance | `c6de9a2` | 571 |

**Sections 1 through 5 are COMPLETE.** Only section 6 (documentation) remains: 7.1, 7.2, 7.4.

## Remaining — all three are documentation (section 6)

1. **7.1** correct the spawn skill —
   `integrations/claude-code/skills/spawn-ours-agent/SKILL.md` and
   `integrations/codex/ours-fleet/skills/spawn-ours-agent/SKILL.md`, rewritten from one source
   of truth. Must explain BOTH permission traps (2.1's `allow`→`dontAsk` denial and the
   unattended floor), require reading `ours-fleet docs`, and cover `--isolation-file`. Needs a
   packaging/content parity test across variants.
2. **7.2** stop using one console command as a liveness verdict — update `src/briefing.ts`'s
   oversight procedure and `integrations/*/skills/oversee-agents/SKILL.md` to the taxonomy 1.5
   already implements: queued, timeout/maybe-delivered, rejected, control-unavailable, confirmed
   offline. `livenessNote()` in `src/session/control.ts` is the single source for that wording —
   reuse it rather than restating it.
3. **7.4** document never-prompt failure and the capability floor — PARTLY DONE: 2.1 already
   added the floor, its six capabilities and the security meaning of `allow` to both
   `src/docs.ts` and README. What remains is the automatic-ACP-decision half (1.3) and
   cross-links from the spawn/permissions references.

Nothing is part-way done. Every commit above is complete with its tests. All three remaining
fixes DESCRIBE behaviour that already exists and is tested, so nothing is blocked by their
absence — which is why they were left last.

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
- **`ours-fleet spawn --isolation-file <path>`** — the ONE approved new operator input (6.3).
  Optional; nothing else about what an operator types changed anywhere in this release.
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
- Real bubblewrap sandbox behaviour is now COVERED for 5.1: `test/isolation-credentials.test.ts`
  runs actual `bwrap` on this host (bubblewrap 0.11.0, userns available) and asserts writes to
  the shared credential/instruction files fail while a minimal session completes on per-role
  state. It skips silently on a host that cannot sandbox — so on such a host it proves nothing.

## 6.4 — the part that is NOT done, and cannot be done from this repo

The spec says: "The ours daemon needs an internal reserve/commit/release operation (or
equivalent transactional endpoint) ... Corresponding ours daemon package: add the minimal
authenticated atomic identity-name reservation contract; pin the required version."

That is a change to a DIFFERENT package. I implemented the fleet side against a defined
contract (`IdentityRegistry` in `src/creation.ts`: `reserve(name)` / `release(name)`), and the
default implementation is `hostLocalIdentityRegistry` — a file reservation taken under the same
host-wide creation lock as the role name.

**What that buys:** atomic across every ours-fleet process on this host. Two `ours-fleet spawn`
commands racing for the same identity — the realistic case — now have exactly one winner.

**What it does NOT buy, and must be stated in the release notes:** it is not atomic against
OTHER clients of the same ours daemon. Another tool creating that identity between our
reservation and our creation still wins. Only the daemon sees every client, so only the daemon
can make the reservation authoritative.

**Not done:** the daemon-side endpoint, and the version pin. Both belong to the ours daemon
package. `IdentityRegistry` is the seam — implement it against the daemon endpoint and inject
it; no fleet-side code changes.

### The contract the ours daemon would have to provide

Hand this to whoever owns the daemon. It is deliberately minimal: three operations, one
authenticated endpoint family, no new concepts.

| Operation | Semantics |
| --- | --- |
| `reserve(name, holder, ttlMs)` | Atomically claim an identity name. Succeeds only if the name is neither an existing identity nor a live reservation. Returns a `reservationId`. MUST be atomic against every client of this daemon — that is the entire reason it lives here rather than in the fleet. |
| `commit(reservationId)` | The identity now exists; drop the reservation without freeing the name. |
| `release(reservationId)` | Abandon the claim; the name becomes available immediately. |

**Authentication:** the same `x-ours-api-token` header the fleet's monitor already uses
(`resolveEndpoint()` in `src/monitor.ts` resolves the token identically to the MCP client). No
new auth path.

**Crash between reserve and commit.** This is the case that decides the design. A fleet process
that dies after `reserve` and before `commit` or `release` must not block the name forever, so
reservations MUST expire: `ttlMs` is supplied by the caller and the daemon drops the
reservation when it lapses. The fleet passes a TTL a little longer than its own creation
transaction. A lapsed reservation is indistinguishable from a released one — no repair step,
no operator action. The fleet's host-local equivalent already behaves this way
(`clearStaleReservations`).

**If the daemon is older than required.** The fleet MUST NOT fail the spawn and MUST NOT
pretend the guarantee holds. It should fall back to `hostLocalIdentityRegistry` — which still
makes concurrent `ours-fleet spawn` safe — and say so once, plainly, naming what is not
guaranteed: that another ours client creating the same identity concurrently can still win.
Degrading loudly is the rule this whole release is built on; degrading silently here would
re-create the exact defect 2.3 and 5.2 were about.

**Version pin.** Once the endpoint exists, pin the minimum daemon version.

**Recommendation to whoever builds the daemon side:** have `doctor` report WHICH registry is in
use — daemon-backed or host-local — so an operator sees the difference rather than infers it.
The fallback must announce itself once and name exactly what is no longer guaranteed. Degrading
silently there would re-create the defect 2.3 and 5.2 were about, inside the fix for a third
one.

## 7.3 — a deviation from the strictest reading, flagged

The spec says "verify the effective identity and create it when absent". Verification is
implemented for real (the daemon's authenticated `/identities`, already used by doctor).
**Creation is a seam** (`IdentityProvisioner.create`), and there is NO default implementation,
because there is no supported way to create a ROLE identity from this repo: `ours-mcp` exposes
only `create-root`, and role identities are minted through the MCP `create_identity` tool
inside an agent session. Inventing a daemon endpoint is what Coordinator ruled out for 6.4.

So when the identity is absent and nothing can create it, the fleet does NOT hard-fail the
spawn. It warns loudly, and the generated briefing tells the agent to mint it — which is what
already happens today — while never claiming the identity was "predefined".

**Why not hard-fail:** the spec's own closed-when allows "handled before launch OR creation
fails loudly", but hard-failing would break the normal case (a new role needs a new identity)
on every host, in exchange for a guarantee I cannot deliver anyway. A loud warning plus an
honest briefing is strictly better than today and breaks nothing. **If the owner wants
hard-fail, it is one branch in `ensureIdentity`.**

What IS fully delivered: the identity stage runs inside the creation transaction and BEFORE
the service is enabled (asserted by an ordering test); a failing `create()` aborts and rolls
back with no config, no state dir and no service; an unreachable daemon is `unknown` and never
mistaken for absent; and the briefing states only what was actually established.

**The word "predefined" is gone from generated briefings.** That claim is what sent a real
agent — the one writing this — to improvise its own identity on first boot.

## Environment trap (cost me a confusing hang)

`mkdirSync` on a path under `/proc` HANGS in this sandbox rather than throwing — a bare
`node -e "mkdirSync('/proc/x', {recursive:true})"` hangs too, so it is the environment's
filesystem, not ours-fleet code. Do not write tests that provoke failures via `/proc`
paths; use a realistic failure instead (e.g. a directory where a file is expected).

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
- `test/atomic-file.test.ts` and `test/cli.test.ts` both run `npm run build` in `beforeAll` and
  drive the built `dist/`. The 6.1 concurrency test spawns 10 real processes; the
  killed-before-rename test waits out the 10s stale-lock window on purpose, so that file takes
  ~12s.

## Release acceptance — an addition the spec does not state

**The 5.1 sandbox tests must have RUN, not merely passed.**
`test/isolation-credentials.test.ts` drives real `bwrap`. On a host without working user
namespaces those tests SKIP — legitimately, since a developer machine may not sandbox — and a
suite that reported green would then say nothing at all about the credential boundary. That is
this release's own disease inside its verification: absence of a signal read as absence of a
problem.

The skip is therefore loud: the file prints a banner naming what was NOT verified and why, and
vitest reports the tests as `skipped`, never as passed. When they do run it prints the host's
bwrap version.

Sign-off requires the suite output to contain
`[5.1] sandbox tests RUNNING against real bubblewrap — <version>`,
with that version recorded in the evidence bundle. On the machine this branch was built,
that line reads **bubblewrap 0.11.0** and user namespaces work, so the 5.1 tests were real here.

I did NOT add this to `IMPLEMENTATION.md`: that file is the approved spec, not mine to edit.
It belongs in the release checklist alongside the 13 soak checks.

## Mutation checks performed (evidence, not confidence)

Each of these was run by breaking the fix and confirming the tests go red:
- 3.2 / false-pass audit: deleted `Restart=on-failure` from the unit template while LEAVING the
  comment that mentions it — 2 tests fail; under the old `toContain` they stayed green.
- 5.1: reverted the wrap context to the pre-fix whole-home mount — 4 of 6 real-bubblewrap tests
  fail.
- 6.1: removed the lock from `pretrust` (keeping the atomic replace) — the ten-process test
  fails with entries missing.
- 5.1 loud skip: forced `sandbox.ok = false` — the banner prints and vitest reports
  `6 skipped`, never `6 passed`.
