# Fleet init choice-map traceability

Approved product specification: `fleet-init-choice-map-2026-09-01.html` SHA-256
`75fe9f4d29e9679827412048adad430fe1b44cea373f7017191028be41bc5f00` and
`DESIGN-CONTRACT.md` SHA-256
`9f1ad86905c9749165bc2b0d08621c1d765f15123686f5b8f9240464e75117f2`.
The source artifacts remain outside this repository. This matrix records their observable
implementation; it does not turn their illustrative model choices into recommendations.

| Approved behavior | Implementation | Verification |
|---|---|---|
| Initial default-No replacement question; literal resolved manifest and split paths; identity/project exclusion | `askInitQuestions`, `splitRootFor`, `TerminalPrompter.confirm` | `begins with the exact destructive warning...`; wizard mutation-boundary tests |
| Q1 Codex-only, Claude-only, or both; empty selection stays on Q1 | provider-filtered catalog in `askInitQuestions`; `multiSelect` empty guard | parameterized `supports one-model subscription combination`; `drives the real multi-select...` |
| Catalog IDs are not recommendations or entitlement claims | questionnaire note and README/AI docs | subscription-combination test asserts note; documentation scan |
| Codex availability is checked by `doctor`; Claude entitlement at launch; unavailable models do not trigger fallback | persistent questionnaire note/review summary, README/AI docs; generated brains omit `model_chain` | real retained-note and questionnaire-summary assertions; deterministic mapping checks |
| Q2 ordinary one-model branch copies one explicit tuple to all three jobs | `assignmentStrategy: one-model`; `askInitQuestions`; invariant in `generateSetup` | Codex/Claude/both parameterized tests; `blocks an inconsistent one-model answer...` |
| Q2 specialized per-job branch asks development, review, coordination and permits all explicit provider mixes | `assignmentStrategy: per-job`; three filtered selectors | `supports a deliberate both-provider per-job mix`; mixed role-mapping test |
| No semantic model default; cursor is only a current highlight and Enter records it | `TerminalPrompter.select` help and key loop | `labels a single-select cursor as a current highlight...` |
| Quick/Balanced/Thorough; Balanced current highlight; low/medium/high mapping | reasoning selector and `REASONING_EFFORT` | `maps ... reasoning ... for every outcome`; summary-state tests |
| Fixed one-agent, reviewed-pair, phased-team, and FleetCoordinator consequences; no internal/template/Cowork question | generated role/template mapping and final summary | `maps default single/pair/team and coordinator roles...`; questionnaire call sequence |
| Review shows paths, neither/manifest/root/both existence, assignment, exact provider/IDs, effort, no fallback, task outcomes, and host caveat | `formatSetupSummary` | four `summarizes target state` cases; questionnaire summary assertions |
| Empty/unknown/duplicate subscriptions, unknown or provider-inconsistent models, tampered capabilities, unsupported effort/strategy block generation | `validateCatalog`, `generateSetup` | catalog and deterministic rejection tests; one-model invariant test |
| Catalog/generation failure occurs before host mutation | `executeInitWizard` generates and preflights before `hostSetup` | `resolves the complete setup before host or publication mutation boundaries` |
| At confirmations N/Enter/Esc/Ctrl-C/Ctrl-D/EOF cancel; in pickers Esc/Ctrl-C/Ctrl-D/EOF cancel, Enter records/continues, N is ignored, and empty multi-select is blocked | key decoding, confirm/select/multi-select loops | cancellation-at-every-stage, real select, key decoding, EOF cleanup, empty multi-select tests |
| Non-TTY fails without host/config mutation | CLI `isInteractiveTerminal` gate before directories/backend | `refuses non-TTY init without host or configuration mutation` in `test/cli.test.ts` |
| Early unsafe-path checks happen before host setup; cooperative drift is detected again under the init lock before publication | `preflightInitPaths`; `executeInitWizard`; `publishSetup` under `.init.lock` | unsafe-before-host, injected owner/device, symlink/mode/tree tests |
| Parent must exist, be an owner-controlled non-symlink directory, and not be group/world writable | `preflightInitPaths` | unsafe-before-host and path rejection tests |
| Existing manifest/root tree must be owner-private regular objects, symlink-free, same filesystem | `assertOwnerPrivate`, `assertPrivateTree`, `preflightInitPaths` | target and nested-symlink tests; injected owner/cross-device test |
| Concurrent init is serialized per named setup | `withFileLock` at `.<stem>.init.lock` | `serializes on the per-setup init lock` |
| Locked rejection after host setup explicitly warns host state may have changed | publication error wrapper in `executeInitWizard` | `warns that host state may have changed...` |
| Host setup can partially mutate before failing; config publication does not run and the error states both facts | host-setup error boundary in `executeInitWizard` | `warns about partial host state and skips publication...` |
| Generated file set is exact, canonical, deterministic, and validated before publication | `canonicalGeneratedSetup`, `writeStaged`, `validateStaged` | unsafe/missing/extra/tampered map tests; byte-determinism test |
| First run and rerun publish a complete pair; whichever prior targets exist are recorded/backed up; success reports create vs replace | recovery `state.json`, atomic renames, `InitPublishResult` existence fields, CLI result copy | absent-marker, rerun, four summary-state tests; CLI output review |
| Publication failure restores proven originals and never overwrites an unproven path | rollback inode proofs and retained evidence | injected second-publication failure and unproven rollback tests |
| Hard kill/power loss/host crash does not promise rollback; stage/recovery evidence remains inspectable | durable staging/recovery order and user-facing summary/docs | `retains inspectable evidence after a hard kill during publication` |
| Successful init does not run legacy missing-preset bootstrap afterward | CLI invokes only `executeInitWizard`/`publishSetup` | CLI source assertion/review; generated setup validation |

Required verification commands are recorded with their exact results in the task worklog
and joint sign-off. The minimum release gate is focused init/CLI tests, `npm run typecheck`,
`git diff --check`, and the full relevant `npm test` suite.
