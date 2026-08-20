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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cannet_core::{CanFramePayload, Direction};
use cannet_dbc::{CalculatedFieldsConfig, FieldViolation, ResolvedCalculatedFields};
use tauri::AppHandle;

use crate::app_state::LoadedDbc;
use crate::sys_debug;
use crate::trace_store::RawTraceFrame;

/// Minimum spacing of valid→invalid Info messages per `(bus, id)`.
const TRANSITION_LOG_INTERVAL: Duration = Duration::from_secs(1);

/// A configured `(bus, raw id, extended)`. The bus is required, and is
/// a bus the declaring database is *assigned to*: assignment governs
/// decode ([`crate::filter::dbc_applies`]), so a database assigned to no
/// bus declares no configuration and there is no any-bus wildcard to
/// fall back to. Distinct from [`RuntimeKey`] all the same — this bus
/// comes from a database's assignment, that one from a frame.
type ConfigKey = (String, u32, bool);

/// The `(bus, raw id, extended)` counter continuity and validity are
/// tracked per. The bus is required: a frame enters through one, and
/// one whose channel maps to no bus never reaches the ingest path.
type RuntimeKey = (String, u32, bool);

/// Shared verification state. One instance on `AppState`.
#[derive(Default)]
pub struct VerificationState {
    /// Whether `inner.configs` currently holds anything — the lock-free
    /// gate [`Self::wants`] consults before reaching for the mutex.
    ///
    /// Written only by [`Self::rebuild_configs`], under the mutex.
    /// `Relaxed` is sufficient: a read that catches a rebuild in flight
    /// makes a config apply one frame later or a removal take effect one
    /// frame later, which is exactly the module's stated "config changes
    /// apply from that point forward" semantics. The authoritative check
    /// is still the hash probe under the lock.
    configured: AtomicBool,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Resolved configs per `(bus scope, id)`.
    configs: HashMap<ConfigKey, ResolvedCalculatedFields>,
    /// Counter continuity per `(actual bus, id)`.
    counters: HashMap<RuntimeKey, u64>,
    /// Sparse violation index: frame index → kind.
    violations: HashMap<u64, &'static str>,
    /// Current validity per `(actual bus, id)` + the last time an
    /// invalid transition was logged.
    validity: HashMap<RuntimeKey, Validity>,
}

struct Validity {
    valid: bool,
    last_logged: Option<Instant>,
}

/// One row of the validity query.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ValidityRecord {
    /// The bus the frames were seen on. Always present — this is a
    /// frame's bus, not a database's scope.
    pub bus_id: String,
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
        let mut configs: HashMap<ConfigKey, ResolvedCalculatedFields> = HashMap::new();

        // DBC-declared defaults: one entry per bus the database is
        // assigned to, and none at all for one assigned to no bus —
        // it decodes nothing, so it declares nothing. First DBC wins
        // per key (matching the decode path's first-match-wins).
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
                for bus in &loaded.buses {
                    configs
                        .entry((bus.clone(), id, extended))
                        .or_insert_with(|| resolved.clone());
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
                .filter(|d| crate::filter::dbc_applies(&d.buses, Some(bus.as_str())))
                .find(|d| d.db.dbc_calculated_fields(can_id).is_some())
            else {
                continue;
            };
            if let Ok(resolved) = loaded.db.resolve_calculated_fields(can_id, config) {
                configs.insert((bus.clone(), *id, *extended), resolved);
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
        self.configured
            .store(!configs.is_empty(), Ordering::Relaxed);
        inner.configs = configs;
    }

    /// Whether `frame`'s `(bus, id)` has a verification config at all
    /// — the per-frame fast-path probe the pump uses to decide if the
    /// frame is worth cloning for [`Self::observe`]. Tx frames never
    /// want verification.
    ///
    /// Runs on the ingest path, once per frame, so it does no work
    /// before it has to: with no calculated-field config loaded at all
    /// — the state of every project that declares none, and of every
    /// project before its DBCs load — it takes **no lock**, on the
    /// `configured` flag alone. The bus-scoped key allocates, so the
    /// allocation-free any-bus wildcard is probed first (the answer is
    /// the same either way — this is an `or`).
    #[must_use]
    pub fn wants(&self, frame: &RawTraceFrame) -> bool {
        if frame.direction == Direction::Tx || !self.configured.load(Ordering::Relaxed) {
            return false;
        }
        let Some(bus) = frame.bus_id.clone() else {
            return false;
        };
        let inner = self.inner.lock().expect("verification mutex poisoned");
        let key: ConfigKey = (bus, frame.id, frame.extended);
        inner.configs.contains_key(&key)
    }

    /// Verify one just-ingested frame. Cheap for unconfigured ids —
    /// two hash probes. `index` is the frame's absolute trace index.
    /// Own transmissions (`Direction::Tx`) are exempt.
    pub fn observe(&self, app: &AppHandle, frame: &RawTraceFrame, index: u64) {
        if let Some(kind) = self.observe_inner(frame, index) {
            // `observe_inner` only returns `Some` for a frame it keyed,
            // which means it had a bus.
            let bus = frame.bus_id.as_deref().unwrap_or_default();
            sys_debug!(
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

        // The bus the frame arrived on: what the runtime state is keyed
        // on, and half of the config lookup.
        let bus = frame.bus_id.clone()?;

        let mut inner = self.inner.lock().expect("verification mutex poisoned");
        // The configuration of the bus this frame arrived on, declared
        // by a database assigned to it. There is no wildcard: a
        // database assigned to no bus configures nothing.
        let cfg_key: ConfigKey = (bus.clone(), frame.id, frame.extended);
        let config = inner.configs.get(&cfg_key)?;

        let seen: RuntimeKey = (bus, frame.id, frame.extended);
        let prev = inner.counters.get(&seen).copied();
        let outcome = config.verify(data, prev);
        if let Some(counter) = outcome.counter {
            inner.counters.insert(seen.clone(), counter);
        }

        if outcome.violations.is_empty() {
            if let Some(v) = inner.validity.get_mut(&seen) {
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
        let entry = inner.validity.entry(seen).or_insert(Validity {
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

    /// A configured state whose database is assigned to `buses`. There
    /// is no "assigned to nothing" flavour: such a database configures
    /// nothing, which is [`a_database_assigned_to_no_bus_configures_nothing`].
    fn state_with_config(buses: &[&str]) -> VerificationState {
        let state = VerificationState::default();
        let loaded = crate::tests::loaded_scoped("v.dbc", VERIFY_DBC, buses);
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
        let state = state_with_config(&["p"]);
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
        let state = state_with_config(&["p"]);
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
        let state = state_with_config(&["p"]);
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

    /// `wants` runs on every ingested frame. With nothing configured it
    /// must not so much as touch the mutex, or a project that declares
    /// no calculated fields still pays a lock acquisition per frame —
    /// contending with whatever else holds it.
    ///
    /// Proved by holding the mutex and asking from another thread: an
    /// answer that arrives while the lock is held is an answer that
    /// didn't need it. Once a config is installed, `wants` does need the
    /// lock, and the same probe blocks — which is what makes the first
    /// half of the assertion mean something.
    #[test]
    fn wants_answers_without_the_lock_until_something_is_configured() {
        use std::sync::mpsc;
        use std::sync::Arc;

        // Asymmetric waits, so neither assertion can fail spuriously: a
        // slow machine only delays an answer that is coming (hence the
        // generous wait where one is expected), and a wait that expects a
        // timeout can only be *shortened* into a false pass, never a
        // false failure.
        fn ask(state: &Arc<VerificationState>, wait: Duration) -> Result<bool, ()> {
            let (tx, rx) = mpsc::channel();
            let s = Arc::clone(state);
            std::thread::spawn(move || {
                let _ = tx.send(s.wants(&rx_frame(Some("p"), vec![0u8; 8])));
            });
            rx.recv_timeout(wait).map_err(|_| ())
        }
        let answered = Duration::from_secs(5);
        let blocked = Duration::from_millis(200);

        let state = Arc::new(VerificationState::default());
        let held = state.inner.lock().expect("verification mutex poisoned");
        assert_eq!(
            ask(&state, answered),
            Ok(false),
            "unconfigured: answered lock-free"
        );
        drop(held);

        // Same probe, now with a config loaded: the answer needs the map,
        // so holding the lock withholds it.
        let loaded = crate::tests::loaded_scoped("v.dbc", VERIFY_DBC, &["p"]);
        state.rebuild_configs(&[loaded], &[]);
        assert_eq!(
            ask(&state, answered),
            Ok(true),
            "configured id wants verification"
        );
        let held = state.inner.lock().expect("verification mutex poisoned");
        assert_eq!(
            ask(&state, blocked),
            Err(()),
            "configured: the answer comes from behind the lock",
        );
        drop(held);
    }

    /// The runtime state — counter continuity and validity — is keyed
    /// on the bus a frame *arrived on*, which is always a real bus: a
    /// frame enters through one, and one whose channel maps to no bus
    /// never reaches the ingest path. That is a different thing from
    /// the config map's key, which names a bus a *database* is assigned
    /// to, and the snapshot names the frame's bus outright rather than
    /// carrying an "unknown" case.
    #[test]
    fn runtime_state_is_keyed_on_the_bus_the_frame_arrived_on() {
        let state = state_with_config(&["p", "c"]);
        let frames = valid_payloads(3);
        // Interleaved, but each bus sees its own in-order sequence.
        for (i, payload) in frames.iter().enumerate() {
            let i = i as u64 * 2;
            observe_quiet(&state, &rx_frame(Some("p"), payload.clone()), i);
            observe_quiet(&state, &rx_frame(Some("c"), payload.clone()), i + 1);
        }
        assert!(
            state.violations_in(0, 100).is_empty(),
            "each bus keeps its own counter continuity",
        );

        let mut bad = frames[0].clone();
        bad[2] ^= 1; // corrupt a CRC-covered byte
        observe_quiet(&state, &rx_frame(Some("p"), bad.clone()), 10);
        observe_quiet(&state, &rx_frame(Some("c"), bad), 11);

        let snap = state.validity_snapshot();
        assert_eq!(
            snap.iter().map(|r| r.bus_id.as_str()).collect::<Vec<_>>(),
            vec!["c", "p"],
        );
        assert!(snap.iter().all(|r| !r.valid));
    }

    #[test]
    fn a_database_assigned_to_no_bus_configures_nothing() {
        // Assignment governs decode, and a calculated-field declaration
        // is decode: an unassigned database declares no configuration,
        // so nothing is checked on any bus.
        let state = state_with_config(&[]);
        let garbage = vec![0xAAu8; 8];
        observe_quiet(&state, &rx_frame(Some("p"), garbage.clone()), 0);
        observe_quiet(&state, &rx_frame(Some("q"), garbage), 1);
        assert!(state.violations_in(0, 10).is_empty());
        assert!(!state.wants(&rx_frame(Some("p"), vec![0u8; 8])));
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
            &[crate::tests::loaded_scoped(
                "v.dbc",
                VERIFY_DBC,
                &["p", "z"],
            )],
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
