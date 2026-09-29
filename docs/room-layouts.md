# YAML Room Layouts

Room Layout describes room goals, participants and their shared or independent
sessions. Rooms and agents have independent lifecycles.

Place a layout at `fleet/room_layouts/<name>.yaml` beside the split configuration
for `fleet.yaml`. Agent Templates remain in `fleet/agent_templates/`.

```yaml
version: 1
participants:
  product: {agent_template: Product}
  developer: {agent_template: Developer}
  qa: {agent_template: QA}
rooms:
  discovery:
    goal: Clarify the problem and acceptance criteria
    members: [product, developer, qa]
  design:
    goal: Review implementation choices
    members: [developer, qa]
  amigos:
    goal: Resolve a concrete acceptance question
    members: [product, developer, qa]
    roles: {product: product, developer: developer, qa: qa}
```

Repeating a participant key reuses its exact running instance and session.
Different keys using the same Agent Template create independent instances.
See the [shared](../examples/room-layouts/shared.yaml) and
[fresh](../examples/room-layouts/fresh.yaml) examples. Both choices can coexist.
Fresh agents receive their room context. Supply relevant evidence through ordinary
room messages or existing project documents when needed.

A participant without `agent_template` requires a binding. `layout instance`
returns a local exact reference (supervisor, agent, launch, CID and session).
Pass participant-to-reference YAML to `create --bindings`. A stopped, replaced
or remote instance is rejected.

```sh
ours-fleet layout validate work
ours-fleet layout create work --id example
ours-fleet layout open example design
ours-fleet layout open example discovery
ours-fleet layout open example amigos
ours-fleet layout close-room example amigos
ours-fleet layout status example
ours-fleet layout close example
```

Any declared room may open first. `create` only saves the definition and resolved
Agent Templates; `open` lazily starts missing participants and admits all members
before sending their room context. The membership notification is informational. Existing room rules govern when
an agent contributes. Each room opens through an explicit command.

`close-room` archives a room and keeps agents available to other rooms. `close`
archives opened rooms and stops only temporary participants created by this layout
instance. Explicitly bound participants survive. Cleanup processes existing resources. A 3-Amigos room is an ordinary room with
complementary members.

Supported room fields: `goal`, `members`, optional `roles`, `contract`,
`quiet_membership`, `anonymous`. `contract` is briefing text.
Top-level fields: `version: 1`, optional `description`, `participants`, `rooms`.
Unknown fields, ambiguous YAML and invalid member references are rejected.
Existing templates and tasks keep their behavior.

Only local Fleet control is supported. The existing authenticated control socket,
agent runtime, `spawnTemp` and session queue perform operations. Private state
snapshots template definitions; public status hides their environment values.
Existing owner settings apply; owner CID/invite fingerprint are pinned. Unknown
mutation outcomes stop new work for inspection rather than blindly replaying a
spawn or room creation. `close` and `close-room` can still clean known resources.
Cleanup continues after individual errors and does not stop replacement or borrowed
instances. Confirmed stopped workers need no live control socket. An unknown
original outcome remains recorded, and cleanup reports incomplete until inspected;
it never claims that unknown resources were found or removed. Retrying cleanup
checks known resources and skips completed cleanup. Reopening an active layout room
checks its native state, CID and required seats and reports drift without repairing it.


Shared sessions retain available conversation context, not guaranteed perfect
recall or isolation between rooms. Compaction and model judgment still matter.
Rooms keep their existing turn scheduling.

Each layout instance creates distinct native room names, so several instances can
open the same declared room key. Participant roles must differ from the attached
owner role; a collision is rejected before creating resources.

Definitions are loaded for authoring commands. Retained instances use their saved
layout and Agent Templates. Status and cleanup operate on saved resources even
when the source YAML is broken or removed. New agent launches continue to use
Fleet's normal configuration and launch checks.
