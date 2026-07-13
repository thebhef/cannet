//! Pure model pieces for the signal view panel: bus-scoped descriptor
//! enumeration, the canonical signal path
//! ([ADR 0038](../../../docs/adr/0038-canonical-signal-path.md)),
//! host-side selection (manual keys + regex patterns), and host-side
//! row sort. The orchestration that joins these to the trace store —
//! latest values, mux groups, statistics — lives in `fetch_signal_page`
//! (lib.rs), next to its by-id sibling.

use std::collections::HashMap;

use cannet_dbc::{Database, SignalDescriptor};

use crate::ipc::{SignalSelection, SignalSnapshotRecord};

/// Expand every loaded DBC's signals across its bus scope: explicit
/// `buses` scoping wins, an unscoped DBC applies to every project bus,
/// and with no project buses at all everything collapses to
/// `bus_id: None` (the early-bring-up degenerate state). Sorted and
/// deduped on the descriptor key `(bus, message id, extended, signal
/// name)` — the shared enumeration behind `list_signals` and
/// `fetch_signal_page`, so the picker catalog and the snapshot rows
/// can't disagree about what exists.
pub fn scoped_descriptors<'a>(
    dbs: impl IntoIterator<Item = (&'a Database, &'a [String])>,
    project_buses: &[String],
) -> Vec<(Option<String>, SignalDescriptor)> {
    let mut out: Vec<(Option<String>, SignalDescriptor)> = Vec::new();
    for (db, buses) in dbs {
        let scope: Vec<Option<String>> = if !buses.is_empty() {
            buses.iter().map(|b| Some(b.clone())).collect()
        } else if !project_buses.is_empty() {
            project_buses.iter().map(|b| Some(b.clone())).collect()
        } else {
            vec![None]
        };
        for d in db.signals() {
            for bus_id in &scope {
                out.push((bus_id.clone(), d.clone()));
            }
        }
    }
    out.sort_by(|a, b| descriptor_key(a).cmp(&descriptor_key(b)));
    out.dedup_by(|a, b| descriptor_key(a) == descriptor_key(b));
    out
}

/// The descriptor identity `(bus, message id, extended, signal name)`
/// as a borrowing sort/dedup key.
fn descriptor_key(
    (bus, d): &(Option<String>, SignalDescriptor),
) -> (Option<&str>, u32, bool, &str) {
    (
        bus.as_deref(),
        d.message_id,
        d.extended,
        d.signal_name.as_str(),
    )
}

/// The canonical signal path `bus/ecu/message/signal` (ADR 0038) — the
/// one regex/fzf/display subject app-wide. Segments are the DBC names
/// verbatim; a missing bus or transmitter renders an empty segment so
/// segment positions stay fixed for patterns.
#[must_use]
pub fn signal_path(
    bus_name: Option<&str>,
    transmitter: Option<&str>,
    message: &str,
    signal: &str,
) -> String {
    format!(
        "{}/{}/{message}/{signal}",
        bus_name.unwrap_or(""),
        transmitter.unwrap_or("")
    )
}

/// Filter `all` (from [`scoped_descriptors`]) down to the selection:
/// a descriptor is kept when it matches a manual key or any regex
/// pattern against its canonical path. Returns indices into `all` (in
/// `all`'s order — the deterministic default row order). An invalid
/// pattern is an `Err` with the compile error — surfaced as a panel
/// error, never a crash.
pub fn select_descriptors(
    all: &[(Option<String>, SignalDescriptor)],
    selection: &SignalSelection,
    bus_names: &HashMap<String, String>,
) -> Result<Vec<usize>, String> {
    let patterns: Vec<regex::Regex> = selection
        .patterns
        .iter()
        .map(|p| regex::Regex::new(p).map_err(|e| format!("invalid pattern /{p}/: {e}")))
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for (i, (bus, d)) in all.iter().enumerate() {
        let manual = selection.keys.iter().any(|k| {
            k.bus_id.as_deref() == bus.as_deref()
                && k.message_id == d.message_id
                && k.extended == d.extended
                && k.signal_name == d.signal_name
        });
        let by_pattern = !patterns.is_empty() && {
            let bus_name = bus
                .as_deref()
                .map(|id| bus_names.get(id).map_or(id, String::as_str));
            let path = signal_path(
                bus_name,
                d.transmitter.as_deref(),
                &d.message_name,
                &d.signal_name,
            );
            patterns.iter().any(|re| re.is_match(&path))
        };
        if manual || by_pattern {
            out.push(i);
        }
    }
    Ok(out)
}

/// Sort snapshot rows host-side by one column (the signal-view analog
/// of `sort_by_id`): stable, `None` key keeps the input (descriptor)
/// order, and rows blank on the sorted column sort last in *either*
/// direction — a dead signal shouldn't lead the table just because the
/// sort flipped.
pub fn sort_rows(
    rows: &mut [SignalSnapshotRecord],
    key: Option<&str>,
    dir: Option<&str>,
    bus_names: &HashMap<String, String>,
) {
    let Some(key) = key else { return };
    let desc = dir == Some("desc");
    rows.sort_by(|a, b| {
        let blanks = row_key_blank(a, key).cmp(&row_key_blank(b, key));
        blanks.then_with(|| {
            let c = row_cmp(a, b, key, bus_names);
            if desc {
                c.reverse()
            } else {
                c
            }
        })
    });
}

/// Whether the row is blank on the sorted column (only the
/// window-dependent columns can be).
fn row_key_blank(r: &SignalSnapshotRecord, key: &str) -> bool {
    match key {
        "value" => r.value.is_none(),
        "time" => r.time_seconds.is_none(),
        "rate" => r.rate.is_none(),
        "count" => r.count.is_none(),
        _ => false,
    }
}

/// Compare two rows by one column's value. Unknown key compares equal.
fn row_cmp(
    a: &SignalSnapshotRecord,
    b: &SignalSnapshotRecord,
    key: &str,
    names: &HashMap<String, String>,
) -> std::cmp::Ordering {
    let bus_key = |r: &SignalSnapshotRecord| match &r.bus_id {
        None => "~".to_string(),
        Some(id) => names.get(id).cloned().unwrap_or_else(|| id.clone()),
    };
    let ecu_key = |r: &SignalSnapshotRecord| r.transmitter.clone().unwrap_or_else(|| "~".into());
    match key {
        "bus" => bus_key(a).cmp(&bus_key(b)),
        "ecu" => ecu_key(a).cmp(&ecu_key(b)),
        "msg" => a.message_name.cmp(&b.message_name),
        "signal" => a.signal_name.cmp(&b.signal_name),
        "unit" => a.unit.cmp(&b.unit),
        "time" => cmp_opt_f64(a.time_seconds, b.time_seconds),
        "rate" => cmp_opt_f64(a.rate, b.rate),
        "count" => a.count.cmp(&b.count),
        // Numeric on the physical value; enum-vs-enum by raw (the
        // VAL_ key), so symbolic signals order by their table.
        "value" => {
            if a.is_enum && b.is_enum {
                a.raw.cmp(&b.raw)
            } else {
                cmp_opt_f64(a.value, b.value)
            }
        }
        _ => std::cmp::Ordering::Equal,
    }
}

fn cmp_opt_f64(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.total_cmp(&y),
        // Blanks are pre-separated by `row_key_blank`; tie here.
        _ => std::cmp::Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::SignalQuery;

    const TWO_ECU_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Bms Vcu\n\n\
        BO_ 256 PackStatus: 8 Bms\n SG_ PackVolts : 0|16@1+ (0.1,0) [0|0] \"V\" Vcu\n SG_ PackTemp : 16|8@1+ (1,-40) [0|0] \"degC\" Vcu\n\n\
        BO_ 257 DriveCmd: 8 Vcu\n SG_ TorqueReq : 0|16@1+ (0.5,0) [0|0] \"Nm\" Bms\n";

    fn db() -> Database {
        Database::parse(TWO_ECU_DBC).unwrap()
    }

    fn all_on(buses: &[&str]) -> Vec<(Option<String>, SignalDescriptor)> {
        let db = db();
        let scoped: Vec<String> = buses.iter().map(|s| (*s).to_string()).collect();
        scoped_descriptors([(&db, scoped.as_slice())], &[])
    }

    fn key(bus: Option<&str>, id: u32, name: &str) -> SignalQuery {
        SignalQuery {
            bus_id: bus.map(Into::into),
            message_id: id,
            extended: false,
            signal_name: name.into(),
        }
    }

    fn blank_row(signal: &str) -> SignalSnapshotRecord {
        SignalSnapshotRecord {
            bus_id: None,
            transmitter: None,
            message_id: 0,
            extended: false,
            message_name: "M".into(),
            signal_name: signal.into(),
            unit: String::new(),
            is_enum: false,
            value: None,
            raw: None,
            label: None,
            rate: None,
            count: None,
            time_seconds: None,
        }
    }

    #[allow(clippy::cast_possible_truncation)] // test values are small integers
    fn valued_row(signal: &str, value: f64) -> SignalSnapshotRecord {
        SignalSnapshotRecord {
            value: Some(value),
            raw: Some(value as i64),
            count: Some(1),
            ..blank_row(signal)
        }
    }

    #[test]
    fn scoped_descriptors_expand_per_bus_and_dedup() {
        // Two buses in scope → each signal appears once per bus.
        let all = all_on(&["chassis", "power"]);
        assert_eq!(all.len(), 6); // 3 signals × 2 buses
                                  // Unscoped DBC + no project buses → the None-bus degenerate.
        let db = db();
        let all = scoped_descriptors([(&db, &[] as &[String])], &[]);
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|(b, _)| b.is_none()));
    }

    #[test]
    fn signal_path_keeps_segment_positions_fixed() {
        assert_eq!(
            signal_path(Some("power"), Some("Bms"), "PackStatus", "PackVolts"),
            "power/Bms/PackStatus/PackVolts",
        );
        // No transmitter / no bus: empty segments, positions unchanged.
        assert_eq!(signal_path(None, None, "M", "S"), "//M/S");
    }

    #[test]
    fn selection_matches_manual_keys_and_patterns_or_combined() {
        let all = all_on(&["power"]);
        let names: HashMap<String, String> =
            [("power".to_string(), "Powertrain".to_string())].into();
        // Regex against the canonical path — bus segment is the *name*.
        let sel = SignalSelection {
            keys: vec![key(Some("power"), 257, "TorqueReq")],
            patterns: vec!["^Powertrain/Bms/".to_string()],
        };
        let hit = select_descriptors(&all, &sel, &names).unwrap();
        let picked: Vec<&str> = hit.iter().map(|&i| all[i].1.signal_name.as_str()).collect();
        // Pattern catches both Bms-sent PackStatus signals; the manual
        // key adds TorqueReq. Deduped, in descriptor order.
        assert_eq!(picked, vec!["PackTemp", "PackVolts", "TorqueReq"]);
    }

    #[test]
    fn selection_rejects_invalid_patterns_as_error() {
        let all = all_on(&["power"]);
        let sel = SignalSelection {
            keys: vec![],
            patterns: vec!["([unclosed".to_string()],
        };
        let err = select_descriptors(&all, &sel, &HashMap::new()).unwrap_err();
        assert!(err.contains("invalid pattern"), "got: {err}");
    }

    #[test]
    fn selection_key_on_one_bus_does_not_match_another() {
        let all = all_on(&["chassis", "power"]);
        let sel = SignalSelection {
            keys: vec![key(Some("power"), 256, "PackVolts")],
            patterns: vec![],
        };
        let hit = select_descriptors(&all, &sel, &HashMap::new()).unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(all[hit[0]].0.as_deref(), Some("power"));
    }

    #[test]
    fn sort_rows_orders_values_numerically_with_blanks_last() {
        let mut rows = vec![
            valued_row("b", 10.0),
            blank_row("dead"),
            valued_row("a", -2.5),
            valued_row("c", 3.0),
        ];
        sort_rows(&mut rows, Some("value"), Some("asc"), &HashMap::new());
        let order: Vec<&str> = rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(order, vec!["a", "c", "b", "dead"]);
        // Descending flips the values but blanks stay last.
        sort_rows(&mut rows, Some("value"), Some("desc"), &HashMap::new());
        let order: Vec<&str> = rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(order, vec!["b", "c", "a", "dead"]);
    }

    #[test]
    fn sort_rows_orders_enums_by_raw() {
        let mut a = valued_row("a", 100.0); // physical 100, raw 2
        a.is_enum = true;
        a.raw = Some(2);
        let mut b = valued_row("b", 1.0); // physical 1, raw 7
        b.is_enum = true;
        b.raw = Some(7);
        let mut rows = vec![b, a];
        sort_rows(&mut rows, Some("value"), Some("asc"), &HashMap::new());
        let order: Vec<&str> = rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(order, vec!["a", "b"]); // raw 2 before raw 7
    }
}
