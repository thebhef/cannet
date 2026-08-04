# Task 48 — Miscellaneous Fixes

A collection of independent defects found by using the app. They share
no design and gate nothing; they are grouped so they get scheduled at
all rather than living in the backlog until they rot.

**Each item is independently shippable.** Land them in whatever order
suits, one commit each, and strike them from this list as they go. Fix
bugs by writing the failing test first — several of these are timing or
layout bugs whose reproduction is the hard half.

## 1. A plot's cached window is discarded 250 ms after mount — **done**

Fixed in `PlotArea`: the uPlot construction effect now drops the cached
window only when the signal set actually changed; every other rebuild
repaints the fresh instance from `useDecimatedRange`'s `current()`
snapshot instead of forcing a full-window refetch. Guarded by
"the post-mount rebuild repaints the fresh uPlot from the cached window"
in `PlotPanel.dom.test.tsx`.

## 2. The first sample of a signal set is slow on a cold cache

Separate from item 1 and host-side. After a disk-cache reload the
decimation pyramids are cold, so the first `sample_signals` for a given
signal set builds them on demand — seconds on a real capture. Item 1
makes every panel pay that twice; fixing item 1 does not make the first
payment cheap.

Observed as load times that vary between plot panels (different signal
sets, different work) and that do not reliably improve on a second
visit.

Worth deciding: warm the pyramids for restored areas' signals during
reload, make the first sample cheap, or show progress rather than a
blank canvas. Measure before choosing — the cost has not been attributed
to a specific stage.

## 3. Integer signals render in scientific notation

A `uint64` signal displays as scientific notation. Signals whose type is
a signed or unsigned integer should render as **hex**, not as a float.

**Decided — hex applies to raw fields only.** A literal reading ("every
integer-typed signal") would hex every non-float DBC signal, so an engine
speed of 1000 rpm would read `0x3E8`. The rule instead is: render hex when
the signal is integer-typed **and** `factor == 1` **and** `offset == 0`
**and** it carries no unit — which is exactly the bit-pattern / id /
serial case the `uint64` is. Anything scaled, offset, or carrying a unit
stays decimal.

Separately and unconditionally: an exact-integer value never renders in
scientific notation. `toExponential` above 1e6 is what made the `uint64`
unreadable, and it is lossy for a value the user needs digit-exact.

`SignalRecord` carries only the physical value today, so the predicate is
computed host-side and travels as a flag on the record — the model owns
the domain fact, the frontend only renders it.

Open sub-question for whoever takes this: a signal with a `VAL_` table
matches the predicate (enums are unscaled and unitless), which would turn
`3 "Drive"` into `0x03 "Drive"`. Existing tests assert the decimal form.
Excluding value-table signals from the hex rule is the suggested
reading — the raw number there is a table key the DBC itself writes in
decimal.

## 4. The unit reads as part of the value in the signal panel

The unit is visually glued to the value string, so a row reads as one
token rather than a value and its unit.

## 5. Dock panels do not scroll

Two instances, likely one fix:

- **Project panel has no scroll.** At 1024 px vertical it is unusable —
  the DBC mapping could not be verified because it could not be reached.
- **By-ID panel does not grow to accommodate expanded signals**, and
  cannot be scrolled to the bottom when its content is taller than the
  window.

## 6. The window hangs or stops rendering after sitting live

Observed while scrolling up in the by-ID trace panel after the app had
been live for a while. **RDP may be involved** — it was present when
observed, and a remote-desktop compositor is a plausible participant in
a WebView repaint stall, so establish whether it reproduces locally
before hunting in app code.

## 7. Transmit panel: the sequence editor disappears mid-edit

Adding a sequence, then changing the signal-selection combobox, makes
the window disappear. No change is applied.

## 8. Per-unit y-axis scaling is wrong

Two symptoms on the per-unit axis mode, possibly one cause:

- **Hidden signals still affect the y limits.** A hidden 3000 A
  "nominal" current limit still sets the scale for a visible 500 A
  "effective" limit.
- **Same-unit signals do not share a scale.** Despite per-unit mode, the
  3 k value does not appear to be on the same scale as the 500 A one,
  which is what per-unit mode exists to guarantee (ADR 0026).

## Exit criteria

- Every item above is fixed or struck with a recorded reason, and this
  file is deleted when the list empties.
- Each fix lands with a test that fails before it.
- Items 1 and 8 touch plot behaviour that ADR 0026 governs; if a fix
  contradicts that ADR, the ADR changes in the same commit.
