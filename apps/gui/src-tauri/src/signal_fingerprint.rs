//! Per-signal **encoding fingerprints**: a short stamp over everything
//! that decides what one signal's samples are, and nothing else.
//!
//! A persisted pyramid holds *decoded* samples, so it is only reusable
//! against a model that would decode them the same way. The whole-set
//! stamp (`app_state::dbc_fingerprint`, carried in
//! [`PyramidValidity`](crate::signal_cache::PyramidValidity)) answers
//! that for the DBC set as a *file* set — path, bus scoping, load order,
//! size, modification time — which is correct but far too coarse: a copy,
//! a checkout or a backup tool rewriting a modification time invalidates
//! every signal's pyramid for a decode that did not change by a bit.
//!
//! A fingerprint here is per signal and over the *parsed* model:
//! [`dbc_encoding`] hashes the signal's candidate chain — every loaded
//! database that defines that signal in that message *and* may decode
//! the series' bus, in load order, each as the [`SignalDecodeSpec`]s it
//! offers. Nothing about the files the databases were parsed from
//! enters it.
//!
//! **The chain, not a nominated winner.** The decode path resolves per
//! frame, not per set: `signal_sampler::sample_shared` takes the first
//! database that yields the name *for that payload*, and a database can
//! withhold it (a multiplexor arm that doesn't match, a payload too
//! short) and let the next one answer. So every database that defines the
//! signal is an input, in order — and a database that defines nothing
//! about it contributes nothing, which is what makes re-prioritising
//! unrelated databases invalidate nothing.
//!
//! **File-backed series** (`FileSignalInfo`) fingerprint against their
//! source instead ([`file_source`]): their samples were read out of a
//! capture file and no DBC ever bore on them.
//!
//! ## The hash, and why this one
//!
//! FNV-1a 64 over an explicit, length-delimited byte encoding — the same
//! construction the whole-set stamp and the pyramid file-name base
//! already use, so there is one hash idiom in this area rather than
//! three. What matters about the *choice* is what it rules out:
//!
//! - **Not `std::hash::Hasher`.** The default hasher is `SipHash` keyed
//!   per process; a fingerprint written by one launch would never match
//!   the next. Nor is `Hash`'s byte encoding stable across Rust
//!   versions.
//! - **No iteration-order dependence.** Everything hashed is walked in a
//!   declared order — the loaded set in load order, a message's `SG_`
//!   entries in declaration order — never out of a `HashMap`.
//! - **Fixed-width, fixed-endian.** Integers are mixed little-endian and
//!   `f64` as `to_bits()`, so the same model fingerprints the same on
//!   any target.
//! - **Length-delimited and tagged.** Every string is preceded by its
//!   length and every section by a tag byte, so no two different models
//!   can serialise to the same bytes by running their fields together.
//!
//! A 64-bit non-cryptographic hash is the right weight for a
//! trusted-input equality check over a few thousand signals; the inputs
//! are the user's own DBCs, not an adversary's. `f64` fields are
//! compared bit-wise, so the fingerprint moves on a `0.0` → `-0.0` edit
//! that changes no value — conservative in the safe direction.

use cannet_core::CanId;
use cannet_dbc::{Database, FloatKind, MuxGate, SignalDecodeSpec, SignalMux};

use crate::filter;
use crate::signal_cache::FileSignalInfo;

/// Section tag for a DBC-backed signal's fingerprint.
const TAG_DBC: u8 = b'D';
/// Section tag for a file-backed signal's fingerprint. Distinct from
/// [`TAG_DBC`] in the first byte mixed, so the two kinds cannot collide
/// however their bodies line up.
const TAG_FILE: u8 = b'F';
/// Section tag opening one candidate database's contribution.
const TAG_CANDIDATE: u8 = b'C';
/// Section tag closing the candidate chain, so a chain is never a prefix
/// of a longer one.
const TAG_END: u8 = b'.';

/// One loaded DBC as a fingerprint sees it: the parsed database and the
/// bus ids it is scoped to. Borrowed — a fingerprint is computed under
/// the same lock hold that reads the loaded set.
pub struct DbcScope<'a> {
    pub db: &'a Database,
    pub buses: &'a [String],
}

/// FNV-1a 64, fed an explicit canonical encoding. See the module docs
/// for why the hash is spelled out here rather than taken from
/// `std::hash`.
struct Fnv(u64);

impl Fnv {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    const fn new() -> Self {
        Self(Self::OFFSET)
    }

    fn mix_bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(Self::PRIME);
        }
    }

    fn mix_u8(&mut self, v: u8) {
        self.mix_bytes(&[v]);
    }

    fn mix_bool(&mut self, v: bool) {
        self.mix_u8(u8::from(v));
    }

    fn mix_u32(&mut self, v: u32) {
        self.mix_bytes(&v.to_le_bytes());
    }

    fn mix_u64(&mut self, v: u64) {
        self.mix_bytes(&v.to_le_bytes());
    }

    fn mix_f64(&mut self, v: f64) {
        self.mix_bytes(&v.to_bits().to_le_bytes());
    }

    fn mix_len(&mut self, n: usize) {
        self.mix_u64(u64::try_from(n).unwrap_or(u64::MAX));
    }

    /// Length first, so two adjacent strings can never be re-split.
    fn mix_str(&mut self, s: &str) {
        self.mix_len(s.len());
        self.mix_bytes(s.as_bytes());
    }

    fn finish(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// Mix one `SG_` entry's decode spec — every field of it, since every
/// field of it is an input `decode_signal` reads.
fn mix_spec(h: &mut Fnv, spec: &SignalDecodeSpec) {
    h.mix_u64(spec.start_bit);
    h.mix_u64(spec.size);
    h.mix_bool(spec.big_endian);
    h.mix_bool(spec.signed);
    h.mix_f64(spec.factor);
    h.mix_f64(spec.offset);
    h.mix_u8(match spec.float_kind {
        FloatKind::Integer => 0,
        FloatKind::Float32 => 1,
        FloatKind::Float64 => 2,
    });
    match spec.mux {
        SignalMux::Plain => h.mix_u8(0),
        SignalMux::Multiplexor => h.mix_u8(1),
        SignalMux::Multiplexed { selector } => {
            h.mix_u8(2);
            h.mix_u64(selector);
        }
        SignalMux::MultiplexorAndMultiplexed { selector } => {
            h.mix_u8(3);
            h.mix_u64(selector);
        }
    }
    match spec.mux_gate {
        None => h.mix_u8(0),
        Some(MuxGate {
            start_bit,
            size,
            big_endian,
        }) => {
            h.mix_u8(1);
            h.mix_u64(start_bit);
            h.mix_u64(size);
            h.mix_bool(big_endian);
        }
    }
}

/// The encoding fingerprint of one DBC-backed series: its key, then its
/// candidate chain through `dbcs` **in load order**.
///
/// The key is mixed in too, so a fingerprint recorded for one series can
/// never validate another's samples.
///
/// A database that defines nothing for `(message_id, extended,
/// signal_name)` is skipped entirely rather than mixed as an empty
/// contribution — that is what makes loading, unloading or re-ordering
/// an unrelated DBC leave this signal's fingerprint where it is. An
/// unrepresentable id, or a set in which no database defines the signal
/// at all, yields the empty chain's fingerprint: well-defined, and
/// distinct from every chain that decodes something.
///
/// **Bus scoping decides who is even a candidate.** A series scoped to
/// a bus takes only that bus's frames, and the decode path judges every
/// database against the bus a frame arrived on
/// ([`filter::dbc_applies`]), so a database scoped elsewhere is skipped
/// entirely — editing it cannot move a sample and must not invalidate
/// the pyramid. `bus_id = None` is the any-bus series and is the
/// exception: its frames arrive from every bus and each is decoded by
/// whichever database applies to *that* bus, so its chain is every
/// defining database, scoped or not. The scoping of a database that
/// *is* a candidate joins its contribution, because a re-scope can
/// change which frames it answers for.
pub fn dbc_encoding(
    dbcs: &[DbcScope<'_>],
    bus_id: Option<&str>,
    message_id: u32,
    extended: bool,
    signal_name: &str,
) -> String {
    let mut h = Fnv::new();
    h.mix_u8(TAG_DBC);
    h.mix_bool(bus_id.is_some());
    h.mix_str(bus_id.unwrap_or(""));
    h.mix_u32(message_id);
    h.mix_bool(extended);
    h.mix_str(signal_name);
    let id = if extended {
        CanId::extended(message_id)
    } else {
        CanId::standard(message_id)
    };
    if let Ok(id) = id {
        for dbc in dbcs {
            // Only the databases that can decode *this* series. A
            // bus-scoped series takes frames from one bus, so a
            // database `filter::dbc_applies` rejects for that bus can
            // never supply one of its samples — editing it must not
            // force a rebuild that provably cannot move a value.
            // `bus_id: None` is the any-bus series and keeps the whole
            // chain: its frames arrive from every bus and each is
            // decoded by whichever database applies to that one.
            if let Some(bus) = bus_id {
                if !filter::dbc_applies(dbc.buses, Some(bus)) {
                    continue;
                }
            }
            let specs = dbc.db.signal_decode_specs(id, signal_name);
            if specs.is_empty() {
                continue;
            }
            h.mix_u8(TAG_CANDIDATE);
            h.mix_len(dbc.buses.len());
            for bus in dbc.buses {
                h.mix_str(bus);
            }
            h.mix_len(specs.len());
            for spec in &specs {
                mix_spec(&mut h, spec);
            }
        }
    }
    h.mix_u8(TAG_END);
    h.finish()
}

/// The fingerprint of a **file-backed** series: which channel of which
/// file it was read from.
///
/// No DBC bears on it, and neither does the source file's own size or
/// modification time. The samples were read once, at import, and the
/// file is never opened again — requiring it to still be there, byte for
/// byte, would strand a series whose source has merely moved. What
/// remains is identity: the path it was imported from, the signal
/// channel group index inside it, and the channel name. Everything else
/// `FileSignalInfo` carries (unit, group name, value table) is metadata
/// the manifest stores and serves; none of it decided a sample.
pub fn file_source(info: &FileSignalInfo) -> String {
    let mut h = Fnv::new();
    h.mix_u8(TAG_FILE);
    h.mix_str(&info.source_path);
    h.mix_u32(info.group);
    h.mix_str(&info.name);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::LoadedDbc;
    use crate::signal_cache::FileSignalInfo;
    use crate::signal_sampler;
    use crate::trace_store::RawTraceFrame;
    use cannet_core::{CanFramePayload, Direction};
    use std::sync::Arc;

    /// A DBC around `body` — the preamble every fixture here shares.
    fn dbc_text(body: &str) -> String {
        format!("VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU ECU2\n\n{body}")
    }

    /// A one-message DBC whose message 256 carries exactly the `SG_`
    /// declarations in `sigs` (each written without the leading `SG_`).
    fn message(sigs: &[&str]) -> String {
        let mut body = String::from("BO_ 256 M: 8 ECU\n");
        for s in sigs {
            body.push_str(" SG_ ");
            body.push_str(s);
            body.push('\n');
        }
        dbc_text(&body)
    }

    /// The plain signal every "one input at a time" test moves off.
    const PLAIN: &str = "S : 0|8@1+ (1,0) [0|0] \"\" ECU2";

    fn parse(text: &str) -> Database {
        Database::parse(text).expect("fixture parses")
    }

    fn scope<'a>(db: &'a Database, buses: &'a [String]) -> DbcScope<'a> {
        DbcScope { db, buses }
    }

    /// Fingerprint of signal `S` in message 256 of the single unscoped
    /// DBC `text`.
    fn fp_body(text: &str) -> String {
        fp_named(text, "S")
    }

    fn fp_named(text: &str, signal: &str) -> String {
        let db = parse(text);
        dbc_encoding(&[scope(&db, &[])], None, 256, false, signal)
    }

    /// Fingerprint of `S` in a one-message DBC declaring only `sig`.
    fn fp_of(sig: &str) -> String {
        fp_body(&message(&[sig]))
    }

    #[test]
    fn every_bit_layout_input_moves_the_fingerprint() {
        let base = fp_of(PLAIN);
        assert_eq!(base, fp_of(PLAIN), "stable across runs");
        assert_ne!(base, fp_of("S : 1|8@1+ (1,0) [0|0] \"\" ECU2"), "start bit");
        assert_ne!(base, fp_of("S : 0|16@1+ (1,0) [0|0] \"\" ECU2"), "length");
        assert_ne!(
            base,
            fp_of("S : 0|8@0+ (1,0) [0|0] \"\" ECU2"),
            "byte order"
        );
        assert_ne!(base, fp_of("S : 0|8@1- (1,0) [0|0] \"\" ECU2"), "sign");
    }

    #[test]
    fn every_scaling_input_moves_the_fingerprint() {
        let base = fp_of(PLAIN);
        assert_ne!(base, fp_of("S : 0|8@1+ (2,0) [0|0] \"\" ECU2"), "factor");
        assert_ne!(base, fp_of("S : 0|8@1+ (1,5) [0|0] \"\" ECU2"), "offset");

        // `SIG_VALTYPE_` re-reads the same bits as an IEEE float.
        let wide = "S : 0|32@1+ (1,0) [0|0] \"\" ECU2";
        let integer = message(&[wide]);
        let float = format!("{integer}\nSIG_VALTYPE_ 256 S : 1;\n");
        assert_ne!(fp_body(&integer), fp_body(&float), "SIG_VALTYPE_");
    }

    #[test]
    fn every_mux_input_moves_the_fingerprint() {
        let gated = |gate: &str, sig: &str| {
            fp_body(&message(&[
                &format!("Sel M : {gate} (1,0) [0|0] \"\" ECU2"),
                sig,
            ]))
        };
        let base = gated("0|8@1+", "S m0 : 8|16@1+ (1,0) [0|0] \"\" ECU2");
        assert_ne!(
            base,
            gated("0|8@1+", "S : 8|16@1+ (1,0) [0|0] \"\" ECU2"),
            "a gated signal is not a plain one"
        );
        assert_ne!(
            base,
            gated("0|8@1+", "S m1 : 8|16@1+ (1,0) [0|0] \"\" ECU2"),
            "the selector that admits it"
        );
        assert_ne!(
            base,
            gated("24|8@1+", "S m0 : 8|16@1+ (1,0) [0|0] \"\" ECU2"),
            "the bits the gate itself is read from"
        );
        // …but only for a signal the gate actually admits or withholds.
        assert_eq!(
            gated("0|8@1+", "S : 8|16@1+ (1,0) [0|0] \"\" ECU2"),
            gated("24|8@1+", "S : 8|16@1+ (1,0) [0|0] \"\" ECU2"),
            "a plain signal is in every frame whatever the gate says"
        );
    }

    #[test]
    fn message_identity_moves_the_fingerprint() {
        let db = parse(&message(&[PLAIN]));
        let at =
            |id: u32, extended: bool| dbc_encoding(&[scope(&db, &[])], None, id, extended, "S");
        assert_ne!(at(256, false), at(257, false), "another message id");
        assert_ne!(
            at(256, false),
            at(256, true),
            "the same number as an extended id is another message"
        );
    }

    #[test]
    fn signal_identity_moves_the_fingerprint() {
        let base = fp_of(PLAIN);
        assert_ne!(
            base,
            fp_of("RENAMED : 0|8@1+ (1,0) [0|0] \"\" ECU2"),
            "a signal that is no longer there decodes nothing"
        );

        // A `SystemSignalLongSymbol` rename is a rename: the decode path
        // matches on the resolved name, so the short one stops resolving.
        let long = format!(
            "{}\nBA_DEF_ SG_ \"SystemSignalLongSymbol\" STRING ;\n\
             BA_DEF_DEF_ \"SystemSignalLongSymbol\" \"\";\n\
             BA_ \"SystemSignalLongSymbol\" SG_ 256 S \"SLongEnoughToBeTruncated\";\n",
            message(&[PLAIN])
        );
        assert_ne!(base, fp_body(&long), "renamed by long symbol");
        assert_eq!(
            fp_named(&long, "SLongEnoughToBeTruncated"),
            fp_named(
                &message(&["SLongEnoughToBeTruncated : 0|8@1+ (1,0) [0|0] \"\" ECU2"]),
                "SLongEnoughToBeTruncated"
            ),
            "and the long name resolves to the same encoding as declaring it outright"
        );
    }

    #[test]
    fn the_dbc_set_resolution_moves_the_fingerprint() {
        let a = parse(&message(&[PLAIN]));
        let b = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let bus1 = vec!["bus1".to_string()];
        let fp = |dbcs: &[DbcScope<'_>]| dbc_encoding(dbcs, None, 256, false, "S");

        let base = fp(&[scope(&a, &[])]);
        assert_ne!(base, fp(&[]), "no DBC at all decodes nothing");
        assert_ne!(
            base,
            fp(&[scope(&a, &[]), scope(&b, &[])]),
            "a second definition can win frames the first does not"
        );
        assert_ne!(
            fp(&[scope(&a, &[]), scope(&b, &[])]),
            fp(&[scope(&b, &[]), scope(&a, &[])]),
            "load order is decode priority between two definitions"
        );
        assert_ne!(
            base,
            fp(&[scope(&a, &bus1)]),
            "the bus scoping of a contributing DBC"
        );

        // Two `SG_` lines of one name, in different multiplexor arms:
        // `decode_message` picks between them per payload, so both are
        // inputs.
        let one_arm = message(&[
            "Sel M : 0|8@1+ (1,0) [0|0] \"\" ECU2",
            "S m0 : 8|16@1+ (1,0) [0|0] \"\" ECU2",
        ]);
        let two_arms = message(&[
            "Sel M : 0|8@1+ (1,0) [0|0] \"\" ECU2",
            "S m0 : 8|16@1+ (1,0) [0|0] \"\" ECU2",
            "S m1 : 24|16@1+ (1,0) [0|0] \"\" ECU2",
        ]);
        assert_ne!(
            fp_body(&one_arm),
            fp_body(&two_arms),
            "a second arm declaring the same name"
        );
    }

    #[test]
    fn only_the_databases_that_can_decode_the_series_bus_are_in_the_chain() {
        // Every frame a `pt`-scoped series takes arrives on `pt`, and a
        // `ch`-scoped database never supplies a value for one of them
        // (`filter::dbc_applies`). It is not a candidate, so it is not
        // in the chain — and editing it must not force a rebuild that
        // provably cannot change a sample.
        let a = parse(&message(&[PLAIN]));
        let ch = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let ch_edited = parse(&message(&["S : 24|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let (pt_bus, ch_bus) = (vec!["pt".to_string()], vec!["ch".to_string()]);
        let fp = |dbcs: &[DbcScope<'_>]| dbc_encoding(dbcs, Some("pt"), 256, false, "S");

        let alone = fp(&[scope(&a, &pt_bus)]);
        assert_eq!(
            alone,
            fp(&[scope(&a, &pt_bus), scope(&ch, &ch_bus)]),
            "a chassis-scoped database is no part of a powertrain series"
        );
        assert_eq!(
            fp(&[scope(&a, &pt_bus), scope(&ch, &ch_bus)]),
            fp(&[scope(&a, &pt_bus), scope(&ch_edited, &ch_bus)]),
            "…so re-encoding it invalidates nothing here"
        );
        assert_ne!(
            alone,
            fp(&[scope(&a, &pt_bus), scope(&ch, &[])]),
            "an unscoped database decodes every bus and stays a candidate"
        );
    }

    #[test]
    fn a_null_bus_series_keeps_the_whole_chain() {
        // `bus_id: None` is "the bus is unknown", not "on no bus": the
        // series takes frames from every bus and each one is decoded by
        // whichever database applies to *it*, so every definition is an
        // input however it is scoped.
        let a = parse(&message(&[PLAIN]));
        let ch = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let ch_edited = parse(&message(&["S : 24|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let (pt_bus, ch_bus) = (vec!["pt".to_string()], vec!["ch".to_string()]);
        let fp = |dbcs: &[DbcScope<'_>]| dbc_encoding(dbcs, None, 256, false, "S");

        assert_ne!(
            fp(&[scope(&a, &pt_bus)]),
            fp(&[scope(&a, &pt_bus), scope(&ch, &ch_bus)]),
            "a chassis-scoped definition decodes this series' chassis frames"
        );
        assert_ne!(
            fp(&[scope(&a, &pt_bus), scope(&ch, &ch_bus)]),
            fp(&[scope(&a, &pt_bus), scope(&ch_edited, &ch_bus)]),
            "…so re-encoding it does invalidate the pyramid"
        );
    }

    #[test]
    fn an_unscoped_project_keeps_every_fingerprint_it_had() {
        // The tightening above costs a one-time rebuild of the signals
        // whose chain shrank — and a project that scopes no DBC has
        // none, because an unscoped database applies to every bus and
        // is never skipped. The literals are what `dbc_encoding`
        // produced for these inputs *before* the tightening, so this
        // fails if the change ever reaches an unscoped set.
        let a = parse(&message(&[PLAIN]));
        let b = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let set = [scope(&a, &[]), scope(&b, &[])];
        assert_eq!(
            dbc_encoding(&set, None, 256, false, "S"),
            "cc804e2183610fba",
            "an any-bus series over two unscoped databases"
        );
        assert_eq!(
            dbc_encoding(&set, Some("pt"), 256, false, "S"),
            "fbf0ef6e0caa9bad",
            "a bus-scoped series over two unscoped databases"
        );
        assert_eq!(
            dbc_encoding(&[scope(&a, &[])], Some("pt"), 256, false, "S"),
            "97983dac27df7f54",
            "a bus-scoped series over one unscoped database"
        );
    }

    #[test]
    fn a_load_order_change_that_does_not_change_the_winner_moves_nothing() {
        let a = parse(&message(&[PLAIN]));
        // Same signal, same encoding, different file.
        let twin = parse(&message(&[PLAIN]));
        // A database with no bearing on `(256, S)` at all.
        let elsewhere = parse(&dbc_text(
            "BO_ 300 Other: 8 ECU\n SG_ T : 0|8@1+ (1,0) [0|0] \"\" ECU2\n",
        ));
        let fp = |dbcs: &[DbcScope<'_>]| dbc_encoding(dbcs, None, 256, false, "S");

        let base = fp(&[scope(&a, &[])]);
        assert_eq!(
            base,
            fp(&[scope(&a, &[]), scope(&elsewhere, &[])]),
            "a DBC that defines nothing about this signal contributes nothing"
        );
        assert_eq!(
            fp(&[scope(&a, &[]), scope(&elsewhere, &[])]),
            fp(&[scope(&elsewhere, &[]), scope(&a, &[])]),
            "…so re-prioritising it changes no decode"
        );
        assert_eq!(
            fp(&[scope(&a, &[]), scope(&twin, &[])]),
            fp(&[scope(&twin, &[]), scope(&a, &[])]),
            "two identical definitions decode identically in either order"
        );
    }

    #[test]
    fn a_touched_but_unchanged_dbc_moves_no_signals_fingerprint() {
        // The case the whole task exists for: a copy, a checkout or a
        // backup tool rewrites a DBC's modification time without
        // changing a byte of it. The whole-set stamp this replaced could
        // not tell that from an edit, and discarded every pyramid for it.
        // A fingerprint over the parsed model cannot see it at all.
        let dir = std::env::temp_dir().join(format!("cannet-fp-touch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.dbc");
        let text = message(&[PLAIN]);
        std::fs::write(&path, &text).unwrap();
        let loaded = [LoadedDbc {
            path: path.to_string_lossy().into_owned(),
            db: Arc::new(parse(&text)),
            buses: Vec::new(),
        }];
        let before_signal = dbc_encoding(
            &[scope(&loaded[0].db, &loaded[0].buses)],
            None,
            256,
            false,
            "S",
        );

        let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        let touched = before_mtime + std::time::Duration::from_hours(1);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(touched)
            .unwrap();
        assert!(
            std::fs::metadata(&path).unwrap().modified().unwrap() > before_mtime,
            "the fixture really did touch the file"
        );

        assert_eq!(
            before_signal,
            dbc_encoding(
                &[scope(&loaded[0].db, &loaded[0].buses)],
                None,
                256,
                false,
                "S"
            ),
            "the per-signal fingerprint never reads the file's metadata"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_encoding_change_moves_only_its_own_signals_fingerprint() {
        let before = parse(&message(&[
            "S : 0|8@1+ (1,0) [0|0] \"\" ECU2",
            "T : 8|8@1+ (1,0) [0|0] \"\" ECU2",
        ]));
        let after = parse(&message(&[
            "S : 0|8@1+ (1,0) [0|0] \"\" ECU2",
            "T : 8|16@1+ (0.5,0) [0|0] \"\" ECU2",
        ]));
        let fp =
            |db: &Database, signal: &str| dbc_encoding(&[scope(db, &[])], None, 256, false, signal);
        assert_eq!(fp(&before, "S"), fp(&after, "S"), "S is untouched");
        assert_ne!(fp(&before, "T"), fp(&after, "T"), "T was re-encoded");
    }

    #[test]
    fn nothing_that_only_labels_or_describes_moves_the_fingerprint() {
        let base = fp_of(PLAIN);
        let with = |extra: &str| fp_body(&format!("{}\n{extra}\n", message(&[PLAIN])));

        assert_eq!(
            base,
            with("VAL_ 256 S 0 \"Off\" 1 \"On\" ;"),
            "a VAL_ table"
        );
        assert_eq!(
            with("VAL_ 256 S 0 \"Off\" 1 \"On\" ;"),
            with("VAL_ 256 S 0 \"Closed\" 1 \"Open\" ;"),
            "relabelled enumerators"
        );
        assert_eq!(base, with("CM_ SG_ 256 S \"a comment\";"), "a comment");
        assert_eq!(
            base,
            with(
                "BA_DEF_ SG_ \"CannetDisplay\" STRING ;\n\
                 BA_DEF_DEF_ \"CannetDisplay\" \"\";\n\
                 BA_ \"CannetDisplay\" SG_ 256 S \"radix=hex\";"
            ),
            "a render-only attribute (ADR 0043)"
        );
        assert_eq!(base, fp_of("S : 0|8@1+ (1,0) [0|0] \"rpm\" ECU2"), "a unit");
        assert_eq!(
            base,
            fp_of("S : 0|8@1+ (1,0) [0|255] \"\" ECU2"),
            "a declared range"
        );
        assert_eq!(
            base,
            fp_of("S : 0|8@1+ (1,0) [0|0] \"\" ECU"),
            "a receiving node"
        );
        assert_eq!(
            base,
            fp_body(&dbc_text(&format!("BO_ 256 M: 4 ECU\n SG_ {PLAIN}\n"))),
            "the BO_ declared length — extraction bounds-checks the payload it is given"
        );
        assert_eq!(
            base,
            fp_body(&dbc_text(&format!(
                "BO_ 256 RENAMED: 8 ECU\n SG_ {PLAIN}\n"
            ))),
            "the message's name — the lookup is by id"
        );
        assert_eq!(
            base,
            fp_body(&dbc_text(&format!("BO_ 256 M: 8 ECU2\n SG_ {PLAIN}\n"))),
            "the transmitting node"
        );
    }

    #[test]
    fn labels_are_resolved_at_serve_not_baked_into_samples() {
        // The task's open question, answered by experiment: if a label
        // were baked into a sample, changing the `VAL_` table would
        // change what the sampler produces.
        let frames: Vec<RawTraceFrame> = (0u8..4)
            .map(|v| RawTraceFrame {
                timestamp_ns: u64::from(v) * 1_000_000,
                channel: 0,
                id: 256,
                extended: false,
                direction: Direction::Rx,
                payload: CanFramePayload::Classic(vec![v, 0, 0, 0, 0, 0, 0, 0]),
                bus_id: None,
            })
            .collect();
        let sample = |extra: &str| {
            let db = parse(&format!("{}\n{extra}\n", message(&[PLAIN])));
            signal_sampler::sample_signal(&frames, &db, 256, false, "S")
        };
        let unlabelled = sample("");
        assert_eq!(unlabelled.len(), 4, "every frame sampled");
        assert_eq!(
            unlabelled,
            sample("VAL_ 256 S 0 \"Off\" 1 \"On\" 2 \"Fault\" 3 \"SNA\" ;"),
            "labelling the codes changes no sample"
        );
        assert_eq!(
            unlabelled,
            sample("VAL_ 256 S 0 \"Closed\" 1 \"Open\" 2 \"Jammed\" 3 \"Unknown\" ;"),
            "relabelling them changes no sample either"
        );
        // A pyramid slot is a `(f64, f64)` pair; there is no field a
        // label could occupy. The label is served separately, from
        // whatever DBC set is loaded at the time.
        assert!(unlabelled.iter().all(|p| p.value.fract() == 0.0));
    }

    #[test]
    fn a_file_backed_signal_fingerprints_against_its_source_not_the_dbc_set() {
        let info = |source: &str, group: u32, name: &str| FileSignalInfo {
            source_path: source.to_string(),
            group,
            group_name: Some("grp".to_string()),
            name: name.to_string(),
            unit: "V".to_string(),
            value_table: Vec::new(),
        };
        let base = file_source(&info("/captures/run.mf4", 3, "Speed"));
        assert_eq!(base, file_source(&info("/captures/run.mf4", 3, "Speed")));
        assert_ne!(base, file_source(&info("/captures/other.mf4", 3, "Speed")));
        assert_ne!(base, file_source(&info("/captures/run.mf4", 4, "Speed")));
        assert_ne!(base, file_source(&info("/captures/run.mf4", 3, "Torque")));

        // Metadata the manifest carries and serves from is not identity:
        // it never decided a sample.
        let mut relabelled = info("/captures/run.mf4", 3, "Speed");
        relabelled.group_name = Some("renamed".to_string());
        relabelled.unit = "km/h".to_string();
        relabelled.value_table = vec![crate::ipc::ValueTableEntryRecord {
            raw: 0,
            label: "Stopped".to_string(),
        }];
        assert_eq!(base, file_source(&relabelled));
    }
}
