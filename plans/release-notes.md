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
- **New:** sixteen functions — sum, difference, product, scale, min, max,
  average, median and range of a set, exponential filter, integration,
  derivative, duty cycle, frequency, a statistic over the whole capture,
  instantaneous RMS, and a constant horizontal line.
- **New:** operands are filled by dragging a signal in from anywhere, by
  a fuzzy-searched picker over the database tree, or — for a set — by a
  name pattern that keeps collecting signals as they appear. A math
  signal may take another math signal as an operand.
- **New:** every field commits as you leave it. There is no Save button,
  and each commit is one undo step, so Ctrl/Cmd+Z reverses a math edit
  like any other. Deleting a definition is one click on the trash beside
  its name, and undo brings it back whole.
- **New:** a definition is stored the moment its function is picked, even
  while it is unfinished. Every surface says what is still missing, and
  the signal serves nothing until it is complete.
- **New:** math signals drag onto plots and signal views like any other
  signal, and the Database panel's value column shows what each one
  currently evaluates to. A math row carries one bus color chip per bus
  feeding it, and reads "Math - Multiple Busses" when several do. Its
  disclosure opens the same editor in place, wherever it sits.
- **New:** Save Capture to MDF carries computed signals as channels in a
  Computed group. BLF carries frames only, and now names the computed
  signals it leaves behind alongside the file-backed ones.
- **Changed:** a constant line and a capture-wide statistic draw solid. A
  value you authored is data, not the plot extrapolating past it.
- Definitions live in the project file under a stable id, so renaming one
  is safe.

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
  unit chip, and on a plot series' unit readout.
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
- **New:** what a DBC's unit *string* means is now editable, in Settings
  under **Unit customizations**: one row per unit, carrying the spellings
  that read as it. Each row's project and user checkboxes say where its
  mappings persist, and the project wins where both map one string.
  Changing an entry rescales every math signal that depends on it.
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
- **Changed:** the write runs in the background and the app stays live. A
  status-bar chip names the file and its progress and carries a Cancel;
  cancelling stops the write and removes the partial file.
- A capture with no wall-clock anchor takes and shows seconds from the
  start only — there are no instants to name.

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

## Small fixes

- **Fixed:** Ctrl/Cmd+F now works in the Settings panel — it focuses the
  search box and selects what is in it, as it already did in the Database
  panel.
- **Fixed:** the Database panel's search box takes a click anywhere in the
  box it draws, not only over the first few characters.

## For application developers

- **New:** a Python client, `servers/cannet-python-client`, registers
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
