# ADR 0009 — DBC via `can-dbc`; BLF via our own focused crate

Status: accepted (2026-05-23, revised same day to record the BLF
parser decision after the feature-support analysis; supersedes the
initial drafting which named `blf_asc` as the BLF parser).

## Decision

CAN signal databases are read as **DBC** via
[`can-dbc`](https://docs.rs/can-dbc) — unchanged from the original
ADR.

CAN capture logs are read and written as **BLF** by **our own focused
BLF implementation inside `cannet-blf`**, not by a third-party crate.
The third-party Rust BLF crates (`blf_asc`, `ablf`) retire from
cannet's dependency tree once the new implementation reaches feature
parity. Technica's C++ `vector_blf` was considered as a candidate via
FFI but rejected on ecosystem-fit grounds — see "Why our own BLF."

`cannet-dbc` continues to own DBC semantics on top of `can-dbc`'s AST
and the DBC long-name extension (`BA_ "SystemMessageLongSymbol"` /
`SystemSignalLongSymbol`).

## Why DBC and BLF

They are the de-facto industry formats for these jobs. DBC has been
the standard CAN signal-database format since the early 1990s; BLF is
Vector's binary log format, and every mainstream CAN tooling vendor
reads and writes it. Adopting them means our captures round-trip
through Vector CANalyzer and our signal definitions interchange with
the wider CAN ecosystem.

## Why `can-dbc` (unchanged)

The only credible pure-Rust DBC parser, MIT/Apache-2.0, currently
maintained. It intentionally stops at producing an AST; `cannet-dbc`
reads the AST and implements decoding, value-table lookup, and the
long-name extension resolution.

## Why our own BLF, not a third-party crate

Four candidate paths were considered; the
[BLF feature support matrix](../blf-feature-support.md) tracks the
per-type coverage gaps:

1. **Continue on `blf_asc`.** Pure-Rust, MIT/Apache-2.0, but two
   months old at the time of decision (created 2026-03-19), single
   maintainer with a
   provenance-ambiguous sibling crate (`codex_blf` v0.0.0, same
   author and repo), narrow coverage (~6 CAN object types), and no
   extension hook for writing other object types. The marker gap is
   what produced the `<file>.blf.notes.json` sidecar (see
   [ADR 0010](0010-no-sidecar-files.md)), and closing it would mean
   a long tail of upstream PRs gated on a single-maintainer review
   velocity we have no read on.

2. **Switch to `ablf`.** Pure-Rust, MIT/Apache-2.0, better-established
   (2 years, ~17× downloads), broader recognise-and-skip surface. But: no
   CAN FD read (the differentiator that made us pick `blf_asc`
   originally), no write surface at all. Using `ablf` would require
   us to contribute CAN FD read + a generic writer upstream before
   we could even use it for our existing capture workflows.
   Substantial up-front work for the same kind of maintainer-
   velocity dependency we have on `blf_asc`.

3. **Wrap Technica's `vector_blf` via FFI.** C++, GPL-3.0-or-later.
   Comprehensive (~132 object types, bidirectional read+write),
   maintained for ~10 years. No off-the-shelf Rust binding exists —
   adopting it means designing, writing, and maintaining the
   Rust↔C++ FFI surface ourselves (via `cxx-rs` or similar), plus
   carrying a C++ build step in cargo. Cannet is a Rust project; a
   Rust BLF library is what it actually wants. With LLM-assisted
   implementation, writing the focused Rust subset cannet needs
   (~25 of 132 types) from Vector's public spec is plausibly less
   work than standing up the FFI surface and maintaining the C++
   toolchain integration over time.

4. **Write our own focused BLF reader / writer.** *Selected.*
   Cannet is a Rust project; a Rust BLF crate is what it needs.
   The feature-support matrix shows cannet's required-and-desired
   list is ~25 object types out of 132, with writers needed for
   ~10. `ablf` shows ~1k Rust LOC covers a real partial subset;
   our scope is comparable. We get to design the API for cannet's
   needs from the start (paged reading aligned with the disk-spill
   store of [ADR 0001](0001-indefinite-length-capture.md) and
   [ADR 0002](0002-disk-spill-store.md), arbitrary-object write
   surface for markers), no upstream-PR bottleneck, bus factor
   under our control. LLM-assisted implementation against a
   published spec makes this realistic in a way it wouldn't have
   been before — the bar for "just write the Rust crate yourself"
   is lower than the bar for adopting a C++ library through FFI.

This aligns with CLAUDE.md's "Work in small, verifiable steps"
guidance: BLF's on-disk format is fixed-size records and
length-prefixed objects against a public spec — exactly the shape
the working agreement identifies as worth hand-rolling (small,
controlled, the hard parts are spec-driven, not failure-mode-rich).

## Implementation sources

The implementation works from Vector's published spec, with existing
implementations consulted as cross-checks, not copied from:

- **Vector's "Read Write BLF API 2018 Version 8" reference
  package** — Vector Informatik's publicly-distributed C headers
  (`binlog.h` for the API, `binlog_objects.h` for object-type
  defines and `VBL*` struct definitions), Copyright Vector
  Informatik 2002, distributed via the
  [NI Forums mirror](https://forums.ni.com/t5/Example-Code/Read-and-Write-BLF-Files/ta-p/3549766)
  referenced in `ablf`'s README. This is the spec the BLF
  feature-support matrix in
  [`docs/blf-feature-support.md`](../blf-feature-support.md) cites
  by line number; treat it as the primary normative source.
- **`ablf` 0.2.1** — structural reference for the outer container,
  object header framing, and `LOG_CONTAINER` / compression.
- **`blf_asc` 0.2.0** — CAN FD message-decoding reference, since
  it's the only Rust crate that decodes object types 100 / 101.
- **`python-can`'s BLF I/O** (Apache-2.0) — cross-check on
  semantics where `ablf` and `blf_asc` differ or are silent.
- **Vector CANalyzer output** — the user runs CANalyzer to generate
  reference BLFs we round-trip.

`vector_blf` itself is consulted only as a black-box test oracle
(test source 4 below), never as a source of struct layouts or
decoding logic — those are derived from the spec and the references
above. The implementer should be able to attest that no code was
copied from `vector_blf` into `cannet-blf`.

## Test coverage strategy

The new crate is tested against four independent sources:

1. **`python-can`'s built-in BLF test files** — the most-exercised
   open BLF test set, hardened by years of community use on the CAN
   subset. Vendored under `crates/cannet-blf/tests/fixtures/python-can/`.
2. **`blf_asc`'s test fixtures** — CAN classic, CAN FD, and
   error-frame fixtures already on our cargo cache via the existing
   dep, captured into the same fixtures tree before the `blf_asc`
   dep is retired.
3. **Vector CANalyzer round-trips** — BLFs generated by Vector
   CANalyzer (the reference tool) are round-tripped through our
   reader and writer; we verify byte-equivalence on the lossless
   types and semantic-equivalence on the rest. Fixtures live in
   `crates/cannet-blf/tests/fixtures/canalyzer/`.
4. **Technica `vector_blf` — fixtures and live oracle.** At test
   time, a build script clones Technica's repository at a pinned
   upstream ref (a release tag or commit SHA — the specific ref is
   selected at implementation time and recorded in the build
   script). The clone lands in `target/`, **never vendored** in
   the cannet repo. Two uses:
   - *Fixtures:* the cloned `tests/` directory provides real-world
     BLFs across object types.
   - *Live oracle:* the cmake build produces the `vector_blf`
     library; a small test-only C++ harness links it and exposes
     "read this BLF, write back to that path, dump structured
     object stream." `cannet-blf`'s tests invoke the harness as a
     black-box oracle — read a fixture through both `vector_blf`
     and `cannet-blf`, write back through both, compare bytes on
     lossless types or decoded fields on lossy ones. The harness
     and the compiled `vector_blf` are test-time artifacts in
     `target/`, never shipped in cannet's runtime binary. Pinning
     the upstream ref keeps the oracle reproducible across CI runs
     and across reviewers.

The combination gives us compatibility checking against the two
most-used BLF implementations in the open ecosystem: `python-can`
(corpus 1) and `vector_blf` (corpus 4).

## Consequences

- **`cannet-blf` grows.** Today it's a ~700-LOC wrapper around
  `blf_asc` ([crates/cannet-blf/src/lib.rs](../../crates/cannet-blf/src/lib.rs)).
  Post-implementation it owns its BLF reader and writer for the
  required-and-desired feature set, behind the same public API.
  Estimated scale: ~1500–2500 Rust LOC for the initial scope
  (CAN classic + CAN FD + error frames + LOG_CONTAINER +
  GLOBAL_MARKER + EVENT_COMMENT + CAN_STATISTIC + DATA_LOST_BEGIN/END).
- **`blf_asc` and `ablf` retire from the dep tree** when the new
  implementation reaches parity. Their inventory entries shrink to
  "considered as alternatives; see this ADR."
- **The BLF feature-support matrix is the running checklist.** When
  the implementation gains support for a new object type, that
  matrix's row updates in the same commit (per the doc's own
  maintenance section).
- **`<file>.blf.notes.json` migration unblocks** as soon as the new
  crate supports `GLOBAL_MARKER` write. The backlog item for the
  notes-sidecar removal stays gated on that — but the gating
  upstream contribution (to `blf_asc`) is no longer needed.
- **Phased delivery.** Tranches matching the type-coverage priorities:
  (1) parity with current `cannet-blf` (CAN classic + FD + error +
  LOG_CONTAINER read+write); (2) `GLOBAL_MARKER` read+write (unblocks
  sidecar removal per [ADR 0010](0010-no-sidecar-files.md));
  (3) `EVENT_COMMENT` + `APP_TEXT` (preserves third-party annotations);
  (4) `CAN_STATISTIC` + `DATA_LOST_BEGIN/END` (capture-integrity
  surfacing). Scheduled in `plans/phased-implementation.md` when
  picked up; not blocking on the disk-spill capture-store work
  (ADRs [0001](0001-indefinite-length-capture.md) /
  [0002](0002-disk-spill-store.md)).
- **Optional future contribution.** If the implementation matures
  well, publishing it as a standalone crate would fill a real gap
  in the Rust BLF ecosystem — no existing Rust crate covers
  CAN FD + markers + writes. Not a goal, but the option stays open.
