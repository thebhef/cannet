# Import time origins

Three tiny captures — one DBC, two BLFs, one MF4 — that pin down where
an imported capture's timeline starts. They exist because "what is
`t = 0` for a file I just opened?" is answered by the file, and the two
formats state it differently (or not at all).

Open any of them in the GUI with `time-origins.dbc` attached; each is
about two seconds long and a couple of kilobytes.

## Files

| File | What it states | Why it exists |
|---|---|---|
| `time-origins.dbc` | `EngineData` (`0x100`: `Rpm`, `CoolantTemp`) and `Status` (`0x200`: `Mode` with a `VAL_` table, `Counter`). | Something to plot the fixtures against. |
| `relative-zero.blf` | **No** start time — the all-zero "unset" `SYSTEMTIME`. Frames run from 0 s to 1.98 s, plus one marker at 1 s. | The capture is relative: its own zero is the origin, and it names no instant. This is the shape `python-can`'s `BLFWriter` produces from a capture-relative timeline — `examples/cannet-demo.blf` has it too. |
| `wall-clock-out-of-order.blf` | A start time of 2024-03-01T12:00:00Z. | The file's objects are **not** in timestamp order: the first object in file order is at +500 ms, while a marker at +100 ms and two frames at +120 ms / +300 ms sit at the *end* of the file. BLF makes no chronological promise, so the earliest event is not the first one read. |
| `wall-clock-signals.mf4` | `hd_start_time_ns` = 2024-03-01T12:00:00Z. | The earliest thing in the file is not a frame: the first CAN frame is at +500 ms, while the `AmbientTemp` signal group starts at +0 and an `##EV` event sits at +100 ms. |

## The rule they pin

Per [ADR 0024](../../docs/adr/0024-trace-like-view-timing.md):

- A file that **states** a start time keeps absolute wall-clock
  timestamps (`wall-clock-out-of-order.blf`, `wall-clock-signals.mf4` —
  both read as 2024-03-01, and the trace view offers a local time).
- A file that states **none** is anchored at zero and reads as relative
  (`relative-zero.blf` — no local time to offer).
- Either way the session origin is the **earliest** timestamp the import
  brings in — frame, file-backed sample, or event — not the first one
  read. Nothing renders at a negative time.

## Regenerating

Both generators use cannet's own writers, so they need no Python:

```sh
cargo run -p cannet-blf --example gen_time_origin_fixtures
cargo run -p cannet-mdf --example gen_time_origin_fixtures
```

`time-origins.dbc` is hand-written and is not generated.
