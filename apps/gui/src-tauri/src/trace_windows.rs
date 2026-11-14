//! Each trace element's **trace window** — the `[start, end)` slice of the
//! session buffer ([`TraceStore`](crate::trace_store::TraceStore)) a
//! trace-style view shows, and whether it is running, paused or stopped.
//!
//! Host state, beside the buffer it indexes, so the frontend can be torn
//! down and rebuilt without the windows changing: the frontend's element
//! registry holds only a mirror, hydrated by [`get_trace_windows`] and
//! kept current by [`TRACE_WINDOWS_CHANGED_EVENT`], and the run controls
//! (Start / Stop / Pause / Resume / Clear / All Data) are host commands
//! ([`trace_window_control`]) — so Stop and Pause freeze at the host's
//! frame count, not at whatever count the frontend last heard.
//!
//! **Session-scoped and in memory only**, like the RBS Run flag (ADR
//! 0028): never written to the project, the workspace state or the
//! scratch. A relaunch restores a prior capture as stopped (ADR 0002
//! DS-7), because the restore sets every window to the stopped whole
//! buffer.
//!
//! **Nothing here runs per frame.** A running window has `end = None`
//! and grows by arithmetic in the views that page over it (ADR 0024,
//! ADR 0025); the map changes only on a run control, a session
//! (re)start, a restore, a buffer that shrank, an element appearing or
//! disappearing, and project open / close.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::AppState;

/// Tauri event emitted whenever any window changes. The payload is the
/// whole map — bounded by the project's element count, so there is no
/// diff format.
pub(crate) const TRACE_WINDOWS_CHANGED_EVENT: &str = "trace-windows-changed";

/// One element's window over the session buffer. `start` / `end` are
/// session-buffer frame counts; an `end` of `None` means *running* —
/// the window grows with the buffer. `is_paused` tells a paused window
/// (Resume continues it) from a stopped one (Start begins a fresh one)
/// and only means anything while `end` is set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceWindow {
    pub(crate) start: u64,
    pub(crate) end: Option<u64>,
    pub(crate) is_paused: bool,
}

/// Every element's window, keyed by element id (never by position).
pub(crate) type WindowMap = BTreeMap<String, TraceWindow>;

/// A run control, as the frontend names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TraceControl {
    /// A fresh, empty, running window at the current count.
    Start,
    /// Freeze at the current count (or keep an existing end).
    Stop,
    /// Freeze at the current count, resumable. No-op unless running.
    Pause,
    /// Continue a paused window, gap included. No-op unless paused.
    Resume,
    /// Collapse to empty at the current count, keeping the run state.
    Clear,
    /// Widen to the whole buffer, keeping the run state.
    AllData,
}

impl TraceWindow {
    /// A fresh, empty, *running* window anchored at count `n`.
    pub(crate) const fn fresh(n: u64) -> Self {
        Self {
            start: n,
            end: None,
            is_paused: false,
        }
    }

    /// An empty, *stopped* window anchored at count `n`.
    pub(crate) const fn cleared(n: u64) -> Self {
        Self {
            start: n,
            end: Some(n),
            is_paused: false,
        }
    }

    /// A *stopped* window spanning the whole restored buffer `[0, n)`: a
    /// reloaded prior capture is history, frozen, not live (ADR 0002
    /// DS-7).
    pub(crate) const fn restored(n: u64) -> Self {
        Self {
            start: 0,
            end: Some(n),
            is_paused: false,
        }
    }

    /// The window a brand-new element starts with. With a session buffer
    /// (a session started, or frames already in it) the view hooks
    /// straight into it — running from 0, the state a session start
    /// gives every window. Without one it is stopped and empty, and the
    /// next session start runs it with everything else.
    pub(crate) const fn new_element(buffer_exists: bool) -> Self {
        if buffer_exists {
            Self::fresh(0)
        } else {
            Self::cleared(0)
        }
    }

    const fn running(self) -> bool {
        self.end.is_none()
    }

    /// Clear: wipe the window to empty at `n` keeping its run state —
    /// Clear does not imply Stop or Pause.
    pub(crate) const fn clear_keeping_state(self, n: u64) -> Self {
        if self.running() {
            Self::fresh(n)
        } else {
            Self {
                is_paused: self.is_paused,
                ..Self::cleared(n)
            }
        }
    }

    /// All Data: widen to the whole buffer `[0, n)` keeping the run state
    /// — a running window runs from 0 (still following live), a frozen
    /// one becomes the buffer to date. The mirror image of
    /// [`Self::clear_keeping_state`]; a plot's post-DBC-reload recovery
    /// is Clear (cheap re-pick of signals) then All Data (one
    /// full-history resample, ADR 0024).
    pub(crate) const fn all_data(self, n: u64) -> Self {
        if self.running() {
            Self::fresh(0)
        } else {
            Self {
                is_paused: self.is_paused,
                ..Self::restored(n)
            }
        }
    }

    /// Stop: freeze at `n`, keeping an existing end (pause → stop keeps
    /// where it paused).
    pub(crate) const fn stop(self, n: u64) -> Self {
        Self {
            start: self.start,
            end: match self.end {
                Some(e) => Some(e),
                None => Some(n),
            },
            is_paused: false,
        }
    }

    /// Pause: freeze at `n`, resumable. No-op unless running.
    pub(crate) const fn pause(self, n: u64) -> Self {
        if self.running() {
            Self {
                start: self.start,
                end: Some(n),
                is_paused: true,
            }
        } else {
            self
        }
    }

    /// Resume a paused window — it continues, including whatever arrived
    /// while paused (it is all in the buffer). No-op otherwise.
    pub(crate) const fn resume(self) -> Self {
        if !self.running() && self.is_paused {
            Self::fresh(self.start)
        } else {
            self
        }
    }

    /// Re-anchor a window the buffer shrank out from under (a clear, a
    /// cache wipe). A running window whose start dangles past the new
    /// end restarts empty, still running; a frozen one out of range
    /// collapses to empty at the new end keeping its paused-ness, so it
    /// does not come back to life; a stale end is trimmed. Unchanged
    /// otherwise.
    pub(crate) const fn reanchor(self, n: u64) -> Self {
        match self.end {
            None if self.start > n => Self::fresh(n),
            Some(_) if self.start > n => Self {
                is_paused: self.is_paused,
                ..Self::cleared(n)
            },
            Some(e) if e > n => Self {
                end: Some(n),
                ..self
            },
            None | Some(_) => self,
        }
    }

    /// Apply a run control at session count `n`.
    pub(crate) const fn apply(self, control: TraceControl, n: u64) -> Self {
        match control {
            TraceControl::Start => Self::fresh(n),
            TraceControl::Stop => self.stop(n),
            TraceControl::Pause => self.pause(n),
            TraceControl::Resume => self.resume(),
            TraceControl::Clear => self.clear_keeping_state(n),
            TraceControl::AllData => self.all_data(n),
        }
    }
}

/// Run control `control` on element `id` at count `n`. Unknown ids are a
/// no-op: an element's window comes into being through [`sync`], not
/// through a control racing its creation. Returns whether anything
/// changed.
pub(crate) fn control(map: &mut WindowMap, id: &str, control: TraceControl, n: u64) -> bool {
    let Some(w) = map.get_mut(id) else {
        return false;
    };
    let next = w.apply(control, n);
    let changed = next != *w;
    *w = next;
    changed
}

/// Make the map hold exactly `ids`: an id it lacks gets
/// [`TraceWindow::new_element`]'s window, an id it has keeps its window
/// untouched, and an id no longer listed (an element removed, undone, or
/// left behind by a project switch) is dropped. Returns whether anything
/// changed.
pub(crate) fn sync(map: &mut WindowMap, ids: &[String], buffer_exists: bool) -> bool {
    let before = map.len();
    map.retain(|id, _| ids.contains(id));
    let mut changed = map.len() != before;
    for id in ids {
        if !map.contains_key(id) {
            map.insert(id.clone(), TraceWindow::new_element(buffer_exists));
            changed = true;
        }
    }
    changed
}

/// Set every window to `f(window)`. Returns whether any changed.
pub(crate) fn set_all(map: &mut WindowMap, f: impl Fn(TraceWindow) -> TraceWindow) -> bool {
    let mut changed = false;
    for w in map.values_mut() {
        let next = f(*w);
        changed |= next != *w;
        *w = next;
    }
    changed
}

/// The map, behind its lock. Every write goes through [`Self::update`],
/// which publishes the new map while still holding the lock — so two
/// writes on different threads cannot reach the frontend in the opposite
/// order from the one they happened in.
#[derive(Default)]
pub(crate) struct TraceWindows {
    map: Mutex<WindowMap>,
}

impl TraceWindows {
    /// The whole map, cloned.
    pub(crate) fn snapshot(&self) -> WindowMap {
        self.lock().clone()
    }

    /// Run `f` over the map; if it reports a change, hand the new map to
    /// `publish` before the lock is released.
    pub(crate) fn update(
        &self,
        f: impl FnOnce(&mut WindowMap) -> bool,
        publish: impl FnOnce(&WindowMap),
    ) {
        let mut map = self.lock();
        if f(&mut map) {
            publish(&map);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WindowMap> {
        self.map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// [`TraceWindows::update`] on the app's map, publishing on
/// [`TRACE_WINDOWS_CHANGED_EVENT`].
pub(crate) fn update(app: &AppHandle, f: impl FnOnce(&mut WindowMap) -> bool) {
    let state = app.state::<AppState>();
    state.trace_windows.update(f, |map| {
        let _ = app.emit(TRACE_WINDOWS_CHANGED_EVENT, map);
    });
}

/// The store's current frame count, as a window count.
fn store_count(state: &AppState) -> u64 {
    u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX)
}

/// Whether a session buffer exists for a new element to hook into: a
/// session has started, or the buffer already holds frames.
fn buffer_exists(state: &AppState) -> bool {
    state.trace_store.session_started() || state.trace_store.len() > 0
}

/// A session (re)start — Connect, opening a capture, Clear: every
/// window runs from 0, following the new capture from its start.
pub(crate) fn start_all(app: &AppHandle) {
    update(app, |map| set_all(map, |_| TraceWindow::fresh(0)));
}

/// The buffer may have shrunk under the windows (a clear, a cache wipe,
/// a reload that found nothing): re-anchor each one to the store's
/// count.
pub(crate) fn reanchor_all(app: &AppHandle) {
    let n = store_count(&app.state::<AppState>());
    update(app, |map| set_all(map, |w| w.reanchor(n)));
}

/// A finished import: every window freezes at `n`, the store's own
/// length when the pump ended. Nothing more will be appended, so a
/// window left running reports a state the session is not in — and
/// keeps every plot over it re-sampling a picture that cannot change.
pub(crate) fn stop_all(app: &AppHandle, n: u64) {
    update(app, |map| set_all(map, |w| w.stop(n)));
}

/// A restored prior capture of `n` frames: every window is the stopped
/// whole buffer (ADR 0002 DS-7).
pub(crate) fn restore_all(app: &AppHandle, n: u64) {
    update(app, |map| set_all(map, |_| TraceWindow::restored(n)));
}

/// Opening a project: the windows are the opened project's elements',
/// each stopped and empty at the store's count. `ids` are the element
/// ids the file lists; one the frontend then drops (an element kind it
/// does not know) leaves with its next [`sync_trace_windows`].
pub(crate) fn replace_for_open(app: &AppHandle, ids: &[String]) {
    let n = store_count(&app.state::<AppState>());
    update(app, |map| {
        let next: WindowMap = ids
            .iter()
            .map(|id| (id.clone(), TraceWindow::cleared(n)))
            .collect();
        let changed = *map != next;
        *map = next;
        changed
    });
}

/// Closing a project: its elements and their windows go with it.
pub(crate) fn clear(app: &AppHandle) {
    update(app, |map| {
        let changed = !map.is_empty();
        map.clear();
        changed
    });
}

/// The whole map, for the frontend mirror's snapshot. In-memory state
/// only, so it is safe on the IPC thread.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn get_trace_windows(state: tauri::State<'_, AppState>) -> WindowMap {
    state.trace_windows.snapshot()
}

/// Apply a run control to one element's window at the store's current
/// count, and publish the result.
///
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers):
/// reading the count takes the store lock, which a capture restore holds
/// for its swap (ADR 0048).
#[tauri::command]
pub(crate) async fn trace_window_control(app: AppHandle, element_id: String, action: TraceControl) {
    crate::sampling::off_async_workers(move || {
        let n = store_count(&app.state::<AppState>());
        update(&app, |map| control(map, &element_id, action, n));
    })
    .await;
}

/// Make the window map hold exactly the frontend registry's element ids
/// (see [`sync`]). The frontend calls this whenever its set of element
/// ids changes — an element created, duplicated, removed, undone or
/// redone, a project's elements applied — never per frame.
///
/// Off the IPC thread for the same reason as [`trace_window_control`].
#[tauri::command]
pub(crate) async fn sync_trace_windows(app: AppHandle, element_ids: Vec<String>) {
    crate::sampling::off_async_workers(move || {
        let exists = buffer_exists(&app.state::<AppState>());
        update(&app, |map| sync(map, &element_ids, exists));
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn w(start: u64, end: Option<u64>, is_paused: bool) -> TraceWindow {
        TraceWindow {
            start,
            end,
            is_paused,
        }
    }

    #[test]
    fn fresh_cleared_and_restored_shapes() {
        assert_eq!(TraceWindow::fresh(5), w(5, None, false));
        assert_eq!(TraceWindow::cleared(7), w(7, Some(7), false));
        assert_eq!(TraceWindow::restored(3626), w(0, Some(3626), false));
    }

    #[test]
    fn a_new_element_runs_from_zero_only_when_a_buffer_exists() {
        assert_eq!(TraceWindow::new_element(true), TraceWindow::fresh(0));
        assert_eq!(TraceWindow::new_element(false), TraceWindow::cleared(0));
    }

    #[test]
    fn clear_keeps_the_run_state() {
        let running = TraceWindow::fresh(2);
        assert_eq!(running.clear_keeping_state(9), TraceWindow::fresh(9));
        let stopped = running.stop(5);
        assert_eq!(stopped.clear_keeping_state(9), w(9, Some(9), false));
        let paused = running.pause(5);
        assert_eq!(paused.clear_keeping_state(9), w(9, Some(9), true));
    }

    #[test]
    fn all_data_widens_to_the_whole_buffer_keeping_the_run_state() {
        let running = TraceWindow::fresh(2);
        // Running stays running, now from the buffer's start.
        assert_eq!(running.all_data(9), TraceWindow::fresh(0));
        // Stopped becomes the buffer to date, frozen.
        assert_eq!(running.stop(5).all_data(9), w(0, Some(9), false));
        // Paused stays paused, widened.
        assert_eq!(running.pause(5).all_data(9), w(0, Some(9), true));
    }

    #[test]
    fn stop_freezes_a_running_window() {
        assert_eq!(TraceWindow::fresh(5).stop(20), w(5, Some(20), false));
    }

    #[test]
    fn pause_freezes_resumably_and_is_a_no_op_once_frozen() {
        let p = TraceWindow::fresh(5).pause(20);
        assert_eq!(p, w(5, Some(20), true));
        assert_eq!(p.pause(999), p);
        assert_eq!(TraceWindow::fresh(0).stop(1).pause(999).end, Some(1));
    }

    #[test]
    fn resume_continues_a_paused_window_and_is_a_no_op_otherwise() {
        let p = TraceWindow::fresh(5).pause(20);
        assert_eq!(p.resume(), w(5, None, false));
        assert_eq!(TraceWindow::fresh(0).resume(), TraceWindow::fresh(0));
        let stopped = TraceWindow::fresh(0).stop(3);
        assert_eq!(stopped.resume(), stopped);
    }

    #[test]
    fn stop_on_a_paused_window_keeps_its_end() {
        let s = TraceWindow::fresh(5).pause(20).stop(999);
        assert_eq!(s, w(5, Some(20), false));
    }

    #[test]
    fn reanchor_restarts_a_dangling_running_window_still_running() {
        assert_eq!(w(1000, None, false).reanchor(0), TraceWindow::fresh(0));
    }

    #[test]
    fn reanchor_collapses_an_out_of_range_frozen_window_keeping_paused_ness() {
        assert_eq!(
            w(1000, Some(2000), false).reanchor(0),
            TraceWindow::cleared(0)
        );
        assert_eq!(w(1000, Some(2000), true).reanchor(0), w(0, Some(0), true));
    }

    #[test]
    fn reanchor_trims_a_stale_end_and_leaves_an_in_range_window_alone() {
        assert_eq!(w(5, Some(100), true).reanchor(50), w(5, Some(50), true));
        let s = w(5, Some(10), false);
        assert_eq!(s.reanchor(100), s);
        let r = w(5, None, false);
        assert_eq!(r.reanchor(100), r);
    }

    #[test]
    fn apply_routes_each_control() {
        let r = TraceWindow::fresh(2);
        assert_eq!(r.apply(TraceControl::Start, 9), TraceWindow::fresh(9));
        assert_eq!(r.apply(TraceControl::Stop, 9), r.stop(9));
        assert_eq!(r.apply(TraceControl::Pause, 9), r.pause(9));
        assert_eq!(r.pause(9).apply(TraceControl::Resume, 12), r);
        assert_eq!(r.apply(TraceControl::Clear, 9), r.clear_keeping_state(9));
        assert_eq!(r.apply(TraceControl::AllData, 9), r.all_data(9));
    }

    #[test]
    fn controls_deserialize_from_the_frontend_names() {
        let names = ["start", "stop", "pause", "resume", "clear", "allData"];
        let parsed: Vec<TraceControl> = names
            .iter()
            .map(|n| serde_json::from_value(serde_json::json!(n)).unwrap())
            .collect();
        assert_eq!(
            parsed,
            [
                TraceControl::Start,
                TraceControl::Stop,
                TraceControl::Pause,
                TraceControl::Resume,
                TraceControl::Clear,
                TraceControl::AllData,
            ]
        );
    }

    #[test]
    fn a_window_serializes_in_the_frontend_shape() {
        let v = serde_json::to_value(w(3, None, true)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "start": 3, "end": null, "isPaused": true })
        );
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn control_changes_one_element_and_ignores_unknown_ids() {
        let mut map = WindowMap::new();
        sync(&mut map, &ids(&["a", "b"]), true);
        assert!(control(&mut map, "a", TraceControl::Stop, 40));
        assert_eq!(map["a"], w(0, Some(40), false));
        assert_eq!(map["b"], TraceWindow::fresh(0));
        assert!(!control(&mut map, "missing", TraceControl::Stop, 40));
        assert!(!map.contains_key("missing"));
        // A control that changes nothing reports no change.
        assert!(!control(&mut map, "a", TraceControl::Pause, 50));
    }

    #[test]
    fn sync_adds_new_elements_keeps_existing_windows_and_drops_removed_ones() {
        let mut map = WindowMap::new();
        assert!(sync(&mut map, &ids(&["a"]), false));
        assert_eq!(map["a"], TraceWindow::cleared(0));
        control(&mut map, "a", TraceControl::Start, 0);
        control(&mut map, "a", TraceControl::Pause, 30);
        // A later element joins a buffer that now exists; `a` keeps its
        // paused window rather than being reset.
        assert!(sync(&mut map, &ids(&["a", "b"]), true));
        assert_eq!(map["a"], w(0, Some(30), true));
        assert_eq!(map["b"], TraceWindow::fresh(0));
        // Removing `a` (or undoing its creation) drops its window.
        assert!(sync(&mut map, &ids(&["b"]), true));
        assert_eq!(map.keys().collect::<Vec<_>>(), ["b"]);
        // The same id set again changes nothing.
        assert!(!sync(&mut map, &ids(&["b"]), true));
    }

    #[test]
    fn set_all_reports_whether_anything_moved() {
        let mut map = WindowMap::new();
        sync(&mut map, &ids(&["a", "b"]), true);
        assert!(!set_all(&mut map, |_| TraceWindow::fresh(0)));
        assert!(set_all(&mut map, |win| win.stop(12)));
        assert!(map.values().all(|win| *win == w(0, Some(12), false)));
    }

    #[test]
    fn update_publishes_only_a_change_and_publishes_the_new_map() {
        let store = TraceWindows::default();
        let mut published: Vec<WindowMap> = Vec::new();
        store.update(
            |map| sync(map, &ids(&["a"]), true),
            |m| published.push(m.clone()),
        );
        store.update(
            |map| sync(map, &ids(&["a"]), true),
            |m| published.push(m.clone()),
        );
        assert_eq!(published.len(), 1);
        assert_eq!(published[0]["a"], TraceWindow::fresh(0));
        assert_eq!(store.snapshot(), published[0]);
    }
}
