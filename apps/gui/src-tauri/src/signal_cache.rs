//! Per-signal cache of decoded sample points, extended incrementally
//! as the trace store grows so `sample_signals` doesn't re-decode the
//! same matching frames on every call.
//!
//! Each decoded signal gets its own [`SignalCache`]: a **resolution
//! pyramid** of its decoded samples plus the next trace-store frame
//! index to scan from. The pyramid is a property of the signal, not of
//! any one consumer — a plot fitting all data is the consumer today,
//! but the multi-resolution view is the signal's. Level 0 is the raw
//! decoded series in capture order; each higher level holds, per bucket
//! of [`PYRAMID_BRANCH`] points of the level below, that bucket's min-
//! and max-value points — so the pyramid is geometrically smaller going
//! up and per-bucket extrema mean spikes survive (ADR 0002 DS-5). A
//! call to [`SignalCacheStore::slice`] catches the cache up to the
//! store's tip (decoding any new matching frames against the loaded
//! DBCs), then serves a `[from_seconds, to_seconds)` range at a point
//! budget by reading the coarsest pyramid level that still has more than
//! `max_points` points in the range. So a whole-span serve over a
//! 10^8-frame capture reads `O(max_points)` points instead of
//! materializing and decimating the whole raw series on every request.
//!
//! Coupled with the existing per-id index in [`TraceStore::by_id`],
//! catch-up is `O(Σ new matches)`: at high rate the per-tick work
//! is bounded by how much capture arrived since the last call, not by
//! the total capture length — which is the whole point. The pyramid is
//! built incrementally on the same catch-up (each new sample is folded
//! into each higher level at most once), so first-plot build is
//! `O(that id's occurrences)` and steady-state serve is `O(max_points)`.
//! Every pyramid level is an mmap'd [`SampleSeq`] under the disk-spill
//! scratch (ADR 0002 DS-5/DS-7), so the resident set is only the segment
//! handles plus whatever windows the serve path has recently touched — the
//! kernel pages cold history out under pressure. A pyramid **outlives the
//! session that built it**: [`SignalCacheStore::persist`] records what is
//! on disk and the [`PyramidValidity`] it may be reused against, and
//! [`SignalCacheStore::restore`] adopts it on the next launch over the same
//! capture instead of re-decoding the whole history (ADR 0047).
//! [`SignalCacheStore::clear`] (on `clear_trace_store`, and every other
//! start of a new capture) still drops the caches and wipes their files;
//! the next serve then rebuilds the pyramid on disk by re-decoding the raw
//! frames, which remain the source of truth.
//!
//! **Decode provenance decides the fill, and only the fill.** A
//! *DBC-backed* series is decoded from the frames of its `(message, bus)`,
//! incrementally, for as long as frames keep arriving. A *file-backed*
//! series (CONTEXT: "File-backed signal") was imported from a capture file
//! as an already-decoded value series: no message carries it, no DBC
//! produces it, and [`SignalCacheStore::fill_file_backed`] fills it once,
//! completely, at import. Everything downstream is the same store, the
//! same pyramid, the same paged serve and the same persistence — the
//! differences all follow from the fill: a file-backed series is never
//! caught up, is complete the moment it exists, survives a DBC-set change
//! ([`SignalCacheStore::invalidate_dbcs`]) and the raw store's ring
//! eviction ([`SignalCacheStore::evict_below`]), and comes back from disk
//! on any relaunch over the same capture whatever the DBC set has become
//! ([`SignalCacheStore::restore`]).
//!
//! A batch of queries ([`SignalCacheStore::slice_many`],
//! [`SignalCacheStore::min_max_many`] — what a plot fetch sends) is
//! caught up **one decode pass per message**: the queries sharing a
//! `(message_id, extended)` fetch that message's frames once between
//! them and decode each frame once, then take their own signal's value
//! out of the result. Bus scoping, decode provenance and the decode
//! cursor stay per series through it ([`catch_up_group_chunked`]).
//!
//! A serve is also **bounded in time** (ADR 0049): it catches up for at most
//! [`CATCH_UP_SERVE_BUDGET`] and then answers with what has decoded,
//! saying so through [`ServedWindows::complete`]. So the first use of a
//! signal over a long capture returns a growing prefix every time it is
//! asked instead of one finished series minutes later, and the caller
//! that wants the whole series asks again until the model says it is
//! caught up.
//!
//! Concurrency and residency: one global mutex around the (small)
//! `HashMap`, but **never held across a rebuild** (ADR 0048). The
//! catch-up scans the unread frame range in [`CATCH_UP_CHUNK_FRAMES`]
//! chunks, and each chunk is planned under the lock, fetched and decoded
//! off it, then appended under it again — so the longest uninterrupted
//! hold is one chunk's appends, not the minutes a cold rebuild takes.
//! Another area's serve, the flusher's eviction, the manifest write and
//! the exit path slot in between chunks, and two cold areas decode in
//! parallel. It holds the trace-store lock only for a chunk's clone (the
//! pump isn't starved by a long catch-up) and the frames it has
//! materialized at any moment are bounded by the chunk, not by the
//! capture length. That matters most on the first use of a signal over a
//! *restored* capture (ADR 0002 DS-7), where the unread range is the
//! whole history.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cannet_dbc::Database;
use cannet_spill::{lower_bound, SampleSeq};
use serde::{Deserialize, Serialize};

use crate::signal_sampler::{self, SamplePoint};
use crate::trace_store::{read_json, write_json, RawTraceFrame, TraceStore};

/// Min/max bucket branching factor: each pyramid level merges this many
/// consecutive points of the level below into one bucket, emitting that
/// bucket's min- and max-value points (so spikes survive). 8 keeps 2
/// points per 8, a ~4× point reduction per level, so a handful of levels
/// span 10^7+ samples and a wide-window serve reads a small coarse level.
const PYRAMID_BRANCH: usize = 8;

/// How many store frames one catch-up scan chunk covers. The catch-up asks
/// the trace store for the matching frames of one chunk at a time, so the
/// frames it materializes at once are bounded by this — not by the capture
/// length. It bounds two things that both matter on a first-use rebuild
/// over restored history: the allocation spike (a materialized frame costs
/// ~116 B resident, so a chunk is a couple of MB no matter how long the
/// capture is) and the trace-store lock hold (the fetch takes the lock, the
/// decode below runs off it — at the measured ~0.3 µs per materialized
/// frame a chunk holds the lock for single-digit milliseconds, so a rebuild
/// never starves the RX append path). Chunking costs one extra `by-id`
/// range lookup per chunk, which is `O(log occurrences)` — negligible
/// beside the per-frame decode.
const CATCH_UP_CHUNK_FRAMES: usize = 16_384;

/// How long one serve may spend catching its caches up before it answers
/// with what has decoded so far, [`ServedWindows::complete`] `== false`
/// (ADR 0049).
///
/// Chunking the catch-up (ADR 0048) bounded the *lock hold*; it did not
/// bound the *call*, which still ran chunk after chunk until the cursor
/// reached the tip — minutes on a first use over a long capture, with the
/// caller holding a blank plot the whole time. A serve now stops at this
/// deadline and reports that it stopped, so the caller can draw the
/// prefix and come back for the rest.
///
/// A **time** budget rather than a chunk count, because a chunk's cost
/// varies by more than an order of magnitude with how much of the capture
/// is the plotted message: a chunk of a rare message decodes almost
/// nothing, and a fixed chunk budget would make such a rebuild take
/// hundreds of round-trips to advance through a capture it could scan in
/// seconds. The deadline is checked *between* chunks, so a serve overruns
/// it by at most one chunk and always makes progress — a serve that
/// decoded nothing would never finish the rebuild.
///
/// 150 ms is about a plot's resample period: short enough that the first
/// points appear promptly and the picture visibly grows, long enough that
/// the per-serve overhead (one lock round-trip and one window read per
/// signal) stays negligible against the decoding.
const CATCH_UP_SERVE_BUDGET: Duration = Duration::from_millis(150);

/// What a **file-backed** series is, beyond its samples: which signal
/// channel group of the imported capture file it was read from and the
/// metadata that group carried. Held beside the pyramid and persisted
/// with it, so a restored session can list and label the signal without
/// re-opening the source file.
///
/// DBC-backed series have no counterpart here — everything a view needs
/// to label one is in the loaded DBCs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileSignalInfo {
    /// Path of the capture file the series was read from — the branch a
    /// catalog surface files it under (ADR 0052). Not part of the
    /// series' identity (the group index and name are), so re-importing
    /// the same file to a different path replaces the series rather
    /// than adding one. `#[serde(default)]` so a manifest written
    /// before the path was recorded still restores, as series with no
    /// named source.
    #[serde(default)]
    pub source_path: String,
    /// Signal-channel-group index in the source file. Plays the part a
    /// message id plays for a DBC-backed signal: it is what keeps two
    /// groups' same-named signals apart.
    pub group: u32,
    /// The group's acquisition name, when it has one.
    pub group_name: Option<String>,
    /// Channel name, verbatim from the file.
    pub name: String,
    /// Engineering unit, verbatim from the file (empty when it has none).
    pub unit: String,
}

impl FileSignalInfo {
    /// The label a view shows where a DBC-backed signal shows its
    /// message name: the group's own name, or its index when the file
    /// left it unnamed.
    #[must_use]
    pub fn group_label(&self) -> String {
        self.group_name
            .clone()
            .unwrap_or_else(|| format!("group {}", self.group))
    }
}

/// One file-backed series as a view lists it: what it is, how many
/// samples it holds, its newest sample, and the average sample rate over
/// its span. Every number is read off the pyramid here rather than
/// re-derived by a caller — statistics are the model's job.
pub struct FileSignalEntry {
    pub info: FileSignalInfo,
    pub sample_count: u64,
    /// Time and value of the newest sample, `None` for an empty series.
    pub latest: Option<SamplePoint>,
    /// Samples per second over the series' own span, `None` when fewer
    /// than two samples (or a zero-length span) make it undefined.
    pub rate: Option<f64>,
}

/// One signal's decoded samples as a min/max resolution pyramid, plus
/// the next trace-store frame index to scan from on the next catch-up.
struct SignalCache {
    /// Scratch directory the level [`SampleSeq`]s are rooted in, and the
    /// per-signal file-name base under it — held so [`Self::fold`] can mint
    /// a new level's sequence when the one below first overflows a bucket.
    dir: PathBuf,
    base: String,
    /// Resolution pyramid. `levels[0]` is the raw decoded series in
    /// capture (frame-index) order; `levels[n]` (n ≥ 1) holds, for each
    /// bucket of [`PYRAMID_BRANCH`] consecutive `levels[n-1]` points,
    /// that bucket's min- and max-value points in time order. Every
    /// level is non-decreasing in `t_seconds`, so the serve path
    /// binary-searches each by `t_seconds`. Each level is an mmap'd
    /// [`SampleSeq`], so the pyramid's residency is bounded (the module
    /// docs); only the small per-level segment directories stay in RAM.
    levels: Vec<SampleSeq>,
    /// `folded[n]` = how many of `levels[n]`'s points have already been
    /// folded into complete buckets in `levels[n+1]`. Lets catch-up
    /// extend the pyramid incrementally: only the buckets that just
    /// became complete are folded, so per-call work is `O(new matches)`.
    folded: Vec<usize>,
    /// Next trace-store frame index to start the next catch-up scan
    /// from. Advances to `TraceStore::len()` after each catch-up.
    next_index: usize,
    /// Running all-time value extent over every decoded sample —
    /// widen-only, maintained as samples are pushed. This is the
    /// host-owned y-extent the plot's auto-normalisation reads (ADR
    /// 0025: a scalar model fact, not a windowed accessor), so the
    /// frontend no longer latches it in a React ref. `lo > hi` (the
    /// empty sentinel) means nothing has decoded yet.
    lo: f64,
    hi: f64,
    /// Set for a **file-backed** series: what it was read from. `None`
    /// is a DBC-backed series, whose samples come from decoding frames.
    /// This is the decode provenance the ruling turns on — it decides
    /// whether catch-up fills the series at all, whether a DBC-set
    /// change discards it, and how views label it.
    file: Option<FileSignalInfo>,
}

impl SignalCache {
    /// A fresh cache whose level-0 sequence is rooted at `dir` with file
    /// base `base` (`{base}.l0`, `{base}.l1`, … minted per level by
    /// [`Self::fold`]). `file` carries the source metadata of a
    /// file-backed series; `None` makes it DBC-backed.
    fn new(dir: &Path, base: &str, file: Option<FileSignalInfo>) -> Self {
        Self {
            dir: dir.to_path_buf(),
            base: base.to_string(),
            levels: vec![SampleSeq::new(dir, format!("{base}.l0"))],
            folded: vec![0],
            next_index: 0,
            lo: f64::INFINITY,
            hi: f64::NEG_INFINITY,
            file,
        }
    }

    /// How many samples the raw (level-0) series holds — its live slots,
    /// so a front-trimmed series counts what it still has.
    fn sample_count(&self) -> usize {
        self.levels[0].live_len()
    }

    /// The newest level-0 sample, or `None` for an empty series.
    fn latest(&self) -> Option<SamplePoint> {
        let level = &self.levels[0];
        (level.live_len() > 0).then(|| {
            let (t_seconds, value) = level.get(level.len() - 1);
            SamplePoint { t_seconds, value }
        })
    }

    /// Average samples per second across the series' own span, or `None`
    /// when fewer than two live samples (or a zero-length span) leave it
    /// undefined.
    #[allow(clippy::cast_precision_loss)]
    fn rate(&self) -> Option<f64> {
        let level = &self.levels[0];
        let n = level.live_len();
        if n < 2 {
            return None;
        }
        let first = level.get(level.first_slot()).0;
        let last = level.get(level.len() - 1).0;
        let span = last - first;
        (span > 0.0).then(|| (n - 1) as f64 / span)
    }

    /// All-time value extent, or `None` if nothing has decoded yet.
    fn extent(&self) -> Option<(f64, f64)> {
        (self.lo <= self.hi).then_some((self.lo, self.hi))
    }

    /// Append one decoded sample, widening the all-time `[lo, hi]`
    /// extent with it.
    fn push_sample(&mut self, t_seconds: f64, value: f64) {
        if value < self.lo {
            self.lo = value;
        }
        if value > self.hi {
            self.hi = value;
        }
        self.levels[0].push(t_seconds, value);
    }

    /// Propagate newly-appended `levels[0]` points up the pyramid: for
    /// each level, fold every bucket of [`PYRAMID_BRANCH`] points that
    /// became complete since the last call into the level above, emitting
    /// that bucket's min- and max-value points in time order. Amortized
    /// `O(new points)` — a point is folded into each higher level at most
    /// once — and it creates the next level only when the one below has a
    /// full bucket to give it, so the pyramid is exactly as tall as the
    /// data warrants (the top level always holds `< PYRAMID_BRANCH` points).
    fn fold(&mut self) {
        let mut src = 0;
        loop {
            let start = self.folded[src];
            let complete = (self.levels[src].len() - start) / PYRAMID_BRANCH;
            if complete == 0 {
                break;
            }
            if self.levels.len() == src + 1 {
                let n = self.levels.len();
                self.levels
                    .push(SampleSeq::new(&self.dir, format!("{}.l{n}", self.base)));
                self.folded.push(0);
            }
            for b in 0..complete {
                let s = start + b * PYRAMID_BRANCH;
                // Copy the bucket out of `levels[src]` first (releasing its
                // immutable borrow) so the `levels[src + 1]` push below can
                // mutably borrow `levels`.
                let mut bucket = [(0.0f64, 0.0f64); PYRAMID_BRANCH];
                for (j, slot) in bucket.iter_mut().enumerate() {
                    *slot = self.levels[src].get(s + j);
                }
                let mut lo = 0;
                let mut hi = 0;
                for (i, &(_, v)) in bucket.iter().enumerate() {
                    if v < bucket[lo].1 {
                        lo = i;
                    }
                    if v > bucket[hi].1 {
                        hi = i;
                    }
                }
                // Emit in time (index) order; collapse to one when the
                // bucket's min and max are the same point (flat bucket).
                let (a, c) = (lo.min(hi), lo.max(hi));
                let (tmin, vmin) = bucket[a];
                self.levels[src + 1].push(tmin, vmin);
                if a != c {
                    let (tmax, vmax) = bucket[c];
                    self.levels[src + 1].push(tmax, vmax);
                }
            }
            self.folded[src] = start + complete * PYRAMID_BRANCH;
            src += 1;
        }
    }

    /// Every live level-0 sample, in time order — the series entire,
    /// with no window and no decimation. Used where the consumer is a
    /// file rather than a viewport.
    fn all_samples(&self) -> Vec<SamplePoint> {
        let level = &self.levels[0];
        (level.first_slot()..level.len())
            .map(|k| {
                let (t_seconds, value) = level.get(k);
                SamplePoint { t_seconds, value }
            })
            .collect()
    }

    /// Serve a `[from, to)` window decimated to about `max_points` points.
    /// Reads the coarsest pyramid level whose in-window point count still
    /// exceeds `max_points` (so the next coarser level would drop below
    /// it), slices that level to the window with two boundary points on
    /// each side, and clamps to `max_points` via min/max decimation. The
    /// chosen level holds at most `~PYRAMID_BRANCH × max_points` points in
    /// the window, so this is `O(max_points)` regardless of capture
    /// length. `max_points == 0` disables decimation and returns the raw
    /// level-0 window slice.
    ///
    /// The slice comes through [`Self::level_points`], so a read off a
    /// coarse level still reaches the series' newest sample rather than
    /// stopping at the last bucket that has folded upward — the tail a
    /// level is always missing is worth seconds once the capture is long
    /// enough to push the read several folds up, and a live plot that
    /// ends seconds short of the live edge is the symptom. The splice
    /// costs fewer than [`PYRAMID_BRANCH`] points per level below the one
    /// read, and [`signal_sampler::decimate_min_max`] keeps its last
    /// bucket's final sample, so the live edge survives the decimation.
    fn window(&self, from: f64, to: f64, max_points: usize) -> Vec<SamplePoint> {
        if self.levels[0].live_len() == 0 {
            return Vec::new();
        }
        // Coarsest level still holding > max_points points in the window.
        // Counts shrink monotonically as levels coarsen, so walk up while
        // the count stays above the budget.
        let mut chosen = 0;
        if max_points > 0 {
            for (n, level) in self.levels.iter().enumerate() {
                if window_count(level, from, to) > max_points {
                    chosen = n;
                } else {
                    break;
                }
            }
        }
        let slice = self.level_points(chosen, from, to);
        if max_points == 0 {
            slice
        } else {
            signal_sampler::decimate_min_max(&slice, max_points)
        }
    }

    /// Serve a `[from, to)` window as a **categorical** series: the run
    /// boundaries in the window, not a per-bucket envelope.
    ///
    /// Same level-choosing shape as [`Self::window`] and the same
    /// `O(max_points)` read, but the level is chosen from the *fine* end
    /// and the reduction is [`signal_sampler::reduce_transitions`]:
    ///
    /// - **Read the finest level whose in-window count fits the read
    ///   budget** ([`PYRAMID_BRANCH`] × `max_points`, the same order the
    ///   numeric serve reads). A window that fits at level 0 is answered
    ///   from the raw samples, so every code and every transition time is
    ///   exact — which is the case a live plot is in until the window
    ///   holds more than a few `max_points` of samples.
    /// - **Above that, resolution degrades but codes do not vanish.** A
    ///   level-`k` point summarises `n / count_k` raw samples, and the
    ///   chosen level holds more than `max_points` points wherever a
    ///   coarser one would not, so a run is resolved to better than an
    ///   eighth of a pixel column. A run shorter than that merges into
    ///   its neighbours instead of displacing them.
    /// - **When the runs themselves exceed the budget, coarsen** (ADR
    ///   0049's partial answer): step up a level and re-reduce until the
    ///   answer fits or the pyramid runs out. The alternative — truncating
    ///   the window and continuing on the next request — is not available
    ///   here: ADR 0049's continuation converges because each serve
    ///   decodes *more*, whereas an identical request over an unchanged
    ///   window returns the identical prefix forever, and the contract
    ///   forbids the caller accumulating across responses. Coarsening
    ///   keeps the answer whole and bounded; what it costs is resolution,
    ///   at a zoom where the transitions are already sub-pixel.
    /// - **The tail is always spliced at full resolution**
    ///   ([`Self::level_points`]), so a lane read off a coarse level still
    ///   reaches the capture's live edge rather than stopping at the last
    ///   bucket that has folded upward.
    ///
    /// So the answer holds at most `max_points` runs plus that splice
    /// (fewer than [`PYRAMID_BRANCH`] points from each level finer than
    /// the one read) — `O(max_points)` regardless of capture length, like
    /// the numeric serve.
    ///
    /// `max_points == 0` means "no budget": the raw level-0 window,
    /// run-reduced (still lossless — a step series *is* its transitions).
    fn window_categorical(&self, from: f64, to: f64, max_points: usize) -> Vec<SamplePoint> {
        if self.levels[0].live_len() == 0 {
            return Vec::new();
        }
        if max_points == 0 {
            return signal_sampler::reduce_transitions(&window_slice(&self.levels[0], from, to));
        }
        let read_budget = max_points.saturating_mul(PYRAMID_BRANCH);
        let mut chosen = 0;
        for (n, level) in self.levels.iter().enumerate() {
            chosen = n;
            if window_count(level, from, to) <= read_budget {
                break;
            }
        }
        loop {
            let out = signal_sampler::reduce_transitions(&self.level_points(chosen, from, to));
            if out.len() <= max_points || chosen + 1 >= self.levels.len() {
                return out;
            }
            chosen += 1;
        }
    }

    /// The `[from, to)` window read off level `level`, extended to the
    /// series' live edge from the finer levels below it.
    ///
    /// [`Self::fold`] only promotes *complete* buckets, so a level stops
    /// short of the newest samples — by up to [`PYRAMID_BRANCH`] of its
    /// own points per level below it. In wall-clock that is the level's
    /// bucket span, which grows with capture length: measured on 90
    /// minutes of a 100 Hz series it is 20 s of missing tail at the
    /// narrowest point budget the plot asks for. A lane of held states
    /// reads that as the signal having stopped; a line ends short of the
    /// live edge. Both reductions therefore read through here. Each
    /// level `j < level`
    /// contributes its own points newer than everything emitted so far —
    /// fewer than [`PYRAMID_BRANCH`] each, because anything older has
    /// already folded upward — so the splice is bounded however deep the
    /// pyramid is, and the newest samples are served at full resolution.
    fn level_points(&self, level: usize, from: f64, to: f64) -> Vec<SamplePoint> {
        let mut out = window_slice(&self.levels[level], from, to);
        for finer in (0..level).rev() {
            let seq = &self.levels[finer];
            let after = out.last().map_or(from, |p| p.t_seconds);
            let lo = partition_by_t(seq, after);
            // The same two-point widening past the right edge that
            // `window_slice` applies, so the last tile reaches off-canvas.
            let hi = std::cmp::min(seq.len(), partition_by_t(seq, to).saturating_add(2));
            for k in lo..hi {
                let (t_seconds, value) = seq.get(k);
                if t_seconds > after {
                    out.push(SamplePoint { t_seconds, value });
                }
            }
        }
        out
    }

    /// Snapshot this cache's manifest row: the key it is filed under plus
    /// the two numbers per level ([`SampleSeq::reopen`] needs `len` and
    /// `first_slot`), the fold cursors, the decode cursor, and the all-time
    /// extent. Everything else is in the level files already.
    #[allow(clippy::cast_possible_truncation)]
    fn snapshot(&self, key: &SignalKey) -> PersistedSignal {
        PersistedSignal {
            bus_id: key.bus_id.clone(),
            message_id: key.slot,
            extended: key.extended,
            signal: key.signal.clone(),
            file: self.file.clone(),
            next_index: self.next_index as u64,
            extent: self.extent().map(|(lo, hi)| [lo, hi]),
            levels: self
                .levels
                .iter()
                .zip(&self.folded)
                .map(|(level, folded)| PersistedLevel {
                    len: level.len() as u64,
                    first_slot: level.first_slot() as u64,
                    folded: *folded as u64,
                })
                .collect(),
        }
    }

    /// Wait for the device to take this signal's level pages, so a
    /// persisted manifest never describes bytes the disk has not been
    /// given (ADR 0047). `harden` decides how much: [`Harden::Sealed`]
    /// takes only what has come to rest, [`Harden::All`] takes the hot
    /// tails too. Best-effort per level, like every other scratch
    /// durability point (ADR 0002 DS-2).
    fn flush_levels(&mut self, harden: Harden, budget: &mut usize) {
        for level in &mut self.levels {
            let _ = match harden {
                Harden::Sealed { .. } => level.flush_sealed(budget),
                Harden::All => level.flush(),
            };
        }
    }

    /// Entries across every level still owed to the device — the work a
    /// flush from here would do.
    #[cfg(test)]
    fn unflushed(&self) -> usize {
        self.levels.iter().map(SampleSeq::unflushed).sum()
    }

    /// The `(prefix, len, first_slot)` runs a manifest row's levels reopen
    /// from — see [`SampleSeq::reopen_many`], which the whole restore goes
    /// through in **one** batch so its thousands of segment files are
    /// mapped with the parallel open at full width.
    fn reopen_runs(base: &str, p: &PersistedSignal) -> Option<Vec<(String, usize, usize)>> {
        if p.levels.is_empty() {
            return None;
        }
        p.levels
            .iter()
            .enumerate()
            .map(|(n, level)| {
                Some((
                    format!("{base}.l{n}"),
                    usize::try_from(level.len).ok()?,
                    usize::try_from(level.first_slot).ok()?,
                ))
            })
            .collect()
    }

    /// Rebuild a cache around levels already mapped by
    /// [`Self::reopen_runs`]'s batch.
    fn from_levels(dir: &Path, base: &str, p: &PersistedSignal, levels: Vec<SampleSeq>) -> Self {
        let (lo, hi) = p
            .extent
            .map_or((f64::INFINITY, f64::NEG_INFINITY), |[lo, hi]| (lo, hi));
        Self {
            dir: dir.to_path_buf(),
            base: base.to_string(),
            levels,
            folded: p
                .levels
                .iter()
                .map(|l| usize::try_from(l.folded).unwrap_or(0))
                .collect(),
            next_index: usize::try_from(p.next_index).unwrap_or(usize::MAX),
            lo,
            hi,
            file: p.file.clone(),
        }
    }

    /// Front-trim every level to the truncation time `ts_seconds` (ADR 0002
    /// DS-8 / 6d): drop the points (and their leading segment files) older
    /// than the live window, so the pyramid's footprint follows the raw
    /// store's. Each level is non-decreasing in `t_seconds`, so the floor is
    /// the time partition point. `folded` is bumped to the floor so the next
    /// [`Self::fold`] never reads an evicted slot — old points evict only
    /// after they have long since folded upward, so this is normally a no-op
    /// on `folded`, but it makes the rare evict-outran-fold case safe.
    fn evict_below(&mut self, ts_seconds: f64) {
        for n in 0..self.levels.len() {
            let floor = partition_by_t(&self.levels[n], ts_seconds);
            self.levels[n].evict_below(floor);
            self.folded[n] = self.folded[n].max(floor);
        }
    }
}

/// One member of a shared catch-up: the facts that stay **per series**
/// when several series of one message are caught up in a single pass —
/// the bus its query is scoped to, the signal it decodes, and its decode
/// cursor.
///
/// The cursor is a *snapshot*, read under the cache lock when a chunk is
/// planned. The scan runs off that lock (ADR 0048), so the authoritative
/// cursor is re-read — and the same gate re-applied — when the chunk's
/// samples are appended.
struct GroupTarget<'a> {
    bus_id: Option<&'a str>,
    signal_name: &'a str,
    next_index: usize,
}

/// One decoded sample waiting for the cache lock: the store frame index
/// it came from, so the append can re-apply the per-target cursor gate
/// against the cursor as it stands *then*, and the point itself.
struct ChunkSample {
    index: usize,
    t_seconds: f64,
    value: f64,
}

/// Fetch and decode one chunk `[from, to)` of a `(message_id, extended)`
/// group's frames for every target at once — **holding no cache lock**
/// (ADR 0048). One `fetch` of the chunk and one decode of each frame
/// answers all of `targets`, so a message carrying sixteen plotted
/// signals costs one scan rather than sixteen.
///
/// What stays per target, and how:
///
/// - **Decode provenance.** [`signal_sampler::sample_shared`] resolves
///   each signal name against the first loaded database that yields
///   *that name*, so two signals of one message may come from two
///   different databases exactly as they did when each was decoded on
///   its own.
/// - **Bus scoping.** The filter is the target's, not the group's: two
///   series on one message id can be scoped to different buses (or to
///   the legacy "any bus"), so the eligibility test runs per target.
/// - **Cursors.** A target already past a frame is skipped, so a series
///   joining a message that is already plotted can read the whole
///   history in the same pass that appends nothing to the incumbents.
///
/// `out` is index-parallel with `targets` and cleared here, so the
/// caller reuses one set of buffers across the whole scan.
fn scan_chunk(
    message_id: u32,
    extended: bool,
    targets: &[GroupTarget<'_>],
    chunk: std::ops::Range<usize>,
    dbs: &[&Database],
    fetch: &impl Fn(u32, bool, usize, usize) -> Vec<(usize, RawTraceFrame)>,
    out: &mut [Vec<ChunkSample>],
) {
    for samples in out.iter_mut() {
        samples.clear();
    }
    // Scratch reused across frames so the per-frame loop allocates
    // nothing: which targets want a value from the frame in hand, the
    // names to decode for them, and the values that came back.
    let mut pending: Vec<usize> = Vec::with_capacity(targets.len());
    let mut wanted: Vec<&str> = Vec::with_capacity(targets.len());
    let mut values: Vec<Option<f64>> = Vec::with_capacity(targets.len());
    for (index, frame) in fetch(message_id, extended, chunk.start, chunk.end) {
        pending.clear();
        wanted.clear();
        for (i, t) in targets.iter().enumerate() {
            // A target already past this frame must not re-append it.
            if index < t.next_index {
                continue;
            }
            // Bus filter: when the query is scoped to a bus, drop
            // frames whose `bus_id` doesn't match. `None` on the query
            // is the legacy "any bus" path that takes every frame.
            if let Some(want) = t.bus_id {
                if frame.bus_id.as_deref() != Some(want) {
                    continue;
                }
            }
            pending.push(i);
            wanted.push(t.signal_name);
        }
        if pending.is_empty() {
            continue;
        }
        signal_sampler::sample_shared(&frame, dbs, message_id, extended, &wanted, &mut values);
        #[allow(clippy::cast_precision_loss)]
        let t_seconds = (frame.timestamp_ns as f64) / 1e9;
        for (&i, value) in pending.iter().zip(&values) {
            if let Some(value) = *value {
                out[i].push(ChunkSample {
                    index,
                    t_seconds,
                    value,
                });
            }
        }
    }
}

/// Smallest live slot `k` in `[first_slot, level.len())` whose `t_seconds`
/// is `>= target` — the partition point of the (non-decreasing) `t_seconds`
/// order, by binary search over [`SampleSeq::get`]. The lower bound starts
/// at the level's low-water mark, so an evicted (front-trimmed) slot is
/// never read.
fn partition_by_t(level: &SampleSeq, target: f64) -> usize {
    lower_bound(level.first_slot(), level.len(), target, |k| level.get(k).0)
}

/// Count of `level` points whose `t_seconds` lies in `[from, to)`.
/// `level` is non-decreasing in `t_seconds`, so this is two binary
/// searches.
fn window_count(level: &SampleSeq, from: f64, to: f64) -> usize {
    partition_by_t(level, to) - partition_by_t(level, from)
}

/// Slice `level` to `[from, to)`, widened by two boundary points on each
/// side. The extra points give a line renderer a segment running off each
/// range edge, so a consumer drawing the series doesn't go blank or end a
/// bin early at the range boundary (see [`SignalCacheStore::slice`]). The
/// chosen level holds `O(max_points)` points in the window, so this
/// materializes a bounded run out of the mmap'd sequence.
fn window_slice(level: &SampleSeq, from: f64, to: f64) -> Vec<SamplePoint> {
    let lo = partition_by_t(level, from);
    let hi = partition_by_t(level, to);
    // Widen by two boundary points each side, but never below the level's
    // low-water mark — a slot under it has been front-trimmed.
    let lo_inclusive = lo.saturating_sub(2).max(level.first_slot());
    let hi_inclusive = std::cmp::min(level.len(), hi.saturating_add(2));
    (lo_inclusive..hi_inclusive)
        .map(|k| {
            let (t_seconds, value) = level.get(k);
            SamplePoint { t_seconds, value }
        })
        .collect()
}

/// Cache key — one bucket per cached series, and the place a series'
/// **decode provenance** is recorded.
///
/// A *DBC-backed* series is one bucket per `(bus, message, signal)`
/// triple, so the same arbitration id on two different buses (with
/// different DBC scopes) decodes into two independent series.
/// `bus_id = None` is the legacy "any bus" path: it matches every frame
/// regardless of its bus tag, used by old plot panels that pre-date
/// per-bus signal binding.
///
/// A *file-backed* series has no bus and no message — nothing on the
/// wire carries it and no DBC decodes it — so `slot` carries the source
/// file's signal-channel-group index instead of a message id and
/// `extended` is meaningless. Provenance is part of the key rather than
/// a field beside it because the two namespaces must not alias: a group
/// index and a message id are unrelated numbers that would otherwise
/// collide.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct SignalKey {
    bus_id: Option<String>,
    /// DBC-backed: the message id. File-backed: the source file's
    /// signal-channel-group index.
    slot: u32,
    /// DBC-backed: whether `slot` is a 29-bit extended id. Always
    /// `false` file-backed.
    extended: bool,
    signal: String,
    /// `true` for a file-backed series — filled once from an imported
    /// signal channel group, never from frames.
    file_backed: bool,
}

impl SignalKey {
    /// The key of a DBC-backed series.
    fn dbc(bus_id: Option<String>, message_id: u32, extended: bool, signal: String) -> Self {
        Self {
            bus_id,
            slot: message_id,
            extended,
            signal,
            file_backed: false,
        }
    }

    /// The key of a file-backed series in signal channel group `group`.
    fn file(group: u32, signal: String) -> Self {
        Self {
            bus_id: None,
            slot: group,
            extended: false,
            signal,
            file_backed: true,
        }
    }
}

/// Segment files one periodic [`SignalCacheStore::persist`] may wait on
/// the device for **while frames are arriving**. Sealing is bursty —
/// signals sharing a bus rate cross a segment boundary on the same tick —
/// and each wait is a device barrier that everything else on the volume
/// queues behind, so an unbounded tick lands as one long stall in the
/// middle of a live capture. Two keeps a tick inside the band the raw
/// store's own periodic flush already occupies (ADR 0031's `flush_ms`,
/// ~4 ms mean / ~10 ms max), and the sealed segments it defers cannot
/// change while they wait.
const LIVE_FLUSH_BUDGET: usize = 2;

/// The same budget once **nothing is arriving** — a stopped capture, a
/// finished import, a restored session being plotted. There is no
/// receive cadence left to disturb, so the only reason to hold back is
/// gone, and the backlog a rebuild just created is worth draining before
/// the user quits rather than making them wait for it then.
const IDLE_FLUSH_BUDGET: usize = 64;

/// How much of a pyramid a [`SignalCacheStore::persist`] waits on the
/// device for (ADR 0047).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Harden {
    /// Up to `budget` segments that have come to rest — the periodic
    /// cadence. A sealed segment's pages can never be dirtied again, so
    /// each file is waited on exactly once ever, and a live capture's hot
    /// tail is left alone instead of being re-flushed on every tick. The
    /// caller sets the budget because the caller is what knows whether
    /// there is a receive cadence to protect: [`live_budget`] /
    /// [`idle_budget`].
    Sealed { budget: usize },
    /// Every page, hot tails included — the shutdown path. Bounded by
    /// what the cadence left behind.
    All,
}

impl Harden {
    /// The periodic flavour for a tick during which frames arrived.
    pub fn live_budget() -> Self {
        Self::Sealed {
            budget: LIVE_FLUSH_BUDGET,
        }
    }

    /// The periodic flavour for a tick during which none did.
    pub fn idle_budget() -> Self {
        Self::Sealed {
            budget: IDLE_FLUSH_BUDGET,
        }
    }
}

/// A stable, filesystem-safe file-name base for a signal's pyramid levels:
/// `sig.{s|e}{id:08x}.{hash:016x}`. The id and extended flag are encoded
/// literally (debuggable); the variable-length bus/signal text is folded
/// into an FNV-1a hash so the name is bounded and contains no path-hostile
/// characters. Deterministic in the key, so the same signal always maps to
/// the same files within a session.
fn key_prefix(key: &SignalKey) -> String {
    // FNV-1a over a canonical encoding of the whole key, separators
    // included so `(Some("a"), "b")` and `(Some("ab"), "")` can't alias.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    mix(key.bus_id.as_deref().unwrap_or("").as_bytes());
    mix(&[0]);
    mix(&key.slot.to_le_bytes());
    mix(&[u8::from(key.extended), u8::from(key.file_backed)]);
    mix(key.signal.as_bytes());
    let kind = match (key.file_backed, key.extended) {
        (true, _) => 'f',
        (false, true) => 'e',
        (false, false) => 's',
    };
    let slot = key.slot;
    format!("sig.{kind}{slot:08x}.{h:016x}")
}

/// The scratch subdirectory the per-signal decimation pyramids spill into
/// (ADR 0002 DS-5/DS-7). Named here because this module owns the pyramid
/// files; the host roots the cache at `<scratch>/`[`PYRAMID_SUBDIR`] and the
/// scratch-footprint diagnostic identifies the pyramid family by it.
pub const PYRAMID_SUBDIR: &str = "signals";

/// On-disk `(bytes, files, deepest-pyramid-level-count)` of the pyramid
/// scratch under `dir` (the [`PYRAMID_SUBDIR`] tree). The depth is parsed
/// from this module's own `….l{n}.{seg}` level-file naming, so the
/// scratch-footprint diagnostic (ADR 0002 DS-8) doesn't reverse-engineer
/// it. Best-effort: an unreadable entry counts zero.
#[must_use]
pub fn pyramid_scratch_usage(dir: &Path) -> (u64, u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0, 0);
    };
    let (mut bytes, mut files, mut depth) = (0, 0, 0);
    for entry in entries.flatten() {
        let Ok(m) = entry.metadata() else { continue };
        if m.is_dir() {
            let (b, f, d) = pyramid_scratch_usage(&entry.path());
            bytes += b;
            files += f;
            depth = depth.max(d);
        } else {
            bytes += m.len();
            files += 1;
            if let Some(level) = pyramid_level(&entry.file_name().to_string_lossy()) {
                depth = depth.max(level + 1);
            }
        }
    }
    (bytes, files, depth)
}

/// The level index `n` in a pyramid segment file name `….l{n}.{seg}`
/// (`{base}.l0.0000`, `{base}.l2.0003`, …), or `None` if it doesn't match.
/// The `.l{n}` suffix is appended by this module when it grows a pyramid
/// level, so the parse lives beside the naming it inverts.
fn pyramid_level(name: &str) -> Option<u64> {
    let after = &name[name.rfind(".l")? + 2..];
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Remove every file directly under `dir` (the pyramid scratch). Called
/// after the mappings have been dropped, so Windows allows the removal.
/// Best-effort: a missing dir or an unremovable file is ignored — the
/// pyramid is derived state that rebuilds regardless.
fn wipe_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Remove one series' level files — every entry under `dir` whose name
/// starts with its [`key_prefix`]. Call only after that series' mappings
/// have been dropped. Best-effort, like [`wipe_dir`].
fn wipe_prefix(dir: &Path, base: &str) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(base) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// [`wipe_dir`], but leaving the level files of `keep` (and the manifest
/// itself) where they are. This is what lets a DBC-set change drop the
/// live *decoded* state without touching either a staged set's files —
/// pre-empting its own validity check — or the file-backed series a DBC
/// change has no bearing on. See [`SignalCacheStore::invalidate_dbcs`].
fn wipe_dir_except(dir: &Path, keep: &[SignalKey]) {
    let keep: Vec<String> = keep.iter().map(key_prefix).collect();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == MANIFEST_FILE || keep.iter().any(|k| name.starts_with(k.as_str())) {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// File in the pyramid scratch describing what is persisted there and what
/// it is only valid against ([`PyramidManifest`]).
const MANIFEST_FILE: &str = "pyramids.json";

/// What a persisted pyramid set is provably a pyramid *of*. A set left on
/// disk by a prior session is reused only when every component matches the
/// session asking for it; any difference means the samples on disk are not
/// the samples the current model would decode, so the pyramid rebuilds.
///
/// The three components are the three ways a pyramid can stop describing
/// the model without the pyramid itself changing:
///
/// - **`capture_id`** — capture identity. Minted whenever a capture starts
///   (`TraceStore::write_scratch_identity`, beside the project identity
///   that already gates the raw reload, ADR 0002 DS-7) and recorded in the
///   scratch, so it survives a relaunch of the *same* capture and differs
///   for any other. Frame indices, and therefore the pyramid's decode
///   cursor, are only meaningful within one capture.
/// - **`dbcs`** — the loaded DBC set, fingerprinted over each database's
///   path, bus scoping, and file identity. A pyramid holds *decoded*
///   samples; a different DBC set decodes different values, or decodes a
///   signal the old set couldn't (ADR 0033).
/// - **`low_water`** — the raw store's windowed-ring eviction mark (ADR
///   0002 DS-8). The pyramid is front-trimmed to follow it, so a pyramid
///   trimmed to one mark does not describe a capture retained to another.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct PyramidValidity {
    /// Identity of the capture the pyramids were decoded from.
    pub capture_id: String,
    /// Fingerprint of the DBC set they were decoded against.
    pub dbcs: String,
    /// Raw-store windowed-ring low-water mark they were trimmed to.
    pub low_water: u64,
}

/// One persisted pyramid level: the two numbers [`SampleSeq::reopen`]
/// needs, plus this level's fold cursor into the level above.
#[derive(Serialize, Deserialize)]
struct PersistedLevel {
    len: u64,
    first_slot: u64,
    folded: u64,
}

/// One persisted signal: its cache key, its decode cursor and all-time
/// extent, and its levels. The samples themselves stay in the mmap'd level
/// files — this only says how to find and interpret them.
#[derive(Serialize, Deserialize)]
struct PersistedSignal {
    bus_id: Option<String>,
    /// The message id of a DBC-backed series; the source file's signal
    /// channel group index when `file` is set.
    message_id: u32,
    extended: bool,
    signal: String,
    /// Present only for a file-backed series. `#[serde(default)]` so a
    /// manifest written before file-backed signals existed still reads,
    /// as the DBC-backed set it describes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file: Option<FileSignalInfo>,
    next_index: u64,
    extent: Option<[f64; 2]>,
    levels: Vec<PersistedLevel>,
}

impl PersistedSignal {
    fn key(&self) -> SignalKey {
        match &self.file {
            Some(f) => SignalKey::file(f.group, self.signal.clone()),
            None => SignalKey::dbc(
                self.bus_id.clone(),
                self.message_id,
                self.extended,
                self.signal.clone(),
            ),
        }
    }
}

/// Map every level of every signal in `manifest` back, in **one** batched
/// parallel open ([`SampleSeq::reopen_many`]). Mapping a segment file is
/// latency-bound, and a restore is thousands of them across dozens of
/// pyramids — opening them a level at a time runs the parallel open at a
/// width of about four and turns the restore into the slow half of a
/// launch. `None` if any run doesn't answer to its manifest row.
fn reopen_set(root: &Path, signals: &[PersistedSignal]) -> Option<Vec<(SignalKey, SignalCache)>> {
    if signals.is_empty() {
        return Some(Vec::new());
    }
    let keys: Vec<(SignalKey, String)> = signals
        .iter()
        .map(|s| {
            let key = s.key();
            let base = key_prefix(&key);
            (key, base)
        })
        .collect();
    let mut runs = Vec::new();
    let mut per_signal = Vec::with_capacity(signals.len());
    for (s, (_, base)) in signals.iter().zip(&keys) {
        let levels = SignalCache::reopen_runs(base, s)?;
        per_signal.push(levels.len());
        runs.extend(levels);
    }
    let mut mapped = SampleSeq::reopen_many(root, &runs)
        .ok()
        .flatten()?
        .into_iter();
    Some(
        signals
            .iter()
            .zip(keys)
            .zip(per_signal)
            .map(|((s, (key, base)), n)| {
                let levels = mapped.by_ref().take(n).collect();
                (key, SignalCache::from_levels(root, &base, s, levels))
            })
            .collect(),
    )
}

/// [`MANIFEST_FILE`]'s contents: the validity key the whole set is reusable
/// against, and one row per cached signal. Small (bounded by the number of
/// plotted signals × pyramid depth), rewritten whole whenever the pyramids
/// have moved.
#[derive(Serialize, Deserialize)]
struct PyramidManifest {
    validity: PyramidValidity,
    signals: Vec<PersistedSignal>,
}

/// One signal a batch of queries names: the cache key's four fields,
/// borrowed. A plot panel asks about many at once, and the ones sharing
/// a `(message_id, extended)` are caught up in a single decode pass.
pub struct CacheQuery<'a> {
    /// Bus the series is scoped to; `None` is the legacy "any bus" path.
    /// Always `None` for a file-backed signal, which has no bus.
    pub bus_id: Option<&'a str>,
    /// The message id, or — when `file_backed` — the source file's
    /// signal channel group index.
    pub message_id: u32,
    pub extended: bool,
    pub signal_name: &'a str,
    /// Names a **file-backed** signal rather than a DBC-backed one.
    /// A file-backed query only ever serves an entry the import already
    /// filled: nothing decodes such a signal, so there is no series to
    /// create on demand.
    pub file_backed: bool,
}

/// How a serve summarises a window that holds more samples than the
/// caller's point budget.
///
/// This is the **requesting view's render mode**, not a property of the
/// series: the same signal is a line on one axis and a lane of held
/// states on another, and only the view knows which it is drawing. The
/// host stays mode-agnostic — it does not infer "categorical" from the
/// presence of a DBC value table, which would make the reduction depend
/// on which databases happen to be loaded and would still be wrong for
/// the labelled-but-plotted-as-a-line case.
///
/// It is a property of the *request*, not of each signal in it, because a
/// fetch batches exactly one axis and an axis has exactly one render
/// mode.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Reduction {
    /// Numeric: each bucket's min- and max-value point, so a spike
    /// survives ([`signal_sampler::decimate_min_max`]).
    #[default]
    MinMax,
    /// Categorical: the window's run boundaries, so every held code and
    /// its transition survive ([`signal_sampler::reduce_transitions`]).
    /// A min/max envelope over a code series keeps the two extreme codes
    /// of each bucket and discards the rest — the held state disappears
    /// rather than being drawn late.
    Runs,
}

impl CacheQuery<'_> {
    fn key(&self) -> SignalKey {
        if self.file_backed {
            SignalKey::file(self.message_id, self.signal_name.to_string())
        } else {
            SignalKey::dbc(
                self.bus_id.map(str::to_owned),
                self.message_id,
                self.extended,
                self.signal_name.to_string(),
            )
        }
    }
}

/// Create a cache for every DBC-backed query that doesn't have one yet,
/// and return the queries' keys in request order (duplicates included —
/// the result of a batch is index-parallel with it).
///
/// A **file-backed** query creates nothing: its series is filled once by
/// the import that read it ([`SignalCacheStore::fill_file_backed`]) and
/// there is no decode that could fill an empty one, so minting a cache
/// here would only leave an empty series in the store — and in the
/// manifest — for a signal this capture does not have.
fn ensure_caches(caches: &mut Caches, queries: &[CacheQuery<'_>]) -> Vec<SignalKey> {
    let Caches { root, by_key, .. } = caches;
    queries
        .iter()
        .map(|q| {
            let key = q.key();
            if !key.file_backed {
                by_key
                    .entry(key.clone())
                    .or_insert_with(|| SignalCache::new(root, &key_prefix(&key), None));
            }
            key
        })
        .collect()
}

/// The batch's DBC-backed keys grouped by `(message_id, extended)` — the
/// unit one decode pass covers — with repeats collapsed, since a query
/// asked twice is one series and must be caught up once. File-backed keys
/// are left out: they have no message to scan and their series is already
/// complete.
fn group_keys(keys: &[SignalKey]) -> HashMap<(u32, bool), Vec<&SignalKey>> {
    let mut seen: std::collections::HashSet<&SignalKey> = std::collections::HashSet::new();
    let mut groups: HashMap<(u32, bool), Vec<&SignalKey>> = HashMap::new();
    for key in keys {
        if !key.file_backed && seen.insert(key) {
            groups
                .entry((key.slot, key.extended))
                .or_default()
                .push(key);
        }
    }
    groups
}

/// Read one chunk of a `(message_id, extended)` group's frames out of the
/// trace store — the production form of [`scan_chunk`]'s `fetch` seam.
fn store_fetch(
    store: &TraceStore,
) -> impl Fn(u32, bool, usize, usize) -> Vec<(usize, RawTraceFrame)> + '_ {
    |message_id, extended, from, to| store.matching_frames_indexed(message_id, extended, from, to)
}

/// Process-wide collection of per-signal caches. The pyramid levels spill
/// to mmap'd files under `root` (a `signals/` subdir of the disk-spill
/// scratch), so the resident set stays bounded (ADR 0002 DS-5/DS-7).
pub struct SignalCacheStore {
    caches: Mutex<Caches>,
    /// How long one serve may catch up before it answers with a partial
    /// series ([`CATCH_UP_SERVE_BUDGET`]). A field rather than a constant
    /// read at the call site so a test can serve deterministically —
    /// either one chunk at a time or the whole capture in one call —
    /// instead of racing a wall clock.
    serve_budget: Duration,
}

/// The store's interior: where the pyramids spill, the live caches rooted
/// there, and the set a prior session left behind. One lock over all of
/// them, so re-rooting the store ([`SignalCacheStore::reroot`]) cannot
/// interleave with a cache being created under the root it is replacing.
struct Caches {
    root: PathBuf,
    by_key: HashMap<SignalKey, SignalCache>,
    /// Bumped whenever the whole set is replaced — [`SignalCacheStore::clear`],
    /// [`SignalCacheStore::invalidate_dbcs`], [`SignalCacheStore::reroot`],
    /// [`SignalCacheStore::restore`]. A catch-up decodes off this lock
    /// (ADR 0048), so it reads the generation when it plans a chunk and
    /// drops the chunk's samples if it no longer matches: they describe
    /// caches that no longer exist, and appending them to whatever took
    /// their key would mix two captures' samples into one pyramid.
    generation: u64,
    /// The pyramid set found under `root` at open, neither adopted nor
    /// rejected yet — the boot sequence loads the project's DBCs before it
    /// restores the capture, and the set can only be judged once both are
    /// known ([`SignalCacheStore::restore`]).
    staged: Option<PyramidManifest>,
    /// Whether the live caches have moved since the manifest was last
    /// written. Keeps the flush cadence from rewriting an unchanged
    /// manifest every tick for the life of a stopped session.
    dirty: bool,
    /// Set by [`SignalCacheStore::restore`] when a persisted set was
    /// **discarded** over a capture that came back: the samples it held
    /// have to be decoded again from frame zero, which is minutes on a
    /// large session and was previously silent. [`SignalCacheStore::
    /// rebuilding`] turns it into the fact the frontend announces, and
    /// clears it once the caches have caught up.
    rebuild_pending: bool,
}

/// Prepare `root` as a pyramid scratch: create it, and stage whatever a
/// prior session left there. Level files with no manifest to vouch for them
/// are wiped — nothing can establish what they decode, and a fresh cache
/// must not append into them.
fn open_root(root: PathBuf) -> Caches {
    let _ = std::fs::create_dir_all(&root);
    let staged = read_json::<PyramidManifest>(&root.join(MANIFEST_FILE));
    if staged.is_none() {
        wipe_dir(&root);
    }
    Caches {
        root,
        by_key: HashMap::new(),
        generation: 0,
        staged,
        dirty: false,
        rebuild_pending: false,
    }
}

impl SignalCacheStore {
    /// Root the per-signal pyramids at `root`, staging any set a prior
    /// session persisted there for [`Self::restore`] to judge.
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self::rooted(root, CATCH_UP_SERVE_BUDGET)
    }

    fn rooted(root: impl AsRef<Path>, serve_budget: Duration) -> Self {
        Self {
            caches: Mutex::new(open_root(root.as_ref().to_path_buf())),
            serve_budget,
        }
    }

    /// A store whose serves catch up **exactly one chunk per message
    /// group** before answering, so a test can observe a partial serve
    /// and its convergence without depending on how fast the machine
    /// decodes.
    #[cfg(test)]
    fn new_chunk_at_a_time(root: impl AsRef<Path>) -> Self {
        Self::rooted(root, Duration::ZERO)
    }

    /// A store that catches up to the tip however long it takes, i.e. the
    /// pre-budget behaviour. For tests that assert on a *finished* series
    /// over a capture spanning several chunks; the bounded serve is what
    /// production does and is pinned on its own.
    #[cfg(test)]
    fn new_unbounded(root: impl AsRef<Path>) -> Self {
        Self::rooted(root, Duration::MAX)
    }

    /// Drop every cached series and wipe its files — call when the capture
    /// they decode is discarded (`clear_trace_store`, and every other start
    /// of a new capture): the frame indices and samples no longer
    /// correspond to anything, and neither does anything a prior session
    /// staged. Dropping the map unmaps the segments first, so the files can
    /// then be removed (Windows forbids removing a mapped file).
    pub fn clear(&self) {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        caches.by_key = HashMap::new();
        caches.generation += 1;
        caches.staged = None;
        caches.dirty = false;
        // Nothing is left to rebuild, so a cold rebuild announced by a
        // restore stops being announced — this is the offramp's own
        // exit as much as the exit path's.
        caches.rebuild_pending = false;
        wipe_dir(&caches.root);
    }

    /// Drop the live decoded state after a DBC-set change (ADR 0033): the
    /// samples in it were decoded against a set that no longer applies.
    ///
    /// **File-backed series survive.** Their samples were read from a
    /// capture file, not decoded from frames — no DBC produced them and
    /// no DBC change can invalidate them — so they and their level files
    /// stay exactly where they are.
    ///
    /// A *staged* set is likewise left where it is. It is not decoded
    /// state yet — it is a candidate whose own recorded DBC fingerprint is
    /// part of the check [`Self::restore`] is about to make — and the boot
    /// sequence loads a project's DBCs before it restores that project's
    /// capture, so wiping here would mean no persisted pyramid could ever
    /// be reused. Once a set has been adopted it is live like any other,
    /// and the next DBC change wipes its DBC-backed half.
    pub fn invalidate_dbcs(&self) {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        caches.by_key.retain(|key, _| key.file_backed);
        caches.generation += 1;
        // The surviving file-backed series still owe the manifest a
        // rewrite: the rows it holds for the discarded DBC-backed ones
        // no longer describe anything on disk.
        caches.dirty = !caches.by_key.is_empty();
        let Caches {
            root,
            staged,
            by_key,
            ..
        } = &*caches;
        let mut keep: Vec<SignalKey> = by_key.keys().cloned().collect();
        if let Some(manifest) = staged {
            keep.extend(manifest.signals.iter().map(PersistedSignal::key));
        }
        if keep.is_empty() {
            // Nothing to preserve — take the manifest with the files, so
            // the directory doesn't describe pyramids that are gone.
            wipe_dir(root);
        } else {
            wipe_dir_except(root, &keep);
        }
    }

    /// Move the pyramids to `root` — the cache directory of a project
    /// directory the session has switched to (ADR 0042).
    ///
    /// Every cached series is dropped first: its levels are mmap'd files
    /// under the *old* root, and on Windows a mapped file cannot even be
    /// removed. Nothing is carried across, because the destination's own
    /// pyramids are what belong there — the new root is prepared exactly as
    /// [`Self::new`] prepares one, staging whatever the project it belongs
    /// to persisted.
    pub fn reroot(&self, root: impl AsRef<Path>) {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        // Unmap before the new root is prepared — the levels are mapped
        // files, and a re-root onto the directory already open would
        // otherwise ask the OS to remove files this process still maps.
        caches.by_key = HashMap::new();
        caches.staged = None;
        // The generation is the store's, not the root's: it only has to
        // keep rising, so a catch-up planned before the move can tell that
        // its samples belong to a set that is gone.
        let generation = caches.generation + 1;
        *caches = open_root(root.as_ref().to_path_buf());
        caches.generation = generation;
    }

    /// Write the manifest describing the live pyramids and the
    /// [`PyramidValidity`] they may be reused against, so the next launch
    /// over the same capture serves them instead of re-decoding the whole
    /// history. A no-op when nothing has moved since the last write.
    ///
    /// The level pages are flushed **first**, so the manifest never
    /// describes bytes the disk has not been given (ADR 0047). How much
    /// is waited on is `harden`'s: the periodic caller takes the sealed
    /// segments, which is what leaves the shutdown caller a residue of
    /// one tail segment per level instead of a whole pyramid.
    ///
    /// Also a no-op while a set is still **staged**: an unjudged candidate
    /// is never overwritten, because the manifest is the only thing that
    /// says what its files are. [`Self::restore`] resolves the staging
    /// within a moment of launch, and every path that abandons the staging
    /// ([`Self::clear`], [`Self::reroot`]) drops the files with it.
    ///
    /// Whether [`Self::persist`] would write anything — the cheap check the
    /// periodic caller makes before assembling a [`PyramidValidity`], which
    /// costs a directory read and one `stat` per loaded DBC.
    pub fn needs_persist(&self) -> bool {
        let caches = self.caches.lock().expect("signal cache mutex poisoned");
        caches.dirty && caches.staged.is_none()
    }

    /// Level entries across every cached signal still owed to the device.
    #[cfg(test)]
    fn unflushed(&self) -> usize {
        let caches = self.caches.lock().expect("signal cache mutex poisoned");
        caches.by_key.values().map(SignalCache::unflushed).sum()
    }

    /// Returns whether a manifest was written.
    pub fn persist(&self, validity: &PyramidValidity, harden: Harden) -> bool {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        if !caches.dirty || caches.staged.is_some() {
            return false;
        }
        // The cadence spends a bounded number of device waits per call,
        // whoever needs them; a signal whose backlog it clears stops
        // asking, so the next call reaches the ones behind it and the
        // whole set drains without any of them being starved. The
        // shutdown flavour has no budget — it must leave nothing.
        let mut budget = match harden {
            Harden::Sealed { budget } => budget,
            Harden::All => usize::MAX,
        };
        for cache in caches.by_key.values_mut() {
            cache.flush_levels(harden, &mut budget);
        }
        let manifest = PyramidManifest {
            validity: validity.clone(),
            signals: caches
                .by_key
                .iter()
                .map(|(key, cache)| cache.snapshot(key))
                .collect(),
        };
        match write_json(&caches.root.join(MANIFEST_FILE), &manifest) {
            Ok(()) => {
                caches.dirty = false;
                true
            }
            Err(e) => {
                tracing::warn!(error = %e, "writing the signal-pyramid manifest failed");
                false
            }
        }
    }

    /// Adopt the staged pyramid set if it provably describes the capture
    /// that has just been restored, and discard it otherwise. Returns how
    /// many signals came back.
    ///
    /// Beyond the [`PyramidValidity`] match, one bound is checked here
    /// rather than keyed: no cache may have read *past* `store_len`. The
    /// pyramids are persisted on their own cadence, so a crash between the
    /// raw store's last flush and the pyramid's can leave a decode cursor
    /// ahead of the frames the store comes back with — and a cursor ahead
    /// of the tip never revisits the frames it skipped.
    ///
    /// Rejection is all-or-nothing **within a provenance**: a level file
    /// that doesn't answer to its manifest row means the directory is not
    /// what the manifest says, and trusting the rest of it on that
    /// evidence would be guessing.
    ///
    /// The two provenances are judged separately, because they are valid
    /// against different things. A DBC-backed row is only reusable when
    /// the whole [`PyramidValidity`] matches — it holds *decoded* samples,
    /// so a different DBC set or a different eviction mark makes it a
    /// pyramid of something else. A file-backed row holds samples read
    /// out of the capture file itself: nothing but the capture's own
    /// identity bears on it, so it comes back whenever `capture_id`
    /// matches, and a DBC change between sessions leaves it untouched
    /// exactly as a DBC change within one does.
    pub fn restore(&self, validity: &PyramidValidity, store_len: usize) -> usize {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let Some(manifest) = caches.staged.take() else {
            return 0;
        };
        let (file_rows, dbc_rows): (Vec<PersistedSignal>, Vec<PersistedSignal>) =
            manifest.signals.into_iter().partition(|s| s.file.is_some());
        // The pyramids are persisted on their own cadence, so a crash
        // between the raw store's last flush and the pyramid's can leave a
        // decode cursor ahead of the frames the store comes back with —
        // and a cursor ahead of the tip never revisits the frames it
        // skipped. File-backed rows have no cursor into the store.
        let dbc_usable = manifest.validity == *validity
            && dbc_rows.iter().all(|s| s.next_index <= store_len as u64);
        let file_usable = manifest.validity.capture_id == validity.capture_id;
        let restored_dbc = dbc_usable
            .then(|| reopen_set(&caches.root, &dbc_rows))
            .flatten();
        let restored_file = file_usable
            .then(|| reopen_set(&caches.root, &file_rows))
            .flatten();
        // A DBC-backed set that was offered and not taken is the cold
        // rebuild this session is about to pay for, one plotted signal
        // at a time. Recorded here because this is the only place that
        // knows a set *existed* — the wipe below leaves no trace of it.
        // Frames have to have come back for there to be anything to
        // decode: over an empty store there is no rebuild.
        caches.rebuild_pending = !dbc_rows.is_empty() && restored_dbc.is_none() && store_len > 0;
        caches.generation += 1;
        let offered = dbc_rows.len() + file_rows.len();
        let mut by_key: HashMap<SignalKey, SignalCache> = HashMap::new();
        by_key.extend(restored_dbc.into_iter().flatten());
        by_key.extend(restored_file.into_iter().flatten());
        let n = by_key.len();
        let keep: Vec<SignalKey> = by_key.keys().cloned().collect();
        caches.by_key = by_key;
        if keep.is_empty() {
            caches.dirty = false;
            wipe_dir(&caches.root);
        } else if n < offered {
            // A rejected half leaves its files behind and makes the
            // manifest describe pyramids that are no longer live, so it
            // owes a rewrite. A clean restore owes nothing.
            caches.dirty = true;
            wipe_dir_except(&caches.root, &keep);
        }
        n
    }

    /// Whether the restored capture is still owed a **cold rebuild** of
    /// its signal pyramids — the fact the frontend announces while it
    /// runs, and the reason it offers to drop the capture instead.
    ///
    /// True from the moment [`Self::restore`] discards a persisted set
    /// until the DBC-backed caches that replace it have decoded up to
    /// `store_len`. Before any plot has served there are no DBC-backed
    /// caches at all, which is still "owed": the samples are gone and
    /// the first serve over any of them re-decodes the capture.
    ///
    /// The answer is latched off, not recomputed: once the caches have
    /// caught up the session is no longer rebuilding anything, and a
    /// later cold signal is ordinary first-use cost (ADR 0049), not the
    /// loss this announces. A restore that reused its set, or had none
    /// to reuse, never sets the latch in the first place.
    pub fn rebuilding(&self, store_len: usize) -> bool {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        if !caches.rebuild_pending {
            return false;
        }
        let mut any = false;
        let mut behind = false;
        for (key, cache) in &caches.by_key {
            if key.file_backed {
                continue;
            }
            any = true;
            behind |= cache.next_index < store_len;
        }
        if any && !behind {
            caches.rebuild_pending = false;
        }
        caches.rebuild_pending
    }

    /// Front-trim every cached pyramid to the truncation time `ts_seconds`
    /// (ADR 0002 DS-8 / 6d) so the signal cache's footprint follows the raw
    /// store's windowed-ring eviction. The host calls this with the timestamp
    /// of the raw low-water mark whenever eviction advances it; signals with
    /// no points that old are unaffected.
    ///
    /// File-backed series are left alone. The mark is a fact about the
    /// *raw store's* ring, and a file-backed series is not decoded from
    /// it: front-trimming one would drop imported samples nothing can
    /// re-derive, since the frames that rebuild a DBC-backed pyramid
    /// never carried it.
    pub fn evict_below(&self, ts_seconds: f64) {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let mut touched = false;
        for (key, cache) in &mut caches.by_key {
            if key.file_backed {
                continue;
            }
            cache.evict_below(ts_seconds);
            touched = true;
        }
        caches.dirty |= touched;
    }

    /// Fill a **file-backed** series in one pass: an entry keyed by its
    /// source channel group and channel name, holding `points` as its
    /// level-0 series with the pyramid folded over it.
    ///
    /// This is the file-backed half of the provenance rule. A DBC-backed
    /// series fills lazily and incrementally, because the frames behind
    /// it keep arriving; a file-backed one is read out of a capture file
    /// that has already ended, so it fills once and is then complete
    /// forever. Everything downstream is identical — the same store, the
    /// same pyramid, the same paged serve, the same persistence.
    ///
    /// `points` are `(absolute nanoseconds, physical value)` in
    /// non-decreasing time order (ADR 0024 — a series' timestamps are
    /// absolute), which is the order the reader yields them in and the
    /// order every pyramid level is searched by. Re-filling a group and
    /// name that already has a series replaces it, so a re-import is not
    /// an append.
    pub fn fill_file_backed(&self, info: &FileSignalInfo, points: &[(u64, f64)]) {
        let key = SignalKey::file(info.group, info.name.clone());
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let base = key_prefix(&key);
        // Drop any incumbent *first*, so its level files are unmapped
        // before the replacement opens files of the same names — Windows
        // refuses to touch a file this process still maps. Its old levels
        // go with it: a re-fill is a replacement, and a shallower pyramid
        // must not inherit the tail of a taller one.
        if caches.by_key.remove(&key).is_some() {
            wipe_prefix(&caches.root, &base);
        }
        let mut cache = SignalCache::new(&caches.root, &base, Some(info.clone()));
        #[allow(clippy::cast_precision_loss)]
        for &(ts_ns, value) in points {
            cache.push_sample((ts_ns as f64) / 1e9, value);
        }
        cache.fold();
        caches.by_key.insert(key, cache);
        caches.generation += 1;
        caches.dirty = true;
    }

    /// Every file-backed series this capture holds, with the statistics a
    /// series-shaped view lists it by. The catalog, the signal grid and
    /// the BLF-save warning all read this — file-backed signals are model
    /// state, so what exists and how much of it there is are answered
    /// here rather than re-derived per surface.
    ///
    /// Ordered by `(group, name)` so the listing is stable across calls
    /// (the store itself is a hash map).
    pub fn file_signals(&self) -> Vec<FileSignalEntry> {
        let caches = self.caches.lock().expect("signal cache mutex poisoned");
        let mut out: Vec<FileSignalEntry> = caches
            .by_key
            .values()
            .filter_map(|cache| {
                let info = cache.file.clone()?;
                Some(FileSignalEntry {
                    info,
                    sample_count: cache.sample_count() as u64,
                    latest: cache.latest(),
                    rate: cache.rate(),
                })
            })
            .collect();
        out.sort_by(|a, b| (a.info.group, &a.info.name).cmp(&(b.info.group, &b.info.name)));
        out
    }

    /// Every file-backed series **with its samples** — what a save that
    /// can carry them (MDF) writes out.
    ///
    /// Whole series, undecimated: a saved file is not a viewport, so the
    /// decimating [`Self::slice`] serve path is the wrong one here. These
    /// series are the short ones by construction (a signal channel group
    /// is read once and is then complete), so materializing them costs
    /// what the import that filled them already cost.
    ///
    /// Same `(group, name)` order as [`Self::file_signals`].
    pub fn file_signal_series(&self) -> Vec<(FileSignalInfo, Vec<SamplePoint>)> {
        let caches = self.caches.lock().expect("signal cache mutex poisoned");
        let mut out: Vec<(FileSignalInfo, Vec<SamplePoint>)> = caches
            .by_key
            .values()
            .filter_map(|cache| Some((cache.file.clone()?, cache.all_samples())))
            .collect();
        out.sort_by(|a, b| (a.0.group, &a.0.name).cmp(&(b.0.group, &b.0.name)));
        out
    }

    /// Create a cache for every query that doesn't have one yet, and
    /// return the queries' keys in request order (duplicates included —
    /// the result of a batch is index-parallel with it). One short hold
    /// of the lock, taken and released before any decoding starts.
    fn ensure_caches(&self, queries: &[CacheQuery<'_>]) -> Vec<SignalKey> {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        ensure_caches(&mut caches, queries)
    }

    /// Catch every cache named by `keys` up to `store_len`, one decode
    /// pass per `(message_id, extended)` group. `store_len` is the tip
    /// read once for the whole batch, so every series in it observes the
    /// same capture length; `fetch` is the seam each group's chunks are
    /// materialized through.
    ///
    /// `deadline` bounds the whole batch ([`CATCH_UP_SERVE_BUDGET`]) —
    /// but every group still scans at least one chunk, so a signal listed
    /// after an expensive one is never starved of progress by a budget an
    /// earlier group has already spent.
    fn catch_up_keys(
        &self,
        keys: &[SignalKey],
        store_len: usize,
        dbs: &[&Database],
        fetch: &impl Fn(u32, bool, usize, usize) -> Vec<(usize, RawTraceFrame)>,
        deadline: Option<Instant>,
    ) {
        for ((message_id, extended), group) in group_keys(keys) {
            self.catch_up_group(
                message_id, extended, &group, store_len, dbs, fetch, deadline,
            );
        }
    }

    /// The deadline a serve's catch-up stops at, or `None` when the
    /// configured budget is longer than the clock can express (the
    /// unbounded catch-up the tests that assert on a finished series use).
    fn serve_deadline(&self) -> Option<Instant> {
        Instant::now().checked_add(self.serve_budget)
    }

    /// Catch one `(message_id, extended)` group up to `store_len`,
    /// **taking the cache lock only to plan a chunk and to apply it**
    /// (ADR 0048). Each turn of the loop:
    ///
    /// 1. *plan* — under the lock, read every target's decode cursor and
    ///    the generation they belong to;
    /// 2. *scan* — off the lock, fetch the chunk's frames and decode them
    ///    once for the whole group ([`scan_chunk`]);
    /// 3. *apply* — under the lock, append what decoded, advance the
    ///    cursors and fold the pyramids.
    ///
    /// So the longest uninterrupted hold is one chunk's appends rather
    /// than a whole rebuild: another area's serve, the flusher's
    /// [`Self::evict_below`], the manifest write and the exit path all
    /// slot in between chunks instead of waiting for the rebuild to end.
    /// Two cold areas now decode in parallel, because the decode — the
    /// expensive part — holds nothing.
    ///
    /// The cursor read in step 1 is only a hint by step 3, so the append
    /// re-applies the gate against the live cursor: a sample whose frame
    /// index another pass has already covered is dropped rather than
    /// appended twice. A generation change between the two means the
    /// caches were replaced (cleared, re-rooted, restored) and the whole
    /// pass is abandoned — its samples describe a set that is gone.
    ///
    /// The loop also stops at `deadline` — after a whole chunk has been
    /// applied, so the cursors always advance and the caller always gets
    /// more than it had. What it left undone is visible to the caller as
    /// a decode cursor short of `store_len`.
    #[allow(clippy::too_many_arguments)]
    fn catch_up_group(
        &self,
        message_id: u32,
        extended: bool,
        keys: &[&SignalKey],
        store_len: usize,
        dbs: &[&Database],
        fetch: &impl Fn(u32, bool, usize, usize) -> Vec<(usize, RawTraceFrame)>,
        deadline: Option<Instant>,
    ) {
        let (generation, mut targets) = {
            let caches = self.caches.lock().expect("signal cache mutex poisoned");
            let mut targets = Vec::with_capacity(keys.len());
            for key in keys {
                let Some(cache) = caches.by_key.get(*key) else {
                    return;
                };
                targets.push(GroupTarget {
                    bus_id: key.bus_id.as_deref(),
                    signal_name: key.signal.as_str(),
                    next_index: cache.next_index,
                });
            }
            (caches.generation, targets)
        };
        // The scan starts at the group's *minimum* cursor, so a series
        // joining a message that is already plotted reads the whole
        // history in the same pass.
        let Some(start) = targets.iter().map(|t| t.next_index).min() else {
            return;
        };
        let mut cursor = start;
        let mut samples: Vec<Vec<ChunkSample>> = (0..keys.len()).map(|_| Vec::new()).collect();
        while cursor < store_len {
            let to = cursor.saturating_add(CATCH_UP_CHUNK_FRAMES).min(store_len);
            scan_chunk(
                message_id,
                extended,
                &targets,
                cursor..to,
                dbs,
                fetch,
                &mut samples,
            );
            let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
            if caches.generation != generation {
                return;
            }
            for (i, key) in keys.iter().enumerate() {
                let Some(cache) = caches.by_key.get_mut(*key) else {
                    continue;
                };
                for s in &samples[i] {
                    if s.index < cache.next_index {
                        continue;
                    }
                    cache.push_sample(s.t_seconds, s.value);
                }
                // Never *lower* a cursor that started ahead of the group's.
                cache.next_index = cache.next_index.max(to);
                cache.fold();
                targets[i].next_index = cache.next_index;
            }
            caches.dirty = true;
            drop(caches);
            cursor = to;
            if deadline.is_some_and(|d| Instant::now() >= d) {
                return;
            }
        }
    }

    /// Catch the signal's cache up to the trace store's current tip,
    /// then return the samples whose `t_seconds` lies in
    /// `[from_seconds, to_seconds)`, decimated to about `max_points`
    /// points by reading the coarsest pyramid level that still has more
    /// than `max_points` points in the window (ADR 0002 DS-5).
    /// `max_points == 0` disables decimation and returns the raw
    /// level-0 window slice. Empty if no DBC decodes the signal or no
    /// matching frames have been seen yet.
    ///
    /// Slicing by time rather than by trace-store frame index matters
    /// when the caller derives a range from "visible x-axis seconds"
    /// via an average-rate (`fps`) estimate: under non-uniform per-id
    /// rates the index drift is tens of seconds, and the user sees the
    /// returned samples starting well inside the requested left edge
    /// (the "fencepost" effect on zoomed-in panels). The cache stores
    /// `t_seconds` per sample anyway, so partitioning by it directly
    /// removes the conversion entirely.
    ///
    /// The catch-up is `O(new matches since last call)` — fast in
    /// steady state; only the first call on a fresh cache pays for the
    /// backlog. The decimated serve is `O(max_points)`, independent of
    /// capture length. Loaded-DBC iteration mirrors the rest of the
    /// host's "first DBC that decodes wins" semantics. `bus_id` scopes
    /// the catch-up to frames tagged with that bus; pass `None` for the
    /// legacy "any bus" path.
    #[allow(clippy::too_many_arguments)]
    pub fn slice(
        &self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
        from_seconds: f64,
        to_seconds: f64,
        max_points: usize,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Vec<SamplePoint> {
        let query = CacheQuery {
            bus_id,
            message_id,
            extended,
            signal_name,
            file_backed: false,
        };
        self.slice_many(
            std::slice::from_ref(&query),
            from_seconds,
            to_seconds,
            max_points,
            Reduction::MinMax,
            store,
            dbs,
        )
        .series
        .pop()
        .unwrap_or_default()
    }

    /// [`Self::slice`] over a whole batch of signals, one window each,
    /// returned index-parallel with `queries`.
    ///
    /// This is the form a plot fetch uses, and the reason it exists is
    /// the catch-up rather than the serve: the queries sharing a
    /// `(message_id, extended)` are caught up in **one** pass over that
    /// message's frames, decoding each frame once for all of them
    /// ([`catch_up_group_chunked`]). Sampling sixteen signals of one
    /// message one at a time re-fetched and re-decoded the same frames
    /// sixteen times, throwing away fifteen values each pass.
    ///
    /// The catch-up is bounded by [`CATCH_UP_SERVE_BUDGET`], so this
    /// returns in about that long however cold the caches are, and says
    /// through [`ServedWindows::complete`] whether the windows are the
    /// whole answer or a prefix of it.
    ///
    /// `reduction` is the caller's render mode — the one input to the
    /// serve that is a fact about the *view* rather than about the series
    /// (see [`Reduction`]). A window served as [`Reduction::Runs`] keeps
    /// every code and every transition it can resolve; served as
    /// [`Reduction::MinMax`] it keeps each bucket's extremes, which for a
    /// code series would discard exactly the held states the view draws.
    #[allow(clippy::too_many_arguments)]
    pub fn slice_many(
        &self,
        queries: &[CacheQuery<'_>],
        from_seconds: f64,
        to_seconds: f64,
        max_points: usize,
        reduction: Reduction,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> ServedWindows {
        let keys = self.ensure_caches(queries);
        // One tip for the whole batch, and the same one completeness is
        // judged against — so "complete" means "caught up to the capture
        // this serve read", not to a tip that moved under it.
        let store_len = store.len();
        self.catch_up_keys(
            &keys,
            store_len,
            dbs,
            &store_fetch(store),
            self.serve_deadline(),
        );
        let caches = self.caches.lock().expect("signal cache mutex poisoned");
        ServedWindows {
            series: keys
                .iter()
                .map(|key| {
                    caches
                        .by_key
                        .get(key)
                        .map_or_else(Vec::new, |cache| match reduction {
                            Reduction::MinMax => cache.window(from_seconds, to_seconds, max_points),
                            Reduction::Runs => {
                                cache.window_categorical(from_seconds, to_seconds, max_points)
                            }
                        })
                })
                .collect(),
            complete: caught_up(&caches, &keys, store_len),
        }
    }

    /// The signal's all-time value extent `(lo, hi)` over every decoded
    /// sample, catching the cache up to the store's tip first. `None`
    /// when no matching frame has decoded yet. This is the host-owned
    /// y-extent the plot's auto-normalisation reads — a scalar model
    /// fact (ADR 0025), so the frontend reads it instead of latching a
    /// widen-only range in a React ref. `bus_id` scoping matches
    /// [`Self::slice`].
    pub fn min_max(
        &self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Option<(f64, f64)> {
        let query = CacheQuery {
            bus_id,
            message_id,
            extended,
            signal_name,
            file_backed: false,
        };
        self.min_max_many(std::slice::from_ref(&query), store, dbs)
            .pop()
            .flatten()
    }

    /// [`Self::min_max`] over a whole batch, index-parallel with
    /// `queries` — and, like [`Self::slice_many`], one catch-up pass per
    /// message rather than one per signal, bounded by
    /// [`CATCH_UP_SERVE_BUDGET`].
    ///
    /// The extent of a series still catching up is the extent of what has
    /// decoded so far — it widens as the rebuild advances, exactly as it
    /// does while a live capture grows. It carries no completeness of its
    /// own: this rides the same round-trip as [`Self::slice_many`] over
    /// the same caches, and that is where the caller reads whether the
    /// answer is settled.
    pub fn min_max_many(
        &self,
        queries: &[CacheQuery<'_>],
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Vec<Option<(f64, f64)>> {
        let keys = self.ensure_caches(queries);
        self.catch_up_keys(
            &keys,
            store.len(),
            dbs,
            &store_fetch(store),
            self.serve_deadline(),
        );
        let caches = self.caches.lock().expect("signal cache mutex poisoned");
        keys.iter()
            .map(|key| caches.by_key.get(key).and_then(SignalCache::extent))
            .collect()
    }
}

/// One batch serve: the windows, and whether the caches behind them had
/// finished catching up when it answered (ADR 0049).
pub struct ServedWindows {
    /// One window per query, index-parallel with the batch.
    pub series: Vec<Vec<SamplePoint>>,
    /// `true` when every queried signal's decode cursor reached the store
    /// tip this serve read — the windows are the whole answer for their
    /// range. `false` when the serve ran out of budget first: the windows
    /// hold the prefix decoded so far and a further serve continues from
    /// there.
    ///
    /// This is the token that makes a partial serve first-class (ADR
    /// 0049). Since a catch-up runs off the lock (ADR 0048) a caller can
    /// observe a series mid-rebuild, so a non-empty window has never been
    /// evidence that the series is finished; asking the model is.
    pub complete: bool,
}

/// Whether every cache named by `keys` has decoded through `store_len`.
/// A key with no cache counts as not caught up — the only way a
/// DBC-backed one is missing is a clear between the catch-up and this
/// read, and the caller asking again is right.
///
/// A **file-backed** key is complete as soon as its series exists: the
/// import filled it in one pass that ran to the end of the channel
/// group, so there is never a prefix to come back for. A file-backed key
/// with no cache is a signal this capture doesn't have, which is also a
/// settled answer.
fn caught_up(caches: &Caches, keys: &[SignalKey], store_len: usize) -> bool {
    keys.iter().all(|key| {
        key.file_backed
            || caches
                .by_key
                .get(key)
                .is_some_and(|c| c.next_index >= store_len)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::RawTraceFrame;
    use cannet_core::{CanFramePayload, Direction};
    use tempfile::TempDir;

    #[test]
    fn pyramid_scratch_usage_sums_bytes_files_and_depth() {
        // The scratch-footprint diagnostic (ADR 0002 DS-8) reads this
        // module's own pyramid accounting: total bytes, file count, and the
        // deepest level parsed from the `.l{n}` names it writes. Nested dirs
        // recurse; a non-level file still counts toward bytes/files but not
        // depth.
        let dir = TempDir::new().unwrap();
        let d = dir.path();
        std::fs::write(d.join("sig.s00000100.dead.l0.0000"), vec![0u8; 300]).unwrap();
        std::fs::write(d.join("sig.s00000100.dead.l1.0000"), vec![0u8; 150]).unwrap();
        std::fs::write(d.join("sig.s00000100.dead.l2.0000"), vec![0u8; 70]).unwrap();
        std::fs::write(d.join("not-a-level"), vec![0u8; 5]).unwrap();
        let (bytes, files, depth) = pyramid_scratch_usage(d);
        assert_eq!(bytes, 525); // 300 + 150 + 70 + 5
        assert_eq!(files, 4);
        assert_eq!(depth, 3); // levels l0, l1, l2 → depth 3
                              // A missing dir reads as empty, not a panic.
        assert_eq!(pyramid_scratch_usage(&d.join("absent")), (0, 0, 0));
    }

    fn dummy(ts_ns: u64, id: u32, payload: Vec<u8>) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(payload),
            bus_id: None,
        }
    }

    const TEST_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_:\n\nBO_ 256 Msg: 8 Vector__XXX\n SG_ X : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n\n";

    fn load_dbc() -> Database {
        Database::parse(TEST_DBC).unwrap()
    }

    /// One second in nanoseconds — keeps the test data using
    /// whole-second timestamps so the seconds-based slice bounds read
    /// naturally.
    const S: u64 = 1_000_000_000;

    #[test]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn slice_decodes_lazily_and_returns_only_the_requested_range() {
        let store = TraceStore::new();
        // Mix of id 256 (decodes via the DBC) and id 999 (doesn't).
        // Id-256 samples land at t = 0, 2, 3, 5 seconds.
        store.append(dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(S, 999, vec![0, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(2 * S, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(3 * S, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(4 * S, 999, vec![0, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(5 * S, 256, vec![4, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        // Full time range — all four id-256 samples. `max_points = 0`
        // disables decimation, so the raw level-0 window comes back.
        let all = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            all.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );

        // Narrow time range [2.5, 4.5): only the id-256 sample at t = 3
        // is in range. The ±2 boundary widening also pulls in samples
        // at t = 0 / 2 (just before) and t = 5 (just after), giving
        // uPlot the last-known-coming-in value and the next-going-out
        // value to draw a line across.
        let mid = cache.slice(None, 256, false, "X", 2.5, 4.5, 0, &store, dbs);
        assert_eq!(
            mid.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );

        // Very narrow zoom that contains zero matches: the slice still
        // returns the boundary samples on each side, so the plot draws
        // a line across the canvas instead of going blank.
        let narrow = cache.slice(None, 256, false, "X", 0.5, 1.5, 0, &store, dbs);
        assert_eq!(
            narrow.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );

        // Append a new sample — catch-up extends the cached series.
        store.append(dummy(6 * S, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let all2 = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            all2.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );

        // Clear drops the cache; the next slice rebuilds it.
        cache.clear();
        let after = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(after.len(), 5);
    }

    #[test]
    fn min_max_tracks_all_time_extent_and_catches_up() {
        // The per-signal min/max latch is the host-owned y-extent the
        // plot's auto-normalisation reads (ADR 0025: a scalar model
        // fact, not a windowed accessor). It is all-time and widen-only:
        // a later in-range sample never shrinks it, a new extreme grows
        // it, and a fresh append is caught up on the next call.
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(S, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(2 * S, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        assert_eq!(
            cache.min_max(None, 256, false, "X", &store, dbs),
            Some((1.0, 5.0))
        );
        // A later sample inside the latch doesn't shrink it.
        store.append(dummy(3 * S, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]));
        assert_eq!(
            cache.min_max(None, 256, false, "X", &store, dbs),
            Some((1.0, 5.0))
        );
        // A new extreme widens it.
        store.append(dummy(4 * S, 256, vec![9, 0, 0, 0, 0, 0, 0, 0]));
        assert_eq!(
            cache.min_max(None, 256, false, "X", &store, dbs),
            Some((1.0, 9.0))
        );
    }

    #[test]
    fn min_max_is_none_for_a_signal_nothing_has_decoded() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        // Unknown id and unknown signal both have no decoded samples.
        assert!(cache.min_max(None, 999, false, "X", &store, dbs).is_none());
        assert!(cache
            .min_max(None, 256, false, "Nope", &store, dbs)
            .is_none());
    }

    #[test]
    fn unknown_signal_returns_empty_and_doesnt_panic() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![0; 8]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let nope = cache.slice(None, 256, false, "Nope", 0.0, 1.0, 0, &store, dbs);
        assert!(nope.is_empty());
        let no_id = cache.slice(None, 42, false, "X", 0.0, 1.0, 0, &store, dbs);
        assert!(no_id.is_empty());
    }

    #[test]
    fn bus_id_scoping_keeps_per_bus_series_independent() {
        // Two frames sharing wire channel 0 and the same arbitration
        // id but tagged with different buses get sliced into two
        // independent cached series.
        let store = TraceStore::new();
        let mut a = dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]);
        a.bus_id = Some("p".into());
        let mut b = dummy(S, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]);
        b.bus_id = Some("c".into());
        let mut c2 = dummy(2 * S, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]);
        c2.bus_id = Some("p".into());
        store.append(a);
        store.append(b);
        store.append(c2);
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let on_p = cache.slice(Some("p"), 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            on_p.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 3.0]
        );
        let on_c = cache.slice(Some("c"), 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(on_c.iter().map(|p| p.value).collect::<Vec<_>>(), vec![2.0]);
        // Legacy "any bus" path: takes every frame regardless of tag.
        let any = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            any.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 2.0, 3.0]
        );
    }

    /// A 16-bit LE value packed into the low two payload bytes — the
    /// `X` signal of `TEST_DBC` (`0|16@1+`). Lets the pyramid tests drive
    /// specific decoded values, including a spike.
    fn val_frame(ts_ns: u64, v: u16) -> RawTraceFrame {
        let [b0, b1] = v.to_le_bytes();
        dummy(ts_ns, 256, vec![b0, b1, 0, 0, 0, 0, 0, 0])
    }

    // ---- Semantics one decode pass per message must preserve ---------
    //
    // A cached series is defined by *which* database decodes its signal,
    // which frames its bus scoping admits, and where its decode cursor
    // sits — all three are per-signal facts even when several signals
    // ride the same message. These pin them from the outside (through
    // `slice`), so they hold whoever does the decoding underneath.

    const DBC_HEADER: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_:\n";

    /// Defines message 256 with **only** `A`, at unit scale.
    fn dbc_a_only() -> Database {
        Database::parse(&format!(
            "{DBC_HEADER}\nBO_ 256 Msg: 8 Vector__XXX\n \
             SG_ A : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n"
        ))
        .unwrap()
    }

    /// Defines the same message 256 with `A` at ten times the scale, and
    /// with a second signal `B` the other database doesn't have.
    fn dbc_a_and_b() -> Database {
        Database::parse(&format!(
            "{DBC_HEADER}\nBO_ 256 Msg: 8 Vector__XXX\n \
             SG_ A : 0|16@1+ (10,0) [0|0] \"\" Vector__XXX\n \
             SG_ B : 16|16@1+ (1,0) [0|0] \"\" Vector__XXX\n"
        ))
        .unwrap()
    }

    /// A frame of message 256 carrying `A` in bytes 0-1 and `B` in 2-3.
    fn ab_frame(ts_ns: u64, a: u16, b: u16) -> RawTraceFrame {
        let ([a0, a1], [b0, b1]) = (a.to_le_bytes(), b.to_le_bytes());
        dummy(ts_ns, 256, vec![a0, a1, b0, b1, 0, 0, 0, 0])
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn first_dbc_wins_per_signal_not_per_message() {
        // Decode provenance is resolved **per signal**: each signal
        // takes the first loaded database that yields *it*, not
        // the first that happens to define the message. Here the first
        // database defines the message but only signal `A`, so `A` comes
        // from it (unit scale, not the second database's ×10) while `B`
        // — which it cannot produce — falls through to the second.
        // Deciding provenance once per message would silently rescale
        // `A` or lose `B` entirely.
        let store = TraceStore::new();
        store.append(ab_frame(0, 3, 100));
        store.append(ab_frame(S, 4, 200));
        let (first, second) = (dbc_a_only(), dbc_a_and_b());
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let dbs: &[&Database] = &[&first, &second];
        let a = cache.slice(None, 256, false, "A", f64::MIN, f64::MAX, 0, &store, dbs);
        let b = cache.slice(None, 256, false, "B", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(
            a.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![3.0, 4.0]
        );
        assert_eq!(
            b.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![100.0, 200.0]
        );

        // Load priority is the whole rule: reverse it and `A` takes the
        // ×10 scaling from what is now the first database.
        let tmp2 = TempDir::new().unwrap();
        let cache2 = SignalCacheStore::new(tmp2.path());
        let dbs: &[&Database] = &[&second, &first];
        let a = cache2.slice(None, 256, false, "A", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(
            a.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![30.0, 40.0]
        );
    }

    /// One multiplexed message: a selector plus two signals that decode
    /// only in their own selector group.
    fn dbc_muxed() -> Database {
        Database::parse(&format!(
            "{DBC_HEADER}\nBO_ 512 MuxMsg: 8 Vector__XXX\n \
             SG_ Sel M : 0|8@1+ (1,0) [0|0] \"\" Vector__XXX\n \
             SG_ M0 m0 : 8|16@1+ (1,0) [0|0] \"\" Vector__XXX\n \
             SG_ M1 m1 : 8|16@1+ (1,0) [0|0] \"\" Vector__XXX\n"
        ))
        .unwrap()
    }

    fn mux_frame(ts_ns: u64, selector: u8, v: u16) -> RawTraceFrame {
        let [b0, b1] = v.to_le_bytes();
        RawTraceFrame {
            id: 512,
            ..dummy(ts_ns, 512, vec![selector, b0, b1, 0, 0, 0, 0, 0])
        }
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn a_muxed_signal_only_takes_the_frames_of_its_selector_group() {
        // Two signals of one message whose frame sets are disjoint: the
        // multiplexor gates each to its own selector group, so neither
        // series may pick up the other's frames.
        let store = TraceStore::new();
        store.append(mux_frame(0, 0, 10));
        store.append(mux_frame(S, 1, 11));
        store.append(mux_frame(2 * S, 0, 12));
        store.append(mux_frame(3 * S, 1, 13));
        let db = dbc_muxed();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let m0 = cache.slice(None, 512, false, "M0", f64::MIN, f64::MAX, 0, &store, dbs);
        let m1 = cache.slice(None, 512, false, "M1", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(
            m0.iter()
                .map(|p| (p.t_seconds, p.value))
                .collect::<Vec<_>>(),
            vec![(0.0, 10.0), (2.0, 12.0)]
        );
        assert_eq!(
            m1.iter()
                .map(|p| (p.t_seconds, p.value))
                .collect::<Vec<_>>(),
            vec![(1.0, 11.0), (3.0, 13.0)]
        );
        // The selector itself is a plain signal of the same message and
        // takes every frame.
        let sel = cache.slice(None, 512, false, "Sel", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(sel.len(), 4);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn a_standard_and_an_extended_id_are_separate_series() {
        // The same raw arbitration id on a standard and an extended
        // frame are different messages, decoded by different `BO_`
        // entries. They must never share a series.
        let db = Database::parse(&format!(
            "{DBC_HEADER}\nBO_ 256 StdMsg: 8 Vector__XXX\n \
             SG_ X : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n\
             \nBO_ 2147483904 ExtMsg: 8 Vector__XXX\n \
             SG_ X : 0|16@1+ (100,0) [0|0] \"\" Vector__XXX\n"
        ))
        .unwrap();
        let dbs: &[&Database] = &[&db];
        let store = TraceStore::new();
        store.append(val_frame(0, 1));
        store.append(RawTraceFrame {
            extended: true,
            ..val_frame(S, 2)
        });
        store.append(val_frame(2 * S, 3));
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let std_series = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        let ext_series = cache.slice(None, 256, true, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(
            std_series.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 3.0]
        );
        assert_eq!(
            ext_series.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![200.0]
        );
    }

    #[test]
    #[allow(clippy::float_cmp, clippy::cast_possible_truncation)]
    fn a_signal_first_asked_for_mid_capture_still_reads_from_frame_zero() {
        // Two signals of one message whose decode cursors are far apart:
        // the first was plotted from the start, the second is added once
        // the capture is already running. The newcomer must read the
        // whole history, and the incumbent must not re-read the frames
        // it has already folded into its pyramid.
        let store = TraceStore::new();
        for i in 0..100u64 {
            store.append(ab_frame(i * S, i as u16, 1000 + i as u16));
        }
        let (first, second) = (dbc_a_only(), dbc_a_and_b());
        let dbs: &[&Database] = &[&first, &second];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let a = cache.slice(None, 256, false, "A", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(a.len(), 100);

        for i in 100..150u64 {
            store.append(ab_frame(i * S, i as u16, 1000 + i as u16));
        }
        // `B` joins here, 100 frames behind `A`.
        let b = cache.slice(None, 256, false, "B", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(
            b.iter().map(|p| p.value).collect::<Vec<_>>(),
            (0..150).map(|i| f64::from(1000 + i)).collect::<Vec<_>>(),
        );
        let a = cache.slice(None, 256, false, "A", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(
            a.iter().map(|p| p.value).collect::<Vec<_>>(),
            (0..150).map(f64::from).collect::<Vec<_>>(),
            "no frame decoded twice and none skipped",
        );
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn fit_data_over_large_capture_returns_bounded_points() {
        // Far more samples than the canvas budget: a "fit data" serve
        // must read a coarse pyramid level and return O(max_points), not
        // re-materialize the whole raw series.
        let store = TraceStore::new();
        let n = 50_000u64;
        for i in 0..n {
            store.append(val_frame(i * S, (i % 1000) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        let max_points = 200;
        let fit = cache.slice(
            None,
            256,
            false,
            "X",
            f64::MIN,
            f64::MAX,
            max_points,
            &store,
            dbs,
        );
        // decimate_min_max bounds output to 2*max_points + 2.
        assert!(
            fit.len() <= 2 * max_points + 2,
            "fit returned {} points, expected ≤ {}",
            fit.len(),
            2 * max_points + 2,
        );
        // And far fewer than the raw series — the whole point.
        assert!(fit.len() < n as usize / 10);
    }

    #[test]
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    fn decimation_preserves_spikes() {
        // One extreme sample buried in a flat series must survive a
        // coarse fit-data serve — per-bucket min/max keeps the argmax.
        let store = TraceStore::new();
        let n = 20_000u64;
        let spike_at = 12_345u64;
        for i in 0..n {
            let v = if i == spike_at { 60_000 } else { 1 };
            store.append(val_frame(i * S, v));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        let fit = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 100, &store, dbs);
        assert!(
            fit.iter().any(|p| (p.value - 60_000.0).abs() < 0.5),
            "spike (60000) lost during decimation; got max {:?}",
            fit.iter().map(|p| p.value).fold(f64::MIN, f64::max),
        );
        // The spike's timestamp is preserved too (not snapped to a bucket
        // edge): its bucket's argmax is the spike sample itself.
        assert!(fit
            .iter()
            .any(|p| (p.t_seconds - (spike_at * S) as f64 / 1e9).abs() < 0.5),);
    }

    /// Serve one categorical window and return its `(t, code)` pairs.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn categorical_serve(
        cache: &SignalCacheStore,
        from: f64,
        to: f64,
        max_points: usize,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Vec<(f64, u32)> {
        cache
            .slice_many(
                &[CacheQuery {
                    bus_id: None,
                    message_id: 256,
                    extended: false,
                    signal_name: "X",
                    file_backed: false,
                }],
                from,
                to,
                max_points,
                Reduction::Runs,
                store,
                dbs,
            )
            .series
            .pop()
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.t_seconds, p.value as u32))
            .collect()
    }

    /// The categorical serve's reason to exist, at the serve seam: above
    /// the decimation threshold (`window samples > max_points`) a
    /// categorical window must still carry **every code and every
    /// transition time**, where the numeric serve of the same window
    /// keeps per-bucket extremes and drops the states held in between.
    #[test]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn categorical_serve_keeps_every_code_and_transition_above_the_budget() {
        // 24 held runs of 6 cycling codes, 100 samples each: 2400 samples
        // in a window served at a 600-point budget — four times over the
        // decimation threshold.
        const HOLD: u64 = 100;
        const CODES: u64 = 6;
        let store = TraceStore::new();
        let mut n = 0u64;
        let mut transitions: Vec<(f64, u32)> = Vec::new();
        for run in 0..24u64 {
            let code = run % CODES;
            #[allow(clippy::cast_precision_loss)]
            transitions.push(((n * S) as f64 / 1e9, code as u32));
            for _ in 0..HOLD {
                store.append(val_frame(n * S, code as u16));
                n += 1;
            }
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());

        let max_points = 600;
        let runs = categorical_serve(&cache, f64::MIN, f64::MAX, max_points, &store, dbs);
        // Exactly the transitions, plus the series' final point so the
        // last tile has an end.
        assert_eq!(
            &runs[..transitions.len()],
            &transitions[..],
            "categorical serve lost or moved a transition",
        );
        assert_eq!(runs.len(), transitions.len() + 1);
        // Bounded, and far below the window's sample count.
        assert!(runs.len() <= max_points);

        // The numeric serve of the same window at a budget whose buckets
        // span whole 0..5 cycles keeps each bucket's argmin and argmax
        // only — the codes held in between are gone. This is the defect
        // the categorical path exists to avoid.
        let envelope = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 4, &store, dbs);
        let kept: std::collections::BTreeSet<u32> =
            envelope.iter().map(|p| p.value as u32).collect();
        assert!(
            !kept.contains(&2) && !kept.contains(&3),
            "min/max decimation was expected to drop the middle codes, kept {kept:?}",
        );
    }

    /// Above the *read* budget the answer coarsens rather than losing
    /// held states: a run long enough to fill a coarse bucket still
    /// arrives, with its transition placed to better than a pixel column.
    #[test]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn categorical_serve_coarsens_a_huge_window_without_losing_held_codes() {
        const HOLD: u64 = 5_000;
        const RUNS: u64 = 10;
        let store = TraceStore::new();
        let mut n = 0u64;
        for run in 0..RUNS {
            for _ in 0..HOLD {
                store.append(val_frame(n * S, (run % 6) as u16));
                n += 1;
            }
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());

        // 50 000 samples at a 200-point budget: 40× over the threshold,
        // and well past the read budget too, so this is served off a
        // coarse pyramid level.
        let max_points = 200;
        let served = categorical_serve(&cache, f64::MIN, f64::MAX, max_points, &store, dbs);
        assert!(served.len() <= max_points, "{} points", served.len());
        // Every run still arrives, in order.
        assert_eq!(
            served.iter().map(|&(_, v)| v).collect::<Vec<_>>(),
            (0..RUNS)
                .map(|r| (r % 6) as u32)
                .chain(std::iter::once(((RUNS - 1) % 6) as u32))
                .collect::<Vec<_>>(),
        );
        // …and each transition lands within a pixel column of the truth
        // (one column is `window samples / max_points` = 250 samples).
        #[allow(clippy::cast_precision_loss)]
        let column = (HOLD * RUNS) as f64 / max_points as f64;
        for (i, &(t, _)) in served.iter().take(RUNS as usize).enumerate() {
            #[allow(clippy::cast_precision_loss)]
            let truth = (i as u64 * HOLD) as f64;
            assert!(
                (t - truth).abs() <= column,
                "transition {i} at {t}, truth {truth}, column {column}",
            );
        }
    }

    /// More transitions than the budget: the answer stays whole and
    /// bounded by coarsening, never by truncating the window (ADR 0049 —
    /// an identical request over an unchanged window cannot continue).
    #[test]
    #[allow(clippy::float_cmp)]
    fn categorical_serve_coarsens_when_transitions_exceed_the_budget() {
        let store = TraceStore::new();
        let n = 8_000u64;
        for i in 0..n {
            store.append(val_frame(i * S, (i % 2) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());

        let max_points = 200;
        let served = categorical_serve(&cache, f64::MIN, f64::MAX, max_points, &store, dbs);
        assert!(served.len() <= max_points, "{} points", served.len());
        // Whole window, not a prefix: the answer still reaches the
        // capture's last sample, via the full-resolution tail splice.
        #[allow(clippy::cast_precision_loss)]
        let last_sample = ((n - 1) * S) as f64 / 1e9;
        assert_eq!(served.last().unwrap().0, last_sample);
    }

    /// **Both** reductions answer to the series' newest sample, at any
    /// point budget and at the length a long live session reaches.
    ///
    /// [`SignalCache::fold`] only promotes *complete* buckets, so a read
    /// off a coarse level stops short of the capture by up to that
    /// level's bucket span — a quantity that grows with capture length.
    /// A view drawing held states reads the gap as the signal having
    /// stopped; a line renderer draws a live plot that ends short of the
    /// live edge. [`SignalCache::level_points`] is what closes it, and it
    /// has to apply to both reductions: the leading edges of a lane and
    /// of a line over the same capture must agree.
    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    fn a_served_window_reaches_the_newest_sample_at_long_capture_length() {
        // 90 minutes of capture — deep enough that the whole-capture
        // window is read off a level several folds up (ten levels for the
        // 100 Hz series), which is where the un-folded tail is worth
        // seconds rather than milliseconds.
        const SPAN_SECONDS: f64 = 5400.0;
        let dir = TempDir::new().unwrap();
        let build = |base: &str, hz: f64, value: &dyn Fn(usize) -> f64| {
            let mut cache = SignalCache::new(dir.path(), base, None);
            for i in 0..(SPAN_SECONDS * hz) as usize {
                cache.push_sample(i as f64 / hz, value(i));
                cache.fold();
            }
            cache
        };
        // A fast varying series (two points per folded bucket, so the
        // pyramid is at its shallowest per sample) and a slow one held in
        // long runs (one point per bucket) — the two shapes a mixed plot
        // puts on its axes.
        let varying = build("varying", 100.0, &|i| (i as f64 / 500.0).sin());
        let held = build("held", 10.0, &|i| ((i / 4_000) % 4) as f64);

        for (name, cache) in [("varying", &varying), ("held", &held)] {
            let tip = cache.latest().expect("series has samples").t_seconds;
            // From the narrowest budget the plot ever asks for to a
            // full-width canvas: the coarser the read, the longer the
            // tail that has not folded yet.
            for max_points in [200usize, 720, 2248] {
                let runs = cache.window_categorical(0.0, tip + 1.0, max_points);
                assert_eq!(
                    runs.last().expect("non-empty").t_seconds,
                    tip,
                    "{name}: categorical serve stopped short at max_points {max_points}",
                );
                let envelope = cache.window(0.0, tip + 1.0, max_points);
                assert_eq!(
                    envelope.last().expect("non-empty").t_seconds,
                    tip,
                    "{name}: min/max serve stopped short at max_points {max_points}",
                );
            }
        }
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn zoom_in_reads_a_finer_level_than_fit_data() {
        // A narrow window over the same capture should serve more detail
        // (finer level) than the whole-capture fit — the level choice is
        // window-relative, not capture-relative.
        let store = TraceStore::new();
        let n = 40_000u64;
        for i in 0..n {
            store.append(val_frame(i * S, (i % 500) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        let max_points = 100;
        // Whole capture.
        let fit = cache.slice(
            None,
            256,
            false,
            "X",
            f64::MIN,
            f64::MAX,
            max_points,
            &store,
            dbs,
        );
        // A 500-sample-wide window (well under the level-0 count but over
        // max_points): served from a fine level, so every in-window raw
        // sample is representable.
        let from = 1000.0;
        let to = 1500.0;
        let zoom = cache.slice(None, 256, false, "X", from, to, max_points, &store, dbs);
        // Both honour the budget…
        assert!(fit.len() <= 2 * max_points + 2);
        assert!(zoom.len() <= 2 * max_points + 2);
        // …and the zoomed window's samples all fall in range (plus the ±2
        // boundary), confirming it's a window slice, not the whole series.
        let in_range = zoom
            .iter()
            .filter(|p| p.t_seconds >= from && p.t_seconds < to)
            .count();
        assert!(in_range > 0 && in_range <= 504);
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn catch_up_never_materializes_more_than_one_chunk_at_a_time() {
        // The property that keeps a first-use rebuild over restored history
        // from spiking: the scan asks for one bounded chunk at a time and
        // the chunks tile the unscanned range exactly. Driven through the
        // fetch seam so a multi-million-frame span costs the test nothing.
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());
        let store_len = 5 * CATCH_UP_CHUNK_FRAMES + 7;
        let asked = std::cell::RefCell::new(Vec::new());
        let key = catch_up_through(
            &cache,
            &[CacheQuery {
                bus_id: None,
                message_id: 256,
                extended: false,
                signal_name: "X",
                file_backed: false,
            }],
            store_len,
            dbs,
            |_, _, from, to| {
                asked.borrow_mut().push((from, to));
                // Every fourth frame in the chunk carries the decodable id.
                (from..to)
                    .step_by(4)
                    .map(|i| (i, val_frame(i as u64 * S, (i % 251) as u16)))
                    .collect()
            },
        )
        .remove(0);

        let asked = asked.into_inner();
        assert!(asked.len() >= 5, "expected several chunks, got {asked:?}");
        assert!(
            asked
                .iter()
                .all(|&(from, to)| to - from <= CATCH_UP_CHUNK_FRAMES),
            "a chunk exceeded the cap: {asked:?}",
        );
        // Tiling: starts at 0, ends at the tip, no gap and no overlap.
        assert_eq!(asked.first().map(|c| c.0), Some(0));
        assert_eq!(asked.last().map(|c| c.1), Some(store_len));
        assert!(asked.windows(2).all(|w| w[0].1 == w[1].0), "{asked:?}");
        // And every matching frame in the span decoded exactly once.
        with_cache(&cache, &key, |c| {
            assert_eq!(c.levels[0].len(), store_len.div_ceil(4));
            assert_eq!(c.next_index, store_len);
        });
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn catch_up_decodes_a_capture_longer_than_one_scan_chunk() {
        // Equivalence pin for the first-use rebuild: a capture spanning
        // several scan chunks must decode to exactly the samples a
        // single-shot scan would produce, in capture order, and a later
        // catch-up must resume at the tip (no gap, no duplicate) even when
        // the resume point falls inside a chunk.
        let store = TraceStore::new();
        let n = 2 * CATCH_UP_CHUNK_FRAMES + 1234;
        for i in 0..n {
            // Every third frame carries the decodable id; the rest don't.
            if i % 3 == 0 {
                store.append(val_frame(i as u64 * S, (i % 977) as u16));
            } else {
                store.append(dummy(i as u64 * S, 999, vec![0; 8]));
            }
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());

        let expect: Vec<f64> = (0..n)
            .filter(|i| i % 3 == 0)
            .map(|i| f64::from((i % 977) as u16))
            .collect();
        let all = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(all.len(), expect.len());
        assert_eq!(all.iter().map(|p| p.value).collect::<Vec<_>>(), expect);
        assert_eq!(all.first().map(|p| p.t_seconds), Some(0.0));

        // Extend past the tip and catch up again: only the new matches
        // land, appended after the ones already decoded.
        for i in n..n + 600 {
            if i % 3 == 0 {
                store.append(val_frame(i as u64 * S, (i % 977) as u16));
            } else {
                store.append(dummy(i as u64 * S, 999, vec![0; 8]));
            }
        }
        let expect2: Vec<f64> = (0..n + 600)
            .filter(|i| i % 3 == 0)
            .map(|i| f64::from((i % 977) as u16))
            .collect();
        let all2 = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(all2.iter().map(|p| p.value).collect::<Vec<_>>(), expect2);
    }

    // ---- A bounded serve, and the token that admits it ----------------
    //
    // Chunking the catch-up bounded the lock hold (ADR 0048); it did not
    // bound the *call*. These pin the second half: a serve stops at its
    // budget, answers with the prefix it decoded, says it is not finished,
    // and converges on exactly the series an unbounded serve returns.
    // Driven through a store built one chunk at a time, so the assertions
    // are about the rule and not about how fast the machine decodes.

    /// A capture of `frames` frames, every one of them message 256 with a
    /// strictly increasing `X` — so a prefix of the series is
    /// distinguishable from the whole of it by its length *and* by its
    /// extent.
    #[allow(clippy::cast_possible_truncation)]
    fn rising_capture(frames: usize) -> TraceStore {
        let store = TraceStore::new();
        for i in 0..frames {
            store.append(val_frame(i as u64 * S, i as u16));
        }
        store
    }

    fn query_on(message_id: u32, signal_name: &str) -> CacheQuery<'_> {
        CacheQuery {
            bus_id: None,
            message_id,
            extended: false,
            signal_name,
            file_backed: false,
        }
    }

    #[test]
    fn a_serve_out_of_budget_answers_with_its_prefix_and_says_it_is_partial() {
        let store = rising_capture(3 * CATCH_UP_CHUNK_FRAMES);
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_chunk_at_a_time(tmp.path());
        let queries = [query_on(256, "X")];
        let serve = || {
            cache.slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                0,
                Reduction::MinMax,
                &store,
                dbs,
            )
        };

        // One chunk in, the serve returns rather than finishing the
        // rebuild — with points to draw, and honest about there being
        // more.
        let first = serve();
        assert!(
            !first.complete,
            "a serve that stopped a chunk in must not claim the series is finished",
        );
        assert_eq!(first.series[0].len(), CATCH_UP_CHUNK_FRAMES);

        // Asking again continues where it left off, and the third serve
        // reaches the tip — no gap, no duplicate, and the same series an
        // unbounded serve builds in one call.
        let mut served = serve();
        let mut round_trips = 2;
        while !served.complete {
            assert!(
                round_trips < 10,
                "the rebuild is not converging: {round_trips} serves",
            );
            served = serve();
            round_trips += 1;
        }
        assert_eq!(round_trips, 3);
        let other = TempDir::new().unwrap();
        let whole = SignalCacheStore::new_unbounded(other.path()).slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &store,
            dbs,
        );
        assert!(whole.complete);
        assert_eq!(served.series[0], whole.series[0]);
        assert_eq!(served.series[0].len(), 3 * CATCH_UP_CHUNK_FRAMES);
    }

    #[test]
    fn a_serve_that_reached_the_tip_says_so_even_with_nothing_to_show() {
        // Completeness is about the catch-up, not about the points: a
        // capture with no frames, and a capture no database decodes, are
        // both *finished* answers. A caller that re-asked until the
        // window was non-empty would spin forever on either.
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_chunk_at_a_time(tmp.path());
        let queries = [query_on(256, "X")];

        let empty = cache.slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &TraceStore::new(),
            dbs,
        );
        assert!(empty.complete);
        assert!(empty.series[0].is_empty());

        let undecodable = undecodable_store(CATCH_UP_CHUNK_FRAMES);
        let served = cache.slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &undecodable,
            dbs,
        );
        assert!(served.complete);
        assert!(served.series[0].is_empty());
    }

    #[test]
    fn an_exhausted_budget_still_advances_every_message_group() {
        // The budget is spent by whichever group is caught up first, so a
        // signal listed behind an expensive one would never move if the
        // deadline could stop a group before its first chunk. Every group
        // scans one chunk regardless.
        let store = TraceStore::new();
        let n = 4 * CATCH_UP_CHUNK_FRAMES;
        for i in 0..n {
            #[allow(clippy::cast_possible_truncation)]
            let mut frame = val_frame(i as u64 * S, i as u16);
            // Two messages, alternating — so the batch is two groups and
            // the second one is behind the deadline the first spent.
            if i % 2 == 1 {
                frame.id = 512;
            }
            store.append(frame);
        }
        let db = dbc_two_areas();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_chunk_at_a_time(tmp.path());
        let queries = [query_on(256, "X"), query_on(512, "Y")];
        let served = cache.slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &store,
            dbs,
        );
        assert!(!served.complete);
        // Half the chunk's frames are each group's, so both groups
        // scanned one chunk of the same span — neither starved.
        assert_eq!(served.series[0].len(), CATCH_UP_CHUNK_FRAMES / 2);
        assert_eq!(served.series[1].len(), CATCH_UP_CHUNK_FRAMES / 2);
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn a_serve_stays_bounded_while_the_capture_is_still_growing() {
        // The freeze-during-import shape: a plot samples while the pump
        // is still appending, so the tip the catch-up is chasing moves
        // under it. Each serve does its budget's worth against the tip it
        // read and says it is behind — it never runs to a moving target.
        let store = rising_capture(2 * CATCH_UP_CHUNK_FRAMES);
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_chunk_at_a_time(tmp.path());
        let queries = [query_on(256, "X")];

        let first = cache.slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &store,
            dbs,
        );
        assert!(!first.complete);
        assert_eq!(first.series[0].len(), CATCH_UP_CHUNK_FRAMES);

        // The import runs on: two more chunks of capture land before the
        // next tick.
        for i in 2 * CATCH_UP_CHUNK_FRAMES..4 * CATCH_UP_CHUNK_FRAMES {
            store.append(val_frame(i as u64 * S, i as u16));
        }
        let second = cache.slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &store,
            dbs,
        );
        assert!(!second.complete);
        assert_eq!(second.series[0].len(), 2 * CATCH_UP_CHUNK_FRAMES);
    }

    #[test]
    fn an_extent_serve_is_bounded_too_and_widens_as_the_rebuild_advances() {
        // The y-extent sidecar rides the same round-trip and catches up
        // the same caches, so it has to stop at the same budget — an
        // unbounded one would hold the plot's fetch for the whole rebuild
        // however promptly the samples came back. Its answer is the
        // extent of what has decoded, which widens exactly as it does
        // while a live capture grows.
        let store = rising_capture(3 * CATCH_UP_CHUNK_FRAMES);
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_chunk_at_a_time(tmp.path());
        let queries = [query_on(256, "X")];

        let first = cache.min_max_many(&queries, &store, dbs);
        #[allow(clippy::cast_precision_loss)]
        let chunk_hi = (CATCH_UP_CHUNK_FRAMES - 1) as f64;
        assert_eq!(first[0], Some((0.0, chunk_hi)));

        while !cache
            .slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                0,
                Reduction::MinMax,
                &store,
                dbs,
            )
            .complete
        {}
        #[allow(clippy::cast_precision_loss)]
        let all_hi = (3 * CATCH_UP_CHUNK_FRAMES - 1) as f64;
        assert_eq!(
            cache.min_max_many(&queries, &store, dbs)[0],
            Some((0.0, all_hi)),
        );
    }

    #[test]
    fn pyramid_levels_spill_to_disk_and_clear_wipes_them() {
        // Enough samples to fold at least one higher level (200 / 8 = 25
        // level-1 points), so more than level 0 lands on disk.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        // Serving catches the pyramid up; its level files land under root.
        let _ = cache.slice(None, 256, false, "X", 0.0, 1000.0, 100, &store, dbs);
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().any(|n| n.contains(".l0.")),
            "expected a level-0 segment file, got {names:?}",
        );
        assert!(
            names.iter().any(|n| n.contains(".l1.")),
            "expected a folded level-1 segment file, got {names:?}",
        );

        // Clear drops the caches (unmapping) and wipes the files.
        cache.clear();
        let after = std::fs::read_dir(tmp.path()).unwrap().flatten().count();
        assert_eq!(after, 0, "clear must wipe the pyramid files");

        // A subsequent serve rebuilds the pyramid from the raw store.
        let rebuilt = cache.slice(None, 256, false, "X", 0.0, 1000.0, 0, &store, dbs);
        assert_eq!(rebuilt.len(), 200);
    }

    #[test]
    fn rerooting_unmaps_the_old_pyramids_and_spills_into_the_new_root() {
        // Re-rooting the session (ADR 0042) has to leave the old cache
        // directory's files unmapped — on Windows a mapped file cannot even
        // be removed, and the trace store is about to move its own files
        // out from beside them. Nothing is carried: a pyramid rebuilds from
        // the raw frames on the next serve.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(a.path());
        let _ = cache.slice(None, 256, false, "X", 0.0, 1000.0, 100, &store, dbs);
        assert!(std::fs::read_dir(a.path()).unwrap().flatten().count() > 0);

        cache.reroot(b.path());

        // Unmapped: the old root's files can now be removed, which is the
        // operational form of "nothing holds them any more".
        for entry in std::fs::read_dir(a.path()).unwrap().flatten() {
            std::fs::remove_file(entry.path()).expect("the old pyramids must be unmapped");
        }
        assert_eq!(std::fs::read_dir(b.path()).unwrap().flatten().count(), 0);

        let rebuilt = cache.slice(None, 256, false, "X", 0.0, 1000.0, 0, &store, dbs);
        assert_eq!(rebuilt.len(), 200, "the pyramid rebuilds on demand");
        assert!(
            std::fs::read_dir(b.path()).unwrap().flatten().count() > 0,
            "and it spills into the new root"
        );
    }

    #[test]
    fn serve_skips_an_evicted_pyramid_front_without_panicking() {
        // The evicted-read contract for the signal cache (ADR 0002): once a
        // pyramid level is front-trimmed to honor the scratch cap, the serve
        // path must read only the live tail and never touch a slot below the
        // level's low-water mark. (Step 6d raises the mark when it drops the
        // segment files; here we raise it directly to assert the read path
        // already tolerates it.)
        let dir = TempDir::new().unwrap();
        let mut cache = SignalCache::new(dir.path(), "sig", None);
        for i in 0..100u32 {
            cache.levels[0].push(f64::from(i), f64::from(i));
        }
        cache.levels[0].evict_below(40); // drop the oldest 40 (t = 0..40)
        assert_eq!(cache.levels[0].first_slot(), 40);

        // A whole-span serve returns only the live tail, in order, no panic.
        let pts = cache.window(0.0, 1000.0, 0);
        assert_eq!(pts.len(), 60);
        assert_eq!(pts.first().map(|p| p.t_seconds), Some(40.0));
        assert_eq!(pts.last().map(|p| p.t_seconds), Some(99.0));
        // A window straddling the floor never reads below it (the ±2
        // boundary widening clamps to the mark, not to slot 38/39).
        let straddle = cache.window(0.0, 50.0, 0);
        assert!(straddle.iter().all(|p| p.t_seconds >= 40.0));
        // A fully-evicted level serves empty rather than reading a dead slot.
        cache.levels[0].evict_below(100);
        assert!(cache.window(0.0, 1000.0, 0).is_empty());
    }

    #[test]
    fn evict_below_trims_the_pyramid_by_time_and_reclaims_disk() {
        // 6d: front-trim the whole pyramid to a truncation timestamp — every
        // level drops the points (and leading segment files) older than it,
        // keeping the serve aligned with the raw store's live window.
        let dir = TempDir::new().unwrap();
        let mut cache = SignalCache::new(dir.path(), "0x100.sig", None);
        for i in 0..200u32 {
            cache.levels[0].push(f64::from(i), f64::from(i)); // t = value = i seconds
        }
        cache.fold(); // build the higher levels
        let before = std::fs::read_dir(dir.path()).unwrap().count();
        cache.evict_below(100.0);
        assert_eq!(
            cache.levels[0].first_slot(),
            100,
            "level-0 floor rose to t=100"
        );
        let pts = cache.window(0.0, 200.0, 0);
        assert!(!pts.is_empty());
        assert!(
            pts.iter().all(|p| p.t_seconds >= 100.0),
            "no point below the truncation time survives",
        );
        let after = std::fs::read_dir(dir.path()).unwrap().count();
        assert!(after < before, "pyramid disk reclaimed: {after} < {before}");
    }

    // ---- One decode pass per message ---------------------------------

    /// Catch `queries` up through the same seam the production path uses,
    /// with `fetch` standing in for the trace store — so a scan over a span
    /// no fixture could hold, or one that blocks mid-chunk, is drivable.
    /// Returns the batch's keys in request order.
    fn catch_up_through(
        store: &SignalCacheStore,
        queries: &[CacheQuery<'_>],
        store_len: usize,
        dbs: &[&Database],
        fetch: impl Fn(u32, bool, usize, usize) -> Vec<(usize, RawTraceFrame)>,
    ) -> Vec<SignalKey> {
        let keys = store.ensure_caches(queries);
        store.catch_up_keys(&keys, store_len, dbs, &fetch, store.serve_deadline());
        keys
    }

    /// Read one cached series' interior — the pyramid levels, cursors and
    /// extent the tests assert on.
    fn with_cache<T>(
        store: &SignalCacheStore,
        key: &SignalKey,
        f: impl FnOnce(&SignalCache) -> T,
    ) -> T {
        let caches = store.caches.lock().unwrap();
        f(caches.by_key.get(key).expect("cache missing for key"))
    }

    /// Everything a built pyramid *is*: the decode cursor, the all-time
    /// extent, the fold cursors, and every live slot of every level.
    /// Two ways of building the same series must agree on all of it, so
    /// this is what the equivalence check compares.
    type PyramidDump = Vec<(SignalKey, usize, f64, f64, Vec<usize>, Vec<Vec<(f64, f64)>>)>;

    fn dump_pyramids(store: &SignalCacheStore) -> PyramidDump {
        let caches = store.caches.lock().unwrap();
        let mut rows: PyramidDump = caches
            .by_key
            .iter()
            .map(|(key, cache)| {
                let levels = cache
                    .levels
                    .iter()
                    .map(|l| (l.first_slot()..l.len()).map(|k| l.get(k)).collect())
                    .collect();
                (
                    key.clone(),
                    cache.next_index,
                    cache.lo,
                    cache.hi,
                    cache.folded.clone(),
                    levels,
                )
            })
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows
    }

    /// A capture with everything a shared pass has to keep apart on one
    /// message: two signals of message 256 that resolve to *different*
    /// databases, a third series scoped to one bus, a multiplexed
    /// message whose two signals see disjoint frames, an extended frame
    /// of the same raw id as a standard one, and frames no database
    /// decodes. Longer than one scan chunk, so the chunk boundary is in
    /// the comparison too.
    #[allow(clippy::cast_possible_truncation)]
    fn mixed_capture() -> TraceStore {
        let store = TraceStore::new();
        let n = CATCH_UP_CHUNK_FRAMES + 500;
        for i in 0..n {
            let t = i as u64 * 1_000_000;
            let frame = match i % 5 {
                0 => {
                    let mut f = ab_frame(t, (i % 977) as u16, 2000 + (i % 311) as u16);
                    f.bus_id = Some(if i % 10 == 0 { "p" } else { "c" }.into());
                    f
                }
                1 => mux_frame(t, (i % 2) as u8, (i % 641) as u16),
                2 => RawTraceFrame {
                    extended: true,
                    ..val_frame(t, (i % 101) as u16)
                },
                3 => val_frame(t, (i % 53) as u16),
                _ => dummy(t, 999, vec![0; 8]),
            };
            store.append(frame);
        }
        store
    }

    /// The queries `mixed_capture` is built for — several per message,
    /// several buses, two message ids that differ only in `extended`.
    fn mixed_queries<'a>() -> Vec<CacheQuery<'a>> {
        vec![
            CacheQuery {
                bus_id: None,
                message_id: 256,
                extended: false,
                signal_name: "A",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 256,
                extended: false,
                signal_name: "B",
                file_backed: false,
            },
            CacheQuery {
                bus_id: Some("p"),
                message_id: 256,
                extended: false,
                signal_name: "A",
                file_backed: false,
            },
            CacheQuery {
                bus_id: Some("c"),
                message_id: 256,
                extended: false,
                signal_name: "B",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 512,
                extended: false,
                signal_name: "M0",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 512,
                extended: false,
                signal_name: "M1",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 512,
                extended: false,
                signal_name: "Sel",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 256,
                extended: true,
                signal_name: "X",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 777,
                extended: false,
                signal_name: "Nothing",
                file_backed: false,
            },
        ]
    }

    /// The four databases `mixed_capture` is decoded against, in load
    /// order — the first two overlap on message 256 so provenance is
    /// resolved per signal.
    fn mixed_dbs() -> Vec<Database> {
        let ext = Database::parse(&format!(
            "{DBC_HEADER}\nBO_ 2147483904 ExtMsg: 8 Vector__XXX\n \
             SG_ X : 0|16@1+ (100,0) [0|0] \"\" Vector__XXX\n"
        ))
        .unwrap();
        vec![dbc_a_only(), dbc_a_and_b(), dbc_muxed(), ext]
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn a_shared_pass_builds_the_same_pyramids_as_a_per_signal_one() {
        // The equivalence bar: catching a message's signals up together
        // must produce exactly what catching each up on its own did —
        // same samples, same cursors, same extents, same pyramid levels
        // slot for slot. Everything else in this phase is an
        // optimisation *of* this.
        let store = mixed_capture();
        let owned = mixed_dbs();
        let dbs: Vec<&Database> = owned.iter().collect();
        let queries = mixed_queries();

        // Per signal: each `slice` is its own one-member group, which
        // is what the catch-up did before the sharing.
        let one_at_a_time = TempDir::new().unwrap();
        let per_signal = SignalCacheStore::new_unbounded(one_at_a_time.path());
        let separate: Vec<Vec<SamplePoint>> = queries
            .iter()
            .map(|q| {
                per_signal.slice(
                    q.bus_id,
                    q.message_id,
                    q.extended,
                    q.signal_name,
                    f64::MIN,
                    f64::MAX,
                    0,
                    &store,
                    &dbs,
                )
            })
            .collect();

        // Shared: one pass per message for the whole batch.
        let together = TempDir::new().unwrap();
        let grouped = SignalCacheStore::new_unbounded(together.path());
        let shared = grouped.slice_many(
            &queries,
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &store,
            &dbs,
        );

        assert!(shared.complete);
        let shared = shared.series;
        assert_eq!(shared, separate, "the served windows must be identical");
        assert_eq!(
            dump_pyramids(&grouped),
            dump_pyramids(&per_signal),
            "the pyramids must be identical",
        );
        // And the fixture must actually exercise the thing: several
        // messages, several signals each, all non-empty but the one
        // deliberately undecodable query.
        assert!(shared[..8].iter().all(|s| !s.is_empty()));
        assert!(shared[8].is_empty());
        // Provenance really is split across databases here: `A` stayed
        // on the first database's unit scale (the raws run below 977,
        // so the ×10 database would have put values above it), and `B`
        // — which only the second database defines — came through.
        assert!(shared[0].iter().all(|p| p.value < 977.0));
        assert_eq!(shared[1][0].value, 2000.0);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn the_extents_of_a_shared_pass_match_a_per_signal_one() {
        // `min_max_many` shares the same catch-up, so the host-owned
        // y-extent (ADR 0025) has to come out of it unchanged too.
        let store = mixed_capture();
        let owned = mixed_dbs();
        let dbs: Vec<&Database> = owned.iter().collect();
        let queries = mixed_queries();

        let a = TempDir::new().unwrap();
        let per_signal = SignalCacheStore::new_unbounded(a.path());
        let separate: Vec<Option<(f64, f64)>> = queries
            .iter()
            .map(|q| {
                per_signal.min_max(
                    q.bus_id,
                    q.message_id,
                    q.extended,
                    q.signal_name,
                    &store,
                    &dbs,
                )
            })
            .collect();
        let b = TempDir::new().unwrap();
        let grouped = SignalCacheStore::new_unbounded(b.path());
        assert_eq!(grouped.min_max_many(&queries, &store, &dbs), separate);
        assert!(separate[0].is_some() && separate[8].is_none());
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn one_group_fetches_each_chunk_once_for_all_its_signals() {
        // The work that disappears: N series of one message used to
        // fetch (and decode) the same frames N times. Driven through
        // the fetch seam, so the count is observable — three series,
        // one walk.
        let owned = [dbc_a_only(), dbc_a_and_b()];
        let dbs: Vec<&Database> = owned.iter().collect();
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());
        let queries = [
            CacheQuery {
                bus_id: None,
                message_id: 256,
                extended: false,
                signal_name: "A",
                file_backed: false,
            },
            CacheQuery {
                bus_id: Some("p"),
                message_id: 256,
                extended: false,
                signal_name: "A",
                file_backed: false,
            },
            CacheQuery {
                bus_id: None,
                message_id: 256,
                extended: false,
                signal_name: "B",
                file_backed: false,
            },
        ];
        let store_len = 2 * CATCH_UP_CHUNK_FRAMES + 7;
        let fetches = std::cell::Cell::new(0usize);
        let keys = catch_up_through(&cache, &queries, store_len, &dbs, |_, _, from, to| {
            fetches.set(fetches.get() + 1);
            (from..to)
                .map(|i| {
                    let mut f = ab_frame(i as u64 * 1_000_000, (i % 97) as u16, (i % 89) as u16);
                    f.bus_id = Some(if i % 3 == 0 { "p" } else { "c" }.into());
                    (i, f)
                })
                .collect()
        });

        assert_eq!(
            fetches.get(),
            store_len.div_ceil(CATCH_UP_CHUNK_FRAMES),
            "one walk of the message, not one per signal",
        );
        // Each series still got exactly its own frames.
        let lens: Vec<usize> = keys
            .iter()
            .map(|k| with_cache(&cache, k, |c| c.levels[0].len()))
            .collect();
        assert_eq!(lens, vec![store_len, store_len.div_ceil(3), store_len]);
        for key in &keys {
            assert_eq!(with_cache(&cache, key, |c| c.next_index), store_len);
        }
    }

    #[test]
    #[allow(clippy::float_cmp, clippy::cast_possible_truncation)]
    fn a_group_scans_from_its_furthest_behind_cursor_without_re_reading() {
        // Heterogeneous cursors: one series has been plotted since the
        // capture started, another is added now. The shared scan starts
        // at the minimum cursor — so the newcomer reads the whole
        // history — while the frame index gates the incumbent, which
        // must not append a frame it already has.
        let store = TraceStore::new();
        for i in 0..100u64 {
            store.append(ab_frame(i * S, i as u16, 1000 + i as u16));
        }
        let owned = [dbc_a_only(), dbc_a_and_b()];
        let dbs: Vec<&Database> = owned.iter().collect();
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let a = CacheQuery {
            bus_id: None,
            message_id: 256,
            extended: false,
            signal_name: "A",
            file_backed: false,
        };
        let b = CacheQuery {
            bus_id: None,
            message_id: 256,
            extended: false,
            signal_name: "B",
            file_backed: false,
        };
        // `A` alone first, then more capture, then both together.
        assert_eq!(
            cache
                .slice_many(
                    std::slice::from_ref(&a),
                    f64::MIN,
                    f64::MAX,
                    0,
                    Reduction::MinMax,
                    &store,
                    &dbs
                )
                .series[0]
                .len(),
            100
        );
        for i in 100..150u64 {
            store.append(ab_frame(i * S, i as u16, 1000 + i as u16));
        }
        let both = cache
            .slice_many(
                &[a, b],
                f64::MIN,
                f64::MAX,
                0,
                Reduction::MinMax,
                &store,
                &dbs,
            )
            .series;
        assert_eq!(
            both[0].iter().map(|p| p.value).collect::<Vec<_>>(),
            (0..150).map(f64::from).collect::<Vec<_>>(),
            "the incumbent appended each frame exactly once",
        );
        assert_eq!(
            both[1].iter().map(|p| p.value).collect::<Vec<_>>(),
            (0..150).map(|i| f64::from(1000 + i)).collect::<Vec<_>>(),
            "the newcomer read the whole history",
        );
    }

    #[test]
    fn a_batch_answers_in_request_order_including_repeats() {
        // The index-parallel contract the callers rely on: one result
        // per query, in the order asked, however the batch was grouped
        // internally — and a repeated query answers twice, identically.
        let store = mixed_capture();
        let owned = mixed_dbs();
        let dbs: Vec<&Database> = owned.iter().collect();
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let mut queries = mixed_queries();
        let repeat = CacheQuery {
            bus_id: None,
            message_id: 256,
            extended: false,
            signal_name: "A",
            file_backed: false,
        };
        queries.push(repeat);
        let out = cache
            .slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                0,
                Reduction::MinMax,
                &store,
                &dbs,
            )
            .series;
        assert_eq!(out.len(), queries.len());
        assert_eq!(out[0], out[queries.len() - 1]);
        // An empty batch is a no-op, not a panic — and trivially
        // complete, since it named nothing that could still be catching
        // up.
        let none = cache.slice_many(&[], f64::MIN, f64::MAX, 0, Reduction::MinMax, &store, &dbs);
        assert!(none.series.is_empty() && none.complete);
        assert!(cache.min_max_many(&[], &store, &dbs).is_empty());
    }

    // ---- Lock granularity (ADR 0048) ---------------------------------
    //
    // A cold rebuild is minutes of fetching and decoding. These pin that
    // it holds nothing while it does that: the probes below run *while* a
    // rebuild sits blocked inside its chunk fetch, and each one has to
    // finish on its own rather than behind the rebuild. Written as
    // would-block probes — the main thread waits on a channel with a
    // timeout and releases the rebuild either way, so a regression fails
    // the assertion instead of hanging the suite.

    /// How long a probe may take before it counts as blocked. Generous:
    /// every operation it covers is microseconds of real work, so the
    /// only way to spend this long is waiting on the rebuild.
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    /// Message 256 signal `X` and message 512 signal `Y` — one plotted
    /// signal in each of two plot areas.
    fn dbc_two_areas() -> Database {
        Database::parse(&format!(
            "{DBC_HEADER}\nBO_ 256 MsgA: 8 Vector__XXX\n \
             SG_ X : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n\
             \nBO_ 512 MsgB: 8 Vector__XXX\n \
             SG_ Y : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n"
        ))
        .unwrap()
    }

    fn query_x<'a>() -> CacheQuery<'a> {
        CacheQuery {
            bus_id: None,
            message_id: 256,
            extended: false,
            signal_name: "X",
            file_backed: false,
        }
    }

    fn key_x() -> SignalKey {
        SignalKey::dbc(None, 256, false, "X".to_string())
    }

    /// Run `probe` while a cold catch-up of message 256 sits blocked
    /// inside its first chunk fetch, and report whether it finished
    /// within [`PROBE_TIMEOUT`]. The rebuild is released either way, so
    /// both threads always join.
    fn while_a_cold_rebuild_runs(
        cache: &SignalCacheStore,
        dbs: &[&Database],
        store_len: usize,
        probe: impl FnOnce() + Send,
    ) -> bool {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;
        let (reached_tx, reached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                let first = AtomicBool::new(true);
                catch_up_through(cache, &[query_x()], store_len, dbs, |_, _, from, to| {
                    if first.swap(false, Ordering::SeqCst) {
                        // Inside the chunk fetch: cursors planned, nothing
                        // decoded, and — the property under test — no lock
                        // held.
                        reached_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                    }
                    #[allow(clippy::cast_possible_truncation)]
                    (from..to)
                        .map(|i| (i, val_frame(i as u64 * 1_000_000, (i % 251) as u16)))
                        .collect()
                });
            });
            reached_rx.recv().unwrap();
            scope.spawn(move || {
                probe();
                done_tx.send(()).unwrap();
            });
            let finished = done_rx.recv_timeout(PROBE_TIMEOUT).is_ok();
            release_tx.send(()).unwrap();
            finished
        })
    }

    #[test]
    fn a_cold_rebuild_in_one_area_does_not_block_another() {
        // The motivating defect: one area's first-use rebuild held the
        // whole signal-cache mutex, so every other plot's serve, every
        // min/max sidecar and the flusher's eviction queued behind it.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(dummy(
                i * S,
                512,
                vec![(i % 251) as u8, 0, 0, 0, 0, 0, 0, 0],
            ));
        }
        let db = dbc_two_areas();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());
        let store_len = 3 * CATCH_UP_CHUNK_FRAMES;

        let finished = while_a_cold_rebuild_runs(&cache, dbs, store_len, || {
            // The other area's serve, its y-extent, and the flusher's
            // front-trim — the three the item names.
            let points = cache.slice(None, 512, false, "Y", f64::MIN, f64::MAX, 0, &store, dbs);
            assert_eq!(points.len(), 200);
            assert!(cache.min_max(None, 512, false, "Y", &store, dbs).is_some());
            cache.evict_below(50.0);
        });
        assert!(
            finished,
            "another area's sampling, min/max and eviction waited for the rebuild",
        );

        // And the rebuild itself still completed, whole.
        with_cache(&cache, &key_x(), |c| {
            assert_eq!(c.next_index, store_len);
            assert_eq!(c.levels[0].len(), store_len);
        });
    }

    #[test]
    fn the_exit_path_does_not_wait_for_a_cold_rebuild() {
        // The exit contract. Closing the window runs the pyramid manifest
        // write, and — with clear-scratch-on-exit — the whole-cache clear.
        // Both used to park behind a rebuild, which is why the window
        // could not be closed while the plots were building.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(dummy(
                i * S,
                512,
                vec![(i % 251) as u8, 0, 0, 0, 0, 0, 0, 0],
            ));
        }
        let db = dbc_two_areas();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(tmp.path());
        // Something already built, so the manifest write has work to do.
        let _ = cache.slice(None, 512, false, "Y", f64::MIN, f64::MAX, 0, &store, dbs);
        let v = validity("cap", "dbcs", 0);
        let store_len = 3 * CATCH_UP_CHUNK_FRAMES;

        let finished = while_a_cold_rebuild_runs(&cache, dbs, store_len, || {
            assert!(cache.needs_persist());
            assert!(cache.persist(&v, Harden::All));
            cache.clear();
        });
        assert!(finished, "the exit path waited for the rebuild");

        // The clear won: the abandoned rebuild appended nothing to a set
        // that no longer exists, and left no file behind it.
        let caches = cache.caches.lock().unwrap();
        assert!(caches.by_key.is_empty());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    // ---- Persistence across restore ---------------------------------

    /// The validity key a persisted pyramid set is reused against, with
    /// each component nameable so a test can change exactly one.
    fn validity(capture: &str, dbcs: &str, low_water: u64) -> PyramidValidity {
        PyramidValidity {
            capture_id: capture.to_string(),
            dbcs: dbcs.to_string(),
            low_water,
        }
    }

    /// A store of `n` frames that **no** DBC decodes, so anything a serve
    /// returns over it came from a persisted pyramid rather than a rebuild.
    fn undecodable_store(n: usize) -> TraceStore {
        let store = TraceStore::new();
        for i in 0..n {
            store.append(dummy(i as u64 * S, 999, vec![0; 8]));
        }
        store
    }

    /// Build a 200-point pyramid under `root` and persist it against
    /// `validity`, returning the store length it was consistent with.
    fn build_and_persist(root: &Path, v: &PyramidValidity) -> usize {
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let cache = SignalCacheStore::new(root);
        let built = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(built.len(), 200);
        cache.persist(v, Harden::All);
        store.len()
    }

    #[test]
    fn a_shutdown_persist_leaves_the_levels_owing_the_device_nothing() {
        // ADR 0047's shutdown rule: a manifest is only ever written over
        // pages the disk has already been given, and the shutdown flavour
        // leaves nothing behind at all.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let root = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(root.path());
        let v = validity("capture-a", "dbc-a", 0);

        let _ = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert!(cache.unflushed() > 0, "a fresh pyramid owes its pages");
        assert!(cache.persist(&v, Harden::All));
        assert_eq!(
            cache.unflushed(),
            0,
            "the manifest went out over flushed pages"
        );

        // And with nothing appended since, the next one has nothing to do.
        cache.evict_below(f64::NEG_INFINITY); // marks dirty, trims nothing
        assert_eq!(cache.unflushed(), 0);
        assert!(cache.persist(&v, Harden::All));
        assert_eq!(cache.unflushed(), 0);
    }

    #[test]
    fn the_cadence_persist_never_waits_on_the_hot_tail() {
        // The periodic caller's whole job is to shrink what a quit owes
        // without paying for pages that are about to be dirtied again. A
        // live capture appends into one segment per level for hours, so a
        // cadence that flushed it would wait on the same files every tick
        // and *still* leave them dirty. It writes the manifest either way
        // — the manifest describes what has been flushed, and the tail's
        // own entries are re-read from the raw frames if a crash loses
        // them.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let root = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(root.path());
        let v = validity("capture-a", "dbc-a", 0);

        let _ = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        let owed = cache.unflushed();
        assert!(owed > 0);
        assert!(
            cache.persist(&v, Harden::live_budget()),
            "the manifest is written"
        );
        let after = cache.unflushed();
        assert!(after > 0, "the hot tail is deliberately still owed");
        assert!(after < owed, "…but the sealed segments were taken");

        // Running it again with nothing sealed since is free and changes
        // nothing — the property the live regime depends on.
        cache.evict_below(f64::NEG_INFINITY); // marks dirty, trims nothing
        assert!(cache.persist(&v, Harden::live_budget()));
        assert_eq!(cache.unflushed(), after);

        // The quit behind it still takes everything.
        cache.evict_below(f64::NEG_INFINITY);
        assert!(cache.persist(&v, Harden::All));
        assert_eq!(cache.unflushed(), 0);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn a_matching_pyramid_comes_back_instead_of_rebuilding() {
        // The whole point of the feature: a relaunch over a restored capture
        // serves the signal from the pyramid on disk. Proved by restoring
        // against a store whose frames *cannot* decode — a rebuild would
        // return nothing, so every point served came off disk.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);

        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&v, len), 1, "one signal's pyramid");
        let store = undecodable_store(len);
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let served = reopened.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(served.len(), 200, "served from the persisted pyramid");
        assert_eq!(served[7].value, 7.0);
        // The all-time extent came back too — it is decoded state, not a
        // window, so re-deriving it would mean re-decoding.
        assert_eq!(
            reopened.min_max(None, 256, false, "X", &store, dbs),
            Some((0.0, 49.0))
        );
    }

    #[test]
    fn every_kind_of_key_mismatch_rebuilds() {
        // The validity discipline: a persisted pyramid is reused only when
        // the capture, the DBC set, and the eviction low-water all match.
        // Change any one and the set is discarded, files and all.
        let good = validity("capture-a", "dbc-a", 0);
        for changed in [
            validity("capture-b", "dbc-a", 0),
            validity("capture-a", "dbc-b", 0),
            validity("capture-a", "dbc-a", 64),
        ] {
            let root = TempDir::new().unwrap();
            let len = build_and_persist(root.path(), &good);
            let reopened = SignalCacheStore::new(root.path());
            assert_eq!(
                reopened.restore(&changed, len),
                0,
                "{changed:?} must not reuse"
            );
            assert_eq!(
                std::fs::read_dir(root.path()).unwrap().flatten().count(),
                0,
                "a rejected set is wiped, not left to accumulate: {changed:?}",
            );
            // And the next serve rebuilds from the raw frames as it always did.
            let store = TraceStore::new();
            for i in 0..200u64 {
                store.append(val_frame(i * S, (i % 50) as u16));
            }
            let db = load_dbc();
            let dbs: &[&Database] = &[&db];
            let rebuilt = reopened.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
            assert_eq!(rebuilt.len(), 200);
        }
    }

    #[test]
    fn a_pyramid_ahead_of_the_restored_capture_rebuilds() {
        // A crash between the raw store's last flush and the pyramid's can
        // leave a pyramid that has already read past the frames the store
        // comes back with. Reusing it would skip the frames in between
        // forever, so the set is rejected.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);
        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&v, len - 1), 0);
    }

    // ---- Announcing a cold rebuild ----------------------------------

    #[test]
    fn a_reused_pyramid_set_announces_no_cold_rebuild() {
        // The fast path is silent: the samples came back off disk, so
        // there is nothing for the user to be told about.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);
        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&v, len), 1);
        assert!(!reopened.rebuilding(len));
    }

    #[test]
    fn a_restore_with_nothing_persisted_announces_no_cold_rebuild() {
        // A capture whose signals were never plotted has no pyramid to
        // discard. The first plot over it builds one, which is the
        // ordinary first-use cost — not a rebuild of something lost.
        let root = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(root.path());
        assert_eq!(cache.restore(&validity("capture-a", "dbc-a", 0), 200), 0);
        assert!(!cache.rebuilding(200));
    }

    #[test]
    fn a_discarded_pyramid_set_announces_a_cold_rebuild_until_it_catches_up() {
        // The announcement this exists for: the persisted set did not
        // answer to the validity key, so every plotted signal is decoded
        // again from frame zero. It is on from the moment the set is
        // discarded — before any serve has run — and off once the caches
        // it left empty have reached the capture's tip.
        let root = TempDir::new().unwrap();
        let len = build_and_persist(root.path(), &validity("capture-a", "dbc-a", 0));
        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&validity("capture-b", "dbc-a", 0), len), 0);
        assert!(
            reopened.rebuilding(len),
            "a discarded set announces itself before anything serves"
        );

        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let rebuilt = reopened.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(rebuilt.len(), 200, "the rebuild ran");
        assert!(
            !reopened.rebuilding(store.len()),
            "the announcement ends when the caches have caught up"
        );
    }

    #[test]
    fn discarding_the_session_ends_the_cold_rebuild_announcement() {
        // The offramp: dropping the restored capture stops the rebuild
        // being announced, because there is no longer anything to
        // rebuild. `clear` is the same call a fresh open makes.
        let root = TempDir::new().unwrap();
        let len = build_and_persist(root.path(), &validity("capture-a", "dbc-a", 0));
        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&validity("capture-b", "dbc-a", 0), len), 0);
        assert!(reopened.rebuilding(len));

        reopened.clear();
        assert!(!reopened.rebuilding(len));
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().flatten().count(),
            0,
            "and nothing is left half-deleted under the root",
        );
    }

    #[test]
    fn a_dbc_change_before_the_restore_leaves_the_staged_pyramids_alone() {
        // Boot order: the project's DBCs load (and invalidate the derived
        // decode state) *before* the capture is restored. The pyramids left
        // on disk are not decode state yet — they are a candidate whose own
        // recorded DBC set is about to be checked — so the DBC-change
        // invalidation must not pre-empt that check.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);

        let reopened = SignalCacheStore::new(root.path());
        reopened.invalidate_dbcs();
        assert_eq!(reopened.restore(&v, len), 1, "the staged set survived");

        // Once the set is live, a DBC change drops it exactly as before.
        reopened.invalidate_dbcs();
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().flatten().count(),
            0,
            "an adopted pyramid is wiped by a DBC change",
        );
    }

    #[test]
    fn a_staged_manifest_is_never_overwritten_before_it_is_judged() {
        // The manifest is the only thing that says what the files under the
        // root are, so a session that starts building its own pyramids
        // before the restore has run must not write over the candidate it
        // has not looked at yet.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);

        let reopened = SignalCacheStore::new(root.path());
        // Build something of its own — a different signal over a different
        // store, as a plot mounting before the restore lands would.
        let store = TraceStore::new();
        for i in 0..50u64 {
            store.append(val_frame(i * S, 7));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let _ = reopened.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert!(
            !reopened.persist(&validity("capture-b", "dbc-a", 0), Harden::All),
            "nothing is written while a candidate is unjudged",
        );
        // …so the candidate is still there to be judged.
        assert_eq!(reopened.restore(&v, len), 1);
    }

    #[test]
    fn clearing_the_trace_drops_the_staged_pyramids() {
        // Clear / start-a-new-capture discards the prior trace, so the
        // pyramids over it go with it — before any restore can adopt them.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);
        let reopened = SignalCacheStore::new(root.path());
        reopened.clear();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().flatten().count(), 0);
        assert_eq!(reopened.restore(&v, len), 0);
    }

    #[test]
    fn pyramid_files_without_a_manifest_are_wiped_on_open() {
        // A prior session that never got to persist leaves level files that
        // nothing can vouch for. They are not reusable and must not be
        // written into by a fresh cache, so opening the root wipes them.
        let root = TempDir::new().unwrap();
        std::fs::write(
            root.path().join("sig.s00000100.dead.l0.0000"),
            vec![0u8; 64],
        )
        .unwrap();
        let _cache = SignalCacheStore::new(root.path());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().flatten().count(), 0);
    }

    #[test]
    fn a_persisted_pyramid_keeps_growing_after_it_is_restored() {
        // Restoring must leave the cache in the state a live one would be
        // in: the decode cursor sits at the persisted tip, so frames that
        // arrive after the restore are caught up incrementally.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let len = build_and_persist(root.path(), &v);

        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&v, len), 1);
        // A store standing in for the reloaded capture: the restored frames
        // don't decode (so nothing is re-read), the new tail does.
        let store = undecodable_store(len);
        for i in 200..260u64 {
            store.append(val_frame(i * S, 100));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let all = reopened.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        assert_eq!(all.len(), 260, "200 persisted + 60 newly decoded");
        assert_eq!(all.last().map(|p| p.value), Some(100.0));
    }

    #[test]
    fn an_evicted_pyramid_survives_a_round_trip_through_disk() {
        // Front-trimmed levels have lost their leading segment files; the
        // persisted low-water is what lets them map back.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let store = TraceStore::new();
        for i in 0..2000u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let cache = SignalCacheStore::new(root.path());
        let _ = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs);
        cache.evict_below(1000.0);
        cache.persist(&v, Harden::All);

        let reopened = SignalCacheStore::new(root.path());
        assert_eq!(reopened.restore(&v, store.len()), 1);
        let cold = undecodable_store(store.len());
        let served = reopened.slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &cold, dbs);
        assert_eq!(served.len(), 1000, "only the live tail came back");
        assert!(served.iter().all(|p| p.t_seconds >= 1000.0));
    }

    // ---- File-backed signals ----------------------------------------
    //
    // A file-backed series (CONTEXT: "File-backed signal") is imported
    // from a capture file as an already-decoded value series. It is a
    // cache entry like any other — same pyramid, same paged serve, same
    // persistence — and differs only in **provenance**: it fills once
    // from the file instead of incrementally from frames, and nothing a
    // DBC does bears on it.

    fn file_info(group: u32, name: &str) -> FileSignalInfo {
        FileSignalInfo {
            source_path: "capture.mf4".into(),
            group,
            group_name: Some("Analog".into()),
            name: name.to_string(),
            unit: "rpm".into(),
        }
    }

    /// A query naming a file-backed signal, the way a plot or a grid row
    /// addresses one.
    fn file_query(group: u32, signal_name: &str) -> CacheQuery<'_> {
        CacheQuery {
            bus_id: None,
            message_id: group,
            extended: false,
            signal_name,
            file_backed: true,
        }
    }

    /// `n` points of a slowly rising series, one per second from t = 0.
    fn ramp(n: u64) -> Vec<(u64, f64)> {
        (0..n)
            .map(|i| (i * S, f64::from((i % 50) as u16)))
            .collect()
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn a_file_backed_series_serves_exactly_like_a_decoded_one() {
        // The ruling's core claim: provenance decides the *fill*, and
        // nothing after it. So a file-backed series holding the same
        // points a DBC-backed one decodes must serve identically —
        // through the same paged, decimated path, at every budget.
        let store = TraceStore::new();
        for i in 0..1_000u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];

        let decoded_dir = TempDir::new().unwrap();
        let decoded = SignalCacheStore::new_unbounded(decoded_dir.path());
        let file_dir = TempDir::new().unwrap();
        let from_file = SignalCacheStore::new_unbounded(file_dir.path());
        from_file.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(1_000));

        for max_points in [0usize, 16, 200] {
            let a = decoded.slice(
                None,
                256,
                false,
                "X",
                f64::MIN,
                f64::MAX,
                max_points,
                &store,
                dbs,
            );
            let b = from_file
                .slice_many(
                    &[file_query(1, "EngineSpeed")],
                    f64::MIN,
                    f64::MAX,
                    max_points,
                    Reduction::MinMax,
                    &store,
                    dbs,
                )
                .series
                .pop()
                .unwrap();
            assert_eq!(
                a.iter().map(|p| (p.t_seconds, p.value)).collect::<Vec<_>>(),
                b.iter().map(|p| (p.t_seconds, p.value)).collect::<Vec<_>>(),
                "max_points = {max_points}",
            );
        }
        // Including the scalar the plot's auto-normalisation reads.
        assert_eq!(
            from_file.min_max_many(&[file_query(1, "EngineSpeed")], &store, dbs),
            vec![Some((0.0, 49.0))],
        );
    }

    #[test]
    fn a_file_backed_serve_is_complete_the_moment_it_exists() {
        // A file-backed fill is a one-time read that *completed*: there
        // is no prefix for the caller to come back for, however far the
        // capture's own decode cursor is from the tip. A budget of zero
        // (one chunk per serve) would leave any DBC-backed series
        // partial over this capture.
        let store = TraceStore::new();
        for i in 0..(CATCH_UP_CHUNK_FRAMES as u64 * 3) {
            store.append(val_frame(i * S, 1));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_chunk_at_a_time(tmp.path());
        cache.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(20));

        let served = cache.slice_many(
            &[file_query(1, "EngineSpeed")],
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &store,
            dbs,
        );
        assert_eq!(served.series[0].len(), 20);
        assert!(served.complete, "a filled file-backed series is settled");
        // The DBC-backed sibling over the same capture is not.
        assert!(
            !cache
                .slice_many(
                    &[query_on(256, "X")],
                    f64::MIN,
                    f64::MAX,
                    0,
                    Reduction::MinMax,
                    &store,
                    dbs
                )
                .complete
        );
    }

    #[test]
    fn a_file_backed_query_for_a_signal_this_capture_lacks_creates_nothing() {
        // Nothing decodes a file-backed signal, so a query for one the
        // import never filled must not mint an empty series — it would
        // sit in the store, and in the manifest, claiming the capture has
        // a signal it does not.
        let store = TraceStore::new();
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let served = cache.slice_many(
            &[file_query(7, "Absent")],
            0.0,
            1.0,
            0,
            Reduction::MinMax,
            &store,
            dbs,
        );
        assert!(served.series[0].is_empty());
        assert!(served.complete);
        assert!(cache.caches.lock().unwrap().by_key.is_empty());
        assert!(cache.file_signals().is_empty());
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn file_signals_reports_what_the_import_filled() {
        // The catalog, the signal grid and the BLF-save warning all read
        // this one listing, so it carries the statistics rather than
        // leaving each surface to re-derive them.
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        cache.fill_file_backed(&file_info(2, "CoolantTemp"), &ramp(20));
        cache.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(5));
        let listed = cache.file_signals();
        assert_eq!(
            listed
                .iter()
                .map(|e| (e.info.group, e.info.name.as_str(), e.sample_count))
                .collect::<Vec<_>>(),
            vec![(1, "EngineSpeed", 5), (2, "CoolantTemp", 20)],
            "ordered by (group, name)",
        );
        assert_eq!(listed[0].info.unit, "rpm");
        assert_eq!(listed[0].info.group_label(), "Analog");
        let latest = listed[0].latest.as_ref().unwrap();
        assert_eq!((latest.t_seconds, latest.value), (4.0, 4.0));
        // Five samples one second apart: four intervals over four seconds.
        assert_eq!(listed[0].rate, Some(1.0));
        // An unnamed group falls back to its index.
        let unnamed = FileSignalInfo {
            group_name: None,
            ..file_info(9, "Solo")
        };
        assert_eq!(unnamed.group_label(), "group 9");
    }

    #[test]
    fn a_dbc_change_does_not_touch_a_file_backed_series() {
        // "DBC reload never touches them." No DBC produced these samples,
        // so no DBC set can invalidate them — the series stays live and
        // its level files stay on disk, while its DBC-backed neighbour is
        // dropped as it always was.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        assert_eq!(
            cache
                .slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs)
                .len(),
            200
        );
        cache.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(20));

        cache.invalidate_dbcs();

        assert_eq!(
            cache
                .file_signals()
                .iter()
                .map(|e| e.sample_count)
                .collect::<Vec<_>>(),
            vec![20],
            "the file-backed series survived the DBC change",
        );
        // Served from what is still in the store — over a capture nothing
        // decodes, so a wiped-and-rebuilt series would come back empty.
        let cold = undecodable_store(store.len());
        let served = cache.slice_many(
            &[file_query(1, "EngineSpeed")],
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &cold,
            dbs,
        );
        assert_eq!(served.series[0].len(), 20);
        // And exactly one series is live: the DBC-backed one went.
        assert_eq!(cache.caches.lock().unwrap().by_key.len(), 1);
    }

    #[test]
    fn eviction_leaves_a_file_backed_series_whole() {
        // The raw store's windowed-ring mark is a fact about frames. A
        // file-backed series is not decoded from them and nothing could
        // re-derive it, so trimming it to that mark would destroy
        // imported data outright.
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        cache.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(100));
        cache.evict_below(50.0);
        assert_eq!(cache.file_signals()[0].sample_count, 100);
    }

    #[test]
    fn a_file_backed_series_comes_back_after_a_dbc_change_across_sessions() {
        // The same rule across a relaunch. The DBC-backed half of a
        // persisted set is only reusable when the whole validity key
        // matches; the file-backed half depends on nothing but the
        // capture's identity, so a different DBC set brings it back
        // anyway and rebuilds only what was decoded.
        let root = TempDir::new().unwrap();
        let v = validity("capture-a", "dbc-a", 0);
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        {
            let cache = SignalCacheStore::new(root.path());
            assert_eq!(
                cache
                    .slice(None, 256, false, "X", f64::MIN, f64::MAX, 0, &store, dbs)
                    .len(),
                200
            );
            cache.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(20));
            assert!(cache.persist(&v, Harden::All));
        }

        let reopened = SignalCacheStore::new(root.path());
        let changed = validity("capture-a", "dbc-b", 0);
        assert_eq!(
            reopened.restore(&changed, store.len()),
            1,
            "only the file-backed series is reusable",
        );
        let listed = reopened.file_signals();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].sample_count, 20);
        assert_eq!(listed[0].info.unit, "rpm", "its metadata persisted too");
        // Served without re-reading the source file: the samples are the
        // ones the level-0 file under the spill dir holds.
        let cold = undecodable_store(store.len());
        let served = reopened.slice_many(
            &[file_query(1, "EngineSpeed")],
            f64::MIN,
            f64::MAX,
            0,
            Reduction::MinMax,
            &cold,
            dbs,
        );
        assert_eq!(served.series[0].len(), 20);
        // A different capture takes both halves with it.
        {
            let cache = SignalCacheStore::new(root.path());
            assert_eq!(cache.restore(&validity("capture-b", "dbc-a", 0), 200), 0);
            assert!(cache.file_signals().is_empty());
        }
    }

    #[test]
    fn clearing_the_capture_drops_the_file_backed_series_too() {
        // A new capture is a new set of file-backed signals — the ones
        // the old capture's file carried describe nothing any more.
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        cache.fill_file_backed(&file_info(1, "EngineSpeed"), &ramp(20));
        cache.clear();
        assert!(cache.file_signals().is_empty());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    // ---- First-use rebuild benchmark --------------------------------
    //
    // Not part of the default suite (`#[ignore]`d; it writes a
    // multi-million-frame capture into a temp dir and runs for tens of
    // seconds). It measures what the first plot over a *restored* capture
    // pays (ADR 0002 DS-7): the catch-up's wall clock, and the process
    // working-set high-water mark across it, sampled while it runs. Run
    // with:
    //
    //   cargo test -p cannet-gui --release bench_first_use_rebuild \
    //       -- --ignored --nocapture
    //
    // The working set counts the store's mapped pages the scan touches as
    // well as its heap, so read the delta as "everything the rebuild made
    // resident", not as heap alone. The number that matters is how it
    // scales: the mapped share grows with the capture, the materialized
    // share must not.
    //
    // It then measures the same first use again over a *persisted* pyramid
    // (ADR 0047) — the manifest written, the cache store reopened on the
    // same root as a relaunch would, the set restored — so the two numbers
    // printed side by side are the before and after of a relaunch.
    //
    // `CANNET_BENCH_FRAMES` sets the capture size and
    // `CANNET_BENCH_SIGNALS` how many distinct signals a view resolves over
    // it. One signal is the dense-single-id worst case the ingest profile
    // named; a plot view over a real project resolves dozens, and the
    // rebuild is paid per signal while the restore is one directory of
    // `mmap` calls — so the two dimensions do not scale together and both
    // are worth running.
    //
    // `CANNET_BENCH_SIGNALS_PER_MSG` (default 1, max 32 — 64 FD bytes at
    // 16 bits a signal) spreads those signals over fewer, wider messages,
    // which is the shape a cell-style message has. It is the dimension the
    // shared catch-up acts on, so the rebuild is measured **twice** over
    // the same capture: once catching each signal up on its own (a batch
    // of one, which is what the catch-up did before the sharing) and once
    // catching each message's signals up together, as a plot fetch does.
    // The shared arm runs first, off cold pages, so the ratio between them
    // is a lower bound.

    /// What one flush cadence tick costs a **live** capture — the regime
    /// the ADR-0031 gate runs in, and the one the rebuild benchmark
    /// above says nothing about. A live session's pyramids advance by a
    /// tick's worth of points, so every level's *hot tail* segment is
    /// re-dirtied and re-flushed while nothing else moves; the question
    /// is what waiting on the device for those files costs, per tick,
    /// on the thread the periodic flusher runs on.
    ///
    /// ```sh
    /// CANNET_BENCH_SIGNALS=16 CANNET_BENCH_TICKS=20 \
    ///   cargo test -p cannet-gui --release bench_live_cadence_flush \
    ///   -- --ignored --nocapture
    /// ```
    ///
    /// Defaults model the gate: 1631 frames/s spread over 173 bus ids of
    /// which 16 are plotted, a 2 s tick, and a capture already caught up.
    /// The id count matters as much as the plotted count — it is what
    /// decides how fast a plotted signal's own chain grows, and so how
    /// often a segment seals.
    #[test]
    #[ignore = "live flush-cadence benchmark; run with --ignored --nocapture"]
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    fn bench_live_cadence_flush() {
        fn env_usize(name: &str, default: usize) -> usize {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        }

        let signals = env_usize("CANNET_BENCH_SIGNALS", 16);
        let ids = env_usize("CANNET_BENCH_IDS", 173).max(signals);
        let ticks = env_usize("CANNET_BENCH_TICKS", 20);
        let per_tick = env_usize("CANNET_BENCH_FRAMES_PER_TICK", 3262);

        let dbc: String = std::iter::once("VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_:\n".to_string())
            .chain((0..ids).map(|m| {
                let id = 256 + m;
                format!(
                    "\nBO_ {id} Msg{id}: 2 Vector__XXX\n SG_ X0 : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n"
                )
            }))
            .collect();
        let db = Database::parse(&dbc).unwrap();
        let dbs: &[&Database] = &[&db];
        let queries: Vec<CacheQuery<'_>> = (0..signals)
            .map(|n| CacheQuery {
                bus_id: None,
                message_id: 256 + n as u32,
                extended: false,
                signal_name: "X0",
                file_backed: false,
            })
            .collect();

        let scratch = TempDir::new().unwrap();
        let raw_dir = scratch.path().join("raw");
        std::fs::create_dir_all(&raw_dir).unwrap();
        let store = TraceStore::new_disk(&raw_dir).unwrap();
        let pyramids = TempDir::new().unwrap();
        let cache = SignalCacheStore::new_unbounded(pyramids.path());
        let validity = PyramidValidity {
            capture_id: "bench-capture".into(),
            dbcs: "bench-dbcs".into(),
            low_water: 0,
        };

        let mut appended = 0usize;
        let mut per_tick_ms: Vec<f64> = Vec::with_capacity(ticks);
        for _ in 0..ticks {
            // A tick's arrivals, round-robined over the plotted messages
            // exactly as a multi-id bus delivers them.
            for _ in 0..per_tick {
                // Every id on the bus arrives; only the plotted ones
                // below build a pyramid, which is what makes a plotted
                // signal's chain grow `ids` times slower than the bus.
                let m = appended % ids;
                let v = (appended % 4096) as u16;
                let mut f = val_frame(appended as u64 * 1_000_000, v);
                f.id = 256 + m as u32;
                f.payload = cannet_core::CanFramePayload::Fd {
                    data: v.to_le_bytes().to_vec(),
                    flags: cannet_core::CanFdFlags::default(),
                };
                store.append(f);
                appended += 1;
            }
            // The plots serve, which is what advances the pyramids.
            let _ = cache.slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                2000,
                Reduction::MinMax,
                &store,
                dbs,
            );
            // …and then the flusher's tick.
            let at = std::time::Instant::now();
            assert!(cache.needs_persist(), "a served pyramid is dirty");
            assert!(cache.persist(&validity, Harden::live_budget()));
            per_tick_ms.push(at.elapsed().as_secs_f64() * 1000.0);
        }

        let total: f64 = per_tick_ms.iter().sum();
        let worst = per_tick_ms.iter().copied().fold(0.0_f64, f64::max);
        let mut sorted = per_tick_ms.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "[bench] live cadence, {signals} of {ids} id(s) plotted, {ticks} tick(s) of \
             {per_tick} frames: \
             per-tick persist mean {:.1} ms, median {:.1} ms, worst {worst:.1} ms, \
             total {total:.0} ms over {appended} frames",
            total / ticks as f64,
            sorted[ticks / 2],
        );
        // The exit flush that follows such a session.
        cache.evict_below(f64::NEG_INFINITY); // marks dirty, trims nothing
        let at = std::time::Instant::now();
        assert!(cache.persist(&validity, Harden::All));
        println!(
            "[bench] the quit after it: {:.1} ms",
            at.elapsed().as_secs_f64() * 1000.0,
        );
    }

    #[test]
    #[ignore = "first-use rebuild benchmark; run with --ignored --nocapture"]
    #[allow(clippy::too_many_lines)]
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    fn bench_first_use_rebuild() {
        use std::fmt::Write as _;
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;

        fn rss() -> u64 {
            use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
            let pid = Pid::from_u32(std::process::id());
            let mut sys = System::new();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[pid]),
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            sys.process(pid).map_or(0, sysinfo::Process::memory)
        }

        fn env_usize(name: &str, default: usize) -> usize {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        }

        let frames = env_usize("CANNET_BENCH_FRAMES", 4_000_000);
        let signals = env_usize("CANNET_BENCH_SIGNALS", 1);
        let per_message = env_usize("CANNET_BENCH_SIGNALS_PER_MSG", 1).clamp(1, 32);
        let messages = signals.div_ceil(per_message);
        // How many signals each message carries: `per_message` except in
        // the last one, which holds the remainder.
        let width = |m: usize| (signals - m * per_message).min(per_message);
        // Ids from 256 up, one per message, each carrying `width(m)`
        // 16-bit signals side by side in an FD payload. The capture
        // round-robins the messages, so every signal is equally dense and
        // the whole capture decodes.
        let dbc: String = std::iter::once("VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_:\n".to_string())
            .chain((0..messages).map(|m| {
                let id = 256 + m;
                let mut msg = format!("\nBO_ {id} Msg{id}: {} Vector__XXX\n", 2 * width(m));
                for s in 0..width(m) {
                    let start = s * 16;
                    writeln!(
                        msg,
                        " SG_ X{s} : {start}|16@1+ (1,0) [0|0] \"\" Vector__XXX"
                    )
                    .unwrap();
                }
                msg
            }))
            .collect();
        let db = Database::parse(&dbc).unwrap();
        let dbs: &[&Database] = &[&db];
        // The view's signals, in the order a plot fetch would name them.
        let names: Vec<String> = (0..per_message).map(|s| format!("X{s}")).collect();
        let queries: Vec<CacheQuery<'_>> = (0..signals)
            .map(|n| CacheQuery {
                bus_id: None,
                message_id: 256 + (n / per_message) as u32,
                extended: false,
                signal_name: &names[n % per_message],
                file_backed: false,
            })
            .collect();

        let scratch = TempDir::new().unwrap();
        let raw_dir = scratch.path().join("raw");
        std::fs::create_dir_all(&raw_dir).unwrap();
        let store = TraceStore::new_disk(&raw_dir).unwrap();
        let wrote = std::time::Instant::now();
        for i in 0..frames {
            let m = i % messages;
            let v = (i % 4096) as u16;
            let mut data = Vec::with_capacity(2 * width(m));
            for s in 0..width(m) {
                data.extend_from_slice(&v.wrapping_add(s as u16).to_le_bytes());
            }
            let mut f = val_frame(i as u64 * 1_000_000, v);
            f.id = 256 + m as u32;
            f.payload = cannet_core::CanFramePayload::Fd {
                data,
                flags: cannet_core::CanFdFlags::default(),
            };
            store.append(f);
        }
        println!(
            "[bench] wrote {frames} frames over {signals} signal(s) in {messages} message(s) \
             ({per_message} signal(s) each) in {:.1} s",
            wrote.elapsed().as_secs_f64(),
        );

        let pyramids = TempDir::new().unwrap();
        // Unbounded serves throughout: the arms measure how long a whole
        // rebuild takes, and the serve budget only decides how many calls
        // that is split across.
        let cache = SignalCacheStore::new_unbounded(pyramids.path());

        // Sample the working set while the rebuild runs — the spike the
        // chunked scan exists to remove is transient, so an after-the-fact
        // reading would miss it.
        let base = rss();
        let peak = Arc::new(AtomicU64::new(base));
        let stop = Arc::new(AtomicBool::new(false));
        let sampler = {
            let (peak, stop) = (Arc::clone(&peak), Arc::clone(&stop));
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    peak.fetch_max(rss(), Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            })
        };

        let started = std::time::Instant::now();
        let shared = cache
            .slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                2000,
                Reduction::MinMax,
                &store,
                dbs,
            )
            .series;
        let secs = started.elapsed().as_secs_f64();
        let pts: usize = shared.iter().map(Vec::len).sum();
        stop.store(true, Ordering::Relaxed);
        sampler.join().unwrap();

        let peak = peak.load(Ordering::Relaxed).max(rss());
        let delta = peak.saturating_sub(base);
        println!(
            "[bench] first-use rebuild, shared pass: {signals} signal(s) over {frames} frames \
             in {:.2} s ({:.3} us/frame/signal), working set {:.0} -> {:.0} MB \
             (+{:.0} MB = {:.0} B/frame), {pts} points served",
            secs,
            secs * 1e6 / (frames * signals) as f64,
            base as f64 / 1e6,
            peak as f64 / 1e6,
            delta as f64 / 1e6,
            delta as f64 / frames as f64,
        );

        // --- the same rebuild, with the flush cadence running ---
        //
        // What a session actually looks like: the periodic flusher takes
        // the level pages every `trace_flush_interval_ms` while the
        // rebuild appends them (ADR 0047), so the quit that follows is
        // left owing one tick's residue. Measures both halves — what the
        // cadence costs the rebuild, and what the exit flush costs after
        // it — against the arm above, which is the same rebuild with no
        // cadence at all.
        let paced_root = TempDir::new().unwrap();
        let paced = Arc::new(SignalCacheStore::new_unbounded(paced_root.path()));
        let paced_v = PyramidValidity {
            capture_id: "bench-capture".into(),
            dbcs: "bench-dbcs".into(),
            low_water: 0,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let flusher = {
            let (cache, v, stop) = (Arc::clone(&paced), paced_v.clone(), Arc::clone(&stop));
            std::thread::spawn(move || {
                let (mut ticks, mut spent) = (0u32, 0f64);
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let at = std::time::Instant::now();
                    // The store is not growing during a rebuild, so this
                    // is the budget the flusher would actually use here.
                    if cache.needs_persist() && cache.persist(&v, Harden::idle_budget()) {
                        spent += at.elapsed().as_secs_f64();
                        ticks += 1;
                    }
                }
                (ticks, spent)
            })
        };
        let paced_at = std::time::Instant::now();
        let paced_series = paced
            .slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                2000,
                Reduction::MinMax,
                &store,
                dbs,
            )
            .series;
        let paced_secs = paced_at.elapsed().as_secs_f64();
        stop.store(true, Ordering::Relaxed);
        let (ticks, tick_secs) = flusher.join().unwrap();
        assert_eq!(paced_series, shared, "the same series, cadence or not");
        println!(
            "[bench] the same rebuild under a 2 s flush cadence: {paced_secs:.2} s \
             ({:+.0} % against the uncadenced arm); {ticks} tick(s) spent {tick_secs:.2} s \
             flushing",
            (paced_secs / secs.max(1e-9) - 1.0) * 100.0,
        );

        // What the cadence does about the backlog a rebuild leaves, if
        // the user keeps working. This is the ruling's own mechanism,
        // measured — the shutdown flush shrinks toward the hot tails as
        // the cadence takes the sealed segments. The quit is timed *only*
        // at the end, because a shutdown flush clears the very state the
        // drain is supposed to be shrinking; what a quit costs with no
        // drain at all is the cold `persist` the restore arm below
        // reports.
        let drain_ticks = env_usize("CANNET_BENCH_DRAIN_TICKS", 40);
        let drain_at = std::time::Instant::now();
        for _ in 0..drain_ticks {
            paced.evict_below(f64::NEG_INFINITY); // marks dirty, trims nothing
            paced.persist(&paced_v, Harden::idle_budget());
        }
        let drain_secs = drain_at.elapsed().as_secs_f64();
        paced.evict_below(f64::NEG_INFINITY);
        let drained_exit_at = std::time::Instant::now();
        assert!(paced.persist(&paced_v, Harden::All));
        let drained_exit_secs = drained_exit_at.elapsed().as_secs_f64();
        drop(paced);
        println!(
            "[bench] after {drain_ticks} idle cadence tick(s) — {drain_secs:.2} s of \
             flushing spread over {:.0} s of wall clock — the quit costs \
             {drained_exit_secs:.3} s",
            drain_ticks as f64 * 2.0,
        );

        // --- the same rebuild, one signal at a time ---
        //
        // A batch of one per signal: the catch-up before the sharing,
        // re-fetching and re-decoding each message's frames once per
        // signal riding it. Its own cold pyramid root, the same capture
        // (whose pages the shared arm has already warmed, so this arm is
        // if anything favoured).
        let alone_root = TempDir::new().unwrap();
        let alone = SignalCacheStore::new_unbounded(alone_root.path());
        let alone_at = std::time::Instant::now();
        let separate: Vec<Vec<SamplePoint>> = queries
            .iter()
            .map(|q| {
                alone.slice(
                    q.bus_id,
                    q.message_id,
                    q.extended,
                    q.signal_name,
                    f64::MIN,
                    f64::MAX,
                    2000,
                    &store,
                    dbs,
                )
            })
            .collect();
        let alone_secs = alone_at.elapsed().as_secs_f64();
        assert_eq!(separate, shared, "the same series, both ways");
        drop(alone);
        println!(
            "[bench] first-use rebuild, per signal: {:.2} s ({:.3} us/frame/signal) — \
             the shared pass is {:.1}x it at {per_message} signal(s) per message",
            alone_secs,
            alone_secs * 1e6 / (frames * signals) as f64,
            alone_secs / secs.max(1e-9),
        );

        // --- the same first use, over a persisted pyramid (ADR 0047) ---
        //
        // Persist what the rebuild just built, then reopen the cache store
        // on the same root exactly as a relaunch does, restore, and serve
        // the same window. The validity key is supplied here rather than
        // read from a scratch identity, because this bench drives the cache
        // store directly and not the host.
        let validity = PyramidValidity {
            capture_id: "bench-capture".into(),
            dbcs: "bench-dbcs".into(),
            low_water: 0,
        };
        let persist_at = std::time::Instant::now();
        assert!(
            cache.persist(&validity, Harden::All),
            "the manifest is written"
        );
        let persist_secs = persist_at.elapsed().as_secs_f64();
        // The exit-path write again, straight after the one above. The two
        // figures are the two ends of what a quit costs (ADR 0047): the
        // first is a whole freshly-built pyramid flushed in one go — the
        // cost with no cadence ever having run — and the second is the
        // same call with the residue already taken, which is what a quit
        // behind the periodic flusher actually pays.
        cache.evict_below(f64::NEG_INFINITY); // marks dirty, trims nothing
        let again_at = std::time::Instant::now();
        assert!(cache.persist(&validity, Harden::All));
        let again_secs = again_at.elapsed().as_secs_f64();
        drop(cache);

        let reopened = SignalCacheStore::new_unbounded(pyramids.path());
        let restore_at = std::time::Instant::now();
        let restored = reopened.restore(&validity, store.len());
        let restore_secs = restore_at.elapsed().as_secs_f64();
        assert_eq!(restored, signals, "every pyramid came back");
        let served_at = std::time::Instant::now();
        let back: usize = reopened
            .slice_many(
                &queries,
                f64::MIN,
                f64::MAX,
                2000,
                Reduction::MinMax,
                &store,
                dbs,
            )
            .series
            .iter()
            .map(Vec::len)
            .sum();
        let served_secs = served_at.elapsed().as_secs_f64();
        assert_eq!(back, pts, "the same windows, point for point");
        println!(
            "[bench] first use after restore: restore {:.3} s + serve {:.3} s = {:.3} s \
             ({:.1}x the rebuild's speed); persist {:.3} s cold then {:.3} s \
             with the residue already flushed; {back} points served",
            restore_secs,
            served_secs,
            restore_secs + served_secs,
            secs / (restore_secs + served_secs).max(1e-9),
            persist_secs,
            again_secs,
        );
    }
}
