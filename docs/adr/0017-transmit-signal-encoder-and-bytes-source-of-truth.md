# ADR 0017 — Transmit-frame signal encoder lives in `cannet-dbc`; bytes are the source of truth

Status: accepted (2026-05-26)

Phase 11 ([`../../plans/phased-implementation.md`](../../plans/phased-implementation.md))
introduces real per-signal editing in the transmit panel — until now
the panel only let the user type raw hex into `dataHex` or pick an
enum signal's raw value from a dropdown that copied one byte into the
payload, and numeric signals had no input at all. This ADR records
three coordinated decisions made for that work.

## Decision

**1. The encoder lives in `cannet-dbc`.** A new public
`Database::encode_frame(message, signals: {name → f64}, base: &mut
[u8])` is the inverse of the existing
[`Database::decode`](../../crates/cannet-dbc/) — it writes only the
bits the named signals cover, preserving all other bytes in `base`
(a *partial encode*). Factor / offset, signedness, big- and little-
endian, multi-byte signals, IEEE-754 floats / doubles, and simple
multiplexing (one `M` switch + `m<N>` sub-signals) all land in this
phase. **Nested / extended multiplexing (`m0M`, `m1M`, …)** is
out of scope and tracked in `plans/backlog.md`; messages declaring
it degrade the transmit panel to "raw bytes only" mode with a clear
note.

**2. The GUI host exposes the encoder via a Tauri command.**
`encode_frame(message_id, extended, signals, base) → bytes`. The
transmit panel calls it on every signal-table edit; the host
returns the new payload bytes which the panel writes back into the
frame's `dataHex`. No new IPC shape — same pattern as `decode_frame`.

**3. Bytes are the persisted source of truth; both views update
from either.** A transmit frame's persisted state stays
`dataHex: string`. The transmit panel shows two **simultaneously
editable** surfaces — a per-byte hex-cell strip (always visible in
the frame's collapsed row) and a signals table (visible when the
frame's row is expanded *and* its id maps to a DBC message).
Editing a signal partial-encodes that signal's bits into the
current bytes; the byte cells re-render. Editing a byte cell
updates `dataHex` directly; the signals table re-decodes. The
signals view is a derived projection over the bytes, never the
other way round.

## Why

**Encoder in `cannet-dbc` because that's where decode lives.** The
encoder is the literal inverse of decode and shares all of its
DBC-walking machinery (signal lookup, bit packing, endianness, the
value-table boundary). Putting it anywhere else (the GUI host,
a new crate) would duplicate that walk.

**Partial encode rather than full re-encode because two-table editing
otherwise drifts.** If a signal edit re-encoded the whole payload
from a `{name → value}` map, two things break: byte regions not
covered by any signal in the DBC get clobbered to zero on every
edit, and bits owned by the *inactive* arm of a multiplexed message
get reset every time the *active* arm is edited. Partial-encode
preserves both.

**Bytes are the source of truth, not signals.** Two reasons. First,
not every byte a CAN frame may carry is covered by a DBC signal —
proprietary CRC bytes, sequence counts, reserved fields, padding —
and the user must be able to set them directly without rewriting
the DBC. Second, bytes are stable across DBC reloads; signals are
not. A capture that loses its DBC (or has a DBC swapped under it)
must keep producing the same frame on the wire.

## Rejected alternatives

- **Signals as the source of truth, bytes view read-only when a DBC
  message is bound.** Forces every transmittable byte to be
  covered by a signal in some DBC, which isn't true in practice
  (CRCs, sequence counts, reserved fields, padding bytes). Also
  loses byte-level edits as a first-class operation when the user
  has a DBC.
- **Full re-encode on every signal edit, using the previous payload
  only to fill "unmapped" bytes.** Drifts on multiplexed messages
  (the inactive arm's bytes get treated as unmapped → zeroed) and
  produces surprising diffs in any byte the DBC happens to leave
  partially unmapped.
- **Encoder in the GUI host (Rust) without a `cannet-dbc` API.**
  Splits the DBC-walking logic across two crates. Future callers
  (server-side simulation in Phase 14, CANopen SDO/PDO in Phase 22)
  would each have to reach into the GUI host or copy the walk.
- **Encoder in TypeScript on the frontend.** Reimplements decode-
  semantics on the wrong side of the model/view boundary, in a
  language without `cannet-dbc`'s test surface.

## Consequences

- `cannet-dbc` gains rustdoc on the partial-encode contract; the
  round-trip property (`decode ∘ encode == identity` for every
  signal in the demo fixture, and `encode ∘ decode == identity`
  modulo unmapped bytes) is enforced by tests.
- The transmit panel's existing "pick enum raw → write one byte"
  hack is retired; enum picks go through the encoder for proper
  multi-byte placement.
- The "bytes source of truth" rule constrains future transmit-side
  features (rest-of-bus simulation in Phase 14, math channels in
  Phase 23) to operate on payloads, not on signal maps, when they
  need to persist or transmit a frame.
