# Predefined Brains

`brain-catalog.json` is the source for generated `fleet/brains/*.yaml` files.
Run `node scripts/generate-brain-presets.mjs` after changing it, and run the same
command with `--check` to verify generated files. An empty `efforts` array generates
one `-default` preset with no `effort` field. Bootstrap adds missing presets and
preserves existing user files. Existing model presets remain available.

## Current model additions (verified 2026-09-24)

| Harness | Exact model ID | Preset efforts |
| --- | --- | --- |
| Codex | `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| Codex | `gpt-6-luna` | low, medium, high, xhigh, max |
| Claude Code | `claude-fable-5-1` | low, medium, high, xhigh, max |
| Claude Code | `claude-opus-5-5` | low, medium, high, xhigh, max |
| Claude Code (retained) | `claude-sonnet-5` | low, medium, high, xhigh, max |
| Claude Code | `claude-haiku-4-5-20251001` | default, with no effort setting |

For example, select `codex-gpt-6-sol-ultra`, `claude-opus-5-5-max`, or
`claude-haiku-4-5-20251001-default` as a Brain reference. The init wizard offers
models supporting its Quick/Balanced/Thorough (low/medium/high) choices; use the
named Brain directly for Haiku, which does not support effort.

### Runtime requirements and evidence

Codex CLI **0.155.0** freshly queried through `app-server` `initialize` then
`model/list` advertised the GPT rows above. A previously populated
`~/.codex/models_cache.json` did not contain these models; refresh runtime discovery
before concluding a model is unavailable. `ours-fleet doctor` compares presets to
the local cache. The catalog is not an account entitlement guarantee.

The [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) and
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) API model pages
also support `none`, but the verified Codex runtime does not advertise it.
Consequently there are no `none` presets. Sol's `ultra` is an advertised Codex
harness mode, not an additional API reasoning level; Luna does not advertise it.

Claude Code **2.1.281** was verified using the Agent SDK `supportedModels()`
control request, with `pathToClaudeCodeExecutable` pointing to the installed
Claude CLI, without sending an inference prompt. It reports Fable 5.1, Opus 5.5,
Sonnet 5 and Haiku 4.5 with the capabilities above. These are verified versions,
not asserted minimum versions. Provider references:
[model IDs](https://platform.claude.com/docs/en/models/overview) and
[Claude Code effort support](https://code.claude.com/docs/en/model-config#adjust-effort-level).

**Check the executable used by ACP before selecting the new Claude presets.**
The inspected `claude-agent-acp` **0.63.0** installation bundles Agent SDK
**0.3.220**, whose default executable reports older models. To use the verified
installed Claude CLI, set `CLAUDE_CODE_EXECUTABLE` to its absolute path in the
launch environment (for example `/usr/bin/claude` on the verification host).
Otherwise use a bundled SDK whose runtime advertises these models and efforts.
The presets do not change your executable or restart agents. An older bundled
runtime alone is not evidence of support for the new models.

No-prompt ACP startup and `session/set_config_option` probes also verified all
new GPT and Claude effort combinations, including Sol `ultra` and Claude `max`;
Haiku startup advertises no effort option. The probes used Codex ACP 1.10.0
with the installed Codex executable and Claude ACP 0.63.0 with the native override.

ACP builds effort options from the selected model's `supportedEffortLevels` and
applies the selection through the SDK's session flag settings. This supports
`max` without writing it to persistent `effortLevel` settings. Fleet verifies
that ACP applied the requested effort and fails on rejection. `ultracode` is a
separate Claude orchestration setting and is not a model effort preset. Account
and organization restrictions still apply at launch; no fallback model is added.
