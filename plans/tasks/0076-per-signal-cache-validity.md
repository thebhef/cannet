# Task 76 — Per-Signal Cache Validity + Retention

Opened by owner ruling 2026-08-14 (grooming dialogue for the 71–75
cycle): "mtime is not enough; if the encoding for a given signal
hasn't changed, we should not require a rebuild of that signal's
cache," and "be conservative about dropping signals from the disk
cache; it's expensive to build them in bulk … maybe keeping a
bounded MRU collection of unreferenced signal caches."

Today ([`signal_cache.rs`] `PyramidValidity`, ADR 0047) one global
stamp — capture id, whole-DBC-set fingerprint (path + bus scoping +
load order + file size + mtime), low-water mark — gates the entire
persisted pyramid set. Any mismatch discards **every** signal's
pyramid and cold-rebuilds by re-decoding raw frames (minutes-scale on
a large session), including file-backed signals whose samples never
came from a DBC. A touched-but-unchanged DBC (copy, checkout, backup
tool rewriting mtime) pays the full price for an identical decode.

## Scope

1. **Per-signal encoding fingerprint.** `capture_id` + `low_water`
   stay global (they gate whether the raw frames are the same
   capture). The DBC-set fingerprint is replaced by a fingerprint
   stored per `PersistedSignal`: a hash of that signal's _effective
   decode spec_ after load-order / bus-scope resolution — start bit,
   length, byte order, sign, scale/offset, mux chain, message
   id/extended, bus scoping, and anything else that feeds a decode.
   On restore each signal is judged alone: match → reopen; mismatch →
   rebuild that signal only (the frame scan runs once, decoding only
   the invalidated subset). File-backed signals fingerprint against
   their source-file identity, not the DBC set.
2. **Bounded MRU retention of unreferenced caches.** A signal whose
   definition disappeared (DBC unloaded / edited away) or that the
   model no longer references moves to a bounded retention pool
   instead of being deleted — bounded by bytes (a slice of the cache
   budget, accounted beside the existing `cache_mb` tracking),
   evict-oldest. A definition returning with a matching fingerprint
   revives the cache instead of rebuilding.

3. **Usage metrics** (owner ruling 2026-08-14): log metrics that
   show how the scratch and the signal-pyramid cache are actually
   being used, enough to answer "are we saving time or wasting
   disk." At minimum: per restore, signals reopened vs rebuilt and
   the bytes reused vs re-decoded; for the retention pool, revivals
   vs evictions and bytes currently retained; and enough about
   ongoing use (e.g. which persisted signals a session ever reads
   again) to see disk that is never earning its keep. Grooming the
   exact counter set is part of the phase; surfaced through the
   existing seams — the restore breakdown log line and the health
   sample's cache accounting — not a new telemetry channel.

## Grooming rulings (2026-08-14)

- Retention-pool bound: settings-backed absolute disk budget in
  `settings.json` beside the existing cache knobs, **default
  16 GB**, evict-oldest, pool usage visible in the health sample's
  cache accounting. (Rationale: unloading a DBC parks every affected
  signal cache at once — a full session's pyramid set is ~1.6 GB
  observed — so the default must hold several complete sets for the
  reload-later case to actually get revivals.)

## Design risks (recorded at opening)

- **Fingerprint completeness is the safety property.** Missing one
  decode-relevant input means serving stale decodes that look valid.
  The design starts with a "what feeds a decode" audit; every input
  found gets a test pinning that its change moves the fingerprint
  (extend the pattern of
  `the_dbc_fingerprint_moves_with_everything_that_changes_a_decode`).
  Open codebase question to answer during design: whether enum value
  labels are baked into pyramid samples or resolved at serve — bakes
  join the fingerprint, serve-time lookups don't.
- **"First DBC that decodes wins" priority**: the fingerprint must be
  over the _winning_ effective spec, so a priority change that does
  not change the winner does not invalidate.
- The retention pool must not resurrect caches across capture
  identity or low-water changes — those two stay hard gates.

## Exit criteria (draft — firm at grooming)

- A DBC touch that changes no encoding invalidates nothing: restore
  reuses every pyramid (regression-tested with a rewritten-mtime
  fixture).
- An encoding change to one signal rebuilds exactly that signal's
  pyramid; the rest reopen (tested).
- File-backed signal pyramids survive DBC-set changes (tested).
- The decode-input audit is recorded in the status log; every input
  has a fingerprint-moves test.
- Unreferenced caches are retained up to the byte bound, evicted
  oldest-first, and revived on a fingerprint match (tested); the
  bound is visible in the health sample's cache accounting.
- The usage metrics land: a restore's reopened/rebuilt split (and
  bytes) is in its log line; pool revivals/evictions, retained
  bytes, and ongoing-use visibility (persisted-but-never-read
  signals identifiable) are in the health sample's cache
  accounting — enough to answer "saving time or wasting disk" from
  a log alone.
- ADR 0047 amended to record the per-signal validity model.
- ADR-0031 perf gate on the final build (restore path is a data-path
  hot spot); all metrics, no baseline promotion.

## Status log

### 2026-08-15 — phase 1: the decode-input audit

Phase 1 builds and persists the per-signal fingerprint layer. It does
**not** change restore behaviour: the global `PyramidValidity` gate
keeps governing restore until phase 2 switches it over.

#### The decode path, walked

What a DBC-backed pyramid sample *is*: `sampling.rs` takes every
loaded database in load order (`db_refs`, `sampling.rs:252`) and hands
the whole set to `SignalCacheStore::slice_many`. `scan_chunk`
(`signal_cache.rs:830`) fetches the frames of one
`(message_id, extended)` group, drops the ones whose `bus_id` doesn't
match the *series'* scoping, and calls
`signal_sampler::sample_shared` (`signal_sampler.rs:97`), which
decodes the frame against each database **in load order** and takes,
per signal name, the first database that yields that name —
`Database::decode_raw` then `decode_message` (`decode.rs:86`) then
`decode_signal` (`decode.rs:126`). What lands in the pyramid is
`sig.value` (`signal_sampler.rs:126`) and the frame timestamp; a
pyramid slot is a `(f64, f64)` pair (`sample_seq.rs:225`).

**Resolution is per frame, not per set.** `decode_message` only emits
a signal whose mux gate passes *for that payload* and whose bits fit
*that payload*, and `sample_shared` falls through to the next database
when the first yields no such name. So a database that "loses" for one
frame can win for the next. The fingerprint therefore covers the whole
**candidate chain** — every loaded database that defines the signal in
that message, in load order — not one nominated winner. A database
that does not define `(message, signal)` contributes nothing, which is
what makes a load-order change between unrelated databases move
nothing.

#### Open question: are enum value labels baked into pyramid samples?

- **Observation.** A pyramid level is a `SampleSeq`; `SampleSeq::get`
  returns `(f64, f64)` and `push` takes `(f64, f64)`
  (`sample_seq.rs:225,240`). `sample_shared` writes `Some(sig.value)`
  — the physical `f64` — and nothing else (`signal_sampler.rs:126`).
  `DecodedSignal::label` is read by the trace-row path
  (`dbc_commands.rs:401`) and dropped on the floor by the sampler.
- **Hypothesis.** Labels are resolved at serve time against the
  currently-loaded DBCs, never baked into a persisted sample, so a
  `VAL_` edit changes no stored sample.
- **Experiment.** Sample the same frames through
  `signal_sampler::sample_signal` against three databases that differ
  *only* in their `VAL_` table (none / two labels / two different
  labels) and compare the returned `SamplePoint`s.
  (`signal_fingerprint.rs::labels_are_resolved_at_serve_not_baked_into_samples`)
- **Data.** Identical `SamplePoint`s in all three cases; the storage
  type has no field a label could occupy.
- **Conclusion.** **Not baked.** Labels come from `list_value_tables`
  (`dbc_commands.rs:424`), which resolves them per query — for a
  DBC-backed signal against the loaded set, first-match-wins; for a
  file-backed one from the `FileSignalInfo::value_table` the manifest
  itself carries. A `VAL_` change is visible on the next serve with no
  rebuild. **`VAL_` stays out of the fingerprint.**

#### The audit table

Everything that feeds a DBC-backed decode, and what it does here.
"Pinned by" names the test in
`apps/gui/src-tauri/src/signal_fingerprint.rs`.

| Decode input | Where it lives | In? | Pinned by |
| --- | --- | --- | --- |
| `SG_` start bit | `Signal::start_bit`, `decode_signal_bits` (`decode.rs:130`) | yes | `every_bit_layout_input_moves_the_fingerprint` |
| `SG_` length | `Signal::size` (`decode.rs:129`) | yes | `every_bit_layout_input_moves_the_fingerprint` |
| Byte order `@1`/`@0` | `Signal::byte_order`, `bitwalk::walk` | yes | `every_bit_layout_input_moves_the_fingerprint` |
| Sign `+`/`-` | `Signal::value_type`, `sign_extend` (`decode.rs:132`) | yes | `every_bit_layout_input_moves_the_fingerprint` |
| Factor | `Signal::factor`, `mul_add` (`decode.rs:146`) | yes | `every_scaling_input_moves_the_fingerprint` |
| Offset | `Signal::offset`, `mul_add` | yes | `every_scaling_input_moves_the_fingerprint` |
| `SIG_VALTYPE_` float kind | `SignalEntry::extended_type` (`decode.rs:146`) | yes | `every_scaling_input_moves_the_fingerprint` |
| Mux indicator / selector | `Signal::multiplexer_indicator` (`decode.rs:102`) | yes | `every_mux_input_moves_the_fingerprint` |
| The message's mux **gate** bits | first `Multiplexor` signal of the message (`decode.rs:89`) — only its `start_bit`/`size`/`byte_order`, since the gate compares `raw_unsigned` | yes, when the signal is gated | `every_mux_input_moves_the_fingerprint` |
| Message id + addressing mode | `MessageKey` = `can_dbc::MessageId`; `canid_to_message_id` (`decode.rs:66`) | yes | `message_identity_moves_the_fingerprint` |
| Signal name, incl. `SystemSignalLongSymbol` rename | `parse.rs:72` rewrites `signal.name`; `sample_shared` matches on it | yes | `signal_identity_moves_the_fingerprint` |
| Which databases are loaded | `db_refs` (`sampling.rs:252`) | yes (chain membership) | `the_dbc_set_resolution_moves_the_fingerprint` |
| Load order ("first DBC that decodes wins") | `sample_shared` (`signal_sampler.rs:114`) | yes (the chain is ordered) | `the_dbc_set_resolution_moves_the_fingerprint`, `a_load_order_change_that_does_not_change_the_winner_moves_nothing` |
| Duplicate `SG_` name inside one message | `decode_message` emits both; `find` takes the first that survived the mux gate | yes (every same-named entry, in declared order) | `the_dbc_set_resolution_moves_the_fingerprint` |
| A contributing DBC's bus scoping | `LoadedDbc::buses` | yes — **conservatively**, see side effects | `the_dbc_set_resolution_moves_the_fingerprint` |
| `VAL_` value table / enum-ness | serve-time `list_value_tables` (`dbc_commands.rs:424`) | no | `labels_are_resolved_at_serve_not_baked_into_samples`, `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| Unit | `DecodedSignal::unit`, never sampled | no | `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| `BO_` declared length (`expected_len`) | reported by `decode_message`, but `decode_signal_bits` bounds-checks the **actual** payload (`decode.rs:27`) | no | `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| Declared min/max | parsed, never read by decode | no | `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| Message name / `SystemMessageLongSymbol` | `MessageEntry::name`; lookup is by id | no | `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| Comments, `BA_` attributes, transmitter, `GenMsgCycleTime`, `GenMsgSendType`, `GenSigStartValue` | `MessageEntry` / `SignalEntry` metadata | no | `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| `CannetDisplay "radix=hex"` | `SignalEntry::display_hex` — render only (ADR 0043) | no | `nothing_that_only_labels_or_describes_moves_the_fingerprint` |
| `CannetCounter` / `CannetCrc` calculated fields | `MessageEntry::calc_fields`, read only by transmit + verification | no | — (no decode seam to pin) |
| `is_fd` / `brs` | `MessageEntry`, transmit only | no | — (no decode seam to pin) |
| DBC file path, size, mtime | `app_state::dbc_fingerprint` — the **global** stamp | no (this is the point) | `a_touched_but_unchanged_dbc_moves_no_signals_fingerprint` |
| Frame `bus_id` filter | series identity, `scan_chunk` (`signal_cache.rs:861`) | key, not encoding | — (carried verbatim in the manifest row) |
| Capture identity, low-water mark | `PyramidValidity` | stays global | existing `every_kind_of_key_mismatch_rebuilds` |

File-backed series fingerprint against their source instead:

| Input | In? | Pinned by |
| --- | --- | --- |
| `source_path` | yes | `a_file_backed_signal_fingerprints_against_its_source_not_the_dbc_set` |
| Signal channel group index | yes | same |
| Channel name | yes | same |
| Loaded DBC set (any of it) | no | same |
| Source file size / mtime | no — the samples were read once at import and the file is never re-read; requiring a stat would invalidate on a file that has merely moved, or vanished | same |
| `value_table`, unit, group name | no — carried in the manifest row and served from there | same |

### 2026-08-15 — phase 1: the fingerprint layer lands

Branch `task76-p1-signal-fingerprints`, off `task74-trust-flow`.

| Commit | What landed |
| --- | --- |
| `1c08dd8` | the decode-input audit above |
| `8dfd474` | `cannet_dbc::Database::signal_decode_specs` — the effective decode spec as a public type |
| `bf73bad` | `signal_fingerprint.rs`, the fingerprint per `PersistedSignal`, and the audit-pinning suite |

Tests: `cannet-gui` 670 → **684** (12 fingerprint tests, 2 persistence
tests), `cannet-dbc` 108 → **109**, frontend unchanged at 2215 in 164
files (nothing under `apps/gui/src` was touched). `cargo clippy
--all-targets` clean on both touched crates, `cargo fmt --check` clean.

#### What the fingerprint is

`Database::signal_decode_specs(id, name)` answers "what would this
database decode this signal with?" — every `SG_` entry that could answer
to the name in that message, in declaration order, carrying exactly the
fields `decode_signal` reads. `signal_fingerprint::dbc_encoding` hashes
the series' key and then that signal's **candidate chain**: each loaded
database that contributes at least one spec, in load order, with its bus
scoping. `file_source` hashes a file-backed series' source path, group
index and channel name.

Design choices worth carrying into phase 2:

- **Chain, not winner.** The recorded design risk asked for the *winning*
  effective spec. There is no single winner to take: resolution is per
  frame (see the audit above), so the faithful reading of "the winning
  spec" is "everything that could win", ordered. It has the property the
  risk was after — a priority change that cannot change any frame's
  decode moves nothing, because a database that defines nothing about the
  signal never enters the chain.
- **Hash and serialization.** FNV-1a 64 over an explicit,
  length-delimited, tagged byte encoding, matching the two fingerprints
  already in this area. Deliberately not `std::hash::Hasher` (SipHash is
  keyed per process — a fingerprint has to survive a relaunch), no
  `HashMap` iteration anywhere in it, integers little-endian and `f64` as
  `to_bits()` so it is identical across platforms. The reasoning is in
  the module's rustdoc.
- **Not judged yet.** `persist` writes an `encoding` per manifest row and
  `restore` reads it back through serde; the whole-set `PyramidValidity`
  still decides everything. `#[serde(default)]` means a manifest written
  before this phase restores exactly as it did.

### 2026-08-15 — phase 2: restore judges each signal alone

Branch `task76-p2-selective-restore`, off `task76-p1-signal-fingerprints`.

| Commit | What landed |
| --- | --- |
| `bb7ec33` | the gate split, the per-signal judgement, the restore breakdown's reopened/rebuilt split, ADR 0047's amendment |

Tests: `cannet-gui` 684 → **686** (four new restore-judgement tests; one
whole-set-stamp test deleted with the stamp, one compat test rewritten),
`cannet-dbc` unchanged at 109, frontend unchanged at 2215 in 164 files
(nothing under `apps/gui/src` was touched). `cargo clippy --all-targets`
clean, `cargo fmt --check` clean.

#### The gate split, as landed

`PyramidValidity` is now `{ capture_id, low_water }` — the two facts
about the *frames*, whole-set, discarding everything on a mismatch. Past
them each `PersistedSignal` answers for itself:

| Row | Judged by |
| --- | --- |
| DBC-backed | its `encoding` fingerprint recomputed against the loaded set, **plus** its own cursor ≤ `store_len` |
| file-backed | nothing beyond the global gates — see below |

The **cursor bound went per row** (it was "any row past the tip rejects
every DBC row"). It is a property of one cache — a cursor ahead of the
tip never revisits the frames it skipped — so judging it per row rebuilds
exactly the affected signal. Crash-truncation normally moves every row at
once, so this is a refinement, not a behaviour the tests could tell apart
before.

**Reopening stays all-or-nothing within a provenance.** A level file that
does not answer to its manifest row is evidence about the *directory*,
not about one encoding, and `reopen_set` maps the whole batch in one
parallel open. Judging is per signal; file-level trust is not.

#### The manifest-compatibility choice

A row with no `encoding` (a manifest written before phase 1):

- **DBC-backed → rebuild.** The fingerprint is a fact about the model the
  samples were decoded against, and that model is *not* in the row. There
  is nothing to judge it by, and the raw frames can always produce it
  again.
- **File-backed → reopen.** Its fingerprint is a function of the row's own
  fields (`source_path`, group index, channel name), so re-deriving it is
  exact and its absence hides nothing. And "rebuild" is not on offer:
  those samples were read once, at import, from a file that may be long
  gone — treating the absent fingerprint as a mismatch would delete
  imported data outright to protect against a judgement that could not
  have failed. This is the "strictly better faithful option" the phase
  brief left open, and it is confined to the provenance that has it.

Which is why the file-backed fingerprint is not compared on restore even
when present: every input to it travels in the row, so the comparison is
a tautology. It is written for phase 3's retention pool, where a revival
*does* match a cache against a definition that arrived separately.

#### The old whole-set stamp: retired, not kept

`PyramidValidity.dbcs` and `app_state::dbc_fingerprint` are **gone**, not
left write-only. What the stamp covered, the candidate chain covers
better: a database added, removed, re-scoped, re-ordered, or edited all
move the chain (or provably cannot change the decode, which is the
point). What it covered *worse* is the whole reason for the task — it
read file metadata, so a copy or a `touch` discarded everything. Keeping
a field nothing judges would leave the next reader to work out which of
two stamps decides. Old manifests still restore: serde ignores the
retired key, and their rows are judged on their own fingerprints.

#### One scan, not one per signal

Structurally there was nothing to build: the rebuilt rows are simply
absent from `by_key`, so the next serve creates them cold and
`catch_up_keys` batches them with everything else on their
`(message_id, extended)` group. The group scans from its *minimum*
cursor, and `scan_chunk` builds its decode name list per frame from the
targets that frame is still ahead of — so a reopened neighbour sitting at
the tip is neither fetched for nor decoded. `the_invalidated_subset_
rebuilds_in_one_walk_of_its_message` pins both halves: the fetch count
over a capture longer than a chunk is one walk (not one per signal), and
`scan_chunk` called directly with a caught-up target and a behind one
produces decode output only for the latter.

#### The tests were checked by falsification

Each new assertion was confirmed load-bearing by breaking the code under
it and watching it fail:

| Sabotage | Failed |
| --- | --- |
| judgement always matches | the encoding-change, file-backed, compat and one-walk tests (4) |
| judgement never matches | those plus the touched-DBC and every reuse test (9) |
| `rebuilding` counts reopened caches | the encoding-change test's announcement assertion |

#### Metrics: counts now, bytes deferred

The breakdown line reports `pyramids {ms} (N reopened, M rebuilt)`, and
the rebuild notice says how many caches did not match. **Bytes reused vs
re-decoded are not here**: the only honest byte figure is live slots ×
slot size, and `ENTRY_BYTES` is private to `cannet-spill` — exposing it
(or adding a per-row byte accessor) is accounting plumbing, which this
phase's brief reserves for phase 3.

#### Exit criteria this phase owns

| Criterion | Where |
| --- | --- |
| a DBC touch that changes no encoding invalidates nothing | `a_touched_but_unchanged_dbc_reopens_every_pyramid` — a real file, a real `set_modified`, every pyramid reopened and served off disk |
| an encoding change rebuilds exactly that signal | `an_encoding_change_rebuilds_that_signal_and_reopens_the_rest` — 1 reopened / 1 rebuilt, proved over an undecodable store, and the rebuilt row's level files are gone |
| file-backed pyramids survive DBC-set changes | `a_file_backed_series_comes_back_after_a_dbc_change_across_sessions`, now restoring against a set in which nothing defines the decoded signal |

### 2026-08-15 — phase 3: the retention pool and the usage metrics

Branch `task76-p3-retention-metrics`, off `task72-p10-label-box`.

| Commit | What landed |
| --- | --- |
| `7c310e6` | `cannet-spill` publishes what a stored sample costs — the bytes seam phase 2 deferred |
| `d11bcef` | the bounded retention pool, the `pyramid_retention_bytes` knob, the in-session judgement, the restore line's bytes, ADR 0047's amendment, README |
| `ecabdcc` | the health sample's pyramid accounting (never-read + pool) |

Tests: `cannet-gui` 686 → **693** (six retention/metrics tests in
`signal_cache`, one health-line test in `crash`), `cannet-spill` 68 →
**69**, `cannet-dbc` unchanged at 109, frontend unchanged at 2220 in 164
files (`hostSettings.ts` gained the knob's type and default; no
behaviour). `cargo clippy --all-targets` clean on both touched crates,
`cargo fmt --check` clean. Release build clean at `ecabdcc`.

#### The bytes-accounting seam

Phase 2 deferred bytes because "the only honest byte figure is live
slots × slot size, and `ENTRY_BYTES` is private to `cannet-spill`". Two
items are now public, because the accounting asks the question in two
different situations:

- **`SampleSeq::live_bytes()`** — for a run that is mapped (a live
  pyramid's levels). The arithmetic lives beside the layout rather than
  being re-stated by a caller.
- **`cannet_spill::SAMPLE_ENTRY_BYTES`** — for a run that is *not*
  mapped, known only as the `(len, first_slot)` pair a manifest row
  carries. That is the case for every rejected and every parked row, so
  a per-run accessor alone would not have covered it.

Both report **live** slots, so a front-trimmed pyramid is charged what
it kept. Its rustdoc says what it is not: the stored size of the
samples, not the on-disk footprint (segments are geometric and lazily
created — that number is what a directory walk measures, and the health
sample already has it as `pyramid=`).

#### The counter set, settled

Grooming the set was part of the phase. What it came to, and why each
one is in rather than beside it:

**Per restore** — the breakdown log line
(`pyramids {ms} (N reopened, R revived, M rebuilt; reused X MB,
re-decoding Y MB)`):

| Counter | Answers |
| --- | --- |
| `reopened` | how much of the offered set was proved reusable |
| `revived` | how much of that the **pool** supplied — the only number that says whether keeping bytes paid off, and it is a strict subset of `reopened` |
| `rebuilt` | what this launch owes, which is what the rebuild chip is about |
| `reused_bytes` | what the reuse was *worth*. Counts do not answer it: one reopened pyramid over a 6 M-frame capture and one over a 200-frame capture are the same count and different by four orders of magnitude |
| `rebuilt_bytes` | what the rejection costs, in the same unit, so the two are comparable on one line |

**Ongoing** — the health sample's cache accounting
(`pyramids=[live=… unread=…/…MB retained=…/…MB cap=…MB revived=… evicted=…]`):

| Counter | Answers |
| --- | --- |
| `live` | how many pyramids the session is carrying |
| `unread` / `unread_bytes` | **disk that has not earned its keep** — pyramids restored or built and never served from. This is the failure retention itself could cause, so it is the counter the phase most needed |
| `retained` / `retained_bytes` | the pool's occupancy |
| `cap` | its bound, so an idling pool reads differently from one thrashing against its budget — `retained ≈ cap` with a rising `evicted` is the "wasting disk" signature |
| `revived` / `evicted` | session-lifetime pool outcomes. Revivals without evictions is the pool working; evictions without revivals is it paying for nothing |

**Deliberately not counted.** Park *events* (a park is visible as a
`retained` step and as a `rebuilt` on the line that caused it); a hit
rate (two counters a reader can divide are more informative than one
ratio that hides both); per-signal read counts (the question is
"anything at all", and a count per signal is a per-serve write on the
hot path for a distinction nobody asks); anything the existing
`cache_mb=[… pyramid=…]` split already reports — the pool's footprint
is inside it, and this group says what *kind* of bytes those are.

Read marks are **per session and not persisted**: "has anything looked
at this since launch" is the question, and a persisted mark would
answer a different one (whether it was ever looked at, ever) that
nothing acts on.

#### Parking renames; it does not copy

The design problem the pool had to solve is that `key_prefix` is
deterministic in the key: a parked pyramid and a *rebuild of the same
signal* would open the same level files, and the rebuild would append
into the retained samples. So parking renames the files to
`park.{seq:08x}.{live base}` and a revival renames them back — directory
entries only, no bytes read or written, and the live name is left clean
for the rebuild that is about to happen.

`the_invalidated_subset_rebuilds_in_one_walk_of_its_message` is what
pins it: it parks `B`, rebuilds it, and asserts the rebuilt level 0 is
`n` long at the *new* encoding's values. Appending into the parked run
would make it `2n`.

The sequence number keeps two parks of one signal apart — a definition
that changed twice leaves two candidates and either may be the one that
returns — and a restore resumes numbering above the highest base the
prior session left, so a park can never land on one.

#### Revival against the hard gates

`capture_id` and `low_water` are checked **before anything is parked or
revived**, and a mismatch in either discards the pool whole (its files
are simply absent from the keep list, so the restore's wipe takes them).
The reasoning is that those two are facts about the *frames*: no
returning definition can make a pyramid of another capture, or of the
same capture trimmed to another mark, valid again — so retaining one
would be retaining something that can only ever be thrown away. A row
whose decode cursor sits past the restored tip (crash truncation) is
discarded for the same reason rather than parked.

Only a **fingerprint** mismatch parks. That is exactly the "the
definition disappeared or was edited away" case the scope names, and it
is the only rejection a later session can undo.

Within the pool, a revival is the same proof a reopen is — the parked
row's recorded fingerprint against the set now loaded — plus one guard:
a key that is already live is never displaced, since the live cache is
the current decode and two pyramids cannot share one key or one set of
files.

#### The in-session half, and what fell out of it

`invalidate_dbcs` now takes the new loaded set and judges each live
DBC-backed cache against it, which is the same judgement `restore`
makes. Three outcomes: chain unchanged → **stays live**; chain moved →
parked; no fingerprint → discarded.

The first is a behaviour change beyond "park instead of delete", and it
is emergent rather than added: parking everything and immediately
reviving whatever matched would produce the same set of live caches, by
a disk round-trip. Keeping them live is strictly better than that —
it preserves samples appended since the last manifest write, which a
round-trip through the persisted row would drop and re-decode. So a
DBC-set change no longer discards pyramids it cannot have changed,
which is the touched-DBC waste of phase 1 and 2, one session earlier.

The third is the cost of stamping at persist time. A cache's
fingerprint is recorded when the manifest is written (and carried in
when a row is reopened), because that is when a loaded set and the
cache are in hand together; by the time `invalidate_dbcs` runs the set
it was decoded against is gone. A cache created since the last write
therefore has no stamp, cannot prove what it was decoded with, and is
discarded — the safe direction, and exactly what every cache got before
this phase. The flush cadence is 2 s by default, so the window is
small, and it costs a rebuild rather than a wrong answer.

Considered and rejected: stamping at catch-up instead. The serve path
carries `&[&Database]` without bus scoping, and `dbc_encoding` needs
the scoping, so it would mean widening the hot serve path's signature
to carry `DbcScope` — a data-path change for a 2-second window.

#### Exit criteria this phase owns

| Criterion | Where |
| --- | --- |
| unreferenced caches retained up to the byte bound | `an_unreferenced_pyramid_is_parked_and_revived_when_its_definition_returns`, `the_retention_pool_evicts_the_oldest_park_at_its_byte_bound` |
| evicted oldest-first | the same eviction test — the pool is bounded at exactly one park's bytes, a second park is made, and the *first* signal is the one whose files go |
| revived on a fingerprint match | the park/revive test across two sessions (proved over a store whose frames decode to nothing, so anything served came off disk) and `a_dbc_change_parks_what_it_re_encoded_and_leaves_the_rest_live` in-session |
| the bound visible in the health sample | `health_message_says_what_the_pyramid_cache_is_earning` (`cap=16384MB`) |
| the restore line carries reopened/rebuilt with bytes | `a_restore_reports_the_bytes_it_reused_and_the_bytes_it_owes` for the figures; the line itself in `capture.rs` |
| pool revivals/evictions/retained bytes in the accounting | the health-line test, over a `CacheUsage` with all of them |
| never-read visibility | `the_usage_report_names_the_pyramids_nothing_has_read` — two restored, one served, one still unread with its bytes |
| task-wide: mtime-touch invalidates nothing | `a_touched_but_unchanged_dbc_reopens_every_pyramid`, unchanged and still green |
| task-wide: one signal's change rebuilds one | `an_encoding_change_rebuilds_that_signal_and_reopens_the_rest`, unchanged but for the parked-not-deleted assertion |

#### The tests were checked by falsification

| Sabotage | Failed |
| --- | --- |
| `park` always wipes instead of renaming | the park/revive, eviction, hard-gate, in-session, staged-set and encoding-change tests (6) |
| evict newest instead of oldest | the eviction test alone |
| the pool survives a `capture_id` / `low_water` change | the hard-gate test alone |
| a serve never sets its read mark | the never-read test alone |

### 2026-08-15 — cycle cleanup: the rebuild test no longer times the machine

Branch `cycle-cleanup-flaky-shadow`, off `task78-p2-gate-hooks`. Ordered
at the consolidated review from task 78's blocker: phase 2's
`the_invalidated_subset_rebuilds_in_one_walk_of_its_message` failed on a
busy machine and passed when run alone.

**Root cause, by experiment.** The test built its store with
`SignalCacheStore::new`, i.e. the shipping 150 ms wall-clock serve
budget, over a capture of `CATCH_UP_CHUNK_FRAMES + 500` frames — two
chunks. It then counted the walk's chunk fetches. Forcing the worst
machine (`new_chunk_at_a_time`, a zero-length budget) reproduced the
recorded failure exactly — `left: 1, right: 2` — which promotes "the
deadline stops the serve mid-walk" from hypothesis to cause: what the
count measured was how much decoding fits in 150 ms.

**Fix.** The store is now `new_unbounded`, the existing test-only
deterministic form for exactly this shape — its rustdoc already reads
"for tests that assert on a *finished* series over a capture spanning
several chunks", and the identically-shaped
`one_group_fetches_each_chunk_once_for_all_its_signals` (same
`div_ceil` fetch-count assertion) has always used it. `Duration::MAX`
overflows `Instant::checked_add`, so the limit is `Deadline(None)` and
`spend` can never end the serve early. The assertion is unchanged and
now exact rather than machine-dependent: one walk of the message for
the whole invalidated subset, not one per invalidated signal.

Production behaviour is untouched — `ServeLimit`, `serve_limit()` and
`CATCH_UP_SERVE_BUDGET` are all as they were; only which test-only
constructor this test picks changed.

**The siblings were checked, and none needed the same fix.** A serve's
budget is charged only *between* rounds, so a capture inside one chunk
cannot stop early whatever the budget. That leaves the tests that both
run on the production deadline and span more than one chunk:

| Test | Verdict |
| --- | --- |
| `a_many_group_batch_converges_on_a_capture_growing_faster_than_a_chunk` | already deterministic — passes `ServeLimit::Frames` explicitly, store budget never consulted |
| `a_straggler_takes_the_budget_the_caught_up_groups_no_longer_need` | already deterministic — explicit `Deadline(None)` then `Frames` |
| `a_batch_answers_in_request_order_including_repeats` | multi-chunk on the production budget, but asserts only answer order and repeat-identity — both read the same post-serve state, so how far the serve got cannot move them |

Everything else on `SignalCacheStore::new` runs a 150- or 200-frame
capture; the rest already use `new_unbounded` or `new_chunk_at_a_time`.

Tests: `cannet-gui` **699**, unchanged (no test added or removed — the
deliverable is the existing one becoming deterministic); frontend
unchanged at **2230** in 165 files. `cargo clippy -p cannet-gui
--all-targets` clean, `cargo fmt --check` clean, `pnpm build` clean.

## Blockers / side effects

- **The pyramid decode path does not honour DBC bus scoping** (found
  during the audit, pre-existing). `sampling.rs:252` hands *every* loaded
  database to the signal cache whatever `LoadedDbc::buses` says, and
  `scan_chunk` filters only the frames, by the series' own bus. Every
  other decode surface does filter the databases —
  `dbc_commands.rs:218`, `app_state.rs:440`, `transmit_commands.rs:79`,
  `verification.rs:137`, all through `filter::dbc_applies`. So a series
  scoped to bus A can today be decoded by a DBC scoped only to bus B.
  Fixing it changes decoded values, which phase 1 must not do, so it is
  recorded rather than done. The fingerprint is written to be correct
  either way: each contributing database's scoping joins its
  contribution, so a re-scope invalidates conservatively now and stays
  correct if the path is fixed.
- **`SignalCacheStore::persist` gained a parameter** — the loaded set, in
  load order, as `&[DbcScope]`. One production call site
  (`emitters::persist_pyramids`), which now takes the DBC lock before the
  signal-cache lock; that is the order `sample_signals` already
  establishes, so no new edge in the lock order.
- **The existing `signal_cache` persist fixtures pass an empty DBC set**,
  so their rows now carry the empty-chain fingerprint. Harmless while
  nothing judges it; **phase 2 must give those fixtures a real set** or
  their restores will start failing for the right reason.
- `f64` fields are fingerprinted bit-wise, so a `0.0` → `-0.0` edit moves
  a fingerprint although it changes no decoded value. Conservative in the
  safe direction; documented on the module.
- README not touched: no shipped behaviour, dependency, prerequisite or
  run command changed, and its source-tree map does not enumerate host
  internals at this granularity (`signal_cache.rs` itself is absent from
  it). ADR 0047 is deliberately left alone — it is amended in phase 2,
  with the behaviour change.

### Phase 2

- **`SignalCacheStore::restore` gained a parameter and changed its return
  type** — `(&PyramidValidity, &[DbcScope], store_len) -> RestoreOutcome`.
  One production call site (`capture::restore_scratch_capture`), which now
  takes the DBC lock before the signal-cache lock, the order
  `persist_pyramids` and `sample_signals` already establish. The two of
  them share `app_state::dbc_scopes` for the borrow.
- **`app_state::dbc_fingerprint` is deleted**, with `PyramidValidity`'s
  `dbcs` field and the `the_dbc_fingerprint_moves_with_everything_that_
  changes_a_decode` test that pinned it. Nothing else read it. Phase 1's
  `a_touched_but_unchanged_dbc_moves_no_signals_fingerprint` lost its
  contrast half (it compared the two stamps); it keeps the mtime fixture
  and now asserts the touch really happened, and the contrast is made at
  the restore level instead, where it is a behaviour rather than a hash.
- **Old manifests**: a `pyramids.json` written before this phase carries a
  `validity.dbcs` key that no longer deserialises into anything — serde
  ignores it — and rows whose `encoding` is absent, judged as above. A
  manifest written *after* it cannot be read by an older build (its
  `PyramidValidity` requires `dbcs`); the scratch is per-project cache
  state a downgrade already rebuilds, so this is not gated.
- **The system-log rebuild notice now counts** ("N persisted signal
  cache(s) did not match this capture"), because with a partial rebuild
  the old wording claimed more than happened. The frontend chip reads
  `pyramids_rebuilding`, unchanged.
- **The ignored first-use benchmark now persists and restores against the
  real DBC set** rather than an empty one, so its restore arm pays the
  per-row fingerprint recompute a launch pays. Its paced-flusher thread
  parses its own copy of the same DBC text (it outlives the borrow).
- The bus-scoping divergence recorded above is **untouched**, as the phase
  required. The judgement is correct under either resolution: scoping
  joins each contributing database's fingerprint either way.
- Concurrently with this phase, another session left an uncommitted edit
  in `plans/tasks/0072-extrapolation-rendering.md` (a post-closeout owner
  ruling on lane-label styling). It is not part of this work and was left
  in the working tree, uncommitted.

### Phase 3

- **`SignalCacheStore::invalidate_dbcs` gained a parameter** — the new
  loaded set as `&[DbcScope]`. One production call site
  (`app_state::invalidate_derived_caches`), which now takes the DBC lock
  before the signal-cache lock; that is the order `persist_pyramids`,
  `restore` and `sample_signals` already establish, so no new edge in the
  lock order.
- **A DBC-set change no longer drops every DBC-backed pyramid.** One
  whose candidate chain has not moved keeps decoding. This is an
  in-session behaviour change beyond "park instead of delete" — see the
  status log for why it falls out of park-then-revive rather than being
  added to it — and it means the *footprint* after a DBC change is now
  higher than before in two ways: live pyramids that used to be dropped,
  and parked ones that used to be deleted. Both are visible in the health
  sample; only the second is bounded.
- **A live cache created since the last manifest write is still
  discarded** by a DBC change, because nothing has ever held it and a
  loaded set at the same moment, so what it was decoded with is
  unprovable. The flush cadence is 2 s, so the window is small, and it
  costs a rebuild rather than a wrong answer.
- **`apply_scratch_cap` is now `apply_cache_caps`** and pushes both
  on-disk bounds (the scratch cap onto the trace store, the retention
  budget onto the signal cache). Three call sites, all internal.
- **`format_health_message` gained a `CacheUsage` parameter**, and the
  whole `cache_mb=…`/`pyramids=…` group is gated on the scratch being
  disk-backed as before. The line is longer by one bracketed group per
  disk-backed sample; `log_rotation_bytes` bounds the file regardless.
- **Old manifests** read unchanged: `retained` is `#[serde(default)]`, so
  a `pyramids.json` written before this phase restores as a set with
  nothing parked. A manifest written *after* it is readable by a phase-2
  build, which ignores `retained` — and would then leave the parked level
  files on disk with nothing referencing them until the next wipe. The
  scratch is per-project cache state a downgrade already rebuilds, so
  this is not gated.
- **The pool can hold two entries for one signal** when its definition
  changed twice (each park records the fingerprint it was parked with,
  and either may be the one that returns). Only the matching one is
  revived; the other ages out through the bound. Deliberate — deduping
  by key would throw away a candidate that is still reachable — and it
  is why parked names carry a serial.
- **No per-signal "stop plotting" drop path exists**, so the scope's
  "or that the model no longer references" clause has exactly one seam
  in the code today: the fingerprint judgement (a definition edited away
  or gone leaves the empty chain, which never matches). A pyramid whose
  signal is merely removed from every plot stays live and is not parked —
  there is nothing in the model that says it was unreferenced.
- The bus-scoping divergence recorded above is **untouched**, as the
  phase required.

## Exit-criteria walk (2026-08-15, orchestrator, at the cycle tip `f21aa13f`)

1. **A DBC touch that changes no encoding invalidates nothing — MET.**
   The fingerprint is over the parsed model only (phase 1's audit puts
   path/size/mtime deliberately out); phase 2's restore-judgement
   tests pin that an identical decode reopens every pyramid.
2. **An encoding change to one signal rebuilds exactly that signal —
   MET.** Phase 1: per-signal fingerprint movement pinned input by
   input; phase 2: the judged-out row rebuilds alone in one batched
   scan while its neighbours reopen untouched (fetch-count and
   mixed-cursor tests).
3. **File-backed pyramids survive DBC-set changes — MET.** Phase 1
   fingerprints them against source identity; phase 2's provenance
   rule reopens them regardless of the DBC set, tested.
4. **Decode-input audit recorded; every input a fingerprint-moves
   test — MET.** Phase 1's status-log table, one named test per row
   (13 verified), including the negatives (mtime, load-order
   no-winner-change, labels-not-baked confirmed by experiment).
5. **Retention pool: bounded, evict-oldest, revival on match; bound
   visible — MET.** Phase 3: `pyramid_retention_bytes` (default
   16 GB) beside the cache knobs; hard gates checked before any park
   or revive; sabotage checks (park-wipes / evict-newest /
   pool-survives-hard-gate) all caught by the intended tests.
6. **Usage metrics answer "saving time or wasting disk" from a log —
   MET.** Restore line: reopened/revived/rebuilt with reused vs
   re-decoded bytes; health sample: live/unread(+bytes)/
   retained(+bytes)/cap/revivals/evictions; never-read visibility via
   per-session read marks.
7. **ADR 0047 amended — MET.** Phase 2 (two-level validity, candidate
   chain) and phase 3 (retention pool) in the same commits as the
   behavior.
8. **ADR-0031 gate on the final build — MET.** Cycle-final gate at
   `f21aa13f` (contains all task-76 code): 69/69, three settled runs,
   median drift form, seeded geometry, no baseline promoted.

Verdict: **all eight criteria MET** — none waived. For the
consolidated review: the pyramid-decode bus-scoping divergence
(pre-existing, surfaced by phase 1, fix changes decoded values) and
the health sampler's `usage()` lock (stated under task 78's product
budget) are owner decisions.
