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
\`--add-dir\`, and \`--monitor\`. Run \`ours-fleet help spawn\` for exact values.

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
    enabled: true
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
      enabled: true
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

The supervisor monitor is enabled by default. It consumes body-free daemon
events and advances its durable cursor only after delivery is accepted. ACP uses
a structured \`session/prompt\`; tmux uses verified console injection. Message
bodies are released only when the role calls the ours \`get_messages\` tool.

Set \`monitor.enabled: false\` only to retain legacy in-session monitoring.
Inspect \`ours-fleet status Name\`, \`peek Name\`, role logs, and
\`~/.ours-fleet/agents/Name/.monitor-status\` when diagnosing delivery.
`;
