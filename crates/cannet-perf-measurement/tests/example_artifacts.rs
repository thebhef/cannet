//! The shipped `examples/ev-demo` workload must parse against the real
//! production parsers and be internally consistent. These tests are the
//! regression guard on the hand-authored artifacts: a typo'd CAN id, a
//! renamed signal, or a schema bump that the example wasn't updated for
//! all fail here.

use std::collections::{HashMap, HashSet};

use cannet_perf_measurement::{default_example_dir, load_example, workload};

#[test]
fn example_parses_and_is_consistent() {
    let ex = load_example(&default_example_dir())
        .unwrap_or_else(|e| panic!("example failed to load: {e}"));

    // Two physically-bridged buses, one DBC per ECU group, all parsed.
    assert_eq!(ex.project.buses.len(), 2, "expected 2 buses");
    assert_eq!(ex.dbcs.len(), 4, "expected 4 DBCs");
    for loaded in &ex.dbcs {
        assert!(
            loaded.db.message_count() > 0,
            "{} has no messages",
            loaded.path.display()
        );
    }

    // Every RBS override resolves to a real DBC message + signal.
    ex.check_rbs_against_dbcs()
        .unwrap_or_else(|e| panic!("RBS / DBC mismatch:\n{e}"));
}

#[test]
fn schedule_is_periodic_and_realistic() {
    let ex = load_example(&default_example_dir()).expect("load example");
    let schedule = workload::build_schedule(&ex);

    // Every DBC message carries a cycle time, so all should be scheduled.
    let total_messages: usize = ex.dbcs.iter().map(|d| d.db.message_count()).sum();
    assert_eq!(
        schedule.len(),
        total_messages,
        "every cyclic DBC message should be scheduled once"
    );

    // Each scheduled message has a positive cadence and a non-empty,
    // correctly-sized payload.
    for m in &schedule {
        assert!(m.period_ms > 0, "0x{:X} has no cadence", m.can_id);
        assert!(!m.payload.is_empty(), "0x{:X} has empty payload", m.can_id);
    }

    // The EV model sums to a few hundred frames/s — a useful sustained
    // ingest workload, in the band the perf diagnosis ran against.
    let rate = workload::aggregate_rate_hz(&schedule);
    assert!(
        (300.0..=600.0).contains(&rate),
        "aggregate rate {rate:.1}/s outside the expected 300-600 band"
    );
}

/// The frontend perf characterisation drives the GUI under this
/// project's *view* configuration, so the committed layout must actually
/// open the trace and plot panels — an empty layout blob renders nothing
/// on open. This guards the hand-authored `layout` against drifting back
/// to empty or referencing elements that don't exist.
#[test]
fn layout_opens_representative_views() {
    let ex = load_example(&default_example_dir()).expect("load example");

    // Declared element ids, keyed by kind.
    let mut elements_by_kind: HashMap<&str, HashSet<&str>> = HashMap::new();
    for e in &ex.project.elements {
        let kind = e.get("kind").and_then(|v| v.as_str()).expect("element has kind");
        let id = e.get("id").and_then(|v| v.as_str()).expect("element has id");
        elements_by_kind.entry(kind).or_default().insert(id);
    }

    // A representative render-tier load: both trace views (chronological +
    // by-id, the config the perf diagnosis ran against), at least two
    // plots, and the RBS element that drives the workload.
    assert!(
        elements_by_kind.get("trace").is_some_and(|s| s.len() >= 2),
        "expected >=2 trace elements (chronological + by-id)"
    );
    assert!(
        elements_by_kind.get("plot").is_some_and(|s| s.len() >= 2),
        "expected >=2 plot elements"
    );
    assert!(elements_by_kind.contains_key("rbs"), "expected an rbs element");

    // The layout must be populated — an empty grid/panels renders nothing.
    let panels = ex
        .project
        .layout
        .get("panels")
        .and_then(serde_json::Value::as_object)
        .expect("layout.panels is an object");
    assert!(
        !panels.is_empty(),
        "layout has no panels — opening the project would render nothing"
    );

    // dockview component name -> the project element kind it opens.
    let component_kind = |c: &str| match c {
        "trace" => Some("trace"),
        "plot" => Some("plot"),
        "rbs" => Some("rbs"),
        _ => None,
    };

    // Every element-backed panel references a declared element of the
    // matching kind, with the `<component>-<elementId>` id the frontend
    // restores from.
    let mut referenced: HashSet<(&str, &str)> = HashSet::new();
    for (panel_id, panel) in panels {
        let component = panel
            .get("contentComponent")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("panel {panel_id} has no contentComponent"));
        let Some(kind) = component_kind(component) else {
            continue;
        };
        let element_id = panel
            .get("params")
            .and_then(|p| p.get("elementId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("panel {panel_id} has no params.elementId"));
        assert!(
            elements_by_kind.get(kind).is_some_and(|s| s.contains(element_id)),
            "panel {panel_id} references unknown {kind} element {element_id:?}"
        );
        assert_eq!(
            panel_id.as_str(),
            format!("{component}-{element_id}"),
            "panel id should be <component>-<elementId>"
        );
        referenced.insert((kind, element_id));
    }

    // Every panel-bearing element is actually opened by a panel.
    for (kind, ids) in &elements_by_kind {
        if component_kind(kind).is_none() {
            continue;
        }
        for id in ids {
            assert!(
                referenced.contains(&(*kind, *id)),
                "{kind} element {id:?} has no panel — it wouldn't render on open"
            );
        }
    }

    // The grid and the panels map agree: every leaf view is a known panel,
    // and every panel is placed somewhere in the grid.
    let root = ex
        .project
        .layout
        .get("grid")
        .and_then(|g| g.get("root"))
        .expect("layout.grid.root");
    let mut leaf_views: HashSet<String> = HashSet::new();
    collect_leaf_views(root, &mut leaf_views);
    assert!(!leaf_views.is_empty(), "grid has no leaf views");
    for v in &leaf_views {
        assert!(panels.contains_key(v), "grid references panel {v:?} absent from the panels map");
    }
    for panel_id in panels.keys() {
        assert!(
            leaf_views.contains(panel_id),
            "panel {panel_id:?} is not placed in the grid"
        );
    }
}

/// Recurse a dockview `SerializedGridObject` tree, collecting the panel
/// ids named by every leaf group's `views`.
fn collect_leaf_views(node: &serde_json::Value, out: &mut HashSet<String>) {
    match node.get("type").and_then(serde_json::Value::as_str) {
        Some("leaf") => {
            let views = node
                .get("data")
                .and_then(|d| d.get("views"))
                .and_then(serde_json::Value::as_array);
            for v in views.into_iter().flatten() {
                if let Some(s) = v.as_str() {
                    out.insert(s.to_string());
                }
            }
        }
        Some("branch") => {
            let children = node.get("data").and_then(serde_json::Value::as_array);
            for c in children.into_iter().flatten() {
                collect_leaf_views(c, out);
            }
        }
        _ => {}
    }
}

/// Every `colormap` element (ADR 0029) targets a real DBC enum signal,
/// and its rules cover *exactly* that signal's `VAL_` values — one
/// degenerate `[v, v]` rule per enum entry, none missing, none stray.
/// Guards the hand-authored maps against DBC drift (a renamed signal, a
/// changed id, an added or removed enum value).
#[test]
fn colormaps_match_dbc_enum_value_tables() {
    let ex = load_example(&default_example_dir()).expect("load example");

    let colormaps: Vec<&serde_json::Value> = ex
        .project
        .elements
        .iter()
        .filter(|e| e.get("kind").and_then(serde_json::Value::as_str) == Some("colormap"))
        .collect();
    assert!(!colormaps.is_empty(), "expected colormap elements in the example");

    for cm in colormaps {
        let name = cm.get("name").and_then(serde_json::Value::as_str).unwrap_or("?");
        let message_id = u32::try_from(
            cm.get("messageId")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(|| panic!("{name}: messageId missing")),
        )
        .expect("messageId fits u32");
        let extended = cm
            .get("extended")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let signal = cm
            .get("signalName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("{name}: signalName missing"));

        // The targeted signal must be an enum (have a VAL_ table) in some
        // loaded DBC.
        let table = ex
            .dbcs
            .iter()
            .find_map(|d| d.db.value_table_for_signal(message_id, extended, signal))
            .unwrap_or_else(|| {
                panic!("{name}: (0x{message_id:X}, ext={extended}) {signal} has no VAL_ table in any DBC")
            });
        let enum_values: HashSet<i64> = table.iter().map(|e| e.raw).collect();

        // Each rule is a degenerate [v, v] range pointing at a real enum
        // value; together they cover the whole table.
        let mut covered: HashSet<i64> = HashSet::new();
        let rules = cm
            .get("rules")
            .and_then(serde_json::Value::as_array)
            .unwrap_or_else(|| panic!("{name}: rules missing"));
        for rule in rules {
            let min = rule.get("min").and_then(serde_json::Value::as_i64).expect("rule.min");
            let max = rule.get("max").and_then(serde_json::Value::as_i64).expect("rule.max");
            assert_eq!(min, max, "{name}: enum rule should be degenerate, got [{min}, {max}]");
            assert!(
                enum_values.contains(&min),
                "{name}: rule value {min} is not in {signal}'s VAL_ table"
            );
            covered.insert(min);
        }
        assert_eq!(
            covered, enum_values,
            "{name}: rules must cover exactly {signal}'s enum values"
        );
    }
}

#[test]
fn extended_e2e_command_is_present() {
    let ex = load_example(&default_example_dir()).expect("load example");
    let schedule = workload::build_schedule(&ex);
    // The BMS contactor heartbeat is the extended-id, E2E-protected
    // (counter + CRC) message — exercise that the example carries one.
    assert!(
        schedule.iter().any(|m| m.extended),
        "expected at least one extended-id message in the schedule"
    );
}
