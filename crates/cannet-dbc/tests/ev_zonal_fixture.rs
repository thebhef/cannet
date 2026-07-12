//! The `examples/ev-zonal` fixture is the deliberately-large DBC set
//! the DBC view's scaling work is measured against. These tests pin
//! the properties the fixture promises: both files parse cleanly and
//! carry the advertised scale (150+ messages each, one message with
//! 500+ multiplexed signals).

use std::path::Path;

use cannet_dbc::{Database, SignalMux};

fn load(name: &str) -> Database {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/ev-zonal/dbc")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let db = Database::parse(&text).expect("fixture must parse");
    assert!(
        db.parse_warnings().is_empty(),
        "{name} parse warnings: {:?}",
        db.parse_warnings()
    );
    db
}

#[test]
fn pack_dbc_parses_at_the_promised_scale() {
    let db = load("pack.dbc");
    let content = db.dbc_content();
    assert!(
        content.len() >= 150,
        "pack.dbc has {} messages, promised 150+",
        content.len()
    );

    // The mux stress case: per-cell voltage / temp / balance for a
    // 200-cell pack behind one selector — 600 multiplexed signals.
    let cell_detail = content
        .iter()
        .find(|m| m.name == "BmsCellDetail")
        .expect("BmsCellDetail present");
    assert!(cell_detail.is_fd, "64-byte payload must classify as FD");
    let muxed = cell_detail
        .signals
        .iter()
        .filter(|s| matches!(s.mux, SignalMux::Multiplexed { .. }))
        .count();
    assert!(
        muxed >= 500,
        "BmsCellDetail has {muxed} multiplexed signals, promised 500+"
    );
    assert!(cell_detail
        .signals
        .iter()
        .any(|s| matches!(s.mux, SignalMux::Multiplexor)));
}

#[test]
fn zonal_dbc_parses_at_the_promised_scale() {
    let db = load("zonal.dbc");
    let content = db.dbc_content();
    assert!(
        content.len() >= 150,
        "zonal.dbc has {} messages, promised 150+",
        content.len()
    );

    // Value tables and comments exist for search-ranking realism.
    assert!(content
        .iter()
        .any(|m| m.signals.iter().any(|s| !s.value_table.is_empty())));
    assert!(content.iter().any(|m| !m.comment.is_empty()));
}
