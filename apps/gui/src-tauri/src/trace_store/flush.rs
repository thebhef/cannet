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
use cannet_spill::DiskRawStore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::rate::{RateEstimate, RateTrack};
use super::scratch::dir_footprint;
use super::{FrameKey, PerKey, RawTraceFrame, TraceStore};

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
#[derive(Serialize, Deserialize)]
struct DerivedEntry {
    bus_id: Option<String>,
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
    /// Live capture passes wall-clock now; BLF replay passes the
    /// first frame's timestamp so the trace is rooted at the file's
    /// own time origin. Tests that just want an empty buffer with no
    /// gating pass `0`.
    ///
    /// (Why fresh `HashMap` allocations instead of `clear()`: those only
    /// reset length, leaving the — possibly enormous after a long replay
    /// — backing buffers resident. Replacing the containers returns the
    /// memory to the allocator so a small session after a large one
    /// doesn't carry the previous footprint. The raw store does the same
    /// in its own [`RawStore::clear`](cannet_spill::RawStore::clear).)
    pub fn start_session(&self, session_start_ns: u64) {
        let mut inner = self.lock_inner();
        inner.session_start_ns = session_start_ns;
        inner.raw.clear();
        inner.agg_rate = RateTrack::default();
        inner.per_key = HashMap::new();
        // The mux index empties with the buffer; the extractor itself
        // survives (the DBC set didn't change) and covers the fresh
        // buffer from index 0.
        inner.latest_mux = HashMap::new();
        inner.mux_rates = HashMap::new();
        inner.mux_index_from = 0;
        inner.per_bus = HashMap::new();
        inner.rx_rate = RateTrack::default();
        inner.tx_rate = RateTrack::default();
        inner.dropped_before_session = 0;
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
                        u128::from(footprint - cap) * u128::from(raw_bytes)
                            / u128::from(footprint),
                    )
                    .unwrap_or(footprint - cap)
                })
            }
            _ => None,
        };

        {
            let mut inner = self.lock_inner();
            if let Some(bytes) = evict_bytes {
                inner.raw.evict_oldest_bytes(bytes);
            }
            if sync {
                inner.raw.flush()?;
            } else {
                inner.raw.flush_async()?;
            }
            if let Some(dir) = dir.as_deref() {
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
        }

        // Cache the total footprint after all of this flush's writes, so the
        // status readout (ADR 0002 DS-8) reflects the on-disk truth including
        // the manifest and derived files just written. A second walk, not the
        // first one reused: the first is measured before this flush wrote
        // anything, and the cap decision needs a pre-write reading anyway.
        if let Some(dir) = dir.as_deref() {
            let footprint = dir_footprint(dir);
            self.lock_inner().footprint_bytes = footprint;
        }
        Ok(())
    }

    /// Record which project the current scratch belongs to (ADR 0002
    /// DS-7), so a later launch reloads it only against that project. A
    /// no-op for the in-RAM double. `None` removes any prior identity (the
    /// scratch then belongs to no project and never reloads). Called by
    /// the host when a capture starts.
    pub fn write_scratch_identity(&self, project_id: Option<Uuid>) {
        let inner = self.lock_inner();
        let Some(dir) = inner.scratch_dir.clone() else {
            return;
        };
        let path = dir.join(IDENTITY_FILE);
        match project_id {
            Some(project_id) => {
                if let Err(e) = write_json(&path, &ScratchIdentity { project_id }) {
                    tracing::warn!(error = %e, "writing scratch identity failed");
                }
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Reload a prior on-disk session as a **stopped** trace, but only if
    /// the scratch's recorded identity matches `project_id` (ADR 0002
    /// DS-7). On a match with a reopenable store, this swaps in the
    /// disk-spill store, restores the derived state and session-start
    /// anchor, and returns `true`; otherwise it leaves the store untouched
    /// (the scratch stays on disk, neither loaded nor wiped) and returns
    /// `false`. The reloaded trace's per-id rates read zero — it isn't
    /// live.
    pub fn try_reload(&self, project_id: Uuid) -> bool {
        let mut inner = self.lock_inner();
        let Some(dir) = inner.scratch_dir.clone() else {
            return false;
        };
        let matches = read_json::<ScratchIdentity>(&dir.join(IDENTITY_FILE))
            .is_some_and(|id| id.project_id == project_id);
        if !matches {
            return false;
        }
        let Ok(Some(reopened)) = DiskRawStore::reopen(&dir) else {
            return false;
        };
        inner.raw = Box::new(reopened);
        // Restore the derived state the by-id view and filter resolution
        // read. Rates are left with only their count (a reloaded trace is
        // stopped, so every rate reads zero); the newest-index and frame are
        // recovered from the overlay.
        inner.per_key = HashMap::new();
        inner.session_start_ns = 0;
        if let Some(derived) = read_json::<DerivedState>(&dir.join(DERIVED_FILE)) {
            inner.session_start_ns = derived.session_start_ns;
            let now = Instant::now();
            for e in derived.entries {
                let frame = RawTraceFrame {
                    timestamp_ns: e.timestamp_ns,
                    channel: e.channel,
                    id: e.id,
                    extended: e.extended,
                    direction: if e.tx { Direction::Tx } else { Direction::Rx },
                    payload: e.payload.into(),
                    bus_id: e.bus_id.clone(),
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
        true
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
    use crate::trace_store::test_support::{dummy, dummy_on_bus};
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
        assert!(booted.try_reload(pid), "matching project reloads");
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
        assert!(!booted.try_reload(uuid::Uuid::new_v4()));
        assert_eq!(booted.len(), 0);
        // Matching project: reloads as a stopped trace with derived state
        // and the session-start anchor restored.
        assert!(booted.try_reload(pid));
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
            assert!(store.try_reload(pid));
            store.start_session(0);
            store.flush().unwrap();
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert!(!booted.try_reload(pid), "wiped identity must not reload");
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
