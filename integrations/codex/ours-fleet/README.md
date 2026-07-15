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
Mail wake is consent-first: a spawned role receives `--monitor` only when the
user explicitly requests it. `ours-codex` supplies background wake; native
`codex` remains the supported foreground-monitor fallback.
