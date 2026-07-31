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
\`\`\`

\`peek\`, \`attach\`, and text \`send\` work with tmux and ACP. ACP attachment
also accepts \`/permit <permission-id> <option-id>\`, \`/interrupt\`, and
\`/detach\`. Raw \`--key\` input is tmux-only.

## Spawn

\`\`\`sh
ours-fleet spawn [--temp] Name \\
  --harness codex|claude-code --session tmux|acp \\
  --mission "one line" --cwd /absolute/path --identity Identity \\
  --coordinator Coordinator --model MODEL \\
  --approval ask|allow|deny \\
  --filesystem read-only|workspace|unrestricted \\
  --unattended deny|wait \\
  --bio-file /path/bio.md --persona-file /path/persona.md
\`\`\`

Permanent spawn writes \`~/fleet.d/Name.yaml\` and starts a supervised role.
\`--temp\` writes ephemeral state, starts a detached supervisor, and removes the
role after exit/reboot. Both lifetimes support \`--session acp\`.

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
\`\`\`

Role values override defaults. \`\${name}\` substitutes entries from \`vars\`.
Other role fields include \`max_tokens\`, \`autocompact_pct\`, and \`isolation\`.
Use README.md for the complete isolation policy and resource-cap schema.

## Permissions

Prefer the harness-neutral \`permissions\` block:

- \`approval: ask|allow|deny\`: whether actions may request or receive approval
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

Security meaning: \`approval: allow\` maps to Claude's \`bypassPermissions\`,
which genuinely permits the actions the role was authorized to take —
\`dontAsk\` only suppresses the prompt while still refusing the action. Nothing
other than an explicit \`allow\` is elevated: \`ask\` stays on Claude's default
mode and \`deny\` maps to \`plan\`. \`allow\` is therefore a real grant and
requires explicit authorization; per-role \`isolation:\` remains the outer
boundary that a permission mode cannot cross.

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

Legacy \`monitor.enabled: true|false\` remains accepted as an alias for
\`mode: fleet|native\`; use \`mode\` in new configuration. Codex's separate
\`harness_options.monitor: true\` is native-monitor consent, not monitor-owner
selection.
Inspect \`ours-fleet status Name\`, \`peek Name\`, role logs, and
\`~/.ours-fleet/agents/Name/.monitor-status\` when diagnosing delivery.

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
