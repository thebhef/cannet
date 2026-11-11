//! Window resize and scale-factor changes, written to `cannet.log` at
//! `debug` as one line per burst.
//!
//! Both are suspects in a frontend hang (a resize starts a relayout of
//! every view; a scale change re-rasterises them), and the log had no
//! record of either. A window drag delivers a resize per frame, so the
//! events are coalesced: the first opens a burst and a short-lived thread
//! that writes the burst's one line once it has been quiet for
//! [`QUIET`]. The event-loop side is a lock and a few stores — it runs on
//! the thread that paints the window.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WindowEvent};

/// Quiet time that ends a burst.
const QUIET: Duration = Duration::from_millis(500);

/// One window change.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Change {
    Resized { w: u32, h: u32 },
    Scale { factor: f64, w: u32, h: u32 },
}

/// A burst of changes being coalesced.
#[derive(Debug, Clone, PartialEq)]
struct Burst {
    first: Instant,
    last: Instant,
    resizes: u32,
    size: (u32, u32),
    scale: Option<f64>,
}

impl Burst {
    fn new(now: Instant) -> Self {
        Self {
            first: now,
            last: now,
            resizes: 0,
            size: (0, 0),
            scale: None,
        }
    }

    fn note(&mut self, now: Instant, change: Change) {
        self.last = now;
        match change {
            Change::Resized { w, h } => {
                self.resizes += 1;
                self.size = (w, h);
            }
            Change::Scale { factor, w, h } => {
                self.scale = Some(factor);
                self.size = (w, h);
            }
        }
    }

    /// The burst's one log line.
    fn line(&self) -> String {
        let (w, h) = self.size;
        let scale = self
            .scale
            .map_or_else(String::new, |f| format!("; scale factor changed to {f}"));
        format!(
            "window: {} resize events over {} ms, final {w}x{h} px{scale}",
            self.resizes,
            self.last.duration_since(self.first).as_millis()
        )
    }
}

/// The open burst, if any. Managed state, shared by the event loop and
/// the burst's flushing thread.
#[derive(Debug, Default)]
pub(crate) struct WindowEvents(Mutex<Option<Burst>>);

impl WindowEvents {
    /// Fold `change` into the open burst. `true` when it opened one, so
    /// the caller starts the thread that will flush it.
    fn note(&self, now: Instant, change: Change) -> bool {
        let mut open = self.0.lock().expect("window events mutex poisoned");
        let opened = open.is_none();
        open.get_or_insert_with(|| Burst::new(now))
            .note(now, change);
        opened
    }

    /// The open burst's line, closing it, once it has been quiet for
    /// [`QUIET`]; `None` while it is still going.
    fn take_if_quiet(&self, now: Instant) -> Option<String> {
        let mut open = self.0.lock().expect("window events mutex poisoned");
        match open.as_ref() {
            Some(b) if now.duration_since(b.last) >= QUIET => open.take().map(|b| b.line()),
            _ => None,
        }
    }
}

/// Note a window event, from the run loop. Anything but a resize or a
/// scale change is ignored.
pub(crate) fn on_window_event(app: &AppHandle, event: &WindowEvent) {
    let change = match event {
        WindowEvent::Resized(size) => Change::Resized {
            w: size.width,
            h: size.height,
        },
        WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => Change::Scale {
            factor: *scale_factor,
            w: new_inner_size.width,
            h: new_inner_size.height,
        },
        _ => return,
    };
    if app.state::<WindowEvents>().note(Instant::now(), change) {
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("window-events".into())
            .spawn(move || loop {
                std::thread::sleep(QUIET / 2);
                if let Some(line) = app.state::<WindowEvents>().take_if_quiet(Instant::now()) {
                    crate::sys_debug!(&app, "window", "{line}");
                    return;
                }
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_is_one_line_written_once_it_goes_quiet() {
        let events = WindowEvents::default();
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        assert!(events.note(t0, Change::Resized { w: 800, h: 600 }));
        for i in 1..30u32 {
            assert!(!events.note(
                ms(u64::from(i) * 16),
                Change::Resized { w: 800 + i, h: 600 }
            ));
        }
        let last = ms(29 * 16);
        assert_eq!(events.take_if_quiet(last + QUIET / 2), None);
        assert_eq!(
            events.take_if_quiet(last + QUIET).as_deref(),
            Some("window: 30 resize events over 464 ms, final 829x600 px")
        );
        // Closed: the next change opens a new burst.
        assert_eq!(events.take_if_quiet(last + QUIET * 2), None);
        assert!(events.note(last + QUIET * 2, Change::Resized { w: 1, h: 1 }));
    }

    #[test]
    fn a_scale_change_rides_in_the_burst_it_arrives_with() {
        let events = WindowEvents::default();
        let t0 = Instant::now();
        events.note(
            t0,
            Change::Scale {
                factor: 1.25,
                w: 2400,
                h: 1350,
            },
        );
        assert_eq!(
            events.take_if_quiet(t0 + QUIET).as_deref(),
            Some("window: 0 resize events over 0 ms, final 2400x1350 px; scale factor changed to 1.25")
        );
    }
}
