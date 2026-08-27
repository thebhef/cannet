//! The `examples/colliding-dbcs` pair is the fixture for two databases
//! assigned to one bus that disagree about the same arbitration id — the
//! case the resolution rule exists for and the signal-mapping panel
//! reports as ambiguous.
//!
//! These tests pin the disagreements the pair promises. A fixture that
//! quietly stopped colliding would still parse, still open, and still
//! demonstrate nothing.

use std::path::Path;

use cannet_dbc::Database;

/// The colliding id: `VehicleState` in `examples/cannet-demo.dbc`, so the
/// committed demo captures carry traffic that both files claim.
const COLLIDING_ID: u32 = 256;

fn load(name: &str) -> Database {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/colliding-dbcs")
        .join(name);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let db = Database::parse(&text).expect("fixture must parse");
    assert!(
        db.parse_warnings().is_empty(),
        "{name} parse warnings: {:?}",
        db.parse_warnings()
    );
    db
}

/// The message both files define, by the id they share.
fn colliding_message(db: &Database) -> cannet_dbc::DbcMessageContent {
    db.dbc_content()
        .iter()
        .find(|m| m.message_id == COLLIDING_ID)
        .cloned()
        .unwrap_or_else(|| panic!("no message {COLLIDING_ID:#x}"))
}

/// The disagreements, one assertion each. Every one of them is a distinct
/// thing the resolution rule has to settle, and a distinct row state the
/// signal-mapping panel has to show.
#[test]
fn the_pair_disagrees_about_one_id_in_every_way_that_matters() {
    let legacy = colliding_message(&load("legacy-vehicle.dbc"));
    let modern = colliding_message(&load("modern-vehicle.dbc"));

    // Same id, different message name — the stale-reference case.
    assert_eq!(
        (legacy.message_id, modern.message_id),
        (COLLIDING_ID, COLLIDING_ID)
    );
    assert_ne!(legacy.name, modern.name);

    let sig = |m: &cannet_dbc::DbcMessageContent, name: &str| {
        m.signals
            .iter()
            .find(|s| s.name == name)
            .cloned()
            .unwrap_or_else(|| panic!("{} has no {name}", m.name))
    };

    // Same signal, different scale and unit — the same wire bits read as
    // two different physical values.
    let (a, b) = (sig(&legacy, "VehSpeed"), sig(&modern, "VehSpeed"));
    assert!(
        (a.factor - b.factor).abs() > 1e-9,
        "{} vs {}",
        a.factor,
        b.factor,
    );
    assert_ne!(a.unit, b.unit);

    // Same signal, identical everywhere — the collision that costs
    // nothing, and the control the others are read against.
    let (a, b) = (sig(&legacy, "EngineRpm"), sig(&modern, "EngineRpm"));
    assert!((a.factor - b.factor).abs() < f64::EPSILON);
    assert!((a.offset - b.offset).abs() < f64::EPSILON);
    assert_eq!(a.unit, b.unit);

    // Same enum signal, different vocabulary.
    let park = |db: &Database| {
        db.value_table_for_signal(COLLIDING_ID, false, "GearLever")
            .and_then(|t| t.iter().find(|e| e.raw == 0))
            .map(|e| e.label.clone())
    };
    assert_eq!(
        (
            park(&load("legacy-vehicle.dbc")),
            park(&load("modern-vehicle.dbc"))
        ),
        (Some("P".to_owned()), Some("Park".to_owned())),
    );

    // A signal only one of them defines, over bits the other calls
    // something else.
    assert!(legacy.signals.iter().any(|s| s.name == "BrakePedal"));
    assert!(modern.signals.iter().any(|s| s.name == "DriveMode"));
    assert!(!legacy.signals.iter().any(|s| s.name == "DriveMode"));
}

/// Only the replacement declares calculated fields on the shared id, so
/// which database decodes the message decides whether a counter and a CRC
/// exist at all.
#[test]
fn only_the_replacement_declares_calculated_fields() {
    let id = cannet_core::CanId::standard(COLLIDING_ID).expect("a valid 11-bit id");
    let legacy = load("legacy-vehicle.dbc");
    let modern = load("modern-vehicle.dbc");

    assert!(
        legacy
            .dbc_calculated_fields(id)
            .is_none_or(cannet_dbc::CalculatedFieldsConfig::is_empty),
        "the outgoing database declares none",
    );
    let fields = modern
        .dbc_calculated_fields(id)
        .expect("the replacement declares them");
    assert!(fields.counter.is_some(), "counter");
    assert!(fields.crc.is_some(), "CRC");
}

/// Each file also carries a message the other has never heard of, so the
/// pair covers the one-sided case as well as the contested one.
#[test]
fn each_file_carries_a_message_the_other_does_not() {
    let legacy = load("legacy-vehicle.dbc");
    let modern = load("modern-vehicle.dbc");
    let names = |db: &Database| {
        db.dbc_content()
            .iter()
            .map(|m| m.name.clone())
            .collect::<Vec<_>>()
    };
    assert!(names(&legacy).contains(&"LegacyOnly".to_owned()));
    assert!(names(&modern).contains(&"ModernOnly".to_owned()));
    assert!(!names(&legacy).contains(&"ModernOnly".to_owned()));
    assert!(!names(&modern).contains(&"LegacyOnly".to_owned()));
}
