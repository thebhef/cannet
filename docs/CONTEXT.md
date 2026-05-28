# cannet

cannet is a CAN bus traffic analyzer: a Tauri GUI renders windowed
views over a host-side model of CAN frames captured from a BLF replay,
real hardware (via per-vendor servers / sidecars), or a loopback bus.

This file is a glossary — the project's shared language. It is not a
spec and carries no implementation detail.

## Language

### Bus and transport

**Bus**:
A logical CAN bus — one shared medium. Multiple **interfaces** can
sit on the same bus and see each other's traffic. In the project,
buses are first-class: a Project Bus carries name and bit-rate,
and **interface bindings** map a server's interface onto a project
bus. A virtual-bus server simulates one bus with N interfaces as
nodes on it.

**Interface**:
The wire-level endpoint a server exposes — what a client subscribes
to. One interface represents one node's view of a bus. A server
publishes an interface set through `ListInterfaces` /
`WatchInterfaces`; a session subscribes by `interface_id`. On the
virtual-bus server, a `Subscribe` is also an **exclusive claim** —
one session at a time owns an interface, mirroring how only one
node occupies a hardware port.
_Avoid_: "channel" for an interface (CAN-FD channel numbering is a
separate, BLF-internal thing).

### Data and model

**Capture**:
The recorded stream of CAN frames from one session, of indefinite
length. The live capture and a saved `.blf` are the same logical thing
in different storage; "Save Capture" persists it.
_Avoid_: "trace" for the data, "log".

**Capture model**:
The host-side representation of the open capture — the source-of-truth
raw frame store plus its derived projections. The GUI never owns
capture data; it renders windows over the capture model.
_Avoid_: "TraceStore" as a name for the whole model — that code symbol
is only the raw-frame part.

**Derived projection**:
A host-side structure computed from the raw frames and kept current as
they arrive — the decoded-signal cache and the latest-by-id index.
Bounded and rebuildable from the raw store; never a second source of
truth.

**Filter predicate**:
A frame-matching condition (by id, bus, signal value, …). Applying one
narrows every data view to the matching frames — the filtered Trace
lists them in order, the filtered By-ID view is a keyed snapshot
recomputed over them. The predicate defines the subset; it is not
itself a view.

### Views

**View**:
A GUI panel that renders a bounded window of the capture model. A view
owns only its scroll position, selection, and rendering — never capture
data, nor a model fact (order, extent, rate, decimation).

**Trace**:
The chronological view of a capture — frames in arrival order. Names a
*view*, never the data.
_Avoid_: "trace" for the capture itself, or for a plotted signal.

**By-ID view**:
The keyed snapshot of a capture — one summary row per arbitration id
(its latest frame plus stats: count, period, last payload). Bounded by
id-space, not by capture length.

**Series**:
One plotted signal in a plot area. Per-signal normalisation and colour
are per-series.
_Avoid_: "trace" for a plotted signal — the code's current "per-trace"
naming is this overload, on the list to retire.

## Flagged ambiguities

**"trace"** was used for three different things: the captured data, the
chronological view panel, and a plotted signal. Resolved — **Capture**
for the data, **Trace** only for the chronological view, **Series** for
a plotted signal.

## Example dialogue

— "How long can a capture run?"
— "Indefinitely. The raw frame store is the source of truth and spills
   to disk, so the capture isn't bounded by RAM."
— "Does the trace panel scroll all of it?"
— "Yes — the trace is a view. It windows the capture model, fetching
   only the rows on screen. The plot is the same, except a plot area
   shows one or more series, each a decimated window of a signal."
— "Where do the decoded signal values live?"
— "In a derived projection, the decoded-signal cache. It's rebuildable
   from the raw frames, so it can be bounded — the raw store can't."
