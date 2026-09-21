# Supervisor-owned ours

Fleet prepares the assigned identity and room before creating the harness session.
The agent receives ready messaging, file and history tools and its assigned identity
in the briefing. It does not create or select an identity, redeem its startup invite,
or read an onboarding skill to start work.

The supervisor attaches to the explicit `OURS_CONFIG` client profile, verifies the
daemon instance, and owns a durable external session. Permanent identities are
created as roles under an existing root; Fleet never silently creates a root.
Existing permanent assignments are pinned to their CID. Temporary identities belong
to the logical temporary run: harness/bridge reconnects retain that identity, and
logical termination releases it. A clean permanent stop releases ownership while
retaining the identity and its established room membership.

A single existing Fleet binder serializes startup and cleanup. State and owner tokens
live under `~/.ours-fleet/private-ours`; the agent state directory holds only the
scoped bridge descriptor. Room orchestration stores the invite privately, consumes
it before model startup, and checks the exact provisioned CID in the Cowork seat.
Pending admission recovery observes the existing operation instead of redeeming again.
A failed or uncertain create does not mint another identity automatically.

The MCP implementation imports the original ours-mcp registry, schemas and handlers.
All 27 retained tools preserve their schemas and normal result/error contracts.
Two intentional managed-mode differences remain: `list_identities` exposes the
adopted assigned identity, and temporary `current_identity` describes the supervisor
logical-run lifetime. Seven tools are absent from discovery
and dispatch: `create_identity`, `choose_identity`, `create_temporary_identity`,
`create_root_identity`, `remove_identity`, `close_temporary_identity`, and
`define_local_identity_file`. File reads, writes and readability checks execute in
the bridge process launched by the harness, using its cwd and permissions; file
contents are streamed, rather than routed through the model context.

Claude ACP, Codex ACP/native, and Hermes ACP receive the managed connector at session
creation. Fleet replaces the standard ours connector/plugin and preserves other
harness settings. Fleet owns mail wakes, including roles with an older `native`
monitor setting. Existing isolation policy remains in effect; this change does not
claim to prevent intentional shell bypass. See [scope amendment](../SCOPE-AMENDMENT.ru.md).
Watchdog and notifier sessions use permanent assigned identities through the same
supervisor path. Temporary supervisor recycle keeps the logical run and replaces the
worker process, with at most three replacement attempts.

## Migration and review builds

Use an explicit daemon client profile with endpoint, expected instance UUID and a
credential-file path. The daemon must advertise `external-sessions-v1` and
`role-only-create-v1`. Prepare its root through the existing operator workflow.
Missing capabilities, absent root, CID collisions and failed room admission stop
startup before the model runs. They do not fall back to a direct connector.

This review uses unpublished local artifacts: SDK `3.8.1-supervisor.0` and MCP
`1.1.2-supervisor.0`. Check out the three reviewed repositories as siblings named
`ours-sdk`, `ours-mcp`, and `ours-fleet`, then run
`scripts/prepare-supervisor-review.sh` from this repository. It builds the tarballs
referenced by the review lockfiles. Fleet and MCP share the reviewed SDK; the existing
operator CLI/dev-daemon packages retain their original dependencies.

For release, publish the reviewed SDK and MCP artifacts through the normal release
process, replace the two Fleet local-file pins and MCP workspace development pin
with the released exact versions, regenerate lockfiles, then validate the packed
consumer. Provision the matching daemon before restarting Fleet agents. This task
does not publish artifacts, change production configuration, or restart services.

Stop existing direct-connector sessions through the ordinary operator lifecycle
before migrating their roles. Do not force-transfer a live identity. Preserve
`private-ours` state across supervisor restarts; if provisioning is uncertain, inspect
that state and reconcile through the operator workflow rather than deleting it or
reusing an invite. Updating existing briefings is part of the normal Fleet apply/up
flow. Manual and interactive ours-mcp sessions retain their original behavior.

## Verification

- `npm test`: Fleet unit and integration suite, including runner and room orchestration.
- `node test/agent-ours-daemon.integration.mjs`: isolated built daemon, real SDK,
  service and stdio bridge; temporary reconnect/termination and permanent restart.
  `FLEET_DAEMON_CLI` can select the reviewed daemon entrypoint.
- `node test/agent-ours-harness.integration.mjs MODE`: real startup discovery for
  `codex-native`, `codex-acp`, `claude`, or `hermes`, without a model turn. Set
  `FLEET_CODEX_BIN` or `FLEET_HERMES_BIN` for the installed test binaries.
- MCP core suite verifies all 27 success/error fixtures and exact discovery schemas,
  denied lifecycle dispatch, unread commit preservation and filesystem callbacks.

All reported executable probes run on Linux. The existing cross-platform binder is
reused; a real macOS execution was not performed in this environment.
