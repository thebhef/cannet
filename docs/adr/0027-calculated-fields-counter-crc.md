# ADR 0027 — Calculated fields: sequence counters and CRCs on transmitted messages

Status: accepted (2026-06-09)

A **calculated field** is a signal on a message cannet transmits whose
value the host recomputes on every send: a **sequence counter** (an
incrementing value with a rollover) or a **CRC** (computed over a
stated range of the just-encoded payload). The common real-world case
is the AUTOSAR E2E-protected frame carrying both. Calculated fields
are available on any transmitted message — a transmit-panel frame or
a rest-of-bus-simulation row ([ADR 0028](0028-rest-of-bus-simulation.md))
— through one mechanism.

## Decision

### One transmitter construct; fields applied in the fire path

The host has a single transmit model (`TransmitFrameRegistry` + the
host scheduler thread); every transmit-side feature is a client of
it. A registry entry optionally carries a resolved calculated-fields
config; the scheduler's fire path applies it on each send:

1. counter ← (counter + increment) mod (rollover + 1), partial-encoded
   into the payload buffer;
2. CRC computed over the configured range of the **updated** buffer
   (so a range covering the counter sees the new value),
   partial-encoded into the destination signal;
3. the frame is sent. The synthesized `Tx` row carries the final
   bytes, so trace decode and plots show the real field values with
   no special handling.

Configs are resolved **at registration time** down to bit placement
(start bit, width, byte order from the destination signal's DBC
layout) so the fire path does no DBC lookups. The counter's current
value is runtime state on the registry entry, never persisted; it
seeds at 0 each time its owner starts transmitting.

The computation itself (counter step, CRC over a byte range, the
partial encodes) lives in `cannet-dbc` beside `encode_frame` — the
GUI host calls it, never reimplements it. Payload bytes remain the
source of truth per [ADR 0017](0017-transmit-signal-encoder-and-bytes-source-of-truth.md);
calculated fields are two more partial encodes into the buffer, not
a signal-map re-encode.

### Config shape

Per message: at most one counter and one CRC, each designating a
**destination signal**. The destination's layout, type, scale, and
unit come from the DBC and are never overridable.

- **Counter:** `increment` (default 1) and `rollover` (default
  `2^bit_length − 1`, i.e. wrap at the signal's width). The value
  runs 0..=rollover. Any bit position/width works.
- **CRC:** either a **named algorithm** from the `crc-catalog`
  catalogue (`CRC-8/SAE-J1850`, `CRC-8/AUTOSAR`, `CRC-16/IBM-3740`,
  …) **or** explicit Rocksoft parameters (width, poly, init,
  refin, refout, xorout) — exactly one of the two; plus:
  - `range_bits` `[start, length]` — the payload range the CRC is
    computed over. Expressed in bits for forward compatibility but
    **byte-aligned ranges only** for now (config error otherwise);
    CRCs are byte-wise and bit-level feeding is speculative.
  - `prefix` (optional hex bytes) — prepended to the ranged data
    before computation. This is how an AUTOSAR E2E Data ID — which
    participates in the CRC but is not in the frame — is expressed
    without modeling E2E profiles as first-class objects.
  - **No implicit exclusions.** The range covers exactly what it
    says; "everything except the CRC byte" is a range that doesn't
    include it. A range overlapping the CRC's own destination signal
    is a config error: rejected with a system-message error on load,
    and reverted in the GUI if an edit control is abandoned with an
    invalid value.

### Persistence: DBC attributes are the defaults, overrides layer on top

The designation lives **in the DBC**, as cannet-defined custom
attributes on the destination signal (consistent with
[ADR 0010](0010-no-sidecar-files.md): the data rides inside the
format's own extension mechanism):

```text
BA_DEF_ SG_ "CannetCounter" STRING ;
BA_DEF_ SG_ "CannetCrc" STRING ;
BA_DEF_DEF_ "CannetCounter" "";
BA_DEF_DEF_ "CannetCrc" "";
BA_ "CannetCounter" SG_ 291 AliveCtr "increment=1;rollover=15";
BA_ "CannetCrc" SG_ 291 Crc8 "alg=CRC-8/SAE-J1850;range=0:56;prefix=A3";
```

The attribute value is a `key=value;` one-liner, not JSON — DBC
STRING values cannot portably carry nested double quotes. Raw CRC
parameters use the same syntax (`width=8;poly=0x1D;init=0xFF;
refin=0;refout=0;xorout=0xFF;range=0:56`). An empty value means
unconfigured. The attribute sits *on* the destination signal, so no
`signal=` key is needed in this form.

Layered on top, a `.cannet_rbs` file or the transmit panel's GUI
config may override per message ([ADR 0028](0028-rest-of-bus-simulation.md)
records the file form, which *does* carry a `signal` key). An
override replaces the DBC default **wholesale** for that field on
that message — no per-field merging between layers.

**cannet reads these attributes but does not yet write them.** DBC
writing (a surgical attribute editor that leaves every other byte of
a third-party file untouched) is deferred; until then the GUI
configures calculated fields for arbitrary signals through the
override layer, and the demo DBC carries hand-authored examples.

### Decode-side verification

Received frames on a `(bus, message id)` with a calculated-field
config are verified **at ingest, host-side** — not at view time,
because counter continuity needs the previous frame of that id and a
paged viewport doesn't have it. CRC verification is stateless;
counter verification keeps per-`(bus, id)` last-value state (the
first sighting seeds, subsequent frames must equal
`prev + increment (mod rollover + 1)`).

- Violations land in a sparse host index (frame index → kind); the
  trace view queries it for the visible window and flags those rows
  (rendered red). Per-`(bus, id)` validity state (valid / invalid)
  is queryable by any view.
- A valid→invalid transition logs an Info system message,
  rate-limited to one per second per `(bus, id)`.
- Frames cannet itself transmitted are exempt (we computed the
  fields). Config changes apply from that point forward — no
  retroactive re-verification.

### CRC implementation

The `crc` crate (with its `crc-catalog` algorithm catalogue) does
the computation — see `plans/technology-inventory.md`. The named
catalogue cannet exposes is the `crc-catalog` name list; zero
curation.

## Why

- **One mechanism, two consumers.** RBS rows and transmit-panel
  frames both need recompute-on-send fields; building it once in the
  registry + fire path keeps the hand-written surface small.
- **In `cannet-dbc`, not the GUI.** The computation is bit-packing
  over DBC layouts — the encoder's domain. The frontend re-deriving
  it would cross the model/view boundary (CLAUDE.md GUI rules).
- **DBC attributes as the home.** The designation is a property of
  the signal, not of any one project; carrying it in the DBC makes
  it portable across projects and tools. Third-party tools that
  scrub unknown attributes are out of cannet's control; standard
  behavior is pass-through.
- **`prefix` instead of E2E profile objects.** Profiles 1/2 reduce
  to "CRC over Data ID + payload bytes" — the raw parameter set plus
  a prefix covers the realistic target without committing to a
  profile model we'd have to grow.
- **Ingest-time verification.** View-time can't see the previous
  frame; per-frame cost for unconfigured ids is one hash probe.

## Rejected alternatives

- **JSON inside the DBC attribute string.** DBC STRING values choke
  on nested double quotes; `key=value;` is unambiguous and readable.
- **Implicit range exclusions** (auto-skip the CRC/counter bits).
  Magic that surprises exactly when payload layouts get unusual;
  explicit ranges are spec-checkable.
- **E2E profiles as first-class config.** Adds a profile model for
  two profiles whose effect is one prefix field; revisit if profile
  4/5/6 semantics (lengths, offsets) are ever needed.
- **Full DBC serializer to write attributes now.** Round-tripping a
  third-party DBC through an AST writer reformats the whole file and
  risks dropping constructs the parser holds lossily. A surgical
  line editor is the eventual shape; reading-only ships first.
- **Frontend-computed fields.** Wrong side of the model/view
  boundary; the scheduler fires without the frontend awake.
