//! Message-independent signal channel groups.
//!
//! MDF records signals directly as well as as bus traffic: a channel group
//! whose channels are the signals themselves, with no frame behind them.
//! Nothing in a DBC describes such a signal, and nothing decodes it — the
//! file *is* its source, so reading it is a one-time pass that completes.
//! That is why this materialises each series instead of streaming it, and
//! why a consumer gets values already in physical units with the channel's
//! own name and unit attached.
//!
//! Only the plain signal groups are reported. A raw bus-logging group is
//! frames, and a per-message DBC-decoded group is a second copy of what
//! those frames already say; both are excluded here.

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
    /// Absolute sample times (ns since the UNIX epoch), ascending.
    pub timestamps_ns: Vec<u64>,
    /// Physical values, one per timestamp. A sample whose invalidation
    /// bit is set, or that does not decode to a number, is dropped along
    /// with its timestamp rather than guessed at.
    pub values: Vec<f64>,
}

/// A channel group of directly recorded signals.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalChannelGroup {
    /// Index of the channel group in the file, in link order.
    pub group_index: usize,
    /// `cg_acq_name`, if the group carries one.
    pub name: Option<String>,
    pub signals: Vec<FileSignal>,
}

pub(crate) fn signal_groups(file: &Mdf4File) -> Vec<SignalChannelGroup> {
    let mut out = Vec::new();
    for (index, group) in file.groups.iter().enumerate() {
        // Frames, and the decoded restatements of frames, are not this.
        // A group that declares itself a bus event is bus-derived either
        // way, whether or not its source path says which message.
        if bus::frame_structure(group).is_some()
            || crate::is_bus_event(group.flags)
            || crate::decoded_message_source(group).is_some()
        {
            continue;
        }
        let Some(master) = group.master() else {
            continue;
        };
        let mut signals = Vec::new();
        for channel in &group.channels {
            if channel.block.channel_type == CN_TYPE_MASTER || bus::is_vlsd(&channel.block) {
                continue;
            }
            let mut timestamps_ns = Vec::new();
            let mut values = Vec::new();
            let mut cursor = Mdf4File::cursor(index);
            while let Some(record) = file.next_record(&mut cursor) {
                let (Some(seconds), Some(value)) = (
                    decode::as_f64(file, index, record, &master.block),
                    decode::as_f64(file, index, record, &channel.block),
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
                timestamps_ns,
                values,
            });
        }
        if !signals.is_empty() {
            out.push(SignalChannelGroup {
                group_index: index,
                name: group.acq_name.clone(),
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
