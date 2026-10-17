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

## Selected-daemon runtime health

Each process retains one health owner per selected endpoint, expected daemon instance
and credential profile while at least one running role needs it. It shares one
nonoverlapping `version({ startup: true })` then `identities()` chain, with a two-second
interval after completion and a ten-second deadline for selection and I/O. The final
consumer releases the timer and closes any in-flight selected client; late selection
cannot publish into a replacement owner. Separate supervisor processes retain their
own health owners.

Generation validation still requires matching ready startup PID and daemon PID,
valid boot ID/timestamps and a nonempty authoritative identity index. SDK selection
continues to enforce the configured daemon instance. Failed selection, startup,
authentication or transport remains unknown identity presence. A temporary role must
first observe its own identity; retirement then requires five seconds of continuous
authoritative absence measured from the completed response. Unknown presence resets
that debounce. Generation recovery remains owned by the existing per-role observer
and recovery controller.

This runtime health is independent of resource SSE readiness. Notification long polls,
cross-process append checks, authentication/leases/presence, bounded startup probes,
process/idle monitoring, retries and scheduled business deadlines retain their owners.
Configuration/reset discovery continues through the existing qualified watches;
health consolidation does not alter supervisor policy.

## Migration and installation

Use an explicit daemon client profile with endpoint, expected instance UUID and a
credential-file path. The daemon must advertise `external-sessions-v1` and
`root-first-identities-v1`. Initialize the Human/root explicitly through the existing operator workflow. Permanent and temporary role creation always require that root; an uninitialized daemon returns `NO_ROOT` before creating any identity. No per-call opt-in flag exists.
Missing capabilities, absent root, CID collisions and failed room admission stop
startup before the model runs. They do not fall back to a direct connector.

SDK and MCP dependencies are pinned to published registry versions in the manifest
and lockfile. `npm ci` and CI install them directly; no sibling repositories, local
tarballs or dependency source bootstrap are required. Use `npm run build` and
`npm run test:pack` to validate the installed Fleet package.

Provision a daemon supporting the capabilities above before restarting Fleet
agents. Package installation does not upgrade the running daemon or migrate live
sessions automatically.

Stop existing direct-connector sessions through the ordinary operator lifecycle
before migrating their roles. Do not force-transfer a live identity. Preserve
`private-ours` state across supervisor restarts; if provisioning is uncertain, inspect
that state and reconcile through the operator workflow rather than deleting it or
reusing an invite. Updating existing briefings is part of the normal Fleet apply/up
flow. Manual and interactive ours-mcp sessions retain the direct connector workflow;
creating agent identities still requires an initialized Human/root identity.

## Verification

- `npm test`: Fleet unit and integration suite, including runner and room orchestration.
- `node test/agent-ours-daemon.integration.mjs`: isolated installed daemon, real SDK,
  service and stdio bridge; temporary reconnect/termination and permanent restart.
  `FLEET_DAEMON_CLI` can override the installed daemon entrypoint.
- `node test/agent-ours-harness.integration.mjs MODE`: real startup discovery for
  `codex-native`, `codex-acp`, `claude`, or `hermes`, without a model turn. Set
  `FLEET_CODEX_BIN` or `FLEET_HERMES_BIN` for the installed test binaries.
- MCP core suite verifies all 27 success/error fixtures and exact discovery schemas,
  denied lifecycle dispatch, unread commit preservation and filesystem callbacks.

All reported executable probes run on Linux. The existing cross-platform binder is
reused; a real macOS execution was not performed in this environment.
