//! Bus-error episodes, as the sidecar reports them (ADR 0060 rule 1).
//!
//! Each [`BusErrorEpisode`] is the sidecar's own account of one blast of
//! error frames on one interface: a start, a latest reading, the counts
//! by kind and direction, and the error counters at that instant. It
//! opens at the first error frame and closes after 1 s without one; an
//! open episode is republished at the state cadence and once more when
//! it closes (ADR 0060 rule 5).
//!
//! Episodes are keyed by `(interface_id, seq)` on the wire so that a
//! closing report is never silently replaced by the next episode's
//! opening -- but if closed reports back up behind a session that fell
//! behind, the sidecar's own control lane folds the oldest into its
//! successor rather than growing without bound (ADR 0060 rule 3). That
//! means a client can see a report for seq `M` without ever seeing seq
//! `M - 1`'s own closing report, so [`BusErrorEpisodes::record`] treats
//! a report for seq `M` as notice that every episode this interface
//! still held open with a lower seq has ended: there is nothing more
//! coming for it, and holding it open would show a fault as ongoing
//! after the sidecar has already moved past it.
//!
//! Shaped like [`crate::controller::ControllerStates`]: a cheap-to-clone
//! handle over shared state that the session's own worker writes and
//! anything holding the session reads, without blocking and without a
//! callback into the reader's thread.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

/// Error-frame counts by kind within one episode, mirroring the wire's
/// `ErrorKindCounts` (ADR 0060 rule 1): what each vendor can tell apart.
/// PEAK decodes `bit`, `form`, `stuff`, `other` and `ack` from the error
/// frame itself; Vector FD decodes its error event's `errorCode`; Vector
/// classic and Kvaser cannot distinguish a kind at all, so every error
/// of theirs counts as `unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ErrorKindCounts {
    pub ack: u64,
    pub bit: u64,
    pub form: u64,
    pub stuff: u64,
    pub crc: u64,
    pub other: u64,
    pub unknown: u64,
}

/// One bus-error episode on an interface, as last reported.
///
/// Does not carry the interface id -- the map this is stored in is
/// already keyed by it, the same choice
/// [`ControllerStatus`](crate::controller::ControllerStatus) makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusErrorEpisode {
    /// This episode's ordinal on its interface (ADR 0060 rule 3): what
    /// [`BusErrorEpisodes::record`] uses to tell which report supersedes
    /// which.
    pub seq: u64,
    /// Hardware timestamps of the first and latest error in this
    /// episode, on the frames' clock -- the same scale as
    /// `Frame.timestamp_ns`.
    pub first_ns: u64,
    pub last_ns: u64,
    /// Error frames counted in this episode.
    pub count: u64,
    pub count_by_kind: ErrorKindCounts,
    /// Errors detected while this side was transmitting / receiving,
    /// where the vendor says which.
    pub tx_count: u64,
    pub rx_count: u64,
    /// The error counters as of `last_ns`.
    pub tec: u32,
    pub rec: u32,
    /// This episode had not yet closed as of this report.
    pub open: bool,
}

/// Closed episodes kept per interface, beyond the one still open.
///
/// The sidecar's own control-lane bound is about two reports in flight
/// per interface (ADR 0060 rule 3: a close plus the next open), with a
/// third folded into its successor before this crate ever sees it -- so
/// keeping more history here than the sidecar itself retains buys
/// nothing. A handful is kept anyway so a host poll that misses a tick
/// still finds the previous episode's final counts rather than nothing;
/// the host persists whatever durable record it needs from what it
/// reads here.
const CLOSED_EPISODE_HISTORY: usize = 4;

/// What one interface has reported: the episode still open, if any, and
/// the most recently closed ones.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InterfaceEpisodeSnapshot {
    pub open: Option<BusErrorEpisode>,
    /// Oldest first, bounded by a small fixed history (see
    /// `CLOSED_EPISODE_HISTORY` below).
    pub recent_closed: Vec<BusErrorEpisode>,
}

/// One interface's accumulated episode state.
#[derive(Debug, Clone, Default)]
struct InterfaceEpisodes {
    open: Option<BusErrorEpisode>,
    recent_closed: VecDeque<BusErrorEpisode>,
    /// The highest seq ever applied, so a stale or duplicate report --
    /// one with a lower seq than anything already folded in -- cannot
    /// reopen or overwrite what a newer one already settled.
    highest_seq: Option<u64>,
}

impl InterfaceEpisodes {
    fn apply(&mut self, report: BusErrorEpisode) {
        if let Some(highest) = self.highest_seq {
            if report.seq < highest {
                return;
            }
        }
        self.highest_seq = Some(report.seq);

        if let Some(open) = self.open.take() {
            if open.seq < report.seq {
                // A report for a later seq is notice that this
                // interface's still-open episode has ended, whether or
                // not its own closing report ever arrives (ADR 0060
                // rule 3, phase-4 side effect (b)).
                let mut closed = open;
                closed.open = false;
                self.push_closed(closed);
            }
            // `open.seq == report.seq` is a fresh reading of the same
            // episode -- a republish at the state cadence, or its close
            // -- and the stale copy is replaced below either way.
        }

        if report.open {
            self.open = Some(report);
        } else {
            self.push_closed(report);
        }
    }

    fn push_closed(&mut self, episode: BusErrorEpisode) {
        self.recent_closed.push_back(episode);
        while self.recent_closed.len() > CLOSED_EPISODE_HISTORY {
            self.recent_closed.pop_front();
        }
    }

    fn snapshot(&self) -> InterfaceEpisodeSnapshot {
        InterfaceEpisodeSnapshot {
            open: self.open,
            recent_closed: self.recent_closed.iter().copied().collect(),
        }
    }
}

/// Per-interface bus-error episode state for one session. Cheap to
/// clone; the clones share one map, so the session worker's writes are
/// visible to every reader.
#[derive(Debug, Clone, Default)]
pub struct BusErrorEpisodes(Arc<Mutex<BTreeMap<String, InterfaceEpisodes>>>);

impl BusErrorEpisodes {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold in one `BusErrorEpisode` report for `interface_id`.
    pub fn record(&self, interface_id: &str, report: BusErrorEpisode) {
        if let Ok(mut guard) = self.0.lock() {
            guard
                .entry(interface_id.to_string())
                .or_default()
                .apply(report);
        }
    }

    /// What `interface_id` has reported so far, or `None` for an
    /// interface no peer has reported an episode on. Never blocks on
    /// the network.
    #[must_use]
    pub fn get(&self, interface_id: &str) -> Option<InterfaceEpisodeSnapshot> {
        self.0
            .lock()
            .ok()?
            .get(interface_id)
            .map(InterfaceEpisodes::snapshot)
    }

    /// Everything reported so far, by interface id.
    #[must_use]
    pub fn snapshot(&self) -> BTreeMap<String, InterfaceEpisodeSnapshot> {
        self.0
            .lock()
            .map(|g| {
                g.iter()
                    .map(|(id, episodes)| (id.clone(), episodes.snapshot()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode(seq: u64, open: bool) -> BusErrorEpisode {
        BusErrorEpisode {
            seq,
            first_ns: seq * 1_000,
            last_ns: seq * 1_000 + 500,
            count: 10,
            count_by_kind: ErrorKindCounts {
                ack: 10,
                ..Default::default()
            },
            tx_count: 4,
            rx_count: 6,
            tec: 128,
            rec: 0,
            open,
        }
    }

    #[test]
    fn a_recorded_episode_is_readable_through_any_clone_of_the_handle() {
        // The session worker holds one clone and the readout another; a
        // report on the worker's has to be visible on the reader's,
        // which is the whole reason this is not a plain map.
        let writer = BusErrorEpisodes::new();
        let reader = writer.clone();
        assert_eq!(reader.get("peak:0"), None);
        writer.record("peak:0", episode(1, true));
        assert_eq!(reader.get("peak:0").unwrap().open, Some(episode(1, true)));
    }

    #[test]
    fn an_open_episode_is_replaced_by_its_own_republish() {
        // The state-cadence republish of a still-open episode (ADR 0060
        // rule 5): same seq, fresh counts.
        let episodes = BusErrorEpisodes::new();
        episodes.record("peak:0", episode(1, true));
        let mut updated = episode(1, true);
        updated.count = 400;
        updated.last_ns = 9_000;
        episodes.record("peak:0", updated);
        let snap = episodes.get("peak:0").unwrap();
        assert_eq!(snap.open.unwrap().count, 400);
        assert!(snap.recent_closed.is_empty(), "no close has happened yet");
    }

    #[test]
    fn a_closing_report_moves_the_episode_from_open_to_recent_closed() {
        let episodes = BusErrorEpisodes::new();
        episodes.record("peak:0", episode(1, true));
        episodes.record("peak:0", episode(1, false));
        let snap = episodes.get("peak:0").unwrap();
        assert_eq!(snap.open, None);
        assert_eq!(snap.recent_closed, vec![episode(1, false)]);
    }

    #[test]
    fn a_report_for_a_later_seq_closes_an_episode_whose_own_close_never_arrived() {
        // Phase-4 side effect (b): the sidecar's control lane folds a
        // backed-up closed report into its successor, so this crate may
        // never see seq 1's own close. Seeing seq 2 open is notice
        // enough that seq 1 has ended.
        let episodes = BusErrorEpisodes::new();
        episodes.record("peak:0", episode(1, true));
        episodes.record("peak:0", episode(2, true));
        let snap = episodes.get("peak:0").unwrap();
        assert_eq!(snap.open.unwrap().seq, 2, "the new episode is now open");
        assert_eq!(snap.recent_closed.len(), 1);
        assert_eq!(snap.recent_closed[0].seq, 1);
        assert!(
            !snap.recent_closed[0].open,
            "the superseded episode reads as closed, even with no close report",
        );
    }

    #[test]
    fn a_stale_report_behind_the_highest_seq_is_ignored() {
        let episodes = BusErrorEpisodes::new();
        episodes.record("peak:0", episode(5, false));
        episodes.record("peak:0", episode(2, true));
        let snap = episodes.get("peak:0").unwrap();
        assert_eq!(snap.open, None, "the stale seq 2 must not reopen anything");
        assert_eq!(snap.recent_closed, vec![episode(5, false)]);
    }

    #[test]
    fn closed_history_is_bounded() {
        let episodes = BusErrorEpisodes::new();
        for seq in 1..=(CLOSED_EPISODE_HISTORY as u64 + 10) {
            episodes.record("peak:0", episode(seq, false));
        }
        let snap = episodes.get("peak:0").unwrap();
        assert_eq!(snap.recent_closed.len(), CLOSED_EPISODE_HISTORY);
        assert_eq!(
            snap.recent_closed.first().unwrap().seq,
            11,
            "the oldest closed episodes are evicted first",
        );
        assert_eq!(snap.recent_closed.last().unwrap().seq, 14);
    }

    #[test]
    fn interfaces_are_tracked_independently() {
        let episodes = BusErrorEpisodes::new();
        episodes.record("peak:0", episode(1, true));
        episodes.record("vector:0", episode(1, false));
        assert_eq!(episodes.get("peak:0").unwrap().open.unwrap().seq, 1);
        assert_eq!(episodes.get("vector:0").unwrap().recent_closed.len(), 1);
        assert_eq!(episodes.snapshot().len(), 2);
    }
}
