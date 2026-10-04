# Managed Fleet CLI from Codex and Claude Code workspace sandboxes

A managed Fleet CLI invocation sends `fleet_audit_begin` to the supervisor's Unix
socket before parsing commands, including `--help`. A socket that exists and is
owned by the current user can still return `connect EPERM` from a restricted
command sandbox. This is not evidence that the supervisor is down or Fleet needs
reinstallation. Check filesystem permissions too: `EACCES`/`EPERM` alone does not
identify which policy denied access.

## Use native execution rules, without a new transport

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
  from granting execution outside the sandbox. Use the canonical simple-token
  invocation above. Paths needing shell quoting have not been qualified.
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
