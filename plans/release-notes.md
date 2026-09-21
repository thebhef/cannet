# Release notes — the work on this branch

What changed for someone using cannet. Nothing here has merged: it sits
on one linear branch chain off `main`, and this file is what the release
will say while the chain is still under review. No version number is
claimed.

Items marked **New** did not exist before. **Changed** is a deliberate
difference you may notice even though nothing was wrong. **Fixed**
repaired something broken.

---

## Math signals

- **New:** the Database panel gains a third branch, **Computed**, holding
  signals you define yourself from other signals. Right-click the tree,
  pick a function, and the definition is created and expanded ready to
  fill in.
- **New:** seventeen functions — sum, difference, product, scale, min,
  max, average, median and range of a set, exponential filter,
  integration, derivative, duty cycle, frequency, a statistic over the
  whole capture, instantaneous RMS, and a constant horizontal line.
- **New:** operands are filled by dragging a signal in from anywhere, by
  a fuzzy-searched picker over the database tree, or — for a set — by a
  name pattern that keeps collecting signals as they appear. A math
  signal may take another math signal as an operand.
- **New:** a two-operand function's A and B are *slots*. A signal dropped
  on B while A is still empty is B's operand and stays B's; only a set
  closes up as it is edited, because its members are a membership rather
  than positions.
- **New:** what a pattern collects folds into one row reading the pattern
  and its count — `Cell.* (24 matches)` — which opens to the members on
  demand. A set over a battery pack is the pattern you wrote, not two
  dozen rows under it. Signals picked by hand stay listed one per row.
- **New:** every field commits as you leave it. There is no Save button,
  and each commit is one undo step, so Ctrl/Cmd+Z reverses a math edit
  like any other. Deleting a definition is one click on the trash beside
  its name, and undo brings it back whole.
- **New:** a definition is stored the moment its function is picked, even
  while it is unfinished. Every surface says what is still missing, and
  the signal serves nothing until it is complete.
- **New:** math signals drag onto plots and signal views like any other
  signal, and the Database panel's value column shows what each one
  currently evaluates to. Its disclosure opens the same editor in place,
  wherever it sits.
- **New:** a math row carries one bus color chip per bus feeding it —
  transitively, through any math operands — and reads "Math - Multiple
  Busses" when several do. In a signal view those chips sit in the
  message cell, the bus cell names the buses, and the `msg/s` column
  reports the computed series' own cadence. A constant line or a
  capture-wide statistic reports none: it is two points spanning the
  capture, not a series with a rate.
- **New:** Save Capture to MDF carries computed signals as channels in a
  Computed group. BLF carries frames only, and now names the computed
  signals it leaves behind alongside the file-backed ones.
- **Changed:** a constant line and a capture-wide statistic draw solid. A
  value you authored is data, not the plot extrapolating past it.
- **Fixed:** editing a definition redraws every plot and view showing it.
  The host recomputed correctly and nothing was told to ask again, so a
  plotted series went on drawing the numbers it held before the edit.
- **Fixed:** a capture-wide statistic draws as one flat line at the value
  it currently holds. A capture arrives in pieces, and each piece's
  answer was left beneath the line, so the statistic drew as the rising
  staircase that produced it.
- Definitions live in the project file under a stable id, so renaming one
  is safe. A pattern is resolved against the project's own bus names, so
  it stands up on the first look after a project opens and follows a bus
  rename.

## Units

- **New:** a math signal's unit is also its **conversion target**. Every
  operand whose own unit the app recognises is converted before the
  function runs, so a set matching milliamps beside amps computes
  correctly, each member scaled by its own factor. An operand that cannot
  be converted passes through unscaled and says so, rather than being
  converted wrongly.
- **New:** every function **derives** an output unit when you name none —
  a product of amps and seconds ships as `A·s`, an integration of a
  current over hours as `Ah`, a derivative of an amp-hour counter per
  second as `Ah/s`.
- **New:** a unit is chosen as a base unit and an SI prefix, in a
  two-column picker: base on the left, the whole prefix ladder on the
  right. It is offered in the math editor, on the View signals panel's
  unit chip, and on a plot series' unit readout. The library is the only
  way to name a conversion target — there is no box for a spelling of
  your own, because a name nothing converts through looked exactly like
  a unit that did. One an older project file stored still loads, still
  resolves and still displays.
- **Changed:** every list of units comes out in one order — what the unit
  measures, then the base unit, then up the prefix ladder. Voltage reads
  mV, V, kV, MV; charge reads mAh, Ah, C. A unit sits in the same place
  in the picker's base column, in a source-unit list and in the settings
  table alike.
- **New:** the picker is locked to the kind of thing being measured
  wherever choosing means a real conversion, and it offers the derived
  unit as a row of its own — picking that again clears an override, so
  there is no separate reset.
- **New:** time is a parameter of integration and derivative, chosen from
  the unit library. Changing it re-derives the output unit.
- **New:** picked operands carry a manual gain and offset and a
  source-unit override, for a database that describes a signal loosely or
  not at all. The definition itself takes an output gain and offset.
- **New:** converting a plot series through its unit readout merges it
  into that unit's lane — values and axis extent both.
- **Fixed:** converting a plot series takes effect where its values are
  *drawn*, not only where its unit is named. A stopped panel's window
  never moves, so the readout used to change while the curve stayed put;
  a reopened panel's saved unit likewise reached the plot only once
  something else happened to redraw it.
- **New:** what a DBC's unit *string* means is now editable, in Settings
  under **Unit customizations**: one row per unit, carrying the spellings
  that read as it. Each row's project and user checkboxes say where its
  mappings persist, and the project wins where both map one string.
  Changing an entry rescales every math signal that depends on it, and
  every plot showing one redraws.
- **Fixed:** a spelling added to or removed from that table shows up at
  once. It used to appear only after the panel was closed and reopened.
- **New:** a unit can also be **composed** from ones the app already
  knows, on the same table: a name, and the string it is built from.
  `VA` = `V * A`, `Nm` = `N * m`, `kVA` = `1000 * V * A`,
  `perSec` = `1 / s`. Terms are separated by `*` (or `·`) and `/`, a term
  that reads as a number is a plain factor, and a definition may name
  another one whatever order the two were entered in.
- **New:** a composed unit is a unit in every respect, not a label. It
  has a dimension and a conversion factor, it is recognised when a
  database spells its name, it is offered in the pickers in its
  dimension's place, and it converts against what it composes — `VA`
  reads in watts, `kVA` at ×1000. It persists at project or user scope
  like a spelling does, by the same checkboxes. A name already taken, a
  term that names nothing, or a malformed string is refused where it was
  typed, with the reason; a definition that later stops holding says why
  on its own row rather than quietly doing nothing.
- A `%` unit string reads as the 0–100 **percent** and `%1.0` as the
  bare 0–1 **ratio**. The spelling is the only thing that can say which:
  a DBC's unit field is free text and the numbers it carries are data,
  not a declaration. Both are defaults, so a project whose databases mean
  the other thing by either remaps it like any other spelling.
- **New:** a signal whose unit string the app cannot place is flagged in
  the View signals panel — a mark beside the name, and an **Unknown unit**
  filter in the toolbar showing exactly those rows. Adding the mapping
  clears the flag without reopening anything. A signal that declares no
  unit is never flagged.
- **New:** the View signals panel's unit column is also a repair surface.
  Reassigning a unit there is **reinterpretation**, not conversion: any
  unit may be chosen, kinds may cross, and no scaling is applied — the
  decoded value is simply read as the unit you chose, everywhere that
  signal appears. The choice persists with the project.
- **New:** that panel's unit column sorts like its neighbours —
  case-folded, so mV and MV sit beside V rather than on either side of
  it, with the rows declaring no unit grouped at the end whichever way
  the sort runs.
- **Fixed:** imported file-backed signals now appear in the View signals
  panel at all. They were skipped, so their units could not be inspected
  or repaired.
- Temperatures convert as absolute readings, so °C, °F and K are handled
  correctly rather than merely scaled.

## Export

- **Changed:** Export now opens a dialog before the save picker, settling
  what the file is called and which slice of the capture goes into it.
- **New:** the name is a template with a live preview. `{project}`,
  `{start}` and `{now}` resolve as you type, each also accepting an
  explicit time format. An invalid template is rejected in the preview,
  with the reason. The template, folder and format are remembered for
  next time.
- **New:** the range defaults to the whole capture, up to the live edge
  when the write finishes. A timeline over the capture takes both bounds,
  with the capture's own events as clickable ticks, and presets for the
  whole capture, the last 1 / 5 / 30 minutes, and the window the plot is
  showing. Each bound is also a text field taking a wall-clock time,
  seconds from the start, or one of the capture's events.
- **New:** a clock bound in a capture that runs longer than a day takes a
  day prefix: `3d 12:30:00` is half past noon on the capture's fourth
  day, counted in local calendar days from the day it started. A bound
  past the first midnight also *reads back* with its prefix, so two
  instants days apart cannot show as the same string. A bare clock keeps
  its short meaning — the capture's own day, or the next one when it is
  earlier than the start — while an explicit day never rolls, so one
  landing before the capture starts is refused rather than pushed
  forward.
- **Changed:** the write runs in the background and the app stays live. A
  status-bar chip names the file and its progress and carries a Cancel;
  cancelling stops the write and removes the partial file.
- A capture with no wall-clock anchor takes and shows seconds from the
  start only — there are no instants to name.

## Very large captures

- **Fixed:** exporting a very large capture as BLF no longer kills the
  app. The BLF writer copied the whole capture into memory before writing
  a byte — around 80 GB for a six-day, 546-million-frame capture — and
  the allocation that finally failed took the process down with nothing
  in the log. It walks the capture in chunks now, as the MDF writer
  already did.
- **Fixed:** reopening the app over a large restored capture no longer
  freezes it. The first lookup of a time on the capture's timeline walked
  all of its metadata at once, on the thread that draws the window — 40
  to 80 seconds of a frozen app on a six-day capture, once per launch.
  That index is now built as the capture is written and saved beside it,
  so a restored capture comes back with it and only has to catch up on
  whatever arrived after the last flush.

## Loggers

- **New:** a **logger** is a project element that writes the capture to
  disk while it is switched on. Add one from the toolbar's Add menu or
  the palette.
- **New:** its panel takes a folder and a file, both templates resolved
  by the same tokens an export name uses, plus a preview, a format and a
  size cap. `{logger}` is available inside a logger, and its `{now}` is
  the moment logging started, so every file of one run shares it.
- **New:** logging runs exactly while the logger is enabled and something
  is connected. Connecting starts it, disconnecting stops it. Unlike the
  RBS Run flag, the enabled flag is saved with the project — logging
  writes locally and puts nothing on a bus.
- **New:** reaching the size cap closes the file and opens the next, with
  `-002`, `-003`… before the extension. A run that starts where files
  already sit takes the next free suffix, so it never overwrites them.
- **New:** the panel lists the folder's contents recursively, with columns
  for name, size, trace start and end, duration, message count and
  modified time. The file being written right now is the list's own live
  row, with its size and count growing — there is no separate status line.
- **New:** importing a file from that list — the row button, its context
  menu, or Space — opens the same import flow "Import trace…" does, range
  picker included. A folder's context menu offers Show in Explorer.
- A folder or file template may be typed with either separator and always
  resolves in the running OS's own, so the default `logs/{logger}` is one
  subdirectory on Windows and on macOS alike and a project written on
  either opens correctly on the other.

## Project panel

- **Changed:** the Elements, logical-bus and DBC rows trade text buttons
  for icons. Focus and Open collapse into one "go to it" button.
- **Changed:** removing an element is a single click, since element
  removal is undoable. Removing a bus or a DBC keeps its confirm step,
  because neither is.
- **New:** a logger or RBS row carries a play/stop toggle, reading and
  writing the same state that element's own panel does. It is tinted by
  whether that element's own buses are connected.
- **Changed:** the two Discover buttons in connection management are now
  icon buttons.

## Plot

- **Changed:** `Points: On` marks every sample the plot is served, with
  no cap. There used to be a flat 500-marker limit spread evenly along
  the visible range, and an even stride over a min/max envelope lands
  on one leg of it — a run of dots hugging one side of a line that
  swings through both, which read as the plot extrapolating. The dots
  now sit on every extreme the line passes through.
- **Changed:** an enum lane is an ordinary series with tiles drawn over
  it. Its markers are the same markers every other series gets, on the
  plotted value, in an ink that reads over the tile, and they no
  longer appear and vanish with zoom. A state held across a wide
  window is one tile, as before.
- **Changed:** cursor and event readouts leave the data area. Event
  labels sit in a band above the top plot; the A and B time readouts
  and Δt sit between the bottom plot and its time axis; the H1 and H2
  value readouts and ΔH sit in the value gutter beside their axis. The
  cursor lines themselves stay where they were. A panel with events
  gives up 34 pixels of plot height for the two bands, 47 when a label
  wraps to two lines.
- **Changed:** an empty plot area still draws the shared time grid and
  ticks, and takes the A and B cursors by click. A panel with no
  signals anywhere shows the capture's span and follows live, so a
  fresh panel is a timeline rather than a blank.
- **Changed:** the plot toolbar carries an **Events** chip that reveals
  the event-kind checklist — which kinds show as markers, bus errors
  included. The copy that lived only in the toolbar's right-click menu
  is gone, so there is one control. Each plot keeps its own choice.
- **Fixed:** an empty area beside a populated one no longer blanks
  every event marker on the panel.

## Trace panel

- **New:** a filter box in the toolbar narrows the rows in both modes
  as you type. It searches the bus name, the message name, its
  transmitting ECU, its id in hex and decimal, the signal names, and
  the label of a decoded signal's current enum value; event rows are
  matched on their text. Fuzzy, the way the Database panel's search
  is, and ranked the same way, so `pkstat` finds `PackStatus`.
  Clearing the box restores the full view.
- The filter composes with the panel's sources, show-events and
  collapse-error-frames — it narrows further, never replaces. The
  chronological trace stays paged end to end while a query is active:
  the host does the matching over the whole capture, and the panel
  still shows one page plus the live tail. Ctrl/Cmd+F focuses the
  box. The text is remembered with the layout and never dirties the
  project.

## Connecting

- **New:** a bus can be set to **no interface** on purpose. Picking
  "— no interface —" in the project panel now records that choice
  with the project instead of deleting the binding, and a project with
  such a bus connects: the bound buses go live, the unbound one reads
  "unbound" in the connection chip's tooltip, the project graph and
  the bus-health panel, and anything transmitted at it is marked
  undelivered. A bus that simply has no binding is still refused, as
  before — that is a bus nobody has wired up, not one set aside.
- **New:** the Servers panel greys out a server that does not speak
  this build's protocol, with the reason, before you can connect to
  it; and a connection to one is refused with the same sentence
  instead of retrying forever. See *For application developers*.

## Small fixes

- **Fixed:** which cursor mode a plot toolbar is in is readable again. A
  pressed chip inside a segmented control was, to the eye, the same chip
  as the ones beside it — in the dark theme especially. It now takes the
  accent edge, fill and label a pressed chip outside a segment already
  took, everywhere a segment is a "which one is on" choice: the plot's
  cursor modes and solo paging, and the trace panel's trace mode.
- **Fixed:** a long comment in the Database panel no longer squeezes a
  signal's value out of its own cell. The comment gives up width first
  now; the name and the value hold theirs, so a value is never shown
  without the unit that sits at the end of it.
- **Fixed:** Ctrl/Cmd+F now works in the Settings panel — it focuses the
  search box and selects what is in it, as it already did in the Database
  panel.
- **Fixed:** the Database panel's search box takes a click anywhere in the
  box it draws, not only over the first few characters.
- **Fixed:** on Windows, the mouse pointer no longer vanishes after typing
  in the command palette — most visibly when Enter raised the Open
  dialog and the pointer stayed hidden over the whole window. WebView2
  runtime 152 began honouring the Windows "Hide pointer while typing"
  setting and keeps the pointer hidden until the webview itself sees a
  mouse move; cannet never wanted the pointer hidden, so the window now
  turns that feature off.
- **Fixed:** the Database and RBS trees collapse and expand normally
  while a filter string is present. Typing a query still opens the
  path to every match; from then on the chevron and the arrow keys
  work on any row, so a bus, database or ECU you are not interested in
  folds away and stays folded until you open it or clear the filter.

## For application developers

- **New:** a Python client, `clients/cannet-python-client`, registers
  cannet as a python-can interface. An application opens a remote bus with
  `can.Bus(interface="cannet", server=..., channel=...)` — no
  cannet-specific import, and no credential pasted into application code.
  `recv`, iteration, listeners, `send`, `shutdown` and `state` all behave
  as python-can expects.
- The server named in `server=` is resolved against the same trust store
  the GUI writes, so accepting a server stays a decision a person makes in
  the GUI. The library reads that store and never writes it. An unknown
  non-loopback server raises rather than guessing.
- Delivered frame timestamps are corrected for the peer's clock, and
  `can.detect_available_configs()` lists the interfaces every trusted
  server currently offers.
- **New:** the wire protocol states its version, and every client
  checks it. The protobuf package name — `cannet.v1`, already in every
  gRPC method path — is the protocol major. Inside a major only
  additive changes land; a breaking change is a new package served
  beside the old one for a deprecation window, so an existing client
  keeps working until it migrates. The rule is written in the header
  of `cannet.proto`.
- **New:** every server answers `ServerInfo` — the packages it serves,
  its build version and its instance name — in a small unversioned
  package of its own, without a token, so a client whose major the
  server does not serve is told "serves cannet.v2; this client speaks
  cannet.v1" rather than an opaque `UNIMPLEMENTED`, and before it is
  asked for a credential. Servers also advertise the packages they
  serve over mDNS as `proto=`.
- **New:** a console script, **`cannet-client`**, does the trust
  workflow without the GUI. `list` browses the network and merges it
  with the trust store — one row per server with its trust state,
  whether it is answering, and the protocol it serves; `connect`
  walks the same paths the GUI's Servers panel does (loopback in the
  clear, a pinned server verified against its stored fingerprint, a
  first contact shown for you to compare and confirm, an explicit
  question before connecting unprotected) and ends by printing the
  working `can.Bus(...)` line; `forget` removes a server's entry. It
  writes the same `servers.json` the GUI owns, so accepting once
  serves every client on the machine.
- CI now refuses a non-additive change inside `cannet.v1` and a
  checked-in Python stub that no longer matches the `.proto`.
