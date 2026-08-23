# Release notes — the work since 0.9.0

What changed for someone using cannet, across the tasks from 86 onward.

**Nothing here has merged.** It all sits on one linear branch chain off
`main`; this file is what the release will say, written while the chain
is still under review. No version number is claimed — the repo does not
carry one for this work yet.

Items marked **Fixed** repaired something that was broken. Items marked
**Changed** or **Removed** are deliberate behaviour changes you may
notice even though nothing was wrong.

---

## Opening a capture

- **Fixed:** a BLF written relative to capture start no longer draws
  negative times.
- **Fixed:** an import now keeps every frame inside the range you asked
  for.
  - Previously it stopped at the first out-of-range frame and never
    resumed.
  - On the measured file that lost 90 of 121 frames, including the two
    earliest.
- **Fixed:** a capture is anchored at its true earliest timestamp, not
  at whatever arrived first.
- **Fixed:** the import dialog shows a file's real earliest and latest
  times, not the first and last objects in file order.
- **Fixed:** a BLF whose writer crashed now opens. One missing trailing
  byte used to discard the whole file.
  - 16,387 frames recovered from the measured fixture; the file itself
    is never modified.
  - A system message says what was recovered, and that the absolute wall
    clock was lost.
- **New:** loading shows real progress — bytes scanned, then frames
  imported, then frames decoded.
- **New:** a Cancel button sits beside the progress bar and works during
  both load phases.
- **Fixed:** cancelling a large MDF import now actually stops. It used
  to keep building caches for the capture you discarded.
- **New:** an example set at `examples/time-origins/` shows how each
  kind of time origin behaves.

## Saving a capture

- **Fixed:** Save Capture no longer rewrites out-of-order timestamps. A
  saved BLF now matches what was captured.
  - The measured error was 500 ms of invented delay on one frame.
- **Fixed:** a saved BLF's header now states the capture's true end
  time, rather than its last-appended object.
- **Fixed:** MDF event blocks now carry the ASAM-correct marker type.
  Files already written stay mislabelled.
- **Changed:** an event's colour now fills a BLF marker's label instead
  of colouring its text.
  - Other tools will draw a solid coloured block where they drew thin
    coloured glyphs.

## Databases and decoding

- **Fixed:** a signal's enum labels now come from the database that
  actually decodes it.
- **Fixed:** a trace row and a plot no longer disagree about the same
  signal's value.
- **New:** a database assigned to no bus decodes nothing anywhere,
  instead of silently decoding every bus.
- **New:** unchecking a bus parks that database's caches; assigning it
  back brings the samples straight back.
- **New:** where two databases define one signal, you can pick which one
  wins. The pick is saved in the project.
- **New:** one pick also re-points every reference to a signal that was
  renamed in a newer DBC.
- **Fixed:** the Database panel no longer claims an unassigned database
  "applies to all buses".
- **New:** two databases defining the same id now warn on the losing
  row, naming which one wins.
- **Fixed:** a database edited on disk now reaches the plot, the
  filtered trace and the by-id view.
- **Fixed:** renaming a `VAL_` label updates the pickers and the plot
  without reopening the view.
- **Fixed:** the ingest verifier no longer borrows a counter or CRC
  designation from a database that does not supply the message.
- **New:** a plot series from a project older than per-bus binding is
  flagged as undecoded and can be re-pointed.

## The signal mapping panel

- **New:** a View Signals panel lists every signal your open views
  reference, and what currently decodes each one.
- **New:** its toolbar badge counts the signals needing attention, live,
  whether or not the panel is open.
- **New:** filter by status or by bus, wash rows by status, and sort by
  bus.
- **New:** an RBS signals grid shows every field's encoder status, so an
  override the encoder dropped is visible.
- **New:** RBS values clamp to the signal's physical range on entry,
  with out-of-range entries highlighted.
- **Fixed:** a hex value typed into the RBS panel goes out as raw bits,
  not as a decimal physical value.

## Plots

- **Fixed:** a signal on a shared axis renders at its real amplitude —
  the −200 A drawn as −1.5 is gone.
  - **Changed:** `unified` mode no longer stretches each unit group to
    fill the canvas. Use `per-unit` or `individual`.
- **Fixed:** enum y-axis ticks are bare numbers now; the quoted label
  beside every tick is gone.
- **Fixed:** a 300-value enum no longer draws 300 ticks. The count
  follows the axis's height.
- **Fixed:** a long enum label on a lane tile is ellipsized and drawn.
  It used to be omitted entirely.
- **Fixed:** a plot on a stopped capture re-reads after a database
  change, instead of holding the old decode.
- **New:** set a plot's visible range from the palette — two numbers for
  min and max, one for a width.
- **Fixed:** measurement statistics over a span no longer drop a sample
  when two samples share a timestamp.

## Long names

- **Fixed:** long signal, message and enum names render correctly on
  sixteen surfaces instead of overflowing or being cut.
  - Names ellipsize in the middle, so two names sharing a prefix stay
    distinguishable.
  - The full name is a tooltip everywhere it is shortened.
  - One pathological name can no longer reflow a whole panel.
- **New:** the shipped example databases carry long names and
  44-character enum labels.

## The trace and the grid views

- **Fixed:** clicking a signal inside an expanded row selects it instead
  of collapsing the message you were reading.
- **New:** disclosed signals are real rows — arrow keys, Shift+click
  ranges and drag-select all work inside them.
- **Fixed:** a timeline event now lands on the right trace row on an
  ordinary multi-bus capture.
  - The anchoring search assumed sorted timestamps; real captures dip
    several times a minute.
  - A marker could land on the wrong row, or be dropped with nothing
    said.
- **Fixed:** arrow-key navigation no longer rings the whole grid
  viewport with a browser focus outline.
- **New:** Space on an event row jumps to it; F2 renames it inline, in
  both the events view and the trace.
- **Fixed:** finishing an event rename hands the keyboard back to the
  grid. The arrow keys used to go dead.
- **Fixed:** an invalid palette prompt shows an inline error and stays
  open, instead of closing silently.
- **New:** jump the whole session to a time with `Mod+T`; go-to-event
  gains `Mod+E`.

## Events

- **New:** an event can say what it is *about* — signals, messages, or
  other events, mixed in one event.
- **New:** event rows carry subject chips naming the message or signal
  the event points at.
- **New:** Shift+click a plot area with signals selected to create an
  event about exactly those signals.
- **New:** right-click a trace frame row to create an event about that
  message, at that frame's time.
- **New:** hovering or selecting an event lights up what it points at
  and fades everything else.
- **New:** link two events, and the pair draws its extent as a coloured
  wash while either end is hovered.
- **New:** events have kinds, and every view has a per-kind checklist to
  show or hide each one.
- **New:** each event carries an editable description and a tag; the
  events view filters on both.
- **New:** subjects, links, tags and descriptions survive a save and
  reopen, in both BLF and MDF.
- **Fixed:** a BLF full of another tool's comments now survives a
  re-save. cannet used to drop every one.
- **Fixed:** deleting an event removes every other event's reference to
  it, so no chip points at nothing.

## Transmit and RBS

- **New:** Space sends a one-shot transmit row, or starts and stops a
  periodic one.
- **Fixed:** Space in the RBS panel enables or disables the row. It used
  to scroll the panel instead.
- **New:** the RBS signals list is a real grid — visible cursor,
  click-to-focus, arrow keys and Space.
- **Fixed:** opening a project can no longer put frames on a bus. RBS
  Run is no longer saved with the project.
- **Removed:** the kill switch. There is now one answer to "how do I
  stop transmitting".
- **New:** an RBS message row says whether it will transmit, and reads
  *Muted* when it cannot.
- **Fixed:** a counter or CRC declared in a DBC now populates the fields
  editor. The controls used to be empty.
- **New:** each populated field says whether it came from the DBC or
  from an override in this project.
- **Fixed:** a malformed `CannetCounter` attribute now names the text it
  choked on.
- **Fixed:** unassigning or reloading a database stops the RBS elements
  and periodics it was driving.
- **Fixed:** a transmit row's Start is no longer disabled by a
  disconnected bus, so it matches what Space does.

## Bus health and connections

- **New:** a bus health panel shows per-bus controller state, TEC and
  REC, bus load, error rate and adapter.
- **Fixed:** unplugging an adapter now reads "Adapter unavailable",
  drops that bus's load to 0 %, and parks its transmits.
  - The trace used to keep producing rows for frames that never reached
    a wire.
- **Fixed:** pulling the CAN cable now moves the readout. Controller
  state comes from the real error counters.
- **New:** Vector adapters report controller state through the same
  panel. Implemented but not yet tested on hardware.
- **Fixed:** an imported BLF's error frames read "Bus error" instead of
  looking like empty data frames.
- **New:** an error storm is summarised as one timeline event with a
  count and a time span.
- **New:** the status bar shows live bus load for the worst bus while
  connected.

## Servers

- **New:** `cannet-server` with no flags now serves every interface on
  `0.0.0.0:50051`.
- **New:** startup prints the address, certificate fingerprint and
  token, ready to paste into the GUI.
- **Fixed:** a server no longer advertises LAN addresses it does not
  serve, so discovery stops offering dead endpoints.
- **New:** the project panel always offers a way into the Servers panel,
  not only once a binding exists.
- **Changed:** a bare launch draws a second Windows Firewall prompt, on
  a different port from the mDNS one.

## Projects

- **New:** a **New** chip at the head of the top bar, available even
  with no project file open.
- **New:** a **Projects** menu and palette entries reopen recent
  projects, most recently used first.
- **New:** Save is a split chip — pressing Save just saves, and Save As
  sits behind the caret beside it.
- **Fixed:** a project or RBS file edited outside cannet is noticed
  instead of being silently ignored.
  - Clean and idle, it reloads itself; dirty or transmitting, you get a
    notice with Reload and Dismiss.
- **Fixed:** cannet's own Save is no longer mistaken for someone else's
  edit.
- **Fixed:** a broken or half-written file on disk is parsed before
  anything is applied, so your copy survives.
- **Fixed:** setting a recent-items limit to 0 now remembers nothing. It
  used to keep the newest entry.

## The interface

- **New:** the top bar is twelve chips rather than twenty text buttons —
  same commands, same order, denser.
- **New:** seven "add a panel" buttons collapsed behind one **Add ▾**
  menu.
- **New:** a status bar under the toolbar carries the numbers,
  right-aligned and tabular so they stop shifting.
- **New:** connect and disconnect is one chip showing real per-bus
  state, including partly connected.
- **New:** narrowing the window drops metrics in a fixed order and folds
  chips into a badged overflow menu.
- **New:** plot cursor mode is three icon buttons; points mode is a
  single cycling chip.
- **New:** the plot bar never wraps — controls that do not fit spill
  into a **…** menu.
- **New:** one drawn icon set across the app, so the same glyph means
  the same thing everywhere.
- **Fixed:** the bus-health icon no longer duplicates the signals icon;
  it is now a bus-topology drawing.
- **Removed:** the redundant Connect all / Disconnect all button. The
  status-bar chip is the one place.
- **Removed:** the plot's catalog-reload button — the catalog already
  refreshes itself.
- **Removed:** the measurements strip no longer draws, for anyone,
  pending rework. Saved preferences are kept.
- **Changed:** the Import chip keeps its label while loading, reporting
  busy on its hairline instead.
- **Changed:** toolbar labels are Title Case; the old sentence-case
  wording survives as the tooltip.

## Packaging

- **Changed:** Windows ships the NSIS `.exe` installer only. The MSI is
  gone.
  - Per-user and silent install without admin; anyone scripting the
    `.msi` has to switch.
