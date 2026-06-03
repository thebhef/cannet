//! Host-side TX-message model.
//!
//! The transmit panel used to own its frame configs in React state and
//! run the periodic schedule with `setInterval`. That inverted the
//! "thin views over a host model" rule (ADR 0003 / CLAUDE.md) and was
//! the source of every transmit-panel bug — edits to a running periodic
//! not landing until stop/start, period changes resetting the schedule,
//! and a rate capped at roughly one send per event-loop turn.
//!
//! This module is the model. A [`TransmitFrameRegistry`] is the single
//! ordered pool of TX messages; the panel is a view onto it. Four
//! properties pin the design:
//!
//! 1. **One model object per message** ([`TransmitFrame`]), created /
//!    destroyed / persisted by the project.
//! 2. **Mode (manual vs periodic) is persisted**, distinct from
//!    *running* (started / stopped), which is runtime-only — a reopened
//!    project never auto-starts a periodic.
//! 3. **Any number of messages may share an id / bus.** The registry
//!    key is the per-message [`TransmitFrame::id`] (a UUID), never
//!    `(bus, can_id)` — duplicates of the same arbitration id on the
//!    same bus are ordinary, independent entries.
//! 4. **Every attribute is editable on a running periodic without
//!    stopping it.** The periodic thread re-reads the entry's request
//!    and `cycle_ms` at the top of each iteration, so any edit lands on
//!    the next emitted message (see `spawn_periodic_transmit` in
//!    `lib.rs`).
//!
//! Timing lives elsewhere: a single host scheduler thread
//! (`run_transmit_scheduler` in `lib.rs`, driving a
//! [`crate::transmit_scheduler::PeriodicSchedule`]) owns every running
//! periodic's deadline. This module owns the data and a per-entry
//! `running` flag the scheduler consults via [`TransmitFrameRegistry::fire_info`].

use serde::{Deserialize, Serialize};

use crate::ipc::TransmitRequest;

/// Whether a message is sent on demand or on a fixed cadence. Persisted
/// with the message; distinct from whether a periodic is *running*
/// (that's runtime-only — see [`TransmitFrameRegistry`]).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransmitMode {
    /// Sent only when the user presses Send.
    #[default]
    Manual,
    /// Sent every `cycle_ms` while started.
    Periodic,
}

/// One TX message — the persisted model object. `description` is an
/// optional user annotation (the *name* shown in the UI is the DBC
/// message name resolved from `request.id`); `request` carries the
/// frame definition (bus, id, kind, payload, …); `cycle_ms` is the
/// configured period (may be non-zero while parked in `Manual` mode);
/// `mode` is manual vs periodic.
///
/// camelCase on the wire so the frontend reads `request.busId`,
/// `cycleMs`, … without a wire-name shim. The same shape is what the
/// project file persists (`Project::transmit_frames`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransmitFrame {
    pub id: String,
    #[serde(default)]
    pub description: String,
    pub request: TransmitRequest,
    #[serde(default)]
    pub cycle_ms: u32,
    #[serde(default)]
    pub mode: TransmitMode,
}

/// A [`TransmitFrame`] plus its runtime-only `running` flag, returned
/// by `list_transmit_frames`. `running` is never persisted — it's the
/// presence of a live periodic thread.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransmitFrameView {
    #[serde(flatten)]
    pub frame: TransmitFrame,
    pub running: bool,
}

/// One pool entry: the message plus its runtime `running` flag.
/// `running` is the live-periodic state — set by [`TransmitFrameRegistry::begin_periodic`],
/// cleared by `stop_periodic` or by an edit that parks the message. The
/// scheduler thread reads it through [`TransmitFrameRegistry::fire_info`]
/// each time the entry comes due, so a stop or park takes effect on the
/// next tick without any per-entry thread to tear down.
struct Entry {
    frame: TransmitFrame,
    running: bool,
}

impl Entry {
    /// Mark this entry stopped (no longer firing).
    fn stop_periodic(&mut self) {
        self.running = false;
    }
}

/// The ordered, id-keyed pool of TX messages. Order is the pool order
/// (persisted, and what `reorder_transmit_frames` rewrites); lookups
/// are by [`TransmitFrame::id`]. Wrapped in a `Mutex` on `AppState`.
#[derive(Default)]
pub struct TransmitFrameRegistry {
    entries: Vec<Entry>,
}

impl TransmitFrameRegistry {
    fn position(&self, id: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.frame.id == id)
    }

    /// Snapshot every message + its running flag, in pool order.
    #[must_use]
    pub fn list(&self) -> Vec<TransmitFrameView> {
        self.entries
            .iter()
            .map(|e| TransmitFrameView {
                frame: e.frame.clone(),
                running: e.running,
            })
            .collect()
    }

    /// Snapshot the persisted shape (no `running`), in pool order —
    /// what `save_project` writes into `Project::transmit_frames`.
    #[must_use]
    pub fn snapshot(&self) -> Vec<TransmitFrame> {
        self.entries.iter().map(|e| e.frame.clone()).collect()
    }

    /// The current request / cycle / mode for `id`, or `None` if the
    /// entry was removed. Used by the manual-send path
    /// (`transmit_frame_once`); the scheduler uses [`Self::fire_info`].
    #[must_use]
    pub fn current(&self, id: &str) -> Option<(TransmitRequest, u32, TransmitMode)> {
        self.position(id).map(|i| {
            let f = &self.entries[i].frame;
            (f.request.clone(), f.cycle_ms, f.mode)
        })
    }

    /// What the scheduler should emit for `id` this tick: the current
    /// request and period, or `None` if the entry should leave the
    /// schedule — removed, stopped (`running == false`), parked to
    /// `Manual`, or `cycle_ms == 0`. Re-read on every tick so a live
    /// edit to the payload or period lands on the next emission
    /// (property 4), and a stop / park drops the entry from the
    /// schedule without any thread to tear down.
    #[must_use]
    pub fn fire_info(&self, id: &str) -> Option<(TransmitRequest, u32)> {
        let e = self.entries.iter().find(|e| e.frame.id == id)?;
        if !e.running || e.frame.mode != TransmitMode::Periodic || e.frame.cycle_ms == 0 {
            return None;
        }
        Some((e.frame.request.clone(), e.frame.cycle_ms))
    }

    /// Insert a new message or update an existing one in place. If the
    /// update parks the message (`Manual` mode or `cycle_ms == 0`), it
    /// is marked stopped; the scheduler drops it on its next tick (the
    /// command layer also sends an explicit unschedule so it stops
    /// promptly). A non-parking edit to a running periodic (e.g. a
    /// payload change) keeps it running.
    pub fn set(&mut self, frame: TransmitFrame) {
        if let Some(i) = self.position(&frame.id) {
            let entry = &mut self.entries[i];
            let parked = frame.mode != TransmitMode::Periodic || frame.cycle_ms == 0;
            entry.frame = frame;
            if parked {
                entry.stop_periodic();
            }
        } else {
            self.entries.push(Entry { frame, running: false });
        }
    }

    /// Remove a message, stopping its periodic first. Returns `true` if
    /// it existed.
    pub fn remove(&mut self, id: &str) -> bool {
        if let Some(i) = self.position(id) {
            self.entries[i].stop_periodic();
            self.entries.remove(i);
            true
        } else {
            false
        }
    }

    /// Reorder the pool to match `ids`. Ids not present are ignored;
    /// entries missing from `ids` keep their relative order at the end
    /// (defensive — the frontend passes the full set).
    pub fn reorder(&mut self, ids: &[String]) {
        let mut rank = std::collections::HashMap::new();
        for (i, id) in ids.iter().enumerate() {
            rank.insert(id.clone(), i);
        }
        let n = ids.len();
        self.entries
            .sort_by_key(|e| rank.get(&e.frame.id).copied().unwrap_or(n));
    }

    /// Mark `id` running. Returns `Ok(true)` if it was newly started
    /// (the caller should add it to the scheduler), `Ok(false)` if it
    /// was already running (a no-op — no second schedule entry), or
    /// `Err` when the message can't run periodically (missing, not
    /// `Periodic`, or `cycle_ms == 0`).
    pub fn begin_periodic(&mut self, id: &str) -> Result<bool, String> {
        let Some(i) = self.position(id) else {
            return Err(format!("no transmit frame with id {id}"));
        };
        let entry = &mut self.entries[i];
        if entry.frame.mode != TransmitMode::Periodic {
            return Err("frame is not in periodic mode".into());
        }
        if entry.frame.cycle_ms == 0 {
            return Err("frame has no cycle period".into());
        }
        if entry.running {
            return Ok(false);
        }
        entry.running = true;
        Ok(true)
    }

    /// Stop `id`'s periodic if running. Returns `true` if the entry
    /// exists.
    pub fn stop_periodic(&mut self, id: &str) -> bool {
        if let Some(i) = self.position(id) {
            self.entries[i].stop_periodic();
            true
        } else {
            false
        }
    }

    /// Stop every periodic and drop all messages.
    pub fn clear(&mut self) {
        for e in &mut self.entries {
            e.stop_periodic();
        }
        self.entries.clear();
    }

    /// Replace the pool with a persisted set (all stopped), used by
    /// `open_project`. Existing periodics are stopped first.
    pub fn load(&mut self, frames: Vec<TransmitFrame>) {
        self.clear();
        self.entries = frames
            .into_iter()
            .map(|frame| Entry { frame, running: false })
            .collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{TransmitKind, TransmitRequest};

    fn req(bus: &str, id: u32) -> TransmitRequest {
        TransmitRequest {
            bus_id: bus.into(),
            id,
            extended: false,
            kind: TransmitKind::Classic,
            data: vec![0],
            brs: false,
            esi: false,
            dlc: 0,
        }
    }

    fn frame(id: &str, bus: &str, can_id: u32, mode: TransmitMode, cycle_ms: u32) -> TransmitFrame {
        TransmitFrame {
            id: id.into(),
            description: String::new(),
            request: req(bus, can_id),
            cycle_ms,
            mode,
        }
    }

    #[test]
    fn same_id_and_bus_coexist_as_independent_entries() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Manual, 0));
        reg.set(frame("b", "p", 0x100, TransmitMode::Manual, 0));
        // Two messages, same can id + bus, distinct entries — never
        // collapsed (property 3).
        let list = reg.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].frame.id, "a");
        assert_eq!(list[1].frame.id, "b");
        assert_eq!(list[0].frame.request.id, 0x100);
        assert_eq!(list[1].frame.request.id, 0x100);
        // Editing one doesn't touch the other.
        reg.set(frame("a", "p", 0x100, TransmitMode::Manual, 50));
        let list = reg.list();
        assert_eq!(list[0].frame.cycle_ms, 50);
        assert_eq!(list[1].frame.cycle_ms, 0);
    }

    #[test]
    fn set_updates_in_place_preserving_order() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Manual, 0));
        reg.set(frame("b", "p", 0x200, TransmitMode::Manual, 0));
        reg.set(frame("a", "c", 0x111, TransmitMode::Periodic, 10));
        let list = reg.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].frame.id, "a");
        assert_eq!(list[0].frame.request.bus_id, "c");
        assert_eq!(list[0].frame.request.id, 0x111);
    }

    #[test]
    fn begin_periodic_rejects_manual_and_zero_period() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Manual, 100));
        assert!(reg.begin_periodic("a").is_err());
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 0));
        assert!(reg.begin_periodic("a").is_err());
        assert!(reg.begin_periodic("missing").is_err());
    }

    #[test]
    fn begin_then_stop_toggles_running() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 100));
        assert!(!reg.list()[0].running);
        // Newly started.
        assert!(reg.begin_periodic("a").unwrap());
        assert!(reg.list()[0].running);
        // Starting again while running is a no-op (no second schedule
        // entry) — reports `false`, not an error.
        assert!(!reg.begin_periodic("a").unwrap());
        reg.stop_periodic("a");
        assert!(!reg.list()[0].running);
    }

    #[test]
    fn parking_via_set_stops_a_running_periodic() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 100));
        assert!(reg.begin_periodic("a").unwrap());
        // Flip to manual via an edit — the periodic is marked stopped.
        reg.set(frame("a", "p", 0x100, TransmitMode::Manual, 100));
        assert!(!reg.list()[0].running);
        assert!(reg.fire_info("a").is_none());

        // Same for dropping the period to zero.
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 100));
        assert!(reg.begin_periodic("a").unwrap());
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 0));
        assert!(!reg.list()[0].running);
        assert!(reg.fire_info("a").is_none());
    }

    #[test]
    fn fire_info_reflects_live_edits_and_running_state() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 100));
        // Not running yet → nothing to fire.
        assert!(reg.fire_info("a").is_none());
        assert!(reg.begin_periodic("a").unwrap());
        // A payload edit mid-run is visible to the next `fire_info` read
        // (what the scheduler does each tick — property 4).
        reg.set(TransmitFrame {
            request: TransmitRequest { data: vec![1, 2, 3], ..req("p", 0x100) },
            ..frame("a", "p", 0x100, TransmitMode::Periodic, 100)
        });
        let (request, cycle_ms) = reg.fire_info("a").unwrap();
        assert_eq!(request.data, vec![1, 2, 3]);
        assert_eq!(cycle_ms, 100);
        // Still running — a payload edit doesn't tear the schedule down.
        assert!(reg.list()[0].running);
        // Stopping drops it from what the scheduler will fire.
        reg.stop_periodic("a");
        assert!(reg.fire_info("a").is_none());
    }

    #[test]
    fn remove_and_clear_stop_periodics() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 100));
        reg.set(frame("b", "p", 0x200, TransmitMode::Periodic, 100));
        assert!(reg.begin_periodic("a").unwrap());
        assert!(reg.begin_periodic("b").unwrap());
        assert!(reg.remove("a"));
        assert!(reg.fire_info("a").is_none());
        assert_eq!(reg.list().len(), 1);
        reg.clear();
        assert!(reg.fire_info("b").is_none());
        assert!(reg.list().is_empty());
    }

    #[test]
    fn reorder_rewrites_pool_order() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 1, TransmitMode::Manual, 0));
        reg.set(frame("b", "p", 2, TransmitMode::Manual, 0));
        reg.set(frame("c", "p", 3, TransmitMode::Manual, 0));
        reg.reorder(&["c".into(), "a".into(), "b".into()]);
        let ids: Vec<_> = reg.list().into_iter().map(|v| v.frame.id).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn load_replaces_pool_all_stopped() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Periodic, 100));
        assert!(reg.begin_periodic("a").unwrap());
        reg.load(vec![
            frame("x", "p", 0x100, TransmitMode::Periodic, 50),
            frame("y", "c", 0x200, TransmitMode::Manual, 0),
        ]);
        // Old periodic gone, pool replaced, nothing auto-running.
        let list = reg.list();
        assert_eq!(list.len(), 2);
        assert!(!list[0].running);
        assert!(!list[1].running);
        assert_eq!(list[0].frame.id, "x");
    }
}
