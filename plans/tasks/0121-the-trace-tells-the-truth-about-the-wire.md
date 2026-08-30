# 0121 — The Tool Tells the Truth About the Wire

> **Opened 2026-08-26** from the owner's walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 3B —
> findings **3.37, 3.39, 3.42, 3.43, 3.52, 3.53**. Two of them (3.42,
> 3.43) are the owner's own observations from the 2026-08-23 hardware
> session; two more came from investigating that report; 3.52 and 3.53
> predate it. Widened 2026-08-26 at the owner's instruction to carry
> **all** of the hardware-truth work as one task — *"fine if it gets
> split into a few PRs, but I intend to do it all before next release,
> so might as well put it together."*

**The trace shows frames the bus never carried, and hides the evidence
that it didn't — and the bus-health panel names its hardware with less
truth than the hardware offers.** Three findings are one defect seen
from three sides, and they are § 1. The rest are separable and are
§§ 2–4.

## 1. A transmit row is a local echo, not a wire confirmation

> *"Transmit frames still present as though they reached a wire."*
> — owner, 2026-08-23

| # | The piece |
|---|---|
| **3.43** | `build_and_confirm` appends the tx-confirm row **before any wire attempt**, unconditionally. A frame the bus never carried is indistinguishable in the trace from one it did. Task 109 phase 2 fixed only the case where the *interface* is unreachable; this is the general one — an open CAN link, a listen-only bus, FD on a classic bus. |
| **3.37** | The wire **does** tell us. `cannet-client::is_per_frame_error_code` classifies `TX_REJECTED` as non-fatal and logs it with `tracing::warn!` — dev stderr only. Not the System Messages panel, not bus health, not the connection chip. The rejection is received and discarded. |
| **3.39** | During the bench fault the adapter emitted **115,136 error frames in 22 s (~5,200/s)**, each becoming a trace row: `session.rs`'s error branch adds the health-coalescer fold and the `trace_store.append` below it is unconditional. Phase 2 attributed the trace's growth to tx-confirm rows and never saw this larger contributor. |

**Ruled 2026-08-26, and it settles the one real design question:**

> *"error frames stay in saved capture, and coalesced in the frontend."*

So **nothing is dropped at ingest.** `bus_health.rs`'s module doc keeps
its promise — *"the frames themselves are stored like any other frame …
so a saved capture is not a lossy restatement of what was received"* —
and the coalescing is a **view** concern. A capture saved during a fault
still carries all 115,136 frames; the trace panel shows them as one row
that counts.

**Work:**

1. A tx row is **provisional until the wire answers**, and reads as such.
2. `TX_REJECTED` reaches the user — coalesced, since at RBS rate it is a
   flood.
3. Error frames coalesce **in the frontend**, storage untouched.

**Re-observed by the owner 2026-08-26**, while ruling on the queue:
*"we still seem to count TX messages and try to keep sending them into a
dead bus."* Both halves are this task's § 1 — the tx count rises because
`build_and_confirm` appends unconditionally, and nothing stops or
surfaces the retries because the wire-level rejection is discarded. PEAK
hardware is available for the verification runs.

## 2. "Error-active" does not read as healthy · 3.42

> *"to a reader it looks like a fault is in progress, which is the
> opposite of what it means"* — owner, 2026-08-23

`Error-active` is the correct ISO 11898-1 name for a node in normal
operation. The other three states (`Error-warning`, `Error-passive`,
`Bus-off`) read correctly as degrees of trouble, so the healthy state is
the only one whose label misleads.

**Ruled 2026-08-26:** the panel shows **`Connected`**, and the ISO
name survives in the tooltip. Independent of § 1 and much smaller — it
can land first.

## 3. Nothing counts dropped frames · 3.53

The status-bar inventory considered a dropped/overrun counter and did not
adopt it, because no such counter exists anywhere in cannet — it is new
work on the ingest path, not a new label. It is, though, the one number
that says whether the trace on screen is the whole of what the bus sent,
and **every other number in the bar is read as if it were**.

**Ruled 2026-08-26 — open it, here**: *"addressing throwing away that
status (for peak, kvaser, vector) ... could land in 121."* The counter
reads the per-vendor overrun/status reporting the ingest path currently
discards — PCAN's status word, Vector's chip-state events, Kvaser's
whenever its CANLIB leg exists — and counts rx-side loss only; tx
rejection is § 1's separate, already-named signal.

## 4. Adapter identity is a display name and nothing else · 3.52

Raised by task 101 (retired to git history): the wire's `Interface`
(`crates/cannet-wire/proto/cannet.proto`) carries exactly `id`,
`display_name`, `fd_capable`, so the bus-health adapter cell can never
show driver name/version, firmware version, or serial — the fields the
approved prototype filled with **fabricated** strings.

**Ruled 2026-08-26** — *"we should address, ship that data across from
the sidecar"*, and it lands here with the rest of the hardware-truth
work:

1. **Protocol**: extend `Interface` with optional identity fields —
   driver name, driver version, firmware version, serial number. All
   optional; absent renders as absent. Internal wire, no out-of-tree
   consumers (the 3.12 precedent).
2. **Sidecar producer, per backend**: populate what each python-can
   backend exposes at interface-listing time — PCAN (`CAN_GetValue`
   channel/API version, device id), Vector (`xlGetDriverConfig` driver
   version, serial). Kvaser follows whenever its CANLIB leg lands (the
   known limitation recorded at task 109); until then its fields are
   absent, which the model handles by construction.
3. **Host + panel**: carry the fields through `cannet-client` to the
   bus-health adapter cell. **Absent means absent** — an em-dash, never
   a guessed or fabricated string; that rule is what task 101 already
   applies to bus load and is the reason this section exists at all.

Out of scope: channel counts, transceiver details, anything the
prototype did not show (additive later); any Kvaser-specific work (the
owner follows up independently).

## Exit criteria

1. **A transmit row that never reached the wire is distinguishable from
   one that did**, in a running build, pinned by a test.
2. **A `TX_REJECTED` reaches the user**, coalesced, and is pinned.
3. **Error frames coalesce in the trace view while the saved capture
   still holds every one of them** — pinned both ways, because the
   ruling is precisely that these two differ.
4. **`Interface` carries the identity fields**, optional and documented
   in the proto; the sidecar populates them for PCAN and Vector from
   the backend's own reporting, pinned by sidecar tests against faked
   backend responses. The adapter cell shows real values where present
   and an absent marker where not, pinned each way; a backend exposing
   nothing (virtual bus, Kvaser today) renders exactly as before, as
   the control. No string in the cell is fabricated.
5. **Each of 3.37, 3.39, 3.42 (ruled: `Connected` + tooltip), 3.52
   (ruled: ship the identity data) and 3.53 (ruled: the rx-loss counter
   is built here) reaches a terminal state**, recorded in this file.
6. **Full CI green** — seven jobs, each named with its command.

## Status log

### 2026-08-27 — §§ 1-2, the trace tells the truth about transmit and error frames

Branch `task-121-trace-truth` off `task-126-verdicts-audit` (94450007).
Scope: § 1 (3.43, 3.37, 3.39) and § 2 (3.42). §§ 3-4 are a later phase
and were not started.

**3.43 — a transmit row is a local echo.** The order was the whole
defect, so the order is the fix. `build_and_confirm` is gone, split into
`build_frame` (compose) and `append_tx_row` (append, after the answer).
Both transmit paths now attempt the wire *first* and append the row with
the outcome in hand — the single-frame `transmit_frame_inner` per frame,
the scheduler's tick per batch after `transmit_batch` returns.

A row whose frame reached no wire is recorded in `UndeliveredTx` and
reaches the view as `TraceFrameRecord::tx_delivery`, decorating the row
the way the ingest-time violation index already does. The direction cell
reads `Tx ✗` and the row says why on hover.

- *Why a side table and not a field on the frame.* ADR 0039's rejected
  alternative — "mark the tx-confirm row instead of parking" — objected
  that the flag would be something "every reader, exporter and file
  format then has to understand". Host-side state read at fetch time has
  none of that: the stored `RawTraceFrame` is unchanged, the spill format
  is unchanged, and a saved capture is byte-for-byte what it was. The
  ADR's bullet now records that boundary; the park still stands for the
  periodic-on-a-gone-route case it was written about.
- *Why it is bounded.* The marks are inclusive index **runs**, not one
  entry per row. The case that produces them in bulk is a bus that is
  down, which is one run however long it lasts; the realistic driver of
  growth is a bus that flaps, and the run list is capped at 4,096 with
  the oldest dropped — the windowed-ring answer the store gives its own
  rows. Pinned by `undelivered_marks_do_not_grow_without_bound`
  (100,000 marks → 1 run).
- *What the mark means.* The **enqueue** answer: no route, or a session
  that refused the frame. A frame the session accepted and the far end
  then rejected is 3.37's signal, not this one — it arrives
  asynchronously and belongs to no single row.

**3.37 — `TX_REJECTED` is received and discarded.** `cannet-client`
gained `rejections::PerFrameErrors`, shaped like `ControllerStates`: a
cheap-clone handle the session worker writes and anything holding the
session reads. The rx loop still logs the `tracing::warn!`, and now also
records the code and the peer's message. `RemoteSession` carries the
handle; `bus_health`'s existing 1 Hz poll reads every session's tally and
emits at most one `transmit` system message per session per poll, with
the delta, the session total and the peer's own words.

- *Why a tally and not a stream.* The owner's bench regime produces
  thousands a second. A message each would be the flood rather than the
  report of it; the code space is fixed and each code holds one message,
  so nothing grows with session length.
- *A bug the tests caught before the code shipped.*
  `a_reconnect_on_the_same_address_is_not_a_negative_delta` failed on the
  first run: a reconnect restarts the peer's count, and
  `saturating_sub` reported the fresh session's first few thousand
  refusals as zero. A fallen total is now read as a new session and its
  whole count is reported.

**3.39 — error frames reach the trace one row each.** The ruling is that
nothing is dropped at ingest and the coalescing is a view concern, and
that is what landed. `session.rs` is untouched: every error frame is
still appended, and `bus_health`'s coalescer still folds the run into the
one `busError` timeline event (ADR 0035) that the trace already draws.

What was missing was the other half — the individual rows. The
chronological trace gained a **Collapse Errors** toggle (view-local,
persisted with the panel's other view state, default on) that ANDs
`{"error_frame": false}` onto the panel's fetch predicate, so the trace
shows the summary event where the run was.

- *Where the collapse lives.* In the view, per the ruling. The predicate
  is composed frontend-side (`withoutErrorFrames`) and the paging is the
  host-side filtered path the panel already uses for a filter element —
  no new paging machinery, and the row elision is not re-derived in JS,
  which the GUI architecture rules forbid.
- *Why the predicate is not id-narrowable.* An error frame's arbitration
  id says nothing about it, so `resolve_candidates` returns `None` for
  the leaf and the filter index (ADR 0002 DS-3) visits the window. That
  is still `O(delta)` to maintain and `O(log n + page)` to serve — the
  index is incremental, so this is not a per-page scan.
- *Why it is gated on the host's error count.* The collapse engages only
  once a bus has reported an error frame (`anyBusHasErrors` over the
  bus-health map the panel already subscribes to). A clean capture keeps
  the plain unfiltered window and its live-tail overlay rather than
  paying for a filtered view of a category of row that never occurs.
- *Pinned both ways*, because the ruling is precisely that they differ:
  `the_capture_keeps_every_error_frame_the_view_collapses` appends 5,000
  error frames interleaved with data frames, asserts the store holds all
  10,000 and that the predicate holds back exactly the 5,000; and
  `brings every row back when the collapse is switched off` asserts the
  panel returns to the unfiltered window.

**3.42 — "Error-active" does not read as healthy.** The panel's healthy
state reads `Connected`, with `Error-active — ISO 11898-1's name for a
controller in normal operation` on hover. Only the healthy state gets a
tooltip: the other three already read as what they are, and
`Bus-off (ISO 11898-1: Bus-off)` would be noise. The launcher's concern
filter is keyed on tone, not on the words, so it is unaffected.

**Terminal states.** 3.37, 3.39, 3.42, 3.43 — done. 3.52 and 3.53 remain
open, in §§ 4 and 3, for the later phase.

**Tests.** 963 Rust host tests (10 new), `cannet-client` 5 new,
frontend 3,083 (16 new).

**CI, run locally in full** — seven jobs, each with the command run.

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | pass (no match) |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| rust | `cargo test --workspace` then `cargo clippy --workspace --all-targets -- -D warnings` | pass — 52 suites ok, 0 failed; clippy clean |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass — 30 frames, 3 signals, 3 events, 1 attachment |
| frontend | `pnpm --dir apps/gui test` then `pnpm --dir apps/gui build` | pass — 225 files, 3,083 tests |
| python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`, `uv run pytest` | pass — 200 tests |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass — freeze + smoke ok |

Two clippy lints and one rustfmt pass were fixed on the way
(`map_unwrap_or`, `format_push_string`, `type_complexity`); nothing else
in the workspace was red at the branch point.

**Render-tier capture**, three 60 s `scrub` runs on the release build of
this commit against `ev-zonal`, reported not judged. Load sanity first:
`ids_measured` 174, rx 1,609-1,611 f/s, tx 1,614-1,616 f/s, `interact`
performed 266 / missing 0 on every run — a real load, not a silent bus.

| | run1 | run2 | run3 |
|---|---|---|---|
| `lag_ms` max | 13.70 | 9.90 | 3.90 |
| `longtask_ms_per_s` p95 | 0.0 | 0.0 | 0.0 |
| `jank_fraction` | 0.0 | 0.0 | 0.0 |
| `mem.webview_mb` max | 605.9 | 608.3 | 603.7 |
| `mem.host_mb` max | 59.4 | 59.0 | 60.2 |
| `mem.tree_mb` max | 724.6 | 726.6 | 722.5 |
| `jsheap_mb` peak | 90.5 | 95.3 | 81.7 |
| `flush_ms` max | 10.52 | 10.36 | 11.03 |
| `rx_gap` worst p95 ratio | 1.1930 | 1.1605 | 1.1606 |
| `rx_gap` worst short frac | 0.002832 | 0.003001 | 0.002834 |

`lag_ms` max spans 3.9-13.7 within this one binary, which is the spread
finding 3.46 is about; it is not over 10 ms on every run. The webview
process sits at 604-608 MB, the same level the seven most recent stored
reports show on builds before this branch (587.6-609.9), so it is the
chain's standing reading rather than anything this phase moved. No
baseline was promoted and no limit widened.

Reports: `docs/performance-measurements/frontend/2026-08-27-3bf1a147-trace-truth{,-run2,-run3}.json`.
The `3bf1a147` in those names is the commit the measured release binary
was built from; the commit that carries them adds only the reports and
this log entry on top of it, so the code is the same tree.

### 2026-08-27 — §§ 3-4, the wire says what it lost and what it is

Branch `task-121-wire-status` off `task-121-trace-truth` (06bcc6e1).
Scope: § 3 (3.53) and § 4 (3.52). §§ 1-2 landed in the previous phase
and are untouched.

**Two optional wire additions, no renumbering.** `Interface` gains
`driver_name` / `driver_version` / `firmware_version` / `serial_number`
(tags 4-7) and `InterfaceState` gains `rx_overruns` (tag 5). All five
are proto3 `optional`, which is the whole point: **absent has to survive
the encoding**, because absent is an answer and it is a different one
from zero or from an empty string. Python stubs regenerated with
`scripts/regen_proto.sh`; the Rust side regenerates from `build.rs`.

**3.53 — nothing counted dropped frames.** The count is `rx_overruns`,
and what it counts is **occasions, not frames**. That is not a
simplification, it is the ceiling of what the hardware reports: PEAK
sets two bits in its channel status word (`PCAN_ERROR_OVERRUN` 0x2, the
controller read too late; `PCAN_ERROR_QOVERRUN` 0x40, the driver's
receive queue read too late) and Vector sets `XL_EVENT_FLAG_OVERRUN` on
an event. Neither carries a quantity, and a producer that reported one
would be inventing it.

- *Where it is read.* PEAK's bits come off the status word
  `_pcan_state` **already reads** — the discard finding 3.53 named is
  literally those two bits being masked out of a word the driver had in
  hand. No second `CAN_GetStatus`: that call serialises against
  `CAN_Write` in PEAK's driver, the same contention that keeps
  interface enumeration off a timer. Vector's flag is counted in the
  `handle_can_event` hook the chip-state subclass already installs.
- *Why an episode, not a poll.* The PEAK bits stay set for as long as
  the condition lasts, so a per-poll count would report one bus stall as
  a figure climbing at the poll rate — a number about the poll rather
  than about the wire. A rising edge is counted; a run that ends and
  starts again is two. Pinned both ways
  (`..._an_episode_once_however_long_it_lasts`,
  `..._a_second_episode_after_the_bus_recovers`).
- *Why Vector FD reports nothing at all.* The FD event struct carries
  its overflow flag in `flagsChip`, and python-can's own `xldefine` does
  not define that bit. Rather than copy a constant nothing in the tree
  can pin, an FD Vector channel answers `None` — no count, not a zero it
  has not earned. The classic constant *is* pinned against the vendored
  enum, exactly as the chip-state ones are.
- *Why the type is tri-state at every layer.* `None` is a backend that
  does not watch; `Some(0)` is a backend that watches and has seen none,
  and only the second licenses reading a capture as the whole of what
  the bus sent. Each boundary keeps them apart —
  `OpenChannel.rx_loss() -> Optional[int]`, the unset wire field,
  `ControllerStatus.rx_overruns: Option<u64>`, `skip_serializing_if` on
  the IPC record, `null` in `BusHealthRow`, an em dash in the cell —
  and each has a test for the pair.
- *One asymmetry, deliberate.* A state read that fails replaces the
  state with `unavailable`; a count read that fails **keeps the last
  figure**. A state is a reading of how the controller is now, a count
  is a record of frames already lost, and losing sight of the adapter
  does not un-lose them (`_read_rx_overruns`, pinned by
  `..._survives_the_adapter_going_away`).
- *Where it surfaces.* An **Overruns** column in the bus-health panel,
  beside TEC / REC, with the "reports, not frames" caveat on the header
  tooltip.

**3.52 — adapter identity is a display name and nothing else.** The
sidecar now fills what each backend actually exposes at listing time.

| Field | PEAK | Vector | Kvaser / virtual |
|---|---|---|---|
| `driver_name` | `PCAN-Basic` | `Vector XL Driver Library` | absent |
| `driver_version` | `PCAN_API_VERSION` | `xlGetDriverConfig().dllVersion`, decoded major.minor.build | absent |
| `firmware_version` | `PCAN_FIRMWARE_VERSION` | absent (no XL call reports it) | absent |
| `serial_number` | absent | card serial from the channel config | absent |

- *`driver_name` is not a readback, and says so.* It names the vendor
  API the sidecar enumerated through — a fact about our own path to the
  device — which is why it can be present where all three others are
  absent. The proto comment carries that distinction so a reader does
  not mistake it for something the device said.
- *PEAK has no serial to give.* PCAN-Basic exposes no hardware-serial
  parameter. `PCAN_DEVICE_ID` is the user-settable PCAN-View id already
  carried in the channel's `uid:`, and passing it off as a serial would
  be exactly the fabrication § 4 exists to stop, so the field stays
  absent.
- *Vector's version decode is unverified against hardware*, like the
  rest of that leg. `dllVersion` is unpacked the way every XL sample
  decodes it (major 31-24, minor 23-16, build low 16); a python-can
  without the helper, or an XL library that raises, leaves the field
  absent rather than guessing.
- *The cell.* Under the adapter's name, a quieter line with three
  labelled slots — Driver (name and version folded into one phrase, a
  version with no stack being meaningless alone), Firmware, Serial —
  each an em dash where the driver said nothing. **The line is absent
  entirely when the driver reported none of it**, so a virtual bus and a
  Kvaser channel render exactly as they did before the fields existed.
  That is the control exit criterion 4 asks for, and it is why the em
  dashes are conditional: three dashes announcing three facts nobody has
  is noise, while a dash beside two real values is an answer.
- *One knock-on.* `interfaces_equal` compared id / display name / FD
  only, so a re-enumeration that finally read a firmware version would
  not have counted as a change and the cell would have stayed empty
  until something else moved. It is whole-record equality now, with `Eq`
  derived on `InterfaceRecord` so the next field added cannot silently
  rot it.

**Tests.** Sidecar 223 (23 new, including the new
`tests/test_rx_overruns.py`); Rust 7 new (`cannet-client` 2,
`cannet-wire` 2, host 3); frontend 3,091 (8 new). Every new pair —
absent vs zero, identity vs no identity — is pinned on both sides,
because the ruling is precisely that they differ. The PEAK overrun tests
were falsified before being trusted: deleting the one
`_note_pcan_overrun` call turns 4 of the 12 red and nothing else.

**CI, run locally in full** — seven jobs, each with the command run.

| Job | Command | Result |
|---|---|---|
| comment-references | the workflow's `git grep --untracked` over `apps/ crates/` | pass (no match) |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| rust | `cargo test --workspace` then `cargo clippy --workspace --all-targets -- -D warnings` | pass — 52 suites, 1,741 ok / 0 failed; clippy clean |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass — 30 frames, 3 signals, 3 events, 1 attachment |
| frontend | `pnpm --dir apps/gui test` then `pnpm --dir apps/gui build` | pass — 225 files, 3,091 tests |
| python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`, `uv run pytest` | pass — 223 tests |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass — freeze + smoke ok |

Nothing in the workspace was red at the branch point, and nothing
unrelated was touched.

**Render-tier capture**, three 60 s `scrub` runs on the release build of
this branch against `ev-zonal`, reported not judged. Load sanity first:
`ids_measured` 174 on every run, rx 1,605-1,608 f/s, tx 1,607-1,615 f/s,
`interact` performed 266 / missing 0 — a real load, not a silent bus.

| | run1 | run2 | run3 |
|---|---|---|---|
| `lag_ms` max | 4.90 | 1.20 | 3.20 |
| `longtask_ms_per_s` p95 | 0.0 | 0.0 | 0.0 |
| `jank_fraction` | 0.0 | 0.0 | 0.0 |
| `mem.webview_mb` max | 608.5 | 606.5 | 608.8 |
| `mem.host_mb` max | 59.9 | 59.2 | 59.6 |
| `mem.tree_mb` max | 727.4 | 724.7 | 727.2 |
| `jsheap_mb` peak | 83.2 | 94.3 | 89.3 |
| `flush_ms` max | 11.04 | 11.82 | 10.31 |
| `tx_late_ms` max | 18.58 | 78.22 | 16.99 |
| `rx_gap` worst p95 ratio | 1.1666 | 1.1786 | 1.1552 |
| `rx_gap` worst short frac | 0.001667 | 0.001669 | 0.001834 |

Nothing here is over the thresholds a phase interrupts for: `lag_ms` max
is 1.2-4.9, well under 10 ms on every run rather than over it on all
three, and the webview process sits at 606-609 MB against the previous
phase's 603.7-608.3 on the same rig — the chain's standing reading,
not something these two sections moved. The one outlier worth naming is
`tx_late_ms` max **78.22 on run2** against 18.58 / 16.99 either side of
it; single-run tails like that are what finding 3.46 is about, and it is
recorded rather than judged. No baseline was promoted and no limit
widened.

Reports: `docs/performance-measurements/frontend/2026-08-27-84b3f3bc-wire-status-run{1,2,3}.json`.
The `84b3f3bc` in those names is the commit the measured release binary
was built from; the squashed commit adds only the reports and this log
entry on top of that tree, so the code is the same.

**Terminal states.** 3.52 and 3.53 — done. With 3.37, 3.39, 3.42 and
3.43 closed in the previous phase, every finding this task opened has
reached one.

## Blockers / side effects

### 2026-08-27 — from the §§ 3-4 phase

- **Neither new signal has been seen against hardware, and both need
  the bench.** The whole phase is exercised against faked vendor
  responses; no PEAK adapter, no Vector card and no XL library was
  involved anywhere it was written. What the owner should look for on
  the PEAK bench:
  1. **The identity line under the adapter name.** Expect
     `Driver PCAN-Basic <version> · Firmware <version> · Serial —` on a
     bound PEAK bus. An em dash where a version should be means the
     driver refused that per-handle `GetValue` — worth knowing, and it
     renders as absent rather than as a wrong string. A version that
     looks *wrong* is the failure that matters.
  2. **The Overruns column reading 0, not an em dash**, on a healthy
     PEAK bus. That zero is what says the capture is the whole of what
     the bus sent, and it is the one thing a faked status word cannot
     prove.
  3. **Whether that column moves during the open-circuit fault** that
     produced the 2026-08-23 run. It may well stay at 0: PEAK's overrun
     bits are about the host not draining fast enough, which is a
     different failure from the bus fault that drove the error counters.
     Either outcome is information. A column climbing at the poll rate
     rather than once per episode would be the bug.
- **Vector's leg is unverified, version decode included.** The
  `dllVersion` unpack is read off the XL samples' own arithmetic, not
  off a card. If it is wrong the cell shows a plausible but false
  version — the one failure mode § 4 is written against — so the first
  Vector session should check that field against Vector Hardware Config
  before trusting it. A missing XL library yields absent, not wrong.
- **Kvaser is a named gap, deliberately untouched.** §§ 3 and 4 both
  say Kvaser follows whenever its CANLIB leg lands. The owner's open
  PR #422 ("Discover Kvaser channels through python-can") is reworking
  that discovery now, so nothing here reads CANLIB and nothing here
  touches `_list_kvaser`. A Kvaser channel therefore reports no identity
  and no overrun count — which the model handles by construction, and
  which the tests pin as the control. Whoever lands #422 can fill both
  in the same two places PEAK and Vector are filled.
- **Where the rx-loss count belongs in the status bar is unruled.**
  Finding 3.53 came out of the status-bar inventory, but the ruling
  opened the *counter*, not a bar slot, so this phase put it in the
  bus-health panel beside TEC / REC and left the bar alone. If the owner
  wants it in the bar it is the same one-number-per-bar question bus
  load already answers (`worst_load_percent` takes the worst across
  buses); nothing here forecloses it.
- **A Vector FD channel reports no overrun count at all.** Classic
  Vector counts; FD answers absent, because the FD event's overflow bit
  is not among python-can's own definitions and inventing the constant
  would be the fabrication this task is about. It renders as an em dash,
  which is honest — but it does mean the one adapter class that is both
  FD and Vector gets no completeness signal until that bit can be pinned
  against a real header.

### 2026-08-27 — from the §§ 1-2 phase

- **The Collapse Errors default is a behaviour change nobody has seen on
  hardware.** On by default, so the first fault an operator meets after
  this lands shows one summary row where it used to show a wall of `Bus
  error` rows. That is the ruling's stated outcome, and the toggle is one
  click away, but it also switches the panel from the unfiltered window
  (with its live-tail overlay) to the host's filtered paging the moment
  the first error frame arrives. That switch has been exercised in tests
  and against the virtual bus, **not against a real fault at 5,200
  frames a second**. Worth a look on the PEAK bench before release.
- **The undelivered-transmit mark is the enqueue answer, not a wire
  confirmation.** A frame the session accepted is unmarked even if the
  far end refuses it a moment later. That is deliberate — the rejection
  belongs to no single row and is § 1's separate coalesced signal — but
  it means a row reading plain `Tx` is "we handed it over", not "a bus
  carried it". If the owner wants per-row confirmation, the wire would
  have to correlate a rejection back to a frame, which it currently
  cannot.
- **§ 3's rx-loss counter and § 4's adapter identity are untouched.**
  Left for the later phase as instructed; nothing in this phase forecloses
  either.
