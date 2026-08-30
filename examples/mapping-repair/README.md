# mapping-repair — a project with nothing mapped

A project whose mappings are absent: its database is assigned to no
bus, its plot series name no bus, and its run flags must not take
effect. It exists so the signal-mapping and RBS-mapping rules can be
demonstrated against a real file rather than described: **opening this
must not decode, resolve, or transmit anything until you map it.**

## Files

| File | What it is |
| --- | --- |
| `mapping-repair.cannet_prj` | One bus on an in-process virtual bus, the demo database assigned to *nothing*, a plot whose series carry no bus, and a periodic transmit message saved while it was running. |
| `mapping-repair.cannet_rbs` | A rest-of-bus simulation for the one bus, so the project has something to transmit if you start it yourself. |

It references `../cannet-demo.dbc`, so it needs no database of its own.

## The three shapes

| In the file | What must happen on open |
| --- | --- |
| `"dbcs": [{ "path": "../cannet-demo.dbc", "buses": [] }]` | A database assigned to no bus decodes nothing, on every consumer — and the Database rows say why rather than leaving the views silently empty. Assigning it to `Bus 1` is what brings the whole project to life, which is the demonstration. |
| Plot series with `"busId": null` | Series that name no bus. They must resolve — or fail to — without inventing a bus, and the signal-mapping panel is where the ones that cannot resolve are reported. |
| `"run": true` on the RBS element and on the transmit message | Opening a project never transmits. Both flags are stale keys today; the file still carries them, and the correct behaviour is that nothing starts sending when it opens. |

## Opening it by hand

Open `mapping-repair.cannet_prj`. Before touching anything:

- Nothing is transmitting. The RBS element and the transmit message are
  both stopped, despite what the file says.
- The trace and the plot decode nothing, because the database is scoped
  to no bus.

Then assign `cannet-demo.dbc` to `Bus 1` in the project panel, connect
(the bus is on an in-process virtual bus, so no hardware is needed) and
start the `Demo RBS` element. Everything comes up.

## What checks it

`project::tests::parses_the_checked_in_mapping_repair_example_project`
(`cannet-gui`) pins what the file *states* — the unassigned database, the
null-bus series and the persisted periodic. What it exists to
demonstrate — that none of it takes effect — is the behaviour those rules
are tested for elsewhere; this is the file to see it on.
