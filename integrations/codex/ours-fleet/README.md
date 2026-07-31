# @ours.network/fleet-codex

Native OpenAI Codex plugin for `ours-fleet`. It adds skills for creating Codex
fleet roles and overseeing agents in their tmux consoles. The
`@ours.network/fleet` CLI performs the actual lifecycle operations.

## Install

```sh
npm install --global @ours.network/fleet-codex
ours-fleet-codex-install
```

The installer ensures `@ours.network/fleet`, `@ours.network/codex`, and the
native `ours` and `ours-fleet` Codex plugins are installed. Start a new Codex
session after installation so it discovers the skills.

Then ask Codex to “spawn an ours agent”, “create a persistent Codex role”, or
“keep an eye on my fleet agents”.

Codex may ask for one-time authorization before individual ours MCP tools run.
Native Codex mail wake is consent-first: a spawned role receives the legacy
`--monitor` consent flag only when the user explicitly requests it.
In fleet YAML, `monitor.mode: fleet|native` separately chooses whether
ours-fleet or the harness owns wake delivery. `ours-codex` supplies native
background wake; plain `codex` remains the supported native foreground fallback.
