# Self-reminders

A Fleet-managed agent can schedule a one-time reminder that wakes **itself** at a
later date and time. When the reminder is due, the agent's own supervisor starts
a turn for it; the agent reads the reminder and decides what to do.

A reminder is not a message. It has no recipient, chat, route, API key or
Telegram setting, and Fleet never sends anything on the agent's behalf. If the
agent decides someone should hear about it, it uses its ordinary messaging tools
under its existing instructions and authorization.

It works for every managed session (`session: acp` or `session: codex-app-server`,
Claude or Codex) and every lifetime: persistent, temporary and task-owned. There
is nothing to install or enable.

## When to use it

- Come back to something at a known time: "check whether the release CI finished
  at 16:00", "follow up on the review on Monday morning".
- Replace polling or sleeping inside a turn. A reminder costs nothing while it
  waits; a turn that sleeps or a loop that polls costs model time every tick.
- Not for recurring maintenance: use configured `loops` for that.

## Tools

The tools are served by the agent's own fixed-identity ours MCP server. No
argument names an agent or identity: every call acts on the caller's own
reminders, and an id that belongs to another agent is simply not found.

| Tool | Arguments | Result |
| --- | --- | --- |
| `fleet_reminder_create` | `request_key`, `title`, `note`?, `local_time`, `time_zone`, `fold`?, `late_window_seconds`? | the reminder (`id`, `revision`, `due_at`, `expires_at`, …) and `created` |
| `fleet_reminder_list` | `state`? (`open` default, `closed`, `all`), `limit`? (1–100), `after`? | a page of reminders, `more`, `after`, `uncertain_events` |
| `fleet_reminder_update` | `id`, `expected_revision`, any of the schedule fields | the reminder at its new revision |
| `fleet_reminder_cancel` | `id`, `expected_revision` | the cancelled reminder |
| `fleet_reminder_inspect` | `event_id` | the event, its reminder (with `note`), `current`, `eligible` |
| `fleet_reminder_ack` | `event_id`, `expected_revision` | `acknowledged` (repeat calls return `duplicate: true`) |

### Time

`local_time` is a calendar date and wall-clock time **without** an offset
(`2027-01-20T16:00` or `2027-01-20T16:00:00`); `time_zone` is an IANA zone such
as `Europe/London`, `America/New_York` or `UTC`. Use the zone of the person or
task the reminder is about; Fleet never assumes the host's zone. "Tomorrow at
nine" must be resolved by the agent to a real date first.

Daylight-saving changes are explicit:

- A time skipped when clocks go forward (`2027-03-28T01:30` in `Europe/London`)
  does not exist and is refused (`nonexistent_local_time`).
- A time that occurs twice when clocks go back (`2027-10-31T01:30` in
  `Europe/London`) needs `fold`: `0` for the first occurrence, `1` for the second
  (`ambiguous_local_time` otherwise).
- Invalid dates (`2027-02-30`) are refused. The time must be in the future and
  within five years.

`late_window_seconds` (60–604800, default 3600) is how late the wake may still
arrive if the agent, Fleet or the host was down, paused or busy at the due time.
After the window the reminder expires without a turn.

### Idempotency and revisions

`request_key` identifies one scheduling decision. Repeating `create` with the same
key and the same input returns the existing reminder, so a retried call after a
timeout never creates a second one; the same key with different input is refused
(`request_key_conflict`). Keys are remembered while the reminder is retained (the
200 most recent closed reminders are kept; at most 100 can be open).

Every `update` and `cancel` names the revision it expects (`stale_revision`
otherwise) and bumps it. A wake issued for an older revision is void: if it is
still waiting it is dropped before it reaches the model, and if it was already
delivered it can no longer be acknowledged.

## Example

```json
fleet_reminder_create {
  "request_key": "release-ci-check-2027-01-20",
  "title": "Check release CI",
  "note": "PR #412 on prerelease. If CI is green, post the result in the task room; do not merge.",
  "local_time": "2027-01-20T16:00",
  "time_zone": "Europe/London"
}
```

At 16:00 London time the agent receives a turn like:

```text
[fleet-reminder]
event_id: rev_7c0d…
reminder_id: rem_1b9e…
revision: 1
title: "Check release CI"
due: 2027-01-20T16:00:00 Europe/London (2027-01-20T16:00:00.000Z)

This is a reminder you scheduled for yourself through Fleet. …
```

It then calls `fleet_reminder_inspect {"event_id": "rev_7c0d…"}`, does the work
(or decides nothing is needed), and calls
`fleet_reminder_ack {"event_id": "rev_7c0d…", "expected_revision": 1}`. To
postpone instead, it calls `fleet_reminder_update` with a new `local_time`; the
current wake becomes void and a new one is issued at the new time.

## Delivery guarantees and limits

- **Who keeps time.** The supervisor process that runs the agent owns the timer
  and the private state (`.self-reminders.json`, mode 0600, in the agent's state
  directory). With no open reminders it arms no timer; otherwise it checks at the
  next due time and at least once a minute. Only a due reminder creates a model
  turn.
- **When it arrives.** At the first idle turn boundary after the due time, and
  only after the agent's startup turn has succeeded. A wake never interrupts the
  agent and never waits in a queue behind other work; a busy agent receives it
  when its current work finishes. A reminder wake always runs as its own turn and
  is never combined with owner or mail input.
- **Offline.** Nothing runs while the host is off or asleep, or while Fleet or the
  agent is stopped. Reminders are kept, and those still inside their late window
  are delivered when the agent is back; the rest expire without a turn. Pause and
  restart keep reminders; they never start a stopped agent.
- **Deletion.** Removing or retiring an agent, or deleting or finishing its task,
  cancels its reminders and deletes their state, including from retained
  evidence. A replaced identity or a new agent with the same name never inherits
  them; a store that does not belong to the running instance is set aside and
  nothing in it is delivered.
- **At most once.** Four facts are separate: the supervisor queued the wake, the
  wake was released to the model, the agent acknowledged it, and any external
  action the agent took. A wake is recorded as dispatched, durably, at the moment
  it is handed to the model; if that record cannot be written, it is not handed
  over. After a crash, an event that was never released is retried as the same
  event; an event that may have reached the model is held as `uncertain` and is
  never sent again. `list` reports `uncertain_events`; the agent checks its own
  records, then acknowledges it or schedules something new.
- **Privacy.** Titles and notes are visible only through the agent's own tools.
  The wake text contains the title, not the note, and the conversation ledger
  stores only a digest of the wake. Logs carry event ids, never reminder text.

Operators can see an agent's reminders through the existing supervisor tool
route, which acts as that agent's supervisor:

```sh
ours-fleet ours call DeveloperA fleet_reminder_list
```

## Migrating from the standalone `self-reminders` worker

The standalone skill ran one Python worker, its own SQLite ledger and a user
service per agent. Built-in reminders replace it; the worker is deprecated.
Personal-assistant reminder, source and outbound messaging stores are separate
systems and are not touched by this procedure. Migration is a deliberate,
separately authorized operation per agent; nothing migrates automatically.

Reminder data is handled **by the agent itself** with both tool sets, so its text
never passes through an operator. The operator only fences and later removes the
old service.

### 1. Preconditions

- The agent runs a Fleet release with built-in reminders:
  `ours-fleet ours tools Name` lists `fleet_reminder_create`.
- `fleet_reminder_list {"state": "all"}` shows no reminder whose key starts with
  `legacy:` from an earlier, abandoned attempt (otherwise reconcile it first).

### 2. Fence the old producer persistently

A `stop` alone is not a fence: an enabled unit starts again at the next login or
boot. The operator records the unit's prior state and then disables it:

```sh
systemctl --user is-enabled self-reminders-Name.service   # record: enabled/linked/...
systemctl --user is-active  self-reminders-Name.service   # record: active/inactive
systemctl --user disable --now self-reminders-Name.service
systemctl --user is-enabled self-reminders-Name.service   # must not be enabled
systemctl --user is-active  self-reminders-Name.service   # must be inactive
```

From here on no old wake can be produced, across worker, Fleet or host
restarts, until someone deliberately re-enables the unit. Do not run the old
`tick` or `serve` commands during the cutover.

### 3. Classify every old reminder

The agent lists all old reminders (`list` with each `state`, every page). The
old CLI cannot list events, so the operator supplies their states with a
read-only query that touches no reminder text (the events table holds only ids,
revisions and states):

```sh
sqlite3 -readonly /path/to/old/ledger.sqlite \
  "SELECT reminder_id, revision, id, state FROM self_events ORDER BY reminder_id, revision"
```

The agent can `inspect` any event id from that list. Each old reminder falls
into exactly one row:

| Old reminder / latest event for its current revision | Meaning | Action |
| --- | --- | --- |
| `active`, no event, due in the future | not yet fired | **migrate** (step 4), then cancel the old one (step 5) |
| `active`, event `pending`, or no event and already due | due but never submitted | **decide**: migrate to a new future time, or cancel the old one; never both |
| event `submitting`, `queued` or `uncertain` | may already have reached the agent | **hold**: check the conversation and your own records. If handled, `complete` it in the old system. If not, cancel the old reminder and, only if still useful, create a new one at a new future time. Never re-create the old event as-is |
| `handled`, `cancelled`, `expired`, or event `failed`/`invalidated` | finished | nothing to migrate |

**Stop condition:** the cutover does not proceed to step 6 while any old
reminder is unclassified, or while any old event is still `submitting`,
`queued` or `uncertain`.

### 4. Re-create the reminders that migrate

For each reminder marked *migrate*, the agent calls `fleet_reminder_create` with:

- `request_key` `legacy:<old id>:r<old revision>`;
- the same title, with the old `context` as `note`;
- the same `local_time`, `timezone` and `fold`;
- the old window (`expires − due`) as `late_window_seconds`.

The key makes this step safe to repeat. A reminder whose time has meanwhile
passed is refused as not in the future. It is then a *decide* row: pick a new
time, using `request_key` `legacy:<old id>:r<old revision>:retimed`, or let it
lapse.

### 5. Verify, then retire the old entries

`fleet_reminder_list` shows exactly one `legacy:` reminder per migrated old id.
The agent then cancels each migrated old reminder with the old `cancel` (`id`,
`expected_revision`). Afterwards the old `list` shows no `active` reminders and
no unsettled events.

### 6. Remove the old service

Only after step 5 is verified, the operator removes the user unit and the
worker's config (it is already disabled and stopped). Keep or delete the old
ledger according to the owner's retention policy; never point Fleet at it.

### Rollback

Rollback is a reconciliation, not a restart. While the old unit stays disabled,
the agent goes through each `legacy:` Fleet reminder:

| Fleet reminder state | Action before the old producer may run again |
| --- | --- |
| open, no event or event `pending` | `fleet_reminder_cancel` it; the old reminder remains the only copy (it must still be `active` in the old system, otherwise re-create it there) |
| event `dispatched` or `uncertain`, or `acknowledged` | the wake already happened in Fleet: **cancel the old reminder** so it cannot fire again, and keep the Fleet record |
| `cancelled` or `expired` | nothing; make sure the old reminder is not active either unless that is intended |

Only when every `legacy:` reminder has been reconciled may the operator restore
the unit to its recorded prior state, for example
`systemctl --user enable --now self-reminders-Name.service` if it was enabled
and active. Never have both producers active for the same reminder.

### Instructions to update

Remove instructions that tell the agent to run the worker script, and replace
them with: "Use the `fleet_reminder_*` tools to schedule wakes for yourself. A
due wake is an internal event: inspect it, decide, then acknowledge it. Message
anyone only through your normal configured channels."
