# ADR 0002 — Disk-spill store: append-only mmap'd segments with materialized indexes

Status: accepted (2026-05-20)

## Context

[ADR 0001](0001-indefinite-length-capture.md) fixed that captures are
indefinite-length and that the raw store is random-access and
disk-spilled. It deliberately deferred the on-disk format, the index
structure, the hot-window eviction policy, and the decimated tiers.

This ADR makes those deferred decisions.

The constraints they answer to:

- **Scale.** 10^7 to 10^9 frames, multi-hour to multi-day sessions.
  The raw store and any per-frame projection exceed RAM.
- **Responsiveness.** GUI interactions stay < 100 ms / 60 fps,
  decoupled from the ingest rate (`windowed-model-convergence.md`).
- **Loss-free addressability.** Every historical row stays addressable
  for the life of the capture (ADR 0001).
- **Reviewability.** Keep the hand-written surface small and lean
  on a vetted library for the failure-mode-rich parts.
- **Not a serialization artifact.** The disk-spill store is the
  *live working store* — ephemeral scratch, rebuilt each session.
  Explicit `.blf` "Save Capture" stays the separate export path;
  this scratch store is not a saved-capture format.

## Decision

Six decisions, DS-1 through DS-6.

### DS-1 — On-disk format

The raw store is two append-only files: a **metadata file** of
fixed-size records (~26 B each) and a packed **payload blob**. Records
are fixed-size, so row N is found by arithmetic — `offset = N ×
record_size` — with no index structure. Each metadata record carries
the frame's scalar fields — timestamp, interned bus index, arbitration
id, flags — and an inline `(offset, len)` into the payload blob.
`bus_id` is interned to a small integer index.

### DS-2 — Tiering

Writes are **write-through**: every frame is appended straight to the
two files, buffered, and flushed on a cadence. Readers `mmap` the
files; the **kernel page cache is the hot tier** — there is no
hand-rolled hot-window cache and no eviction policy. A small **RAM
ring** holds the most recent frames that have not yet been flushed, so
a read of the live tail is served from RAM until those bytes are
durable.

### DS-3 — Indexes

Indexes are materialized as append-only mmap'd files.

`by-id` is an always-on family of per-id index files: for each
arbitration id, the ordered list of its frame indices.

Every filter gets a materialized index, and **every filter predicate
is id-narrowable against the loaded DBC** — so every filter index is
built off `by-id`, never by scanning the capture:

- `bus`, `id_range`, `id_list` resolve to a pure id set; the index is
  the merge of those ids' `by-id` lists. No decode.
- `name_regex` matches a DBC message/signal name, which is a property
  of the DBC keyed by id. Evaluating the regex against the DBC's names
  yields the exact id set; the index is the merge of those ids'
  `by-id` lists. It resolves the *DBC*, not the *frames* — no
  per-frame decode.
- `signal_equals { name, value }` — the signal name resolves via the
  DBC to the message id(s) carrying that signal, a small candidate id
  set. The index is built by decoding only those candidate ids'
  frames — located via `by-id` — and testing the value.
- `all` / `any` compose the candidate id sets by intersection /
  union.

So no filter index build is an O(capture) scan; each is bounded by its
candidate ids' occurrence counts. Filter index files are dropped when
the predicate changes; `by-id` is persistent for the life of the
capture. Paging a filtered view is always O(page).

### DS-4 — Segmentation

Every file family — raw metadata, raw payload, and each index — is a
sequence of fixed-size segment files. Each segment is **pre-allocated
to its full size and mapped whole**, with a separately tracked
**valid-length watermark** recording how much of it is real data.
Sealed (full) segments are immutable and mapped once. Only the tail
segment is active; because it is already full-size, it never needs to
be resized while mapped — which Windows forbids (`SetEndOfFile` fails
on a file with an active mapping, and a mapping is created with a
fixed maximum size).

Readers map only sealed segments. The active tail's not-yet-durable
bytes are served from the DS-2 RAM ring, so the design never depends
on `write()`/`mmap` coherency — a guarantee POSIX gives but Windows
does not.

The raw store shares one frame-count epoch across its metadata and
payload segments. Each index family tracks its own count.

### DS-5 — Decimated tier

The decoded-signal cache gains a per-signal **resolution pyramid**:
level 0 is the raw decoded series; level n is min/max over buckets of
Bⁿ samples. `DecimatedRange` serves a plot by reading the coarsest
level whose point count still exceeds `maxPoints`, so a "fit data"
over the whole capture reads a bounded number of points instead of
re-decoding the raw series. Per-bucket min/max means spikes survive
decimation.

A signal's pyramid is built lazily on first plot and
**by-id-accelerated**: the signal's frames are located via its message
id's `by-id` list, decoded once, and folded up the pyramid — so the
build is O(that id's occurrences), not O(capture).

### DS-6 — Always-on

The disk-backed store is the only production path. `TraceStore` is a
trait; the in-RAM `Vec` implementation retires to a **test double**.
There is one production implementation and one test implementation —
not two production paths to keep in sync.

## Alternatives considered

- **An embedded database for the raw store (SQLite, LMDB, RocksDB).**
  Rejected. The raw store's access pattern is append plus random read
  by a dense integer key — exactly what a fixed-size-record file
  answers with arithmetic. A SQL or KV engine adds a dependency and a
  query/transaction layer for an access pattern that is array
  indexing. A library *is* warranted for the failure-mode-rich part —
  the `mmap` syscall abstraction — and that is `memmap2` (see
  Consequences).
- **A hand-rolled hot-window cache with an eviction policy.** Rejected
  (DS-2). The kernel page cache is already an LRU file cache — shared
  across processes, tuned, and the demand-paging path the OS uses for
  everything. Hand-rolling one is expensive-to-review surface for no
  gain over `mmap`.
- **A single growing file per family instead of segments.** Rejected
  (DS-4). A growing mapped file must be remapped as it grows, and
  Windows cannot resize a file that has an active mapping. Fixed-size
  pre-allocated segments are mapped once and never move.
- **An O(capture) decode scan to build decode-requiring filter
  indexes.** Rejected (DS-3). An earlier draft treated `name_regex`
  and `signal_equals` as needing a one-time full-capture decode scan.
  They do not: every predicate is id-narrowable against the DBC, so
  every filter index builds off `by-id` and is bounded by candidate-id
  occurrence counts. `name_regex` needs the DBC resolved, not the
  frames decoded; `signal_equals` decodes only its candidate ids'
  frames.
- **Keeping the in-RAM `Vec` store as a parallel production path.**
  Rejected (DS-6). Two production implementations of one contract is
  duplication the project has already shed on the view side; the
  `Vec` store earns its keep only as a test double.
- **Raw `libc` / `windows-sys` FFI for the `mmap` syscalls.**
  Rejected. `memmap2` already wraps POSIX `mmap` and Windows
  `CreateFileMapping` / `MapViewOfFile` behind one Rust API.
  Re-creating that per-OS plumbing is hand-written failure-mode
  surface for no gain — `memmap2` is the maintained successor to
  the unmaintained `memmap` crate and the de-facto Rust standard.
- **An append-only file with no random-access index** was already
  rejected in ADR 0001; DS-1's fixed-size records are how this ADR
  delivers the random access ADR 0001 requires.

## Consequences

- **New dependency: `memmap2`** (cross-platform `mmap`: POSIX `mmap`
  on Unix, `CreateFileMapping` / `MapViewOfFile` on Windows;
  MIT/Apache-2.0). Recorded in `plans/technology-inventory.md`.
- The `RowPage` / `DecimatedRange` host accessor signatures from
  [ADR 0001](0001-indefinite-length-capture.md) are unchanged; only
  their implementation swaps.
- The disk-spill store is **ephemeral scratch** — created per session,
  not persisted across runs, and not a serialization format. "Save
  Capture" to `.blf` remains the separate export. No new `.blf`
  sidecar is introduced ([ADR 0010](0010-no-sidecar-files.md)).
- **Disk-space cost.** ~26 B per frame of metadata plus payload; a
  10^9-frame capture needs tens of GB of scratch space. The host sites
  the scratch files on a volume with room and surfaces a clear error
  if it runs out. `by-id` and the per-signal pyramids persist for the
  capture's life and add their own disk cost; filter index files are
  transient (dropped on predicate change).
- An I/O error on a mapped page raises `SIGBUS` (Unix) or
  `EXCEPTION_IN_PAGE_ERROR` (Windows) rather than a recoverable error
  return — an acceptable "the scratch volume failed" failure mode for
  an ephemeral store.
- The design is exercised at 10^8+ frames by an exit benchmark.
