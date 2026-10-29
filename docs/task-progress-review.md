# Task Progress and To review

Every task can carry two optional sections next to its description. Tasks created
before this feature, or that never use it, have neither and behave as before.

- **Progress** is an append-only, chronological milestone log: free-form text
  entries, each with a stable ID, the time it was recorded and its author. The
  browser response also includes `unread` per entry from the same task snapshot,
  based on persisted entry-ID acknowledgments. Legacy records without read state
  report all existing entries as read; retry keys remain private. It is
  for significant verified facts the Owner should know: delivered behavior, a
  concrete root cause, a measured improvement with a valid comparison, a PR or
  publication milestone, an important blocker, a changed scope or a required
  Owner decision. It is not for room chat, routine status, handoffs or internal
  review rounds. Each entry holds one fact in at most 400 characters (see
  [Limits](#limits-retries-and-concurrency)), leads with the result or the
  required action, names the actor and uses the task's language. Entries cannot
  be edited or removed.
- **To review** holds one *current* request for human review or decision: the
  final acceptance package, or one specific Owner decision that blocks or steers
  the work. It is not ongoing agent review, an evidence archive or a growing list
  of materials. Markdown plus retained files gather everything needed for that
  decision in one place. The final package lets the Owner review without reading
  the room or the task description: concise outcome, clickable PR and
  specification links, attached documents, validation and required-CI results
  for the exact heads, the independent verdict where one applies, material limits
  and any Owner decision. Research and document tasks attach their documents and
  need no PR.

### Progress examples

| Instead of | Write |
| --- | --- |
| "Started looking into the flaky test, will report back." | Nothing: routine status. |
| "After a lot of investigation we think the cache might be the cause." | "Developer found the root cause: the cache key omits the workspace ID." |
| "Critic reviewed PR #42 and asked for two changes, then approved." | "Critic approved PR #42 after the review rounds." (only the outcome) |
| A 900-character summary of three results | Three entries, one result each. |
| — | "Owner review required: choose the deployment option in To review." |

### To review lifecycle

1. **Request.** The responsible agent writes the request into To review
   (`fleet_task_review_set`, attachments with the CLI) and appends a Progress
   entry that sends the Owner there, for example "Owner review required: choose
   the deployment option in To review." Final acceptance also uses the Review
   lifecycle; an interim decision never marks unfinished work done.
2. **Answer.** Opening To review marks it read but does not resolve it. The
   Owner's answer in the room does.
3. **Clear.** The agent that owns the request records the decision in Progress or
   the room, reads the package `revision` with `fleet_task_review_show`, and
   calls `fleet_task_review_clear` with that `expected_revision` (CLI:
   `ours-fleet task review-package TASK --clear --expected-revision N`). The next
   request replaces the cleared one, in the same change when `markdown` (CLI:
   `--markdown-file`) is given; requests do not accumulate.

A clear removes the Markdown and every attached file in one change and only when
the package revision is still the one the writer read. Any Markdown edit, attach
or detach since then, including an edit back to the same Markdown, makes it a
conflict and nothing is removed. A file attached after the clear committed is
kept. Clearing an empty package at its current revision changes nothing. Like
every package change, a clear gets the next revision: readers see an updated
package until they view it, and read markers stay valid.

The web App shows both as compact **Progress** and **To review** buttons with
counts on the task screen, each opening its own view. Review links use the same
safe Markdown and link rules as the task description.

## Who writes them

The packaged default roles divide the work so milestones are not duplicated:

| Role | Progress | To review |
| --- | --- | --- |
| LocalCoordinator | The only writer when present: extracts Owner-relevant facts from room discussion during turns it already takes. Its 15-minute continuity pass never writes Progress. | Makes sure members prepare the package before a Review handoff; hands it to the Fleet Coordinator. Directs the Owner to an interim decision request and clears it after the answer. |
| Developer, Engineer | Writer only in a room without a LocalCoordinator; otherwise posts such facts in the room. | Prepare and keep the package current before reporting completion or asking for Review; clear a request they wrote once the Owner answered. |
| Critic | Never; posts findings in the room. | Check that the package matches what was verified; withhold sign-off while it is missing, stale or misleading. Review rounds stay in the room. |
| Coordinator (Fleet Coordinator) | Not by default. | Before `task review`, check that the package is one current acceptance request and attaches the original description; if not, ask the room to complete it instead of writing it. Then replace the description with only the PR links (or deliverable links when there are no PRs). Finish only when the Owner accepts or asks. |

This is default instruction policy, not an access rule: any agent bound to the
task, and the local operator, can use the surfaces below. Preparing a package
grants no lifecycle authority. A role moves a task to Review only when its
instructions grant that; otherwise it hands the complete package to its
authorized coordinator. Nothing here merges, deploys or marks a task done.

At Review, the task description and the To review package have separate jobs.
The description is replaced with only the clickable Markdown PR links, one per
line, with no status or evidence. A research or document task without PRs links
its actual deliverables instead; it never invents a PR. The package holds everything the Owner needs
to review, including the original task description as an attached file. Package
authors save and attach that file before the handoff, the Critic checks it, and
the Coordinator replaces the description only once the package has it.

Fresh installations get these instructions with preset revision 13. An existing
configuration keeps its installed copies until you run
`ours-fleet migrate-role-defaults -c FILE` (a zero-write plan) and then with
`--write`: untouched revision-11 and revision-12 copies of the Developer, Critic,
Engineer, LocalCoordinator and Coordinator roles, and the revision-11
LocalCoordinator Agent Template, adopt the new text, and edited copies are
preserved byte-for-byte. Running
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
| `fleet_task_review_set` | Replace the Markdown; pass the Markdown you last read as `expected_markdown` (`""` when empty). Attached files are kept. |
| `fleet_task_review_clear` | Clear the resolved request: Markdown and every file, only if `expected_revision` is still current. Optional `markdown` writes the next request in the same change. Returns the package and the removed files. |
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
ours-fleet task review-package TASK --clear --expected-revision N [--markdown-file next.md]
```

Run inside a managed agent, the supervisor-verified caller is recorded as the
author (with its identity CID); otherwise the author is the local operator.
`--text`, `--text-file`, `--markdown`, `--markdown-file` and `--attach` values are
redacted from the supervisor's command ledger. `--markdown-file` replaces the
Markdown current at the time of the call; use `fleet_task_review_set` when a
concurrent change must be refused. The text output shows the package revision.
`--clear` is fenced by `--expected-revision`; with `--markdown` or
`--markdown-file` the same locked change writes the next request, so no other
writer can land in between. `--clear` cannot be combined with `--attach`: attach
the next request's files afterwards.

## HTTP API

Authenticated like the rest of `/api/v1`; writes need the CSRF token or a
workspace-device bearer. `GET /api/v1/meta` reports API minor version 1.

| Route | Result |
| --- | --- |
| `GET /tasks`, `GET /tasks/:id` and other task payloads | `progress_count` and `review: {has_markdown, artifact_count, revision, updated_at?}`; `revision` grows with every package change (0 without a package). Bodies are not inlined. |
| `GET /tasks/:id/progress` | `{progress: [{id, at, author, text, unread}]}`, oldest first. |
| `POST /tasks/:id/progress` | `{text, requestKey?}` (or an `Idempotency-Key` header): 201 new, 200 replay, 409 conflicting replay. |
| `GET /tasks/:id/review` | `{review: {revision, markdown, updated_at, updated_by, artifacts: [{id, name, mime, size, sha256, added_at, added_by}]}}` or `{review: null}`. |
| `PUT /tasks/:id/review` | `{markdown, expectedMarkdown}`; 409 when the Markdown changed meanwhile. |
| `GET /tasks/:id/review/artifacts/:artifactId` | The retained bytes as `application/octet-stream` attachment with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and `no-store`. Another task's artifact ID is 404. |

The HTTP API has no upload route: the browser never submits a file path.

## Limits, retries and concurrency

- Progress text: 1-400 characters, kept exactly as written; whitespace-only text
  is rejected. Characters are Unicode code points of the exact submitted text,
  without normalization or trimming: `😀` counts as 1 (although it is two UTF-16
  units), while `é` written as `e` plus a combining accent counts as 2, and a
  joined emoji such as `👩‍💻` counts as 3. Longer text is refused with
  `invalid_request` on every surface (HTTP 400): nothing is saved, cut or split.
  Entries written before this limit keep their text and still display. At most
  200 entries per task.
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
symlinks, so symlinks, hard links, any `..` component and paths outside the
workspace (including sibling folders with a common name prefix) are refused.
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
