# extrapolation — every extrapolated shape, on one plot

A tiny synthetic capture whose only job is to put **every stretch a plot
draws without data behind it** in front of a renderer at once, so the
extrapolation rendering ruled in
[ADR 0026](../../docs/adr/0026-sparse-series-render-rules.md) can be
photographed rather than described.

Nothing here is a realistic bus. Every series is the smallest thing that
produces one ruled shape.

## Files

| File | What it is |
| --- | --- |
| `extrapolation.dbc` | Seven single-signal messages — four numeric, three enum with `VAL_` tables. |
| `extrapolation.blf` | 20 s, 871 frames, ~5 KB. Deterministic; no RNG, no wall clock. |
| `generate_blf.py` | The generator. Every timestamp and payload is a function of its constants. |
| `extrapolation.cannet_prj` | One bus, one plot panel, one per-unit area holding all seven series. |

## The shapes

A stretch is extrapolation when it is **not bounded by a sample on each
side**, or when it is an interior gap longer than **10×** the series' own
raw cadence. `RefLevel` exists only to carry the window's right edge out
to 20 s — without it, every other series' last sample would *be* the edge
and there would be no tail to draw.

| Series | Cadence | Arrives | Renders as |
| --- | --- | --- | --- |
| `RefLevel` | 50 ms | 0 – 20 s | solid throughout — the control, and the window's right edge |
| `StoppedLevel` | 50 ms | 0 – 8 s | solid, then **dashed** 8 – 20 s |
| `StalledLevel` | 100 ms | 0 – 6 s, 13 – 20 s | **dashed interior** 6 – 13 s (70× its cadence) |
| `OneShotLevel` | — | one frame at 10 s | a horizontal line, **dashed on both wings** |
| `DenseMode` | 200 ms | 0 – 20 s | solid tiles + lane sample markers — the control lane |
| `StoppedMode` | 500 ms | 0 – 6 s | one tile opened at 3 s, **striped** from 6 s to the edge |
| `StalledMode` | 200 ms | 0 – 7 s, 15 – 20 s | one held tile **striped in its middle**, 7 – 15 s |

The four numeric series share the `%` unit, so per-unit mode puts them on
one numeric axis; the three enums land on the area's single shared
enum-lanes axis. Their value bands are separated so one series' dashes
are never read as another's.

## Regenerating

```sh
uv run --with python-can --with cantools \
    examples/extrapolation/generate_blf.py
```

The generator is deterministic, so a regeneration with no edits produces
a byte-identical file.

## What checks it

- `signal_cache::tests::the_screenshot_fixture_exhibits_every_ruled_extrapolated_shape`
  (`cannet-gui`) reads this BLF through the real reader, decodes it
  against this DBC, and asserts each series' classified spans. The
  captures are eyeballed rather than diffed, so this is what would
  notice a fixture that stopped exhibiting a shape.
- `project::tests::parses_the_checked_in_extrapolation_example_project`
  keeps the project openable and its one area whole.

## Opening it

Open `extrapolation.cannet_prj`, then import `extrapolation.blf`
(**Import trace…**, or the toolbar's **Recent** menu once it has been
opened once). The BLF's single channel maps onto the project's single
bus, so the channel dialog's defaults are already right — press
**Open**. Press `f` over the plot to fit the x axis to the capture.
