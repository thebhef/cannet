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
