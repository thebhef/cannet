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
  decoupled from the ingest rate
  ([ADR 0025](0025-frontend-windowed-source-contract.md)).
- **Loss-free addressability.** Every historical row stays addressable
  for the life of the capture (ADR 0001).
- **Reviewability.** Keep the hand-written surface small and lean
  on a vetted library for the failure-mode-rich parts.
- **Not a serialization artifact.** The disk-spill store is the
  *live working store* — scratch, not a saved-capture format.
  Explicit `.blf` "Save Capture" stays the separate export path.
  (The on-disk files are not deleted on exit — see DS-7.)

## Decision

Seven decisions, DS-1 through DS-7.

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

The periodic flush is **asynchronous** (`msync(MS_ASYNC)` /
`FlushViewOfFile`): it only re-syncs the segments dirtied since the last
flush (incremental — sealed segments are immutable and synced once) and
it does **not** wait for the device, because waiting on a per-segment
`fsync` would pin the append lock and stall ingest/transmit on a periodic
sawtooth. The durability this store actually owes is **survive a process
restart** — `current/` is reloaded as a stopped trace at the next launch
(DS-7) — and that is preserved unconditionally: an async msync leaves
every write in the OS page cache, which backs the same file a reopen
maps, so a reopen in the same OS session sees all of it. Only a
**power loss or OS crash** in the window before physical writeback can
lose the trailing frames since the last sync — an acceptable loss for an
**ephemeral** scratch that is wiped on the next Start/Clear anyway. A
single **synchronous** flush runs on clean shutdown to harden that
trailing window against a power loss right after quit.

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

### DS-7 — Scratch lifecycle: cache directory, reset-on-new-trace

The scratch files live in a single directory under the OS cache
directory: `$XDG_CACHE_HOME/cannet/current/` on Linux, the OS
equivalents on macOS and Windows (Tauri's `PathResolver::app_cache_dir()`
is the natural source). There is at most one trace in scope at a
time, so one directory — not a per-session subdirectory — is the
honest data model.

`current/` is the home for **all session-scoped data the GUI is
mutating**, not only the raw frame store. That includes the raw
metadata and payload (DS-1), the `by-id` and filter indexes (DS-3),
the per-signal decimated pyramids (DS-5), and **session-authored
markers and events** — `GLOBAL_MARKER` and `EVENT_COMMENT` records
authored during a live capture before any `.blf` Save, and
markers/events accumulated against an already-open BLF before its
next Save back out. On Save Capture, markers and events fold into
the output `.blf` per [ADR 0010](0010-no-sidecar-files.md); until
then `current/` is where they live. (Exact on-disk form for
markers/events is left to the implementer — appendable BLF-record
files are the natural fit since Save already writes that format.)

**Lifecycle: reset on new trace, never on exit.** `current/` is
wiped exactly when the *session buffer* is wiped:

- **Clear** (user-initiated) — wipes `current/` and starts fresh.
- **Start a new capture from a stopped state** — wipes `current/`
  and starts fresh. Starting a fresh capture *is* discarding the
  previous trace; the disk scratch and the session buffer go
  together.
- **Exit / panic / crash** — `current/` is left alone.

Together these mean: whenever a project is opened (auto-reopen at
launch, or manual Open Project), if `current/` exists *and its
recorded project identity matches the project being opened*, it is
loaded as a **stopped, historical trace** — the prior session the
user did not explicitly discard. From there the user can Save
Capture to a `.blf` (preserving it), or Start (wiping it and
beginning a new capture). There is no automatic background cleanup
at any time.

(For context: today the frontend auto-reopens the last project at
launch by reading a host-persisted last-project pointer (ADR 0032) and
calling `open_project`. DS-7's gate runs as part of that `open_project`
call. The host carries no project-reload memory of its own — `current/`
is *not* a launch trigger, only a match against whatever project the
frontend opens.)

**Project identity gate.** `current/` records the identity of the
project it belongs to, plus the project's path at the time the
scratch was created. The identity is what gates loading; the path is
a host-side diagnostic / robustness record (so the host has its own
trace of which project the scratch belongs to, independent of the
last-project pointer). On `open_project`, the scratch
loads only when its recorded identity matches the project's
identity; otherwise it stays on disk, invisible to the active
project. Opening a *different* project is not a wipe trigger; only
Clear and Start wipe. (So opening project B hides project A's
scratch but doesn't destroy it; reopening project A brings it back.)

Identity must be **stable across rename and move** — a project's
file path is the user's to change at any time, and the last-project
pointer can go stale or be wiped. The identity is a
UUID embedded inside the project JSON file, generated once when the
project is first created and never modified after. This adds a
`project_id: Uuid` field to the `Project` schema. [ADR 0011](0011-project-file-format.md)
rejects rather than migrates a non-current `schema_version`, so the
field is added the way other backward-compatible fields are (e.g.
`transmit_frames`): an **additive field with a generating serde
default, no version bump**. An older file with no id gains a freshly
generated one when it is read; because the field is host-managed (the
frontend's save payload omits it, like `transmit_frames`), `save_project`
anchors it to the target file — preserving the id already on disk and
writing a new one only for a brand-new file — so it stays stable across
saves. The path recorded alongside the identity in `current/` is
best-effort diagnostic data, not the basis for the match.

This is deliberate. The on-disk formats are reload-compatible by
construction (DS-1's arithmetic-addressable fixed-size records,
DS-3's append-only indexes, DS-5's append-only pyramids, and the
append-only marker/event files all survive a process exit
unchanged), which is what makes the launch-loads-prior-as-stopped
behavior mechanically free — including the markers and events
authored before the crash. Auto-deleting on exit, or on crash, would
foreclose that path without changing the formats that enable it.
The opt-in `clear on exit` toggle belongs in a future settings
panel, not in the always-on cleanup policy.

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
- **Auto-cleanup of scratch files on exit (or on crash).** Rejected
  (DS-7). mmap'd files persist after process exit — the format is
  reload-compatible by construction, and auto-deleting on exit (or,
  worse, attempting to scrub on crash) would foreclose the "launch
  loads the prior session as a stopped trace" behavior whose
  mechanism is already in place. Cleanup happens only when the
  *session buffer* is reset (Clear, or Start of a new capture);
  opt-in clear-on-exit is a future settings-panel item, not an
  always-on behavior.
- **Per-session subdirectory under the cache root.** Rejected (DS-7).
  Only one trace is ever in scope, so a single `current/` directory
  is the honest data model — per-session subdirs would either always
  hold exactly one occupant (waste) or imply a multi-session history
  the product does not have.
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
  [ADR 0025](0025-frontend-windowed-source-contract.md) are unchanged;
  only their implementation swaps.
- The disk-spill store is **scratch, not a serialization format** —
  "Save Capture" to `.blf` remains the separate export and the
  canonical durable form. No new `.blf` sidecar is introduced
  ([ADR 0010](0010-no-sidecar-files.md)). Per DS-7 the scratch files
  *do* survive across runs (cleanup is manual via the GUI Clear
  action), so the format is reload-compatible — a property a future
  "recover unsaved capture" feature can use without revisiting this
  ADR.
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
