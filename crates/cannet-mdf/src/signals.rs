//! Signal channel groups — every group of a file that is signals rather
//! than frames.
//!
//! MDF records signals directly as well as as bus traffic: a channel group
//! whose channels are the signals themselves, with no frame behind them.
//! Nothing in a DBC describes such a signal, and nothing decodes it — the
//! file *is* its source, so reading it is a one-time pass that completes.
//! That is why this materialises each series instead of streaming it, and
//! why a consumer gets values already in physical units with the channel's
//! own name and unit attached.
//!
//! Two kinds of group land here, and the only difference between them is
//! [`SignalChannelGroup::decoded_source`]: a *message-independent* group
//! has none, and a *per-message DBC-decoded* group names the frame its
//! signals were decoded from. Both are series a file carries and neither
//! can be re-derived from anything else the importer holds — the decoding
//! tool's database is not this project's — so both are offered. Only the
//! raw bus-logging groups are excluded: those are frames, and frames go
//! down the [`crate::MdfCanFrameSource`] path.

use crate::bus;
use crate::decode;
use crate::file::{Mdf4File, CN_TYPE_MASTER};

/// One signal recorded directly in the file.
#[derive(Debug, Clone, PartialEq)]
pub struct FileSignal {
    /// `cn_tx_name`, e.g. `EngineSpeed`.
    pub name: String,
    /// `cn_md_unit` as plain text, when the channel names one.
    pub unit: Option<String>,
    /// The `cc_type` of the channel's conversion block, named — the
    /// values below already have it applied, so this is provenance
    /// rather than something to re-apply.
    pub conversion: Option<String>,
    /// The channel's own value→text table as `(code, label)` pairs, in
    /// the conversion's order — a coded signal's enumerators, and empty
    /// for every other channel. A DBC's `VAL_` table plays this part for
    /// a signal decoded here; for one decoded before the file was
    /// written, the conversion block is the only place it exists.
    pub value_table: Vec<(i64, String)>,
    /// Absolute sample times (ns since the UNIX epoch), ascending.
    pub timestamps_ns: Vec<u64>,
    /// Physical values, one per timestamp — with one exception the
    /// channel's own conversion forces: where that conversion maps values
    /// to *text* (a coded signal), the stored code is kept, since the
    /// series is numeric and the text is its label — the labels are in
    /// [`FileSignal::value_table`]. A sample whose
    /// invalidation bit is set, or that has no numeric reading at all
    /// (a genuine text channel), is dropped along with its timestamp
    /// rather than guessed at.
    pub values: Vec<f64>,
}

/// A channel group of recorded signals.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalChannelGroup {
    /// Index of the channel group in the file, in link order.
    pub group_index: usize,
    /// `cg_acq_name`, if the group carries one.
    pub name: Option<String>,
    /// For a per-message DBC-decoded group, the `si_path` naming the
    /// frame its signals were decoded from, e.g.
    /// `CAN1.CAN_DataFrame.ID=0x310 EXT=False`. `None` for a
    /// message-independent group.
    pub decoded_source: Option<String>,
    pub signals: Vec<FileSignal>,
}

/// One signal-shaped group's shape, without reading a single sample —
/// what an import dialog needs to say what a file holds. Counting
/// channels is a block-graph read; materialising the series is a walk per
/// channel, so the census is the cheap half of [`signal_groups`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalGroupCensus {
    /// Index of the channel group in the file, in link order.
    pub group_index: usize,
    /// `cg_acq_name`, if the group carries one.
    pub name: Option<String>,
    /// See [`SignalChannelGroup::decoded_source`].
    pub decoded_source: Option<String>,
    /// How many signal channels the group carries, its master excluded.
    pub signal_count: usize,
}

/// Whether this group is signals rather than frames: no frame structure
/// to decode, and a master channel to put the samples on a timeline.
fn is_signal_group(group: &crate::file::Group) -> bool {
    bus::frame_structure(group).is_none() && group.master().is_some()
}

/// The message a decoded group's signals came from, owned.
fn decoded_source(group: &crate::file::Group) -> Option<String> {
    crate::decoded_message_source(group).map(ToOwned::to_owned)
}

/// Whether a channel of a signal group is one of its signals — the master
/// is the time axis, and a VLSD channel is a variable-length blob with no
/// numeric series behind it.
fn is_signal_channel(channel: &crate::file::Channel) -> bool {
    channel.block.channel_type != CN_TYPE_MASTER && !bus::is_vlsd(&channel.block)
}

pub(crate) fn signal_group_census(file: &Mdf4File) -> Vec<SignalGroupCensus> {
    file.groups
        .iter()
        .enumerate()
        .filter_map(|(index, group)| {
            if !is_signal_group(group) {
                return None;
            }
            let signal_count = group
                .channels
                .iter()
                .filter(|c| is_signal_channel(c))
                .count();
            (signal_count > 0).then(|| SignalGroupCensus {
                group_index: index,
                name: group.acq_name.clone(),
                decoded_source: decoded_source(group),
                signal_count,
            })
        })
        .collect()
}

pub(crate) fn signal_groups(file: &Mdf4File) -> Vec<SignalChannelGroup> {
    let mut out = Vec::new();
    for (index, group) in file.groups.iter().enumerate() {
        if !is_signal_group(group) {
            continue;
        }
        let master = group.master().expect("is_signal_group checked the master");
        let mut signals = Vec::new();
        for channel in &group.channels {
            if !is_signal_channel(channel) {
                continue;
            }
            let mut timestamps_ns = Vec::new();
            let mut values = Vec::new();
            let mut cursor = Mdf4File::cursor(index);
            while let Some(record) = file.next_record(&mut cursor) {
                let (Some(seconds), Some(value)) = (
                    decode::as_f64(file, index, record, &master.block),
                    decode::as_signal_f64(file, index, record, &channel.block),
                ) else {
                    continue;
                };
                timestamps_ns.push(absolute_ns(file.start_time_ns, seconds));
                values.push(value);
            }
            signals.push(FileSignal {
                name: channel.name.clone(),
                unit: channel.unit.clone(),
                conversion: channel
                    .block
                    .conversion
                    .as_ref()
                    .map(|c| format!("{:?}", c.conversion_type)),
                value_table: decode::value_table(file, &channel.block),
                timestamps_ns,
                values,
            });
        }
        if !signals.is_empty() {
            out.push(SignalChannelGroup {
                group_index: index,
                name: group.acq_name.clone(),
                decoded_source: decoded_source(group),
                signals,
            });
        }
    }
    out
}

/// Master seconds → absolute nanoseconds, per ADR 0024.
fn absolute_ns(start_time_ns: u64, seconds: f64) -> u64 {
    let offset = (seconds * 1e9).round();
    if offset < 0.0 {
        return start_time_ns;
    }
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    start_time_ns.saturating_add(offset as u64)
}
