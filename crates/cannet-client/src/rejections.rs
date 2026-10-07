//! What the far end said about frames it would not carry.
//!
//! Three of the wire's error codes refer to a single transmit rather
//! than to the session: `TX_REJECTED` (the peer would not put the frame
//! on the wire), `NOT_SUBSCRIBED` (the batch named an interface this
//! session does not hold) and `NO_ACKNOWLEDGER` (a virtual-bus transmit
//! reached no listener). None of them ends the session, and the rx loop
//! goes on yielding frames — which is right, and is also why they used
//! to disappear: they were logged to `tracing` and nothing else, so the
//! one thing the wire had to say about a transmit that did not happen
//! reached a developer's stderr and no user.
//!
//! [`PerFrameErrors`] is where they land instead, shaped like
//! [`ControllerStates`](crate::controller::ControllerStates): a
//! cheap-to-clone handle over shared state that the session's own worker
//! writes and anything holding the session reads, without blocking and
//! without a callback into the reader's thread.
//!
//! It is a **tally, not a log**. A peer refusing transmits at
//! rest-of-bus-simulation rate produces thousands of these a second, so
//! what is kept is a count per code plus the newest message — the reader
//! polls it and reports the movement. Nothing here grows with session
//! length: the code space is fixed and each code holds one message.
//!
//! [`TxRefusals`] is this module's other tally, for the wire message
//! that replaces the per-frame path for refused *transmits* (ADR 0060
//! rule 4): a peer new enough to batch its refusals sends a `TxRefusals`
//! summary per interface and reason instead of one `Error{TX_REJECTED}`
//! per frame. Both tallies stay live side by side — a peer old enough
//! not to send `TxRefusals` yet (an older `cannet-server`) still reports
//! refusals the old way, and this crate must not silently drop them.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// A per-frame error code, as the wire spells it. Codes this build does
/// not recognise are not per-frame errors at all (they end the session),
/// so there is no unknown variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PerFrameError {
    /// The peer would not put the frame on the wire.
    TxRejected,
    /// The batch named an interface this session does not hold.
    NotSubscribed,
    /// A virtual-bus transmit reached no listener.
    NoAcknowledger,
}

impl PerFrameError {
    /// The wire's enum, or `None` for a code that is not per-frame.
    #[must_use]
    pub fn from_wire(code: i32) -> Option<Self> {
        use cannet_wire::proto::error::Code;
        match Code::try_from(code) {
            Ok(Code::TxRejected) => Some(Self::TxRejected),
            Ok(Code::NotSubscribed) => Some(Self::NotSubscribed),
            Ok(Code::NoAcknowledger) => Some(Self::NoAcknowledger),
            _ => None,
        }
    }

    /// How this reads to someone who is not holding the proto file.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TxRejected => "transmit rejected",
            Self::NotSubscribed => "interface not subscribed",
            Self::NoAcknowledger => "no listener on the bus",
        }
    }
}

/// One code's running tally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectionTally {
    pub code: PerFrameError,
    /// How many the peer has reported this session.
    pub count: u64,
    /// The newest message the peer sent with it, for the report.
    pub last_message: String,
}

/// Per-frame errors reported on one session, counted by code. Cheap to
/// clone; the clones share one map, so the session worker's writes are
/// visible to every reader.
#[derive(Debug, Clone, Default)]
pub struct PerFrameErrors(Arc<Mutex<BTreeMap<PerFrameError, RejectionTally>>>);

impl PerFrameErrors {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one per-frame error the peer reported. A code that is not
    /// a per-frame one is dropped rather than counted as a guess — it
    /// ends the session and surfaces through the frame channel instead.
    pub fn record(&self, code: i32, message: &str) {
        let Some(code) = PerFrameError::from_wire(code) else {
            return;
        };
        if let Ok(mut guard) = self.0.lock() {
            let entry = guard.entry(code).or_insert_with(|| RejectionTally {
                code,
                count: 0,
                last_message: String::new(),
            });
            entry.count += 1;
            if !message.is_empty() {
                entry.last_message.clear();
                entry.last_message.push_str(message);
            }
        }
    }

    /// Every code reported so far, in code order. Never blocks on the
    /// network.
    #[must_use]
    pub fn snapshot(&self) -> Vec<RejectionTally> {
        self.0
            .lock()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Total reported across every code — the one number a readout
    /// polls to see whether anything moved.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.0
            .lock()
            .map_or(0, |g| g.values().map(|t| t.count).sum())
    }
}

/// A refused-transmit summary's reason, as the wire's `TxRefusalReason`
/// spells it (ADR 0060 rule 4). Unspecified and anything a future peer
/// sends that this build does not recognise are dropped rather than
/// guessed at, the same rule [`PerFrameError::from_wire`] applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TxRefusalReason {
    /// The interface's transmit queue is full.
    QueueFull,
    /// The interface has been closed.
    Closed,
    /// The bus is open listen-only; nothing may be sent on it.
    ListenOnly,
    /// The frame is incompatible with how the bus is configured (e.g.
    /// an FD frame on a classic-only bus).
    Incompatible,
    /// Refused for a reason none of the above names.
    Other,
}

impl TxRefusalReason {
    /// The wire's enum, or `None` for the unspecified value and for
    /// anything a future peer sends that this build does not know.
    #[must_use]
    pub fn from_wire(value: i32) -> Option<Self> {
        use cannet_wire::proto::TxRefusalReason as Wire;
        match Wire::try_from(value) {
            Ok(Wire::QueueFull) => Some(Self::QueueFull),
            Ok(Wire::Closed) => Some(Self::Closed),
            Ok(Wire::ListenOnly) => Some(Self::ListenOnly),
            Ok(Wire::Incompatible) => Some(Self::Incompatible),
            Ok(Wire::Other) => Some(Self::Other),
            _ => None,
        }
    }

    /// How this reads to someone who is not holding the proto file.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::QueueFull => "transmit queue full",
            Self::Closed => "interface closed",
            Self::ListenOnly => "bus is listen-only",
            Self::Incompatible => "frame incompatible with the bus mode",
            Self::Other => "refused",
        }
    }
}

/// One interface-and-reason's running tally of refused transmits (ADR
/// 0060 rule 4). `count`, `flush_count` and the two timestamp pairs
/// accumulate across every `TxRefusals` report this session, the same
/// way [`RejectionTally`] accumulates per-frame codes; `last_message`
/// holds the newest non-empty one reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxRefusalTally {
    pub interface_id: String,
    pub reason: TxRefusalReason,
    /// Refused sends reported for this interface and reason, summed
    /// across every report.
    pub count: u64,
    pub first_ns: u64,
    pub last_ns: u64,
    /// The driver's own text for the latest refusal, where it gave one.
    pub last_message: String,
    /// Transmit-queue flushes reported (ADR 0060 rule 7: a queue that
    /// has accepted nothing for 1 s is flushed), summed the same way.
    pub flush_count: u64,
    pub last_flush_ns: u64,
}

/// Per-(interface, reason) refusal tallies for one session (ADR 0060
/// rule 4). Cheap to clone, shaped like [`PerFrameErrors`]: the session
/// worker writes as `TxRefusals` reports arrive and a control surface
/// reads whenever it wants to.
#[derive(Debug, Clone, Default)]
pub struct TxRefusals(Arc<Mutex<BTreeMap<(String, TxRefusalReason), TxRefusalTally>>>);

impl TxRefusals {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold in one `TxRefusals` report. A reason this build cannot name
    /// is dropped rather than counted as a guess.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        interface_id: &str,
        reason: i32,
        count: u64,
        first_ns: u64,
        last_ns: u64,
        last_message: &str,
        flush_count: u64,
        last_flush_ns: u64,
    ) {
        let Some(reason) = TxRefusalReason::from_wire(reason) else {
            return;
        };
        if let Ok(mut guard) = self.0.lock() {
            let entry = guard
                .entry((interface_id.to_string(), reason))
                .or_insert_with(|| TxRefusalTally {
                    interface_id: interface_id.to_string(),
                    reason,
                    count: 0,
                    first_ns,
                    last_ns,
                    last_message: String::new(),
                    flush_count: 0,
                    last_flush_ns: 0,
                });
            entry.count += count;
            entry.last_ns = entry.last_ns.max(last_ns);
            if !last_message.is_empty() {
                entry.last_message.clear();
                entry.last_message.push_str(last_message);
            }
            entry.flush_count += flush_count;
            if flush_count > 0 {
                entry.last_flush_ns = entry.last_flush_ns.max(last_flush_ns);
            }
        }
    }

    /// Every (interface, reason) tallied so far, in key order. Never
    /// blocks on the network.
    #[must_use]
    pub fn snapshot(&self) -> Vec<TxRefusalTally> {
        self.0
            .lock()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Total refusals reported across every interface and reason.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.0
            .lock()
            .map_or(0, |g| g.values().map(|t| t.count).sum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_wire::proto::error::Code;

    #[test]
    fn a_recorded_rejection_is_readable_through_any_clone_of_the_handle() {
        // The session worker holds one clone and the readout another;
        // a rejection on the worker's has to be visible on the
        // reader's, which is the whole reason this is not a plain map.
        let writer = PerFrameErrors::new();
        let reader = writer.clone();
        assert_eq!(reader.total(), 0);
        writer.record(Code::TxRejected as i32, "bus is listen-only");
        assert_eq!(reader.total(), 1);
        let tally = reader.snapshot().pop().unwrap();
        assert_eq!(tally.code, PerFrameError::TxRejected);
        assert_eq!(tally.last_message, "bus is listen-only");
    }

    #[test]
    fn a_flood_is_a_count_and_not_a_log() {
        // The reading the owner's bench fault produces: thousands a
        // second. What is kept has to be bounded by the code space, not
        // by how long the peer keeps refusing.
        let errors = PerFrameErrors::new();
        for i in 0..100_000 {
            errors.record(Code::TxRejected as i32, &format!("refused {i}"));
        }
        assert_eq!(errors.total(), 100_000);
        assert_eq!(errors.snapshot().len(), 1, "one code, one entry");
        assert_eq!(errors.snapshot()[0].last_message, "refused 99999");
    }

    #[test]
    fn the_three_per_frame_codes_are_counted_apart() {
        // They mean different things — a rejected transmit, a batch
        // addressed to an interface we do not hold, and a virtual bus
        // with nobody on it — and a readout that summed them would name
        // the wrong fault.
        let errors = PerFrameErrors::new();
        errors.record(Code::TxRejected as i32, "a");
        errors.record(Code::NotSubscribed as i32, "b");
        errors.record(Code::NoAcknowledger as i32, "c");
        errors.record(Code::TxRejected as i32, "d");
        assert_eq!(errors.total(), 4);
        assert_eq!(errors.snapshot().len(), 3);
    }

    #[test]
    fn a_session_fatal_code_is_not_counted_here() {
        // The control: a fatal code ends the rx loop and surfaces
        // through the frame channel. Counting it here would have a
        // readout report a transmit problem for a connection failure.
        let errors = PerFrameErrors::new();
        errors.record(Code::Busy as i32, "single-client server");
        errors.record(Code::UnknownInterface as i32, "no such interface");
        errors.record(Code::Unspecified as i32, "");
        errors.record(999, "a code from a future peer");
        assert_eq!(errors.total(), 0);
        assert!(errors.snapshot().is_empty());
    }

    #[test]
    fn an_empty_message_does_not_erase_the_one_that_explained_it() {
        let errors = PerFrameErrors::new();
        errors.record(Code::TxRejected as i32, "bus is listen-only");
        errors.record(Code::TxRejected as i32, "");
        assert_eq!(errors.snapshot()[0].last_message, "bus is listen-only");
        assert_eq!(errors.snapshot()[0].count, 2);
    }

    // ---------- TxRefusals (ADR 0060 rule 4) ----------

    use cannet_wire::proto::TxRefusalReason as WireReason;

    #[test]
    fn a_recorded_refusal_is_readable_through_any_clone_of_the_handle() {
        let writer = TxRefusals::new();
        let reader = writer.clone();
        assert_eq!(reader.total(), 0);
        writer.record(
            "pcan:0",
            WireReason::QueueFull as i32,
            800,
            1_000,
            5_000,
            "The transmit queue is full",
            0,
            0,
        );
        assert_eq!(reader.total(), 800);
        let tally = reader.snapshot().pop().unwrap();
        assert_eq!(tally.interface_id, "pcan:0");
        assert_eq!(tally.reason, TxRefusalReason::QueueFull);
        assert_eq!(tally.last_message, "The transmit queue is full");
    }

    #[test]
    fn interfaces_and_reasons_are_tallied_apart() {
        // Two interfaces refusing for the same reason, and one
        // interface refusing for two reasons, must not be summed into
        // the wrong fault.
        let refusals = TxRefusals::new();
        refusals.record("if0", WireReason::QueueFull as i32, 5, 0, 1, "a", 0, 0);
        refusals.record("if1", WireReason::QueueFull as i32, 7, 0, 1, "b", 0, 0);
        refusals.record("if0", WireReason::ListenOnly as i32, 3, 0, 1, "c", 0, 0);
        assert_eq!(refusals.total(), 15);
        assert_eq!(refusals.snapshot().len(), 3);
    }

    #[test]
    fn counts_accumulate_across_reports() {
        let refusals = TxRefusals::new();
        refusals.record(
            "if0",
            WireReason::QueueFull as i32,
            800,
            1_000,
            5_000,
            "x",
            0,
            0,
        );
        refusals.record(
            "if0",
            WireReason::QueueFull as i32,
            200,
            5_100,
            9_000,
            "y",
            0,
            0,
        );
        let tally = refusals.snapshot().pop().unwrap();
        assert_eq!(tally.count, 1_000);
        assert_eq!(
            tally.first_ns, 1_000,
            "the first-ever report's start stands"
        );
        assert_eq!(tally.last_ns, 9_000, "the newest report's end replaces it");
        assert_eq!(tally.last_message, "y");
    }

    #[test]
    fn an_unspecified_or_unknown_reason_is_not_counted() {
        let refusals = TxRefusals::new();
        refusals.record("if0", WireReason::Unspecified as i32, 5, 0, 1, "", 0, 0);
        refusals.record("if0", 999, 5, 0, 1, "", 0, 0);
        assert_eq!(refusals.total(), 0);
        assert!(refusals.snapshot().is_empty());
    }

    #[test]
    fn a_flush_count_accumulates_and_last_flush_ns_tracks_the_newest() {
        // ADR 0060 rule 7: a stuck queue is flushed, and the flush is
        // reported on the same envelope as the refusals that triggered
        // it.
        let refusals = TxRefusals::new();
        refusals.record(
            "if0",
            WireReason::QueueFull as i32,
            100,
            0,
            1_000,
            "x",
            1,
            1_000,
        );
        refusals.record(
            "if0",
            WireReason::QueueFull as i32,
            50,
            1_100,
            2_000,
            "y",
            1,
            2_000,
        );
        let tally = refusals.snapshot().pop().unwrap();
        assert_eq!(tally.flush_count, 2);
        assert_eq!(tally.last_flush_ns, 2_000);
    }

    #[test]
    fn a_refusal_empty_message_does_not_erase_the_one_that_explained_it() {
        let refusals = TxRefusals::new();
        refusals.record(
            "if0",
            WireReason::QueueFull as i32,
            1,
            0,
            1,
            "bus is listen-only",
            0,
            0,
        );
        refusals.record("if0", WireReason::QueueFull as i32, 1, 1, 2, "", 0, 0);
        let tally = refusals.snapshot().pop().unwrap();
        assert_eq!(tally.last_message, "bus is listen-only");
        assert_eq!(tally.count, 2);
    }
}
