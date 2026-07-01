//! Off-screen recovery for the main window.
//!
//! `tauri-plugin-window-state` persists the window's size, position,
//! maximized, and fullscreen state across launches. Restoring a saved
//! *position*, though, can drop the window onto coordinates no longer
//! covered by any monitor — the laptop was undocked, an external display
//! was unplugged, or the monitor arrangement changed between runs.
//!
//! That is dangerous here because the window is borderless
//! (`decorations: false`, with the custom `TitleBar`): a window whose
//! title bar lands off-screen leaves the user no OS chrome to drag it
//! back, so it is effectively lost. The fix is to guarantee a grabbable
//! strip of the *title bar* (not just any pixel of the window) survives
//! on a connected monitor, and to recentre on the primary monitor when
//! it doesn't.
//!
//! [`corrected_origin`] is the pure geometry that makes that decision;
//! [`ensure_on_screen`] is the thin Tauri wrapper that feeds it the live
//! monitor list and applies the correction.

use tauri::{Manager, PhysicalPosition};

/// Title-bar height in logical pixels. Must match the `.titlebar`
/// `height` in `apps/gui/src/index.css`; the band that has to stay
/// grabbable is this tall.
const TITLEBAR_HEIGHT_LOGICAL: u32 = 30;

/// Minimum width (physical px) of the title-bar band that must remain
/// visible for the user to land the cursor on the drag region and pull
/// the window back. Roughly two of the 46px window-control buttons.
const MIN_GRAB_W: i32 = 120;

/// A rectangle in physical pixels: top-left origin plus size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Length of the overlap between two 1-D intervals `[a, a+a_len)` and
/// `[b, b+b_len)`, clamped at zero.
fn overlap(a: i32, a_len: i32, b: i32, b_len: i32) -> i32 {
    let left = a.max(b);
    let right = (a + a_len).min(b + b_len);
    (right - left).max(0)
}

impl Rect {
    /// Area of the overlap between `self` and `other` (0 if disjoint).
    /// `i64` so summing several can't overflow on large desktops.
    fn intersection_area(self, other: Rect) -> i64 {
        let w = i64::from(overlap(self.x, self.w, other.x, other.w));
        let h = i64::from(overlap(self.y, self.h, other.y, other.h));
        w * h
    }
}

/// Decide whether the restored window's title bar is grabbable and, if
/// not, where to move it.
///
/// `window` is the restored outer rect, `band_h` the title-bar height
/// (physical px), `monitors` every connected monitor's rect, and
/// `primary` the recovery target. Returns `Some(new_origin)` to recentre
/// the window on `primary` (size preserved), or `None` if the title bar
/// is already grabbable where it is.
pub fn corrected_origin(
    window: Rect,
    band_h: i32,
    monitors: &[Rect],
    primary: Rect,
) -> Option<(i32, i32)> {
    let band = Rect {
        x: window.x,
        y: window.y,
        w: window.w,
        h: band_h,
    };
    // Monitors don't overlap in the virtual desktop, so summing the
    // per-monitor intersection areas equals the band's intersection with
    // the visible union — which handles a window straddling a seam.
    let visible: i64 = monitors.iter().map(|m| band.intersection_area(*m)).sum();
    let needed = i64::from(MIN_GRAB_W) * i64::from(band_h.max(1));
    if visible >= needed {
        return None;
    }
    // Recentre on the primary monitor, keeping the window's size. The
    // `max(0)` clamps a window larger than the monitor to the top-left
    // corner (it overflows bottom/right, which stays draggable) rather
    // than pushing the title bar above the monitor's top edge.
    let nx = primary.x + ((primary.w - window.w) / 2).max(0);
    let ny = primary.y + ((primary.h - window.h) / 2).max(0);
    Some((nx, ny))
}

/// Round a non-negative `f64` to the nearest `i32`, saturating. Used for
/// the logical→physical band-height conversion.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn round_to_i32(v: f64) -> i32 {
    let r = v.round();
    if r >= f64::from(i32::MAX) {
        i32::MAX
    } else if r <= 0.0 {
        0
    } else {
        r as i32
    }
}

/// Pull `position`/`size` off a [`tauri::Monitor`]-like pair into a
/// [`Rect`]. Physical pixels throughout.
fn to_rect(pos: PhysicalPosition<i32>, size: tauri::PhysicalSize<u32>) -> Rect {
    Rect {
        x: pos.x,
        y: pos.y,
        w: i32::try_from(size.width).unwrap_or(i32::MAX),
        h: i32::try_from(size.height).unwrap_or(i32::MAX),
    }
}

/// After `tauri-plugin-window-state` has restored the main window's
/// geometry, nudge it back onto a connected monitor if its title bar
/// landed off-screen. A no-op when the window is maximized/fullscreen
/// (it covers a monitor by definition) or when monitor info is
/// unavailable. Best-effort: a failed reposition is logged, not fatal.
pub fn ensure_on_screen(window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let monitors = match window.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        _ => return,
    };
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .unwrap_or_else(|| monitors[0].clone());
    let band_h = round_to_i32(f64::from(TITLEBAR_HEIGHT_LOGICAL) * primary.scale_factor());
    let window_rect = to_rect(pos, size);
    let monitor_rects: Vec<Rect> = monitors
        .iter()
        .map(|m| to_rect(*m.position(), *m.size()))
        .collect();
    let primary_rect = to_rect(*primary.position(), *primary.size());

    if let Some((nx, ny)) = corrected_origin(window_rect, band_h, &monitor_rects, primary_rect) {
        match window.set_position(PhysicalPosition::new(nx, ny)) {
            Ok(()) => crate::sys_info!(
                window.app_handle(),
                "window",
                "restored window was off-screen; recentred on primary monitor"
            ),
            Err(e) => crate::sys_warn!(
                window.app_handle(),
                "window",
                "failed to recentre off-screen window: {e}"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single 1920×1080 monitor at the origin; primary == only monitor.
    fn one_monitor() -> Vec<Rect> {
        vec![Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        }]
    }

    const BAND: i32 = 30;

    #[test]
    fn overlap_is_zero_when_disjoint_and_length_when_nested() {
        assert_eq!(overlap(0, 100, 200, 50), 0); // disjoint
        assert_eq!(overlap(0, 100, 50, 200), 50); // partial
        assert_eq!(overlap(0, 100, 10, 20), 20); // nested
    }

    #[test]
    fn intersection_area_multiplies_both_axes() {
        let a = Rect { x: 0, y: 0, w: 100, h: 100 };
        let b = Rect { x: 50, y: 50, w: 100, h: 100 };
        assert_eq!(a.intersection_area(b), 50 * 50);
        let c = Rect { x: 1000, y: 0, w: 10, h: 10 };
        assert_eq!(a.intersection_area(c), 0);
    }

    #[test]
    fn fully_on_screen_window_is_left_alone() {
        let mons = one_monitor();
        let win = Rect { x: 100, y: 100, w: 1200, h: 800 };
        assert_eq!(corrected_origin(win, BAND, &mons, mons[0]), None);
    }

    #[test]
    fn window_fully_off_all_monitors_is_recentred() {
        let mons = one_monitor();
        // Far to the left of any monitor — the undocked-laptop case.
        let win = Rect { x: -5000, y: 300, w: 1200, h: 800 };
        let origin = corrected_origin(win, BAND, &mons, mons[0]);
        // Centred on the 1920×1080 primary.
        assert_eq!(origin, Some(((1920 - 1200) / 2, (1080 - 800) / 2)));
    }

    #[test]
    fn body_visible_but_title_bar_above_screen_is_recentred() {
        // The decorations:false trap — most of the window is on-screen
        // but its title bar sits above the monitor's top edge, so there
        // is nothing to grab.
        let mons = one_monitor();
        let win = Rect { x: 200, y: -200, w: 1200, h: 800 };
        assert!(corrected_origin(win, BAND, &mons, mons[0]).is_some());
    }

    #[test]
    fn sliver_of_title_bar_under_the_grab_threshold_is_recentred() {
        // Only 50px of the title bar's width pokes onto the monitor —
        // below MIN_GRAB_W (120), so it's not realistically grabbable.
        let mons = one_monitor();
        let win = Rect { x: 1920 - 50, y: 100, w: 1200, h: 800 };
        assert!(corrected_origin(win, BAND, &mons, mons[0]).is_some());
    }

    #[test]
    fn enough_title_bar_visible_is_left_alone() {
        // 200px of title-bar width on-screen (> MIN_GRAB_W) — keep it.
        let mons = one_monitor();
        let win = Rect { x: 1920 - 200, y: 100, w: 1200, h: 800 };
        assert_eq!(corrected_origin(win, BAND, &mons, mons[0]), None);
    }

    #[test]
    fn straddling_two_monitors_counts_the_union() {
        // Two side-by-side 1920-wide monitors; the title bar spans the
        // seam with plenty visible across both, so no correction.
        let mons = vec![
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            Rect { x: 1920, y: 0, w: 1920, h: 1080 },
        ];
        let win = Rect { x: 1920 - 600, y: 100, w: 1200, h: 800 };
        assert_eq!(corrected_origin(win, BAND, &mons, mons[0]), None);
    }

    #[test]
    fn oversized_window_recentres_to_the_top_left_corner() {
        // A window larger than the primary monitor clamps to the corner
        // instead of pushing its title bar above the top edge.
        let mons = vec![Rect { x: 0, y: 0, w: 1000, h: 700 }];
        let win = Rect { x: -9000, y: -9000, w: 1200, h: 800 };
        assert_eq!(corrected_origin(win, BAND, &mons, mons[0]), Some((0, 0)));
    }

    #[test]
    fn recovery_target_is_the_primary_not_the_monitor_it_strayed_near() {
        // Primary is the right-hand monitor; the window strayed far below
        // everything. Recovery centres on the primary's coordinates.
        let mons = vec![
            Rect { x: 0, y: 0, w: 1920, h: 1080 },
            Rect { x: 1920, y: 0, w: 1920, h: 1080 },
        ];
        let primary = mons[1];
        let win = Rect { x: 500, y: 5000, w: 1200, h: 800 };
        assert_eq!(
            corrected_origin(win, BAND, &mons, primary),
            Some((1920 + (1920 - 1200) / 2, (1080 - 800) / 2)),
        );
    }
}
