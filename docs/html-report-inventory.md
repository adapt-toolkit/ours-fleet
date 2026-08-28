# Fleet HTML report inventory

HTML reports are finished, passive, self-contained files. They preserve existing text and JSON output and never add controls, forms, scripts, remote assets, mutation links, prompts, consoles, or raw payloads.

## Included report kinds

Implementation status: the task list/lists slice is signed off and task show is implemented under review. The remaining rows are the audited target inventory, not a claim that their adapters or presenters are complete yet.

| Surface | Commands/resources | Report kind | Safe content |
|---|---|---|---|
| Tasks (list/lists signed off; show under review) | `task list`, `task lists`, `task show`; REST task/list reads; Messenger `/tasks`, `/task list`, `/task lists`, `/task show` | `tasks`, `task-lists`, `task` | IDs, list, title, lifecycle, blocker, template/room references, timestamps, terminal outcome, bounded member roles and safe orchestration readiness |
| Rooms | `room list`, `room show`, `room members`; corresponding REST/Messenger reads | `rooms`, `room`, `room-members` | IDs/names, lifecycle, task/template linkage, roles, seat state, readiness, bounded safe orchestration metadata |
| Agents | `ls`, `status`; REST roles/detail; Messenger `/ls`, `/status` | `agents`, `agent-status` | Role, harness, lifecycle/readiness, safe activity/restart/model state; values are allowlisted rather than copied from `RoleStatus` |
| Templates | `template list/show/validate`; Messenger list/show | `templates`, `template`, `template-validation` | Name/version/description, contract, room policy, member slots, content hash, validation issues |
| Loops | `loops list/status/validate` | `loops`, `loop-status`, `loop-validation` | Redacted definitions and bounded state/health; expanded ACP targets and prompt material stay excluded |
| Watchdog | `watchdog-report` single/latest/list | `watchdog`, `watchdog-runs` | Safe summary, bounded role findings and internal artifact anchors; raw evidence payloads/errors/logs stay excluded |
| Host | `version`, `config`, `doctor` | `version`, `config`, `doctor` | Existing versioned, secret-safe contracts and categorized diagnostics only |
| Manual | `docs` | `manual` | Static bundled manual through the same view-model/renderer pipeline; no runtime coupling |
| Aggregate | explicit overview command/endpoint/message | `overview` | Only resources visible through the caller's capability-scoped provider, with per-source observation/unavailable/stale labels |

## Intentionally excluded reads

| Surface | Disposition |
|---|---|
| `attach`, `peek`, `logs`; REST output/log/conversation; terminal WebSocket | Excluded: consoles, prompts, message bodies and raw logs are prohibited report content. |
| `owner-channel contact list`, owner authorization list | Excluded: identity/contact/authentication material is not a Fleet operational report and risks authorization disclosure. |
| Owner-channel task receipts/updates, REST action and creation receipts | Excluded in this task: transactional receipts are not navigable reports; a future generic safe receipt renderer may cover already-authorized results. |
| Audit/event feeds | Excluded: may contain operational/request correlation detail and are streaming rather than deterministic snapshots. |
| Configuration editor model/raw YAML, topology draft | Excluded: editable/raw configuration can contain paths or sensitive fields. The allowlisted `config` health report is included. |
| Topology, creation capabilities, removal preview | Excluded: console planning/control surfaces are not read-only Fleet status documents; removal preview is mutation-adjacent. |
| Web service status, help, comments status, model status | Excluded as standalone reports because they are small scalar/help receipts; relevant safe health fields may appear in agent/doctor/manual reports. |
| `room open` | Excluded: it exposes a host-local console URL and is an execution/navigation surface. |

## Mutation inventory

All create/start/work/block/unblock/review/done/finish/cancel/delete/move/rename/recover/up/down/restart/force-restart/spawn/remove/send/reload/enable/disable/install/uninstall/save/promote/respond/interrupt/login/logout commands and routes are intentionally excluded. HTML contains no mutation URLs or controls.

## Determinism and delivery contract

- Callers explicitly select HTML. `--output` is valid only with `--format html`; absent `--output`, HTML is written to stdout. File writes require a `.html` suffix, are atomic, and fail if the target exists unless overwrite is explicit.
- The adapter constructs an authenticated capability-scoped provider; viewer claims are never accepted from CLI arguments, REST bodies/query strings, or Messenger command text.
- Collectors allowlist fields before view-model construction, sort with a locale-independent comparator, bound records/fields, and report shown/total counts. Aggregate collectors authorize every nested resource.
- Current task repositories expose deterministic full-list reads but no bounded read API. Task adapters therefore acquire the authorized list, immediately allowlist it into safe DTOs, retain at most 200 DTOs, and disclose the pre-cap total. This bounds the safe snapshot and artifact, but not repository read memory; adding a repository limit/cursor is a prerequisite for truly bounded acquisition.
- `generatedAt` is explicit UTC RFC3339. Each source has its own observation time plus honest stale/unavailable state when a coherent atomic snapshot is impossible.
- REST uses `text/html; charset=utf-8`, `Content-Disposition: attachment`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`; size failures occur before a response body starts.
- Messenger uploads the artifact bytes and safe generated basename to the authenticated requester. It never returns a host-local path.
- Artifact metadata contains kind, filename, media type, byte size, source version/build identity, generated time, effective filters, source observation times, explicit truncation details and unavailable sources. Delivery results remain transport-owned.

## Extension rule

A new report kind must add a discriminated selector, registry entry, capability-scoped allowlisting collector, typed presenter, explicit bounds, and transport-parity/security tests. Generic JSON-to-HTML dumping is forbidden.
