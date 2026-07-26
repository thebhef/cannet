//! The host-side transmit scheduler.
//!
//! Every running periodic message is driven by a **single** host thread
//! (`run_transmit_scheduler` in `lib.rs`) instead of one OS thread per
//! message. That thread owns a [`PeriodicSchedule`] — a min-heap of
//! `(deadline, id)` — and, each time an entry comes due, asks the
//! [`crate::transmit_frames::TransmitFrameRegistry`] what to emit
//! (`fire_info`) and reschedules it one period later. One thread scales
//! to arbitrarily many low-rate (5–10 ms) messages across multiple
//! buses without the per-thread wake-up jitter and lock contention the
//! old thread-per-message model suffered.
//!
//! This module is the *pure* part — the heap, the generation bookkeeping
//! that keeps a stop→start from leaving a stale entry behind, and the
//! command channel handle. The driver loop (which needs `AppState` to
//! actually transmit) lives in `lib.rs` so this stays unit-testable
//! without a Tauri runtime.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A command to the scheduler thread. `Start` / `Stop` mirror the
/// `start_periodic_transmit` / `stop_periodic_transmit` IPC commands;
/// the thread also exits when every [`TransmitScheduler`] sender is
/// dropped (app shutdown), so no explicit shutdown variant is needed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchedulerCmd {
    /// Begin firing `id`, first fire at `now + stagger_offset(id,
    /// cycle_ms)` and every period thereafter. `cycle_ms` rides along
    /// (read under the registry lock the caller already holds) so the
    /// driver can place the phase offset without a registry lookup.
    Start { id: String, cycle_ms: u32 },
    /// Stop firing `id`.
    Stop(String),
    /// A bus route may have come up (a session registered). Best-effort
    /// hint so parked periodics resume promptly instead of waiting for
    /// the slow retry probe; the driver re-checks routes on receipt.
    RoutesChanged,
}

/// Handle the command layer uses to talk to the scheduler thread.
/// Wrapped in a `Mutex` because `std::sync::mpsc::Sender` is not `Sync`
/// and `AppState` is shared `&` across command invocations; the lock is
/// taken only on start / stop (never per frame), so it's never hot.
pub struct TransmitScheduler {
    tx: Mutex<Sender<SchedulerCmd>>,
}

impl TransmitScheduler {
    #[must_use]
    pub fn new(tx: Sender<SchedulerCmd>) -> Self {
        Self { tx: Mutex::new(tx) }
    }

    /// Schedule `id` to start firing on a `cycle_ms` period. Best-effort:
    /// a send failure means the scheduler thread is gone (app shutting
    /// down), which is harmless to ignore.
    pub fn start(&self, id: String, cycle_ms: u32) {
        let _ = self
            .tx
            .lock()
            .expect("transmit scheduler sender poisoned")
            .send(SchedulerCmd::Start { id, cycle_ms });
    }

    /// Unschedule `id`. Best-effort (see [`Self::start`]).
    pub fn stop(&self, id: String) {
        let _ = self
            .tx
            .lock()
            .expect("transmit scheduler sender poisoned")
            .send(SchedulerCmd::Stop(id));
    }

    /// Hint that a bus route may have come up. Best-effort (see
    /// [`Self::start`]); correctness doesn't depend on it — the driver's
    /// retry probe covers a missed hint.
    pub fn routes_changed(&self) {
        let _ = self
            .tx
            .lock()
            .expect("transmit scheduler sender poisoned")
            .send(SchedulerCmd::RoutesChanged);
    }
}

/// Build a scheduler handle plus the receiver the driver thread owns.
#[must_use]
pub fn channel() -> (TransmitScheduler, Receiver<SchedulerCmd>) {
    let (tx, rx) = std::sync::mpsc::channel();
    (TransmitScheduler::new(tx), rx)
}

/// Deterministic per-message phase offset in `[0, period)` (ADR 0039).
///
/// Every periodic's first fire lands at `start + offset` so same-period
/// messages spread across the period instead of firing as one aligned
/// cohort — a bulk RBS start would otherwise put every cycle group on a
/// shared epoch and the fixed-rate grid would keep them phase-locked,
/// draining as periodic multi-frame bursts on the wire. Keyed on the
/// message's registry row id: stable across restarts and start order
/// within a build (fixed-key `DefaultHasher`); never persisted, so
/// cross-version hash drift is harmless.
#[must_use]
pub fn stagger_offset(id: &str, period: Duration) -> Duration {
    use std::hash::{Hash, Hasher};
    // Period arrives as u32 milliseconds, so this never saturates.
    let period_ms = u64::try_from(period.as_millis()).unwrap_or(u64::MAX);
    if period_ms == 0 {
        return Duration::ZERO;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    Duration::from_millis(h.finish() % period_ms)
}

/// One queued firing: the absolute `deadline`, the message `id`, and the
/// `seq` (generation) that stamped it. Ordered by deadline first so the
/// `BinaryHeap` (wrapped in [`Reverse`]) yields the earliest deadline.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pending {
    deadline: Instant,
    seq: u64,
    id: String,
}

impl PartialOrd for Pending {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Pending {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.deadline
            .cmp(&other.deadline)
            .then_with(|| self.seq.cmp(&other.seq))
            .then_with(|| self.id.cmp(&other.id))
    }
}

/// A min-heap of pending firings keyed by deadline.
///
/// Generations make stop→start safe without removing from the middle of
/// the heap: each [`Self::schedule`] stamps the id with a fresh, globally
/// increasing `seq` recorded in `live`. A heap entry is *live* only if
/// its `seq` matches `live[id]`; [`Self::unschedule`] drops the id from
/// `live`, so its queued entry is skipped when popped. This prevents the
/// classic "stop then immediately start doubles the rate" bug — the old
/// queued entry can never fire after a restart.
#[derive(Default)]
pub struct PeriodicSchedule {
    heap: BinaryHeap<Reverse<Pending>>,
    /// id → the seq of its one live queued entry. Absent ⇒ unscheduled.
    live: HashMap<String, u64>,
    seq: u64,
}

impl PeriodicSchedule {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or restart) `id`, due at `at`. Any previously-queued entry
    /// for `id` is invalidated by the fresh generation.
    pub fn schedule(&mut self, id: String, at: Instant) {
        self.seq += 1;
        let seq = self.seq;
        self.live.insert(id.clone(), seq);
        self.heap.push(Reverse(Pending {
            deadline: at,
            seq,
            id,
        }));
    }

    /// Stop `id`. Its queued heap entry (if any) becomes stale and is
    /// skipped when popped.
    pub fn unschedule(&mut self, id: &str) {
        self.live.remove(id);
    }

    /// Re-queue `id`'s next firing at `at`, keeping its current
    /// generation. A no-op if `id` was unscheduled in the meantime (so a
    /// stop during a tick wins).
    pub fn reschedule(&mut self, id: &str, at: Instant) {
        if let Some(&seq) = self.live.get(id) {
            self.heap.push(Reverse(Pending {
                deadline: at,
                seq,
                id: id.to_string(),
            }));
        }
    }

    /// Discard stale heap entries at the top (ids that were unscheduled
    /// or superseded), leaving a live entry — or nothing — on top.
    fn prune(&mut self) {
        while let Some(Reverse(top)) = self.heap.peek() {
            if self.live.get(&top.id) == Some(&top.seq) {
                break;
            }
            self.heap.pop();
        }
    }

    /// The earliest live deadline, or `None` if nothing is scheduled.
    /// The driver sleeps until this (or until a command arrives).
    pub fn next_deadline(&mut self) -> Option<Instant> {
        self.prune();
        self.heap.peek().map(|Reverse(p)| p.deadline)
    }

    /// Pop every live entry due at or before `now`, returning each as
    /// `(id, deadline)` — the deadline lets the caller reschedule on a
    /// fixed-rate grid (`deadline + period`) rather than drifting from
    /// `now`. Popped ids stay in `live`; the caller then either
    /// [`Self::reschedule`]s (still running) or [`Self::unschedule`]s
    /// (stopped / parked / removed) each one.
    pub fn take_due(&mut self, now: Instant) -> Vec<(String, Instant)> {
        let mut due = Vec::new();
        loop {
            match self.heap.peek() {
                None => break,
                Some(Reverse(top)) => {
                    if self.live.get(&top.id) != Some(&top.seq) {
                        self.heap.pop();
                        continue;
                    }
                    if top.deadline > now {
                        break;
                    }
                }
            }
            let Reverse(p) = self.heap.pop().expect("peeked entry");
            due.push((p.id, p.deadline));
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ids(due: &[(String, Instant)]) -> Vec<&str> {
        due.iter().map(|(id, _)| id.as_str()).collect()
    }

    #[test]
    fn stagger_offset_is_deterministic_and_bounded() {
        let p = Duration::from_millis(100);
        for id in ["a", "b", "row-uuid-1"] {
            let o = stagger_offset(id, p);
            assert_eq!(o, stagger_offset(id, p), "offset must be stable per id");
            assert!(o < p, "offset {o:?} must stay inside the period");
        }
        // Degenerate period: no offset (never scheduled in practice —
        // begin_periodic rejects cycle_ms == 0 — but never panic).
        assert_eq!(stagger_offset("a", Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn stagger_offset_spreads_a_cohort_across_the_period() {
        // 100 same-period rows must not collapse onto a few phases —
        // the point is breaking the bulk-start cohort (ADR 0039).
        let p = Duration::from_millis(100);
        let distinct: std::collections::HashSet<_> = (0..100)
            .map(|i| stagger_offset(&format!("row-{i}"), p))
            .collect();
        assert!(
            distinct.len() >= 50,
            "only {} distinct offsets across 100 rows",
            distinct.len()
        );
    }

    #[test]
    fn fires_then_reschedules_on_a_fixed_grid() {
        let base = Instant::now();
        let period = Duration::from_millis(10);
        let mut s = PeriodicSchedule::new();
        s.schedule("a".into(), base);

        // Due at base; reschedules to base + 10 ms (from the deadline,
        // not from "now").
        let due = s.take_due(base);
        assert_eq!(ids(&due), ["a"]);
        let (id, fired_at) = &due[0];
        s.reschedule(id, *fired_at + period);

        assert_eq!(s.next_deadline(), Some(base + period));
        assert!(s.take_due(base + Duration::from_millis(5)).is_empty());
        assert_eq!(ids(&s.take_due(base + period)), ["a"]);
    }

    #[test]
    fn restart_does_not_leave_a_stale_entry_that_double_fires() {
        let base = Instant::now();
        let mut s = PeriodicSchedule::new();
        s.schedule("a".into(), base);
        // Stop, then restart 5 ms out before the original entry fired.
        s.unschedule("a");
        s.schedule("a".into(), base + Duration::from_millis(5));

        // The original (now stale) base entry must not fire.
        assert!(s.take_due(base + Duration::from_millis(1)).is_empty());
        // Only the restarted entry fires, exactly once.
        let due = s.take_due(base + Duration::from_millis(6));
        assert_eq!(ids(&due), ["a"]);
    }

    #[test]
    fn unschedule_during_a_tick_wins_over_reschedule() {
        let base = Instant::now();
        let mut s = PeriodicSchedule::new();
        s.schedule("a".into(), base);
        let due = s.take_due(base);
        assert_eq!(ids(&due), ["a"]);
        // Stop arrives while we're processing the tick; the follow-up
        // reschedule must be a no-op.
        s.unschedule("a");
        s.reschedule("a", base + Duration::from_millis(10));
        assert_eq!(s.next_deadline(), None);
    }

    #[test]
    fn earliest_deadline_first_across_messages() {
        let base = Instant::now();
        let mut s = PeriodicSchedule::new();
        s.schedule("slow".into(), base + Duration::from_millis(10));
        s.schedule("fast".into(), base + Duration::from_millis(2));
        assert_eq!(s.next_deadline(), Some(base + Duration::from_millis(2)));
        let due = s.take_due(base + Duration::from_millis(2));
        assert_eq!(ids(&due), ["fast"]);
        // slow isn't due yet.
        assert!(s.take_due(base + Duration::from_millis(2)).is_empty());
    }

    #[test]
    fn double_start_does_not_queue_two_live_entries() {
        let base = Instant::now();
        let mut s = PeriodicSchedule::new();
        s.schedule("a".into(), base);
        // A second start supersedes the first (fresh generation).
        s.schedule("a".into(), base);
        // Only one live firing comes due, not two.
        let due = s.take_due(base);
        assert_eq!(ids(&due), ["a"]);
    }
}
