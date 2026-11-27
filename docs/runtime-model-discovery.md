# Installed runtimes and model metadata

This change is unreleased. It neither upgrades upstream CLIs nor changes configured models/efforts or authentication files.

## Runtime policy and migration

There are four independent versions: the Ours integration/skill bundle, the upstream CLI, the ACP adapter and its SDK-managed CLI, and model metadata. @ours.network/claude-code 2.0.4 is the Ours bundle, not Anthropic Claude Code 2.0.4.

The adapter dependencies stay pinned because their control protocol, permissions and effort handling are qualified together. The SDK dependencies carry native upstream binaries; removing every pin would not remove that bundled runtime and would discard reproducibility.

Fleet already uses your installed Claude/Codex when it is at least as new as the
adapter's bundled copy. If it is older, missing or unreadable, Fleet silently uses
the bundled copy. This precedence is unchanged from 2.4.0; explicit executable
overrides remain authoritative. The installer itself never installs either CLI.

The proposed strict missing/old-host error policy was held and reverted because
it would break existing roles, including this host's Codex 0.162.1 versus the
adapter's bundled 0.166.0. The metadata-only change does not impose that policy. The separately reviewed runtime-policy slice adds an explicit fresh-init choice while preserving unmarked definitions; see [runtime policy](runtime-policy.md).

Current Codex adapter qualification: 2.7.0 uses >=0.166.0; 1.10.0 uses >=0.153.3;
legacy 1.1.7 uses >=0.145.0. Claude's current host preference compares against the
SDK's claudeCodeVersion (2.1.321), a conservative qualification boundary, not a
proof that all earlier releases are incompatible or all future releases work.

Existing roles retain their model, effort, CLI override and authentication.
An explicit nonempty CLAUDE_CODE_EXECUTABLE or CODEX_PATH selects a custom path.
An explicit empty value keeps the bundled runtime. No setting is rewritten.
Custom ACP commands retain control of their runtime.

## Model sources

Official interfaces: [Codex app-server model/list](https://learn.chatgpt.com/docs/app-server#models), [Claude SDK query.supportedModels](https://code.claude.com/docs/en/agent-sdk/typescript#query-object).

Codex model/list is already in released Fleet 2.4.0; this change retains previously dropped fields. IDs use `model` (falling back to `id`), label uses `displayName`, efforts use ordered `supportedReasoningEfforts[].reasoningEffort`, and the optional suggested default uses `defaultReasoningEffort` only when supported. Installed host schema verified with codex-cli 0.162.1; schema artifacts in task tooling-evidence/codex-schema. This host's installed CLI is below the selected adapter 2.7.0 floor; unchanged Fleet precedence queries the bundled 0.166.0 for discovery and launch. The generated 0.162.1 schema is evidence of the installed host interface, not a claim that this is the selected ACP runtime.

Claude metadata uses the selected adapter's SDK with the installed CLI and provider environment. The probe replaces CLAUDE_CONFIG_DIR with a private disposable directory: actual initialization writes metadata (.claude.json and plugin-store metadata), even with persistSession=false. No auth file is copied, and user settings/auth directories are not the probe's write destination. This deliberately returns a generic provider/harness catalog, not an account-specific eligibility list. ID is SDK `value` (preserves aliases), label is `displayName`, efforts are `supportedEffortLevels`; supportsEffort=false means no effort setting. Missing support means unknown, never all efforts. SDK metadata does not provide a reliable per-model default effort, so none is invented. `resolvedModel` is not substituted for aliases or user choices.

The SDK probe submits no prompt message: an empty input iterator stays pending, only supportedModels initialization is requested. It uses settingSources=[], disableAllHooks=true, plugins=[], tools=[], mcpServers={}, strictMcpConfig=true, persistSession=false, an isolated disposable config home and a 5-second abort/close boundary. It does not request inference or token-counting operations. This is not a network capture proving zero incidental network traffic, nor an entitlement, quota or inference test. Policy-managed provider differences and settings deliberately excluded by the probe can affect catalog completeness; advanced/custom model entry remains available.

Caches: Claude metadata TTL 5 minutes, negative results 10 seconds, keyed by executable/version, profile, credential-file modification time and a hash of the effective environment; in-flight refreshes coalesce. Codex retains its executable/version/profile/sign-in cache with the same TTLs. Picker requests wait at most 200ms for async discovery, then return labeled static fallback while the coalesced refresh continues. Existing synchronous executable version probes retain a 5-second process bound. Codex listing has one 30-second budget, 100-page guard and repeated-cursor rejection.

Onboarding payload carries per-entry `source`, `freshness` (fresh/cached/static), and optional defaultEffort. Harness capability reports retain runtime-discovery versus adapter source plus freshness at discovery level. Runtime IDs with unknown efforts remain available through advanced creation; onboarding's explicit-effort flow only lists models with known metadata. Known-empty Codex catalogs are not replaced with invented entries. Unknown/offline/auth/timeout metadata falls back to the versioned static adapter catalog; the warning remains visible. Existing local models_cache.json reader is an offline doctor path, not this picker data source.

Static fallback is a maintained adapter contract, not current account availability. All catalog entries require provider validation at launch. No private account endpoint, API-key model endpoint substitute, session token scraping or paid inference was used to refresh models.

Claude picker labels explicitly say “plan/org checked at launch”. Its no-credential probe cannot discover plan tier or organization allowlists. The probe always disables updater and nonessential traffic with DISABLE_AUTOUPDATER=1 and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; it never updates the selected CLI. CLI version detection in this Claude discovery path uses async execFile under a one-second timeout. Error responses use fixed metadata error categories and never return raw SDK/environment diagnostics. Environment hashes remain in closure memory only and are never logged or persisted.

## Internal runtime-selection audit (policy unchanged)

- Claude launch: harness/claude-code.ts prepareSession -> hostClaude; merged role/service env preserves explicit override.
- Codex persistent/temporary launch: harness/codex.ts runtime resolution and prepareSession -> hostCodex/probeCodexRuntime; same merged environment.
- Managed CLI launch: managed-cli.ts -> hostCodex, unchanged.
- Codex model metadata: application/codex-models.ts -> probeCodexRuntime with service env and the selected subscription profile for the app-server request, unchanged executable precedence.
- Doctor: doctor.ts -> probeCodexRuntime for native or ACP selections, unchanged.
- Subscription login/status helpers use defaultBinaries() (OURS_FLEET_CLAUDE_BIN / OURS_FLEET_CODEX_BIN or PATH), not hostClaude/hostCodex. Those overrides and profiles are unchanged.
- New Claude metadata: application/claude-models.ts uses async installed-CLI inspection, private disposable config and static fallback; it never changes a launch selection. Bundled-only Claude metadata returns unknown/static rather than selecting another executable.
