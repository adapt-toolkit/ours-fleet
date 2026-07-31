# Security Policy

ours.network is security software. We take vulnerability reports seriously and we appreciate the work of security researchers.

## Disclaimer

ours.network is early, alpha-stage software. It has **not** been independently security-audited. It is provided **"as is", without warranty of any kind**, and you use it **at your own risk**. See the [LICENSE](./LICENSE) for the full warranty disclaimer. Reporting a vulnerability under this policy does not create any warranty or liability on our part.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately to: **security@adaptframework.solutions**

Please include: a description of the issue, steps to reproduce or proof of concept, affected component and version, and any suggested remediation. We accept reports in English.

## What to expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** (validity and severity) within 14 days.
- **Remediation targets:** critical issues as fast as humanly possible; high severity within 30 days; medium/low within 90 days. We will keep you informed of progress.
- **Credit:** we will credit reporters in the advisory unless you ask otherwise.

We do not currently operate a paid bug bounty programme.

## Disclosure

We follow coordinated disclosure. We ask that you give us a reasonable opportunity to remediate before public disclosure; we will not take legal action against good-faith security research conducted within this policy's scope.

Advisories are published via GitHub Security Advisories on the affected repository, with fixed versions noted.

## Scope

In scope: the ours.network daemon, relay/broker, SDKs, and Claude Code plugin as published in our official repositories.

Out of scope: third-party dependencies (report upstream — though we'd appreciate a heads-up), social engineering, denial of service against our infrastructure, and issues in forks or modified versions.

## Threat model

Our published threat model (see `docs/threat-model.md`) states precisely what ours.network protects against and what it does not — including the explicit limitation that the relay, while unable to read message content, can observe delivery metadata. Claims in reports should be assessed against that model.

## Agent isolation (sandboxing)

ours-fleet spawns long-running AI coding agents. Without isolation, every agent runs
with the **full privileges of the `fleet` user** — it can read `~/.ssh`, `~/.aws`, the
Claude credentials, *every other agent's* state directory, and the ours identity key
store, with unrestricted network and unbounded CPU/memory. The optional per-role
`isolation:` block (see the README) reduces what a single misbehaving, prompt-injected,
or compromised agent can reach.

**Trust boundary.** The `fleet` user and the ours daemon are trusted; a spawned agent is
**not** fully trusted. Isolation is an OS backstop *underneath* the harness's own
permission system, not a replacement for it.

**Enforcement.** Each agent's process is wrapped in **bubblewrap** — rootless (unprivileged
user namespaces, no setuid), an explicit allowlist mount model (only the state dir, `cwd`,
harness config, and declared `fs`/`secrets` are visible; everything else on the host is
absent) — and resource-limited by `systemd-run --user --scope` (real cgroup-v2
`MemoryMax`+`MemorySwapMax=0`, `CPUQuota`, `TasksMax`).

**The forbidden-path list is enforced, not advisory.** A role that asks for a sensitive
path — in `fs.read`/`fs.write`, in `secrets`, or via a Codex `add_dirs` entry — is refused
before launch. Four shapes are refused: the exact path, anything inside it, any *parent*
that would expose it (binding `$HOME` does not name `~/.ssh`, but shares it just as
completely), and symlink aliases, since paths are canonicalised through the filesystem
first. Both the source and the destination of a mount are checked. `ours-fleet config` and
`ours-fleet doctor` report the refusal by role and path.

**Credential and configuration boundary.** Inside the sandbox an agent has a **per-role
writable harness home**, kept under its own state directory, so its sessions, history and
caches belong to it alone and are invisible to its peers. Layered read-only on top are the
**shared** credentials, global instructions and configuration — `~/.claude.json` and
`~/.claude/CLAUDE.md`, `settings.json`, `plugins/`; `~/.codex/auth.json`, `config.toml`,
`AGENTS.md`, `plugins/`, and `~/.agents`. An agent can therefore *read* the credentials it
needs to work and **cannot** rewrite them, cannot edit the instructions every role shares,
and cannot alter a peer's configuration. Claude pre-trust remains a host-side step
performed by the fleet, not something the agent can do for itself.

| Level | Config | Guarantees | Does **not** stop |
|---|---|---|---|
| L0 none | *(no block)* | — | anything: full `fleet`-user access |
| L1 fs-confined | `isolation: {}` | can't read `~/.ssh`/`~/.aws`, the ours key store, or sibling agents' state; can't modify shared harness credentials, global instructions or peer config; writes limited to state dir + `cwd` + its own harness runtime home; messaging still works | CPU/mem exhaustion; kernel escape |
| L2 + resources | `+ resources:` | L1 + bounded CPU/mem/pids (no fork-bomb / noisy-neighbor DoS of the host) | kernel escape |
| L3 + net policy | `+ network: deny` | L2 + no arbitrary network egress | covert channels via the allowed broker |

**Rootless prerequisites.** Unprivileged user namespaces must be enabled (stock Ubuntu
permits bubblewrap via its shipped AppArmor profile). `MemoryMax`/`TasksMax` are enforced
out of the box; the **cpu** controller may need a one-time `Delegate=cpu` (surfaced by
`ours-fleet doctor`, never auto-`sudo`'d) — absent it, `cpu:` caps degrade to a warning
while mem/pids stay enforced. No per-spawn root is ever required.

**Fallback policy.** `on_unavailable: warn` (default) is fail-open: if no backend is
available the role runs un-isolated, logs a prominent warning, and drops a
`.isolation-degraded` marker in its state dir. `on_unavailable: strict` is fail-closed:
the role refuses to launch. High-autonomy roles (e.g. `permission_mode: bypassPermissions`)
SHOULD carry a tight `isolation:` block.

**Residual risks (stated honestly).** Shared-kernel isolation — a kernel-level
sandbox-escape defeats it (no microVM/hypervisor boundary in this phase). The ours
**broker is its own trust boundary**: isolation confines *who can reach* it, but
per-identity broker authentication is the ours daemon's responsibility. The default
`network: broker` currently keeps host networking so the loopback ours daemon stays
reachable; full broker egress-hardening (deny all IP egress except the broker via a
forwarder) is a planned follow-up.
