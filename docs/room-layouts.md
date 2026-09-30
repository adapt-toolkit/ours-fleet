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

Participant `instance_scope` controls instance reuse:

- `layout` (default): repeating a participant key reuses its exact running instance
  and session within this layout run.
- `room`: each room using the key gets its own identity and session, lazily created
  when that room opens. Repeated opens of the same active room reuse that instance.

For example, one shared process doctor and one independent critic per room:

```yaml
version: 1
participants:
  doctor: {agent_template: ProcessDoctor, instance_scope: layout}
  critic: {agent_template: Critic, instance_scope: room}
rooms:
  discovery:
    goal: Agree on the problem
    members: [doctor, critic]
  design:
    goal: Review the design
    members: [doctor, critic]
```

Different keys using the same Agent Template still create independent instances.
See the [shared](../examples/room-layouts/shared.yaml) and
[fresh](../examples/room-layouts/fresh.yaml) examples, and the mixed
[scoped](../examples/room-layouts/scoped.yaml) example. All choices can coexist.
Fresh agents receive their room context. Supply relevant evidence through ordinary
room messages or existing project documents when needed.

A participant without `agent_template` requires a binding. `layout instance`
returns a local exact reference (supervisor, agent, launch, CID and session).
Pass participant-to-reference YAML to `create --bindings`. A stopped or replaced instance is rejected. Cross-Fleet bindings require
an explicit owner grant, as described below.
Room-scoped participants require `agent_template`; an explicit binding for them
is rejected before creating resources. Bindings for layout-scoped participants
keep their existing behavior.

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
Room-scoped instances follow the same cleanup rules: closing a room does not
retire them, and a closed room cannot reopen. A new layout run creates new instances.

Private state keeps the authorable definition unchanged. Its `participants` map
uses the original key for shared instances and `<room>:<participant>` for
room-scoped instances, with `participant` and `room` metadata. Declared but unopened
rooms have no running instance. Status and task read models distinguish these
entries and resolve their original Agent Template. Existing snapshots without
`instance_scope` retain their original keys and require no migration. Snapshots
using `room` require a Fleet version that supports this field; they are not a
downgrade format for older Fleet versions.

Supported room fields: `goal`, `members`, optional `roles`, `contract`,
`quiet_membership`, `anonymous`. `contract` is briefing text.
Top-level fields: `version: 1`, optional `description`, `participants`, `rooms`.
Participant fields: optional `agent_template`, `instance_scope: layout|room`.
Unknown fields, ambiguous YAML and invalid member references are rejected.
Existing templates and tasks keep their behavior.

Local Fleet control uses the existing authenticated control socket,
agent runtime, `spawnTemp` and session queue. Cross-Fleet bindings delegate
membership operations to their owning Fleet as described below. Private state
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

## Borrowing an instance from another Fleet on the same host

Fleet A can open rooms using standalone temporary or persistent agents supervised
by Fleet B under another OS user. Both must select the same daemon instance and
Cowork gateway. An agent's original Fleet keeps its session, identity and lifecycle
control. This extends layout bindings; it does not add bindings to legacy
`room create` / RoomTemplate provisioning.

On the agent owner's Fleet B, use its existing web server and grant access to an
exact live standalone instance:

```sh
ours-fleet web serve --port 49272 --no-open
# In another terminal belonging to Fleet B's owner:
ours-fleet layout share Architect --temporary --participant architect \
  --server-url http://127.0.0.1:49272 --output ./architect.binding.yaml
```

The command prints the grant ID and output path. It creates a binding YAML and
an adjacent `.token` file, both owner-only. The private owner record stores a
SHA-256 token digest, not the token. `share` never overwrites an existing export.
Transfer both files explicitly to Fleet A's user through your existing secure
file-transfer method, keeping the receiving credential file owned by that user
with mode `0600`. Do not share Fleet B's console session, client profile, daemon
credential, private state directory or supervisor socket. This feature creates
no additional server; Fleet B's existing web server must remain available.

Export each specialist under its logical layout participant key, then merge the
YAML mappings into one bindings document. Keep every adjacent token filename
unique. Relative credential paths resolve against the bindings file's directory.
The reusable layout contains participant factories or empty participant mappings,
never concrete credentials or running-instance references:

```yaml
version: 1
participants:
  architect: {}
  developer: {}
  doctor: {}
rooms:
  product: {goal: Scope, members: [architect, doctor]}
  design: {goal: Design, members: [architect, developer, doctor]}
  delivery: {goal: Delivery, members: [developer, doctor]}
```

On Fleet A:

```sh
ours-fleet layout create project --id project-run --bindings ./bindings.yaml
ours-fleet layout open project-run product
ours-fleet layout open project-run design
ours-fleet layout open project-run delivery
ours-fleet layout close-room project-run product
ours-fleet layout close project-run
```

The exact CID, launch and harness session are reused. Reopening an active room
checks existing membership without delivering duplicate context. Closing rooms
archives Cowork history and never stops borrowed instances. After acceptance,
the original Fleet B owner explicitly retires its standalone temporary specialists
using the existing lifecycle commands. Persistent specialists keep their ordinary
lifecycle. Mixed local-created and borrowed participants are supported.

An exported reference adds `remote` to the existing instance reference:

```yaml
remote:
  url: http://127.0.0.1:49272
  grant_id: 11111111-1111-4111-8111-111111111111
  credential_file: architect.binding.yaml.token
  daemon_instance_id: 22222222-2222-4222-8222-222222222222
```

The grant authorizes only `verify`, `join`, and `assign` for that exact instance.
Room admission validates the requested room ID and CID against shared Cowork and
uses an invite issued by Cowork on the owner side; caller-supplied contact invites
are rejected before contact mutation. Context delivery also requires its active seat, expected room CID and role in
Cowork. It cannot inspect inventory, spawn, stop, reconfigure, export identities,
or authenticate browser console routes. It grants the holder room admission and
room-context delivery, so transfer it only to the intended room creator.

Owner-side revocation does not stop the agent or remove existing memberships:

```sh
ours-fleet layout revoke-binding <grant-id>
```

Stopped/replaced sessions, a different daemon, revoked grants or unavailable
owner transport produce errors; no replacement is spawned. A lost response to a
membership/context mutation retains the existing layout `uncertain` marker.
Inspect the native room and owning Fleet before retrying; no mutation is blindly
replayed. Only direct loopback HTTP origins (`127.0.0.1`) are supported;
redirects, external hosts and forwarded requests are rejected. No cross-host
support, discovery protocol, mission service, or room conversation limits are
introduced.
