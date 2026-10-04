# Managed Fleet CLI from Codex and Claude Code workspace sandboxes

> **Use the generated setup.** Since `managed-cli.setup-v1`, Fleet prepares the
> native policy for the packaged task workflow itself. The hand-written rules
> further down remain as background and for operations outside that workflow
> (for example `room delete`).

## Fleet-generated setup (issue #233)

Declare the workflow on the Agent, or let Fleet add the one key for you:

```sh
ours-fleet managed-cli setup --enable FleetCoordinator   # adds managed_cli: [task-workflow]
ours-fleet managed-cli setup                             # generate / reconcile, starts nothing
ours-fleet managed-cli status                            # compare only, exit 1 when not current
```

The declaration is explicit configuration. It is never inferred from a role or
display name, and `--enable` changes no permission. The same preparation runs at
every agent start (`up`, `restart`, `spawn`, task-room agents), so newly created
agents need no separate step. `ours-install` runs `managed-cli setup` from the
exact Fleet it installed after `init` and on update.

An agent invokes a prepared command through the pinned entry form printed in its
briefing:

```sh
/abs/node /abs/fleet/dist/cli.js --managed-configuration /abs/fleet.yaml task create --title "..." --backlog --no-room
```

### What is prepared

| Prepared (runs outside the command sandbox) | Not prepared (stays sandboxed) |
| --- | --- |
| `task create`, `task start`, `task finish`, `task block`, `task unblock`, `task review`, `task list`, `task show` | `task cancel`, `task delete` |
| `room show`, `room members` | `room create`, `room delete`, `room close` |
| `template list`, `template show`, `template validate`, `config`, `docs` | `spawn`, `ours tools`, `ours call`, `status`, `peek`, `send` |
| `--help`, `task --help`, `room --help`, `template --help` | service administration, identity and contact commands, oversight |

`task start` and `task finish` provision and retire rooms and agents. That is
real authority, and it is disclosed by `setup`, `status` and the installer.

### Actual invocation boundary

- The native rule fixes four things: the Node executable, this Fleet CLI, the
  pinned configuration and the command words. It is an argv **prefix** and admits
  every trailing option and argument. It is not argument validation, target
  authorization or per-agent isolation.
- A later `-c`/`--configuration` naming another file is refused by the Fleet CLI
  after the process has already started outside the sandbox and been audited.
  That is Fleet runtime validation, not a native policy denial.
- The pinned form requires a managed session. Outside one, where no supervisor
  would audit it, the CLI refuses it. Commands outside the inventory are refused
  by the CLI even if a hand-written rule would admit them.
- The supervisor audit, CLI validation, confirmations, SDK credential checks and
  any outer container or host sandbox are unchanged. There is no blanket
  Node/Bash/Fleet grant, no sandbox is disabled, and no new transport exists.
- Compound (`&&`, `;`), piped, redirected, `$(...)`, backslash-escaped and
  `VAR=value`-prefixed command lines do not match and stay sandboxed.

### Quoting, measured natively

Measured with real Codex 0.160.0 and Claude Code 2.1.289 on Linux:

| Spelling | Codex | Claude |
| --- | --- | --- |
| Single-quoted CLI / configuration path or option value containing spaces | matches | matches |
| Double-quoted later token | matches | does not match |
| Quoted **executable** token | never matches | never matches |
| Unquoted symlinked executable | matches | matches |

Fleet therefore spells a CLI or configuration path containing spaces in single
quotes (Codex >= 0.160.0 required; older or unreadable versions are reported as
unsupported for such paths), and requires the Node executable at a path needing
no quoting. A path containing anything but letters, digits, spaces and
`_@%+=:,./-` (so no quotes, backslashes, `*` or other pattern characters, which
Claude's entries would not treat literally), or one that is or resolves
inside the agent's workspace, is reported as unsupported rather than widened.

### What is written, and ownership

- **Codex**: `<workspace>/.codex/rules/ours-fleet-<id>.rules`, one file per Fleet
  configuration, carrying a Fleet marker header. It applies to every trusted
  Codex session in that workspace, not to one identity, and Codex must already
  trust the workspace: Fleet reports missing trust and never changes it. A file
  shared by several agents is held in `~/.ours-fleet/managed-cli/registry.json`
  and removed only when its last holder is gone. Files without the Fleet marker,
  including a hand-written `ours-fleet.rules`, are never modified; one occupying
  the generated name is reported as a conflict.
- **Claude**: `permissions.allow` and `sandbox.excludedCommands` entries in the
  agent's own Fleet settings overlay, delivered to the bundled ACP adapter. The
  operator's Claude settings are not modified. Fleet never sets
  `sandbox.enabled`; if no readable settings file enables the OS sandbox, or a
  `deny` rule would override the entries, `status` and `doctor` say so.
- Setup is idempotent. Changed Node/CLI/configuration paths rewrite the Fleet
  entries; entries for agents or configurations that no longer exist are removed
  and listed.

### Diagnostics

`ours-fleet doctor` and `managed-cli status` report three separate facts:

| Row | Source | Meaning |
| --- | --- | --- |
| setup | generated files compared with this installation | static configuration only |
| session | the role's launch record | whether the last start loaded the current policy, or a restart is required |
| observed | the supervisor audit ledger | which pinned forms actually completed since that start |

A prepared setup is not evidence of supervisor access. An observed `--help`
proves only its own audited path; lifecycle forms that were never observed are
listed as such. `task create --help` is reported as `task create --help`, a help
call, not as `task create`. Rows from before the current launch are reported as
historical. The ledger stores the pinned configuration as a fingerprint, never
as its path; a row pinned to another configuration, or to none that can be told,
is counted separately and is not evidence for this policy. Rows whose content
was erased with their task or room keep what they prove.

A launch also gives up what the role held before: opting out, losing support or
moving to another workspace or configuration removes that role's Codex rules at
the next start, without touching a file another agent still holds.

### Unsupported combinations

Reported, with the reason, and left exactly as sandboxed as before: Windows and
other platforms; Hermes and other harnesses; custom ACP or app-server session
commands; roles declaring `isolation:`; unspellable paths; a Node path needing
quotes; Codex older than 0.160.0 with quoted paths; and any pinned file the
agent could replace — inside its workspace or a `harness_options.add_dirs`
directory, lexically or through a symlink. Codex roles with
`harness_options.config` or `harness_options.profile` are unsupported too:
those change the native sandbox (for example extra writable roots) in ways Fleet
does not inspect. Native user settings Fleet cannot read are outside this check.

### Qualification

`test/managed-cli-workflow.integration.mjs` runs real Codex / Claude Code through
Fleet's own adapters and launch preparation against a real supervisor control
server and audit ledger. A scripted local provider only requests commands; no
external model, account, production identity or room is used.

```sh
FLEET_TEST_HARNESS=codex FLEET_CODEX_BIN=/absolute/codex FLEET_TEST_SESSION=codex-app-server \
FLEET_TEST_TMP_PREFIX=/absolute/private-test-parent/fleet-mc- \
node test/managed-cli-workflow.integration.mjs
```

Use `FLEET_TEST_SESSION=acp` for bundled Codex ACP, and
`FLEET_TEST_HARNESS=claude FLEET_CLAUDE_BIN=/absolute/claude` for bundled Claude
ACP. `FLEET_TEST_QUOTED=1` installs the CLI and configuration under paths
containing spaces. `FLEET_TEST_CLAUDE_SANDBOX=0` checks the diagnostics when the
operator has not enabled Claude's sandbox. `FLEET_TEST_NESTED_SANDBOX=1` is for
unprivileged containers only. `FLEET_TEST_EVIDENCE=/file.json` records every
command, exit code and output.

Each run checks: unpinned `--help` denied at the socket; an unrelated write
outside the workspace still denied by the OS; pinned help; `task create` with
quoted variable options, `task list|show|block|unblock`, template and plan
inspection completing with audit rows; `task review|start|finish` and
`room show|members` reaching the supervisor and Fleet validation (their
successful run is the lifecycle fixture below); `template show|validate` and
`docs`; a late
`--configuration` refused by Fleet; unprepared commands, a missing or different
pin, preload injection, chaining and redirection staying sandboxed; and `status`
listing exactly the forms the audit ledger observed.

`test/managed-cli-lifecycle.integration.mjs` is the full stack: the real role
runner (`ours-fleet _run`) launches the Coordinator, with a real local ours
daemon and Cowork service (`FLEET_COWORK_CLI=/abs/cowork/dist/cli.js`). From
inside the command sandbox the Coordinator's session creates a task, starts it —
a Cowork room is provisioned and a room member agent is really spawned through
the supervisor — runs `task show`, `room show`, `room members`, `task block`,
`task unblock`, `task review` and `task finish`, which retires the member and
the room. Every command is typed in the pinned form and must have a successful
audit row; the task must end `done`. `FLEET_TEST_HARNESS=claude` puts the
Coordinator on bundled Claude ACP with its OS sandbox enabled (the member stays
on Codex). Only the model provider is scripted; the daemon runs without a broker.

Two outcomes of that run are Fleet's existing lifecycle behaviour, not policy,
and are recorded rather than hidden: the first `task start` can answer
"readiness is unknown" while the member's session is still starting, and the
first `task finish` can report that the member's live state disappeared while it
is still stopping. In both cases the task is already durably in the right state
and re-running the same command, as its message says, succeeds.

Linux x86_64 host (kernel 7.0, Node 22.23.1, Codex 0.160.0, Claude Code 2.1.289):

| Harness / session | Plain paths | Paths with spaces |
| --- | --- | --- |
| Codex native app-server | PASS | PASS |
| Bundled Codex ACP | PASS | PASS |
| Bundled Claude ACP, OS sandbox enabled | PASS | PASS |
| Bundled Claude ACP, OS sandbox not enabled (diagnostic) | PASS | not run |

| Full-stack lifecycle (real runner, room, spawned member) | Result |
| --- | --- |
| Codex native app-server Coordinator, Codex native member | PASS |
| Bundled Codex ACP Coordinator, Codex ACP member | PASS |
| Bundled Claude ACP Coordinator (OS sandbox enabled), Codex native member | PASS |

Across repeated runs the re-runs described above occurred zero or one time per
command; each run prints how many. The spawned member's Agent Template declares
`managed_cli` itself, and the run asserts what that member's own launch
prepared: a Codex native member gets its own record, rules in its own workspace
and a temporary holder; a Codex ACP member with `approval: allow` has no command
sandbox, so its launch records `not-required` and generates nothing. After
`task finish` the run asserts that the member's live state, Fleet's room record
and the Cowork room are gone, and that the member's rules were removed.

Not qualified, and not claimed:

- **macOS.** The generated setup has not been run there. `managed-cli status`
  discloses this on macOS. The mechanisms are the ones the hand-written policy
  below used on macOS, but that is not a run of this matrix.
- **Service-managed supervisors and a real model.** The lifecycle run starts
  the runner directly (`OURS_FLEET_SUPERVISOR=none`), not through systemd or
  launchd, uses a scripted provider, attaches no owner to the room and has no
  broker. The spawned member only starts and stops; it does no work.
- Paths with spaces in the full-stack lifecycle run (covered by the matrix
  above), Claude standalone, Hermes, Windows and isolated roles.

A managed Fleet CLI invocation sends `fleet_audit_begin` to the supervisor's Unix
socket before parsing commands, including `--help`. A socket that exists and is
owned by the current user can still return `connect EPERM` from a restricted
command sandbox. This is not evidence that the supervisor is down or Fleet needs
reinstallation. Check filesystem permissions too: `EACCES`/`EPERM` alone does not
identify which policy denied access.

## Background: hand-written native execution rules

Keep the role's `approval: auto`, `filesystem: workspace`, and `unattended: deny`.
For an operator authorized to manage rooms, explicitly approve the necessary CLI
operations using Codex's standard execution rules. A matching operation executes
outside Codex's command sandbox, retaining the normal CLI, supervisor audit,
configuration, credentials, and confirmation checks. Other shell commands remain
sandboxed. This does not override an outer container or host sandbox.

In the **trusted workspace** create `.codex/rules/ours-fleet.rules`, substituting
absolute paths to the installed Node binary, installed Fleet CLI, and approved
configuration. Example for an operator allowed to delete rooms in this Fleet:

```python
prefix_rule(
    pattern=["/opt/node/bin/node", "/opt/fleet/dist/cli.js", "room", "delete",
             "--configuration", "/srv/fleet/fleet.yaml", "--json", "--"],
    decision="allow",
)
```

Invoke exactly that prefix, followed by the room ID and the confirmation ID:

```sh
/opt/node/bin/node /opt/fleet/dist/cli.js room delete --configuration /srv/fleet/fleet.yaml --json -- ROOM_ID ROOM_ID
```

To authorize only one room, append both concrete IDs to the rule's pattern.
The `--` terminator prevents trailing arguments from changing the fixed options.
Do not approve the entire Node executable or the entire Fleet CLI. Do not add
`spawn`, `ours call`, arbitrary scripts, or configuration overrides to this rule.
A separate fixed `[NODE, CLI, "--help"]` rule can authorize managed help.

Restart the Codex session after changing rules. Native Fleet and bundled Codex ACP
use the same workspace rules. Codex must trust that workspace; configure trust
through the normal operator workflow rather than enabling it from an agent tool.
No runtime services or installed packages need restarting for this policy change.

## Boundaries

- A rule grants the named operation real authority. The repeated room ID is CLI
  confirmation, not a substitute for user authorization.
- Rules apply to trusted Codex sessions in this workspace, not exclusively to one
  Fleet identity. They depend on the launcher's inherited environment. Keep the
  executable, CLI installation, credentials, and configuration outside the
  agent-writable workspace. Do not treat this as an identity isolation feature.
- User/organization denied-read rules or an outer sandbox may forbid execution
  outside the command sandbox. These restrictions take precedence; do not remove
  them implicitly to make Fleet work.
- On tested Codex 0.159.0, quoting the executable/script tokens prevented the rule
  from granting execution outside the sandbox. For hand-written rules use the
  canonical simple-token invocation above. The generated setup qualifies quoted
  script and argument paths on Codex 0.160.0; see "Quoting, measured natively".
- Merely enabling network inside the Linux command sandbox was insufficient:
  its user namespace maps ancestor directory owners to UID 65534, which the SDK's
  strict credential ancestry checks reject. Approved CLI execution avoids that
  namespace; SDK security checks remain unchanged.

## Reproduction and regression checks

The [issue author’s validation matrix](https://github.com/adapt-toolkit/ours-fleet/issues/231)
used Codex 0.159.0 on macOS/Linux, native and ACP. Those results are not new runs
on every revision of this fixture. Build Fleet and supply the complete installed
Codex distribution (including its adjacent helper binaries) and a built Cowork CLI.
Run from the Fleet repo:

```sh
FLEET_CODEX_BIN=/absolute/codex \
FLEET_COWORK_CLI=/absolute/cowork/dist/cli.js \
FLEET_TEST_SESSION=codex-app-server \
FLEET_TEST_TMP_PREFIX=/absolute/private-test-parent/fleet-ipc- \
node test/fleet-cli-permissions.integration.mjs
```

Repeat with `FLEET_TEST_SESSION=acp`. The test parent must be writable, outside
`/tmp` and outside the tested workspace: ACP may allow `/tmp` independently.
Omit `FLEET_TEST_SESSION` to test standalone `codex exec`.

The local scripted Responses provider supplies only command requests. Real Codex,
Fleet adapters, CLI, control socket, audit store, daemon, and Cowork perform the
operations. No external model or production identities/rooms are used. Child processes are stopped and temporary state is removed afterward. To retain
fixture evidence, set `FLEET_TEST_KEEP_ARTIFACTS=1`. The fixture allowlists its
launcher environment and uses a disposable HOME; no provider keys, preloads, or
user configuration are inherited.

Checks: baseline network-denied `--help`; permitted help; wrong confirmation
leaves the room intact; correct confirmation deletes the actual empty test room
from Fleet and Cowork; caller audit remains present; unrelated outside-workspace
write, `NODE_OPTIONS` injection, and a different configuration remain denied.
The fixture uses `OURS_FLEET_SUPERVISOR=none`: launchctl/systemd workers and deletion
of a live room containing agents are outside this test's coverage.

Reference: [Codex execution rules](https://learn.chatgpt.com/docs/agent-configuration/rules).

## Claude Code: the same CLI path, different permission settings

The issue author verified Claude Code 2.1.284 on macOS and Linux, both standalone and through
Fleet's bundled Claude ACP adapter (0.63.0). Fleet `approval: auto` maps to
`acceptEdits`, which is not blanket permission for Bash. Fleet's `filesystem:
workspace` also does not by itself enable Claude's OS sandbox. Explicitly enable
it and configure both the execution exclusion and the command permission:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [
      "/opt/node/bin/node /opt/fleet/dist/cli.js room delete --configuration /srv/fleet/fleet.yaml --json -- *"
    ]
  },
  "permissions": {
    "allow": [
      "Bash(/opt/node/bin/node /opt/fleet/dist/cli.js room delete --configuration /srv/fleet/fleet.yaml --json -- *)"
    ]
  }
}
```

Use operator-controlled Claude settings. The fixture uses an isolated settings
file delivered with `--settings` (standalone) or Fleet's supported settings overlay
metadata (bundled ACP). It does not modify the user's settings. As with the Codex
rule, append exact room IDs instead of `*` to restrict this to one room.

`excludedCommands` controls placement outside the command sandbox;
`permissions.allow` authorizes the action. Neither should be replaced with global
`bypassPermissions`, blanket `Bash(*)`, or an exception for all Node programs.
An external sandbox or managed policy can still override this configuration.

Linux inside an unprivileged Docker container additionally needed
`sandbox.enableWeakerNestedSandbox: true`: otherwise bubblewrap failed to mount
`/proc` before any CLI command ran. This documented setting bind-mounts the
container's existing `/proc`, weakening that part of the nested isolation. It is
specific to the nested test environment, not an unconditional Linux requirement.
The tests still prove Unix-socket denial and filesystem write denial. The outer
Docker seccomp profile was unconfined to support nesting, as in the Codex tests.

Run the same integration scenario with:

```sh
FLEET_CLAUDE_BIN=/absolute/claude \
FLEET_COWORK_CLI=/absolute/cowork/dist/cli.js \
FLEET_TEST_TMP_PREFIX=/absolute/private-test-parent/fleet-claude- \
FLEET_TEST_SESSION=claude-acp \
node test/fleet-cli-permissions.integration.mjs
```

Omit `FLEET_TEST_SESSION` for standalone Claude. In the nested Linux fixture add
`FLEET_TEST_NESTED_SANDBOX=1` explicitly. A scripted local Anthropic Messages/SSE
provider requests the real Bash call and captures the actual tool result. The
negative baseline grants Bash permission without an exclusion and verifies that
the supervisor socket is still blocked. The write probe is separately authorized
inside the sandbox; it must execute and report an OS denial, not merely fail an
approval prompt. No real model/account credentials are used.

All other limits above apply: empty room, isolated audit/control server,
`supervisor=none` workers, and adapter coverage rather than full production runner.

Reference: [Claude sandbox exclusions and permissions](https://code.claude.com/docs/en/sandboxing#run-commands-outside-the-sandbox-with-excludedcommands).


## Port validation for issue #231

The separate upstream port was rerun on Linux amd64 in a disposable Node 22.23.1
container with Codex 0.160.0 and Claude Code 2.1.289:

| Harness execution | Result |
| --- | --- |
| Codex native app-server | PASS |
| Bundled Codex ACP | PASS |
| Claude standalone | PASS |
| Bundled Claude ACP | PASS |

Each complete run checks actual socket denial, permitted help, wrong-confirmation
refusal, deletion of its own empty Fleet/Cowork room, preserved caller audit, and
OS denial of an unrelated write, preload injection, and alternate configuration.
The scripted providers and all state are local; external network access is disabled.
For these nested tests only, the outer Docker seccomp and AppArmor profiles were
unconfined and Claude used `enableWeakerNestedSandbox: true`. No host policies or
production services were changed. The inner command sandbox remains enforced by
the negative checks. These are container results, not a qualification of normal
host settings. Initial missing-helper and outer-policy failures were retained
alongside the passing runs; they are not counted as passing tests.

The port also passed 88 diagnostic/conversation/audit unit checks, a build, and an
npm package dry-run check for this document. The diagnostic preserves the prior
error kinds and audited CLI failure before parsing. This does not claim a fresh
macOS run, full production runner coverage, or live-agent room deletion.
