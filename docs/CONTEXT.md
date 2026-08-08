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
bus. A project bus carries **at most one binding** — "many
interfaces on one medium" describes the physical/simulated bus,
not project bindings. A virtual-bus server simulates one bus with
N interfaces as nodes on it.

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

### Servers

**Cannet server**:
The production server — a headless process an operator launches on a
**server host** to make that host's CAN hardware reachable over the
network. It supervises vendor **sidecars** and exposes their
interfaces, unchanged, at a single endpoint the GUI connects to.
_Avoid_: "rig" / "rig mode" — the machine is a server host, the
process is the cannet server.

**Sidecar**:
A vendor-hardware driver process, reachable only from the machine it
runs on, supervised by whoever needs it — the GUI for local hardware,
a cannet server for remote hardware. Never addressed by the user
directly.
_Avoid_: "sidecar file" — that unrelated term names the forbidden
companion-file pattern (ADR 0010).

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

**Generator**:
A project rule that _derives_ a signal attribute from a partial regex
match on the signal's name — `Cell(\d+)` makes the captured number the
signal's color-wheel slot, so `Cell1…Cell16` read consistently
wherever they appear instead of taking hash-assigned colors. Rules are
ordered and the first one that both matches and yields a usable
capture wins; a signal no rule claims keeps its identity-hash color.
_Avoid_: "signal filter" — a generator selects nothing, it only
derives.

### Transmit

**Calculated field**:
A signal on a transmitted message whose value the host recomputes on
every send — a **sequence counter** (incrementing value with a
rollover) or a **CRC** (computed over a stated byte range of the
just-encoded payload, optionally prefixed with an E2E Data ID). The
designation lives in the DBC (`CannetCounter` / `CannetCrc`
attributes); overrides layer on top per message. Received frames with
a designation are verified at ingest.
_Avoid_: "checksum signal" — the mechanism covers counters too.

**Rest-of-bus simulation (RBS)**:
Transmitting a configured set of DBC messages on a cadence with live,
editable signal values — cannet plays every node except the device
under test. The config is a sparse-override `.cannet_rbs` document
the user owns — in memory until first saved, a file thereafter; the
project references it by path through an RBS element whose Run flag
(default off) is project-persisted.
_Avoid_: "remaining bus simulation" (Vector's term) in code — the
repo's name is RBS / rest-of-bus.

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

**Gridview**:
The shared tree/grid interaction base every grid-like view
instantiates — one row space of branch nodes and leaf rows, with a
row cursor, a selection, disclosures, and drag. A view supplies
rows and cell content; the gridview supplies the interaction.
_Avoid_: per-panel one-off row interaction.

**Branch node**:
A gridview row that structures other rows — expanding it adds its
children to the row space, collapsing removes them.

**Leaf row**:
A gridview row with no children. A leaf *with content* expands in
place — its content block (e.g. a trace row's decoded signals)
grows the row and adds no rows.
_Avoid_: "children" for a leaf's expanded content.

**Cursor (active row)**:
The one row a gridview's keyboard navigation is on. Not the
selection — moving the cursor collapses the selection to it.

**Selection**:
The set of gridview rows (and pattern chips) that mouse gestures
have selected; what a drag carries and a bulk action acts on.
Ephemeral — never persisted.

### Plot view

**Plot panel**:
A dockview panel that plots signals over time. Holds one or more
**plot areas**, the shared time (x) **scale** across them, and the
panel toolbar (fit, follow-live, show-points).

**Plot area**:
A curated group of **series** within a plot panel, plus its **y-axis
mode**. Its membership is either hand-picked (manual mode) or
computed from a name regex (filter mode) — see ADR 0020. A plot area
renders as one or more **axes**.
_Avoid_: "axis" for a plot area — an area can hold several axes.

**Y-axis mode**:
A plot-area property choosing how the area's series map to **axes**
and how each axis's y **scale** derives: **unified** (one axis,
series grouped by unit on a shared y scale), **per-unit** (one axis
per unit, plus one shared **enum-lanes axis** collecting all the
area's enums), or **individual** (one axis per series). Despite the
colloquial name, it tunes the _number of axes_ and the _y scale_, not
a single "y axis". y scales are always auto-derived — there is no
fixed-range mode.

**Axis**:
A single drawing surface: data plotted against one y **scale** and
the panel's shared x scale. Matplotlib's `Axes`. How many axes a
plot area has, and which series land on each, is the area's choice.
An axis renders its series in one of two styles: a normal **line**
(with optional points), or a **logic-analyzer lane**.
_Avoid_: "plot area" for a single axis; "axis" for a scale or ruler.

**Enum-lanes axis**:
The shared axis that per-unit mode gives an area's enum series. Each
enum is a horizontal **lane** (config order, top-first) with its
stepped waveform normalized into the lane's band and an opaque label
tile on each constant-value segment. A lane's y range is a _table
fact_ (the value table's raw min/max, padded), independent of
observed data / follow-live / Fit Y. The axis has no y gutter — the
tiles carry the labels, the side panel carries identity — and a
colormap (ADR 0029) tints tiles by value.

**Logic-analyzer lane**:
The lane render style described above. In an **enum-lanes axis** there
is one lane per enum. A single enum on its own axis (`individual`
mode, or a manual single-enum area) uses the older variant: one
centered horizontal label ribbon down the middle of the plot,
decoupled from the held value's y position so a tall value table
doesn't collapse the labels to a few pixels, with the stepped line
still drawn at the actual value. Under unified mode an enum plots as a
plain numeric line with no labels.

**Scale**:
The value dimension of an axis — its **y scale** (signal values) or
the shared **x scale** (time). Signals sharing a unit share a y
scale.
_Avoid_: "axis" for a scale; the surface is the axis, the dimension
is the scale.

**Series**:
One plotted signal on an axis. Color is per-series; any series can
be its axis's **primary signal**.
_Avoid_: "trace" for a plotted signal — the code's current "per-trace"
naming is this overload, on the list to retire.

**Primary signal**:
The series whose unit and value range drive an axis's visible y
**scale** labels. The user selects it by clicking a series (per plot
area). An axis that doesn't hold the area's primary — e.g. every
per-unit axis but one — labels through its own first ranged signal
instead. Either way the labels show real engineering values, never a
0–1 normalised ratio. (The blank-gutter **enum-lanes axis** is exempt:
its tiles carry the labels.)

**Axis weight** (fit-to-panel):
The vertical share a derived **axis** takes of its panel's height. All
of a panel's axes always fit (no stack scrolling); each carries a
flex-grow weight (default 1, persisted per axis id). A draggable
**splitter** between two adjacent axes trades weight between that pair
(conserving their sum); double-click equalizes them.

## Flagged ambiguities

**"trace"** was used for three different things: the captured data, the
chronological view panel, and a plotted signal. Resolved — **Capture**
for the data, **Trace** only for the chronological view, **Series** for
a plotted signal.

**"axis"** is the drawing surface (matplotlib's `Axes`), not the y/x
ruler — that dimension is the **scale**. The **y-axis mode** feature
keeps its colloquial name but tunes the number of axes and how the y
scale derives, not a single "y axis". See
[ADR 0026](adr/0026-plot-areas-compose-axes-configure.md).

## Example dialogue

— "How long can a capture run?"
— "Indefinitely. The raw frame store is the source of truth and spills
   to disk, so the capture isn't bounded by RAM."
— "Does the trace panel scroll all of it?"
— "Yes — the trace is a view. It windows the capture model, fetching
   only the rows on screen. The plot is the same, except a plot area
   shows one or more series, each a decimated window of a signal."
— "How are several signals with different units drawn together?"
— "That's the plot area's y-axis mode. In unified mode they share one
   axis — each unit group auto-scales to fill it, and the ticks show
   the primary signal's real units. In per-unit mode each unit gets
   its own axis; an enum gets its own axis too, drawn as a
   logic-analyzer lane."
— "Where do the decoded signal values live?"
— "In a derived projection, the decoded-signal cache. It's rebuildable
   from the raw frames, so it can be bounded — the raw store can't."
