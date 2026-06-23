//! Ingest-time verification of received calculated fields (ADR 0027).
//!
//! Received frames on a `(bus, message id)` with a calculated-field
//! config — the DBC's `CannetCounter` / `CannetCrc` attributes, with
//! any RBS per-message override layered on top — are verified
//! **host-side at ingest**, not at view time: counter continuity needs
//! the previous frame of that id, and a paged viewport doesn't have
//! it. CRC verification is stateless; counter verification keeps
//! per-`(bus, id)` last-value state (first sighting seeds, then each
//! frame must equal `prev + increment (mod rollover + 1)`).
//!
//! Findings land in a sparse index (frame index → kind) the trace
//! fetch path decorates rows from; per-`(bus, id)` validity is
//! queryable; a valid→invalid transition logs one Info system
//! message, rate-limited per id. Frames cannet itself transmitted are
//! exempt (we computed the fields). Config changes apply from that
//! point forward — no retroactive re-verification.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cannet_core::{CanFramePayload, Direction};
use cannet_dbc::{CalculatedFieldsConfig, FieldViolation, ResolvedCalculatedFields};
use tauri::AppHandle;

use crate::trace_store::RawTraceFrame;
use crate::{sys_info, LoadedDbc};

/// Minimum spacing of valid→invalid Info messages per `(bus, id)`.
const TRANSITION_LOG_INTERVAL: Duration = Duration::from_secs(1);

/// `(bus scope, raw id, extended)`. A `None` bus in the *config* map
/// means "any bus" (the declaring DBC is unscoped); in the *runtime*
/// maps it keys frames that arrived with no bus assigned.
type Key = (Option<String>, u32, bool);

/// Shared verification state. One instance on `AppState`.
#[derive(Default)]
pub struct VerificationState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Resolved configs per `(bus scope, id)`.
    configs: HashMap<Key, ResolvedCalculatedFields>,
    /// Counter continuity per `(actual bus, id)`.
    counters: HashMap<Key, u64>,
    /// Sparse violation index: frame index → kind.
    violations: HashMap<u64, &'static str>,
    /// Current validity per `(actual bus, id)` + the last time an
    /// invalid transition was logged.
    validity: HashMap<Key, Validity>,
}

struct Validity {
    valid: bool,
    last_logged: Option<Instant>,
}

/// One row of the validity query.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ValidityRecord {
    pub bus_id: Option<String>,
    pub id: u32,
    pub extended: bool,
    pub valid: bool,
}

impl VerificationState {
    /// Rebuild the config index from the loaded DBC set plus the RBS
    /// elements' per-message overrides. Counter / validity state for
    /// keys that keep a config is preserved (a DBC reload doesn't
    /// reset continuity); keys whose config disappeared are dropped.
    pub fn rebuild_configs(
        &self,
        dbs: &[LoadedDbc],
        rbs_overrides: &[(String, u32, bool, CalculatedFieldsConfig)],
    ) {
        let mut configs: HashMap<Key, ResolvedCalculatedFields> = HashMap::new();

        // DBC-declared defaults: one entry per scoped bus, or a
        // wildcard (`None`) for an unscoped DBC. First DBC wins per
        // key (matching the decode path's first-match-wins).
        for loaded in dbs {
            for (id, extended, config) in loaded.db.calculated_field_messages() {
                let can_id = if extended {
                    cannet_core::CanId::extended(id)
                } else {
                    cannet_core::CanId::standard(id)
                };
                let Ok(can_id) = can_id else { continue };
                let Ok(resolved) = loaded.db.resolve_calculated_fields(can_id, config) else {
                    // Malformed designation — already warned at load.
                    continue;
                };
                if loaded.buses.is_empty() {
                    configs
                        .entry((None, id, extended))
                        .or_insert_with(|| resolved.clone());
                } else {
                    for bus in &loaded.buses {
                        configs
                            .entry((Some(bus.clone()), id, extended))
                            .or_insert_with(|| resolved.clone());
                    }
                }
            }
        }

        // RBS overrides replace the DBC default for their (bus, id) —
        // the caller has already resolved them per-field against the
        // right DBC.
        for (bus, id, extended, config) in rbs_overrides {
            let can_id = if *extended {
                cannet_core::CanId::extended(*id)
            } else {
                cannet_core::CanId::standard(*id)
            };
            let Ok(can_id) = can_id else { continue };
            let Some(loaded) = dbs
                .iter()
                .filter(|d| d.buses.is_empty() || d.buses.iter().any(|b| b == bus))
                .find(|d| d.db.dbc_calculated_fields(can_id).is_some())
            else {
                continue;
            };
            if let Ok(resolved) = loaded.db.resolve_calculated_fields(can_id, config) {
                configs.insert((Some(bus.clone()), *id, *extended), resolved);
            }
        }

        let mut inner = self.inner.lock().expect("verification mutex poisoned");
        let live_ids: std::collections::HashSet<(u32, bool)> =
            configs.keys().map(|(_, id, ext)| (*id, *ext)).collect();
        inner
            .counters
            .retain(|(_, id, ext), _| live_ids.contains(&(*id, *ext)));
        inner
            .validity
            .retain(|(_, id, ext), _| live_ids.contains(&(*id, *ext)));
        inner.configs = configs;
    }

    /// Whether `frame`'s `(bus, id)` has a verification config at all
    /// — the per-frame fast-path probe the pump uses to decide if the
    /// frame is worth cloning for [`Self::observe`]. Tx frames never
    /// want verification.
    #[must_use]
    pub fn wants(&self, frame: &RawTraceFrame) -> bool {
        if frame.direction == Direction::Tx {
            return false;
        }
        let inner = self.inner.lock().expect("verification mutex poisoned");
        if inner.configs.is_empty() {
            return false;
        }
        let scoped: Key = (frame.bus_id.clone(), frame.id, frame.extended);
        let wildcard: Key = (None, frame.id, frame.extended);
        inner.configs.contains_key(&scoped) || inner.configs.contains_key(&wildcard)
    }

    /// Verify one just-ingested frame. Cheap for unconfigured ids —
    /// two hash probes. `index` is the frame's absolute trace index.
    /// Own transmissions (`Direction::Tx`) are exempt.
    pub fn observe(&self, app: &AppHandle, frame: &RawTraceFrame, index: u64) {
        if let Some(kind) = self.observe_inner(frame, index) {
            let bus = frame.bus_id.as_deref().unwrap_or("(unassigned)");
            sys_info!(
                app,
                "verify",
                "{bus} 0x{:X}: calculated-field check failed ({kind}) at frame {index}",
                frame.id
            );
        }
    }

    /// The pure core of [`Self::observe`]: run the checks, update
    /// state, and return `Some(kind)` exactly when a (rate-limited)
    /// valid→invalid transition message should be logged.
    fn observe_inner(&self, frame: &RawTraceFrame, index: u64) -> Option<&'static str> {
        if frame.direction == Direction::Tx {
            return None;
        }
        let data: &[u8] = match &frame.payload {
            CanFramePayload::Classic(d) => d,
            CanFramePayload::Fd { data, .. } => data,
            CanFramePayload::Remote { .. } | CanFramePayload::Error => return None,
        };

        let mut inner = self.inner.lock().expect("verification mutex poisoned");
        // Bus-scoped config first, then the any-bus wildcard.
        let scoped: Key = (frame.bus_id.clone(), frame.id, frame.extended);
        let wildcard: Key = (None, frame.id, frame.extended);
        let config = inner
            .configs
            .get(&scoped)
            .or_else(|| inner.configs.get(&wildcard))?;

        let prev = inner.counters.get(&scoped).copied();
        let outcome = config.verify(data, prev);
        if let Some(counter) = outcome.counter {
            inner.counters.insert(scoped.clone(), counter);
        }

        if outcome.violations.is_empty() {
            if let Some(v) = inner.validity.get_mut(&scoped) {
                v.valid = true;
            }
            return None;
        }

        let kind = match outcome.violations[0] {
            FieldViolation::CrcMismatch { .. } => "crc",
            FieldViolation::CounterSkip { .. } => "counter",
            FieldViolation::Truncated => "truncated",
        };
        inner.violations.insert(index, kind);

        let now = Instant::now();
        let entry = inner.validity.entry(scoped).or_insert(Validity {
            valid: true,
            last_logged: None,
        });
        let transitioned = entry.valid;
        entry.valid = false;
        let due = entry
            .last_logged
            .is_none_or(|t| now.duration_since(t) >= TRANSITION_LOG_INTERVAL);
        if transitioned && due {
            entry.last_logged = Some(now);
            return Some(kind);
        }
        None
    }

    /// The violations within `[start, end)` — what the trace fetch
    /// path decorates its rows from.
    #[must_use]
    pub fn violations_in(&self, start: u64, end: u64) -> Vec<(u64, &'static str)> {
        let inner = self.inner.lock().expect("verification mutex poisoned");
        // The violation index is sparse (violations are exceptional),
        // so scanning it beats scanning the range.
        let mut out: Vec<(u64, &'static str)> = inner
            .violations
            .iter()
            .filter(|(i, _)| (start..end).contains(*i))
            .map(|(i, k)| (*i, *k))
            .collect();
        out.sort_unstable_by_key(|(i, _)| *i);
        out
    }

    /// The violation kind for one frame, if any.
    #[must_use]
    pub fn violation_at(&self, index: u64) -> Option<&'static str> {
        self.inner
            .lock()
            .expect("verification mutex poisoned")
            .violations
            .get(&index)
            .copied()
    }

    /// Current validity per configured-and-seen `(bus, id)`.
    #[must_use]
    pub fn validity_snapshot(&self) -> Vec<ValidityRecord> {
        let inner = self.inner.lock().expect("verification mutex poisoned");
        let mut out: Vec<ValidityRecord> = inner
            .validity
            .iter()
            .map(|((bus, id, ext), v)| ValidityRecord {
                bus_id: bus.clone(),
                id: *id,
                extended: *ext,
                valid: v.valid,
            })
            .collect();
        out.sort_by(|a, b| (&a.bus_id, a.extended, a.id).cmp(&(&b.bus_id, b.extended, b.id)));
        out
    }

    /// Drop all runtime state (violations, counters, validity) but
    /// keep the configs — the trace was cleared, so frame indices and
    /// continuity are meaningless now.
    pub fn clear_runtime(&self) {
        let mut inner = self.inner.lock().expect("verification mutex poisoned");
        inner.violations.clear();
        inner.counters.clear();
        inner.validity.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERIFY_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
        BO_ 291 Status: 8 ECU\n\
        \x20SG_ Mode : 0|8@1+ (1,0) [0|255] \"\" ECU\n\
        \x20SG_ AliveCtr : 48|4@1+ (1,0) [0|15] \"\" ECU\n\
        \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n\n\
        BA_DEF_ SG_ \"CannetCounter\" STRING ;\n\
        BA_DEF_ SG_ \"CannetCrc\" STRING ;\n\
        BA_DEF_DEF_ \"CannetCounter\" \"\";\n\
        BA_DEF_DEF_ \"CannetCrc\" \"\";\n\
        BA_ \"CannetCounter\" SG_ 291 AliveCtr \"increment=1;rollover=15\";\n\
        BA_ \"CannetCrc\" SG_ 291 Crc8 \"alg=CRC-8/SAE-J1850;range=0:56\";\n";

    fn resolved() -> ResolvedCalculatedFields {
        let db = cannet_dbc::Database::parse(VERIFY_DBC).unwrap();
        let id = cannet_core::CanId::standard(291).unwrap();
        let config = db.dbc_calculated_fields(id).unwrap().clone();
        db.resolve_calculated_fields(id, &config).unwrap()
    }

    /// A valid frame sequence: counter stepped + CRC recomputed by the
    /// engine itself.
    fn valid_payloads(n: usize) -> Vec<Vec<u8>> {
        let resolved = resolved();
        let mut counter = 0u64;
        let mut payload = vec![0x42u8, 0, 0, 0, 0, 0, 0, 0];
        (0..n)
            .map(|_| {
                resolved.apply(&mut counter, &mut payload).unwrap();
                payload.clone()
            })
            .collect()
    }

    fn rx_frame(bus: Option<&str>, data: Vec<u8>) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: 0,
            channel: 0,
            id: 291,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(data),
            bus_id: bus.map(ToString::to_string),
        }
    }

    fn state_with_config(buses: &[&str]) -> VerificationState {
        let state = VerificationState::default();
        let loaded = if buses.is_empty() {
            crate::tests::loaded("v.dbc", VERIFY_DBC)
        } else {
            crate::tests::loaded_scoped("v.dbc", VERIFY_DBC, buses)
        };
        state.rebuild_configs(&[loaded], &[]);
        state
    }

    /// The tests drive the pure core (`observe_inner`); `observe`
    /// only adds the system-log emit on a returned transition.
    fn observe_quiet(state: &VerificationState, frame: &RawTraceFrame, index: u64) {
        let _ = state.observe_inner(frame, index);
    }

    #[test]
    fn valid_sequence_stays_clean_and_seeds_state() {
        let state = state_with_config(&[]);
        for (i, payload) in valid_payloads(4).into_iter().enumerate() {
            observe_quiet(&state, &rx_frame(Some("p"), payload), i as u64);
        }
        assert!(state.violations_in(0, 100).is_empty());
        let validity = state.validity_snapshot();
        // Clean traffic never creates a validity entry (it appears on
        // the first violation).
        assert!(validity.is_empty());
    }

    #[test]
    fn corruption_and_skip_paint_their_frames() {
        let state = state_with_config(&[]);
        let frames = valid_payloads(5);
        observe_quiet(&state, &rx_frame(Some("p"), frames[0].clone()), 0);
        // Corrupt a covered byte → CRC violation at index 1.
        let mut bad = frames[1].clone();
        bad[2] ^= 1;
        observe_quiet(&state, &rx_frame(Some("p"), bad), 1);
        // Skip frame 2 entirely; frame 3 is then out of sequence.
        observe_quiet(&state, &rx_frame(Some("p"), frames[3].clone()), 2);
        // Frame 4 follows 3 — continuity restored.
        observe_quiet(&state, &rx_frame(Some("p"), frames[4].clone()), 3);

        let violations = state.violations_in(0, 100);
        assert_eq!(violations.len(), 2, "{violations:?}");
        assert_eq!(violations[0], (1, "crc"));
        assert_eq!(violations[1], (2, "counter"));
        assert_eq!(state.violation_at(3), None, "re-seeded after the skip");

        // Validity reflects the latest state (frame 3 was clean).
        let validity = state.validity_snapshot();
        assert_eq!(validity.len(), 1);
        assert!(validity[0].valid);

        // The window query clips.
        assert_eq!(state.violations_in(2, 3), vec![(2, "counter")]);

        // Clearing the trace clears runtime but keeps configs.
        state.clear_runtime();
        assert!(state.violations_in(0, 100).is_empty());
        observe_quiet(&state, &rx_frame(Some("p"), frames[0].clone()), 0);
        assert!(
            state.violations_in(0, 100).is_empty(),
            "first sighting re-seeds instead of flagging"
        );
    }

    #[test]
    fn own_tx_and_unconfigured_ids_are_exempt() {
        let state = state_with_config(&[]);
        let mut tx = rx_frame(Some("p"), vec![0u8; 8]);
        tx.direction = Direction::Tx;
        // A Tx frame with garbage fields is never checked.
        observe_quiet(&state, &tx, 0);
        assert!(state.violations_in(0, 10).is_empty());
        // An id with no config is one hash probe and out.
        let mut other = rx_frame(Some("p"), vec![0u8; 8]);
        other.id = 0x700;
        observe_quiet(&state, &other, 1);
        assert!(state.violations_in(0, 10).is_empty());
    }

    #[test]
    fn bus_scoping_gates_which_frames_are_checked() {
        let state = state_with_config(&["q"]);
        // Garbage payload: violates if checked.
        let garbage = vec![0xAAu8; 8];
        observe_quiet(&state, &rx_frame(Some("p"), garbage.clone()), 0);
        assert!(state.violations_in(0, 10).is_empty(), "config scoped to q");
        observe_quiet(&state, &rx_frame(Some("q"), garbage), 1);
        assert_eq!(state.violations_in(0, 10).len(), 1);
    }

    #[test]
    fn rbs_override_replaces_the_dbc_config_for_its_bus() {
        let db = cannet_dbc::Database::parse(VERIFY_DBC).unwrap();
        let id = cannet_core::CanId::standard(291).unwrap();
        let dbc_config = db.dbc_calculated_fields(id).unwrap().clone();
        // Override: counter increments by 2 on bus "p".
        let override_config = cannet_dbc::CalculatedFieldsConfig {
            counter: Some(cannet_dbc::CounterConfig {
                signal: "AliveCtr".into(),
                increment: 2,
                rollover: Some(15),
            }),
            crc: dbc_config.crc.clone(),
        };
        let state = VerificationState::default();
        state.rebuild_configs(
            &[crate::tests::loaded("v.dbc", VERIFY_DBC)],
            &[("p".into(), 291, false, override_config)],
        );

        // Build traffic with the *override* engine (+2 steps).
        let resolved = db
            .resolve_calculated_fields(
                id,
                &cannet_dbc::CalculatedFieldsConfig {
                    counter: Some(cannet_dbc::CounterConfig {
                        signal: "AliveCtr".into(),
                        increment: 2,
                        rollover: Some(15),
                    }),
                    crc: dbc_config.crc.clone(),
                },
            )
            .unwrap();
        let mut counter = 0u64;
        let mut payload = vec![0u8; 8];
        for i in 0..3 {
            resolved.apply(&mut counter, &mut payload).unwrap();
            observe_quiet(&state, &rx_frame(Some("p"), payload.clone()), i);
        }
        assert!(
            state.violations_in(0, 10).is_empty(),
            "+2 traffic passes on the overridden bus"
        );
        // The same +2 traffic on another bus falls back to the DBC's
        // +1 config and trips the counter check.
        let mut counter = 0u64;
        let mut payload = vec![0u8; 8];
        for i in 10..13 {
            resolved.apply(&mut counter, &mut payload).unwrap();
            observe_quiet(&state, &rx_frame(Some("z"), payload.clone()), i);
        }
        assert!(!state.violations_in(10, 20).is_empty());
    }
}
