/**
 * Stable, AI-friendly CLI and configuration reference.
 *
 * Keep this concise enough to place directly in an agent context. Unlike
 * Commander's per-command help, this describes how the pieces compose.
 */
export const AI_DOCS = `# ours-fleet reference

ours-fleet runs persistent or temporary, identity-bound AI roles. A role selects
a harness independently from its session backend:

- harness: \`claude-code\` or \`codex\`
- session: \`tmux\` (default) or \`acp\`
- lifetime: permanent (supervised, restartable) or \`spawn --temp\`

## Discover and validate

\`\`\`sh
ours-fleet docs                         # this complete reference (\`man\` is an alias)
ours-fleet help <command>               # exact flags for one command
ours-fleet config [-c FILE]             # validate and print the merged plan; no changes
ours-fleet doctor [-c FILE] [--harness codex|claude-code]
\`\`\`

Default configuration is \`~/fleet.yaml\` plus sorted \`~/fleet.d/*.yaml\` role
drop-ins. An explicit \`-c FILE\` replaces \`~/fleet.yaml\`; fleet.d still adds
roles. Validate with \`config\` and \`doctor\` before starting or restarting.

## Lifecycle and console commands

\`\`\`sh
ours-fleet init
ours-fleet up|down [Name...]
ours-fleet restart [Name...]            # preserve/resume harness context
ours-fleet force-restart [Name...]      # fresh context; briefing is reloaded
ours-fleet ls
ours-fleet status|peek|attach|logs Name
ours-fleet logs -f Name
ours-fleet send Name "prompt"
ours-fleet send Name --key Enter        # tmux only
ours-fleet rm Name
ours-fleet watchdog-report <name> [run-id] [--list] [--json]
ours-fleet watchdog-run <name>
\`\`\`

\`peek\`, \`attach\`, and text \`send\` work with tmux and ACP. ACP attachment
also accepts \`/permit <permission-id> <option-id>\`, \`/interrupt\`, and
\`/detach\`. Raw \`--key\` input is tmux-only.

## Local web console

The npm package includes the web console; installed users do not clone the repo
or run \`npm run build\`:

\`\`\`sh
npm i -g @ours.network/fleet
ours-fleet init
ours-fleet doctor
ours-fleet web                         # install/update service, start, pair browser
\`\`\`

The normal command uses stable \`http://127.0.0.1:49271/\`, installs an
owner-level systemd user service (Linux) or LaunchAgent (macOS), and opens a
five-minute one-use pairing link in the local browser. After pairing, bookmark
the plain URL or install the PWA. To pair a new, signed-out, or revoked browser,
run \`ours-fleet web open\`.

\`\`\`sh
ours-fleet web status
ours-fleet web start|stop|restart
ours-fleet web open
ours-fleet web revoke-all              # revoke every browser and active session
ours-fleet web uninstall
ours-fleet web serve --port 0 --no-open # isolated foreground/testing mode
\`\`\`

The console is IPv4-loopback-only by default. Both \`localhost\` and
\`127.0.0.1\` are accepted locally. For an nginx/TLS reverse proxy, keep the
default bind and declare the exact browser origin:

\`ours-fleet web install --public-origin https://fleet.example.com --password-file /secure/fleet-password\`

Fleet reads the password file during setup and persists only a salted scrypt
verifier. New browsers authenticate and retain rotating HttpOnly/SameSite
trusted-device credentials. If nginx already authenticates, the operator may
deliberately select \`--no-password\`; the CLI and browser warn that anyone
reaching the origin can control the fleet. First setup requires an explicit
choice: \`--password-file\` or \`--pairing\` for protected access, or
\`--no-password\` for intentional unprotected access.

Use \`--bind ADDRESS\` only for an intentional direct listen. A non-loopback
bind is rejected unless \`--public-origin\` is also present. Host/Origin checks
use the declaration and do not trust forwarded headers. Configure nginx to
proxy HTTP and WebSocket upgrades to \`127.0.0.1:49271\` and terminate TLS;
fleet accepts nginx's loopback upstream Host, so no Host rewrite is required.
Browser credentials add Secure for HTTPS, and \`revoke-all\` invalidates all
trusted devices. Role creation offers harness-scoped known-model choices
while still accepting a typed model ID; blank explicitly uses the selected
harness's own default.

## Spawn

\`\`\`sh
ours-fleet spawn [--temp] [Name | --role Name] \\
  --harness codex|claude-code --session tmux|acp \\
  --mission "one line" --cwd /absolute/path --identity Identity \\
  --coordinator Coordinator --model MODEL \\
  --approval ask|auto|allow \\
  --filesystem read-only|workspace|unrestricted \\
  --unattended deny|wait \\
  --bio-file /path/bio.md --persona-file /path/persona.md
\`\`\`

Permanent spawn writes \`~/fleet.d/Name.yaml\` and starts a supervised role.
\`--temp\` writes ephemeral state, starts a detached supervisor, and removes the
role after exit/reboot. Both lifetimes support \`--session acp\`.

Temporary-role identity bootstrap is capability-based. The generated briefing
first tries to bind the exact assigned identity and preserves it when it already
exists. If missing, it uses ours MCP \`create_temporary_identity\` when that tool
is exposed, tying a newly-created identity to the connector session lifecycle;
older servers fall back to \`create_identity\`. Collisions and creation errors
stop safely without force-adopting or deleting identity state. Permanent roles
retain normal \`create_identity\` behavior.

Inside a managed ACP role, the same CLI automatically routes a real \`spawn\`
through that role's authenticated supervisor control socket. \`--role Name\` is
accepted as an alternative to the positional name, so a minimal delegated call
is \`ours-fleet spawn --role DeveloperX --temp\`. The supervisor records the
calling role, performs creation, and only after success sends a structured
spawn notice through the caller's owner channel when one is configured.

Omitted harness, session, working directory, coordinator, neutral permissions,
fleet monitor policy, and (when the harness is unchanged) model inherit from the
calling role. Explicit options always win. Selecting a different harness without
\`--model\` leaves model selection to that harness/fleet defaults rather than
copying an incompatible caller model. This automatic proxy is a convenience and
attribution mechanism, not an isolation boundary: an unrestricted role can still
invoke another binary path directly. Tmux roles and host/operator shells keep the
ordinary direct CLI behavior.

Codex-specific spawn flags: \`--sandbox\`, \`--permission-mode\`, \`--launcher\`,
\`--profile\`, \`--search\`, repeatable \`--codex-config key=value\`, repeatable
\`--add-dir\`, and legacy \`--monitor\` (consent for the native Codex monitor,
not the \`monitor.mode\` wake-owner selector). Run \`ours-fleet help spawn\` for
exact values.

## fleet.yaml

\`\`\`yaml
vars:
  work_root: /home/me/work
start_stagger_ms: 0
defaults:
  harness: codex
  session: acp
  model: gpt-model-id
  permissions:
    approval: ask
    filesystem: workspace
    unattended: deny
  monitor:
    mode: fleet                          # fleet (default) | native
roles:
  Coordinator:
    harness: codex
    session: acp
    identity: Coordinator
    cwd: \${work_root}/project
    mission: Coordinate work and delegate implementation.
    model: gpt-model-id
    permissions:
      approval: ask
      filesystem: workspace
      unattended: deny
    session_options:                    # advanced overrides; normally omit
      # acp:
      #   command: [/custom/codex-acp, --flag]
      tmux:
        boot_grace_ms: 10000
    monitor:
      mode: fleet                        # fleet supervisor | native harness monitor
      interrupt: false                    # true cancels active work before every configured wake
      wake_sources: [message_received, file_received, local_contact_request, pending_message]
      batch_ms: 2000
      inject: notification
      turn_fail_threshold: 3
    harness_options:
      launcher: auto
      sandbox: workspace-write
      approval: on-request
      search: false
      profile: fleet
      add_dirs: [/data/shared]
      config:
        model_reasoning_effort: high
    bio: Public role card and when peers should engage it.
    persona: Local operating contract, boundaries, and escalation policy.
    briefing_file: /absolute/custom-briefing.md
    coordinator: AnotherCoordinator
    env:
      KEY: value
    oversee:
      - { role: Worker, interval: 5m }
watchdogs:
  nightwatch:                       # [A-Za-z0-9_-], must not collide with a role name
    coordinator: FleetCoordinator   # required — where alerts go
    # everything below is optional
    enabled: true                   # default true; false = configured but never scheduled
    interval: 10m                   # default 10m; 30s | 10m | 2h, minimum 1m
    watch: [Alice, CodexReviewer]   # explicit lists are exact; omit for configured + live temp roles
    harness: claude-code            # default: defaults.harness
    model: claude-fable-5           # default: same resolution rule roles use (resolveRoleModel)
    session: acp                    # default: defaults.session
    identity: Watchdog-nightwatch   # default: Watchdog-<name>
    timeout: 5m                     # default 5m; a run past this is killed and recorded as error
    keep_reports: 50                # default 50 reports retained per watchdog
    alert_cooldown: 60m             # default 60m before the same finding alerts again
    prompt_file: /abs/extra.md      # optional extra focus, APPENDED to the fixed contract
    isolation:                      # optional; omitted means no OS sandbox, like an ordinary role
      backend: bubblewrap           # when present, the ordinary role isolation schema applies
      network: broker
      fs: { read: [/opt/watch-data] }
\`\`\`

A watchdog observes and reports; it never restarts, stops, spawns, or removes a
role, answers a pending permission, edits a workspace, or approves anything on
the owner's behalf. \`watchdogs:\` may appear only in the base config
(\`~/fleet.yaml\` or \`-c FILE\`), not in \`~/fleet.d/*.yaml\` drop-ins.
Watchdogs are not isolated by default. An explicit watchdog \`isolation:\` block
uses the same policy schema as a role and is applied unchanged; declare every
extra filesystem access required by a custom prompt there.
When \`watch:\` is omitted, each run watches the configured roles plus temporary
fleet roles that are live when the run starts. An explicit \`watch:\` list is
never augmented.

Role values override defaults. \`\${name}\` substitutes entries from \`vars\`.
Other role fields include \`max_tokens\`, \`autocompact_pct\`, and \`isolation\`.
Use README.md for the complete isolation policy and resource-cap schema.

## Permissions

Prefer the harness-neutral \`permissions\` block:

- \`approval: ask|auto|allow\`: portable permission policy. \`deny\` remains a
  deprecated, fail-closed compatibility alias for existing fleet files.
- \`filesystem: read-only|workspace|unrestricted\`: filesystem intent
- \`unattended: deny|wait\`: what ACP does when no console can answer a request

The backend translates this common intent. Harness-native settings in
\`harness_options\` take precedence where supplied. Do not choose
\`allow\`/\`unrestricted\`, Codex \`never\`/\`danger-full-access\`, or Claude
\`bypassPermissions\` without explicit authorization.

### Creation-time isolation

\`ours-fleet spawn --isolation-file <path>\` supplies a role's sandbox policy at
creation, so the FIRST launch is already confined — a role that only gains
\`isolation:\` on a later \`up\` ran unsandboxed until then.

The file holds exactly the \`isolation:\` mapping documented above and nothing
else — the same schema, validated by the same code, so a policy written here
cannot mean something different from the identical block in fleet.yaml:

\`\`\`yaml
network: deny
fs:
  read: [/opt/reference]
resources:
  mem: 2G
\`\`\`

Invalid files are rejected before anything is created: no config, no state
directory, no identity reservation. Works for both permanent and \`--temp\` roles.

### Never-prompt failure

The failure this section exists to prevent leaves no error message anywhere.

An unattended role has no console. When the harness needs a permission decision
there is nobody to ask, so the request is refused INSIDE the harness — no
prompt, no error, no log line. The agent simply does less than its briefing told
it to, reports success, and nothing distinguishes that from having done the
work. Two settings produce it:

1. a permission mode that suppresses the prompt without granting the action
   (Claude \`dontAsk\`, which is why neutral \`allow\` maps to
   \`bypassPermissions\` instead); and
2. \`unattended: deny\`, which refuses every request that reaches it.

**Automatic decisions are now recorded.** Every permission request decided
without a human emits a completed event into
\`~/.ours-fleet/agents/<Name>/.session-events.jsonl\` carrying the decision,
whether policy or a person made it, the policy that produced it
(\`permissions.unattended=deny\` vs \`permissions.approval=deny\`/\`=allow\`),
the reason, and the option selected. \`ours-fleet peek\` and \`attach\` render
them. Automatic denial asks for a one-shot rejection, never a standing one, so a
single unattended refusal cannot disable a tool for the rest of the session.

A role that can auto-deny logs one line at startup saying so.

To detect an under-permissioned role BEFORE it runs, use the capability floor
below: \`ours-fleet doctor\` fails such a role rather than letting it discover
the problem silently at work.

### The unattended capability floor

An unattended role has no console, so a permission request cannot be answered —
it is refused, silently, inside the harness. The agent then does less than it
was told to and reports no error. To make that visible before launch,
\`ours-fleet config\` and \`ours-fleet doctor\` resolve each role's neutral
permissions through its harness and check the result against a fixed floor:

- \`read-state\` — read its briefing, ROUTINES.md, and WORKLOG.md
- \`write-state\` — append its WORKLOG and its own state files
- \`messaging\` — bind its identity, send and receive ours mail
- \`monitor\` — arm and observe its mail monitor
- \`workspace-edit\` — edit and test files in its working directory
- \`status-commands\` — run the inspection commands its briefing prescribes

\`doctor\` reports this per role as \`unattended floor: <Role>\`. A role with
\`unattended: deny\` that cannot meet the floor FAILS doctor, because it will
deny those requests with nobody to see it; with \`unattended: wait\` it warns,
because a human can still attach and answer.

Security meaning: \`ask\` maps to Codex \`untrusted\` and Claude \`default\`;
\`auto\` maps to Codex \`on-request\` and Claude \`acceptEdits\`; and
\`approval: allow\` maps to Codex \`never\` and Claude \`bypassPermissions\`,
which genuinely permits the actions the role was authorized to take —
\`dontAsk\` only suppresses the prompt while still refusing the action. Nothing
other than an explicit \`allow\` becomes non-interactive. Legacy \`deny\` keeps
its conservative Codex \`on-request\` / Claude \`plan\` translation. \`allow\` is therefore a real grant and
requires explicit authorization; per-role \`isolation:\` remains the outer
boundary that a permission mode cannot cross.

ACP carries agent-advertised session mode IDs and \`session/set_mode\`, but those
IDs are agent-specific and ACP defines no portable permission-policy capability.
Fleet therefore uses the ACP primitive where an adapter exposes a matching mode
and otherwise performs the harness translation above. The live session reports
both its effective normalized mode and exact harness-native mode.

See also: \`spawn --approval/--filesystem/--unattended\` set this intent at
creation, and \`ours-fleet config\` prints each role's neutral settings, their
native translation, and any warning — the same text \`doctor\` reports.

Claude \`harness_options\`: \`permission_mode\` (default, acceptEdits, plan,
dontAsk, bypassPermissions), \`plugins\`, \`mem_palace\`, and
\`mem_palace_midsession_autosave\`.

Codex \`harness_options\`: \`launcher\` (auto, ours-codex, codex), \`sandbox\`
(read-only, workspace-write, danger-full-access), \`approval\` or
\`permission_mode\` (untrusted, on-request, never), \`profile\`, \`search\`,
\`config\`, \`add_dirs\`, and \`monitor\`.

## ACP adapters

The maintained \`@agentclientprotocol/codex-acp\` and
\`@agentclientprotocol/claude-agent-acp\` runtimes are bundled automatically as
optional ours-fleet dependencies. The supervisor resolves their executable
entrypoints internally, so default ACP roles do not depend on global PATH.
The maintained Claude adapter requires Node 22; tmux and Codex ACP continue to
work on the ours-fleet core minimum of Node 20.

Override an adapter only when necessary with \`session_options.acp.command\`
(string or argv list). If optional dependencies were deliberately omitted,
ours-fleet falls back to a compatible globally installed \`codex-acp\` or
\`claude-agent-acp\`. \`ours-fleet doctor -c FILE\` verifies the resolved adapter.

## Reliable mail wake

\`monitor.mode\` selects exactly one wake owner:

- \`fleet\` (default): the ours-fleet supervisor consumes body-free daemon
  events and advances its durable cursor only after delivery is accepted. ACP
  uses live steering when supported and falls back to structured
  \`session/prompt\`; tmux uses verified console injection.
- \`native\`: ours-fleet starts no supervisor monitor; the generated briefing
  instructs Claude Code or Codex to arm its harness-native wake mechanism.

Set \`monitor.interrupt: true\` in fleet mode to cancel active work before every
configured wake. The policy is content-blind because the supervisor cannot
inspect encrypted message bodies. Message bodies are released only when the
role calls the ours \`get_messages\` tool.

The default is \`false\`. For a temporary role whose mission intentionally arrives
after its readiness announcement, set \`mode: fleet\` and \`interrupt: true\`
explicitly. The readiness announcement does not change the transport: the
mission remains ordinary ours mail, fleet injects only the body-free wake, and
the role calls \`get_messages\` before acting. Every later configured wake uses
the same interruption policy.

Legacy \`monitor.enabled: true|false\` remains accepted as an alias for
\`mode: fleet|native\`; use \`mode\` in new configuration. Codex's separate
\`harness_options.monitor: true\` is native-monitor consent, not monitor-owner
selection.
Inspect \`ours-fleet status Name\`, \`peek Name\`, role logs, and
\`~/.ours-fleet/agents/Name/.monitor-status\` when diagnosing delivery.

## Trusted owner channel

An ACP role may declare a separate, existing ours identity which fleet — never
the agent — binds:

\`\`\`yaml
owner_channel:
  identity: Coordinator Owner Channel
  owners: [authenticated-owner-contact-cid]
  agent: authenticated-managed-agent-cid
  interrupt: false
  progress_interval_ms: 30000
  attachments:
    enabled: true
    max_files_per_request: 4
    max_file_bytes: 10485760
    max_request_bytes: 20971520
    retention_ms: 86400000
    allowed_mime: [application/pdf, text/plain, image/png, audio/ogg]
\`\`\`

This does not replace the role identity. Normal identity mail remains untrusted
peer input: the agent reads it through \`get_messages\` and replies through
\`send_message\`. Mail arriving on the dedicated channel from a CID in \`owners\`
is injected as a direct \`[fleet-owner]\` prompt. Mail from the exact \`agent\`
CID is forwarded as a new message to the latest authenticated owner conversation.
Every other CID is rejected and warned about without reflecting its body. Fleet sends
accepted/queued/progress/interrupted/failure notices and routes the ACP turn's
final assistant text back to the authenticated sender with its source wire ID.
For file replies, fleet injects a request-specific outbox path into the owner
prompt. The agent copies completed artifacts there; fleet sends every regular
file from the channel identity with the same source wire ID and removes the
temporary outbox only after successful delivery. The agent never chooses an owner
recipient or calls ours \`send_file\` for an owner-channel response.
Owner messages whose trimmed text starts with \`/\` are deterministic
supervisor commands and never enter the model: \`/help\` (alias \`/commands\`),
\`/status\`, \`/interrupt\`, \`/clear\`, \`/compact\`, \`/model <model-id>\`,
\`/restart\`, \`/force-restart\`, \`/ls\`, \`/peek\`, \`/worklog\`, and
\`/version\`. Unknown or malformed commands answer with the help text instead of
being forwarded; plain messages reach the agent unchanged. \`/clear\`,
\`/compact\`, and \`/model\` are forwarded only when the role's bundled ACP
adapter executes them locally (claude-code: all three; codex: \`/compact\`
only) and are otherwise refused with a notice, so slash text never reaches the
model as a prompt.

Owner documents, images, and voice messages use the same authenticated sender
and source-wire boundary. Fleet inspects body-free metadata first and rejects
disabled, over-count, over-size, or disallowed-MIME requests before selective
retrieval. Unauthorized CIDs are never retrieved or answered. Reply-linked text
and files from the same sender become one ordered request; a file-only wake also
starts a turn. Retrieved bytes must match their structured size and SHA-256,
their content signature must match the declared MIME, and symlinks or non-regular
paths fail closed. Sanitized copies live only in a mode-0700 request directory as
mode-0600 files and are removed after completion or bounded stale retention.

Voice prompts include a bounded transcript only when ours-mcp reports success.
Failure or unavailability is explicit and preserves the private audio path as the
fallback. Run \`ours-mcp voice-status --json\` to inspect the host configuration.
A mode-0600 crash journal contains only authenticated CID and wire routing data;
it never stores captions, filenames, paths, transcript text, or bytes. Journaled
post-retrieval files resume selectively through \`save_file\`; corrupt state
disables attachment admission rather than weakening provenance checks.

The channel identity must be unique and must not be a role identity. The bridge
persists bounded wire IDs only, never message/reply plaintext, and requeues input
before starting its turn for at-least-once crash recovery. It currently requires
\`session: acp\`: tmux has no structured, turn-correlated final answer, and pane
scraping cannot provide the same reliable reply guarantee.

### Live contact and owner administration

The supervisor which is already running the ACP role remains the sole binder of
\`owner_channel.identity\`. The CLI reaches that exact live \`OwnerChannel\`
through the role's token-authenticated, mode-0600 Unix control socket for contact
inspection and setup; it never starts another ours client and never force-binds:

Rapid supervised restart is serialized by a role-scoped single-binder lease.
The predecessor closes its authenticated control socket and MCP proxy before
releasing ownership. The replacement waits at most five seconds and retries the
daemon bind only when PID/start-marker metadata proves the holder was the same
role and owner-channel identity. Foreign, live, corrupt, or otherwise
unverifiable ownership remains fail-closed; fleet never uses \`force=true\`.

If that matching predecessor misses the bound, its still-authenticated control
route may send one fixed, digest-deduplicated recovery notice through the latest
authenticated owner conversation (or the sole configured owner). Notice
plaintext is never persisted. With no safe deterministic route fleet guesses no
recipient and leaves the actionable failure in the web console and role logs.
The remote recovery action is \`/restart\`; inspect repeated failures with
\`ours-fleet logs <Role>\` or the web console.

\`\`\`sh
ours-fleet owner-channel contact list <Role>
ours-fleet owner-channel contact invite <Role> [--name <label>]
ours-fleet owner-channel contact add <Role> (--invite-file <path> | --invite-stdin) [--name <label>]
ours-fleet owner-channel owner list <Role>
ours-fleet owner-channel owner authorize <Role> <exact-64-hex-contact-cid>
ours-fleet owner-channel owner revoke <Role> <exact-64-hex-contact-cid>
\`\`\`

Contact establishment and owner authorization are separate security steps.
\`contact add\` never authorizes: invite redemption is pending until the peer
verifies it. Once \`contact list\` reports the established contact, authorize
its exact immutable CID explicitly. Invite creation emits invite material only
on stdout; acceptance reads it from a file or stdin, not argv.

Configured \`owners\` remain the baseline. On legacy channels without \`agent\`,
live authorizations/revocations are an immediately effective, restart-persistent
overlay. Managed-agent CID gating makes fleet configuration authoritative and
disables live owner mutation and direct control-socket sends. \`owner list\` labels
baseline versus dynamic entries and effective status. The atomic mode-0600 file
contains bounded CIDs and audit actions only. Corruption disables all effective
owners and refuses mutation rather than resurrecting authority; revoking the
last effective owner is always refused.

A missing/stopped role, tmux session, role without \`owner_channel\`, unavailable
MCP client, or a role entering shutdown returns an actionable error with no
side effects. Management uses no network listener and never logs or persists
invite material.

For any non-final message—progress, blocker, suggestion, or later proactive note—
the managed agent calls ordinary ours \`send_message\` to the channel identity.
Fleet checks only that the authenticated sender CID exactly equals \`agent\`, then
forwards the text as a new message. There is no task/request/update type, phase,
reply correlation, or owner recipient argument. A sole owner is the safe fallback;
with multiple owners and no inbound route history the relay fails closed. Devices
sharing one identity share its CID; separate owner identities hand off the route
when either sends channel mail. The ACP final is separate: fleet extracts it from
the completed turn and deterministically replies to the initiating owner wire.

The bounded mode-0600 route state stores CIDs, wire IDs, timestamps, delivery state,
and hashes but never message plaintext. Unauthorized attempts produce a bounded
CID-only owner warning; attempted bodies are neither reflected nor persisted.

For a mobile owner, establish the contact first, wait for peer verification,
authorize its exact CID, and revoke that same CID when access ends. The bounded
mode-0600 CID overlay survives supervisor restart and remains fail-closed on
corruption. Update bodies remain memory-only. After a crash/restart, unfinished
deferred owner input follows the existing at-least-once replay path; the restarted
supervisor remains the sole binder.

## Stable config and YAML migration

\`ours-fleet config --json\` emits schemaVersion 1 resolved plans. Environment
values and mission/persona/bio bodies are withheld; environment keys are sorted
and values are marked redacted. Additive fields may appear in schema 1, while a
removal or semantic reuse requires a new schema version.

YAML parsing always rejects duplicate keys. The current default
\`--yaml-mode compat\` warns with file/line/column for anchors, aliases, explicit
tags, non-scalar keys, and multiple documents. Use \`--yaml-mode strict\` in CI
now; strict becomes the next-major default and compat is the temporary migration
escape hatch.

## Bounded worklogs, auth proxy, and model recovery

An optional \`worklog: { max_kb, keep_tail_kb, max_archives }\` policy rotates a
stable snapshot at fleet-owned lifecycle points. Concurrent changes defer
rotation. Archives remain beside WORKLOG.md with the same sensitive-state
boundary; retention deletes only recognized fleet archive names.

\`auth_proxy: { kind: anthropic, base_url, required, health_url }\` is Claude-only
and loopback-only. Fleet injects only ANTHROPIC_BASE_URL and doctor rejects
credential env keys. The privileged reference companion is
\`contrib/anthropic-auth-proxy.mjs\`; deploy it separately as a dedicated account
with a 0600 token file and per-role listener access. Fleet never installs it or
reads its credential.

\`model_chain\` is an ordered authorization list and its first entry must equal
\`model\`. Only sustained high-confidence entitlement/quota 429 evidence advances
one entry. Transient 429, overload, auth, policy, and unknown errors never
down-shift. Runtime state is atomic in .model-recovery.json; exhaustion is
fail-closed and held down. Change the declared chain/model and restart to
reconcile explicitly; no chain preserves detection-only behavior.
`;

/**
 * What every shipped spawn-skill variant must say, and must not say (7.1).
 *
 * The skills are separate markdown files in two published plugins, written for
 * two different harnesses, so they cannot literally be one file. This is the
 * source of truth they are all written from, and a test holds each variant to
 * it — including the CLI reference above, so a skill and \`ours-fleet docs\`
 * cannot name different permission settings.
 *
 * \`forbidden\` is the more important half. The old skills prescribed
 * \`--approval ask --filesystem workspace --unattended deny\` as a blanket
 * default while also telling the agent to stop at a failed doctor check — and
 * that combination is exactly what \`doctor\` FAILS, because \`ask\` grants an
 * unattended role nothing but \`read-state\` and \`deny\` makes the shortfall
 * fatal. Following the skill produced a role the CLI then refused.
 */
export const SPAWN_SKILL_CONTRACT = {
  /** Substrings every variant must contain (whitespace-normalised). */
  required: [
    // The installed reference is authoritative and must actually be read.
    'ours-fleet docs',
    'ours-fleet doctor',
    // Trap 1: a mode that suppresses the prompt without granting the action.
    'dontAsk',
    'bypassPermissions',
    // Trap 2: the floor, and the command that reports it before launch.
    'unattended capability floor',
    'unattended floor:',
    // The only intent that clears the floor, and the honest alternative.
    '--approval allow',
    '--unattended wait',
    // Creation-time isolation (6.3) — the one new operator input this release adds.
    '--isolation-file',
  ],
  /**
   * Substrings no variant may contain. Deliberately short: the real guard is
   * the acceptance test, which runs every spawn command a variant prints
   * through the same analysis `doctor` uses and fails if doctor would fail it.
   * This list only pins the specific claim that was wrong.
   */
  forbidden: [
    // The contradictory blanket default both variants used to prescribe.
    // `ask` grants an unattended role only `read-state`, and `deny` makes the
    // shortfall a doctor FAILURE — so the skill told you to build a role the
    // CLI then refused, in the same breath as telling you to trust doctor.
    '--approval ask --filesystem workspace --unattended deny',
    '[TODO:',
  ],
} as const;
