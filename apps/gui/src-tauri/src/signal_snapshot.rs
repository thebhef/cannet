//! Pure model pieces for the signal view panel: bus-scoped descriptor
//! enumeration, the canonical signal path
//! ([ADR 0038](../../../docs/adr/0038-canonical-signal-path.md)),
//! host-side selection (manual keys + regex patterns), and host-side
//! row sort. The orchestration that joins these to the trace store —
//! latest values, mux groups, statistics — lives in `fetch_signal_page`
//! (lib.rs), next to its by-id sibling.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use cannet_dbc::{Database, SignalDescriptor};

use crate::ipc::{
    SignalDescriptorRecord, SignalPageRow, SignalSectionHeaderRecord, SignalSections,
    SignalSelection, SignalSnapshotRecord,
};
use crate::signal_cache::FileSignalEntry;

/// The bus-expanded descriptor universe: one entry per `(bus,
/// descriptor)` pair, in descriptor-key order. What
/// [`scoped_descriptors`] produces and [`select_descriptors`] indexes
/// into.
pub type ScopedDescriptors = Vec<(Option<String>, SignalDescriptor)>;

/// A cached [`scoped_descriptors`] result, held by `AppState`.
///
/// The universe is a pure function of the loaded DBC set plus the
/// project's bus list, and rebuilding it means cloning and sorting one
/// descriptor per signal per bus — tens of thousands of entries on a
/// large project, which is far too much to pay per `fetch_signal_page`
/// call when the panels behind it poll at 2–4 Hz. So it is built once
/// and shared by `Arc` until one of its two inputs changes: the bus
/// list is compared here, and a DBC-set change drops the whole snapshot
/// through `invalidate_derived_caches` (ADR 0033 — rebuild dependent
/// state when its inputs change).
pub struct DescriptorSnapshot {
    /// The project-bus list `descriptors` was expanded against.
    pub project_buses: Vec<String>,
    pub descriptors: Arc<ScopedDescriptors>,
}

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
) -> ScopedDescriptors {
    let mut out: ScopedDescriptors = Vec::new();
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
///
/// `source_buses` is the caller view's bus wiring: `Some(scope)` bounds
/// what exists *for that view* — descriptors on other buses (and the
/// unassigned-bus degenerate) are out of scope for the regex too, not
/// just for the rows. `None` is unwired / "*" — everything. This is a
/// filter rather than a prune of `all` so that `all` can be the shared,
/// cached universe ([`DescriptorSnapshot`]) rather than a per-call
/// copy.
pub fn select_descriptors(
    all: &[(Option<String>, SignalDescriptor)],
    selection: &SignalSelection,
    bus_names: &HashMap<String, String>,
    source_buses: Option<&[String]>,
) -> Result<Vec<usize>, String> {
    let patterns: Vec<regex::Regex> = selection
        .patterns
        .iter()
        .map(|p| regex::Regex::new(p).map_err(|e| format!("invalid pattern /{p}/: {e}")))
        .collect::<Result<_, _>>()?;
    // Manual keys are hashed on the descriptor identity so the scan
    // below costs O(descriptors) rather than O(descriptors × keys). Both
    // sides scale with the project: the DBC panel's value column selects
    // one key per visible row while the universe runs to tens of
    // thousands of descriptors, and the product is what made a poll tick
    // cost hundreds of milliseconds.
    let manual: HashSet<(Option<&str>, u32, bool, &str)> = selection
        .keys
        .iter()
        .map(|k| {
            (
                k.bus_id.as_deref(),
                k.message_id,
                k.extended,
                k.signal_name.as_str(),
            )
        })
        .collect();
    let mut out = Vec::new();
    for (i, (bus, d)) in all.iter().enumerate() {
        if let Some(scope) = source_buses {
            if !bus.as_ref().is_some_and(|b| scope.contains(b)) {
                continue;
            }
        }
        if manual.contains(&descriptor_key(&all[i])) {
            out.push(i);
            continue;
        }
        if patterns.is_empty() {
            continue;
        }
        let bus_name = bus
            .as_deref()
            .map(|id| bus_names.get(id).map_or(id, String::as_str));
        let path = signal_path(
            bus_name,
            d.transmitter.as_deref(),
            &d.message_name,
            &d.signal_name,
        );
        if patterns.iter().any(|re| re.is_match(&path)) {
            out.push(i);
        }
    }
    Ok(out)
}

/// One file-backed signal (`docs/CONTEXT.md`) as a catalog row — what
/// `list_signals` appends to the DBC-derived descriptors so the picker
/// and the plot can reach an imported series.
///
/// Its identity is the source signal channel group index in the message
/// slot, no bus, never extended; `message_name` is the group's label,
/// standing where a DBC-backed signal shows the message that carries
/// it. It has no transmitter, no `VAL_` table and no DBC-implied
/// precision, so those read as absent rather than as defaults.
#[must_use]
pub fn file_backed_descriptor(entry: FileSignalEntry) -> SignalDescriptorRecord {
    SignalDescriptorRecord {
        bus_id: None,
        message_id: entry.info.group,
        extended: false,
        message_name: entry.info.group_label(),
        transmitter: None,
        signal_name: entry.info.name,
        unit: entry.info.unit,
        is_enum: false,
        display_hex: false,
        decimals: None,
        file_backed: true,
    }
}

/// The file-backed signals (`docs/CONTEXT.md`) `selection` admits, as
/// snapshot rows — the file-backed half of what `fetch_signal_page`
/// serves, alongside [`select_descriptors`]' DBC-backed half.
///
/// Selection works exactly as it does for a DBC-backed descriptor: a
/// manual key matches on identity, and a pattern matches the canonical
/// path (ADR 0038), whose bus and ECU segments are empty because a
/// file-backed signal has neither — `//Analog/EngineSpeed`. A view
/// **wired to specific buses** excludes them for the same reason it
/// excludes an unassigned-bus descriptor: nothing puts them on a bus.
///
/// The window-dependent columns are not window-dependent here. No frame
/// in the trace window carries a file-backed signal, so its value, time,
/// count and rate are facts about its whole imported series — read off
/// the pyramid by the model, never re-derived here.
pub fn select_file_backed(
    entries: &[FileSignalEntry],
    selection: &SignalSelection,
    source_buses: Option<&[String]>,
) -> Result<Vec<SignalSnapshotRecord>, String> {
    if entries.is_empty() || source_buses.is_some() {
        return Ok(Vec::new());
    }
    let patterns: Vec<regex::Regex> = selection
        .patterns
        .iter()
        .map(|p| regex::Regex::new(p).map_err(|e| format!("invalid pattern /{p}/: {e}")))
        .collect::<Result<_, _>>()?;
    let manual: HashSet<(u32, &str)> = selection
        .keys
        .iter()
        .filter(|k| k.file_backed)
        .map(|k| (k.message_id, k.signal_name.as_str()))
        .collect();
    let mut out = Vec::new();
    for entry in entries {
        let group = entry.info.group_label();
        if !manual.contains(&(entry.info.group, entry.info.name.as_str())) {
            let path = signal_path(None, None, &group, &entry.info.name);
            if !patterns.iter().any(|re| re.is_match(&path)) {
                continue;
            }
        }
        let latest = entry.latest.as_ref();
        out.push(SignalSnapshotRecord {
            bus_id: None,
            transmitter: None,
            message_id: entry.info.group,
            extended: false,
            message_name: group,
            signal_name: entry.info.name.clone(),
            unit: entry.info.unit.clone(),
            is_enum: false,
            raw_field: false,
            display_hex: false,
            value: latest.map(|p| p.value),
            // The file carries physical values with the conversion
            // already applied; there is no raw field behind them and no
            // `VAL_` table to label them with.
            raw: None,
            label: None,
            rate: entry.rate,
            count: Some(entry.sample_count),
            time_seconds: latest.map(|p| p.t_seconds),
            // Stamped by `arrange_sections`, which runs next.
            section: None,
            file_backed: true,
        });
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

/// The stable signal identity `bus|s|x|f:id:name` — the descriptor key
/// `(bus, message id, extended, signal name)` ADR 0038 keeps as *the*
/// identity for persistence and equality, rendered as one string.
///
/// Byte-for-byte the frontend's `signalKey` (`plotData.ts`), which is
/// already what the signal view keys its manual picks and its per-signal
/// colours on — so a section assignment keyed on it survives selection
/// edits, DBC renames of ECUs/messages, and a pattern-matched signal
/// becoming a manual pick.
///
/// The flag slot carries **provenance** as well as id width. A
/// file-backed signal (`docs/CONTEXT.md`) has no message and no bus, so
/// `message_id` is its source file's signal channel group index; `f`
/// keeps that number out of the message-id namespace, which is
/// otherwise free to hold the same value.
#[must_use]
pub fn signal_identity(
    bus_id: Option<&str>,
    message_id: u32,
    extended: bool,
    signal_name: &str,
    file_backed: bool,
) -> String {
    let flag = match (file_backed, extended) {
        (true, _) => "f",
        (false, true) => "x",
        (false, false) => "s",
    };
    format!(
        "{}|{flag}:{message_id}:{signal_name}",
        bus_id.unwrap_or("*")
    )
}

/// The view's selection widened by every live section's own patterns.
///
/// A section's patterns are part of what the view *selects*, not merely
/// a re-ordering of rows that were already there — otherwise a pattern
/// typed into a section would collect nothing until the same pattern
/// was also typed into the view-level selection. Deduped, and patterns
/// belonging to a section that no longer exists are dropped, so a
/// deleted section stops contributing rows the moment it is gone.
#[must_use]
pub fn selection_with_section_patterns(
    base: &SignalSelection,
    sections: &SignalSections,
) -> SignalSelection {
    let mut patterns = base.patterns.clone();
    for name in &sections.names {
        let Some(ps) = sections.patterns.get(name) else {
            continue;
        };
        for p in ps {
            if !patterns.contains(p) {
                patterns.push(p.clone());
            }
        }
    }
    SignalSelection {
        keys: base.keys.clone(),
        patterns,
    }
}

/// Arrange the selected rows into the view's user-authored sections and
/// return the page-row space the panel scrolls: a header row per
/// section followed by that section's rows, sorted *within* the section.
///
/// The implicit unassigned section comes **first** and is unnamed. With
/// no sections at all it is the whole list and prints no header, so a
/// user who never made a section sees the flat list unchanged.
///
/// A folded section keeps its header (with its full signal count) and
/// contributes no signal rows, which is what makes the returned length
/// the fold-aware extent the scrollbar needs.
///
/// Two ways a row lands in a section, in this precedence:
///
/// 1. **An explicit assignment wins.** The user moved that signal by
///    hand; another section's pattern must not drag it back.
/// 2. **Otherwise the first section, in creation order, whose own
///    patterns match the row's canonical path** (ADR 0038). Creation
///    order rather than "most specific" or "last wins" because it is
///    the order the user already sees on screen, so the tie-break is
///    readable off the panel instead of inferred.
pub fn arrange_sections(
    rows: Vec<SignalSnapshotRecord>,
    sections: &SignalSections,
    sort_key: Option<&str>,
    sort_dir: Option<&str>,
    bus_names: &HashMap<String, String>,
) -> Vec<SignalPageRow> {
    // Bucket 0 is the implicit section; the rest are `names` in creation
    // order, deduped (a duplicate name is one section, not two headers
    // fighting over the same assignment).
    let mut names: Vec<&str> = Vec::with_capacity(sections.names.len() + 1);
    names.push("");
    for n in &sections.names {
        if !n.is_empty() && !names.contains(&n.as_str()) {
            names.push(n);
        }
    }
    let index: HashMap<&str, usize> = names.iter().enumerate().map(|(i, n)| (*n, i)).collect();
    let folded: HashSet<&str> = sections.folded.iter().map(String::as_str).collect();
    // Each live section's patterns, compiled once, in creation order —
    // the order the first-match tie-break reads. A pattern that does not
    // compile simply never matches: `select_descriptors` is what reports
    // the compile error to the panel.
    let claims: Vec<(usize, Vec<regex::Regex>)> = names
        .iter()
        .enumerate()
        .skip(1)
        .filter_map(|(slot, name)| {
            let ps = sections.patterns.get(*name)?;
            let res: Vec<regex::Regex> = ps
                .iter()
                .filter_map(|p| regex::Regex::new(p).ok())
                .collect();
            (!res.is_empty()).then_some((slot, res))
        })
        .collect();

    let mut buckets: Vec<Vec<SignalSnapshotRecord>> = vec![Vec::new(); names.len()];
    for mut row in rows {
        let id = signal_identity(
            row.bus_id.as_deref(),
            row.message_id,
            row.extended,
            &row.signal_name,
            row.file_backed,
        );
        // An assignment naming a section that no longer exists reads as
        // unassigned — deleting a section returns its signals without
        // rewriting every assignment, and re-creating it restores them.
        let slot = sections
            .assignments
            .get(&id)
            .and_then(|s| index.get(s.as_str()).copied())
            .or_else(|| claim_slot(&claims, &row, bus_names))
            .unwrap_or(0);
        // Tell the row where it landed, so the panel's section cell
        // reports a pattern claim as accurately as an explicit move.
        row.section = (slot > 0).then(|| names[slot].to_string());
        buckets[slot].push(row);
    }

    let mut out = Vec::new();
    for (slot, name) in names.iter().enumerate() {
        let bucket = &mut buckets[slot];
        sort_rows(bucket, sort_key, sort_dir, bus_names);
        let count = u64::try_from(bucket.len()).unwrap_or(u64::MAX);
        // No sections at all: the implicit section *is* the view, and a
        // header over the whole list would be a change to a panel
        // nobody asked to change. An empty implicit section likewise has
        // nothing to head — unlike a named one, you cannot lose it.
        let headed = if name.is_empty() {
            names.len() > 1 && count > 0
        } else {
            true
        };
        if headed {
            out.push(SignalPageRow::SectionHeader(SignalSectionHeaderRecord {
                name: (*name).to_string(),
                signal_count: count,
            }));
        }
        if headed && folded.contains(name) {
            continue;
        }
        out.extend(
            std::mem::take(bucket)
                .into_iter()
                .map(SignalPageRow::Signal),
        );
    }
    out
}

/// The first section (creation order) whose patterns claim this row,
/// matched against the row's canonical path — the same subject string
/// [`select_descriptors`] matches the view-level patterns against, so a
/// pattern cannot mean one thing for selection and another for
/// grouping.
fn claim_slot(
    claims: &[(usize, Vec<regex::Regex>)],
    row: &SignalSnapshotRecord,
    bus_names: &HashMap<String, String>,
) -> Option<usize> {
    if claims.is_empty() {
        return None;
    }
    let bus_name = row
        .bus_id
        .as_deref()
        .map(|id| bus_names.get(id).map_or(id, String::as_str));
    let path = signal_path(
        bus_name,
        row.transmitter.as_deref(),
        &row.message_name,
        &row.signal_name,
    );
    claims
        .iter()
        .find(|(_, res)| res.iter().any(|re| re.is_match(&path)))
        .map(|(slot, _)| *slot)
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
    use crate::ipc::{SignalQuery, SignalSections};

    fn sections(names: &[&str], assignments: &[(&str, &str)], folded: &[&str]) -> SignalSections {
        SignalSections {
            names: names.iter().map(|s| (*s).to_string()).collect(),
            assignments: assignments
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            patterns: HashMap::new(),
            folded: folded.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn with_patterns(mut s: SignalSections, patterns: &[(&str, &[&str])]) -> SignalSections {
        for (name, ps) in patterns {
            s.patterns.insert(
                (*name).to_string(),
                ps.iter().map(|p| (*p).to_string()).collect(),
            );
        }
        s
    }

    /// A row whose canonical path is `bus/ecu/message/signal`.
    fn pathed_row(bus: &str, ecu: &str, message: &str, signal: &str) -> SignalSnapshotRecord {
        SignalSnapshotRecord {
            bus_id: Some(bus.into()),
            transmitter: Some(ecu.into()),
            message_name: message.into(),
            ..valued_row(signal, 1.0)
        }
    }

    /// `name` for a header row, `+name` for a signal row — one flat
    /// transcript of the arranged row space, which is what the panel
    /// pages through.
    fn transcript(rows: &[SignalPageRow]) -> Vec<String> {
        rows.iter()
            .map(|r| match r {
                SignalPageRow::SectionHeader(h) => format!("{}({})", h.name, h.signal_count),
                SignalPageRow::Signal(s) => format!("+{}", s.signal_name),
            })
            .collect()
    }

    fn ident(signal: &str) -> String {
        signal_identity(None, 0, false, signal, false)
    }

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
            file_backed: false,
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
            raw_field: false,
            display_hex: false,
            value: None,
            raw: None,
            label: None,
            rate: None,
            count: None,
            time_seconds: None,
            section: None,
            file_backed: false,
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
        let hit = select_descriptors(&all, &sel, &names, None).unwrap();
        let picked: Vec<&str> = hit.iter().map(|&i| all[i].1.signal_name.as_str()).collect();
        // Pattern catches both Bms-sent PackStatus signals; the manual
        // key adds TorqueReq. Deduped, in descriptor order.
        assert_eq!(picked, vec!["PackTemp", "PackVolts", "TorqueReq"]);
    }

    #[test]
    fn selection_matches_manual_keys_independently_of_key_order_or_count() {
        // Manual keys are looked up through a hash of the descriptor
        // identity rather than scanned per descriptor. The observable
        // contract that guards the rewrite: results are the descriptors'
        // own order, whatever order (and however many) keys arrive in.
        let all = all_on(&["power"]);
        let mut keys = vec![
            key(Some("power"), 257, "TorqueReq"),
            key(Some("power"), 256, "PackVolts"),
        ];
        // Padding keys that match nothing must not change the outcome.
        keys.extend((0..500).map(|i| key(Some("power"), 900 + i, "Absent")));
        let sel = SignalSelection {
            keys,
            patterns: vec![],
        };
        let hit = select_descriptors(&all, &sel, &HashMap::new(), None).unwrap();
        let picked: Vec<&str> = hit.iter().map(|&i| all[i].1.signal_name.as_str()).collect();
        assert_eq!(picked, vec!["PackVolts", "TorqueReq"]);
    }

    #[test]
    fn source_bus_scope_hides_descriptors_from_patterns_too() {
        // A view wired to one bus can't reach another bus's descriptors
        // even through a catch-all regex. Applied as a filter over the
        // shared universe rather than by pruning it.
        let all = all_on(&["chassis", "power"]);
        let sel = SignalSelection {
            keys: vec![key(Some("chassis"), 256, "PackVolts")],
            patterns: vec![".".to_string()],
        };
        let hit =
            select_descriptors(&all, &sel, &HashMap::new(), Some(&["power".to_string()])).unwrap();
        assert!(!hit.is_empty());
        assert!(hit.iter().all(|&i| all[i].0.as_deref() == Some("power")));
    }

    #[test]
    fn selection_rejects_invalid_patterns_as_error() {
        let all = all_on(&["power"]);
        let sel = SignalSelection {
            keys: vec![],
            patterns: vec!["([unclosed".to_string()],
        };
        let err = select_descriptors(&all, &sel, &HashMap::new(), None).unwrap_err();
        assert!(err.contains("invalid pattern"), "got: {err}");
    }

    #[test]
    fn selection_key_on_one_bus_does_not_match_another() {
        let all = all_on(&["chassis", "power"]);
        let sel = SignalSelection {
            keys: vec![key(Some("power"), 256, "PackVolts")],
            patterns: vec![],
        };
        let hit = select_descriptors(&all, &sel, &HashMap::new(), None).unwrap();
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
    fn signal_identity_is_the_descriptor_key_the_frontend_writes() {
        // Must match `signalKey` in `plotData.ts` byte for byte — it is
        // the assignment key the panel persists.
        assert_eq!(
            signal_identity(Some("p"), 256, false, "EngineSpeed", false),
            "p|s:256:EngineSpeed",
        );
        assert_eq!(signal_identity(None, 7, true, "S", false), "*|x:7:S");
        // A file-backed signal takes the third flag: its `message_id` is
        // a channel group index, which must not alias a message id.
        assert_eq!(signal_identity(None, 7, false, "S", true), "*|f:7:S");
    }

    #[test]
    fn experiment_frontend_json_buckets_a_row() {
        // EXPERIMENT (item 16 defect): the exact `sections` payload the
        // panel builds, deserialized the way the command deserializes
        // it, against a row with the matching descriptor.
        let wire = r#"{"names":["Pack"],"assignments":{"p|s:256:EngineSpeed":"Pack"},"folded":[]}"#;
        let s: SignalSections = serde_json::from_str(wire).expect("frontend payload deserializes");
        assert_eq!(s.names, vec!["Pack".to_string()]);
        assert_eq!(
            s.assignments.get("p|s:256:EngineSpeed"),
            Some(&"Pack".into())
        );
        let mut row = valued_row("EngineSpeed", 1.0);
        row.bus_id = Some("p".into());
        row.message_id = 256;
        let out = arrange_sections(vec![row], &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["Pack(1)", "+EngineSpeed"]);
    }

    #[test]
    fn no_sections_arranges_the_flat_sorted_list_with_no_headers() {
        // The whole point of the implicit section: a user who never made
        // a section sees exactly the list they had.
        let rows = vec![valued_row("b", 2.0), valued_row("a", 1.0)];
        let out = arrange_sections(
            rows,
            &SignalSections::default(),
            Some("signal"),
            Some("asc"),
            &HashMap::new(),
        );
        assert_eq!(transcript(&out), vec!["+a", "+b"]);
    }

    #[test]
    fn sections_render_unassigned_first_then_creation_order() {
        let rows = vec![
            valued_row("loose", 1.0),
            valued_row("packv", 2.0),
            valued_row("relay", 3.0),
        ];
        let s = sections(
            &["Pack", "Contactors"],
            &[(&ident("packv"), "Pack"), (&ident("relay"), "Contactors")],
            &[],
        );
        let out = arrange_sections(rows, &s, None, None, &HashMap::new());
        assert_eq!(
            transcript(&out),
            vec![
                "(1)",
                "+loose",
                "Pack(1)",
                "+packv",
                "Contactors(1)",
                "+relay",
            ],
        );
    }

    #[test]
    fn an_empty_named_section_still_gets_its_header() {
        // A section you created but haven't filled must stay visible —
        // otherwise there is nothing to drop a signal onto or delete.
        let rows = vec![valued_row("loose", 1.0)];
        let s = sections(&["Empty"], &[], &[]);
        let out = arrange_sections(rows, &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["(1)", "+loose", "Empty(0)"]);
        // …but the implicit section with nothing in it prints nothing.
        let s = sections(&["Pack"], &[(&ident("loose"), "Pack")], &[]);
        let out = arrange_sections(
            vec![valued_row("loose", 1.0)],
            &s,
            None,
            None,
            &HashMap::new(),
        );
        assert_eq!(transcript(&out), vec!["Pack(1)", "+loose"]);
    }

    #[test]
    fn a_folded_section_keeps_its_header_and_count_but_drops_its_rows() {
        let rows = vec![valued_row("loose", 1.0), valued_row("packv", 2.0)];
        let s = sections(&["Pack"], &[(&ident("packv"), "Pack")], &["Pack", ""]);
        let out = arrange_sections(rows, &s, None, None, &HashMap::new());
        // Both folded: two header rows, no signal rows — and that is the
        // count the scrollbar gets.
        assert_eq!(transcript(&out), vec!["(1)", "Pack(1)"]);
    }

    #[test]
    fn sort_applies_within_each_section_not_across_them() {
        let rows = vec![
            valued_row("a", 9.0),
            valued_row("z", 1.0),
            valued_row("m", 5.0),
            valued_row("b", 4.0),
        ];
        let s = sections(
            &["Pack"],
            &[(&ident("m"), "Pack"), (&ident("b"), "Pack")],
            &[],
        );
        let out = arrange_sections(rows, &s, Some("value"), Some("asc"), &HashMap::new());
        // Unassigned sorts z(1) before a(9); Pack sorts b(4) before m(5).
        // A cross-section sort would have produced z, b, m, a.
        assert_eq!(
            transcript(&out),
            vec!["(2)", "+z", "+a", "Pack(2)", "+b", "+m"],
        );
    }

    #[test]
    fn an_assignment_to_a_deleted_section_falls_back_to_unassigned() {
        // Deleting a section is a `names` edit: its signals come back to
        // the implicit section, and the stale assignment stays dormant so
        // re-creating the section restores them.
        let rows = vec![valued_row("packv", 1.0)];
        let s = sections(&[], &[(&ident("packv"), "Pack")], &[]);
        let out = arrange_sections(rows, &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["+packv"]);
    }

    #[test]
    fn a_section_pattern_collects_its_matches_under_that_section() {
        let rows = vec![
            pathed_row("p", "Bms", "PackStatus", "PackVolts"),
            pathed_row("p", "Vcu", "DriveCmd", "TorqueReq"),
        ];
        let s = with_patterns(sections(&["Pack"], &[], &[]), &[("Pack", &["/Bms/"])]);
        let out = arrange_sections(rows, &s, None, None, &HashMap::new());
        assert_eq!(
            transcript(&out),
            vec!["(1)", "+TorqueReq", "Pack(1)", "+PackVolts"]
        );
    }

    #[test]
    fn an_explicit_assignment_beats_a_section_pattern() {
        // The user moved this signal by hand; a pattern in another
        // section must not drag it back.
        let row = pathed_row("p", "Bms", "PackStatus", "PackVolts");
        let id = signal_identity(Some("p"), 0, false, "PackVolts", false);
        let s = with_patterns(
            sections(&["Pack", "Debug"], &[(&id, "Debug")], &[]),
            &[("Pack", &["/Bms/"])],
        );
        let out = arrange_sections(vec![row], &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["Pack(0)", "Debug(1)", "+PackVolts"]);
    }

    #[test]
    fn two_matching_section_patterns_resolve_to_the_earlier_section() {
        let row = pathed_row("p", "Bms", "PackStatus", "PackVolts");
        let s = with_patterns(
            sections(&["First", "Second"], &[], &[]),
            &[("First", &["Pack"]), ("Second", &["Pack"])],
        );
        let out = arrange_sections(vec![row.clone()], &s, None, None, &HashMap::new());
        assert_eq!(
            transcript(&out),
            vec!["First(1)", "+PackVolts", "Second(0)"]
        );
        // Creation order decides it, not name order: flip the names and
        // the same signal follows.
        let s = with_patterns(
            sections(&["Second", "First"], &[], &[]),
            &[("First", &["Pack"]), ("Second", &["Pack"])],
        );
        let out = arrange_sections(vec![row], &s, None, None, &HashMap::new());
        assert_eq!(
            transcript(&out),
            vec!["Second(1)", "+PackVolts", "First(0)"]
        );
    }

    #[test]
    fn reordering_the_names_moves_the_headers_and_the_claim_together() {
        // The signal view's section drag-reorder (ADR 0045) is exactly
        // a permutation of `names`. The property that makes it safe to
        // expose as a gesture is that the *visible* order and the
        // pattern-claim priority are one fact: dragging "Late" to the
        // front must both move its header and hand it the contested
        // row, so claim priority stays readable off the panel.
        let row = pathed_row("p", "Bms", "PackStatus", "PackVolts");
        let patterns: &[(&str, &[&str])] = &[("Early", &["Pack"]), ("Late", &["Pack"])];
        let before = with_patterns(sections(&["Early", "Mid", "Late"], &[], &[]), patterns);
        let out = arrange_sections(vec![row.clone()], &before, None, None, &HashMap::new());
        assert_eq!(
            transcript(&out),
            vec!["Early(1)", "+PackVolts", "Mid(0)", "Late(0)"]
        );

        // …and the panel's reorder, dropping "Late" onto "Early".
        let after = with_patterns(sections(&["Late", "Early", "Mid"], &[], &[]), patterns);
        let out = arrange_sections(vec![row], &after, None, None, &HashMap::new());
        assert_eq!(
            transcript(&out),
            vec!["Late(1)", "+PackVolts", "Early(0)", "Mid(0)"]
        );
    }

    #[test]
    fn an_explicit_unsectioned_assignment_overrides_a_claiming_pattern() {
        // Moving a pattern-claimed signal *out* has to be expressible,
        // and deleting the assignment cannot say it — the pattern would
        // simply re-claim the row. The implicit section's own name (the
        // empty string) is that assignment.
        let row = pathed_row("p", "Bms", "PackStatus", "PackVolts");
        let id = signal_identity(Some("p"), 0, false, "PackVolts", false);
        let s = with_patterns(
            sections(&["Pack"], &[(&id, "")], &[]),
            &[("Pack", &["/Bms/"])],
        );
        let out = arrange_sections(vec![row], &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["(1)", "+PackVolts", "Pack(0)"]);
    }

    #[test]
    fn every_row_is_stamped_with_the_section_it_landed_in() {
        let rows = vec![
            pathed_row("p", "Bms", "PackStatus", "PackVolts"),
            pathed_row("p", "Vcu", "DriveCmd", "TorqueReq"),
        ];
        let s = with_patterns(sections(&["Pack"], &[], &[]), &[("Pack", &["/Bms/"])]);
        let out = arrange_sections(rows, &s, None, None, &HashMap::new());
        let stamped: Vec<(String, Option<String>)> = out
            .iter()
            .filter_map(|r| r.signal())
            .map(|s| (s.signal_name.clone(), s.section.clone()))
            .collect();
        assert_eq!(
            stamped,
            vec![
                ("TorqueReq".to_string(), None),
                ("PackVolts".to_string(), Some("Pack".to_string())),
            ],
        );
    }

    #[test]
    fn a_pattern_on_a_deleted_section_collects_nothing() {
        let row = pathed_row("p", "Bms", "PackStatus", "PackVolts");
        let s = with_patterns(sections(&[], &[], &[]), &[("Pack", &["/Bms/"])]);
        let out = arrange_sections(vec![row], &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["+PackVolts"]);
    }

    #[test]
    fn a_bad_section_pattern_buckets_nothing_rather_than_panicking() {
        // `select_descriptors` is what reports the compile error to the
        // panel; the arrangement must simply not match on it.
        let row = pathed_row("p", "Bms", "PackStatus", "PackVolts");
        let s = with_patterns(sections(&["Pack"], &[], &[]), &[("Pack", &["([unclosed"])]);
        let out = arrange_sections(vec![row], &s, None, None, &HashMap::new());
        assert_eq!(transcript(&out), vec!["(1)", "+PackVolts", "Pack(0)"]);
    }

    #[test]
    fn section_patterns_widen_the_views_selection() {
        // A section's patterns are part of what the view selects — a
        // signal matched only by a section pattern must have a row to
        // organize in the first place.
        let base = SignalSelection {
            keys: vec![],
            patterns: vec!["^first$".into()],
        };
        // "Gone" carries patterns but is not in `names` — a deleted
        // section whose patterns went dormant with it.
        let s = with_patterns(
            sections(&["Pack"], &[], &[]),
            &[("Pack", &["/Bms/", "/Bms/"]), ("Gone", &["never"])],
        );
        let wide = selection_with_section_patterns(&base, &s);
        // The view's own pattern, then each live section's, deduped; a
        // section that no longer exists contributes nothing.
        assert_eq!(
            wide.patterns,
            vec!["^first$".to_string(), "/Bms/".to_string()]
        );
        assert!(wide.keys.is_empty());
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
