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
