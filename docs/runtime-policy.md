# Explicit runtime policy for new Fleet definitions

This slice adds a runtime choice to new initialization without changing existing roles. It does not install or update Claude Code or Codex, edit PATH/auth, or change models or effort.

The four versions are independent: the Ours integration/skill bundle; the upstream agent executable; the ACP adapter and SDK/native dependencies; and model metadata. The Ours package pin is not an upstream CLI version. Fleet installation still acquires the adapter's SDK/native dependencies even when an installed CLI will run; this feature selects the executable and does not remove those package dependencies.

## Choose during init

The wizard asks which runtime freshly generated definitions should use. The settings JSON and onboarding API accept optional `runtimePolicy`:

- `installed-v1` (wizard recommendation): validate a compatible installed executable before host setup/config publication, then write `env: { OURS_FLEET_RUNTIME_POLICY: installed-v1 }` into only newly created agent/template definitions. At launch, a missing, unreadable or unqualified installed CLI is an actionable error; no automatic installation or different runtime is selected.
- `bundled`: explicitly pin the adapter-managed runtime using `CODEX_PATH: ""` or `CLAUDE_CODE_EXECUTABLE: ""` for the provider that definition uses. Installing/upgrading a CLI later will not replace this choice until the explicit override is changed.
- `legacy`, or omitted in existing API/settings clients: keep Fleet 2.4.0 behavior. Prefer the host only when it is at least as new as the selected adapter bundle, otherwise use that bundle. A fallback warning names the selected binary/version and the exact explicit choice. Existing files are never rewritten by init/update/restart.

An explicit provider override always wins. Empty means bundled. In installed-v1, a nonempty explicit executable is validated rather than silently replaced; in legacy mode its existing treatment is unchanged. Unknown marker values are errors. Custom ACP/native command overrides retain their command-owned runtime; Fleet reports that it cannot verify that command's executable instead of interpreting arbitrary shell commands.

All choices are per generated definition. The `env` map is an existing schema field: old Fleet 2.4.0 can read the new configuration. The internal marker is removed from CLI version probes and spawned agent environments; it remains in the saved definition for restart. Older Fleet ignores the marker, so downgrading loses strict enforcement while retaining readability. The longstanding explicit provider overrides still work on rollback.

## Qualification and diagnostics

Codex ACP2.7.0 uses minimum 0.166.0, ACP1.10.0 uses 0.153.3, legacy ACP1.1.7 uses 0.145.0 (existing adapter qualification). Claude retains the conservative qualification floor from the selected SDK's claudeCodeVersion (currently 2.1.321). Strict mode requires a qualified adapter version; unfamiliar adapter versions are refused rather than guessed. These are qualified version/features, not universal claims about earlier/future CLIs. Plugin-only installation separately checks actual plugin commands and never installs either upstream CLI.

Persistent and temporary ACP roles use the same resolver. Marked default native Codex app-server roles use its selected binary directly; custom commands retain their own selection. Legacy native launcher behavior is unchanged. Managed CLI analysis, doctor and launch use the same underlying choice. Doctor summarizes installed-v1/legacy/explicit/invalid counts and reports the selected runtime per role; copied unmarked roles remain visible as legacy. Launch logs emit each fallback warning once.

Subscription login/status helpers keep their separate explicit helper binary overrides. Model catalogs are not entitlement or inference checks and do not change a launch choice. A role's explicit runtime and model may still be rejected by its provider; that error is surfaced with no automatic model substitution.

## Settings and installer integration

Both current per-purpose `effort` settings and retained legacy `reasoning`/`efforts` settings can carry the optional policy. Omission remains legacy for compatibility. The onboarding GET advertises the three runtime choices; POST passes the selected value through the shared preflight/publication boundary. API clients must require the advertised capability/options before promising strict enforcement by an older server.

The corresponding installer change accepts the same field and requires the exact acquired Fleet binary to advertise `init.runtime-policy-v1` before invoking `init --settings`. Old Fleet refuses this policy path without initializing config; removing the field is an explicit choice to retain legacy behavior. The installer release manifest must select the approved new Fleet before this route can ship. No unpublished package version is pinned by these source changes.

## Existing installations and optional migration

No automatic migration or rewrite is included. Unmarked existing roles still launch as before, with fallback provenance visible. Doctor shows mixed modes. To change a role, review its current choice and explicitly edit its env/override through the existing configuration workflow. Preserve a backup and do not change Brains/auth/unrelated env. A future dry-run/approved migration tool with reversible backups is a separate optional slice; this release does not pretend to provide that command.

Validation includes marked and unmarked old/missing/equal/new hosts, explicit empty/custom paths, marker stripping, fresh-init preflight before mutations, API/settings persistence, repeat-init preservation, restart, doctor and actual released 2.4.0 config reading. The released-binary check uses a task-local dependency tree and `--version` only; it does not start paid inference or claim a clean-OS installation.

Catalog runtime inspection uses asynchronous version probes and coalesces concurrent runtime resolution, so a hanging version command cannot block the model-picker event loop. Launch-only synchronous host probes retain their existing five-second bound.
