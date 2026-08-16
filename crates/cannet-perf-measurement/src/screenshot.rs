//! Visual-parity screenshots of the running GUI (ADR 0031 harness).
//!
//! The perf harness already characterises what the render tier *costs*;
//! this module characterises what it *looks like*, so a refactor that is
//! meant to be pixel-neutral (swapping literal colors for tokens, say)
//! can be proven so instead of eyeballed.
//!
//! Same argument as the rest of ADR 0031 — measure the real shipping app,
//! not a stand-in — with one platform caveat the perf tier doesn't have:
//! the capture goes through the Chrome `DevTools` Protocol, so it needs a
//! Chromium-backed webview. That is `WebView2`, i.e. **Windows only**.
//! macOS (`WKWebView`) and Linux (`WebKitGTK`) speak no CDP; the parity check
//! is a developer/CI tool on Windows rather than a per-platform gate.
//! Nothing about the shipping binary changes: `WebView2` opens the
//! debugging port from the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
//! environment variable this module sets on the child, so there is no new
//! automation surface in the app itself.
//!
//! ## Determinism
//!
//! A screenshot diff is only meaningful if the two captures were of the
//! same picture. The app renders live data, so [`SCENARIO`] — the
//! parity walk — is built to stand still. ([`EXTRAPOLATION_SCENARIO`] is
//! a sign-off set to look at rather than a baseline to diff; it holds
//! still for its own reasons, recorded there.)
//!
//! - **Idle** — the app is launched without `--connect-on-start`, so no
//!   interface is touched, no frames arrive, and every rate, counter and
//!   follow-live window is at rest.
//! - **An isolated profile** — `--app-data-dir` redirects the whole user
//!   scope into a directory the run owns ([`CaptureConfig::app_data_dir`]),
//!   so the capture neither writes the operator's settings and window
//!   geometry nor reads them. Reading matters as much as writing here: every
//!   user-scope setting is an input to the picture, and the theme the
//!   capture is *for* ([`CaptureConfig::theme`]) is one of them.
//! - **An isolated `WebView2` profile** — the child also gets its own
//!   `WEBVIEW2_USER_DATA_FOLDER` inside that directory ([`gui_env`]),
//!   without which a capture launched while the operator has their own
//!   copy of the app open is served by the browser process already
//!   running — and that one carries no debugging port.
//! - **Fixed viewport** — `Emulation.setDeviceMetricsOverride` pins the
//!   layout to [`CaptureConfig::width`] × [`CaptureConfig::height`] at
//!   device-scale 1, so the OS window geometry (restored from the user's
//!   window state) cannot move a pixel.
//! - **No animation** — `Emulation.setEmulatedMedia` forces
//!   `prefers-reduced-motion: reduce`, which the stylesheet honours by
//!   dropping its one keyframe animation.
//! - **Masking** — the few regions that still move while idle are hidden
//!   by an injected stylesheet ([`MASK_CSS`]) before the shutter. The
//!   mask lives here, not in the app, so it is identical on both sides of
//!   a comparison.
//!
//! The residual is measured, not assumed: capture the same scenario twice
//! against one build and diff it (the *noise floor*). A parity claim is
//! only as strong as that floor, and the floor belongs in whatever
//! writes the claim down.

use std::collections::BTreeSet;
use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// Every dock component name the app can render (the `contentComponent`
/// values in a saved layout). The scenario's coverage is asserted against
/// this list so "the captures show the whole app" is a checked claim, not
/// a hope.
pub const ALL_PANEL_COMPONENTS: &[&str] = &[
    "trace",
    "plot",
    "signals",
    "transmit",
    "rbs",
    "colormap",
    "project",
    "project-graph",
    "system-messages",
    "dbc",
    "settings",
    "about",
    "events",
    "shortcuts",
];

/// Regions that still change while the app sits idle, hidden before the
/// shutter. Each entry is here because it moved a diff, not on suspicion:
///
/// - `.status` — the status bar carries RAM / cache readings that the
///   host refreshes independently of frame arrival.
/// - `.system-messages-count` / `.system-messages-badge` — the health
///   recorder logs one debug line every 20 s, so the totals climb even
///   with nothing connected.
/// - `.system-messages-ts` / `.system-messages-msg` /
///   `.system-messages-source` — wall-clock stamps, message bodies that
///   quote per-launch facts (sidecar pids, resolved cache paths), and
///   the source column, whose rows race: the sidecar's startup lines and
///   the project-open line interleave differently run to run. The rows
///   themselves and their level chips stay in frame.
/// - `.plot-perf` — the plot's per-second render badge decays after the
///   last resample.
/// - the About panel's version readout — `git describe` output, so it
///   differs between any two builds. It has no class of its own; the
///   selector reaches the first field of the first group of the About
///   panel (`.settings-panel` without the shortcuts modifier).
///
/// `visibility: hidden` rather than a fill color: the mask must not
/// introduce a color of its own into the comparison, and it leaves the
/// surrounding surface — which *is* under test — visible.
pub const MASK_CSS: &str = "\
.status, .plot-perf, .system-messages-count, .system-messages-badge, \
.system-messages-ts, .system-messages-msg, .system-messages-source, \
.settings-panel:not(.shortcuts-panel) .settings-group:first-of-type .settings-desc \
{ visibility: hidden !important; }";

/// Helpers injected into the page before each step so the scenario
/// scripts stay short. Driving is done the way a user drives: clicking
/// the real toolbar buttons, dock tabs and palette rows.
const PRELUDE_JS: &str = r#"
window.__shot = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  settle: async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await window.__shot.sleep(400);
  },
  /* Click a toolbar button by its exact label. */
  toolbar: async (label) => {
    const b = [...document.querySelectorAll(".toolbar button")].find(
      (e) => e.textContent.trim() === label,
    );
    if (!b) throw new Error("no toolbar button " + JSON.stringify(label));
    b.click();
    await window.__shot.settle();
  },
  /* Open the command palette (the real Mod+Shift+P chord). The
     dispatcher matches modifiers exactly and rejects a Meta stroke off
     mac, so Control alone — this harness is Windows-only anyway. */
  openPalette: async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "P", ctrlKey: true, shiftKey: true, bubbles: true,
      }),
    );
    await window.__shot.settle();
    if (!document.querySelector(".palette-input")) throw new Error("palette did not open");
  },
  /* Run a palette command by its exact label. */
  command: async (label) => {
    await window.__shot.openPalette();
    const item = [...document.querySelectorAll(".palette-item")].find(
      (e) => e.textContent.trim().startsWith(label),
    );
    if (!item) throw new Error("no palette item " + JSON.stringify(label));
    item.click();
    await window.__shot.settle();
  },
  /* Poll `fn` until it returns something truthy, or give up saying what
     was being waited for. A step driving an import waits on the app's
     own progress, which is seconds of file walking and pumping — a
     fixed sleep would either be a guess or a tax on every run. */
  waitFor: async (what, fn, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await window.__shot.sleep(100);
    }
  },
  /* Open the toolbar's Recent menu and pick its one entry — the capture
     this run seeded into its own profile's recents. Driven
     structurally rather than by the path's text, because the path is a
     property of the machine the run is on. This is the dialog-free way
     into a capture: the file picker is a native dialog the page cannot
     reach, and `Recent` calls the same import with a path. */
  openSeededCapture: async () => {
    const trigger = document.querySelector(".recent-captures > button");
    if (!trigger) throw new Error("no Recent menu — this profile's recents were not seeded");
    trigger.click();
    await window.__shot.settle();
    const item = document.querySelector(".recent-captures-menu button");
    if (!item) throw new Error("the Recent menu is empty");
    item.click();
    await window.__shot.settle();
  },
  /* Click a modal's button by its exact label. */
  modal: async (label) => {
    const b = [...document.querySelectorAll(".modal-buttons button")].find(
      (e) => e.textContent.trim() === label,
    );
    if (!b) throw new Error("no modal button " + JSON.stringify(label));
    b.click();
    await window.__shot.settle();
  },
  /* True while no trace import is running. The toolbar's import button
     is the app's own statement about it: it says "Loading trace…"
     from the first byte of the census to the pump's `log-finished`. */
  importIdle: () =>
    ![...document.querySelectorAll(".toolbar button")].some(
      (e) => e.textContent.trim() === "Loading trace…",
    ),
};
"#;

/// One scenario step: drive the app, then photograph it.
pub struct Step {
    /// File stem of the capture (`<out-dir>/<prefix><name>.png`).
    pub name: &'static str,
    /// Script run before the shutter. Evaluated as an async expression.
    pub script: &'static str,
    /// Dock components this capture is claimed to show. Purely a
    /// coverage ledger — [`scenario_covers_every_panel`] checks the union.
    pub shows: &'static [&'static str],
}

/// The capture scenario: a small set of layouts that, between them, put
/// every dock component and the always-on chrome (toolbar, status bar,
/// dock tabs, command palette) in front of the lens.
///
/// Written against `examples/ev-demo`, whose saved layout already carries
/// nine of the fourteen components; the rest are opened the way a user
/// opens them. Only step 01 reads the project's saved layout — every
/// later step opens what it photographs — so a project with a different
/// set of saved tabs (`examples/ev-zonal`) walks the same scenario.
pub const SCENARIO: &[Step] = &[
    Step {
        // The layout as saved: project, RBS, events, two traces, the
        // signals view and both plots are the active tabs of their groups.
        name: "01-saved-layout",
        script: "(async () => { await window.__shot.settle(); })()",
        shows: &["project", "rbs", "events", "trace", "signals", "plot"],
    },
    // Singleton panels are brought forward by their own commands rather
    // than by clicking a dock tab. A singleton's title is a constant of
    // the build (`SINGLETON_PANEL_TITLES`), so a saved layout's tab text
    // is whatever the project was saved under until the app normalizes
    // it — driving by title made the step a function of both the rename
    // history and the project (the Database panel is in `ev-demo`'s saved
    // layout and not in `ev-zonal`'s). The show-or-focus command is the
    // same picture either way: it activates the panel when it is open and
    // adds it when it isn't.
    Step {
        name: "02-dbc-system-messages",
        script: "(async () => { \
            await window.__shot.command('Show Database panel'); \
            await window.__shot.command('Show system messages'); \
        })()",
        shows: &["dbc", "system-messages"],
    },
    Step {
        name: "03-settings",
        script: "(async () => { await window.__shot.command('Show settings'); })()",
        shows: &["settings"],
    },
    // One added panel per step: each lands as the active tab of its
    // group, so adding two in a row would photograph only the second.
    Step {
        name: "04-transmit",
        script: "(async () => { await window.__shot.toolbar('Add transmit panel'); })()",
        shows: &["transmit"],
    },
    Step {
        name: "05-colormap",
        script: "(async () => { await window.__shot.toolbar('Add color map'); })()",
        shows: &["colormap"],
    },
    Step {
        name: "06-project-graph",
        script: "(async () => { await window.__shot.toolbar('Graph panel'); })()",
        shows: &["project-graph"],
    },
    Step {
        name: "07-about",
        script: "(async () => { await window.__shot.command('Show about'); })()",
        shows: &["about"],
    },
    Step {
        name: "08-shortcuts",
        script: "(async () => { await window.__shot.command('Show keyboard shortcuts'); })()",
        shows: &["shortcuts"],
    },
    Step {
        name: "09-palette",
        script: "(async () => { await window.__shot.openPalette(); })()",
        shows: &[],
    },
];

/// The sign-off scenario for the **extrapolation rendering** (ADR
/// 0026): import a capture that carries every extrapolated shape and
/// photograph the plot drawing them.
///
/// It is its own scenario rather than a step of [`SCENARIO`] because it
/// needs something [`SCENARIO`] deliberately does not have — data. The
/// parity walk photographs an *idle* app so that nothing in frame is a
/// function of when the shutter fell; a plot can only show a dashed
/// tail, an interior stall, a one-sample hline or a striped lane if the
/// session holds a capture with those shapes in it. Written against
/// `examples/extrapolation`, whose project is one plot panel and whose
/// BLF is the shapes and nothing else.
///
/// Determinism comes from the fixture and from **fit x axis**: the
/// capture is a file, so its extent is fixed, and fitting to it pins the
/// window to exactly that extent. Follow-live is left on — with a static
/// capture the newest frame *is* the fixture's last, so the window comes
/// to rest where the fit put it.
pub const EXTRAPOLATION_SCENARIO: &[Step] = &[
    // The import, driven the way a user drives it: Recent → the seeded
    // path → the channel dialog's own defaults (one BLF channel onto the
    // project's one bus) → Open. Then wait for the pump, because a
    // shutter that falls mid-import photographs a partial capture, and a
    // partial capture's series all end early — which is to say, it would
    // manufacture the very shape this scenario is here to show.
    Step {
        name: "01-capture-imported",
        script: "(async () => { \
            await window.__shot.openSeededCapture(); \
            await window.__shot.waitFor('the channel dialog', \
                () => document.querySelector('.modal-buttons'), 120000); \
            await window.__shot.modal('Open'); \
            await window.__shot.waitFor('the import to finish', \
                () => window.__shot.importIdle(), 180000); \
            await window.__shot.sleep(1500); \
            await window.__shot.settle(); \
        })()",
        shows: &["plot"],
    },
    // The sign-off frame: the whole capture in the window, so every
    // series' last sample is inside it and the stretch past it is drawn.
    Step {
        name: "02-extrapolated-stretches",
        script: "(async () => { \
            await window.__shot.command('Plot: fit x axis'); \
            await window.__shot.sleep(1500); \
            await window.__shot.settle(); \
        })()",
        shows: &["plot"],
    },
];

/// The scenarios a capture run can walk, by their `--scenario` name.
pub const SCENARIOS: &[(&str, &[Step])] = &[
    ("panels", SCENARIO),
    ("extrapolation", EXTRAPOLATION_SCENARIO),
];

/// Look a scenario up by name, listing the alternatives when it misses.
///
/// # Errors
/// Returns a message naming the known scenarios.
pub fn scenario_by_name(name: &str) -> Result<&'static [Step], String> {
    SCENARIOS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, s)| *s)
        .ok_or_else(|| {
            format!(
                "unknown scenario {name:?}; known: {}",
                SCENARIOS
                    .iter()
                    .map(|(n, _)| *n)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

/// Union of the scenario's `shows` ledgers, sorted.
#[must_use]
pub fn scenario_coverage(steps: &[Step]) -> BTreeSet<&'static str> {
    steps.iter().flat_map(|s| s.shows.iter().copied()).collect()
}

/// A capture run: launch, drive, photograph, shut down.
pub struct CaptureConfig {
    /// The GUI binary to run. Must be a build with an embedded frontend
    /// (`tauri build --no-bundle`) — a bare `cargo build` release binary
    /// points at the dev server and comes up blank.
    pub gui_binary: PathBuf,
    /// Project to open (absolute; the child's working directory is not
    /// the repo root).
    pub project: PathBuf,
    /// The scenario to walk — one of [`SCENARIOS`].
    pub steps: &'static [Step],
    /// A capture file to seed into [`Self::app_data_dir`]'s recents, so
    /// a scenario that needs data can open one without a native file
    /// dialog (which a page cannot reach). Absolute: the recents list is
    /// paths, and the child's working directory is not the repo root.
    ///
    /// `None` for a scenario that photographs the idle app.
    pub capture: Option<PathBuf>,
    /// Directory the PNGs are written to (created if absent).
    pub out_dir: PathBuf,
    /// Prefix on every file name, e.g. `dark-baseline-`.
    pub prefix: String,
    /// `DevTools` port to open on the child's `WebView2`.
    pub port: u16,
    /// Emulated viewport.
    pub width: u32,
    pub height: u32,
    /// How long to wait for the splash overlay to drop (it has a 5 s
    /// floor and stays until the boot project-open concludes).
    pub boot_timeout: Duration,
    /// Directory this run's whole **user scope** is redirected into —
    /// trust store, recents, settings, window geometry — via the app's
    /// `--app-data-dir` flag.
    ///
    /// A capture must not run against the operator's own state, for two
    /// separate reasons. It would **write** it: window geometry alone
    /// means running a capture moves the operator's window next time
    /// they open the app. And it would **read** it: every user-scope
    /// setting is an input to what gets photographed, so two runs on two
    /// machines are two different pictures, and the theme — the one the
    /// capture is *for* — is a user-scope setting, so a capture that
    /// does not own the profile cannot choose it.
    pub app_data_dir: PathBuf,
    /// Theme to photograph in — one of the frontend's `ThemeName`
    /// spellings (`dark`, `light`, `lighthk`). Seeded into
    /// [`Self::app_data_dir`]'s settings before the app is launched,
    /// because that is where the app reads it from; there is no flag for
    /// it and there should not be one, since the shipping app's theme is
    /// a user setting and the harness's job is to measure the shipping
    /// app.
    pub theme: String,
}

/// The settings document the app reads its user scope from, seeded into
/// a capture's own app-data directory.
const SETTINGS_FILE: &str = "settings.json";

/// The recorded-as-it-works document beside it (ADR 0034), which is
/// where the recent-captures list lives.
const STATE_FILE: &str = "state.json";

/// The user-scope settings a capture run seeds before launching, as the
/// JSON the app will read.
///
/// Only the keys the capture needs to control are written. The file is
/// otherwise absent, so every other setting comes up at its default —
/// which is the point: a capture is a picture of the shipping defaults
/// plus the one thing it is varying.
#[must_use]
pub fn seed_settings_json(theme: &str) -> String {
    format!("{{\n  \"theme\": {}\n}}\n", json!(theme))
}

/// The recorded state a capture run seeds: the one capture the scenario
/// is to open, as the app's recent-captures list.
///
/// This is what makes a data-carrying scenario drivable at all. Import
/// goes through a **native** file dialog, which lives outside the page
/// and so outside everything the capture can reach; the toolbar's
/// Recent menu calls the same import with a path instead. The list is a
/// persisted-state key, so putting the fixture in it is putting the
/// fixture one click away — the same click a user makes.
#[must_use]
pub fn seed_state_json(capture: &Path) -> String {
    format!(
        "{{\n  \"recent_blfs\": [{}]\n}}\n",
        json!(capture.to_string_lossy())
    )
}

/// Write [`seed_settings_json`] — and, when the scenario needs a capture
/// to open, [`seed_state_json`] — into `dir`, creating it.
///
/// # Errors
/// Returns a message if the directory or either file can't be written.
pub fn seed_app_data(dir: &Path, theme: &str, capture: Option<&Path>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let path = dir.join(SETTINGS_FILE);
    std::fs::write(&path, seed_settings_json(theme))
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    if let Some(capture) = capture {
        let path = dir.join(STATE_FILE);
        std::fs::write(&path, seed_state_json(capture))
            .map_err(|e| format!("writing {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Result of one capture run.
pub struct CaptureOutcome {
    pub files: Vec<PathBuf>,
}

/// Launch the GUI, walk [`SCENARIO`], and write one PNG per step.
///
/// # Errors
/// Returns a message if the app fails to launch, the debugging port never
/// answers, a scenario script throws, or a PNG can't be written.
pub fn run_capture(cfg: &CaptureConfig) -> Result<CaptureOutcome, String> {
    std::fs::create_dir_all(&cfg.out_dir)
        .map_err(|e| format!("creating {}: {e}", cfg.out_dir.display()))?;
    let mut child = spawn_gui(cfg)?;
    let result = capture_with(cfg);
    kill_tree(&mut child);
    result
}

fn capture_with(cfg: &CaptureConfig) -> Result<CaptureOutcome, String> {
    let mut cdp = Cdp::attach(cfg.port, Duration::from_mins(1))?;
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        &json!({
            "width": cfg.width, "height": cfg.height,
            "deviceScaleFactor": 1, "mobile": false,
        }),
    )?;
    cdp.call(
        "Emulation.setEmulatedMedia",
        &json!({ "features": [{ "name": "prefers-reduced-motion", "value": "reduce" }] }),
    )?;
    // Ready means *the app* is up, not merely that the webview answers:
    // the debugging port opens before the page navigates, so an
    // "is the splash gone" test alone passes on the blank pre-navigation
    // document — and everything injected into it is wiped by the load
    // that follows. Require the toolbar (React has mounted) and the
    // absence of the splash (which is unmounted, not hidden, when boot
    // settles).
    cdp.wait_for(
        "document.readyState === 'complete' \
         && !!document.querySelector('.toolbar') \
         && !document.querySelector('[data-testid=\"splash-overlay\"]')",
        cfg.boot_timeout,
    )?;

    let mut files = Vec::new();
    let mut shots: Vec<(&str, Vec<u8>)> = Vec::new();
    for step in cfg.steps {
        cdp.eval(PRELUDE_JS)?;
        cdp.eval(step.script)
            .map_err(|e| format!("step {}: {e}", step.name))?;
        cdp.eval(&format!(
            "(() => {{ let s = document.getElementById('__shot_mask'); \
               if (!s) {{ s = document.createElement('style'); s.id = '__shot_mask'; \
               document.head.appendChild(s); }} s.textContent = {}; }})()",
            serde_json::to_string(MASK_CSS).unwrap_or_default()
        ))?;
        // Dockview's own tab-strip styling fades on a transition that
        // `prefers-reduced-motion` doesn't gate (it isn't our stylesheet),
        // and the shutter caught it mid-fade — a ≤3-per-channel ghost on
        // the step that adds a panel. Wait it out rather than mask it.
        cdp.eval(
            "(async () => { await window.__shot.sleep(1200); \
             await window.__shot.settle(); })()",
        )?;
        let png = cdp.screenshot()?;
        let path = cfg.out_dir.join(format!("{}{}.png", cfg.prefix, step.name));
        std::fs::write(&path, &png).map_err(|e| format!("writing {}: {e}", path.display()))?;
        println!("captured {}", path.display());
        files.push(path);
        shots.push((step.name, png));
    }
    // Every step changes what is on screen, so two identical captures
    // mean a driving script did nothing — the failure mode that hid a
    // no-op tab click behind nine plausible-looking PNGs.
    if let Some(dup) = first_duplicate(&shots) {
        return Err(dup);
    }
    Ok(CaptureOutcome { files })
}

/// Report the first pair of byte-identical captures, if any.
fn first_duplicate(shots: &[(&str, Vec<u8>)]) -> Option<String> {
    for (i, (name, bytes)) in shots.iter().enumerate() {
        for (other, other_bytes) in &shots[i + 1..] {
            if bytes == other_bytes {
                return Some(format!(
                    "steps {name} and {other} captured identical pixels — \
                     the driving script for {other} changed nothing"
                ));
            }
        }
    }
    None
}

/// The command line a capture launches the app with. Split out from
/// [`spawn_gui`] so the isolation is testable without running a GUI.
#[must_use]
pub fn gui_args(cfg: &CaptureConfig) -> Vec<String> {
    vec![
        "--project".to_string(),
        cfg.project.to_string_lossy().into_owned(),
        "--app-data-dir".to_string(),
        cfg.app_data_dir.to_string_lossy().into_owned(),
    ]
}

/// The environment a capture launches the app with. Split out from
/// [`spawn_gui`] for the same reason [`gui_args`] is: the isolation is
/// the thing under test, and it is testable without running a GUI.
///
/// Both variables are `WebView2`'s own, read by the runtime before the
/// app sees anything — so there is no automation surface in the shipping
/// binary, which is the whole premise of this module.
///
/// - **`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`** opens the debugging
///   port the capture talks CDP over.
/// - **`WEBVIEW2_USER_DATA_FOLDER`** gives the run its own browser
///   profile. This is not tidiness: `WebView2` keys its *browser
///   process* by user data folder, and the app's default folder is a
///   fixed path under the operator's local app data. With the
///   operator's own copy of the app open, a capture launched into that
///   folder is served by the browser process **already running** —
///   which was started without the port, so the argument above is never
///   applied and the attach fails with a bare connection refusal. The
///   app profile was given its own directory for the same reason a
///   layer up: a capture must be a picture of the app, not of what else
///   is running.
#[must_use]
pub fn gui_env(cfg: &CaptureConfig) -> Vec<(String, String)> {
    vec![
        (
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS".to_string(),
            format!("--remote-debugging-port={}", cfg.port),
        ),
        (
            "WEBVIEW2_USER_DATA_FOLDER".to_string(),
            cfg.app_data_dir
                .join("webview2")
                .to_string_lossy()
                .into_owned(),
        ),
    ]
}

fn spawn_gui(cfg: &CaptureConfig) -> Result<Child, String> {
    // Seed the profile *before* the launch: the theme is a user-scope
    // setting read at boot, and the recents list is read when the
    // toolbar first renders, so writing either afterwards would
    // photograph the previous run's.
    seed_app_data(&cfg.app_data_dir, &cfg.theme, cfg.capture.as_deref())?;
    Command::new(&cfg.gui_binary)
        .args(gui_args(cfg))
        .envs(gui_env(cfg))
        .spawn()
        .map_err(|e| format!("launching {}: {e}", cfg.gui_binary.display()))
}

/// Kill the child *and its descendants* — the `WebView2` browser and GPU
/// processes are children of the host, and a leaked one holds the
/// debugging port against the next run.
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    #[cfg(not(windows))]
    let _ = pid;
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------

/// A `DevTools` target as listed by `/json/list`.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub kind: String,
    pub url: String,
    pub ws_url: String,
}

/// Parse `/json/list` output into targets.
///
/// # Errors
/// Returns a message if the payload isn't the expected `JSON` array.
pub fn parse_targets(body: &str) -> Result<Vec<Target>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("parsing /json/list: {e}"))?;
    let arr = v.as_array().ok_or("/json/list was not an array")?;
    Ok(arr
        .iter()
        .filter_map(|t| {
            Some(Target {
                kind: t.get("type")?.as_str()?.to_string(),
                url: t.get("url")?.as_str().unwrap_or_default().to_string(),
                ws_url: t.get("webSocketDebuggerUrl")?.as_str()?.to_string(),
            })
        })
        .collect())
}

/// Pick the app's page target: the first `page` target that isn't the
/// devtools frontend itself.
#[must_use]
pub fn pick_page_target(targets: &[Target]) -> Option<&Target> {
    targets
        .iter()
        .find(|t| t.kind == "page" && !t.url.starts_with("devtools://"))
}

struct Cdp {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Cdp {
    /// Poll the debugging port until the app's page target appears, then
    /// open the CDP websocket to it.
    fn attach(port: u16, timeout: Duration) -> Result<Self, String> {
        let deadline = Instant::now() + timeout;
        let mut last;
        loop {
            match list_targets(port).and_then(|ts| {
                pick_page_target(&ts)
                    .map(|t| t.ws_url.clone())
                    .ok_or_else(|| "no page target yet".to_string())
            }) {
                Ok(ws_url) => {
                    let (ws, _) = tungstenite::connect(&ws_url)
                        .map_err(|e| format!("connecting to {ws_url}: {e}"))?;
                    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
                        let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
                    }
                    return Ok(Self { ws, next_id: 1 });
                }
                Err(e) => {
                    last = e;
                    if Instant::now() >= deadline {
                        return Err(format!("attaching to the webview: {last}"));
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }

    /// Issue a CDP command and return its `result`, skipping the event
    /// traffic that arrives interleaved on the same socket.
    fn call(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "id": id, "method": method, "params": params });
        self.ws
            .send(Message::Text(req.to_string().into()))
            .map_err(|e| format!("sending {method}: {e}"))?;
        loop {
            let msg = self
                .ws
                .read()
                .map_err(|e| format!("reading the reply to {method}: {e}"))?;
            let Message::Text(text) = msg else { continue };
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("parsing the reply to {method}: {e}"))?;
            match reply_for(&v, id) {
                Some(Ok(result)) => return Ok(result),
                Some(Err(e)) => return Err(format!("{method}: {e}")),
                None => {}
            }
        }
    }

    /// Evaluate JS in the page, awaiting a returned promise. A thrown
    /// exception becomes an `Err`.
    fn eval(&mut self, js: &str) -> Result<Value, String> {
        let res = self.call(
            "Runtime.evaluate",
            &json!({
                "expression": js,
                "awaitPromise": true,
                "returnByValue": true,
                "userGesture": true,
            }),
        )?;
        if let Some(details) = res.get("exceptionDetails") {
            return Err(format!("page threw: {}", exception_text(details)));
        }
        Ok(res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Poll a JS predicate until it is true.
    fn wait_for(&mut self, predicate: &str, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.eval(predicate)? == Value::Bool(true) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("timed out waiting for `{predicate}`"));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// Photograph the emulated viewport.
    fn screenshot(&mut self) -> Result<Vec<u8>, String> {
        let res = self.call(
            "Page.captureScreenshot",
            &json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false }),
        )?;
        let b64 = res
            .get("data")
            .and_then(Value::as_str)
            .ok_or("Page.captureScreenshot returned no data")?;
        decode_base64(b64)
    }
}

/// Classify one inbound CDP frame against the id we're waiting on:
/// `None` = someone else's traffic (an event, or another command's
/// reply); `Some(Ok(result))` / `Some(Err(message))` = our answer.
fn reply_for(v: &Value, id: u64) -> Option<Result<Value, String>> {
    if v.get("id").and_then(Value::as_u64) != Some(id) {
        return None;
    }
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Some(Err(msg.to_string()));
    }
    Some(Ok(v.get("result").cloned().unwrap_or(Value::Null)))
}

/// Flatten an `exceptionDetails` payload to one line.
fn exception_text(details: &Value) -> String {
    details
        .get("exception")
        .and_then(|e| e.get("description"))
        .and_then(Value::as_str)
        .or_else(|| details.get("text").and_then(Value::as_str))
        .unwrap_or("unknown exception")
        .lines()
        .next()
        .unwrap_or("unknown exception")
        .to_string()
}

fn list_targets(port: u16) -> Result<Vec<Target>, String> {
    let url = format!("http://127.0.0.1:{port}/json/list");
    let mut res = ureq::get(&url).call().map_err(|e| format!("{url}: {e}"))?;
    let mut body = String::new();
    res.body_mut()
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|e| format!("reading {url}: {e}"))?;
    parse_targets(&body)
}

/// Decode standard base64 (the encoding CDP returns image data in).
///
/// # Errors
/// Returns a message if the payload isn't valid base64.
fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("decoding the screenshot payload: {e}"))
}

// ---------------------------------------------------------------------
// Pixel diff
// ---------------------------------------------------------------------

/// A decoded RGBA8 image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, RGBA.
    pub rgba: Vec<u8>,
}

/// Decode a PNG into RGBA8.
///
/// # Errors
/// Returns a message if the bytes aren't a PNG this decoder handles.
pub fn decode_png(bytes: &[u8]) -> Result<Image, String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("reading PNG header: {e}"))?;
    let mut buf = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("decoding PNG: {e}"))?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()]
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        other => return Err(format!("unsupported PNG color type {other:?}")),
    };
    Ok(Image {
        width: info.width,
        height: info.height,
        rgba,
    })
}

/// Encode RGBA8 as a PNG.
///
/// # Errors
/// Returns a message if encoding fails.
pub fn encode_png(img: &Image) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width, img.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc
            .write_header()
            .map_err(|e| format!("writing PNG header: {e}"))?;
        writer
            .write_image_data(&img.rgba)
            .map_err(|e| format!("writing PNG data: {e}"))?;
    }
    Ok(out)
}

/// The verdict of one image comparison.
#[derive(Debug, Clone, PartialEq)]
pub struct DiffOutcome {
    pub width: u32,
    pub height: u32,
    /// Pixels whose RGBA differs at all.
    pub differing: u64,
    pub total: u64,
    /// Largest per-channel difference seen (0 when identical).
    pub max_channel_delta: u8,
    /// Visual artifact: the `after` image dimmed to grey, with every
    /// differing pixel painted magenta.
    pub artifact: Image,
}

impl DiffOutcome {
    /// Differing pixels as a percentage of the frame.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn percent(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.differing as f64 * 100.0 / self.total as f64
        }
    }
}

/// Compare two images pixel for pixel.
///
/// # Errors
/// Returns a message if the two images differ in size — a geometry
/// change is a comparison failure, not a pixel count.
pub fn diff_images(before: &Image, after: &Image) -> Result<DiffOutcome, String> {
    if before.width != after.width || before.height != after.height {
        return Err(format!(
            "size mismatch: {}x{} vs {}x{}",
            before.width, before.height, after.width, after.height
        ));
    }
    let mut artifact = Vec::with_capacity(after.rgba.len());
    let mut differing = 0u64;
    let mut max_delta = 0u8;
    for (b, a) in before.rgba.chunks_exact(4).zip(after.rgba.chunks_exact(4)) {
        if b == a {
            // Dim the unchanged background so the marks stand out.
            let grey = u8::try_from((u32::from(a[0]) + u32::from(a[1]) + u32::from(a[2])) / 6)
                .unwrap_or(u8::MAX);
            artifact.extend_from_slice(&[grey, grey, grey, 255]);
        } else {
            differing += 1;
            for i in 0..4 {
                max_delta = max_delta.max(a[i].abs_diff(b[i]));
            }
            artifact.extend_from_slice(&[255, 0, 255, 255]);
        }
    }
    Ok(DiffOutcome {
        width: after.width,
        height: after.height,
        differing,
        total: u64::from(after.width) * u64::from(after.height),
        max_channel_delta: max_delta,
        artifact: Image {
            width: after.width,
            height: after.height,
            rgba: artifact,
        },
    })
}

/// Diff two PNG files and write the visual artifact beside them.
///
/// # Errors
/// Returns a message if either file can't be read/decoded, the sizes
/// differ, or the artifact can't be written.
pub fn diff_files(before: &Path, after: &Path, artifact_out: &Path) -> Result<DiffOutcome, String> {
    let b = decode_png(&std::fs::read(before).map_err(|e| format!("{}: {e}", before.display()))?)?;
    let a = decode_png(&std::fs::read(after).map_err(|e| format!("{}: {e}", after.display()))?)?;
    let outcome = diff_images(&b, &a)?;
    std::fs::write(artifact_out, encode_png(&outcome.artifact)?)
        .map_err(|e| format!("writing {}: {e}", artifact_out.display()))?;
    Ok(outcome)
}

/// Pair up two capture sets by their step name — the file stem with the
/// set's prefix removed. Every capture must have a partner: a missing one
/// means the two runs didn't walk the same scenario, which invalidates
/// the comparison rather than shrinking it.
///
/// # Errors
/// Returns a message naming the unmatched steps.
pub fn pair_names(
    before: &[String],
    after: &[String],
    before_prefix: &str,
    after_prefix: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let strip = |n: &String, p: &str| n.strip_prefix(p).unwrap_or(n).to_string();
    let mut pairs = Vec::new();
    let mut unmatched = Vec::new();
    for b in before {
        let step = strip(b, before_prefix);
        match after.iter().find(|a| strip(a, after_prefix) == step) {
            Some(a) => pairs.push((b.clone(), a.clone(), step)),
            None => unmatched.push(format!("before/{b}")),
        }
    }
    for a in after {
        let step = strip(a, after_prefix);
        if !before.iter().any(|b| strip(b, before_prefix) == step) {
            unmatched.push(format!("after/{a}"));
        }
    }
    if unmatched.is_empty() {
        pairs.sort();
        Ok(pairs)
    } else {
        Err(format!(
            "captures without a partner: {}",
            unmatched.join(", ")
        ))
    }
}

/// List the `.png` file names in a directory, sorted.
///
/// # Errors
/// Returns a message if the directory can't be read.
pub fn png_names(dir: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_ascii_lowercase().ends_with(".png"))
        .collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: u32, h: u32, fill: [u8; 4]) -> Image {
        Image {
            width: w,
            height: h,
            rgba: fill
                .iter()
                .copied()
                .cycle()
                .take((w * h * 4) as usize)
                .collect(),
        }
    }

    #[test]
    fn scenario_covers_every_panel() {
        let covered = scenario_coverage(SCENARIO);
        let missing: Vec<_> = ALL_PANEL_COMPONENTS
            .iter()
            .filter(|c| !covered.contains(*c))
            .collect();
        assert!(missing.is_empty(), "panels never photographed: {missing:?}");
    }

    /// Every `'label'` any scenario passes to one of the `__shot`
    /// helpers, e.g. `scenario_labels("command")`.
    fn scenario_labels(helper: &str) -> Vec<String> {
        let needle = format!("window.__shot.{helper}('");
        let mut out = Vec::new();
        for step in SCENARIOS.iter().flat_map(|(_, steps)| steps.iter()) {
            let mut rest = step.script;
            while let Some(i) = rest.find(&needle) {
                rest = &rest[i + needle.len()..];
                let end = rest
                    .find('\'')
                    .expect("unterminated label in a scenario step");
                out.push(rest[..end].to_string());
                rest = &rest[end..];
            }
        }
        out
    }

    /// A scenario drives the app by the labels the app renders, and
    /// those labels live in the frontend — so a rename there silently
    /// turns a step into a run-aborting "no such button" (it did: the
    /// Database panel was called "DBC" when this scenario was written).
    /// Nothing else in the build ties the two together, so the check is
    /// this: every label any scenario clicks must exist in the source
    /// that defines it.
    ///
    /// Two spellings, because the frontend has two. A command or toolbar
    /// label is *declared* (`label: "…"`); a modal's button carries its
    /// text as JSX, where the only stable thing to match is the label on
    /// a line of its own.
    #[test]
    fn the_scenarios_drive_labels_the_frontend_still_defines() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let read = |rel: &str| {
            std::fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("reading {rel}: {e}"))
        };
        let commands = read("apps/gui/src/commands.ts");
        let app = read("apps/gui/src/App.tsx");
        let blf_modal = read("apps/gui/src/BlfChannelMapModal.tsx");
        let declared = |src: &str, label: &str| src.contains(&format!("label: \"{label}\""));
        let jsx_text = |src: &str, label: &str| src.lines().any(|l| l.trim() == label);
        for (helper, source, file, matches) in [
            (
                "command",
                &commands,
                "commands.ts",
                &declared as &dyn Fn(&str, &str) -> bool,
            ),
            ("toolbar", &app, "App.tsx", &declared),
            (
                "modal",
                &blf_modal,
                "BlfChannelMapModal.tsx",
                &jsx_text as &dyn Fn(&str, &str) -> bool,
            ),
        ] {
            let labels = scenario_labels(helper);
            assert!(!labels.is_empty(), "no {helper} labels found to check");
            for label in labels {
                assert!(
                    matches(source, &label),
                    "a scenario clicks {label:?}, which {file} no longer defines",
                );
            }
        }
    }

    /// A scenario that opens a capture needs one seeded into the profile
    /// it runs against, because import goes through a native file
    /// dialog the page cannot reach. The recents list is the way in, and
    /// it is a persisted-state key rather than a settings one — so the
    /// two documents are separate, and a capture-less scenario leaves
    /// the state file absent entirely.
    #[test]
    fn a_capture_scenario_seeds_the_recents_the_import_is_driven_from() {
        let dir = tempfile::TempDir::new().unwrap();
        let c = cfg(dir.path(), "dark");
        let blf = Path::new("/captures/extrapolation.blf");

        seed_app_data(&c.app_data_dir, &c.theme, Some(blf)).unwrap();
        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(c.app_data_dir.join(STATE_FILE)).expect("state written"),
        )
        .expect("valid JSON");
        assert_eq!(
            v.get("recent_blfs").and_then(Value::as_array),
            Some(&vec![json!(blf.to_string_lossy())]),
        );
        // The theme still comes from the settings document beside it.
        assert!(c.app_data_dir.join(SETTINGS_FILE).exists());

        let idle = tempfile::TempDir::new().unwrap();
        let c = cfg(idle.path(), "dark");
        seed_app_data(&c.app_data_dir, &c.theme, None).unwrap();
        assert!(
            !c.app_data_dir.join(STATE_FILE).exists(),
            "a scenario that photographs the idle app must not be given a capture to open",
        );
    }

    /// A path with a backslash in every separator is the normal case on
    /// the only platform this harness runs on, and pasting one into JSON
    /// unescaped produces either a broken document or a different path.
    #[test]
    fn a_seeded_capture_path_is_json_escaped_rather_than_pasted() {
        let v: Value =
            serde_json::from_str(&seed_state_json(Path::new(r"C:\c\x.blf"))).expect("valid JSON");
        assert_eq!(
            v.get("recent_blfs")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str),
            Some(r"C:\c\x.blf"),
        );
    }

    /// Every scenario is reachable by the name the CLI takes, and an
    /// unknown one says what the alternatives are rather than silently
    /// walking the default.
    #[test]
    fn scenarios_are_selected_by_name() {
        assert_eq!(scenario_by_name("panels").unwrap().len(), SCENARIO.len());
        assert_eq!(
            scenario_by_name("extrapolation").unwrap().len(),
            EXTRAPOLATION_SCENARIO.len()
        );
        let e = scenario_by_name("nope").err().expect("unknown");
        assert!(e.contains("panels") && e.contains("extrapolation"), "{e}");
    }

    #[test]
    fn a_step_that_changed_nothing_is_caught() {
        let shots = vec![
            ("01", vec![1u8, 2, 3]),
            ("02", vec![9u8]),
            ("03", vec![1u8, 2, 3]),
        ];
        let dup = first_duplicate(&shots).expect("01 and 03 are identical");
        assert!(dup.contains("01") && dup.contains("03"), "{dup}");
        assert!(first_duplicate(&shots[..2]).is_none());
    }

    #[test]
    fn identical_images_diff_to_zero() {
        let a = img(4, 3, [10, 20, 30, 255]);
        let d = diff_images(&a, &a).expect("same size");
        assert_eq!(d.differing, 0);
        assert_eq!(d.total, 12);
        assert_eq!(d.max_channel_delta, 0);
        assert!((d.percent() - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn one_changed_pixel_is_counted_and_marked() {
        let before = img(2, 1, [0, 0, 0, 255]);
        let mut after = before.clone();
        after.rgba[4] = 9; // second pixel's red channel
        let d = diff_images(&before, &after).expect("same size");
        assert_eq!(d.differing, 1);
        assert_eq!(d.total, 2);
        assert_eq!(d.max_channel_delta, 9);
        assert!((d.percent() - 50.0).abs() < 1e-9);
        // First pixel dimmed grey, second painted magenta.
        assert_eq!(&d.artifact.rgba[0..4], &[0, 0, 0, 255]);
        assert_eq!(&d.artifact.rgba[4..8], &[255, 0, 255, 255]);
    }

    #[test]
    fn a_size_change_is_a_failure_not_a_pixel_count() {
        let e = diff_images(&img(2, 2, [0; 4]), &img(2, 3, [0; 4])).expect_err("sizes differ");
        assert!(e.contains("size mismatch"), "{e}");
    }

    #[test]
    fn png_roundtrips_through_encode_decode() {
        let mut src = img(3, 2, [1, 2, 3, 255]);
        src.rgba[8] = 200;
        let bytes = encode_png(&src).expect("encodes");
        let back = decode_png(&bytes).expect("decodes");
        assert_eq!(back, src);
    }

    #[test]
    fn targets_are_parsed_and_the_page_is_picked() {
        let body = r#"[
          {"type":"other","url":"about:blank","webSocketDebuggerUrl":"ws://x/other"},
          {"type":"page","url":"http://tauri.localhost/","webSocketDebuggerUrl":"ws://x/page"}
        ]"#;
        let ts = parse_targets(body).expect("parses");
        assert_eq!(ts.len(), 2);
        let page = pick_page_target(&ts).expect("a page target");
        assert_eq!(page.ws_url, "ws://x/page");
    }

    #[test]
    fn devtools_frontend_is_not_mistaken_for_the_app() {
        let body = r#"[
          {"type":"page","url":"devtools://devtools/bundled/x.html","webSocketDebuggerUrl":"ws://x/dt"},
          {"type":"page","url":"http://tauri.localhost/","webSocketDebuggerUrl":"ws://x/app"}
        ]"#;
        let ts = parse_targets(body).expect("parses");
        assert_eq!(
            pick_page_target(&ts).expect("app page").ws_url,
            "ws://x/app"
        );
    }

    #[test]
    fn replies_are_matched_by_id_and_events_ignored() {
        let event = json!({ "method": "Page.frameNavigated", "params": {} });
        assert!(reply_for(&event, 7).is_none());
        let other = json!({ "id": 6, "result": { "x": 1 } });
        assert!(reply_for(&other, 7).is_none());
        let ours = json!({ "id": 7, "result": { "data": "abc" } });
        assert_eq!(reply_for(&ours, 7), Some(Ok(json!({ "data": "abc" }))));
        let failed = json!({ "id": 7, "error": { "message": "nope" } });
        assert_eq!(reply_for(&failed, 7), Some(Err("nope".to_string())));
    }

    #[test]
    fn exception_details_reduce_to_one_line() {
        let d = json!({ "exception": { "description": "Error: boom\n    at <anonymous>" } });
        assert_eq!(exception_text(&d), "Error: boom");
    }

    #[test]
    fn base64_decodes_to_bytes() {
        assert_eq!(decode_base64("aGk=").expect("valid"), b"hi".to_vec());
        assert!(decode_base64("!!!").is_err());
    }

    #[test]
    fn capture_sets_pair_by_step_across_different_prefixes() {
        let before = vec!["dark-01-a.png".to_string(), "dark-02-b.png".to_string()];
        let after = vec!["tok-02-b.png".to_string(), "tok-01-a.png".to_string()];
        let pairs = pair_names(&before, &after, "dark-", "tok-").expect("all matched");
        assert_eq!(
            pairs,
            vec![
                (
                    "dark-01-a.png".to_string(),
                    "tok-01-a.png".to_string(),
                    "01-a.png".to_string()
                ),
                (
                    "dark-02-b.png".to_string(),
                    "tok-02-b.png".to_string(),
                    "02-b.png".to_string()
                ),
            ]
        );
    }

    #[test]
    fn a_missing_capture_fails_the_comparison() {
        let e = pair_names(
            &["a.png".to_string(), "b.png".to_string()],
            &["a.png".to_string(), "c.png".to_string()],
            "",
            "",
        )
        .expect_err("b and c are unpartnered");
        assert!(e.contains("before/b.png"), "{e}");
        assert!(e.contains("after/c.png"), "{e}");
    }

    #[test]
    fn the_mask_hides_rather_than_paints() {
        // The mask must not introduce a color into a color comparison.
        assert!(!MASK_CSS.contains('#'), "mask must not set a color");
        assert!(MASK_CSS.contains("visibility: hidden"));
    }

    fn cfg(dir: &Path, theme: &str) -> CaptureConfig {
        CaptureConfig {
            gui_binary: PathBuf::from("cannet-gui"),
            project: PathBuf::from("/p/x.cannet_prj"),
            out_dir: dir.join("out"),
            prefix: String::new(),
            port: 9333,
            width: 1600,
            height: 1000,
            boot_timeout: Duration::from_secs(90),
            app_data_dir: dir.join("profile"),
            theme: theme.to_string(),
            steps: SCENARIO,
            capture: None,
        }
    }

    /// A capture must not run against the operator's own user scope.
    /// Writing it would move their window next time they open the app;
    /// reading it would make the picture depend on their settings, and
    /// the theme a capture is *for* is one of those settings.
    #[test]
    fn a_capture_launches_against_its_own_app_data_directory() {
        let dir = std::env::temp_dir().join("cannet-shot-args");
        let args = gui_args(&cfg(&dir, "dark"));
        let i = args
            .iter()
            .position(|a| a == "--app-data-dir")
            .expect("the launch must redirect the user scope");
        assert_eq!(
            args.get(i + 1).map(String::as_str),
            dir.join("profile").to_str()
        );
        assert!(args.contains(&"--project".to_string()));
    }

    /// A capture must not share the operator's **browser** profile
    /// either. `WebView2` keys its browser process by user data folder,
    /// so a run launched into the app's default folder while the
    /// operator has the app open is served by the browser process
    /// already running — which carries no debugging port, and the
    /// capture dies at the attach with a connection refusal that says
    /// nothing about why.
    #[test]
    fn a_capture_launches_against_its_own_webview_profile() {
        let dir = std::env::temp_dir().join("cannet-shot-env");
        let cfg = cfg(&dir, "dark");
        let env = gui_env(&cfg);
        let get = |k: &str| {
            env.iter().find(|(n, _)| n == k).map_or_else(
                || panic!("{k} must be set on the child"),
                |(_, v)| v.clone(),
            )
        };
        assert!(get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .contains(&format!("--remote-debugging-port={}", cfg.port)));
        let folder = PathBuf::from(get("WEBVIEW2_USER_DATA_FOLDER"));
        assert!(
            folder.starts_with(&cfg.app_data_dir),
            "the browser profile must live inside the run's own app-data directory, got {}",
            folder.display(),
        );
    }

    /// The theme is read from the profile's settings at boot, so it is
    /// seeded there rather than passed as a flag — the shipping app has
    /// no theme flag, and the harness photographs the shipping app.
    #[test]
    fn the_capture_theme_is_seeded_inside_the_isolated_profile() {
        let dir = tempfile::TempDir::new().unwrap();
        let c = cfg(dir.path(), "light");
        seed_app_data(&c.app_data_dir, &c.theme, None).unwrap();
        let written =
            std::fs::read_to_string(c.app_data_dir.join(SETTINGS_FILE)).expect("settings written");
        let v: Value = serde_json::from_str(&written).expect("valid JSON");
        assert_eq!(v.get("theme").and_then(Value::as_str), Some("light"));
        // Only the key the capture is varying: everything else must come
        // up at the shipping default, or the picture is of this
        // machine rather than of the app.
        assert_eq!(v.as_object().map(serde_json::Map::len), Some(1));
    }

    #[test]
    fn a_seeded_theme_is_json_escaped_rather_than_pasted() {
        let v: Value = serde_json::from_str(&seed_settings_json("da\"rk")).expect("valid JSON");
        assert_eq!(v.get("theme").and_then(Value::as_str), Some("da\"rk"));
    }
}
