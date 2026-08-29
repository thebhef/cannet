//! The view-signal panel's model: every signal the open views
//! reference, what currently decodes it, and which of those need
//! attention.
//!
//! The panel this feeds is a repair surface, not a picker. It answers
//! three questions per signal — *is it decoded at all*, *by which
//! database*, and *does what it decodes to still match what the view
//! asked for* — and it answers them **host-side**, because the count of
//! signals needing attention has to be available whether or not the
//! panel is open (`CLAUDE.md`: domain computation belongs in the model,
//! frontend state is view-local). A frontend scan over view configs
//! could not serve a launcher badge.
//!
//! ## Where the view configs come from
//!
//! A view's signal selections live in the frontend's element registry
//! and are persisted in the project's opaque `elements` blob, which the
//! host deliberately does not interpret ([`crate::project`]). So the
//! frontend **pushes** its references here — one
//! [`ViewSignalRefs`] per view, replaced whenever that view's config is
//! edited — and the host owns the derived model from there. That is the
//! same shape the transmit pool and the RBS runtime already use: the
//! host holds the model, the frontend edits it through commands.
//!
//! ## The status taxonomy, in severity order
//!
//! The order below **is** the severity order, and a signal that
//! qualifies for more than one reads as the most severe:
//!
//! 1. **Not Decoded** — no database assigned to the reference's bus
//!    defines it. Nothing decodes the signal at all, so a view showing
//!    it shows nothing. A reference naming no bus lands here too: under
//!    bus-governed decode ([`crate::filter::dbc_applies`]) no assignment
//!    can contain "no bus", and the decode path has no series for it at
//!    all ([ADR 0054](../../../docs/adr/0054-a-decoded-value-has-one-definition.md)).
//!    Such a reference is kept rather than migrated or dropped, and
//!    this panel is where it is repaired: its candidates are drawn from
//!    every bus that decodes, so choosing one re-points it there.
//! 2. **Scale** — it decodes, but on a different *scale* from the one
//!    the view was configured against: a different unit, factor or
//!    offset. The unit case is the one with a visible consequence
//!    beyond the numbers — y scales group by unit
//!    ([ADR 0026](../../../docs/adr/0026-plot-axes-and-color.md)), so a
//!    series whose unit changed can no longer join the scale group it
//!    shared and lands on an axis of its own. The factor case changes
//!    nothing about how the view looks while changing every value it
//!    shows, which is exactly why it needs reporting. The repair is the
//!    panel's **accept**: the views' recorded fields are rewritten to
//!    what now decodes (`signalRemap.ts`'s `acceptSignalDrift`) —
//!    like the rename repair, a rewrite of the references made where
//!    they are owned, arriving back here through the views' re-push.
//! 3. **Ambiguous** — more than one database assigned to the bus
//!    defines the signal, so which one decodes it is settled silently by
//!    project load order. Invisible everywhere else: the signal catalog
//!    deduplicates the collision away, and the decoder just takes the
//!    first database that answers. This is the one status the panel
//!    resolves **here**: recording a database for the signal
//!    ([`set_signal_dbc_pick`]) settles the choice, and the row leaves
//!    Ambiguous because there is no longer more than one candidate in
//!    its chain. A **drifted row on a contested message id** reads
//!    Ambiguous too, whatever the count of databases still defining
//!    its name: when two databases claim the id and the serving
//!    definition does not match what the view recorded, the record
//!    names one contender while another serves — renaming a signal in
//!    one of two colliding databases lands here, and must not slide
//!    the row down to Stale and out of the attention view. The other two repairs the panel offers — re-pointing
//!    the views at a signal that replaced a renamed one, and re-pointing
//!    a reference that names no bus at one that decodes — are rewrites
//!    of the references themselves, which live in the project's opaque
//!    `elements` blob, so they are made where those are owned and arrive
//!    back here as an ordinary change to what the views push.
//! 4. **Stale** — it decodes, on the scale the view expects, but the
//!    decoder differs from the view's configuration in some other
//!    recorded way — today, the message it belongs to has been renamed
//!    — and nothing else contends for its message id (a contested id
//!    reads Ambiguous, above). The value is right; the labelling has
//!    drifted. Repaired by the same accept as Scale.
//! 5. **Decoded** — the decoder matches the view's configuration in
//!    every recorded field.
//!
//! **Needing attention** is the first three: the states where the value
//! the view gets is not the value it asked for. Stale still decodes
//! correctly.
//!
//! ## What the model is compared against
//!
//! A view records more than a signal's identity — a plot series carries
//! the message name and unit it was picked under. Those recorded fields
//! are the comparand: a status above "Decoded" is always a statement
//! that the database now says something different from what the view
//! stored. A view that records only identity
//! ([`ViewSignalRef::message_name`] and friends left absent) can only
//! ever read Not Decoded, Ambiguous or Decoded, which is correct — there
//! is nothing recorded for the database to have drifted from.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use cannet_core::CanId;
use cannet_dbc::{Database, MessageDescriptor};

use crate::app_state::AppState;
use crate::signal_snapshot::{definition_index, signal_identity};

/// One signal reference a view holds, as the view persists it.
///
/// The first five fields are the signal's identity (ADR 0038), the same
/// `(bus, message id, extended, signal name)` key every persisted
/// selection in the app uses. The rest are the view's *record of what it
/// picked* — absent when the view stores only identity — and are what a
/// drift is measured against.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSignalRef {
    /// Logical bus the reference is bound to. `None` is a selection
    /// saved before per-bus signal binding: it decodes nothing under
    /// bus-governed decode, reads as Not Decoded here, and is repaired
    /// by re-pointing it at a bus from this panel's source picker.
    pub bus_id: Option<String>,
    pub message_id: u32,
    pub extended: bool,
    pub signal_name: String,
    /// A **file-backed** series read out of a capture file rather than
    /// decoded from a database (`docs/CONTEXT.md`). No DBC ever bore on
    /// it, so it has no mapping to repair and never becomes a row.
    #[serde(default)]
    pub file_backed: bool,
    /// The message name recorded when the signal was picked.
    #[serde(default)]
    pub message_name: Option<String>,
    /// The unit recorded when the signal was picked.
    #[serde(default)]
    pub unit: Option<String>,
    /// The scaling factor recorded when the signal was picked.
    #[serde(default)]
    pub factor: Option<f64>,
    /// The scaling offset recorded when the signal was picked.
    #[serde(default)]
    pub offset: Option<f64>,
}

impl ViewSignalRef {
    /// Whether this reference recorded any of the fields a drift is
    /// measured against. A view that records none pushes identity only
    /// — a colormap target, a transmit frame's calculated-field
    /// signal, a pattern match — and can say nothing about whether the
    /// databases moved under it.
    fn records_mapping(&self) -> bool {
        self.message_name.is_some()
            || self.unit.is_some()
            || self.factor.is_some()
            || self.offset.is_some()
    }
}

/// Everything one view contributes: the label the "applies to" column
/// shows for it, and every signal it references.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ViewSignalRefs {
    pub view_name: String,
    pub refs: Vec<ViewSignalRef>,
}

/// Which views reference which signals, keyed by view id.
///
/// Held by [`AppState`] and replaced a view at a time. Ordered, so the
/// model built from it is deterministic when two views disagree about
/// what they recorded for the same signal (of two references that both
/// recorded a mapping the lowest view id wins — per-view divergence is
/// a defect this panel exists to surface, not a state the model has to
/// represent; a reference holding identity alone always yields to one
/// that recorded a mapping, since it has nothing to disagree with).
#[derive(Debug, Default)]
pub(crate) struct ViewSignalRegistry {
    views: BTreeMap<String, ViewSignalRefs>,
}

impl ViewSignalRegistry {
    /// Replace `view_id`'s references wholesale. Returns whether
    /// anything actually changed — a view re-persisting what it already
    /// had is not news, and announcing it would loop the panel that
    /// wrote it back into a refetch.
    pub(crate) fn set(&mut self, view_id: String, refs: ViewSignalRefs) -> bool {
        if self.views.get(&view_id) == Some(&refs) {
            return false;
        }
        self.views.insert(view_id, refs);
        true
    }

    /// Drop a view's references — it was closed or removed.
    pub(crate) fn remove(&mut self, view_id: &str) -> bool {
        self.views.remove(view_id).is_some()
    }

    /// Drop every view's references — the project closed.
    pub(crate) fn clear(&mut self) -> bool {
        let had = !self.views.is_empty();
        self.views.clear();
        had
    }

    fn iter(&self) -> impl Iterator<Item = &ViewSignalRefs> {
        self.views.values()
    }
}

/// Where one signal sits between the views that reference it and the
/// databases currently assigned to its bus. See the module docs for
/// what each state means; the declaration order **is** the severity
/// order, most severe first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewSignalStatus {
    NotDecoded,
    Scale,
    Ambiguous,
    Stale,
    Decoded,
}

impl ViewSignalStatus {
    /// Whether this status is one the panel's attention count — and the
    /// launcher badge that reads it — counts.
    #[must_use]
    pub fn needs_attention(self) -> bool {
        matches!(self, Self::NotDecoded | Self::Scale | Self::Ambiguous)
    }
}

/// One field where the database disagrees with what a view recorded —
/// the panel's "mapped as X, decoded by Y" detail. Both sides are
/// already rendered as text, because the column states the drift rather
/// than computing with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSignalDiff {
    /// Which field drifted: `unit`, `factor`, `offset` or `message`.
    pub field: String,
    /// What the view recorded.
    pub mapped: String,
    /// What the serving database says today.
    pub decoded: String,
}

/// A database's definition of one signal in the referenced message —
/// what the panel's source picker offers where there is a choice to
/// make. Several candidates naming the same signal under different
/// databases is the ambiguous case; several naming different signals
/// under one database is the remap case; and one naming a *different
/// bus* is the re-point, which is the only repair open to a reference
/// that names no bus.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSignalCandidate {
    /// The bus this definition decodes on. The row's own bus for every
    /// candidate of an ordinary row; for a reference that names none,
    /// the bus the candidate would re-point it at.
    pub bus_id: String,
    /// The project's name for [`Self::bus_id`], or the id when the
    /// project has no name for it — the same rendering
    /// [`ViewSignalRow::bus_name`] gets, so the picker and the bus
    /// column say the same thing.
    pub bus_name: String,
    pub dbc_path: String,
    pub signal_name: String,
    pub message_name: String,
    pub unit: String,
}

/// One row: a signal the open views reference, and everything the panel
/// renders about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSignalRow {
    /// The signal identity (ADR 0038) — the row key, and the same
    /// string the frontend's `signalKey` produces.
    pub id: String,
    pub status: ViewSignalStatus,
    pub bus_id: Option<String>,
    /// The project's name for [`Self::bus_id`], or the id when the
    /// project has no name for it.
    pub bus_name: Option<String>,
    pub message_id: u32,
    pub extended: bool,
    /// The serving database's message name, or the one the view
    /// recorded when nothing decodes the signal.
    pub message_name: String,
    pub signal_name: String,
    /// The serving database's unit, or the one the view recorded when
    /// nothing decodes the signal.
    pub unit: String,
    /// The database that decodes this signal today: the one the user
    /// picked for it, or — with no pick — the first assigned to the bus
    /// that defines it. `None` when nothing does.
    pub serving_dbc: Option<String>,
    /// The database the user chose for this signal, when they have
    /// chosen one that still defines it. `None` is the load-order
    /// default, which is what an untouched project has everywhere.
    /// The panel shows the pick as the picker's current value, and
    /// needs to be able to tell "chosen, and it happens to be first"
    /// from "nobody chose".
    pub picked_dbc: Option<String>,
    /// The views that reference this signal, by name. **Blast radius**,
    /// not a to-do list: one signal is one row and a repair applies
    /// everywhere it is referenced.
    pub used_by: Vec<String>,
    /// The choices available for this row, empty where there is no
    /// choice to make (a `Decoded` row is already what the view asked
    /// for) — **unless a pick is in force**, which a Decoded row keeps
    /// its candidates for, since the pick has to stay reversible from
    /// the same control that made it.
    ///
    /// A row whose reference names **no bus** takes its candidates from
    /// every bus the loaded databases are assigned to, because nothing
    /// on its own (absent) bus can ever decode it
    /// ([ADR 0054](../../../docs/adr/0054-a-decoded-value-has-one-definition.md)).
    /// Choosing one re-points the reference at that bus, which is the
    /// repair that keeps the rule from being a silent emptying.
    pub candidates: Vec<ViewSignalCandidate>,
    /// Every field where the serving database differs from what the
    /// views recorded. Empty for `Decoded` and `Not Decoded`.
    pub diffs: Vec<ViewSignalDiff>,
}

/// What `list_view_signals` answers: the rows, already sorted, plus the
/// single number the launcher badge reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSignalPage {
    pub rows: Vec<ViewSignalRow>,
    /// How many rows are Not Decoded, Scale or Ambiguous. Computed here
    /// rather than counted by the caller so the badge and the panel can
    /// never disagree, and so the badge costs one number.
    pub attention_count: usize,
    /// How many rows there are in total, whatever their status.
    pub total: usize,
}

/// Every database on one bus that carries one message, with its
/// description of it — [`describe_on_bus`]'s answer, cached per
/// `(bus, message)` for the rows that share it.
type DescribedMessage<'a> = Vec<(&'a str, MessageDescriptor)>;

/// One signal identity, and everything the views said about it.
struct Aggregate<'a> {
    /// The first view's record, by view id order.
    reference: &'a ViewSignalRef,
    used_by: BTreeSet<&'a str>,
}

/// Build the panel's rows from the pushed view references and the
/// loaded DBC set. Pure: every input is a parameter, so the whole
/// taxonomy is testable without a Tauri app.
///
/// `dbs` is the loaded set in project load order, each with the buses it
/// is assigned to; `bus_names` maps bus id to the project's name for it;
/// `picks` is the per-signal database choices the decode also resolves
/// through, so the serving database this reports is the one that really
/// decodes.
fn build_rows<'a>(
    registry: &'a ViewSignalRegistry,
    dbs: &[(&'a str, &'a Database, &'a [String])],
    bus_names: &HashMap<String, String>,
    picks: &crate::signal_fingerprint::SignalDbcPicks,
) -> Vec<ViewSignalRow> {
    // The one detector for "which assigned databases define this",
    // shared with the Database panel's duplicate-id warning.
    let index = definition_index(dbs.iter().copied());

    let mut aggregates: BTreeMap<String, Aggregate<'a>> = BTreeMap::new();
    for view in registry.iter() {
        for reference in &view.refs {
            if reference.file_backed {
                continue;
            }
            let id = signal_identity(
                reference.bus_id.as_deref(),
                reference.message_id,
                reference.extended,
                &reference.signal_name,
                false,
            );
            let agg = aggregates.entry(id).or_insert(Aggregate {
                reference,
                used_by: BTreeSet::new(),
            });
            // Whichever reference says the most wins: one that recorded
            // the fields a drift is measured against beats one holding
            // identity alone, whatever order the views arrive in.
            // Between two that both recorded something, the first still
            // wins — that disagreement is the defect this panel exists
            // to surface.
            if !agg.reference.records_mapping() && reference.records_mapping() {
                agg.reference = reference;
            }
            agg.used_by.insert(view.view_name.as_str());
        }
    }

    // Every bus the loaded databases are assigned to, in a stable
    // order — the buses a reference that names none can be re-pointed
    // at, since those are the only ones anything decodes on.
    let repoint_buses: BTreeSet<&'a str> = dbs
        .iter()
        .flat_map(|(_, _, buses)| buses.iter().map(String::as_str))
        .collect();

    // Which buses a row is described on. Its own, when it names one;
    // every bus that decodes, when it does not — those descriptions are
    // the re-point offers, and its own (absent) bus offers nothing.
    let buses_for = |r: &'a ViewSignalRef| -> Vec<Option<&'a str>> {
        match r.bus_id.as_deref() {
            Some(bus) => vec![Some(bus)],
            None => repoint_buses.iter().copied().map(Some).collect(),
        }
    };

    // One `describe_message` per (bus, message) rather than per row:
    // the referenced signals of one message all resolve through the
    // same walk of the assigned databases. Filled in full first, so the
    // rows below read it by reference rather than copying a message
    // descriptor each.
    let mut messages: HashMap<(Option<&str>, u32, bool), DescribedMessage<'a>> = HashMap::new();
    for agg in aggregates.values() {
        let r = agg.reference;
        for bus in buses_for(r) {
            messages
                .entry((bus, r.message_id, r.extended))
                .or_insert_with(|| describe_on_bus(dbs, bus, r.message_id, r.extended));
        }
    }

    let mut rows: Vec<ViewSignalRow> = aggregates
        .iter()
        .map(|(id, agg)| {
            let r = agg.reference;
            let described: Vec<(Option<&'a str>, &DescribedMessage<'a>)> = buses_for(r)
                .into_iter()
                .map(|bus| (bus, &messages[&(bus, r.message_id, r.extended)]))
                .collect();
            row(
                id,
                r,
                &agg.used_by,
                index.resolved(id, picks),
                index.picked(id, picks),
                &described,
                bus_names,
            )
        })
        .collect();

    // A deterministic build order, so an unsorted fetch and a fetch
    // sorted on a column full of ties both render the same table twice
    // running.
    rows.sort_by(|a, b| {
        bus_sort_key(a)
            .cmp(bus_sort_key(b))
            .then(a.message_id.cmp(&b.message_id))
            .then_with(|| a.signal_name.cmp(&b.signal_name))
    });
    rows
}

/// Every database assigned to `bus_id` that carries the message, in
/// project load order, with its description of it.
///
/// Deliberately **all** of them rather than
/// [`DecodeModel::message_source`](crate::signal_fingerprint::DecodeModel::message_source)'s
/// one: this panel is where the ambiguity is reported and resolved, so
/// it has to show the candidates the user is choosing between. Which
/// of them wins is [`DefinitionIndex::resolved`]'s answer, applied per
/// row.
fn describe_on_bus<'a>(
    dbs: &[(&'a str, &'a Database, &'a [String])],
    bus_id: Option<&str>,
    message_id: u32,
    extended: bool,
) -> DescribedMessage<'a> {
    let Ok(can_id) = CanId::new(message_id, extended) else {
        return Vec::new();
    };
    dbs.iter()
        .filter(|(_, _, buses)| crate::filter::dbc_applies(buses, bus_id))
        .filter_map(|(path, db, _)| db.describe_message(can_id).map(|m| (*path, m)))
        .collect()
}

/// Classify one signal and render its row.
fn row(
    id: &str,
    reference: &ViewSignalRef,
    used_by: &BTreeSet<&str>,
    definers: &[&str],
    picked: Option<&str>,
    described: &[(Option<&str>, &DescribedMessage<'_>)],
    bus_names: &HashMap<String, String>,
) -> ViewSignalRow {
    // What the reference's *own* bus offers. Empty for a reference that
    // names none — nothing decodes there — which is what makes such a
    // row Not Decoded; the entries under the other buses are the
    // re-point offers, and none of them is serving anything yet.
    let own: &[(&str, MessageDescriptor)] = described
        .iter()
        .find(|(bus, _)| *bus == reference.bus_id.as_deref())
        .map_or(&[], |(_, d)| d.as_slice());

    // The serving database is the first of the *resolved* chain — the
    // one the user picked where they picked one, and otherwise the
    // first that defines the signal. Either way it is the one the
    // decoder resolves it from (`DefinitionIndex::resolved`).
    let serving = definers.first().and_then(|path| {
        own.iter().find(|(p, _)| p == path).and_then(|(p, m)| {
            m.signals
                .iter()
                // A multiplexed message may declare the name in
                // several arms; the first is the one this row
                // reports, as the decoder's own spec list orders
                // them.
                .find(|s| s.name == reference.signal_name)
                .map(|s| (*p, m, s))
        })
    });

    let mut diffs = Vec::new();
    let mut off_scale = false;
    let mut renamed = false;
    if let Some((_, message, signal)) = serving {
        if let Some(mapped) = &reference.unit {
            if mapped != &signal.unit {
                diffs.push(ViewSignalDiff {
                    field: "unit".into(),
                    mapped: mapped.clone(),
                    decoded: signal.unit.clone(),
                });
                off_scale = true;
            }
        }
        // Bit-wise, like the per-signal encoding fingerprints
        // ([`crate::signal_fingerprint`]): conservative in the safe
        // direction, and NaN-free without a special case.
        if let Some(mapped) = reference.factor {
            if mapped.to_bits() != signal.factor.to_bits() {
                diffs.push(ViewSignalDiff {
                    field: "factor".into(),
                    mapped: mapped.to_string(),
                    decoded: signal.factor.to_string(),
                });
                off_scale = true;
            }
        }
        if let Some(mapped) = reference.offset {
            if mapped.to_bits() != signal.offset.to_bits() {
                diffs.push(ViewSignalDiff {
                    field: "offset".into(),
                    mapped: mapped.to_string(),
                    decoded: signal.offset.to_string(),
                });
                off_scale = true;
            }
        }
        if let Some(mapped) = &reference.message_name {
            if mapped != &message.name {
                diffs.push(ViewSignalDiff {
                    field: "message".into(),
                    mapped: mapped.clone(),
                    decoded: message.name.clone(),
                });
                renamed = true;
            }
        }
    }

    // A drifted row on a contested message id is unresolved, not
    // merely mislabelled: the record names one contender while another
    // serves — renaming a signal in one of two colliding databases
    // must not slide the row from Ambiguous to Stale and out of the
    // attention view. Stale is reserved for drift with nothing else
    // contending for the id.
    let contested = own.len() > 1;
    let status = if serving.is_none() {
        ViewSignalStatus::NotDecoded
    } else if off_scale {
        ViewSignalStatus::Scale
    } else if definers.len() > 1 || (renamed && contested) {
        ViewSignalStatus::Ambiguous
    } else if renamed {
        ViewSignalStatus::Stale
    } else {
        ViewSignalStatus::Decoded
    };

    ViewSignalRow {
        id: id.to_owned(),
        status,
        bus_name: reference
            .bus_id
            .as_ref()
            .map(|b| bus_names.get(b).cloned().unwrap_or_else(|| b.clone())),
        bus_id: reference.bus_id.clone(),
        message_id: reference.message_id,
        extended: reference.extended,
        message_name: serving.map_or_else(
            || reference.message_name.clone().unwrap_or_default(),
            |(_, m, _)| m.name.clone(),
        ),
        signal_name: reference.signal_name.clone(),
        unit: serving.map_or_else(
            || reference.unit.clone().unwrap_or_default(),
            |(_, _, s)| s.unit.clone(),
        ),
        serving_dbc: serving.map(|(p, _, _)| p.to_owned()),
        picked_dbc: picked.map(ToOwned::to_owned),
        used_by: used_by.iter().map(|v| (*v).to_owned()).collect(),
        candidates: offers(status, picked, reference, described, bus_names),
        diffs,
    }
}

/// What the source picker offers the row, by status. A Decoded row
/// with no pick offers nothing (there is nothing to repair). A row
/// whose signal still decodes — however it got flagged — is asking one
/// question, *which database*, so it offers the signal under each
/// definer and nothing else. Only a row nothing decodes keeps the full
/// [`candidates`] list, because its repair is a re-point and the
/// message's signals are what there is to re-point at.
fn offers(
    status: ViewSignalStatus,
    picked: Option<&str>,
    reference: &ViewSignalRef,
    described: &[(Option<&str>, &DescribedMessage<'_>)],
    bus_names: &HashMap<String, String>,
) -> Vec<ViewSignalCandidate> {
    if status == ViewSignalStatus::Decoded && picked.is_none() {
        return Vec::new();
    }
    let mut offers = candidates(described, bus_names);
    if status != ViewSignalStatus::NotDecoded {
        offers.retain(|c| c.signal_name == reference.signal_name);
    }
    offers
}

/// Every `(bus, database, signal)` the referenced message offers, in
/// bus order then project load order then declaration order — the
/// source picker's options. A name repeated across multiplexor arms of
/// one database is one option.
///
/// One bus for an ordinary row (its own); every bus that decodes for a
/// reference that names none, whose options are therefore all
/// re-points.
fn candidates(
    described: &[(Option<&str>, &DescribedMessage<'_>)],
    bus_names: &HashMap<String, String>,
) -> Vec<ViewSignalCandidate> {
    let mut out: Vec<ViewSignalCandidate> = Vec::new();
    for (bus, message_on_bus) in described {
        // A description under no bus offers nothing: no assignment can
        // contain "no bus", so `describe_on_bus` returned an empty list
        // for it in the first place.
        let Some(bus) = *bus else { continue };
        for (path, message) in *message_on_bus {
            for signal in &message.signals {
                if out
                    .iter()
                    .any(|c| c.bus_id == bus && c.dbc_path == *path && c.signal_name == signal.name)
                {
                    continue;
                }
                out.push(ViewSignalCandidate {
                    bus_id: bus.to_owned(),
                    bus_name: bus_names
                        .get(bus)
                        .cloned()
                        .unwrap_or_else(|| bus.to_owned()),
                    dbc_path: (*path).to_owned(),
                    signal_name: signal.name.clone(),
                    message_name: message.name.clone(),
                    unit: signal.unit.clone(),
                });
            }
        }
    }
    out
}

/// The bus column's sort subject: the project's name for the bus, with
/// a reference bound to no bus sorting last.
fn bus_sort_key(row: &ViewSignalRow) -> &str {
    row.bus_name.as_deref().unwrap_or("\u{7f}")
}

/// Sort rows host-side by one column, as the by-id and signal views
/// already do (`CLAUDE.md`: the host sorts, the frontend renders). A
/// `None` key keeps the build order; an unknown key compares equal, so
/// it degrades to the build order rather than to an arbitrary one.
///
/// Ties break on `(bus, signal)` in *ascending* order whichever way the
/// sort runs, so flipping the direction on a column full of ties does
/// not reshuffle rows that column cannot tell apart.
pub fn sort_rows(rows: &mut [ViewSignalRow], key: Option<&str>, dir: Option<&str>) {
    let Some(key) = key else { return };
    let desc = dir == Some("desc");
    rows.sort_by(|a, b| {
        let primary = match key {
            "status" => a.status.cmp(&b.status),
            "bus" => bus_sort_key(a).cmp(bus_sort_key(b)),
            "signal" => a.signal_name.cmp(&b.signal_name),
            "msg" => a
                .message_name
                .cmp(&b.message_name)
                .then(a.message_id.cmp(&b.message_id)),
            // A row nothing decodes has no database, and sorts last
            // either way: it shouldn't lead the table just because the
            // sort flipped.
            "database" => a
                .serving_dbc
                .is_none()
                .cmp(&b.serving_dbc.is_none())
                .then_with(|| flip(a.serving_dbc.cmp(&b.serving_dbc), desc)),
            "used" => a.used_by.cmp(&b.used_by),
            _ => std::cmp::Ordering::Equal,
        };
        let primary = if key == "database" {
            primary
        } else {
            flip(primary, desc)
        };
        primary
            .then_with(|| bus_sort_key(a).cmp(bus_sort_key(b)))
            .then_with(|| a.signal_name.cmp(&b.signal_name))
    });
}

fn flip(ordering: std::cmp::Ordering, desc: bool) -> std::cmp::Ordering {
    if desc {
        ordering.reverse()
    } else {
        ordering
    }
}

/// Event announcing that the set of signals the views reference
/// changed, so the panel and the launcher badge re-ask. The other half
/// of the model's inputs — the loaded DBC set and its bus assignments —
/// announces itself as `dbc-changed`
/// ([ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md) §2).
const VIEW_SIGNALS_CHANGED: &str = "view-signals-changed";

/// Record what one view references. Called whenever a view's signal
/// configuration is edited; replaces that view's entry wholesale.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_view_signals(
    app: AppHandle,
    state: State<'_, AppState>,
    view_id: String,
    view_name: String,
    signals: Vec<ViewSignalRef>,
) {
    let changed = state.view_signals().set(
        view_id,
        ViewSignalRefs {
            view_name,
            refs: signals,
        },
    );
    if changed {
        let _ = app.emit(VIEW_SIGNALS_CHANGED, ());
    }
}

/// Forget a view's references — it was closed or removed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn remove_view_signals(app: AppHandle, state: State<'_, AppState>, view_id: String) {
    if state.view_signals().remove(&view_id) {
        let _ = app.emit(VIEW_SIGNALS_CHANGED, ());
    }
}

/// Forget every view's references — the project closed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_view_signals(app: AppHandle, state: State<'_, AppState>) {
    if state.view_signals().clear() {
        let _ = app.emit(VIEW_SIGNALS_CHANGED, ());
    }
}

/// Record — or clear — which assigned database decodes one signal.
///
/// `signal` is the row's identity ([`signal_identity`], ADR 0038) and
/// `dbc_path` the loaded path of the chosen database. This is the
/// resolution of the ambiguous case: two databases assigned to one bus
/// define the same signal, and without a choice the decode path settles
/// it silently by project load order.
///
/// **The entry is recorded only for a real, non-default choice**, which
/// makes three cases into one clear:
///
/// - `None` — the caller is reverting to the default.
/// - the database that already wins on load order — choosing it changes
///   nothing, and recording it would put a redundant entry in the
///   project file for behaviour that is already the default. Selecting
///   it is therefore how the user reverts.
/// - a path that does not define this signal on this bus — a remap
///   candidate, an unassigned database, or one already removed. There
///   is no pick to make, so none is kept.
///
/// A change re-judges the pyramids and announces itself as a DBC change
/// ([ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
/// §2): a pick changes what the loaded set decodes, which is exactly
/// what that event means, and every consumer of decoded data — this
/// panel, its badge, the plots — already re-asks on it. A call that
/// changes nothing announces nothing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_signal_dbc_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    signal: String,
    dbc_path: Option<String>,
) {
    if !set_signal_dbc_pick_inner(&state, signal, dbc_path) {
        return;
    }
    crate::app_state::invalidate_derived_caches(&state);
    crate::dbc_commands::announce_dbc_change(&app, "*");
}

/// [`set_signal_dbc_pick`]'s body: apply the choice, and say whether it
/// moved anything. Split out so the rule is testable against a real
/// `AppState` without a Tauri app.
pub(crate) fn set_signal_dbc_pick_inner(
    state: &AppState,
    signal: String,
    dbc_path: Option<String>,
) -> bool {
    // Lock order: the DBC set before the picks, as `decode_model` takes
    // them.
    let dbs = state.databases();
    let borrowed: Vec<(&str, &Database, &[String])> = dbs
        .iter()
        .map(|d| (d.path.as_str(), d.db.as_ref(), d.buses.as_slice()))
        .collect();
    // The same index the rows are built from, so "is this a definer"
    // is answered by the rule the panel displays rather than by a
    // second scan. Any definer counts, the load-order winner included:
    // choosing the default explicitly is a choice, and only a recorded
    // one makes the row leave Ambiguous. `None` is the revert.
    let definers = definition_index(borrowed.iter().copied());
    let keep = dbc_path.filter(|path| definers.defining(&signal).iter().any(|d| *d == path));
    let mut picks = state.signal_dbc_picks();
    let changed = match &keep {
        Some(path) => picks.get(&signal) != Some(path),
        None => picks.contains_key(&signal),
    };
    if changed {
        let mut next = (**picks).clone();
        match keep {
            Some(path) => picks_insert(&mut next, signal, path),
            None => {
                next.remove(&signal);
            }
        }
        *picks = std::sync::Arc::new(next);
    }
    drop(picks);
    drop(dbs);
    changed
}

/// `HashMap::insert` without the discarded-return lint noise.
fn picks_insert(
    picks: &mut crate::signal_fingerprint::SignalDbcPicks,
    signal: String,
    path: String,
) {
    picks.insert(signal, path);
}

/// The panel's rows and the attention count, sorted host-side.
///
/// Computed fresh from the loaded DBC set and the recorded references
/// on every call, so it is never stale: a database assigned,
/// unassigned, replaced or edited on disk moves rows here on the next
/// fetch, and so does a view-config edit. Both inputs announce their
/// own changes (`dbc-changed` and `view-signals-changed`), which is what
/// makes the next fetch happen.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_view_signals(
    state: State<'_, AppState>,
    sort_key: Option<String>,
    sort_dir: Option<String>,
    bus_names: Vec<(String, String)>,
) -> ViewSignalPage {
    list_view_signals_inner(&state, sort_key.as_deref(), sort_dir.as_deref(), bus_names)
}

/// [`list_view_signals`] over a borrowed state, so the model can be
/// exercised against a real `AppState` without a Tauri app.
pub(crate) fn list_view_signals_inner(
    state: &AppState,
    sort_key: Option<&str>,
    sort_dir: Option<&str>,
    bus_names: Vec<(String, String)>,
) -> ViewSignalPage {
    let names: HashMap<String, String> = bus_names.into_iter().collect();
    // Lock order: the view registry before the DBC set — no other path
    // takes both, and this one never takes them the other way round.
    let registry = state.view_signals();
    let dbs = state.databases();
    let borrowed: Vec<(&str, &Database, &[String])> = dbs
        .iter()
        .map(|d| (d.path.as_str(), d.db.as_ref(), d.buses.as_slice()))
        .collect();
    // Lock order: the DBC set before the picks, as `decode_model`
    // takes them.
    let picks = state.picks_snapshot();
    let mut rows = build_rows(&registry, &borrowed, &names, &picks);
    drop(dbs);
    drop(registry);
    sort_rows(&mut rows, sort_key, sort_dir);
    ViewSignalPage {
        attention_count: rows.iter().filter(|r| r.status.needs_attention()).count(),
        total: rows.len(),
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Msg` on 0x100 with a volts signal, plus a second message so a
    /// remap has somewhere to point.
    fn dbc(message: &str, signal: &str, unit: &str, factor: &str) -> Database {
        Database::parse(&format!(
            "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Ecu\n\n\
             BO_ 256 {message}: 8 Ecu\n \
             SG_ {signal} : 0|16@1+ ({factor},0) [0|0] \"{unit}\" Ecu\n \
             SG_ Other : 16|8@1+ (1,0) [0|0] \"A\" Ecu\n"
        ))
        .expect("test DBC parses")
    }

    fn plain() -> Database {
        dbc("PackStatus", "PackVolts", "V", "0.1")
    }

    /// A reference recording identity only.
    fn bare(bus: Option<&str>, signal: &str) -> ViewSignalRef {
        ViewSignalRef {
            bus_id: bus.map(Into::into),
            message_id: 256,
            extended: false,
            signal_name: signal.into(),
            file_backed: false,
            message_name: None,
            unit: None,
            factor: None,
            offset: None,
        }
    }

    /// A reference recording what a plot series records: identity plus
    /// the message name, unit and scaling it was picked under.
    fn recorded(signal: &str, message: &str, unit: &str, factor: f64) -> ViewSignalRef {
        ViewSignalRef {
            message_name: Some(message.into()),
            unit: Some(unit.into()),
            factor: Some(factor),
            offset: Some(0.0),
            ..bare(Some("power"), signal)
        }
    }

    fn registry(views: &[(&str, &str, Vec<ViewSignalRef>)]) -> ViewSignalRegistry {
        let mut r = ViewSignalRegistry::default();
        for (id, name, refs) in views {
            r.set(
                (*id).to_string(),
                ViewSignalRefs {
                    view_name: (*name).to_string(),
                    refs: refs.clone(),
                },
            );
        }
        r
    }

    fn power() -> Vec<String> {
        vec!["power".to_string()]
    }

    fn names() -> HashMap<String, String> {
        HashMap::from([("power".to_string(), "Powertrain".to_string())])
    }

    fn build(
        registry: &ViewSignalRegistry,
        dbs: &[(&str, &Database, &[String])],
    ) -> Vec<ViewSignalRow> {
        build_rows(
            registry,
            dbs,
            &names(),
            &crate::signal_fingerprint::SignalDbcPicks::new(),
        )
    }

    /// [`build`] with one signal's database chosen by the user.
    fn build_picked(
        registry: &ViewSignalRegistry,
        dbs: &[(&str, &Database, &[String])],
        signal: &str,
        path: &str,
    ) -> Vec<ViewSignalRow> {
        let mut picks = crate::signal_fingerprint::SignalDbcPicks::new();
        picks.insert(
            signal_identity(Some("power"), 256, false, signal, false),
            path.to_owned(),
        );
        build_rows(registry, dbs, &names(), &picks)
    }

    #[test]
    fn a_signal_no_assigned_database_defines_is_not_decoded() {
        let db = plain();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        // Loaded but assigned to nothing: it decodes nothing, so the
        // view's signal has no decoder at all.
        let rows = build(&reg, &[("a.dbc", &db, &[])]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, ViewSignalStatus::NotDecoded);
        assert_eq!(rows[0].serving_dbc, None);
        assert!(rows[0].diffs.is_empty());
        // Nothing on the bus carries the message, so there is nothing
        // to offer as a replacement either.
        assert!(rows[0].candidates.is_empty());
        // The row still renders what the view recorded.
        assert_eq!(rows[0].message_name, "PackStatus");
        assert_eq!(rows[0].unit, "V");
    }

    #[test]
    fn a_reference_bound_to_no_bus_is_not_decoded() {
        // Bus assignment governs decode, and no assignment can contain
        // "no bus" — a selection saved before per-bus signal binding
        // decodes nothing. The decode path agrees: `signal_cache` has no
        // series for such a reference at all.
        let db = plain();
        let buses = power();
        let reg = registry(&[("v1", "Plot 1", vec![bare(None, "PackVolts")])]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::NotDecoded);
        assert_eq!(rows[0].bus_name, None);
        assert!(
            rows[0].status.needs_attention(),
            "so the launcher badge counts it with the panel closed",
        );
    }

    #[test]
    fn a_reference_bound_to_no_bus_is_offered_the_buses_that_decode() {
        // What keeps "a busless series resolves nothing" from being a
        // silent emptying: the row's own (absent) bus can never decode,
        // so the picker offers every bus the loaded databases are
        // assigned to, and choosing one re-points the reference there.
        let db = plain();
        let both = vec!["power".to_string(), "chassis".to_string()];
        let reg = registry(&[("v1", "Plot 1", vec![bare(None, "PackVolts")])]);
        let rows = build(&reg, &[("a.dbc", &db, &both)]);

        assert_eq!(rows[0].status, ViewSignalStatus::NotDecoded);
        assert_eq!(
            rows[0].serving_dbc, None,
            "nothing decodes it, whatever is on offer",
        );
        let offers: Vec<(&str, &str, &str)> = rows[0]
            .candidates
            .iter()
            .map(|c| {
                (
                    c.bus_id.as_str(),
                    c.bus_name.as_str(),
                    c.signal_name.as_str(),
                )
            })
            .collect();
        assert_eq!(
            offers,
            vec![
                ("chassis", "chassis", "PackVolts"),
                ("chassis", "chassis", "Other"),
                ("power", "Powertrain", "PackVolts"),
                ("power", "Powertrain", "Other"),
            ],
            "one offer per (bus, database, signal), and the bus is named \
             the way the bus column names it",
        );
    }

    #[test]
    fn an_ordinary_row_offers_only_its_own_bus() {
        // The other side of the same rule: a reference that already
        // names a bus is not offered a different one. Re-pointing across
        // buses is the repair for a reference that has none, not a
        // choice to make everywhere.
        let db = plain();
        let both = vec!["power".to_string(), "chassis".to_string()];
        let reg = registry(&[("v1", "Plot 1", vec![bare(Some("power"), "Gone")])]);
        let rows = build(&reg, &[("a.dbc", &db, &both)]);

        assert_eq!(rows[0].status, ViewSignalStatus::NotDecoded);
        assert!(
            rows[0].candidates.iter().all(|c| c.bus_id == "power"),
            "an assigned reference is offered its own bus only: {:?}",
            rows[0].candidates,
        );
    }

    #[test]
    fn a_signal_the_assigned_database_defines_as_recorded_is_decoded() {
        let db = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Decoded);
        assert_eq!(rows[0].serving_dbc.as_deref(), Some("a.dbc"));
        assert_eq!(rows[0].bus_name.as_deref(), Some("Powertrain"));
        assert!(rows[0].diffs.is_empty());
        // Nothing to choose: the view already has what it asked for.
        assert!(rows[0].candidates.is_empty());
    }

    #[test]
    fn a_unit_the_database_changed_reads_as_scale() {
        // ADR 0026 groups y scales by unit, so the series can no longer
        // join the scale group it shared and lands on its own axis.
        let db = dbc("PackStatus", "PackVolts", "mV", "0.1");
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Scale);
        assert_eq!(
            rows[0].diffs,
            vec![ViewSignalDiff {
                field: "unit".into(),
                mapped: "V".into(),
                decoded: "mV".into(),
            }]
        );
        assert_eq!(rows[0].unit, "mV");
    }

    #[test]
    fn a_factor_the_database_changed_reads_as_scale() {
        // Same name, same unit, different scaling: nothing looks broken
        // and every value has changed.
        let db = dbc("PackStatus", "PackVolts", "V", "0.5");
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Scale);
        assert_eq!(
            rows[0].diffs,
            vec![ViewSignalDiff {
                field: "factor".into(),
                mapped: "0.1".into(),
                decoded: "0.5".into(),
            }]
        );
    }

    #[test]
    fn a_message_the_database_renamed_reads_as_stale() {
        let db = dbc("BatteryStatus", "PackVolts", "V", "0.1");
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Stale);
        assert_eq!(
            rows[0].diffs,
            vec![ViewSignalDiff {
                field: "message".into(),
                mapped: "PackStatus".into(),
                decoded: "BatteryStatus".into(),
            }]
        );
        // Stale still decodes correctly, so it is not in the count.
        assert!(!rows[0].status.needs_attention());
    }

    #[test]
    fn a_collision_survivor_with_drift_reads_ambiguous_not_stale() {
        // Owner report, 2026-08-29: two databases defined the signal
        // (Ambiguous, in the attention set); renaming the signal in
        // one of them left the old name with a single definer, so the
        // row silently rebound to the survivor — whose message name
        // does not match what the view recorded — and dropped to
        // Stale, out of the attention view. But the message id is
        // still contested and the record names the *other* contender:
        // that is an unresolved state, not a labelling drift. A
        // drifted row on a contested id reads Ambiguous, whatever the
        // count of databases still defining its name.
        let a = dbc("PackStatus", "PackVolts2", "V", "0.1");
        let b = dbc("BatteryStatus", "PackVolts", "V", "0.1");
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(
            &reg,
            &[("a.dbc", &a, &buses), ("b.dbc", &b, &buses)],
        );

        assert_eq!(rows[0].status, ViewSignalStatus::Ambiguous);
        assert!(
            rows[0].status.needs_attention(),
            "the row must not leave the attention view while the id is contested",
        );
        // The drift is still stated — the detail cell and its accept
        // repair work exactly as they do on a Scale/Stale row.
        assert_eq!(
            rows[0].diffs,
            vec![ViewSignalDiff {
                field: "message".into(),
                mapped: "PackStatus".into(),
                decoded: "BatteryStatus".into(),
            }]
        );
    }

    #[test]
    fn two_assigned_databases_defining_one_signal_read_as_ambiguous() {
        // The signal catalog dedups the collision away and the decoder
        // settles it by load order; this is the one place it is
        // reported. The detection is the Database panel's own detector.
        let a = plain();
        let b = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(&reg, &[("a.dbc", &a, &buses), ("b.dbc", &b, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Ambiguous);
        // Load order decides today, and the row says so.
        assert_eq!(rows[0].serving_dbc.as_deref(), Some("a.dbc"));
        // The choice on offer is *which database* — one entry per
        // definer, this signal only. The message's other signals are
        // not part of the question.
        let pairs: Vec<(&str, &str)> = rows[0]
            .candidates
            .iter()
            .map(|c| (c.dbc_path.as_str(), c.signal_name.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![("a.dbc", "PackVolts"), ("b.dbc", "PackVolts")]
        );
    }

    #[test]
    fn a_decoding_row_is_offered_databases_only_whatever_flagged_it() {
        // Scale outranks Ambiguous in the taxonomy, so a duplicate
        // whose definitions disagree on scale reads as Scale — and its
        // offer must still be "which database", never the message's
        // signal list. Only a row nothing decodes is offered other
        // signals, because its repair is a re-point.
        let drifted = dbc("PackStatus", "PackVolts", "mV", "0.1");
        let agreeing = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(
            &reg,
            &[("a.dbc", &drifted, &buses), ("b.dbc", &agreeing, &buses)],
        );

        assert_eq!(rows[0].status, ViewSignalStatus::Scale);
        let pairs: Vec<(&str, &str)> = rows[0]
            .candidates
            .iter()
            .map(|c| (c.dbc_path.as_str(), c.signal_name.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![("a.dbc", "PackVolts"), ("b.dbc", "PackVolts")]
        );
    }

    #[test]
    fn a_pick_settles_the_ambiguity_and_names_the_database_it_chose() {
        // The resolution the panel exists for: with a database chosen,
        // there is no longer more than one candidate in the signal's
        // chain, so the row leaves Ambiguous and reports the chosen
        // database as the one that serves it — which is the same
        // database the decode resolves through
        // (`DefinitionIndex::resolved`).
        let a = plain();
        let b = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let dbs = [
            ("a.dbc", &a, buses.as_slice()),
            ("b.dbc", &b, buses.as_slice()),
        ];

        let rows = build_picked(&reg, &dbs, "PackVolts", "b.dbc");
        assert_eq!(rows[0].status, ViewSignalStatus::Decoded);
        assert_eq!(rows[0].serving_dbc.as_deref(), Some("b.dbc"));
        assert_eq!(rows[0].picked_dbc.as_deref(), Some("b.dbc"));
        // A Decoded row normally offers nothing, but a picked one has
        // to stay reversible from the control that made the pick.
        assert!(
            rows[0]
                .candidates
                .iter()
                .any(|c| c.dbc_path == "a.dbc" && c.signal_name == "PackVolts"),
            "the way back to the other database has to stay on offer"
        );
        // And like the Ambiguous row it came from, the offer is
        // databases only — never the message's other signals.
        assert!(
            rows[0].candidates.iter().all(|c| c.signal_name == "PackVolts"),
            "a picked row's offer is which database, not which signal: {:?}",
            rows[0].candidates,
        );

        // A pick against the database load order already picks is
        // reported as a pick, not as nothing — the panel's control
        // shows what was chosen.
        let same = build_picked(&reg, &dbs, "PackVolts", "a.dbc");
        assert_eq!(same[0].serving_dbc.as_deref(), Some("a.dbc"));
        assert_eq!(same[0].picked_dbc.as_deref(), Some("a.dbc"));
        assert_eq!(same[0].status, ViewSignalStatus::Decoded);
    }

    #[test]
    fn a_pick_on_a_database_that_no_longer_defines_the_signal_is_ignored() {
        // The stale pick, three ways: not loaded, assigned elsewhere,
        // or edited until it no longer defines the signal. All three
        // fall back to the load-order default, which still reads
        // Ambiguous because nothing has resolved it.
        let a = plain();
        let b = plain();
        let elsewhere = vec!["chassis".to_string()];
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);

        let gone = build_picked(
            &reg,
            &[
                ("a.dbc", &a, buses.as_slice()),
                ("b.dbc", &b, buses.as_slice()),
            ],
            "PackVolts",
            "removed.dbc",
        );
        assert_eq!(gone[0].status, ViewSignalStatus::Ambiguous);
        assert_eq!(gone[0].serving_dbc.as_deref(), Some("a.dbc"));
        assert_eq!(gone[0].picked_dbc, None);

        let unassigned = build_picked(
            &reg,
            &[
                ("a.dbc", &a, buses.as_slice()),
                ("b.dbc", &b, elsewhere.as_slice()),
            ],
            "PackVolts",
            "b.dbc",
        );
        assert_eq!(unassigned[0].status, ViewSignalStatus::Decoded);
        assert_eq!(unassigned[0].serving_dbc.as_deref(), Some("a.dbc"));
        assert_eq!(unassigned[0].picked_dbc, None);
    }

    #[test]
    fn a_pick_can_put_a_row_into_scale_by_choosing_a_different_scaling() {
        // Choosing the other database is a real change of encoding, and
        // the panel reports what the choice cost: the picked database
        // scales the signal differently from what the view recorded, so
        // the row reads Scale and names both sides.
        let a = plain();
        let b = dbc("PackStatus", "PackVolts", "V", "0.5");
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build_picked(
            &reg,
            &[
                ("a.dbc", &a, buses.as_slice()),
                ("b.dbc", &b, buses.as_slice()),
            ],
            "PackVolts",
            "b.dbc",
        );
        assert_eq!(rows[0].status, ViewSignalStatus::Scale);
        assert_eq!(rows[0].serving_dbc.as_deref(), Some("b.dbc"));
        let factor = rows[0]
            .diffs
            .iter()
            .find(|d| d.field == "factor")
            .expect("the scaling difference is reported");
        assert_eq!(
            (factor.mapped.as_str(), factor.decoded.as_str()),
            ("0.1", "0.5")
        );
    }

    #[test]
    fn a_more_severe_status_wins_over_a_less_severe_one() {
        // Both databases define it (Ambiguous) *and* the serving one
        // changed the unit (Scale). Scale is the more severe of the
        // two, and the row reads as that one.
        let a = dbc("PackStatus", "PackVolts", "mV", "0.1");
        let b = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
        )]);
        let rows = build(&reg, &[("a.dbc", &a, &buses), ("b.dbc", &b, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Scale);
    }

    #[test]
    fn a_view_that_records_only_identity_never_drifts() {
        // Nothing was recorded for the database to differ from, so a
        // renamed message and a changed unit are both invisible here —
        // and correctly so.
        let db = dbc("BatteryStatus", "PackVolts", "mV", "0.5");
        let buses = power();
        let reg = registry(&[("v1", "Colormap", vec![bare(Some("power"), "PackVolts")])]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows[0].status, ViewSignalStatus::Decoded);
        assert!(rows[0].diffs.is_empty());
    }

    #[test]
    fn one_signal_is_one_row_however_many_views_reference_it() {
        let db = plain();
        let buses = power();
        let reg = registry(&[
            ("v1", "Plot 1", vec![bare(Some("power"), "PackVolts")]),
            ("v2", "Plot 2", vec![bare(Some("power"), "PackVolts")]),
            ("v3", "Trace", vec![bare(Some("power"), "Other")]),
        ]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows.len(), 2);
        let volts = rows.iter().find(|r| r.signal_name == "PackVolts").unwrap();
        assert_eq!(volts.used_by, vec!["Plot 1", "Plot 2"]);
        let other = rows.iter().find(|r| r.signal_name == "Other").unwrap();
        assert_eq!(other.used_by, vec!["Trace"]);
    }

    #[test]
    fn an_identity_only_reference_never_masks_a_drift_another_view_recorded() {
        // A view that records nothing about a signal — a colormap
        // target, a transmit frame's counter, a pattern match — says
        // less about it than a view that recorded the fields it was
        // picked under. Merging them must keep the reference that says
        // more, whichever view id sorts first, or a drift the other
        // view really has would read as Decoded.
        let db = plain(); // PackVolts in V
        let buses = power();
        let reg = registry(&[
            ("a", "Signals", vec![bare(Some("power"), "PackVolts")]),
            (
                "b",
                "Plot 1",
                vec![recorded("PackVolts", "PackStatus", "mV", 0.1)],
            ),
        ]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, ViewSignalStatus::Scale);
        assert_eq!(rows[0].used_by, vec!["Plot 1", "Signals"]);
    }

    #[test]
    fn a_file_backed_series_is_not_a_row() {
        // Read out of the capture file, never decoded from a database:
        // there is no mapping to repair, so it must not sit in the
        // grid reading Not Decoded forever.
        let db = plain();
        let buses = power();
        let mut file_ref = bare(Some("power"), "Imported");
        file_ref.file_backed = true;
        let reg = registry(&[("v1", "Plot 1", vec![file_ref])]);
        let rows = build(&reg, &[("a.dbc", &db, &buses)]);

        assert!(rows.is_empty());
    }

    #[test]
    fn the_attention_count_is_not_decoded_plus_scale_plus_ambiguous() {
        let a = plain();
        let b = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![
                // Decoded.
                recorded("PackVolts", "PackStatus", "V", 0.1),
                // Scale: the database says "A".
                recorded("Other", "PackStatus", "V", 1.0),
                // Not decoded: no such signal.
                recorded("Gone", "PackStatus", "V", 1.0),
            ],
        )]);
        let mut rows = build(&reg, &[("a.dbc", &a, &buses), ("b.dbc", &b, &buses)]);
        sort_rows(&mut rows, Some("status"), None);

        let statuses: Vec<ViewSignalStatus> = rows.iter().map(|r| r.status).collect();
        assert_eq!(
            statuses,
            vec![
                ViewSignalStatus::NotDecoded,
                ViewSignalStatus::Scale,
                ViewSignalStatus::Ambiguous,
            ],
            "severity order, most severe first",
        );
        assert_eq!(
            rows.iter().filter(|r| r.status.needs_attention()).count(),
            3
        );
    }

    #[test]
    fn sorting_is_host_side_and_reversible() {
        let db = plain();
        let buses = power();
        let reg = registry(&[
            ("v1", "Plot 1", vec![bare(Some("power"), "PackVolts")]),
            ("v2", "Plot 2", vec![bare(Some("power"), "Other")]),
        ]);
        let mut rows = build(&reg, &[("a.dbc", &db, &buses)]);

        sort_rows(&mut rows, Some("signal"), Some("asc"));
        let up: Vec<&str> = rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(up, vec!["Other", "PackVolts"]);

        sort_rows(&mut rows, Some("signal"), Some("desc"));
        let down: Vec<&str> = rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(down, vec!["PackVolts", "Other"]);

        // An unknown key degrades to the build order, not an arbitrary
        // one, and no key at all leaves the rows alone.
        sort_rows(&mut rows, Some("nonsense"), Some("desc"));
        let unknown: Vec<&str> = rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(unknown, vec!["Other", "PackVolts"]);
    }

    #[test]
    fn a_row_with_no_serving_database_sorts_last_either_way() {
        let db = plain();
        let buses = power();
        let reg = registry(&[(
            "v1",
            "Plot 1",
            vec![
                bare(Some("power"), "PackVolts"),
                bare(Some("power"), "Gone"),
            ],
        )]);
        let mut rows = build(&reg, &[("a.dbc", &db, &buses)]);

        for dir in [Some("asc"), Some("desc")] {
            sort_rows(&mut rows, Some("database"), dir);
            assert_eq!(
                rows.last().unwrap().signal_name,
                "Gone",
                "undecoded row must not lead the table on {dir:?}",
            );
        }
    }

    #[test]
    fn re_recording_identical_references_is_not_a_change() {
        // A panel persisting what it already had must not announce a
        // change, or it loops itself back into a refetch.
        let mut reg = ViewSignalRegistry::default();
        let refs = ViewSignalRefs {
            view_name: "Plot 1".into(),
            refs: vec![bare(Some("power"), "PackVolts")],
        };
        assert!(reg.set("v1".into(), refs.clone()));
        assert!(!reg.set("v1".into(), refs.clone()));
        assert!(reg.set(
            "v1".into(),
            ViewSignalRefs {
                view_name: "Plot 1".into(),
                refs: vec![bare(Some("power"), "Other")],
            }
        ));
        assert!(reg.remove("v1"));
        assert!(!reg.remove("v1"));
    }

    /// The panel model as an `AppState` holding one loaded, assigned
    /// database serves it — the real load / assign path, so a wiring
    /// mistake between the registry and the DBC set shows up even when
    /// `build_rows` is right.
    fn state_with_dbc(dbc_text: &str) -> AppState {
        let state = crate::tests::test_state();
        crate::dbc_commands::install_dbc(&state, "a.dbc", dbc_text).unwrap();
        state
    }

    fn page(state: &AppState) -> ViewSignalPage {
        list_view_signals_inner(
            state,
            Some("bus"),
            None,
            vec![("power".to_string(), "Powertrain".to_string())],
        )
    }

    #[test]
    fn assigning_a_database_moves_a_row_out_of_not_decoded() {
        // The panel is live against bus assignment: a project that
        // opens with everything unassigned reads Not Decoded, and
        // assigning the database is what repairs it — no reopen, and
        // nothing cached in between.
        let state = state_with_dbc(
            "VERSION \"\"

NS_ :

BS_:

BU_: Ecu

             BO_ 256 PackStatus: 8 Ecu
              SG_ PackVolts : 0|16@1+ (0.1,0) [0|0] \"V\" Ecu
",
        );
        state.view_signals().set(
            "v1".into(),
            ViewSignalRefs {
                view_name: "Plot 1".into(),
                refs: vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
            },
        );

        let before = page(&state);
        assert_eq!(before.rows[0].status, ViewSignalStatus::NotDecoded);
        assert_eq!(before.attention_count, 1);
        assert_eq!(before.total, 1);

        crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["power".to_string()]);

        let after = page(&state);
        assert_eq!(after.rows[0].status, ViewSignalStatus::Decoded);
        assert_eq!(after.rows[0].serving_dbc.as_deref(), Some("a.dbc"));
        assert_eq!(after.attention_count, 0);

        // …and unassigning it takes the row straight back.
        crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());
        assert_eq!(page(&state).attention_count, 1);
    }

    #[test]
    fn a_database_reloaded_in_place_moves_the_row_without_a_refetch_gap() {
        // The DBC-change generation carries an edit to a loaded file,
        // not only an assignment change: the same path the watcher
        // takes replaces the database under the same identity, and the
        // next fetch reports the drift.
        let with_unit = |unit: &str| {
            format!(
                "VERSION \"\"

NS_ :

BS_:

BU_: Ecu

                 BO_ 256 PackStatus: 8 Ecu
                  SG_ PackVolts : 0|16@1+ (0.1,0) [0|0] \"{unit}\" Ecu
"
            )
        };
        let state = state_with_dbc(&with_unit("V"));
        crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["power".to_string()]);
        state.view_signals().set(
            "v1".into(),
            ViewSignalRefs {
                view_name: "Plot 1".into(),
                refs: vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
            },
        );
        assert_eq!(page(&state).rows[0].status, ViewSignalStatus::Decoded);

        crate::dbc_commands::install_dbc(&state, "a.dbc", &with_unit("mV")).unwrap();

        let after = page(&state);
        assert_eq!(after.rows[0].status, ViewSignalStatus::Scale);
        assert_eq!(after.attention_count, 1);
    }

    #[test]
    fn a_view_config_edit_changes_the_model() {
        // The model's other input: dropping a view's references drops
        // the rows only it held, and the count with them.
        let db = plain();
        let buses = power();
        let mut reg = registry(&[
            (
                "v1",
                "Plot 1",
                vec![recorded("Gone", "PackStatus", "V", 1.0)],
            ),
            ("v2", "Plot 2", vec![bare(Some("power"), "PackVolts")]),
        ]);
        let before = build(&reg, &[("a.dbc", &db, &buses)]);
        assert_eq!(before.len(), 2);
        assert_eq!(
            before.iter().filter(|r| r.status.needs_attention()).count(),
            1
        );

        reg.remove("v1");
        let after = build(&reg, &[("a.dbc", &db, &buses)]);
        assert_eq!(after.len(), 1);
        assert_eq!(
            after.iter().filter(|r| r.status.needs_attention()).count(),
            0
        );
    }

    /// A DBC text defining `PackVolts` in `PackStatus` at `factor`.
    fn dbc_text(factor: &str, unit: &str) -> String {
        format!(
            "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Ecu\n\n\
             BO_ 256 PackStatus: 8 Ecu\n \
             SG_ PackVolts : 0|16@1+ ({factor},0) [0|0] \"{unit}\" Ecu\n"
        )
    }

    /// A state with two databases both assigned to `power` and both
    /// defining `PackVolts` — the ambiguous case, exactly as the panel
    /// reports it.
    fn ambiguous_state() -> AppState {
        let state = crate::tests::test_state();
        crate::dbc_commands::install_dbc(&state, "a.dbc", &dbc_text("0.1", "V")).unwrap();
        crate::dbc_commands::install_dbc(&state, "b.dbc", &dbc_text("0.5", "V")).unwrap();
        crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["power".to_string()]);
        crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["power".to_string()]);
        state
    }

    /// The one signal identity every pick test names.
    const PICKED: &str = "power|s:256:PackVolts";

    fn pick_of(state: &AppState) -> Option<String> {
        state.signal_dbc_picks().get(PICKED).cloned()
    }

    #[test]
    fn a_pick_of_any_definer_is_recorded_including_the_load_order_winner() {
        let state = ambiguous_state();

        // The load-order loser: recorded.
        assert!(set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("b.dbc".into())
        ));
        assert_eq!(pick_of(&state).as_deref(), Some("b.dbc"));
        // Re-applying the same choice moves nothing, so nothing is
        // announced.
        assert!(!set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("b.dbc".into())
        ));

        // The load-order winner is a choice like any other: choosing
        // the default explicitly settles the ambiguity exactly as
        // choosing the loser does — the picker treats every offer the
        // same, and only recording can make the row leave Ambiguous.
        assert!(set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("a.dbc".into())
        ));
        assert_eq!(pick_of(&state).as_deref(), Some("a.dbc"));

        // `None` is the revert (what undo dispatches), and on an
        // already-absent entry changes nothing.
        assert!(set_signal_dbc_pick_inner(&state, PICKED.into(), None));
        assert_eq!(pick_of(&state), None);
        assert!(!set_signal_dbc_pick_inner(&state, PICKED.into(), None));
    }

    #[test]
    fn a_path_that_does_not_define_the_signal_is_no_pick() {
        // A remap candidate, a database assigned elsewhere, and one
        // that was never loaded all name nothing that could decode
        // this signal, so no entry is kept.
        let state = ambiguous_state();
        assert!(!set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("never-loaded.dbc".into())
        ));
        assert_eq!(pick_of(&state), None);

        crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["chassis".to_string()]);
        assert!(!set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("b.dbc".into())
        ));
        assert_eq!(pick_of(&state), None);
    }

    #[test]
    fn clearing_the_whole_set_keeps_the_picks_the_project_just_installed() {
        // `clear_dbcs` is the first half of an *open project*: the
        // frontend clears the set and re-adds the project's databases
        // one at a time, after `open_project` has already installed the
        // project's picks. Pruning there would wipe every pick the file
        // carried before its databases were back. Only an explicit
        // `remove_dbc` drops one.
        let state = ambiguous_state();
        assert!(set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("b.dbc".into())
        ));
        state.databases().clear();
        crate::app_state::invalidate_derived_caches(&state);
        assert_eq!(pick_of(&state).as_deref(), Some("b.dbc"));

        // …and it comes back into force the moment its database does.
        crate::dbc_commands::install_dbc(&state, "a.dbc", &dbc_text("0.1", "V")).unwrap();
        crate::dbc_commands::install_dbc(&state, "b.dbc", &dbc_text("0.5", "V")).unwrap();
        crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["power".to_string()]);
        crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["power".to_string()]);
        state.view_signals().set(
            "v1".into(),
            ViewSignalRefs {
                view_name: "Plot 1".into(),
                refs: vec![recorded("PackVolts", "PackStatus", "V", 0.1)],
            },
        );
        let rows = page(&state).rows;
        assert_eq!(rows[0].picked_dbc.as_deref(), Some("b.dbc"));
        assert_eq!(rows[0].serving_dbc.as_deref(), Some("b.dbc"));
    }

    #[test]
    fn removing_the_picked_database_drops_the_pick_silently() {
        // Owner ruling: the entry is dropped from the project when the
        // selected DBC is removed, falling back to the load-order
        // default. Silently — there is nothing to repair, because the
        // default is what a project that never chose already decodes.
        let state = ambiguous_state();
        assert!(set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("b.dbc".into())
        ));

        let before = state.system_log.snapshot().len();
        crate::dbc_commands::remove_dbc_inner(&state, "b.dbc");
        assert_eq!(pick_of(&state), None, "the pick went with its database");
        assert_eq!(
            state.system_log.snapshot().len(),
            before,
            "and said nothing about it"
        );

        // Removing an unrelated database leaves a pick alone.
        crate::dbc_commands::install_dbc(&state, "b.dbc", &dbc_text("0.5", "V")).unwrap();
        crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["power".to_string()]);
        crate::dbc_commands::install_dbc(&state, "c.dbc", &dbc_text("0.2", "V")).unwrap();
        assert!(set_signal_dbc_pick_inner(
            &state,
            PICKED.into(),
            Some("b.dbc".into())
        ));
        crate::dbc_commands::remove_dbc_inner(&state, "c.dbc");
        assert_eq!(pick_of(&state).as_deref(), Some("b.dbc"));
    }
}
