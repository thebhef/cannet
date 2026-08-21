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
//! [`dbc_encoding`] hashes the [`SignalDecodeSpec`]s of the one
//! definition that decodes the series. Nothing about the files the
//! databases were parsed from enters it.
//!
//! **One definition, and nothing else.** A decoded value comes from
//! exactly one signal definition, and everything derived from it depends
//! on that definition alone (ADR 0054). So the fingerprint covers the
//! winner's decode specs and stops: not the other buses that database is
//! assigned to, and not the databases behind it in load order, neither of
//! which can change a sample. Two states that decode identically must
//! fingerprint identically, which is why a different file supplying the
//! same specification revives a parked pyramid rather than rebuilding it.
//!
//! **Which one wins** is the resolution rule of ADR 0054, read in load
//! order over the databases assigned to the series' bus — unless a
//! [`SignalDbcPicks`] entry names one, overriding the default for that
//! signal. Either way the fingerprint follows the decode, so a pick is a
//! change of encoding: the samples the other database produced cannot be
//! revived against it, and reverting the pick restores the fingerprint
//! they were parked under.
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

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

use cannet_core::CanId;
use cannet_dbc::{Database, FloatKind, MuxGate, SignalDecodeSpec, SignalMux};

use crate::filter;
use crate::signal_cache::FileSignalInfo;
use crate::signal_snapshot::signal_identity;

/// Section tag for a DBC-backed signal's fingerprint.
const TAG_DBC: u8 = b'D';
/// Section tag for a file-backed signal's fingerprint. Distinct from
/// [`TAG_DBC`] in the first byte mixed, so the two kinds cannot collide
/// however their bodies line up.
const TAG_FILE: u8 = b'F';
/// Section tag opening the winning definition's decode specification.
const TAG_WINNER: u8 = b'W';
/// Section tag closing the body, so a series no loaded database defines
/// is never a prefix of one that is defined.
const TAG_END: u8 = b'.';

/// One loaded DBC as a fingerprint sees it: its identity (the loaded
/// path), the parsed database and the bus ids it is scoped to.
/// Borrowed — a fingerprint is computed under the same lock hold that
/// reads the loaded set.
///
/// The path is not mixed into any fingerprint: a fingerprint is over
/// the *parsed model*, so which file a definition came from must not
/// move it (see the module docs). It is here because a
/// [`SignalDbcPicks`] entry names a database by path, and resolving one
/// has to be able to tell the candidates apart.
pub struct DbcScope<'a> {
    pub path: &'a str,
    pub db: &'a Database,
    pub buses: &'a [String],
}

/// Per-signal choices of *which* assigned database decodes a signal:
/// signal identity ([`signal_identity`], ADR 0038) → the loaded path of
/// the chosen database.
///
/// A signal is in here only when the user has made a choice for it, so
/// the map is empty in every project that never had an ambiguity to
/// resolve, and an absent entry means "the databases resolve in their
/// consistent order" — the load-order default. Persisted in the project
/// file ([`crate::project::Project::signal_dbc_picks`]).
pub type SignalDbcPicks = HashMap<String, String>;

/// **The model a signal decodes against**: the loaded DBC set, in load
/// order and with each database's bus assignment, plus the per-signal
/// database picks that override the load-order default.
///
/// The two travel together because a pick is only meaningful against
/// the set it selects within, and because every consumer that resolves
/// "which database serves this signal" has to apply the same rule —
/// bundling them makes it structurally impossible for a call site to
/// pass the set and forget the picks. It derefs to the scope slice, so
/// the many places that only need the set read exactly as they did.
///
/// The picks are shared by `Arc`: a model is built per serve and the
/// map is empty in almost every project, so cloning it must cost
/// nothing.
pub struct DecodeModel<'a> {
    dbcs: Vec<DbcScope<'a>>,
    picks: Arc<SignalDbcPicks>,
}

impl<'a> DecodeModel<'a> {
    /// The set plus the picks that apply to it.
    #[must_use]
    pub fn new(dbcs: Vec<DbcScope<'a>>, picks: Arc<SignalDbcPicks>) -> Self {
        Self { dbcs, picks }
    }

    /// The set with no picks — the load-order default everywhere.
    #[must_use]
    pub fn plain(dbcs: Vec<DbcScope<'a>>) -> Self {
        Self {
            dbcs,
            picks: Arc::default(),
        }
    }

    /// The picks this model resolves against.
    #[must_use]
    pub fn picks(&self) -> &SignalDbcPicks {
        &self.picks
    }

    /// The path a pick names for one signal, or `None` when the user has
    /// made no choice for it. Costs nothing — not even the identity
    /// string — in a project with no picks at all.
    fn pick_path(
        &self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
    ) -> Option<&str> {
        if self.picks.is_empty() {
            return None;
        }
        self.picks
            .get(&signal_identity(
                bus_id,
                message_id,
                extended,
                signal_name,
                false,
            ))
            .map(String::as_str)
    }

    /// **The resolution rule, once.** Where a pick names a database that
    /// is loaded, is assigned to the signal's bus, and actually defines
    /// the signal, this is its position among the databases eligible to
    /// decode a frame on that bus (in load order) — and that database
    /// alone is the signal's candidate chain. `None` everywhere else,
    /// which is the load-order default: no pick recorded, or a pick
    /// naming a database that has since been unassigned, removed, or
    /// edited so it no longer defines the signal.
    ///
    /// A stale pick is *ignored*, not honoured-and-empty: a pick must
    /// never be able to silence a signal that a database still defines.
    #[must_use]
    pub fn picked_index(
        &self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
    ) -> Option<usize> {
        let pick = self.pick_path(bus_id, message_id, extended, signal_name)?;
        let id = CanId::new(message_id, extended).ok()?;
        self.dbcs
            .iter()
            .filter(|d| filter::dbc_applies(d.buses, bus_id))
            .position(|d| d.path == pick && !d.db.signal_decode_specs(id, signal_name).is_empty())
    }
}

impl<'a> Deref for DecodeModel<'a> {
    type Target = [DbcScope<'a>];

    fn deref(&self) -> &Self::Target {
        &self.dbcs
    }
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

/// The encoding fingerprint of one DBC-backed series: its key, then the
/// decode specification of the definition that decodes it.
///
/// The key is mixed in too, so a fingerprint recorded for one series can
/// never validate another's samples.
///
/// **Which definition that is** is the resolution rule of ADR 0054, read
/// off `dbcs` in load order: the first database assigned to the series'
/// bus that defines `(message_id, extended, signal_name)`, or the one a
/// per-signal pick names ([`DecodeModel::picked_index`]). Everything
/// else the set contains is left out, because none of it can move a
/// sample:
///
/// - **A database assigned elsewhere, or to nothing, is not eligible.**
///   A series on a bus takes only that bus's frames, and the decode path
///   judges every database against the bus a frame arrived on
///   ([`filter::dbc_applies`]). A series that names no bus is admitted
///   by no assignment either, and so has no definition at all.
/// - **What the winner is *also* assigned to is not part of its decode.**
///   It decodes a frame on this bus the same way whatever other buses it
///   serves, so narrowing an assignment elsewhere leaves this
///   fingerprint where it is.
/// - **The databases behind the winner are irrelevant.** Resolution is
///   first-wins per signal, so a later definition supplies no sample:
///   loading one, editing one or re-prioritising one below the winner
///   moves nothing.
///
/// A set in which no eligible database defines the signal — and an
/// unrepresentable id — yields the no-definition fingerprint:
/// well-defined, and distinct from every fingerprint that decodes
/// something.
///
/// So a *change of definition* is what moves it: editing the winner's
/// `SG_` entry, putting another database in front of it, unassigning it,
/// or naming a different one with a pick. A persisted pyramid decoded
/// under the definition that left cannot revive against the one that
/// replaced it (ADR 0047), and restoring the definition restores the
/// fingerprint the parked pyramid carries — from whichever file now
/// supplies it, since an identical specification is the same encoding.
pub fn dbc_encoding(
    dbcs: &DecodeModel<'_>,
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
        let picked = dbcs.picked_index(bus_id, message_id, extended, signal_name);
        let mut eligible = 0usize;
        for dbc in dbcs.iter() {
            // Only the databases that can decode *this* series: its
            // frames arrive on one bus, so a database
            // `filter::dbc_applies` rejects for that bus can never
            // supply one of its samples — editing it must not force a
            // rebuild that provably cannot move a value.
            if !filter::dbc_applies(dbc.buses, bus_id) {
                continue;
            }
            // The pick's position is counted over the same eligible
            // sequence the decode walks (`signal_sampler::sample_shared`
            // over `scan_chunk`'s `eligible`), so the chain hashed here
            // is the chain that decodes.
            let this = eligible;
            eligible += 1;
            if picked.is_some_and(|p| p != this) {
                continue;
            }
            let specs = dbc.db.signal_decode_specs(id, signal_name);
            if specs.is_empty() {
                continue;
            }
            // The first eligible database that defines the signal is
            // the one that decodes it, and its decode specs are the
            // whole of what a sample depends on (ADR 0054). Not what
            // else it is assigned to, and not the databases behind it.
            h.mix_u8(TAG_WINNER);
            h.mix_len(specs.len());
            for spec in &specs {
                mix_spec(&mut h, spec);
            }
            break;
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

    /// One loaded database, under `path` — the identity a per-signal
    /// pick names, and otherwise no input to any fingerprint.
    fn scope<'a>(path: &'a str, db: &'a Database, buses: &'a [String]) -> DbcScope<'a> {
        DbcScope { path, db, buses }
    }

    /// A set with no picks — the load-order default everywhere, which
    /// is what every test but the pick ones is about.
    fn plain(dbcs: Vec<DbcScope<'_>>) -> DecodeModel<'_> {
        DecodeModel::plain(dbcs)
    }

    /// The bus the fixtures' databases are assigned to, and the bus
    /// their series is on. Assignment governs decode, so a fingerprint
    /// taken over an unassigned database has no chain to move — every
    /// "this input moves the fingerprint" test needs an assigned one.
    const FP_BUS: &str = "bus1";

    fn fp_bus() -> Vec<String> {
        vec![FP_BUS.to_string()]
    }

    /// Fingerprint of signal `S` in message 256 of the single DBC
    /// `text`, assigned to [`FP_BUS`].
    fn fp_body(text: &str) -> String {
        fp_named(text, "S")
    }

    fn fp_named(text: &str, signal: &str) -> String {
        let db = parse(text);
        let bus = fp_bus();
        dbc_encoding(
            &plain(vec![scope("db.dbc", &db, &bus)]),
            Some(FP_BUS),
            256,
            false,
            signal,
        )
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
        let bus = fp_bus();
        let at = |id: u32, extended: bool| {
            dbc_encoding(
                &plain(vec![scope("db.dbc", &db, &bus)]),
                Some(FP_BUS),
                id,
                extended,
                "S",
            )
        };
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
        let bus = fp_bus();
        let fp =
            |dbcs: Vec<DbcScope<'_>>| dbc_encoding(&plain(dbcs), Some(FP_BUS), 256, false, "S");

        let base = fp(vec![scope("a.dbc", &a, &bus)]);
        assert_ne!(base, fp(vec![]), "no DBC at all decodes nothing");
        assert_ne!(
            fp(vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &bus)]),
            fp(vec![scope("b.dbc", &b, &bus), scope("a.dbc", &a, &bus)]),
            "load order is decode priority between two definitions"
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

    /// The set with `S` on [`FP_BUS`] pinned to the database loaded
    /// under `path`.
    fn pinned<'a>(dbcs: Vec<DbcScope<'a>>, path: &str) -> DecodeModel<'a> {
        let mut picks = SignalDbcPicks::new();
        picks.insert(
            signal_identity(Some(FP_BUS), 256, false, "S", false),
            path.to_owned(),
        );
        DecodeModel::new(dbcs, Arc::new(picks))
    }

    #[test]
    fn a_pick_shortens_the_chain_to_the_database_it_names() {
        // A pick is a change of *encoding*, not merely of display: the
        // chain becomes the picked database alone, so a pyramid decoded
        // under the load-order chain cannot revive against it
        // (ADR 0047). Getting this wrong would leave the other
        // database's samples on screen under the picked database's
        // name.
        let a = parse(&message(&[PLAIN]));
        let b = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let bus = fp_bus();
        let both = || vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &bus)];
        let fp = |m: &DecodeModel<'_>| dbc_encoding(m, Some(FP_BUS), 256, false, "S");

        let default = fp(&plain(both()));
        let picked_b = fp(&pinned(both(), "b.dbc"));
        assert_ne!(default, picked_b, "a pick moves the encoding");
        assert_eq!(
            picked_b,
            fp(&plain(vec![scope("b.dbc", &b, &bus)])),
            "…to exactly the chain of the database it names"
        );

        // A pick naming the database the load order already chose
        // names the same definition, so it costs nothing: the
        // fingerprint is the default's. (The command that records one
        // clears the entry in that case, so this shape is never
        // persisted — but the rule here has to be the same either way.)
        assert_eq!(
            fp(&pinned(both(), "a.dbc")),
            fp(&plain(vec![scope("a.dbc", &a, &bus)]))
        );
        assert_eq!(
            fp(&pinned(both(), "a.dbc")),
            default,
            "…so pinning the incumbent parks nothing",
        );
    }

    #[test]
    fn a_stale_pick_leaves_the_chain_where_the_load_order_puts_it() {
        // Three ways a pick goes stale — the database is gone, it is
        // assigned elsewhere, or it no longer defines the signal — and
        // all three fall back to the default rather than shortening the
        // chain to nothing. A pick must never silence a signal.
        let a = parse(&message(&[PLAIN]));
        let b = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let other = parse(&message(&["T : 0|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let bus = fp_bus();
        let elsewhere = vec!["bus2".to_string()];
        let fp = |m: &DecodeModel<'_>| dbc_encoding(m, Some(FP_BUS), 256, false, "S");

        let default = fp(&plain(vec![scope("a.dbc", &a, &bus)]));
        assert_eq!(
            default,
            fp(&pinned(vec![scope("a.dbc", &a, &bus)], "gone.dbc")),
            "the picked database is not loaded"
        );
        assert_eq!(
            fp(&plain(vec![
                scope("a.dbc", &a, &bus),
                scope("b.dbc", &b, &elsewhere),
            ])),
            fp(&pinned(
                vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &elsewhere)],
                "b.dbc",
            )),
            "the picked database is assigned to another bus"
        );
        assert_eq!(
            fp(&plain(vec![
                scope("a.dbc", &a, &bus),
                scope("b.dbc", &other, &bus),
            ])),
            fp(&pinned(
                vec![scope("a.dbc", &a, &bus), scope("b.dbc", &other, &bus)],
                "b.dbc",
            )),
            "the picked database no longer defines the signal"
        );
    }

    #[test]
    fn a_pick_moves_only_the_signal_it_names() {
        // The pick key is the signal identity, so a pick on `S` leaves
        // every other signal of the same message on the load-order
        // default — the same per-signal granularity the decode has.
        let a = parse(&message(&[PLAIN, "T : 8|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let b = parse(&message(&[
            "S : 16|8@1+ (1,0) [0|0] \"\" ECU2",
            "T : 24|8@1+ (1,0) [0|0] \"\" ECU2",
        ]));
        let bus = fp_bus();
        let both = || vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &bus)];
        let fp =
            |m: &DecodeModel<'_>, signal: &str| dbc_encoding(m, Some(FP_BUS), 256, false, signal);
        assert_ne!(fp(&plain(both()), "S"), fp(&pinned(both(), "b.dbc"), "S"));
        assert_eq!(
            fp(&plain(both()), "T"),
            fp(&pinned(both(), "b.dbc"), "T"),
            "T's chain is untouched by a pick on S"
        );
    }

    #[test]
    fn a_databases_other_assignments_are_no_part_of_the_fingerprint() {
        // A value decodes from one definition, and what else the
        // database holding it is assigned to is not part of that
        // definition (ADR 0054). A series on `pt` decodes the same
        // whether its database also serves `ch` or not, so narrowing
        // the assignment elsewhere must not park a pyramid whose
        // samples provably cannot move.
        let a = parse(&message(&[PLAIN]));
        let one = vec!["pt".to_string()];
        let two = vec!["pt".to_string(), "ch".to_string()];
        let renamed = vec!["pt".to_string(), "body".to_string()];
        let fp = |buses: &[String]| {
            dbc_encoding(
                &plain(vec![scope("a.dbc", &a, buses)]),
                Some("pt"),
                256,
                false,
                "S",
            )
        };
        assert_eq!(fp(&one), fp(&two), "another bus it is assigned to");
        assert_eq!(fp(&two), fp(&renamed), "…or what that other bus is called");
    }

    #[test]
    fn only_the_winning_definition_is_in_the_fingerprint() {
        // Decode takes the first eligible database that defines the
        // signal, so a later one supplies no sample and cannot be part
        // of what the samples were decoded under (ADR 0054). Loading
        // one, or editing it, must leave the pyramid alone; making it
        // the winner must not.
        let a = parse(&message(&[PLAIN]));
        let b = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let b_edited = parse(&message(&["S : 24|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let bus = fp_bus();
        let fp =
            |dbcs: Vec<DbcScope<'_>>| dbc_encoding(&plain(dbcs), Some(FP_BUS), 256, false, "S");

        let alone = fp(vec![scope("a.dbc", &a, &bus)]);
        assert_eq!(
            alone,
            fp(vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &bus)]),
            "a second definition the load order never reaches",
        );
        assert_eq!(
            fp(vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &bus)]),
            fp(vec![
                scope("a.dbc", &a, &bus),
                scope("b_edited.dbc", &b_edited, &bus)
            ]),
            "…so re-encoding it invalidates nothing here",
        );
        assert_ne!(
            alone,
            fp(vec![scope("b.dbc", &b, &bus), scope("a.dbc", &a, &bus)]),
            "putting it first makes it the definition that decodes",
        );
    }

    #[test]
    fn only_the_databases_that_can_decode_the_series_bus_are_in_the_chain() {
        // Every frame a `pt`-scoped series takes arrives on `pt`, and a
        // `ch`-scoped database never supplies a value for one of them
        // (`filter::dbc_applies`). It is not eligible, so it can never
        // be the definition — and editing it must not force a rebuild
        // that provably cannot change a sample.
        let a = parse(&message(&[PLAIN]));
        let ch = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let ch_edited = parse(&message(&["S : 24|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let (pt_bus, ch_bus) = (vec!["pt".to_string()], vec!["ch".to_string()]);
        let fp = |dbcs: Vec<DbcScope<'_>>| dbc_encoding(&plain(dbcs), Some("pt"), 256, false, "S");

        let alone = fp(vec![scope("a.dbc", &a, &pt_bus)]);
        assert_eq!(
            alone,
            fp(vec![
                scope("a.dbc", &a, &pt_bus),
                scope("ch.dbc", &ch, &ch_bus)
            ]),
            "a chassis-scoped database is no part of a powertrain series"
        );
        assert_eq!(
            fp(vec![
                scope("a.dbc", &a, &pt_bus),
                scope("ch.dbc", &ch, &ch_bus)
            ]),
            fp(vec![
                scope("a.dbc", &a, &pt_bus),
                scope("ch_edited.dbc", &ch_edited, &ch_bus)
            ]),
            "…so re-encoding it invalidates nothing here"
        );
        assert_eq!(
            alone,
            fp(vec![scope("a.dbc", &a, &pt_bus), scope("ch.dbc", &ch, &[])]),
            "a database assigned to no bus is a candidate for nothing"
        );
    }

    #[test]
    fn a_series_that_names_no_bus_has_the_empty_chain() {
        // No assignment admits a query that names no bus, so a
        // DBC-backed series without one has no candidate at all: its
        // fingerprint is the empty chain's, whatever is loaded and
        // however it is assigned.
        let a = parse(&message(&[PLAIN]));
        let ch = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let (pt_bus, ch_bus) = (vec!["pt".to_string()], vec!["ch".to_string()]);
        let fp = |dbcs: Vec<DbcScope<'_>>| dbc_encoding(&plain(dbcs), None, 256, false, "S");

        let empty = fp(vec![]);
        assert_eq!(fp(vec![scope("a.dbc", &a, &pt_bus)]), empty);
        assert_eq!(
            fp(vec![
                scope("a.dbc", &a, &pt_bus),
                scope("ch.dbc", &ch, &ch_bus)
            ]),
            empty
        );
        assert_eq!(fp(vec![scope("a.dbc", &a, &[])]), empty);
        // …and still distinct from a chain that decodes something.
        assert_ne!(
            empty,
            dbc_encoding(
                &plain(vec![scope("a.dbc", &a, &pt_bus)]),
                Some("pt"),
                256,
                false,
                "S"
            ),
        );
    }

    #[test]
    fn an_unassigned_database_is_no_part_of_any_chain() {
        // The successor to the old "an unscoped project keeps every
        // fingerprint" guard, which pinned literals for a set where
        // every database applied to every bus. There is no such set
        // now: loading a file changes no chain until it is assigned, so
        // adding, re-ordering or editing an unassigned database moves
        // nothing.
        let a = parse(&message(&[PLAIN]));
        let b = parse(&message(&["S : 16|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let b_edited = parse(&message(&["S : 24|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let bus = fp_bus();
        let fp =
            |dbcs: Vec<DbcScope<'_>>| dbc_encoding(&plain(dbcs), Some(FP_BUS), 256, false, "S");

        let alone = fp(vec![scope("a.dbc", &a, &bus)]);
        assert_eq!(
            alone,
            fp(vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &[])]),
            "added"
        );
        assert_eq!(
            alone,
            fp(vec![scope("b.dbc", &b, &[]), scope("a.dbc", &a, &bus)]),
            "re-ordered"
        );
        assert_eq!(
            fp(vec![scope("a.dbc", &a, &bus), scope("b.dbc", &b, &[])]),
            fp(vec![
                scope("a.dbc", &a, &bus),
                scope("b_edited.dbc", &b_edited, &[])
            ]),
            "edited"
        );
        // Assigning it is what makes it an input — in front of the
        // incumbent, where it is the definition that decodes.
        assert_ne!(
            alone,
            fp(vec![scope("b.dbc", &b, &bus), scope("a.dbc", &a, &bus)]),
            "assigned"
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
        let bus = fp_bus();
        let fp =
            |dbcs: Vec<DbcScope<'_>>| dbc_encoding(&plain(dbcs), Some(FP_BUS), 256, false, "S");

        let base = fp(vec![scope("a.dbc", &a, &bus)]);
        assert_eq!(
            base,
            fp(vec![
                scope("a.dbc", &a, &bus),
                scope("elsewhere.dbc", &elsewhere, &bus)
            ]),
            "a DBC that defines nothing about this signal contributes nothing"
        );
        assert_eq!(
            fp(vec![
                scope("a.dbc", &a, &bus),
                scope("elsewhere.dbc", &elsewhere, &bus)
            ]),
            fp(vec![
                scope("elsewhere.dbc", &elsewhere, &bus),
                scope("a.dbc", &a, &bus)
            ]),
            "…so re-prioritising it changes no decode"
        );
        assert_eq!(
            fp(vec![
                scope("a.dbc", &a, &bus),
                scope("twin.dbc", &twin, &bus)
            ]),
            fp(vec![
                scope("twin.dbc", &twin, &bus),
                scope("a.dbc", &a, &bus)
            ]),
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
            buses: fp_bus(),
        }];
        let before_signal = dbc_encoding(
            &plain(vec![scope(
                &loaded[0].path,
                &loaded[0].db,
                &loaded[0].buses,
            )]),
            Some(FP_BUS),
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
                &plain(vec![scope(
                    &loaded[0].path,
                    &loaded[0].db,
                    &loaded[0].buses,
                )]),
                Some(FP_BUS),
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
        let bus = fp_bus();
        let fp = |db: &Database, signal: &str| {
            dbc_encoding(
                &plain(vec![scope("a.dbc", db, &bus)]),
                Some(FP_BUS),
                256,
                false,
                signal,
            )
        };
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
    fn a_value_the_winner_withholds_is_outside_the_fingerprint() {
        // The corner the one-definition rule gives up, pinned so it is
        // a known trade rather than a discovery. Decode resolves per
        // *frame*: `sample_shared` falls through to the next assigned
        // database where the winning definition withholds a value (here
        // a multiplexor arm that does not match), so that database can
        // still put samples in a pyramid — and the fingerprint, which is
        // the winner's specification alone (ADR 0054), cannot see it
        // change. ADR 0047's 2026-08-21 amendment names the exposure.
        let a = parse(&message(&[
            "Sel M : 0|8@1+ (1,0) [0|0] \"\" ECU2",
            "S m0 : 8|16@1+ (1,0) [0|0] \"\" ECU2",
        ]));
        let b = parse(&message(&["S : 24|8@1+ (1,0) [0|0] \"\" ECU2"]));
        let b_edited = parse(&message(&["S : 32|8@1+ (2,0) [0|0] \"\" ECU2"]));
        let bus = fp_bus();
        // Selector 1, so `a`'s arm-0 definition of `S` does not answer.
        let frame = RawTraceFrame {
            timestamp_ns: 0,
            channel: 0,
            id: 256,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![1, 0, 0, 7, 9, 0, 0, 0]),
            bus_id: Some(FP_BUS.to_string()),
        };
        let sampled = |second: &Database| {
            let mut out = Vec::new();
            signal_sampler::sample_shared(&frame, &[&a, second], 256, false, &["S"], &[], &mut out);
            out
        };
        assert_eq!(sampled(&b), vec![Some(7.0)], "the second database answers");
        assert_eq!(
            sampled(&b_edited),
            vec![Some(18.0)],
            "…so editing it moves the value",
        );

        let fp = |second: &Database| {
            dbc_encoding(
                &plain(vec![scope("a.dbc", &a, &bus), scope("b.dbc", second, &bus)]),
                Some(FP_BUS),
                256,
                false,
                "S",
            )
        };
        assert_eq!(fp(&b), fp(&b_edited), "and the fingerprint does not move");
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
