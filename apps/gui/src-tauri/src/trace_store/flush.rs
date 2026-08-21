//! Session lifecycle and scratch persistence.
//!
//! [`TraceStore::start_session`] resets the whole model for a new
//! capture; [`TraceStore::flush`] / [`TraceStore::flush_async`] are the
//! durability points that make the disk-spill store and the facade's
//! derived overlay reloadable (ADR 0002 DS-2/DS-4/DS-7/DS-8); and
//! [`TraceStore::write_scratch_identity`] / [`TraceStore::try_reload`]
//! carry a prior on-disk session back only against the project that
//! produced it. The small JSON sidecars this module owns
//! ([`IDENTITY_FILE`], [`DERIVED_FILE`]) are written via the crash-safe
//! [`write_json`] temp-file+rename helper.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use cannet_core::{CanFdFlags, CanFramePayload, Direction};
use cannet_spill::{DiskRawStore, MemRawStore, RawStore};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::anchor::TsAnchorIndex;
use super::rate::{RateEstimate, RateTrack};
use super::scratch::dir_footprint;
use super::{FrameKey, Inner, PerKey, RawTraceFrame, TraceStore};

/// File in the scratch dir recording which project the on-disk session
/// belongs to (ADR 0002 DS-7). Written when a capture starts; read by
/// [`TraceStore::try_reload`] so a prior session reloads only against the
/// project that produced it. (The project *path* DS-7 mentions is
/// best-effort diagnostic only and is omitted here.)
const IDENTITY_FILE: &str = "identity.json";

/// File in the scratch dir holding the facade's RAM-only derived state —
/// the per-key newest index + count and the session-start anchor — so a
/// reopened session comes back with a working by-id view and filter
/// candidate resolution, not just the raw frames (ADR 0002 DS-7). Written
/// on flush; restored on reopen.
const DERIVED_FILE: &str = "derived.json";

/// Persisted scratch identity ([`IDENTITY_FILE`]).
#[derive(Serialize, Deserialize)]
struct ScratchIdentity {
    project_id: Uuid,
    /// Identity of the *capture* in the scratch, minted whenever one
    /// starts. The project id says which project the scratch belongs to;
    /// this says which of that project's captures it holds, so state
    /// derived from frame indices (the signal pyramids, ADR 0047) can prove
    /// it is looking at the capture it was derived from. Absent in a
    /// scratch written before captures were identified — read as "no
    /// identity", which reuses nothing.
    #[serde(default)]
    capture_id: Option<Uuid>,
}

/// `derived.json` mirror of a frame payload. `cannet-core`'s
/// [`CanFramePayload`] carries no serde derives (a foundational crate kept
/// dependency-free), so the host serialises this local shape for the
/// retention overlay and converts back on reopen.
#[derive(Serialize, Deserialize)]
enum PersistedPayload {
    Classic(Vec<u8>),
    Fd { data: Vec<u8>, brs: bool, esi: bool },
    Remote { dlc: u8 },
    Error,
}

impl From<&CanFramePayload> for PersistedPayload {
    fn from(p: &CanFramePayload) -> Self {
        match p {
            CanFramePayload::Classic(d) => Self::Classic(d.clone()),
            CanFramePayload::Fd { data, flags } => Self::Fd {
                data: data.clone(),
                brs: flags.bitrate_switch,
                esi: flags.error_state_indicator,
            },
            CanFramePayload::Remote { dlc } => Self::Remote { dlc: *dlc },
            CanFramePayload::Error => Self::Error,
        }
    }
}

impl From<PersistedPayload> for CanFramePayload {
    fn from(p: PersistedPayload) -> Self {
        match p {
            PersistedPayload::Classic(d) => Self::Classic(d),
            PersistedPayload::Fd { data, brs, esi } => Self::Fd {
                data,
                flags: CanFdFlags {
                    bitrate_switch: brs,
                    error_state_indicator: esi,
                },
            },
            PersistedPayload::Remote { dlc } => Self::Remote { dlc },
            PersistedPayload::Error => Self::Error,
        }
    }
}

/// One persisted derived-state row: a [`FrameKey`] flattened, its last-seen
/// frame index and session frame count, plus the newest frame itself (the
/// retention overlay — `timestamp_ns` / `tx` / `payload`), so a reopen across
/// an eviction still shows the row's last value.
///
/// `bus_id` is required, as it is on [`FrameKey`] — the store holds no
/// bus-less frame, so no key flattened from one names no bus. A
/// `derived.json` written before that rule carries `null` there and
/// fails to parse; [`read_json`] reports that as a clean miss, so such a
/// scratch reopens with its frames and an empty retention overlay.
#[derive(Serialize, Deserialize)]
struct DerivedEntry {
    bus_id: String,
    channel: u8,
    id: u32,
    extended: bool,
    last_index: u64,
    count: u64,
    timestamp_ns: u64,
    tx: bool,
    payload: PersistedPayload,
}

/// Persisted derived state ([`DERIVED_FILE`]): the session-start anchor
/// and one [`DerivedEntry`] per distinct key. Small (id-space-bounded),
/// rewritten whole on each flush.
#[derive(Serialize, Deserialize)]
struct DerivedState {
    session_start_ns: u64,
    entries: Vec<DerivedEntry>,
}

impl TraceStore {
    /// Begin a new session: empty the buffer **and** raise the
    /// session-start threshold to `session_start_ns`. Subsequent
    /// [`Self::append`] calls drop any frame whose timestamp predates
    /// `session_start_ns` — the pipeline-drain guard for in-flight
    /// frames at the moment of clear / connect.
    ///
    /// Live capture passes wall-clock now; an import passes the earliest
    /// timestamp it has seen so far, and corrects downwards through
    /// [`Self::lower_session_start`] as it meets earlier ones (ADR
    /// 0024). Tests that just want an empty buffer with no gating pass
    /// `0` — which is also a real origin, for a log that states no start
    /// time; [`Self::session_started`] is what tells the two apart.
    ///
    /// (Why fresh `HashMap` allocations instead of `clear()`: those only
    /// reset length, leaving the — possibly enormous after a long replay
    /// — backing buffers resident. Replacing the containers returns the
    /// memory to the allocator so a small session after a large one
    /// doesn't carry the previous footprint. The raw store does the same
    /// in its own [`RawStore::clear`](cannet_spill::RawStore::clear).)
    pub fn start_session(&self, session_start_ns: u64) {
        let mut inner = self.lock_inner();
        inner.raw.clear();
        inner.reset_derived();
        inner.session_start_ns = session_start_ns;
        inner.session_started = true;
        // Wiping the buffer wipes the scratch (ADR 0002 DS-7): the raw
        // store's `clear` already dropped its segments and manifest; drop
        // the facade's derived + identity files too so a stale prior
        // session can't be reloaded. The host re-writes the identity if
        // this reset is the start of a fresh capture.
        if let Some(dir) = inner.scratch_dir.clone() {
            let _ = std::fs::remove_file(dir.join(DERIVED_FILE));
            let _ = std::fs::remove_file(dir.join(IDENTITY_FILE));
        }
    }

    /// Lower the session origin to `session_start_ns` — the one way it
    /// moves without emptying the buffer.
    ///
    /// An import learns its origin as it goes: the earliest timestamp it
    /// brings in is the session origin (ADR 0024), and the file does not
    /// have to present that timestamp first (BLF promises no ordering,
    /// and an MDF's earliest sample may be a signal rather than a frame).
    /// Lowering the anchor is the only correction that keeps the frames
    /// already appended — [`Self::start_session`] would discard them.
    ///
    /// A no-op when the anchor is already at or below `session_start_ns`,
    /// so the common in-order case costs one comparison. Never *raises*
    /// the anchor: raising it would strand frames already in the buffer
    /// below the origin, which is the negative-time bug this exists to
    /// prevent.
    pub fn lower_session_start(&self, session_start_ns: u64) {
        let mut inner = self.lock_inner();
        if inner.session_started && inner.session_start_ns <= session_start_ns {
            return;
        }
        inner.session_start_ns = session_start_ns;
        inner.session_started = true;
    }

    /// Flush the raw store to disk — a no-op for the in-RAM test double,
    /// and for the disk-spill store the durability point that makes its
    /// segments and reopen manifest reloadable (ADR 0002 DS-4/DS-7). The
    /// host calls this on a cadence so a crash loses at most the
    /// since-last-flush tail (DS-2), and a cleanly stopped session is
    /// reloadable as a stopped trace. Returns the raw store's I/O result.
    ///
    /// The raw store's manifest is written first (it is the authority on
    /// frame count); then the facade's [`DERIVED_FILE`] is rewritten, so
    /// its newest-index/count entries never reference a frame past the
    /// just-persisted length.
    pub fn flush(&self) -> std::io::Result<()> {
        self.flush_with(true)
    }

    /// Like [`Self::flush`] but with a non-blocking `msync` of the raw
    /// store (ADR 0002 DS-2): queues writeback instead of waiting for the
    /// device, so the periodic flusher doesn't pin the append lock on a
    /// disk fsync. Reopen-after-process-restart is unaffected (the page
    /// cache backs the mapping); only power-loss durability of the trailing
    /// window relaxes — acceptable for the ephemeral scratch.
    pub fn flush_async(&self) -> std::io::Result<()> {
        self.flush_with(false)
    }

    /// Move this store onto `dir` — the cache directory of a project
    /// directory the session has switched to (ADR 0042 §1).
    ///
    /// The whole swap happens under one hold of the store lock, which is
    /// what makes it safe against a running flusher and live ingest: both
    /// take the same lock, so they observe the store either wholly before
    /// or wholly after the move, never mid-way. A flush whose directory
    /// walk straddled the swap is detected and dropped
    /// ([`Self::commit_flush`]).
    ///
    /// [`Carry::Contents`] is the Save As path (ADR 0042 §6): the capture
    /// is flushed, unmapped, moved, and remapped at its new home, and the
    /// facade's derived state is kept because it describes the same frames.
    /// [`Carry::Nothing`] is the open-a-different-project path: the old
    /// directory keeps its capture untouched, and this store comes up empty
    /// on the new one — `try_reload` is what brings that project's own
    /// capture back, gated on its identity as always.
    ///
    /// A no-op if `dir` is already this store's directory. Errors only if
    /// the new directory can't be created or opened; a file that refuses to
    /// move is logged and left behind.
    pub fn reroot(&self, dir: &Path, carry: Carry) -> std::io::Result<()> {
        let mut inner = self.lock_inner();
        let from = inner.scratch_dir.clone();
        if from.as_deref() == Some(dir) {
            return Ok(());
        }
        std::fs::create_dir_all(dir)?;
        if carry == Carry::Contents {
            // Nothing may stay in the RAM ring: the files are about to
            // become the only copy.
            inner.raw.flush()?;
        }
        // Dropping the disk store is what unmaps its segments — required
        // before they can be renamed (Windows refuses to move a mapped
        // file) and before another store opens the same directory. The
        // in-RAM double stands in for the moment in between; the lock is
        // held throughout, so nothing ever observes it.
        drop(std::mem::replace(
            &mut inner.raw,
            Box::new(MemRawStore::new()) as Box<dyn RawStore>,
        ));
        let carried = match (carry, from.as_deref()) {
            (Carry::Contents, Some(from)) => {
                move_scratch_files(from, dir);
                DiskRawStore::reopen(dir).ok().flatten()
            }
            _ => None,
        };
        // A store that came across keeps the derived state describing it;
        // one that did not is a different capture entirely.
        if let Some(store) = carried {
            inner.raw = Box::new(store);
        } else {
            inner.raw = Box::new(DiskRawStore::open_empty(dir)?);
            inner.reset_derived();
        }
        inner.scratch_dir = Some(dir.to_path_buf());
        inner.footprint_bytes = 0;
        Ok(())
    }

    /// The directory this store's scratch lives in, or `None` for the
    /// in-RAM double.
    pub fn scratch_dir(&self) -> Option<std::path::PathBuf> {
        self.lock_inner().scratch_dir.clone()
    }

    fn flush_with(&self, sync: bool) -> std::io::Result<()> {
        // Both directory walks below run **off** the store lock, following
        // the same clone-the-dir-then-release shape as
        // [`TraceStore::scratch_breakdown`]. Each is one `metadata()` syscall
        // per file — thousands on a long capture — and the flusher runs on a
        // cadence against a live ingest pump, so walking under the lock stalls
        // every append for the duration of the walk.
        //
        // The eviction, the raw flush and the derived write stay inside one
        // lock hold: `start_session` deletes [`DERIVED_FILE`] and empties
        // `per_key`, so a flush that wrote its snapshot outside the lock could
        // recreate that file describing the session that just ended. The
        // write is small by construction (id-space-bounded, see
        // [`DerivedState`]); the walks are not, which is why they are the part
        // that moves out.
        let (dir, cap, raw_bytes) = {
            let inner = self.lock_inner();
            (
                inner.scratch_dir.clone(),
                inner.scratch_cap_bytes,
                inner.raw.raw_disk_bytes(),
            )
        };
        // Windowed-ring cap (ADR 0002 DS-8): shed the oldest raw segments
        // *before* the raw flush, so the manifest that flush writes reflects
        // the post-eviction floor and segment set. A manifest written before
        // the eviction would name segment files the eviction then deletes, and
        // a reopen across that eviction would fail.
        //
        // The cap bounds the *whole* scratch dir, but only the raw family is
        // shed here — the derived caches (pyramids, by-id, filter) cascade-
        // trim to the new low-water afterward (6d, in the flusher). So scale
        // the request by the raw share of the dir: handing the whole-dir
        // excess to a raw-only eviction would shed raw to cover the derived
        // families' bytes too, collapsing the retained window to the tail.
        // The cascade then shrinks the derived families to match, so raw + the
        // cascade converge on the cap together across a tick or two.
        let evict_bytes = match (dir.as_deref(), cap) {
            (Some(dir), Some(cap)) => {
                let footprint = dir_footprint(dir);
                (footprint > cap).then(|| {
                    u64::try_from(
                        u128::from(footprint - cap) * u128::from(raw_bytes) / u128::from(footprint),
                    )
                    .unwrap_or(footprint - cap)
                })
            }
            _ => None,
        };

        if !self.commit_flush(sync, dir.as_deref(), evict_bytes)? {
            return Ok(());
        }

        // Cache the total footprint after all of this flush's writes, so the
        // status readout (ADR 0002 DS-8) reflects the on-disk truth including
        // the manifest and derived files just written. A second walk, not the
        // first one reused: the first is measured before this flush wrote
        // anything, and the cap decision needs a pre-write reading anyway.
        if let Some(dir) = dir.as_deref() {
            let footprint = dir_footprint(dir);
            let mut inner = self.lock_inner();
            if inner.scratch_dir.as_deref() == Some(dir) {
                inner.footprint_bytes = footprint;
            }
        }
        Ok(())
    }

    /// The half of a flush that runs under the lock: the windowed-ring
    /// eviction, the raw flush, and the derived snapshot. `dir` is the
    /// scratch directory the caller measured its eviction budget against.
    ///
    /// Returns `false` — having written nothing — when the store has been
    /// re-rooted since then. [`Self::reroot`] takes this same lock, so the
    /// swap can only have happened while the lock was released for the
    /// directory walk; what the caller measured describes a store this no
    /// longer is, and `dir` names a directory it no longer owns. Dropping
    /// the tick is right rather than merely safe: the next one measures the
    /// new root, and the alternative is writing one store's derived
    /// snapshot into another store's directory.
    fn commit_flush(
        &self,
        sync: bool,
        dir: Option<&Path>,
        evict_bytes: Option<u64>,
    ) -> std::io::Result<bool> {
        let mut inner = self.lock_inner();
        if inner.scratch_dir.as_deref() != dir {
            return Ok(false);
        }
        if let Some(bytes) = evict_bytes {
            inner.raw.evict_oldest_bytes(bytes);
        }
        if sync {
            inner.raw.flush()?;
        } else {
            inner.raw.flush_async()?;
        }
        if let Some(dir) = dir {
            let entries = inner
                .per_key
                .iter()
                .map(|(key, e)| DerivedEntry {
                    bus_id: key.0.clone(),
                    channel: key.1,
                    id: key.2,
                    extended: key.3,
                    last_index: e.last_index as u64,
                    count: e.rate.count,
                    timestamp_ns: e.last_frame.timestamp_ns,
                    tx: matches!(e.last_frame.direction, Direction::Tx),
                    payload: PersistedPayload::from(&e.last_frame.payload),
                })
                .collect();
            let derived = DerivedState {
                session_start_ns: inner.session_start_ns,
                entries,
            };
            write_json(&dir.join(DERIVED_FILE), &derived)?;
        }
        Ok(true)
    }

    /// Record which project the current scratch belongs to (ADR 0002
    /// DS-7), so a later launch reloads it only against that project, and
    /// mint a fresh identity for the capture that is starting. A no-op for
    /// the in-RAM double. `None` removes any prior identity (the scratch
    /// then belongs to no project and never reloads). Called by the host
    /// when a capture starts.
    ///
    /// Each call is one capture beginning, so each call mints a new
    /// `capture_id`: it is stable across relaunches of the same capture
    /// (nothing rewrites the identity on reload) and distinct for the next
    /// one, which is exactly what derived state keyed on frame indices
    /// needs to prove it is still describing the right frames (ADR 0047).
    pub fn write_scratch_identity(&self, project_id: Option<Uuid>) {
        let inner = self.lock_inner();
        let Some(dir) = inner.scratch_dir.clone() else {
            return;
        };
        let path = dir.join(IDENTITY_FILE);
        match project_id {
            Some(project_id) => {
                let identity = ScratchIdentity {
                    project_id,
                    capture_id: Some(Uuid::new_v4()),
                };
                if let Err(e) = write_json(&path, &identity) {
                    tracing::warn!(error = %e, "writing scratch identity failed");
                }
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Identity of the capture currently in the scratch, or `None` for the
    /// in-RAM double, a scratch with no capture, or one written before
    /// captures were identified. See [`ScratchIdentity::capture_id`].
    pub fn scratch_capture_id(&self) -> Option<Uuid> {
        let dir = self.lock_inner().scratch_dir.clone()?;
        read_json::<ScratchIdentity>(&dir.join(IDENTITY_FILE))?.capture_id
    }

    /// Reload a prior on-disk session as a **stopped** trace, but only if
    /// the scratch's recorded identity matches `project_id` (ADR 0002
    /// DS-7). On a match with a reopenable store, this swaps in the
    /// disk-spill store, restores the derived state and session-start
    /// anchor, and returns the reload's per-phase cost breakdown ready to
    /// log; otherwise it leaves the store untouched (the scratch stays on
    /// disk, neither loaded nor wiped) and returns `None`. The reloaded
    /// trace's per-id rates read zero — it isn't live.
    ///
    /// The breakdown is a deliverable, not scaffolding: reloading is the
    /// one place a launch pays `O(segments)` before the user sees anything
    /// (ADR 0002 DS-7), and its phases have wildly different costs
    /// depending on how many segment files the capture spans, so every
    /// restore says where its time went and on how many files.
    pub fn try_reload(&self, project_id: Uuid) -> Option<String> {
        let started = Instant::now();
        let mut inner = self.lock_inner();
        let dir = inner.scratch_dir.clone()?;
        let identity_at = Instant::now();
        let matches = read_json::<ScratchIdentity>(&dir.join(IDENTITY_FILE))
            .is_some_and(|id| id.project_id == project_id);
        if !matches {
            return None;
        }
        let identity_ms = ms_since(identity_at);
        let Ok(Some((reopened, reopen))) = DiskRawStore::reopen_timed(&dir) else {
            return None;
        };
        inner.raw = Box::new(reopened);
        // The mux index describes frames that went through the extractor on
        // append; none of the reloaded ones did. Re-root its coverage at the
        // new tip — same promise `set_mux_extractor` makes — so queries over
        // the restored history take the bounded backward scan instead of
        // reading an empty map as proof that no group ever matched.
        inner.latest_mux = HashMap::new();
        inner.mux_rates = HashMap::new();
        inner.mux_index_from = inner.raw.len();
        // Same for the anchor index: it was folded from the buffer this
        // reload just replaced, so it describes no row that now exists.
        inner.ts_anchor = TsAnchorIndex::default();
        // Restore the derived state the by-id view and filter resolution
        // read. Rates are left with only their count (a reloaded trace is
        // stopped, so every rate reads zero); the newest-index and frame are
        // recovered from the overlay.
        inner.per_key = HashMap::new();
        inner.key_generation = inner.key_generation.wrapping_add(1);
        inner.session_start_ns = 0;
        let derived_at = Instant::now();
        let mut derived_entries = 0usize;
        if let Some(derived) = read_json::<DerivedState>(&dir.join(DERIVED_FILE)) {
            derived_entries = derived.entries.len();
            inner.session_start_ns = derived.session_start_ns;
            // A reloaded capture has an origin by definition, whatever its
            // value — including zero, for a log that stated no start time.
            inner.session_started = true;
            let now = Instant::now();
            for e in derived.entries {
                let frame = RawTraceFrame {
                    timestamp_ns: e.timestamp_ns,
                    channel: e.channel,
                    id: e.id,
                    extended: e.extended,
                    direction: if e.tx { Direction::Tx } else { Direction::Rx },
                    payload: e.payload.into(),
                    bus_id: Some(e.bus_id.clone()),
                };
                let key: FrameKey = (e.bus_id, e.channel, e.id, e.extended);
                let mut rate = RateEstimate::first_seen(0, now);
                rate.count = e.count;
                inner.per_key.insert(
                    key,
                    PerKey {
                        last_index: usize::try_from(e.last_index).unwrap_or(usize::MAX),
                        last_frame: frame,
                        rate,
                    },
                );
            }
        }
        // Durations only read as fast or slow beside the file counts, so
        // each phase carries how much work it did.
        Some(format!(
            "reload {total:.0} ms: identity {identity_ms:.0} manifest {manifest:.0} \
             byid {byid:.0} ({byid_files} files, {byid_ids} ids) \
             meta {meta:.0} ({meta_files} files) payload {payload:.0} ({payload_files} files) \
             ring {ring:.0} ({ring_frames} frames) derived {derived:.0} ({derived_entries} keys)",
            total = ms_since(started),
            manifest = reopen.manifest_ms,
            byid = reopen.byid_ms,
            byid_files = reopen.byid_files,
            byid_ids = reopen.byid_ids,
            meta = reopen.meta_ms,
            meta_files = reopen.meta_files,
            payload = reopen.payload_ms,
            payload_files = reopen.payload_files,
            ring = reopen.ring_ms,
            ring_frames = reopen.ring_frames,
            derived = ms_since(derived_at),
        ))
    }
}

/// Wall-clock milliseconds elapsed since `t`, for the restore breakdown.
fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

impl Inner {
    /// Drop every RAM-side derivation of the frame buffer, leaving the
    /// buffer itself and the injected mux extractor alone. Shared by the
    /// two places that make the buffer no longer describe what the
    /// derivations say: starting a session (the frames go) and re-rooting
    /// without carrying the capture (the frames are somewhere else now).
    ///
    /// Fresh `HashMap` allocations rather than `clear()`: those only reset
    /// length, leaving the — possibly enormous after a long replay —
    /// backing buffers resident, so a small session after a large one would
    /// carry the previous footprint. The raw store does the same in its own
    /// [`RawStore::clear`](cannet_spill::RawStore::clear).
    fn reset_derived(&mut self) {
        self.session_start_ns = 0;
        self.session_started = false;
        self.agg_rate = RateTrack::default();
        // The sampled prefix maxima describe rows that are gone; a fold
        // outliving its capture would anchor events against it.
        self.ts_anchor = TsAnchorIndex::default();
        self.per_key = HashMap::new();
        self.key_generation = self.key_generation.wrapping_add(1);
        // The mux index empties with the buffer; the extractor itself
        // survives (the DBC set didn't change) and covers the fresh buffer
        // from index 0.
        self.latest_mux = HashMap::new();
        self.mux_rates = HashMap::new();
        self.mux_index_from = 0;
        self.per_bus = HashMap::new();
        self.rx_rate = RateTrack::default();
        self.tx_rate = RateTrack::default();
        self.dropped_before_session = 0;
    }
}

/// Whether a re-root brings the current capture with it (ADR 0042 §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Carry {
    /// Save As: the user asked cannet to put the project somewhere, so its
    /// data goes too — arriving without it would be a surprise.
    Contents,
    /// Opening a different project: this session's capture stays in the
    /// directory it belongs to, and the destination's own capture is what
    /// belongs there.
    Nothing,
}

/// Move the scratch's own files from `from` into `to`, leaving the
/// derived subdirectories behind.
///
/// The raw store keeps everything it owns — segments, by-id index,
/// manifest — as *files* at the top level of the cache directory, beside
/// this module's `identity.json` / `derived.json` and the notes copy. The
/// derived caches (the filter index, the signal pyramids) are
/// subdirectories, and they are deliberately not moved: they are rebuilt
/// on demand, and they are mapped by subsystems this lock does not hold,
/// which is the one part of the move that cannot be made safe. What they
/// leave behind is bytes in a cache directory the user can reclaim.
///
/// Best-effort per file: one that refuses to move is logged and left
/// where it is rather than failing the re-root.
fn move_scratch_files(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        if let Err(e) = std::fs::rename(entry.path(), to.join(entry.file_name())) {
            tracing::warn!(
                file = %entry.path().display(),
                error = %e,
                "could not move a scratch file to the new project directory; \
                 it stays where it is"
            );
        }
    }
}

/// Serialize `value` to `path` as JSON via a temp-file + rename, so a
/// crash mid-write can't leave a half-written file that fails to parse on
/// reload.
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)
}

/// Read and parse a JSON file written by [`write_json`]. `None` when the
/// file is absent or unparseable — both treated as "no usable state",
/// which the reload path handles as a clean miss.
pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::test_support::{dummy, dummy_on_bus, TEST_BUS};
    use cannet_core::CanFramePayload;
    use cannet_spill::RawStore;

    #[test]
    fn clear_resets_len() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        store.append(dummy(0, 2));
        store.start_session(0);
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn flush_is_a_noop_on_the_in_ram_double() {
        // The test double has no disk; flush must still succeed so the
        // host's flush cadence is store-agnostic.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        assert!(store.flush().is_ok());
    }

    #[test]
    fn flush_persists_a_disk_store_for_reopen() {
        // The facade flush is the durability point the host cadence drives:
        // after it, the disk store reopens with every frame (ADR 0002 DS-7).
        let dir = std::env::temp_dir().join(format!("cannet-flush-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            for i in 0u32..5 {
                store.append(dummy(u64::from(i) * 1_000, i));
            }
            store.flush().unwrap();
        }
        let reopened = cannet_spill::DiskRawStore::reopen(&dir)
            .unwrap()
            .expect("flush wrote a reopen manifest");
        assert_eq!(reopened.len(), 5);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_wipes_the_scratch_so_a_reopen_restores_nothing() {
        // The contract "clear scratch cache on exit" relies on (ADR 0002
        // DS-7): the Clear reset (`start_session`) drops the raw store's
        // segments and reopen manifest in place — while the store is still
        // mapped, no unmap needed — so a later reopen finds nothing to
        // restore. The host runs exactly this on exit when the setting is on.
        let dir = std::env::temp_dir().join(format!("cannet-clearexit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            for i in 0u32..5 {
                store.append(dummy(u64::from(i) * 1_000, i));
            }
            store.flush().unwrap();
            store.start_session(1); // the Clear / clear-on-exit reset
        }
        let restored_len = cannet_spill::DiskRawStore::reopen(&dir)
            .unwrap()
            .map_or(0, |s| s.len());
        assert_eq!(restored_len, 0, "clear must leave nothing to reload");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flush_sheds_oldest_segments_when_over_the_scratch_cap() {
        // 6c-B (ADR 0002 DS-8): a flush past the cap drops the oldest raw
        // segments; the tip is unchanged, only the floor moves.
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-cap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
        let store = TraceStore::with_raw(raw, Some(dir.clone()));
        for i in 0u32..40 {
            store.append(dummy(u64::from(i) * 1_000, 0x100));
        }
        store.flush().unwrap(); // unbounded: no eviction
        assert!(
            !store.slice(0, 1).is_empty(),
            "row 0 present before the cap"
        );
        let full = dir_footprint(&dir);
        // Cap well below the footprint: the next flush sheds the oldest.
        store.set_scratch_cap(Some(full / 2));
        store.flush().unwrap();
        let after = dir_footprint(&dir);
        assert!(after < full, "flush reclaimed disk: {after} < {full}");
        assert!(store.slice(0, 1).is_empty(), "oldest rows were evicted");
        assert_eq!(
            store.len(),
            40,
            "the tip is unchanged — only the floor moved"
        );
        assert_eq!(
            store.slice(39, 40)[0].id,
            0x100,
            "the live tail still reads"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn by_id_overlay_keeps_a_rare_ids_last_value_across_eviction() {
        // 6c-C (ADR 0002 DS-8): the global latest-by-id read serves frame
        // content from the eager overlay, so an id whose only frame was
        // evicted below the low-water mark still shows its last value in the
        // by-id grid — not a blank row, and not misaligned onto another id's
        // frame (the failure mode of reading evicted indices back from raw).
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-overlay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
        let store = TraceStore::with_raw(raw, Some(dir.clone()));
        // A rare id seen once at the very start (index 0), then a flood of a
        // common id that pushes the rare id's only frame into the oldest
        // segments.
        store.append({
            let mut f = dummy(1_000, 0x7AA);
            f.payload = CanFramePayload::Classic(vec![0xAB]);
            f
        });
        for i in 1u32..40 {
            store.append(dummy(u64::from(i) * 1_000, 0x100));
        }
        store.flush().unwrap();
        let full = dir_footprint(&dir);
        store.set_scratch_cap(Some(full / 2));
        store.flush().unwrap();

        let (mark, _) = store.low_water();
        assert!(mark > 0, "eviction advanced the low-water mark");
        assert!(store.slice(0, 1).is_empty(), "the rare id's frame left raw");
        let rows = store.latest_since(0);
        let rare = rows
            .iter()
            .find(|r| r.frame.id == 0x7AA)
            .expect("the evicted rare id is still in the by-id grid");
        assert_eq!(
            rare.frame.payload.data(),
            &[0xAB],
            "its last value survives"
        );
        // The common id is also present and correct (no zip misalignment).
        assert!(rows.iter().any(|r| r.frame.id == 0x100));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn by_id_overlay_persists_an_evicted_last_value_across_reopen() {
        // 6c-C: the overlay rides `derived.json`, so a reopen across an
        // eviction still serves the evicted id's last value.
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-overlay-rl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        {
            let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
            let store = TraceStore::with_raw(raw, Some(dir.clone()));
            store.write_scratch_identity(Some(pid));
            store.append({
                let mut f = dummy(1_000, 0x7AA);
                f.payload = CanFramePayload::Classic(vec![0xCD]);
                f
            });
            for i in 1u32..40 {
                store.append(dummy(u64::from(i) * 1_000, 0x100));
            }
            store.flush().unwrap();
            store.set_scratch_cap(Some(dir_footprint(&dir) / 2));
            store.flush().unwrap();
            assert!(store.slice(0, 1).is_empty(), "evicted before reopen");
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert!(booted.try_reload(pid).is_some(), "matching project reloads");
        let rare = booted
            .latest_since(0)
            .into_iter()
            .find(|r| r.frame.id == 0x7AA)
            .expect("the evicted rare id reloads with its last value");
        assert_eq!(rare.frame.payload.data(), &[0xCD]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cap_eviction_does_not_over_evict_raw_for_derived_family_footprint() {
        // Regression (ADR 0002 DS-8): the scratch cap bounds the *whole* dir
        // (raw + the derived caches), but only the raw family is shed at flush
        // — the derived caches cascade-trim to the new low-water afterward.
        // Sizing the raw eviction against the whole-dir excess made it shed raw
        // to cover the derived families' bytes too, collapsing the retained
        // window to the tail ("retained resets to ~0 every flush"). The request
        // must be scaled to the raw share so raw + the cascade land at the cap
        // together.
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-cap-share-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
        let store = TraceStore::with_raw(raw, Some(dir.clone()));
        for i in 0u32..40 {
            store.append(dummy(u64::from(i) * 1_000, 0x100));
        }
        store.flush().unwrap();
        // A derived cache as large as the whole raw dir, which this flush
        // cannot shed (not a `meta.`/`payload.` file) — it stands in for the
        // signal pyramids that live in a `signals/` sibling.
        let raw_dir_bytes = dir_footprint(&dir);
        let stub = vec![0u8; usize::try_from(raw_dir_bytes).unwrap()];
        std::fs::write(dir.join("derived.stub"), stub).unwrap();
        // Cap at the raw dir's size: the whole dir is now ~2x the cap, but the
        // excess is the derived stub, not raw.
        store.set_scratch_cap(Some(raw_dir_bytes));
        store.flush().unwrap();

        let len = store.len();
        let (mark, _) = store.low_water();
        assert!(mark > 0, "eviction advanced the low-water mark");
        assert!(
            len - mark >= 12,
            "raw over-evicted to cover the derived stub: retained {} of {len} (mark {mark})",
            len - mark,
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two cache directories, as a Save As or a project switch would have.
    struct Roots {
        _tmp: tempfile::TempDir,
        a: std::path::PathBuf,
        b: std::path::PathBuf,
    }

    impl Roots {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let a = tmp.path().join("a");
            let b = tmp.path().join("b");
            std::fs::create_dir_all(&a).unwrap();
            std::fs::create_dir_all(&b).unwrap();
            Self { _tmp: tmp, a, b }
        }
    }

    #[test]
    fn rerooting_with_carry_moves_the_capture_and_keeps_it_readable() {
        // ADR 0042 §6: Save As carries the contents across, so the trace
        // the user is looking at survives the move — same frames, same
        // derived state, new home.
        let roots = Roots::new();
        let store = TraceStore::new_disk(&roots.a).unwrap();
        store.start_session(1_000);
        for i in 0u32..5 {
            store.append(dummy(1_000 + u64::from(i) * 1_000, 0x100 + i));
        }
        store.flush().unwrap();

        store.reroot(&roots.b, Carry::Contents).unwrap();

        assert_eq!(store.scratch_dir().as_deref(), Some(roots.b.as_path()));
        assert_eq!(store.len(), 5, "the frames came with it");
        assert_eq!(store.session_start_ns(), 1_000, "and so did the anchor");
        assert_eq!(
            store.latest_since(0).len(),
            5,
            "the by-id derived state describes the same frames"
        );
        // The files really moved: the new directory reopens with the
        // capture, and the old one is left with no manifest to reopen.
        drop(store);
        assert_eq!(
            cannet_spill::DiskRawStore::reopen(&roots.b)
                .unwrap()
                .expect("the manifest moved too")
                .len(),
            5
        );
        assert!(cannet_spill::DiskRawStore::reopen(&roots.a)
            .unwrap()
            .is_none());
    }

    #[test]
    fn rerooting_without_carry_leaves_the_old_capture_exactly_where_it_was() {
        // Opening a different project: A's capture must still be there when
        // the user comes back to it, and this session starts empty on B —
        // `try_reload` is what brings B's own capture back, not this.
        let roots = Roots::new();
        let store = TraceStore::new_disk(&roots.a).unwrap();
        store.start_session(1_000);
        for i in 0u32..5 {
            store.append(dummy(1_000 + u64::from(i) * 1_000, 0x100 + i));
        }
        store.flush().unwrap();

        store.reroot(&roots.b, Carry::Nothing).unwrap();

        assert_eq!(store.scratch_dir().as_deref(), Some(roots.b.as_path()));
        assert_eq!(store.len(), 0, "a different project's store starts empty");
        assert!(
            store.latest_since(0).is_empty(),
            "and so does its by-id view"
        );
        assert_eq!(
            cannet_spill::DiskRawStore::reopen(&roots.a)
                .unwrap()
                .expect("A's capture is untouched")
                .len(),
            5
        );
    }

    #[test]
    fn rerooting_to_the_directory_already_open_changes_nothing() {
        let roots = Roots::new();
        let store = TraceStore::new_disk(&roots.a).unwrap();
        store.append(dummy(1_000, 0x100));
        store.reroot(&roots.a, Carry::Nothing).unwrap();
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn a_flush_whose_walk_straddles_a_reroot_writes_nothing() {
        // `flush_with` measures the scratch off the lock (the walk is too
        // slow to hold it) and commits under it. A re-root in between means
        // those measurements describe a store this no longer is — and the
        // directory it named belongs to another project now. The commit
        // must recognise that and drop the tick rather than write one
        // store's derived snapshot into another's directory.
        let roots = Roots::new();
        let store = TraceStore::new_disk(&roots.a).unwrap();
        store.append(dummy(1_000, 0x100));
        store.reroot(&roots.b, Carry::Nothing).unwrap();
        let before: Vec<_> = std::fs::read_dir(&roots.a)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();

        // Exactly what an in-flight flush would carry: the directory it
        // measured, which is no longer the store's.
        let committed = store.commit_flush(true, Some(&roots.a), None).unwrap();

        assert!(!committed, "the tick must be dropped, not committed");
        let after: Vec<_> = std::fs::read_dir(&roots.a)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(before, after, "nothing was written into the old directory");
        // And the store itself still flushes normally on its own root.
        assert!(store.commit_flush(true, Some(&roots.b), None).unwrap());
    }

    #[test]
    fn rerooting_is_safe_against_a_running_flusher() {
        // The flusher thread runs on a cadence against live ingest, and a
        // re-root swaps the raw store out from under both. They serialise on
        // the store lock, so the invariant to prove is that no interleaving
        // leaves torn state: after the last swap the store holds exactly
        // what was appended to it since, and every earlier directory keeps a
        // consistent, reopenable capture.
        let roots = Roots::new();
        let store = std::sync::Arc::new(TraceStore::new_disk(&roots.a).unwrap());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flusher = {
            let store = store.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    store.flush_async().ok();
                }
            })
        };
        let appender = {
            let store = store.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut ts = 1_000u64;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    ts += 1_000;
                    store.append(dummy(ts, 0x200));
                }
            })
        };

        let tmp = tempfile::tempdir().unwrap();
        for i in 0..20 {
            let dir = tmp.path().join(format!("root-{i}"));
            std::fs::create_dir_all(&dir).unwrap();
            store.reroot(&dir, Carry::Nothing).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        appender.join().unwrap();
        flusher.join().unwrap();

        // The final root is the one in force, and the capture reopens to
        // exactly the length the store reports — a torn swap would leave a
        // manifest describing frames the store no longer has, or vice versa.
        let final_dir = tmp.path().join("root-19");
        assert_eq!(store.scratch_dir().as_deref(), Some(final_dir.as_path()));
        let len = store.len();
        store.flush().unwrap();
        drop(store);
        let reopened = cannet_spill::DiskRawStore::reopen(&final_dir).unwrap();
        assert_eq!(reopened.map_or(0, |s| s.len()), len);
    }

    #[test]
    fn try_reload_restores_a_matching_stopped_session() {
        let dir = std::env::temp_dir().join(format!("cannet-reload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.start_session(1_000); // session-start anchor
            store.write_scratch_identity(Some(pid));
            store.append(dummy_on_bus(1_000, 0x100, "pt"));
            store.append(dummy_on_bus(2_000, 0x100, "body")); // same id, other bus
            store.append(dummy_on_bus(3_000, 0x100, "pt"));
            store.flush().unwrap();
        }
        // A fresh launch over the same dir: empty until the gate reloads.
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert_eq!(booted.len(), 0);
        // Mismatched project: nothing loads, the scratch is left intact.
        assert!(booted.try_reload(uuid::Uuid::new_v4()).is_none());
        assert_eq!(booted.len(), 0);
        // Matching project: reloads as a stopped trace with derived state
        // and the session-start anchor restored.
        assert!(booted.try_reload(pid).is_some());
        assert_eq!(booted.len(), 3);
        assert_eq!(booted.session_start_ns(), 1_000);
        // Multi-bus same-id stays faithful (fork P persists the full key):
        // both buses are present with their own counts.
        let mut by_bus: Vec<(Option<String>, u64)> = booted
            .latest_since(0)
            .iter()
            .map(|r| (r.frame.bus_id.clone(), r.count))
            .collect();
        by_bus.sort();
        assert_eq!(
            by_bus,
            vec![(Some("body".into()), 1), (Some("pt".into()), 2)]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discarding_a_restored_session_leaves_nothing_for_the_next_launch() {
        // The offramp's own exit criterion: when the user drops a restored
        // capture rather than paying its cold pyramid rebuild, what is left
        // is a *clean empty session* — not a half-deleted scratch a later
        // launch can bring a fragment of back from. The drop is the same
        // `start_session` + restamp a fresh open already runs.
        let dir = std::env::temp_dir().join(format!("cannet-discard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.start_session(1_000);
            store.write_scratch_identity(Some(pid));
            store.append(dummy_on_bus(1_000, 0x100, "pt"));
            store.append(dummy_on_bus(2_000, 0x100, "pt"));
            store.flush().unwrap();
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert!(booted.try_reload(pid).is_some());
        assert_eq!(booted.len(), 2, "the capture is there to be discarded");

        booted.start_session(0);
        booted.write_scratch_identity(Some(pid));
        assert_eq!(booted.len(), 0);
        assert!(booted.latest_since(0).is_empty(), "no derived residue");
        assert_eq!(booted.session_start_ns(), 0);

        // The next launch over the same scratch: the identity is this
        // project's, so the gate opens — and finds an empty capture.
        let relaunched = TraceStore::new_disk(&dir).unwrap();
        relaunched.try_reload(pid);
        assert_eq!(relaunched.len(), 0, "nothing was resurrected");
        assert!(relaunched.latest_since(0).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn try_reload_leaves_no_false_mux_coverage_over_the_restored_history() {
        // `mux_index_from` promises "every frame at or above me passed
        // through the current extractor". A reload swaps in frames that
        // never did, so the promise has to be re-made at the new tip —
        // otherwise a launch (where the DBC set installs its extractor over
        // an *empty* store, leaving the mark at 0) claims coverage of the
        // whole restored history and every mux group reads blank.
        let dir = std::env::temp_dir().join(format!("cannet-muxreload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        let muxed = |ts: u64, sel: u8| RawTraceFrame {
            payload: CanFramePayload::Classic(vec![sel]),
            ..dummy(ts, 0x10)
        };
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.write_scratch_identity(Some(pid));
            store.append(muxed(1_000, 0));
            store.append(muxed(2_000, 1));
            store.append(muxed(3_000, 0));
            store.flush().unwrap();
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        // The open path's order: the DBC set installs the extractor while
        // the store is still empty, then the capture is restored.
        booted.set_mux_extractor(Some(std::sync::Arc::new(|f: &RawTraceFrame| {
            f.payload.data().first().copied().map(u64::from)
        })));
        assert!(booted.try_reload(pid).is_some());
        let got = booted.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0, 1], 0, usize::MAX);
        assert_eq!(
            got.get(&0).map(|(i, f)| (*i, f.timestamp_ns)),
            Some((2, 3_000)),
            "group 0's latest restored frame"
        );
        assert_eq!(
            got.get(&1).map(|(i, f)| (*i, f.timestamp_ns)),
            Some((1, 2_000)),
            "group 1's latest restored frame"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_capture_id_is_stable_across_a_reload_and_fresh_per_capture() {
        // The identity derived state keyed on frame indices is validated
        // against (ADR 0047): the same capture keeps its id across as many
        // relaunches as it likes, and the next capture never inherits it.
        let dir = std::env::temp_dir().join(format!("cannet-capid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        let first = {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.write_scratch_identity(Some(pid));
            store.append(dummy(1_000, 1));
            store.flush().unwrap();
            store.scratch_capture_id().expect("a capture was started")
        };
        // Relaunch over the same scratch: reloading does not re-identify.
        let second = {
            let store = TraceStore::new_disk(&dir).unwrap();
            assert!(store.try_reload(pid).is_some());
            store.scratch_capture_id()
        };
        assert_eq!(second, Some(first), "a reload keeps the capture's id");

        // A new capture in the same project is a different capture.
        let store = TraceStore::new_disk(&dir).unwrap();
        store.start_session(0);
        assert_eq!(store.scratch_capture_id(), None, "the reset drops it");
        store.write_scratch_identity(Some(pid));
        assert_ne!(store.scratch_capture_id(), Some(first));

        // An in-RAM double has no scratch and so no capture identity.
        assert_eq!(TraceStore::new().scratch_capture_id(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn start_session_wipes_the_scratch_so_a_later_reload_misses() {
        let dir = std::env::temp_dir().join(format!("cannet-wipe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.write_scratch_identity(Some(pid));
            store.append(dummy(1_000, 1));
            store.flush().unwrap();
        }
        {
            // A Clear / new-capture reset wipes the scratch identity.
            let store = TraceStore::new_disk(&dir).unwrap();
            assert!(store.try_reload(pid).is_some());
            store.start_session(0);
            store.flush().unwrap();
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert!(
            booted.try_reload(pid).is_none(),
            "wiped identity must not reload"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn start_session_empties_buffer_and_raises_threshold() {
        let store = TraceStore::new();
        store.append(dummy(100, 1));
        store.append(dummy(200, 2));
        assert_eq!(store.len(), 2);
        store.start_session(1_000);
        assert_eq!(store.len(), 0);
        assert_eq!(store.session_start_ns(), 1_000);
    }
}
