# Task Progress and To review

Every task can carry two optional sections next to its description. Tasks created
before this feature, or that never use it, have neither and behave as before.

- **Progress** is an append-only, chronological milestone log: free-form text
  entries, each with a stable ID, the time it was recorded and its author. It is
  for significant verified milestones (root cause found, PR opened with its link,
  a measured result with its honest scope, final deliverable ready), not for room
  chat, routine status, handoffs or ordinary review rounds. Entries cannot be
  edited or removed.
- **To review** is the self-contained package the Owner reviews before deciding
  on the task: Markdown plus retained files. It should let the Owner review
  without reading the room or the task description: concise outcome, clickable PR
  and specification links, attached documents, validation and required-CI results
  for the exact heads, the independent verdict where one applies, material limits
  and any Owner decision. Research and document tasks attach their documents and
  need no PR.

The web App shows both as compact **Progress** and **To review** buttons with
counts on the task screen, each opening its own view. Review links use the same
safe Markdown and link rules as the task description.

## Who writes them

The packaged default roles divide the work so milestones are not duplicated:

| Role | Progress | To review |
| --- | --- | --- |
| LocalCoordinator | Default writer: appends significant verified milestones during room turns it already takes. Its 15-minute continuity pass never writes Progress. | Makes sure members prepare the package before a Review handoff; hands it to the Fleet Coordinator. |
| Developer, Engineer | Not by default. | Prepare and keep the package current before reporting completion or asking for Review. |
| Critic | Not by default. | Check that the package matches what was verified; withhold sign-off while it is missing, stale or misleading. |
| Coordinator (Fleet Coordinator) | Not by default. | Before `task review`, check that the package exists; if it is missing, ask the room to complete it instead of writing it. Finish only when the Owner accepts or asks. |

This is default instruction policy, not an access rule: any agent bound to the
task, and the local operator, can use the surfaces below. Preparing a package
grants no lifecycle authority. A role moves a task to Review only when its
instructions grant that; otherwise it hands the complete package to its
authorized coordinator. Nothing here merges, deploys or marks a task done.

Fresh installations get these instructions with preset revision 12. An existing
configuration keeps its installed copies until you run
`ours-fleet migrate-role-defaults -c FILE` (a zero-write plan) and then with
`--write`: untouched revision-11 copies of the Developer, Critic, Engineer,
LocalCoordinator and Coordinator roles and the LocalCoordinator Agent Template
adopt the new text, and edited copies are preserved byte-for-byte. Running
agents keep the instructions they started with until they are restarted.

## Agent tools

Every managed agent launched for a task gets these tools on its own MCP endpoint.
The task and the author come from the agent's supervisor launch records, never from
tool arguments, so an agent can only read and write the task it belongs to. An
agent that is a listed task member must match that member's identity CID.

| Tool | Purpose |
| --- | --- |
| `fleet_task_progress_list` | Read the log oldest first, in pages; pass `after` = the previous page's `next_after`. |
| `fleet_task_progress_append` | Append one entry (`text`, optional `request_key`). |
| `fleet_task_review_show` | Read the package Markdown and file list. |
| `fleet_task_review_set` | Replace the Markdown; pass the Markdown you last read as `expected_markdown` (`""` when empty). |
| `fleet_task_review_detach` | Remove one file by `artifact_id`. |

Files are attached with the CLI below. It runs in the agent's own process, so the
harness's command approval and sandbox decide what it may read.

## CLI

```sh
ours-fleet task progress TASK [--json]
ours-fleet task progress TASK --text "PR opened: https://..." [--request-key KEY]
ours-fleet task progress TASK --text-file milestone.md [--request-key KEY]
ours-fleet task review-package TASK [--json]
ours-fleet task review-package TASK --markdown-file review.md
ours-fleet task review-package TASK --attach docs/spec.md [--request-key KEY]
ours-fleet task review-package TASK --detach ARTIFACT_ID
```

Run inside a managed agent, the supervisor-verified caller is recorded as the
author (with its identity CID); otherwise the author is the local operator.
`--text`, `--text-file`, `--markdown`, `--markdown-file` and `--attach` values are
redacted from the supervisor's command ledger. `--markdown-file` replaces the
Markdown current at the time of the call; use `fleet_task_review_set` when a
concurrent change must be refused.

## HTTP API

Authenticated like the rest of `/api/v1`; writes need the CSRF token or a
workspace-device bearer. `GET /api/v1/meta` reports API minor version 1.

| Route | Result |
| --- | --- |
| `GET /tasks`, `GET /tasks/:id` and other task payloads | `progress_count` and `review: {has_markdown, artifact_count, updated_at?}`; bodies are not inlined. |
| `GET /tasks/:id/progress` | `{progress: [{id, at, author, text}]}`, oldest first. |
| `POST /tasks/:id/progress` | `{text, requestKey?}` (or an `Idempotency-Key` header): 201 new, 200 replay, 409 conflicting replay. |
| `GET /tasks/:id/review` | `{review: {markdown, updated_at, updated_by, artifacts: [{id, name, mime, size, sha256, added_at, added_by}]}}` or `{review: null}`. |
| `PUT /tasks/:id/review` | `{markdown, expectedMarkdown}`; 409 when the Markdown changed meanwhile. |
| `GET /tasks/:id/review/artifacts/:artifactId` | The retained bytes as `application/octet-stream` attachment with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and `no-store`. Another task's artifact ID is 404. |

The HTTP API has no upload route: the browser never submits a file path.

## Limits, retries and concurrency

- Progress text: 1-4000 characters, kept exactly as written; whitespace-only text
  is rejected. At most 200 entries per task.
- Review Markdown: up to 50,000 characters. At most 20 files of 20 MiB each per
  task, and 200 MiB stored per task including unreferenced copies.
- Every change is a read-modify-write under the task's cross-process lock, so
  concurrent appends and attachments are never lost.
- `request_key` (1-128 of letters, digits, `.`, `_`, `:` and `-`) makes a retry
  safe. Keys are scoped to the author: an agent by its identity CID (the same
  through MCP and the CLI), or by role name when no CID is known; the operator by
  surface. Repeating a key with the same text, or the same file name and content,
  returns the original; different content is a conflict. A keyed file retry is
  compared by content without storing another copy. Without a key, an interrupted
  call may or may not have taken effect: read the log or package before retrying.
- Writes are refused once deletion is accepted or a terminal settlement is pending.

## Files and their lifetime

An attached file must be one regular, singly linked file inside the task's owned
workspace. Each path component below the workspace is opened without following
symlinks, so symlinks, hard links, `..` and paths in sibling folders are refused.
The file must not change while it is copied. The copy goes to Fleet's private
store at `.ours-fleet/task-review-artifacts/<task-id>/`, outside the
agent-writable workspace, with owner-only permissions. It is made durable before
the package references it and is integrity-checked (size and SHA-256) on every
download. Nothing is uploaded automatically.

Retained files survive later edits or deletion of the workspace copy, review,
return to work and service restarts. Detaching removes a file. Deleting the task
removes all of them together with the workspace. Copies left by an interrupted
attach are removed after ten minutes by the next attach and count toward the
quota until then.
