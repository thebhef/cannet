# Task 14 — Rest-of-Bus Simulation + Calculated Fields (CRC / Sequence Counter)

Two transmit-side features that share one mechanism: **calculated
fields** — signals the host recomputes on every send (a rolling
counter; a CRC over a range of the just-encoded payload) — and
**rest-of-bus simulation (RBS)**, the bulk + cadence transmit surface
that consumes them. Both build on the transmit encoder
([ADR 0017](../../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)),
the host transmit registry/scheduler (`transmit_frames.rs` /
`transmit_scheduler.rs`), and the Task-13 buses.

The design was settled in a grilling session (2026-06-09) and is
recorded in two ADRs — the task implements them:

- **[ADR 0027 — Calculated fields](../../docs/adr/0027-calculated-fields-counter-crc.md):**
  one transmitter construct; fields resolved to bit placements at
  registration and applied in the scheduler fire path
  (counter → CRC → send); config = catalogue name XOR raw Rocksoft
  params + byte-aligned `range_bits` + optional `prefix` (E2E Data
  ID); persisted as cannet `BA_` attributes in the DBC
  (`CannetCounter` / `CannetCrc`, `key=value;` one-liners) with
  wholesale per-message overrides layered on top; DBC *writing*
  deferred — cannet reads the attributes, the GUI configures via the
  override layer; ingest-time decode-side verification (red trace
  rows, queryable validity, rate-limited Info transitions).
- **[ADR 0028 — RBS](../../docs/adr/0028-rest-of-bus-simulation.md):**
  human-editable `.cannet_rbs` JSON (sparse overrides; `fill_bit`;
  nested `bus → ecu → message` with ANDed enables; logical-bus-name
  keys; values-only overrides, hex iff unity-scaled, enums by
  label); per-message payload buffer reconstructed fill → DBC
  defaults → overrides, registered as provenance-tagged
  `TransmitFrameRegistry` entries; project element `kind: "rbs"`
  referencing the file by path with a project-persisted Run flag
  (default off) + global runtime kill-switch; per-bus connectivity
  gating; Save Project / Save All / exit-prompt split; `.cannet_prj`
  / `.cannet_rbs` extensions with `.json` still accepted.

## Work items

1. **`cannet-dbc`: calculated-field engine.** Counter step + CRC
   compute (via the `crc` crate — see
   [technology-inventory.md](../technology-inventory.md)) as partial
   encodes into a payload buffer; config types; resolution to bit
   placements; validation (byte-aligned range, range/destination
   overlap). Verified against independent reference vectors
   (crc-catalog check values; an E2E-profile example).
2. **`cannet-dbc`: attribute parsing.** `CannetCounter` /
   `CannetCrc` (`key=value;` syntax) plus typed accessors for
   `GenSigStartValue` and `GenMsgSendType` (absorbed from the
   backlog's Gen\* item). Demo DBC gains hand-authored examples.
3. **Host: registry + fire path.** Provenance tag on
   `TransmitFrameRegistry` entries (excluded from project snapshot
   and transmit-panel list); optional calculated-fields config per
   entry applied in the scheduler driver; counter runtime state.
4. **Host: `.cannet_rbs` model.** Load/validate/save (sparse-
   override round-trip), buffer reconstruction, logical-bus
   resolution, skip-with-warning semantics, registration/teardown,
   Run flag + per-bus connectivity gating + global kill-switch.
5. **Host: decode-side verification.** Ingest-time CRC/counter
   checks for configured `(bus, id)`s; sparse violation index;
   per-`(bus, id)` validity query; Info system message on
   valid→invalid (1/s rate limit per id); own-Tx exemption.
6. **GUI: RBS element + panel.** `kind: "rbs"` element (nameable,
   path-referenced); tree-grid (bus → ECU → message → signal) with
   ANDed enable checkboxes, effective-value display (override marked,
   light **×** to clear), period column, fzf filter (reuse the DBC
   panel's), inert rows for unresolved buses; calculated-field cells
   read-only with algorithm combo + attribute editor; right-click
   any signal → configure as CRC / counter.
7. **GUI: shared components.** Extract the validated input
   (commit-on-blur/Enter, revert-on-Escape/invalid — pattern already
   in `TransmitPanel.tsx`) and the calculated-field config editor;
   use both in the transmit panel too (its messages gain the same
   counter/CRC configuration).
8. **GUI: trace red rows** for verification violations (visible-
   window query against the violation index).
9. **GUI: save flow + extensions.** Save All action (project +
   dirty RBS files); exit prompt covers all dirty state; save
   dialogs default `.cannet_prj` / `.cannet_rbs`, open accepts
   `.json` too.

## Deferred / out of scope

- **DBC writing** (surgical `BA_` line editor) — read-only this
  task; overrides cover unwritable DBCs.
- **E2E profiles as first-class config** — `prefix` covers the Data
  ID; revisit if profile-specific semantics are needed.
- **Non-byte-aligned CRC ranges** — config error for now; the bits
  format keeps the file forward-compatible.
- **1 ms cadence validation** — the scheduler targets 5–10 ms
  periods today; sub-5 ms timing (Windows timer resolution) is
  re-deferred pending the real-hardware performance pass (Task 25
  territory). RBS must not regress the current scheduler.
- **Duplicate-config affordance** — forking is a file op + path
  re-point.

## Exit criteria

- A message can be configured (DBC attributes or GUI/`.cannet_rbs`
  overrides) so one signal is a sequence counter and another a CRC;
  every transmit recomputes both; `cannet-dbc` tests verify against
  independent reference vectors and round-trip through `decode`.
- The transmit panel exposes the same calculated-field configuration
  on its messages.
- An RBS panel lists a DBC's messages grouped per ECU as a grid of
  live, editable signal values and sends enabled messages on their
  cadence via the host scheduler; sent frames appear as `Tx` rows
  with the fields filled in, over `local-virtual-bus`, hardware
  (sidecar) interfaces, and FD frames (test matrix).
- `.cannet_rbs` round-trips: load → edit → save preserves sparse
  semantics (non-overridden values keep tracking the DBC); unknown
  bus / unknown message / transmitter-mismatch behaviors match
  ADR 0028.
- Received frames with configured fields are verified at ingest:
  bad CRC / out-of-sequence counter paints the trace row red,
  validity is queryable, and valid→invalid logs a rate-limited Info
  system message.
- Run flag persists in the project (default off); enabled RBS
  resumes on open once its bus connects; the global kill-switch
  stops everything; per-bus connect/disconnect gates sends live.
- ADRs 0027 / 0028 are checked in; `technology-inventory.md` records
  the `crc` decision; the README documents the RBS workflow and
  calculated-field configuration; rustdoc covers the new
  `cannet-dbc` surface.
- **ADR cleanup:** scrub task-number references out of
  [ADR 0017](../../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)
  (its rest-of-bus mention) — ADRs describe what *is*.
