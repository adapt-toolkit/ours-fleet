# Models, efforts and Brains

`brain-catalog.json` is the model catalog maintained with the Claude Code and
Codex harness adapters: each exact model ID, its label, and the efforts it
supports (an empty `efforts` list means the model has no effort setting). The
adapters expose it through `modelCapabilities()`, and Fleet serves it, narrowed
to the models the active Codex account offers, at `GET /api/v1/harness-capabilities`.
Onboarding, Settings and agent launch flows use that one source. Hermes models
come from the provider configured in the role home, so Hermes lists none and
sets no effort.

Setup no longer installs a Brain per model and effort. It creates three
editable purpose Brains from the choices made during setup:

| Brain | Used by |
| --- | --- |
| `development` | Developer, Engineer |
| `critic` | Critic |
| `coordination` | LocalCoordinator, FleetCoordinator |

Users change these or add more in Settings > Brains. An agent can also be
launched with a one-off harness, model and effort; that choice is kept with the
agent and saves no Brain.

Existing installations keep every Brain file and reference. The values of the
Brain presets earlier releases generated per model and effort are frozen in
`legacy/generated-brains-rev4.json`; configuration provenance reports an
untouched one as `legacy` and an edited one as `changed`. Nothing deletes them.
`fleet/brains/claude-default.yaml` (the Claude Code default model) still ships
for packaged templates and existing references; setup does not install it.

## GPT-6.1 Sol (added 2026-09-29)

The Codex catalog entry uses the exact model ID `gpt-6.1-sol` with ACP sessions. The init wizard offers
GPT-6.1 Sol for development, review, and coordination.

[Official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
supports low, medium, high, xhigh, and max API reasoning efforts. The local
Codex `models_cache.json` inspected on 2026-09-29 additionally advertises
`ultra`, a Codex harness mode. The catalog reflects that six-effort Codex
catalog; no inference or ACP launch was performed for this addition.

## Current model additions (verified 2026-09-24)

| Harness | Exact model ID | Efforts |
| --- | --- | --- |
| Codex | `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| Codex | `gpt-6-luna` | low, medium, high, xhigh, max |
| Claude Code | `claude-fable-5-1` | low, medium, high, xhigh, max |
| Claude Code | `claude-opus-5-5` | low, medium, high, xhigh, max |
| Claude Code (retained) | `claude-sonnet-5` | low, medium, high, xhigh, max |
| Claude Code | `claude-haiku-4-5-20251001` | default, with no effort setting |

Setup asks for an effort only among the efforts a model supports; Haiku gets
none.

### Runtime requirements and evidence

Codex CLI **0.155.0** freshly queried through `app-server` `initialize` then
`model/list` advertised the GPT rows above. A previously populated
`~/.codex/models_cache.json` did not contain these models; refresh runtime discovery
before concluding a model is unavailable. `ours-fleet doctor` compares configured Codex Brains to
the local cache. The catalog is not an account entitlement guarantee.

The [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) and
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) API model pages
also support `none`, but the verified Codex runtime does not advertise it.
Consequently the catalog lists no `none` effort. Sol's `ultra` is an advertised Codex
harness mode, not an additional API reasoning level; Luna does not advertise it.

Claude Code **2.1.281** was verified using the Agent SDK `supportedModels()`
control request, with `pathToClaudeCodeExecutable` pointing to the installed
Claude CLI, without sending an inference prompt. It reports Fable 5.1, Opus 5.5,
Sonnet 5 and Haiku 4.5 with the capabilities above. These are verified versions,
not asserted minimum versions. Provider references:
[model IDs](https://platform.claude.com/docs/en/models/overview) and
[Claude Code effort support](https://code.claude.com/docs/en/model-config#adjust-effort-level).

**Check the executable used by ACP before selecting the new Claude models.**
The inspected `claude-agent-acp` **0.63.0** installation bundles Agent SDK
**0.3.220**, whose default executable reports older models. To use the verified
installed Claude CLI, set `CLAUDE_CODE_EXECUTABLE` to its absolute path in the
launch environment (for example `/usr/bin/claude` on the verification host).
Otherwise use a bundled SDK whose runtime advertises these models and efforts.
The catalog does not change your executable or restart agents. An older bundled
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
