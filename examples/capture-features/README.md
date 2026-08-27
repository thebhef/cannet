# capture-features — everything a capture file can carry

The demo trace (`../cannet-demo.blf`) shows what ordinary traffic looks
like. This set shows everything *else* a capture file holds: the
annotation records, the colour states, the payload kinds that are not
data frames, the series with no frame behind them, and the two states a
file can be in that are not "finished".

Everything here decodes against `../cannet-demo.dbc` — the same database
the demo trace uses — so the set needs no database of its own.

## Files

| File | What it is |
| --- | --- |
| `annotated.blf` | 2 s, ~200 frames, ~2.4 KB. Every annotation record a BLF has, on two channels. |
| `annotated.mf4` | The same two seconds as ASAM MDF 4.10, ~19 KB, plus the things MDF has a place for and BLF does not. |
| `interrupted.blf.part` | ~57 KB. A capture whose writer was killed mid-run: real data, placeholder header. |
| `interrupted-tail.blf.part` | The same file with its last 4 KB cut away, so the final container ends mid-object. |
| `capture-features.cannet_prj` | Project: two buses — one on an in-process virtual bus, one deliberately unbound — with the demo database scoped to both. |
| `capture-features.cannet_rbs` | A rest-of-bus simulation for the virtual bus, so the project transmits with no adapter plugged in. |

## What `annotated.blf` demonstrates

| Record | On screen |
| --- | --- |
| `GLOBAL_MARKER` × 5 | Five timeline events in the events view and along the trace. |
| A **black** event (`#000000`) | Black is a colour someone picked. The record's two colour fields are the only thing that tells it from an uncoloured event, and both are in this file. |
| An **uncoloured** event | The control the black one is read against — the neutral default. |
| `cannet-event/1` blocks | Tags, and structural subjects: a signal (`0x100 VehSpeed`), a message (`0x18FF40E5/ext`), and a link to another event. |
| An event of kind `busError` | A kind that hides itself until the event filter asks for it. |
| A block from a **later** schema version | Its `severity: high` line is one this build has no field for. It must survive a save → open round trip verbatim. |
| `EVENT_COMMENT` | A message-bound event: no name or colour field of its own, so its block carries both, and the object type it is attached to (`86`, `CAN_MESSAGE2`) is written in the record *and* the block. |
| Error frames × 2, remote frame × 1 | Trace rows that are not data frames — one on a standard id, one on an extended one. |
| Two channels | Channel 2 carries a thin second stream, so importing into a project with one bus leaves a channel to map or to drop. |

## What `annotated.mf4` adds

| Content | On screen |
| --- | --- |
| Six `##EV` blocks | The same events, plus one written by another tool with no `cannet-event/1` block at all — it gets a synthetic id and keeps its prose. |
| A native begin/end range pair | MDF's own typed span. This project stores nothing in it and reads it back as one more untyped link between two events. |
| `Ambient` / `Charger` signal groups | Series recorded directly, with no frame behind them: `AmbientTemp` (degC), `CabinHumidity` (%), `ContactorState`. |
| A **coded** series | `ContactorState`'s conversion block is a value→text table (`Open` / `Precharge` / `Closed` / `Fault`), so its lane renders labels with no database in play. |
| A **descending master** | `CabinHumidity`'s samples are written newest first. No file this project writes does that; plenty of foreign ones do. It must read back ascending, with each value still on its own timestamp. |
| Records out of order | Two data frames are written after frames that follow them in time. |
| Error and remote frames | In `CAN_ErrorFrame` and `CAN_RemoteFrame` groups of their own. |

## What the two `.part` files demonstrate

A `BlfCaptureWriter` streams to `<name>.blf.part` and renames into place
when it finishes, so a crash never leaves a half-file at the destination
— it leaves the `.part`. These are that state, produced the only way it
can be: by not finishing.

- **`interrupted.blf.part`** carries the placeholder header its writer
  stamped at open, with the measurement start time already in it (the
  anchor reaches disk the moment it is latched, not at `finish`).
  Everything the writer flushed is recoverable; the last buffer's worth,
  which never reached disk, is gone. Opening it must **not** rewrite it:
  the file is byte-identical afterwards.
- **`interrupted-tail.blf.part`** is the same file cut mid-container. The
  reader stops at the last complete object and says how much it lost,
  rather than refusing the file.

## Opening it by hand

Open `capture-features.cannet_prj`, then import `annotated.blf`
(**Import trace…**). The BLF's channel 1 maps onto `Main`; channel 2 is
the one to leave unmapped or to send to `Aux`. Repeat with
`annotated.mf4` for the MDF side, and with either `.part` for the
recovery case.

`Main` is bound to an in-process virtual bus, so **Connect** and then
running the `Loopback RBS` element transmits and receives with no
hardware attached. `Aux` is bound to nothing on purpose — connecting
with it in the project is what a refusal has to name.

## Regenerating

Both generators use cannet's own writers, so they need no Python:

```sh
cargo run -p cannet-blf --example gen_annotated_blf
cargo run -p cannet-mdf --example gen_annotated_mdf
```

Nothing here seeds an RNG or reads a clock, so a regeneration with no
edits produces byte-identical files. The project, the RBS and this README
are hand-written.

## The one file that is not here: a large capture

Two surfaces only show themselves at scale — determinate load progress
with a discoverable cancel, and a stopped capture's bounded window scan.
Both need **millions** of frames, which is tens of megabytes: the wrong
thing to commit next to a set whose whole point is that it stays small
and openable by hand. So the generator writes one on demand instead, to
wherever you point it, and nothing commits it:

```sh
cargo run --release -p cannet-blf --example gen_annotated_blf -- \
    <some-scratch-dir> 2000000
```

That writes `<some-scratch-dir>/large.blf` — 2 000 000 `VehicleState`
frames at 1 ms plus the other two messages, about 18 MB, decodable
against `../cannet-demo.dbc` like everything else here.

## What checks it

- `crates/cannet-blf/tests/capture_features_fixture.rs` — the colour
  pair, every annotation shape, both channels, every payload kind, and
  both `.part` files' recovery.
- `crates/cannet-mdf/tests/capture_features_fixture.rs` — the coded
  series, the descending master read back ascending, the native range
  pair, and the payload kinds.
- `project::tests::parses_the_checked_in_capture_features_example_project`
  and `rbs::runtime::tests::the_demo_database_rbs_fixtures_resolve_against_it`
  (`cannet-gui`) — the project stays openable with its virtual bus and
  its unbound bus, and the RBS keeps resolving against the demo database.

These are demo files: they are looked at by hand, not diffed. Without
those tests nothing would notice a regeneration that quietly stopped
carrying one of the things this README promises.
