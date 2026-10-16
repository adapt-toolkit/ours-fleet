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
- Wait for a peer without forgetting the task: see [Waiting on a peer](#waiting-on-a-peer).
- Not for recurring maintenance: use configured `loops` for that.

## Tools

The tools are served by the agent's own fixed-identity ours MCP server. No
argument names an agent or identity: every call acts on the caller's own
reminders, and an id that belongs to another agent is simply not found.

| Tool | Arguments | Result |
| --- | --- | --- |
| `fleet_reminder_create` | `request_key`, `title`, `note`?, `local_time`, `time_zone`, `fold`?, `late_window_seconds`?, `interrupt`? | the reminder (`id`, `revision`, `due_at`, `expires_at`, `interrupt`, …) and `created` |
| `fleet_reminder_list` | `state`? (`open` default, `closed`, `all`), `limit`? (1–100), `after`? | a page of reminders, `more`, `after`, `uncertain_events` |
| `fleet_reminder_update` | `id`, `expected_revision`, any of the schedule fields | the reminder at its new revision |
| `fleet_reminder_cancel` | `id`, `expected_revision` | the cancelled reminder |
| `fleet_reminder_inspect` | `event_id` | the event (with `interrupt` / `interrupt_deferred` for an urgent one), its reminder (with `note`), `current`, `eligible` |
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

`interrupt` (default `false`) marks a reminder as urgent; see
[Urgent reminders](#urgent-reminders-interrupt-true). Leave it out for ordinary
reminders.

### Idempotency and revisions

`request_key` identifies one scheduling decision. Repeating `create` with the same
key and the same input returns the existing reminder, so a retried call after a
timeout never creates a second one; the same key with different input is refused
(`request_key_conflict`). Keys are remembered while the reminder is retained (the
200 most recent closed reminders are kept; at most 100 can be open).

An urgent request differs from an ordinary one: repeating a call made without
`interrupt` (or with `interrupt: false`) matches the original, while the same key
with `interrupt: true` is a `request_key_conflict`. `update` can turn urgency on or
off; it keeps its current value when not given.

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
- **When it arrives.** By default, at the first idle turn boundary after the
  due time, and only after the agent's startup turn has succeeded. An ordinary
  wake never interrupts the agent and never waits in a queue behind other work;
  a busy agent receives it when its current work finishes. An urgent reminder may
  instead stop interruptible busy work once (next section). A reminder wake always
  runs as its own turn and is never combined with owner or mail input.
- **Offline.** Nothing runs while the host is off or asleep, or while Fleet or the
  agent is stopped. Reminders are kept, and those still inside their late window
  are delivered when the agent is back; the rest expire without a turn. Pause and
  restart keep reminders; they never start a stopped agent.
- **Deletion.** Removing or retiring an agent, or deleting or finishing its task,
  cancels its reminders and deletes their state, including from retained
  evidence. A replaced identity or a new agent with the same name never inherits
  them: a store is bound to the agent's role and identity (and, for a temporary
  or task agent, its runtime instance), and a store that does not match is set
  aside and nothing in it is delivered.
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

## Urgent reminders (`interrupt: true`)

An ordinary reminder waits for the agent to be idle, so a long busy turn delays
it. For a return that is genuinely bound to a time — a deadline, a meeting, a
window that closes — the agent can create the reminder with `interrupt: true`.
When it is due and the agent is busy, the supervisor may ask the current turn to
stop and then start the wake in the same session, instead of waiting.

What happens, as separate recorded facts:

1. **Due.** The reminder reaches its time (nothing happens before it).
2. **Interruption requested.** Only if the busy turn is interruptible (below).
   The request, and which turn it targets, is durably recorded *before* the
   session is asked to stop. Each reminder revision may request this **once**.
3. **Terminal.** How the stop ended, shown by `inspect` as `interrupt.state`:
   `cancelled` (the target turn's own result confirms this request cancelled it),
   `ended` (the session reported it settled, but cancellation is not confirmed),
   `forced` (the adapter ignored the stop and was restarted), `failed` (the
   control call failed) or `unknown` (Fleet restarted before the outcome).
4. **Released.** The wake is handed to the model through the same release fence
   as every reminder. After `forced` or `failed` it is not queued; it is
   delivered later, idle-only, within its late window.
5. **Acknowledged**, and any **external action** the agent then takes, are the
   agent's own and remain separate facts.

The session and its context are kept: nothing is reset, no second agent and no
parallel model turn is started. The wake tells the agent what it interrupted so
it can re-check and resume that work. It sends nothing to anyone and grants no
authority.

An urgent reminder **never** stops, and instead waits like an ordinary one:

- an owner-channel request or an owner admin-console turn (owner commands keep
  priority, and cancelling one would end the owner's request and its reply);
- the startup turn, a stall-recovery turn, or another reminder's wake;
- a turn with a pending permission decision;
- work queued behind the current turn, or another admission waiting for the role;
- a turn Fleet cannot identify exactly (for example one started by adapter-side
  steering, which reports the role idle).

Interruptible turns are mail wakes, scheduled loops and local-console prompts.
When the reminder defers, `inspect` shows why in `event.interrupt_deferred`, and it
interrupts at a later boundary if one becomes interruptible. A mail wake that was
stopped is retried by the monitor and queued behind the reminder; it cannot stop
the reminder in turn.

Limits:

- Not a hard real-time alarm: the dispatcher checks at least once a minute, and
  stopping a turn and starting a model turn both take time.
- Nothing happens while the host is off or asleep, or Fleet or the agent is down.
- One interruption per revision: after it (whatever its outcome) the wake is
  idle-only. A failed or forced stop means the urgency was lost for that event,
  and `inspect` says so; it never reports a successful interruption.
- Use it sparingly. Ordinary coordination waits stay `interrupt: false`.

## Waiting on a peer

In paired work (Developer and Critic, Engineer and Critic) an agent that stops to
wait for a review, answer, artifact or check schedules **one** idle-only reminder
about 20 minutes out (or at the agreed time), naming the task or room and the
exact expectation:

```json
fleet_reminder_create {
  "request_key": "pr-412-wait-critic-final-1",
  "title": "PR 412: Critic FINAL on head 1a2b3c",
  "note": "Task room for PR 412: waiting for the Critic's FINAL on head 1a2b3c. If it arrived, just ack.",
  "local_time": "2027-01-20T16:20",
  "time_zone": "UTC"
}
```

- The answer arrives, the state changes or the work is finished: `cancel` (or
  `update`) the reminder with its current revision.
- On the wake: `inspect`, re-check the task. Resolved or closed: `ack`, nothing
  else. Still waiting: one concise follow-up in the same room, `ack`, and at most
  one more reminder; if that one finds no progress either, report the
  nonresponse or blocker once through the configured routes and stop reminding.
- Never a short polling interval, a recurring chain of reminders, repeated
  follow-ups or acknowledgements, or a "done" status because a reminder fired.
- A deleted or finished task removes the agent's reminders, so a closed task
  produces no wake.

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
- `fleet_reminder_list {"state": "all"}` (every page) shows each reminder's
  `request_key`. Any key starting with `legacy:` belongs to an earlier attempt:
  reconcile it with the rollback table below before starting again. Keys map
  back to old ids (`legacy:<old id>:r<old revision>`), so an interrupted run
  is always resumable from the two lists.

### 2. Fence the old producer persistently

A `stop` alone is not a fence: an enabled unit starts again at the next login or
boot. The operator records the unit's prior state and its unit file, then
disables it. The old setup enabled a generated unit by absolute path outside the
unit search path, so disabling removes its only link; keep the recorded path and
do not delete that file until step 6:

```sh
systemctl --user is-enabled self-reminders-Name.service   # record: enabled/linked/...
systemctl --user is-active  self-reminders-Name.service   # record: active/inactive
systemctl --user show -p FragmentPath self-reminders-Name.service   # record the absolute unit file
systemctl --user disable --now self-reminders-Name.service
systemctl --user is-enabled self-reminders-Name.service   # must not be enabled
systemctl --user is-active  self-reminders-Name.service   # must be inactive
```

From here on no old wake can be produced, across worker, Fleet or host
restarts, until someone deliberately re-enables the unit. Do not run the old
`tick` or `serve` commands during the cutover.

### 3. Classify every old reminder

The old CLI lists reminders but not events, and its `cancel` leaves earlier
events in whatever state they had. Classification therefore uses the old
system's own eligibility rule, not raw event states: an event is **live** only
if its reminder is still `active`, the event's revision equals the reminder's
current revision, and its state is `submitting`, `queued` or `uncertain`.
Anything else is historical: superseded by an update or cancellation, or
belonging to a reminder that is already `handled`, `cancelled` or `expired`.

The operator supplies the metadata with a read-only query that selects no
title or context:

```sh
sqlite3 -readonly /path/to/old/ledger.sqlite "
  SELECT r.id, r.revision, r.state,
         datetime(r.due, 'unixepoch'), datetime(r.expires, 'unixepoch'),
         e.id, e.revision, e.state
  FROM self_reminders r LEFT JOIN self_events e
    ON e.reminder_id = r.id AND e.revision = r.revision
  ORDER BY r.due, r.id"
```

Each old reminder falls into exactly one row:

| Old reminder (current revision) | Meaning | Action |
| --- | --- | --- |
| `handled`, `cancelled` or `expired` | finished; its events are historical | nothing |
| `active`, `expires` already passed | lapsed while fenced; the old worker would expire it | old `cancel`, nothing to migrate |
| `active`, due in the future, no event | not yet fired | **migrate** (step 4), then old `cancel` (step 5) |
| `active`, already due, no event or event `pending` | due, never submitted | **decide**: migrate to a new future time, or old `cancel`; never both |
| `active`, event `submitting`, `queued` or `uncertain` | live: may already have reached the agent | **hold**: check the conversation and your own records. If handled and still inside its window, old `complete`. Otherwise old `cancel`, which makes the event historical, and create a new reminder only if one is still useful. Never re-create the old event as-is |
| `active`, event `handled`, `failed` or `invalidated` | finished for this revision | old `cancel` |

**Stop condition:** do not continue to step 6 while any old reminder is still
`active`. When every row above has been applied, nothing is active and no
event is live.

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
| open, no event or event `pending` | First check the old reminder named by the key (`legacy:<old id>:…`). Only if it is still `active` in the old system, `fleet_reminder_cancel` the Fleet copy. If the old one is no longer active, the Fleet copy is the only schedule: keep it |
| event `dispatched` or `uncertain`, or `acknowledged` | the wake already happened in Fleet: **cancel the old reminder** so it cannot fire again, and keep the Fleet record |
| `cancelled` or `expired` | nothing; make sure the old reminder is not active either unless that is intended |

Only when every `legacy:` reminder has been reconciled may the operator restore
the unit to its recorded prior state from the recorded unit file, for example
`systemctl --user enable --now /recorded/FragmentPath/self-reminders-Name.service`
if it was enabled and active. Never have both producers active for the same
reminder.

### Instructions to update

Remove instructions that tell the agent to run the worker script, and replace
them with: "Use the `fleet_reminder_*` tools to schedule wakes for yourself. A
due wake is an internal event: inspect it, decide, then acknowledge it. Message
anyone only through your normal configured channels."
