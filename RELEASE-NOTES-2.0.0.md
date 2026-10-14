# Fleet suite 2.0.0 (major release candidate)

This release promotes the validated `prerelease` line to `main` as a major
release. Versions are produced by the `main` version-bump job, not written by
hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/fleet` | 1.1.5 | 2.0.0 |
| `@ours.network/fleet-claude-code` | 1.1.5 | 2.0.0 |
| `@ours.network/fleet-codex` (+ `.codex-plugin/plugin.json`) | 1.1.5 | 2.0.0 |

## Breaking changes

- Requires the SDK 4 line: default client attach goes through a saved shared
  gateway client profile, legacy environment daemon selection is rejected, and
  the daemon runtime ships separately as `@ours.network/daemon`. See ours-sdk
  `RELEASE-NOTES-4.0.0.md`.
- One OS-managed Fleet parent service (`ours-fleet.service` / `network.ours.fleet`)
  supervises permanent and task agents; per-agent boot and intermediate task
  services are retired. Existing installations migrate proven permanent services
  into central supervision; hosts missing the parent readiness policy get an
  actionable migration error.
- Every web task runs a saved room layout (single/pair/team).
- Fleet depends on the SDK 4, CLI 3 and MCP 2 lines.

## Stable dependency pins (blocked on upstream publication)

`prerelease` pins nightly `@ours.network/*` versions exactly. Before this
release merges, the release branch must be repinned to the published stable
versions below, `package-lock.json` regenerated, and CI rerun on the new head:

| manifest | dependency | prerelease pin | stable target |
|---|---|---|---|
| `package.json` | `@ours.network/sdk` | 3.8.1-nightly.18 | 4.0.0 |
| `package.json` | `@ours.network/cli` | 2.8.1-nightly.16 | 3.0.0 |
| `package.json` | `@ours.network/mcp` | 1.2.0-nightly.14 | 2.0.0 |
| `package.json` (dev) | `@ours.network/daemon` | 3.8.1-nightly.10 | 4.0.0 |

None of these stable versions is published at the time of writing; they are the
versions the upstream `main` bump jobs are expected to produce.

## Features

- renew the live-voice stream across access credentials
- rotate App browser link credentials
- deliver every waiting message in one turn at a boundary
- ACP chat file delivery by default, without an export directory
- notify owner for committed task lifecycle changes
- retain owned supervisors and resume task context in place
- announce managed agent readiness before loading task details
- bind live voice prompts and cancellation to managed sessions
- Fleet-owned native harness setup for the task workflow
- produce durable agent completion notifications from web backend
- add on-demand bounded Claude usage probe
- Claude/Codex subscription profiles, login, health and usage API
- add GPT-6.1 Sol brain presets
- bind voice prompts to the recorded session generation
- connect local Fleet API through generic service prefixes
- ship a gated engineering starter (Engineer + Critic pair)
- add verified current GPT and Claude Brain presets (#187)
- provision agent identity and ours MCP in the supervisor (#175)

## Fixes

- bind tickets to their credential and rotate on link codes
- only supported commands split a release; guard steering by console membership
- list every waiting prompt in the snapshot, not the first fifty
- create permanent agent files with private permissions
- refuse standalone task-member removal before web archive
- expose fenced service presence for legacy cleanup
- fence retained service cleanup and recovery ownership
- pin published MCP file delivery package
- report initial unread authentication failures and retain recovery proof
- pin directory traversal during deletion permission recovery
- recover restrictive owned artifacts during task deletion
- forward service headers before the first body byte
- handle tunnel spawn errors through shutdown
- keep conversation replay tail paging in memory
- accept validated Codex reasoning effort
- align live voice with published GPT-Live dependencies
- revoke live voice presence with browser session
- recover interrupted retirement and successor enrollment safely
- tighten provenance, release, containment and path spelling
- deliver workspace frontend and select available web ports
- link completed replies and serve Fleet installation metadata
- fail closed on missing providers; register only verified Codex subscriptions
- adopt the CLI default home from $HOME, not OURS_FLEET_HOME
- accept normal Fleet state directory permissions for uploads
- pass bounded readiness timeout through CLI adapter factory
- … and 12 more; see `git log origin/main..origin/prerelease`.

## Merging

The `main` bump reads only the head commit message. Merge with a merge commit
whose subject is `feat!: promote prerelease to main` and whose body contains a
`BREAKING CHANGE:` line; the default "Merge pull request" subject yields a patch.
