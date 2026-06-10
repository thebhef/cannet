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

use cannet_dbc::ResolvedCalculatedFields;

use crate::ipc::{CalcFieldsSpec, TransmitRequest};

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

/// Who owns a TX message — what created it and is responsible for its
/// lifecycle (ADR 0028). Provenance decides visibility: only
/// [`TransmitSource::Project`] entries appear in the transmit panel's
/// list and in the project's persisted `transmit_frames`; RBS-owned
/// entries are registered/torn down by their element and persist as
/// the `.cannet_rbs` file instead.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransmitSource {
    /// A transmit-panel message, persisted in the project.
    #[default]
    Project,
    /// A rest-of-bus-simulation row; the payload names the owning
    /// RBS element id.
    Rbs(String),
}

impl TransmitSource {
    fn is_project(&self) -> bool {
        matches!(self, Self::Project)
    }
}

/// One TX message — the persisted model object. `description` is an
/// optional user annotation (the *name* shown in the UI is the DBC
/// message name resolved from `request.id`); `request` carries the
/// frame definition (bus, id, kind, payload, …); `cycle_ms` is the
/// configured period (may be non-zero while parked in `Manual` mode);
/// `mode` is manual vs periodic; `source` is the owning feature
/// (see [`TransmitSource`]); `calc` is the message's calculated-field
/// override spec (ADR 0027) — `None` means "the DBC's declared
/// defaults apply", per-field.
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
    #[serde(default, skip_serializing_if = "TransmitSource::is_project")]
    pub source: TransmitSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calc: Option<CalcFieldsSpec>,
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

/// One pool entry: the message plus its runtime state. `running` is
/// the live-periodic state — set by [`TransmitFrameRegistry::begin_periodic`],
/// cleared by `stop_periodic` or by an edit that parks the message. The
/// scheduler thread reads it through [`TransmitFrameRegistry::fire_info`]
/// each time the entry comes due, so a stop or park takes effect on the
/// next tick without any per-entry thread to tear down.
///
/// `resolved_calc` is the entry's calculated-fields config resolved
/// against the current DBC set (ADR 0027 — resolved at registration,
/// applied in the fire path); `counter` is the sequence counter's
/// runtime value, never persisted. Both live here, not on
/// [`TransmitFrame`], because they're derived / runtime state.
struct Entry {
    frame: TransmitFrame,
    running: bool,
    resolved_calc: Option<ResolvedCalculatedFields>,
    counter: u64,
}

impl Entry {
    fn new(frame: TransmitFrame) -> Self {
        Self {
            frame,
            running: false,
            resolved_calc: None,
            counter: 0,
        }
    }

    /// Mark this entry stopped (no longer firing).
    fn stop_periodic(&mut self) {
        self.running = false;
    }

    /// ADR 0027 fire path: step the counter and recompute the CRC
    /// *into the entry's payload buffer* (the buffer is the source of
    /// truth — ADR 0017), then hand back the request to send.
    /// Best-effort: a buffer too short for the resolved placements
    /// (the user shrank the payload after registration) sends the
    /// bytes unmodified rather than dropping the frame.
    fn prepare_send(&mut self) -> TransmitRequest {
        if let Some(resolved) = &self.resolved_calc {
            let mut counter = self.counter;
            if resolved
                .apply(&mut counter, &mut self.frame.request.data)
                .is_ok()
            {
                self.counter = counter;
            }
        }
        self.frame.request.clone()
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

    /// Snapshot every project-owned message + its running flag, in
    /// pool order — what the transmit panel renders. RBS-owned entries
    /// are excluded by provenance (ADR 0028): their view is the RBS
    /// panel.
    #[must_use]
    pub fn list(&self) -> Vec<TransmitFrameView> {
        self.entries
            .iter()
            .filter(|e| e.frame.source.is_project())
            .map(|e| TransmitFrameView {
                frame: e.frame.clone(),
                running: e.running,
            })
            .collect()
    }

    /// Snapshot the persisted shape (no `running`), in pool order —
    /// what `save_project` writes into `Project::transmit_frames`.
    /// RBS-owned entries are excluded by provenance: they persist as
    /// their element's `.cannet_rbs` file, never in the project pool.
    #[must_use]
    pub fn snapshot(&self) -> Vec<TransmitFrame> {
        self.entries
            .iter()
            .filter(|e| e.frame.source.is_project())
            .map(|e| e.frame.clone())
            .collect()
    }

    /// The request the manual-send path (`transmit_frame_once`) should
    /// emit for `id` right now — with the entry's calculated fields
    /// applied into its payload buffer first ("every transmit
    /// recomputes both", ADR 0027). `None` if the entry was removed.
    pub fn send_request(&mut self, id: &str) -> Option<TransmitRequest> {
        let i = self.position(id)?;
        Some(self.entries[i].prepare_send())
    }

    /// What the scheduler should emit for `id` this tick: the current
    /// request (calculated fields freshly applied — counter stepped,
    /// CRC recomputed into the payload buffer) and period, or `None`
    /// if the entry should leave the schedule — removed, stopped
    /// (`running == false`), parked to `Manual`, or `cycle_ms == 0`.
    /// Re-read on every tick so a live edit to the payload or period
    /// lands on the next emission (property 4), and a stop / park
    /// drops the entry from the schedule without any thread to tear
    /// down.
    pub fn fire_info(&mut self, id: &str) -> Option<(TransmitRequest, u32)> {
        let e = self.entries.iter_mut().find(|e| e.frame.id == id)?;
        if !e.running || e.frame.mode != TransmitMode::Periodic || e.frame.cycle_ms == 0 {
            return None;
        }
        let cycle_ms = e.frame.cycle_ms;
        Some((e.prepare_send(), cycle_ms))
    }

    /// Install the resolved calculated-fields config for `id` —
    /// called at registration and again whenever the DBC set changes
    /// (resolution depends on the DBC's signal placements). `None`
    /// clears it (no fields, or resolution failed). The counter's
    /// runtime value is preserved: re-resolving mid-run must not
    /// restart the sequence.
    pub fn set_resolved_calc(&mut self, id: &str, resolved: Option<ResolvedCalculatedFields>) {
        if let Some(i) = self.position(id) {
            self.entries[i].resolved_calc = resolved;
        }
    }

    /// Re-seed `id`'s sequence counter to 0 — its owner is starting to
    /// transmit (ADR 0027). Distinct from [`Self::begin_periodic`]
    /// because an RBS mute/unmute mid-run resumes the counter
    /// (ADR 0028): only the *owner's* start resets.
    pub fn reset_counter(&mut self, id: &str) {
        if let Some(i) = self.position(id) {
            self.entries[i].counter = 0;
        }
    }

    /// Everything resolution needs, for every entry: `(id, request,
    /// calc override spec)`. Snapshot shape so the caller can resolve
    /// against the DBC set and write back via
    /// [`Self::set_resolved_calc`].
    #[must_use]
    pub fn resolution_inputs(&self) -> Vec<(String, TransmitRequest, Option<CalcFieldsSpec>)> {
        self.entries
            .iter()
            .map(|e| (e.frame.id.clone(), e.frame.request.clone(), e.frame.calc.clone()))
            .collect()
    }

    /// Insert a new message or update an existing one in place. If the
    /// update parks the message (`Manual` mode or `cycle_ms == 0`), it
    /// is marked stopped; the scheduler drops it on its next tick (the
    /// command layer also sends an explicit unschedule so it stops
    /// promptly). A non-parking edit to a running periodic (e.g. a
    /// payload change) keeps it running — and keeps its counter, so a
    /// live edit doesn't restart the sequence. The caller re-resolves
    /// the calculated fields after a `set` (the edit may have changed
    /// the calc spec, bus, or id).
    pub fn set(&mut self, frame: TransmitFrame) {
        if let Some(i) = self.position(&frame.id) {
            let entry = &mut self.entries[i];
            let parked = frame.mode != TransmitMode::Periodic || frame.cycle_ms == 0;
            entry.frame = frame;
            if parked {
                entry.stop_periodic();
            }
        } else {
            self.entries.push(Entry::new(frame));
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
    /// `open_project`. Existing periodics are stopped first. Counters
    /// seed at 0; calculated-field resolution is the caller's next
    /// step (it needs the DBC set).
    pub fn load(&mut self, frames: Vec<TransmitFrame>) {
        self.clear();
        self.entries = frames.into_iter().map(Entry::new).collect();
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
            source: TransmitSource::Project,
            calc: None,
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

    /// A DBC whose `Status` message carries a 4-bit counter (byte 6
    /// low nibble) and an 8-bit CRC (byte 7) — the calc fixture for
    /// the fire-path tests.
    const CALC_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
        BO_ 256 Status: 8 ECU\n\
        \x20SG_ Mode : 0|8@1+ (1,0) [0|255] \"\" ECU\n\
        \x20SG_ AliveCtr : 48|4@1+ (1,0) [0|15] \"\" ECU\n\
        \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n";

    fn resolved_calc() -> ResolvedCalculatedFields {
        let db = cannet_dbc::Database::parse(CALC_DBC).unwrap();
        let config = cannet_dbc::CalculatedFieldsConfig {
            counter: Some(cannet_dbc::CounterConfig::new("AliveCtr")),
            crc: Some(cannet_dbc::CrcConfig {
                signal: "Crc8".into(),
                algorithm: cannet_dbc::CrcAlgorithm::Named("CRC-8/SAE-J1850".into()),
                range_bits: (0, 56),
                prefix: vec![],
            }),
        };
        db.resolve_calculated_fields(cannet_core::CanId::standard(256).unwrap(), &config)
            .unwrap()
    }

    fn frame_with_payload(id: &str, cycle_ms: u32) -> TransmitFrame {
        TransmitFrame {
            request: TransmitRequest {
                data: vec![0x42, 0, 0, 0, 0, 0, 0, 0],
                ..req("p", 256)
            },
            ..frame(id, "p", 256, TransmitMode::Periodic, cycle_ms)
        }
    }

    #[test]
    fn rbs_provenance_is_excluded_from_panel_list_and_project_snapshot() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame("a", "p", 0x100, TransmitMode::Manual, 0));
        reg.set(TransmitFrame {
            source: TransmitSource::Rbs("element-1".into()),
            ..frame("rbs:element-1:x", "p", 0x200, TransmitMode::Periodic, 10)
        });
        // The panel list and the project snapshot see only the
        // project-owned message (ADR 0028 provenance).
        assert_eq!(reg.list().len(), 1);
        assert_eq!(reg.list()[0].frame.id, "a");
        assert_eq!(reg.snapshot().len(), 1);
        assert_eq!(reg.snapshot()[0].id, "a");
        // But the RBS entry exists and fires like any other.
        assert!(reg.begin_periodic("rbs:element-1:x").unwrap());
        assert!(reg.fire_info("rbs:element-1:x").is_some());
    }

    #[test]
    fn fire_info_applies_calculated_fields_into_the_buffer() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame_with_payload("a", 100));
        reg.set_resolved_calc("a", Some(resolved_calc()));
        assert!(reg.begin_periodic("a").unwrap());

        let (first, _) = reg.fire_info("a").unwrap();
        // Counter stepped 0 → 1 and landed in byte 6's low nibble.
        assert_eq!(first.data[6] & 0x0F, 1);
        // The CRC matches what the engine itself verifies.
        let outcome = resolved_calc().verify(&first.data, None);
        assert!(outcome.violations.is_empty());

        let (second, _) = reg.fire_info("a").unwrap();
        assert_eq!(second.data[6] & 0x0F, 2);
        let outcome = resolved_calc().verify(&second.data, Some(1));
        assert!(outcome.violations.is_empty());
        // The entry's own buffer carries the last-applied values (the
        // buffer is the source of truth, ADR 0017).
        assert_eq!(reg.list()[0].frame.request.data[6] & 0x0F, 2);
    }

    #[test]
    fn manual_send_request_recomputes_fields_too() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(TransmitFrame {
            mode: TransmitMode::Manual,
            ..frame_with_payload("a", 0)
        });
        reg.set_resolved_calc("a", Some(resolved_calc()));
        let first = reg.send_request("a").unwrap();
        let second = reg.send_request("a").unwrap();
        assert_eq!(first.data[6] & 0x0F, 1);
        assert_eq!(second.data[6] & 0x0F, 2);
        // Without a resolved config the request passes through as-is.
        reg.set_resolved_calc("a", None);
        let third = reg.send_request("a").unwrap();
        assert_eq!(third.data, second.data);
    }

    #[test]
    fn reset_counter_reseeds_but_edits_and_restarts_do_not() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(frame_with_payload("a", 100));
        reg.set_resolved_calc("a", Some(resolved_calc()));
        assert!(reg.begin_periodic("a").unwrap());
        reg.fire_info("a").unwrap();
        reg.fire_info("a").unwrap();

        // An in-place edit keeps the counter (live edit semantics) …
        reg.set(frame_with_payload("a", 50));
        reg.set_resolved_calc("a", Some(resolved_calc()));
        let (after_edit, _) = reg.fire_info("a").unwrap();
        assert_eq!(after_edit.data[6] & 0x0F, 3);

        // … and a stop → start (mute / unmute) resumes it (ADR 0028).
        reg.stop_periodic("a");
        assert!(reg.begin_periodic("a").unwrap());
        let (after_restart, _) = reg.fire_info("a").unwrap();
        assert_eq!(after_restart.data[6] & 0x0F, 4);

        // Only the owner's explicit reset re-seeds at 0.
        reg.reset_counter("a");
        let (after_reset, _) = reg.fire_info("a").unwrap();
        assert_eq!(after_reset.data[6] & 0x0F, 1);
    }

    #[test]
    fn too_short_buffer_sends_unmodified_instead_of_dropping() {
        let mut reg = TransmitFrameRegistry::default();
        reg.set(TransmitFrame {
            request: TransmitRequest { data: vec![1, 2], ..req("p", 256) },
            ..frame("a", "p", 256, TransmitMode::Periodic, 100)
        });
        reg.set_resolved_calc("a", Some(resolved_calc()));
        assert!(reg.begin_periodic("a").unwrap());
        let (request, _) = reg.fire_info("a").unwrap();
        assert_eq!(request.data, vec![1, 2], "best-effort: bytes pass through");
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
