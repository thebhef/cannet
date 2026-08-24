//! User settings, persisted host-side (ADR 0034), across two scopes
//! (ADR 0042).
//!
//! Choices the user deliberately sets — as opposed to the machine state
//! the app records as it works ([`crate::state`]) — live in
//! `settings.json`, read and written through the [`get_settings`] /
//! [`set_settings`] commands. The file is a durable, hand-editable
//! contract (ADR 0034): every field is written explicitly (no
//! skip-when-default) so opening `settings.json` shows the full set of
//! knobs and their current values, VS Code-style. The GUI's settings
//! panel is sugar over it, not the only way to edit it.
//!
//! **Two scopes, one filename.** The *user* copy is in Tauri's
//! `app_config_dir` and follows the person; the *workspace* copy is
//! `.cannet/settings.json` inside the open project directory and holds
//! that project's overrides. A read resolves the two — a workspace value
//! wins for the key it declares, and every other key keeps the user's
//! value. The path carries the scope, not the filename.
//!
//! **Writes are routed by the same metadata.** [`SCOPES`] declares every
//! key's scope, and a write goes to the file that scope names — so
//! echoing the resolved settings back (which is all the frontend ever
//! does) updates an existing override in place instead of promoting it
//! into the user's own file. A project that overrides nothing never has
//! its `.cannet/settings.json` written at all.
//!
//! A missing file or missing key resolves to the documented default, so a
//! fresh install and a hand-deleted file behave identically.
//!
//! **One bad value costs one field.** A key whose value the struct
//! refuses — a string where a number belongs — is dropped and reported
//! at the read boundary and resolves to its own default; the rest of the
//! user's file survives. A hand-editable contract cannot afford a typo
//! that silently reverts everything
//! ([`crate::persisted_json::resolve_scoped`]).

use std::path::Path;
use std::sync::{Arc, OnceLock, PoisonError, RwLock};

use serde::{Deserialize, Serialize};

use crate::persisted_json::{Scope, ScopeTable};

/// File name under `app_config_dir`.
const SETTINGS_FILE: &str = "settings.json";

/// The scope of every key [`Settings`] persists (ADR 0042 §3) — what
/// routes a write to the user file or to the project's `.cannet/`.
///
/// Settings that govern the app's behaviour are **overridable**: the
/// value is a preference that follows the person, and the workspace copy
/// of the file exists to hold this project's exceptions to it. Which of
/// them are better modelled as project-scoped outright —
/// `scratch_cap_bytes` and `clear_scratch_on_exit` both govern a
/// per-project resource — is settled with the rest of the settings
/// promotion work, not here.
///
/// The exceptions are the settings about *the person at the keyboard*
/// rather than about the work: what the settings view reveals
/// (`show_developer_settings`), how verbose their log view is
/// (`system_log_min_level`), how long a status notice dwells before it
/// clears (`notice_dwell_ms`, a reading-speed accommodation), and
/// whether launching resumes the last project (`reopen_last_project`,
/// which is read before any project — and therefore any workspace file
/// — has been resolved at all). None of those are a project's
/// business, so they stay at user scope.
///
/// The names are the serialized ones. `every_settings_key_declares_a_scope`
/// is what keeps this table from drifting away from the struct.
pub(crate) const SCOPES: ScopeTable = &[
    ("scratch_cap_bytes", Scope::UserOverridable),
    ("pyramid_retention_bytes", Scope::UserOverridable),
    ("clear_scratch_on_exit", Scope::UserOverridable),
    ("autosave_on_exit", Scope::UserOverridable),
    ("keybindings", Scope::UserOverridable),
    ("show_developer_settings", Scope::User),
    ("system_log_min_level", Scope::User),
    ("notice_dwell_ms", Scope::User),
    ("reopen_last_project", Scope::User),
    ("theme", Scope::User),
    ("plot_fetch_interval_ms", Scope::UserOverridable),
    ("view_refresh_interval_ms", Scope::UserOverridable),
    ("follow_window_ms", Scope::UserOverridable),
    ("recent_blfs_limit", Scope::UserOverridable),
    ("recent_commands_limit", Scope::UserOverridable),
    ("recent_projects_limit", Scope::UserOverridable),
    ("solo_page_size", Scope::UserOverridable),
    ("live_update_interval_ms", Scope::UserOverridable),
    ("trace_flush_interval_ms", Scope::UserOverridable),
    ("log_rotation_bytes", Scope::UserOverridable),
    ("system_log_ring_capacity", Scope::UserOverridable),
    ("system_log_rate_limit", Scope::UserOverridable),
    ("health_sample_interval_ms", Scope::UserOverridable),
    ("sidecar_restart_budget", Scope::UserOverridable),
    ("reconnect_backoff_ms", Scope::UserOverridable),
    ("default_server_address", Scope::UserOverridable),
    ("sidecar_dir", Scope::UserOverridable),
    ("driver_module", Scope::UserOverridable),
    ("log_file_min_level", Scope::UserOverridable),
    ("sidecar_log_level", Scope::UserOverridable),
    ("trace_mode", Scope::UserOverridable),
    ("trace_auto_scroll", Scope::UserOverridable),
    ("trace_show_events", Scope::UserOverridable),
    ("plot_y_axis_mode", Scope::UserOverridable),
    ("dbc_auto_reload", Scope::UserOverridable),
    ("can_id_format", Scope::UserOverridable),
    ("trace_columns", Scope::UserOverridable),
    ("signal_columns", Scope::UserOverridable),
    ("float_exponential_below", Scope::UserOverridable),
    ("float_exponential_from", Scope::UserOverridable),
    ("float_mantissa_decimals", Scope::UserOverridable),
];

/// The persisted user settings. `#[serde(default)]` fills any absent field
/// from [`Settings::default`], so a partial file still parses and an
/// unknown field a newer build wrote is ignored. Unlike [`crate::state`],
/// the fields are *not* skipped on serialize — the file is meant to be
/// read and hand-edited, so it always lists every setting.
// `show_developer_settings` trips `struct_field_names` by ending in the
// struct's own name. The field name *is* the `settings.json` key a user
// reads and hand-edits, so it is named for the file, not for Rust.
//
// `struct_excessive_bools` fires for the same reason and gets the same
// answer: this is not a state machine whose flags interact, it is the
// serde mirror of a hand-editable JSON document (ADR 0034) in which each
// on/off knob is independent. Folding pairs into two-variant enums would
// change what the file looks like without making any of them clearer.
//
// `derive_partial_eq_without_eq` cannot apply: the float-format
// thresholds are `f64`, and a struct carrying one is `PartialEq` and
// nothing more.
#[allow(clippy::struct_field_names, clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Maximum bytes the disk-spill scratch may grow to before the oldest
    /// history is dropped — the windowed-ring cap (ADR 0002). `None` (the
    /// default) means unbounded: the scratch grows with the capture.
    pub scratch_cap_bytes: Option<u64>,
    /// Bytes of **unreferenced** signal pyramids this project may keep on
    /// disk against their definition returning — the retention pool's
    /// bound (ADR 0047). Default
    /// [`DEFAULT_RETENTION_BYTES`](crate::signal_cache::DEFAULT_RETENTION_BYTES),
    /// 16 GiB; `0` keeps none, which is what the cache did before the
    /// pool existed.
    ///
    /// Absolute rather than a share of `scratch_cap_bytes`, because the
    /// two bound different things: the scratch cap bounds the *live*
    /// capture and its derived state, while this bounds what is kept for
    /// a session that may never come. Over the bound, the oldest park is
    /// given up first.
    pub pyramid_retention_bytes: u64,
    /// Whether to wipe the disk-spill scratch on a clean exit. Default
    /// `false`: a prior session is kept and reloads on the next launch
    /// (ADR 0002 DS-7).
    pub clear_scratch_on_exit: bool,
    /// Whether a dirty close saves silently instead of showing the
    /// unsaved-changes prompt. Default `false` — prompting stays the
    /// behaviour until a user opts in.
    ///
    /// Scoped narrower than the name alone would suggest: it fires only
    /// for a project directory the user pointed cannet at explicitly
    /// (`.cannet_prj` beside a `.cannet/`, ADR 0042 §1) that is dirty —
    /// checked at close time against [`crate::project_dir::ProjectDir::is_auto_located`].
    /// An auto-located project directory (a loose project file, or no
    /// project opened at all) is inert: the prompt behaves exactly as it
    /// does with this setting off, because there is no project file to
    /// save silently *to* without minting one the user never asked for.
    pub autosave_on_exit: bool,
    /// User keybinding customisation (ADR 0018). `None` (the default) means
    /// "use the app's built-in default bindings"; `Some(list)` is the whole
    /// effective binding set, which replaces the defaults. The host only
    /// stores and round-trips this — the frontend reads it, merges it over
    /// the defaults, and applies the result; the host never dispatches keys.
    pub keybindings: Option<Vec<Binding>>,
    /// Whether the settings view reveals the `developer`-tagged knobs
    /// ([`crate::settings_descriptor::Kind::Developer`]). Default
    /// `false`. It is an ordinary setting rather than panel chrome so
    /// that the view grows no controls of its own — and so that the
    /// toggle is itself findable by searching for it.
    pub show_developer_settings: bool,
    /// Lowest severity the System Messages panel shows — one of
    /// [`SYSTEM_LOG_LEVELS`], default `info`. It is a preference ("how
    /// verbose do I want my log view") rather than panel state, so it
    /// survives closing and reopening the panel; the panel's *source*
    /// filter is view-local and stays in its dockview params.
    pub system_log_min_level: String,
    /// Whether launching cannet resumes the project it was last working
    /// in. Default `true`, which is what launching has always done.
    ///
    /// Off, a launch starts in the auto-located project directory
    /// (ADR 0042 §1) with nothing open — there is still a project
    /// directory, because there is no no-project code path. The
    /// `last_project` pointer is left as it is, so turning this back on
    /// resumes where the pointer still says.
    ///
    /// Read at startup from the **user scope only** ([`user_scope`]):
    /// the workspace scope lives inside the directory this decides, so
    /// it cannot take part in deciding it. That it is not a project's
    /// business either is what makes the restriction cost nothing.
    pub reopen_last_project: bool,
    /// Which color theme the app renders in — one of [`THEMES`], default
    /// `dark`, which is the only look the app had before this existed.
    ///
    /// The frontend owns what a theme *is* (a set of CSS custom
    /// properties plus the JS color source that paints the canvas); the
    /// host only stores which one is chosen. Applied live, so changing
    /// it needs no restart.
    ///
    /// A setting about the person at the keyboard rather than about the
    /// work, so it is user-scoped: a project does not get to decide what
    /// its reader's screen looks like. Manual only — there is no
    /// "follow the OS" value, because the per-platform webview media
    /// query is a separate question from having a second theme at all.
    pub theme: String,
    /// How long a transient status notice stays frozen in the header
    /// before the bar reverts to the resting residency line. Default
    /// 3000 ms. Nothing is lost by shortening or lengthening it —
    /// notices are mirrored to the system log — so it is purely a
    /// reading-speed accommodation.
    pub notice_dwell_ms: u64,
    /// How often an open plot asks the host for a resampled window
    /// while a capture runs. Default 67 ms (~15 Hz). Redraw stays
    /// pinned to rAF; this governs only the fetch, which is where the
    /// host-side cost is (ADR 0025).
    pub plot_fetch_interval_ms: u64,
    /// How often a paged view re-reads the tail while a capture runs —
    /// the chronological and filtered traces, by-id, signals, and the
    /// transmit/RBS host mirrors. Default 250 ms. It bounds both the
    /// UI-thread parse cost and the host-side window scans under a
    /// high-rate stream.
    pub view_refresh_interval_ms: u64,
    /// Width of a plot's follow-live x-window before the user has set
    /// one by zooming or panning, in milliseconds (the settings view
    /// edits it in seconds). Default 10 000 ms. Site-specific: 10 s is
    /// wrong for a slow body bus.
    pub follow_window_ms: u64,
    /// How many recently-opened BLFs the File menu remembers. Default
    /// 8. `0` remembers none.
    pub recent_blfs_limit: u64,
    /// How many recently-run commands the palette floats to the top.
    /// Default 10. `0` remembers none.
    pub recent_commands_limit: u64,
    /// How many recently-opened projects the toolbar and the palette
    /// offer. Default 8. `0` remembers none. The list itself is state
    /// rather than a setting (ADR 0034) and lives in
    /// [`crate::state::UiState::recent_projects`]; only its bound is a
    /// preference.
    pub recent_projects_limit: u64,
    /// How many match groups one page of a plot panel's solo view holds.
    /// Default 1 — one group per page, so the cycle steps a group at a
    /// time. A solo pattern's capture groups bucket its matches into
    /// keyed groups (no captures: one group per match), and `‹ / ›` and
    /// `PageUp` / `PageDown` alike walk pages of them.
    pub solo_page_size: u64,
    /// How often the host pushes a `trace-grew` event with the latest
    /// count, rate, and live tail. Default 100 ms. It is *one* setting
    /// covering the whole live-update loop: the smoothing constant and
    /// the tail ceiling are tuned against this cadence, and exposing
    /// one of the three would invite a combination none of them was
    /// designed for.
    pub live_update_interval_ms: u64,
    /// How often the host flushes the trace store to disk (ADR 0002
    /// DS-2/DS-7). Default 2000 ms — a crash loses at most this much
    /// trailing capture, at the cost of an fsync and a manifest
    /// rewrite each time. The same durability-versus-I/O decision
    /// `scratch_cap_bytes` already exposes.
    pub trace_flush_interval_ms: u64,
    /// Size at which `cannet.log` rotates to `cannet.log.1`. Default
    /// 5 MiB; one generation is kept, so disk use is bounded to about
    /// twice this. The rolling log is the artifact a field engineer
    /// ships back, and a long soak at the default silently loses its
    /// head.
    pub log_rotation_bytes: u64,
    /// Entries the host's in-process system-log ring holds before the
    /// oldest is evicted. Default 4096. The frontend mirror follows it,
    /// so raising it makes more history reachable in the panel as well.
    pub system_log_ring_capacity: u64,
    /// How many messages one `(source, template)` pair may contribute
    /// per second before the rest are suppressed. Default 5. **`0`
    /// turns the limiter off** — debugging a message flood is exactly
    /// when you want to see all of it.
    pub system_log_rate_limit: u64,
    /// How often the health recorder samples memory and store metrics.
    /// Default 20 000 ms. Each sample walks the whole system process
    /// table, so it is genuinely expensive. **`0` turns sampling off.**
    pub health_sample_interval_ms: u64,
    /// How many times the host auto-restarts a crashed sidecar before
    /// giving up for the session. Default 3 — too few for a flaky
    /// dongle, too many for a CI soak. `0` never auto-restarts. A
    /// manual "Restart sidecar" resets the counter either way.
    pub sidecar_restart_budget: u64,
    /// How long the interface watcher waits before reconnecting to a
    /// `cannet-server` after the stream ends or a connect fails.
    /// Default 2000 ms: fine on a LAN, short for a flaky VPN to a
    /// remote server.
    pub reconnect_backoff_ms: u64,
    /// The address a **new** server form opens filled with — the
    /// "Add server…" form under a bus, and the bridge form. Default
    /// `127.0.0.1:50051`, the literal both boxes used to hard-code.
    ///
    /// A *default*, not a policy: it seeds the box and the user types
    /// over it. Nothing validates it, for the same reason nothing
    /// validates [`Settings::sidecar_dir`] — only a connection attempt
    /// can say whether an address answers, and it reports that already.
    pub default_server_address: String,
    /// Directory holding the `cannet-python-can` package to launch,
    /// instead of the one the host finds for itself. Empty (the
    /// default) means the built-in resolution: the frozen bundled
    /// sidecar, or the source tree found by walking up from the GUI
    /// binary. A field engineer with a patched or replaced sidecar
    /// build points cannet at it here instead of repackaging the app.
    ///
    /// Free text: a directory that holds no sidecar surfaces as the
    /// resulting spawn failure on the system log, which is the only
    /// place the answer is actually known.
    ///
    /// `CANNET_SIDECAR_DIR` in the environment overrides this for one
    /// run and says so on the system log — see
    /// [`crate::sidecar`]'s `env_over_setting`.
    pub sidecar_dir: String,
    /// Python module the sidecar loads its hardware driver from. Empty
    /// (the default) means the sidecar's own
    /// `cannet_python_can.driver_python_can`. The host forwards a
    /// non-empty value to the sidecar process as
    /// `CANNET_DRIVER_MODULE`; before this setting the host never set
    /// that variable at all, so choosing a driver meant launching the
    /// GUI from a shell that already had it.
    ///
    /// Free text, for the same reason as `sidecar_dir`: only the
    /// sidecar can say whether a module exists and implements the
    /// driver protocol, and it reports that on startup.
    ///
    /// `CANNET_DRIVER_MODULE` in the host's own environment overrides
    /// this for one run and says so on the system log.
    pub driver_module: String,
    /// Lowest severity written to the rolling `cannet.log` — one of
    /// [`SYSTEM_LOG_LEVELS`], default `debug`, which is everything and
    /// therefore exactly what the file held before it was adjustable.
    ///
    /// A **separate filter over a separate sink** from
    /// [`Settings::system_log_min_level`]: that one narrows the System
    /// Messages *view*, this one narrows the artifact a bug report
    /// carries, and quieting one must not quieten the other. A panic
    /// record ignores both ([`crate::crash`]).
    pub log_file_min_level: String,
    /// Log level the python-can sidecar runs at — one of
    /// [`SIDECAR_LOG_LEVELS`], default `info`, which is the sidecar's
    /// own default, so an untouched install is unchanged.
    ///
    /// It governs the sidecar's stderr, which the host classifies into
    /// System Messages, so it is the verbosity of everything a vendor
    /// driver contributes to a log a user ships back — `debug` for a
    /// hardware fault nobody can reproduce.
    pub sidecar_log_level: String,
    /// Which view a **freshly created** trace panel opens in — one of
    /// [`TRACE_MODES`], default `by-id`, which is what a new panel has
    /// always opened in.
    ///
    /// A *default*, not a policy: the panel's mode buttons still switch
    /// it, and the choice is persisted on the element, so changing this
    /// never rewrites a panel that already exists. Read once, when the
    /// panel seeds its state.
    pub trace_mode: String,
    /// Whether a **freshly created** chronological trace pins to the
    /// live tail. Default `true`.
    ///
    /// Read once at panel creation, like [`Settings::trace_mode`]; the
    /// panel's auto-scroll checkbox (and scrolling away from the tail)
    /// still wins for a panel that exists.
    pub trace_auto_scroll: bool,
    /// Whether a **freshly created** chronological trace interleaves
    /// timeline events (ADR 0035) among its frame rows. Default `true`.
    ///
    /// Read once at panel creation, like [`Settings::trace_mode`]; the
    /// panel's events checkbox still wins for a panel that exists.
    pub trace_show_events: bool,
    /// How a **newly created** plot area lays its series out across
    /// y-axes (ADR 0026) — one of [`Y_AXIS_MODES`], default `unified`.
    ///
    /// Read once, when an area is created: the panel's first area, or
    /// one added with "add plot area". The per-area mode picker still
    /// wins afterwards, and an area saved before this field existed
    /// keeps reading as `unified` rather than being re-laid-out.
    pub plot_y_axis_mode: String,
    /// Whether a loaded DBC is re-read and swapped in when the file
    /// changes on disk (ADR-free; see [`crate::dbc_watcher`]). Default
    /// `true`, which is what the app has always done.
    ///
    /// App-wide policy rather than a per-view default: there is no
    /// "this panel only" version of it. Read on every filesystem
    /// event, so switching it off stops the next swap rather than the
    /// next launch, and a file *disappearing* is still reported either
    /// way — the opt-out is about not replacing the database under an
    /// analysis in progress, not about going quiet.
    pub dbc_auto_reload: bool,
    /// How a trace-style table's `id` column renders an arbitration
    /// id — one of [`CAN_ID_FORMATS`], default `hex`, which is what the
    /// column has always shown.
    ///
    /// App-wide policy rather than a per-view default: there is no
    /// per-panel id format, and two panels disagreeing about how to
    /// spell the same id would be worse than either choice. It governs
    /// the *display* columns only — the transmit and filter editors
    /// keep typing ids in hex, which is their own input contract.
    ///
    /// The `s:` / `x:` prefix is not part of the choice and survives
    /// both: 11-bit and 29-bit ids overlap numerically.
    pub can_id_format: String,
    /// The column layout a **newly created** trace or by-ID table opens
    /// with — order, width, and which columns start hidden. `None` (the
    /// default) means the built-in layout, so a file that predates this
    /// field opens exactly the table the app always opened.
    ///
    /// Read once, when the panel seeds its state. The header's own
    /// drag-to-resize, drag-to-reorder, and right-click show/hide still
    /// win for a panel that exists, and a panel restored from a project
    /// keeps the layout saved on its element.
    ///
    /// **Stored and round-tripped, not validated**, exactly like
    /// [`Settings::keybindings`]: the column key set is declared in the
    /// frontend (`traceColumns.ts`), so a host-side check would need a
    /// second copy of it. The frontend's own parser accepts a known key
    /// at most once and falls back to the built-in layout otherwise.
    pub trace_columns: Option<Vec<ColumnLayout>>,
    /// The column layout a **newly created** signal table opens with —
    /// [`Settings::trace_columns`] for the signal view's own column set
    /// (`signalColumns.ts`), with the same contract.
    ///
    /// Two fields rather than one: the two tables have different
    /// columns, so one shared layout could not name them both.
    pub signal_columns: Option<Vec<ColumnLayout>>,
    /// Magnitude below which a float reads exponentially. Default
    /// `1e-4`, so `0.0001` is the smallest value still written out in
    /// full and `0.00001` is the largest one that switches.
    ///
    /// One of the three knobs behind **one** rule, applied identically
    /// by every float readout and y-axis tick label the plot draws: a
    /// value cannot read `0.0001` in the signal panel and `1.0e-4` on
    /// the axis beside it. Zero is legal and means "never switch at the
    /// small end"; a negative threshold is refused, since the
    /// comparison is against `|v|`.
    pub float_exponential_below: f64,
    /// Magnitude from which a float reads exponentially. Default `1e6`.
    /// The large-end counterpart of
    /// [`Settings::float_exponential_below`], with the same contract.
    pub float_exponential_from: f64,
    /// Decimals the mantissa carries in exponential form, trailing
    /// zeros kept — default 5, so a value reads `1.23457e-4` and
    /// `1.00000e-6` rather than a trimmed `1e-6`. Zero drops the
    /// mantissa's fraction entirely.
    ///
    /// Capped at [`MAX_MANTISSA_DECIMALS`]: past what a double actually
    /// carries the digits are noise, and the renderer's
    /// `Number.toExponential` refuses a wide enough width outright.
    pub float_mantissa_decimals: u64,
}

/// One column of a table's default layout — the on-disk mirror of the
/// frontend's `ColumnState`. Its `key` names a column of whichever
/// table the setting belongs to; the host does not interpret it (see
/// [`Settings::trace_columns`]).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnLayout {
    pub key: String,
    pub width: u64,
    pub visible: bool,
}

/// The smallest legal value of any millisecond-interval setting.
///
/// A hard implementation limit rather than a taste: an interval of zero
/// is a busy loop, and below one millisecond is not representable in the
/// timer APIs on either side of the IPC. Stated once, enforced in
/// [`validate`], and published as the `min` of every interval field's
/// descriptor rather than restated there
/// (`every_published_minimum_is_the_one_validate_enforces`).
pub const MIN_INTERVAL_MS: u64 = 1;

/// The smallest legal [`Settings::system_log_ring_capacity`]. A ring
/// that holds nothing cannot hold the message being pushed into it, so
/// one entry is the floor the data structure itself imposes.
pub const MIN_SYSTEM_LOG_RING: u64 = 1;

/// The smallest legal [`Settings::log_rotation_bytes`], and the unit the
/// settings view edits it in. A rotation cap is stored in bytes but
/// typed in MiB — the control's `scale` — so one mebibyte is the
/// smallest value that control can express, and a cap below one block
/// write would rotate the log away faster than anything could be read
/// out of it.
pub const MIN_LOG_ROTATION_BYTES: u64 = 1024 * 1024;

/// The severity names [`Settings::system_log_min_level`] accepts, least
/// to most severe — the same ladder the frontend's
/// `SYSTEM_LOG_LEVEL_RANK` and [`crate::system_log::LogLevel`] order by.
///
/// Stated once: [`validate`] refuses anything outside it, and it is what
/// the field's descriptor publishes as its `enum` options rather than
/// re-listing them ([`crate::settings_descriptor`]).
pub const SYSTEM_LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error"];

/// The level names [`Settings::sidecar_log_level`] accepts, least to
/// most severe.
///
/// These are the sidecar's own `--log-level` choices — Python's ladder,
/// where the third rung is `warning` rather than `warn` — not
/// [`SYSTEM_LOG_LEVELS`]. The host passes the value through verbatim,
/// so translating between the two spellings here would only create a
/// mapping to get wrong; the list is what the sidecar's argument parser
/// accepts, and a value outside it would make the sidecar exit at
/// startup.
pub const SIDECAR_LOG_LEVELS: &[&str] = &["debug", "info", "warning", "error"];

/// The view names [`Settings::trace_mode`] accepts — the two modes a
/// trace panel switches between, spelled as the panel's own `TraceMode`
/// spells them, since the value crosses the IPC verbatim.
///
/// Stated once: [`validate`] refuses anything outside it, and it is what
/// the field's descriptor publishes as its `enum` options.
pub const TRACE_MODES: &[&str] = &["chronological", "by-id"];

/// The layout names [`Settings::plot_y_axis_mode`] accepts — the plot's
/// own `YAxisMode` spellings (ADR 0026), since the value crosses the IPC
/// verbatim and is narrowed by `yAxisModeFromRaw` on arrival.
pub const Y_AXIS_MODES: &[&str] = &["unified", "per-unit", "individual"];

/// The widest [`Settings::float_mantissa_decimals`] the renderer will
/// accept.
///
/// A hard limit rather than a taste, and stated once here: an IEEE
/// double carries about 17 significant decimal digits, so a mantissa
/// wider than this is padding — and the frontend formats through
/// `Number.prototype.toExponential`, which throws outside its own
/// accepted width. Enforced in [`validate`]; the control publishes no
/// maximum because `Control::Int` has no such field, so the bound lives
/// in the field's help text instead.
pub const MAX_MANTISSA_DECIMALS: u64 = 20;

/// The renderings [`Settings::can_id_format`] accepts for a trace-style
/// table's `id` column. The names are the frontend's `CanIdFormat`
/// spellings, since the value crosses the IPC verbatim.
pub const CAN_ID_FORMATS: &[&str] = &["hex", "decimal"];

/// The themes [`Settings::theme`] accepts. The names are the frontend's
/// `ThemeName` spellings and the value of its `data-theme` attribute,
/// since the value crosses the IPC verbatim.
pub const THEMES: &[&str] = &["dark", "light", "lighthk"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            scratch_cap_bytes: None,
            pyramid_retention_bytes: crate::signal_cache::DEFAULT_RETENTION_BYTES,
            clear_scratch_on_exit: false,
            autosave_on_exit: false,
            keybindings: None,
            show_developer_settings: false,
            system_log_min_level: "info".to_string(),
            reopen_last_project: true,
            theme: "dark".to_string(),
            notice_dwell_ms: 3_000,
            plot_fetch_interval_ms: 67,
            view_refresh_interval_ms: 250,
            follow_window_ms: 10_000,
            recent_blfs_limit: 8,
            recent_commands_limit: 10,
            recent_projects_limit: 8,
            solo_page_size: 1,
            live_update_interval_ms: 100,
            trace_flush_interval_ms: 2_000,
            log_rotation_bytes: 5 * 1024 * 1024,
            system_log_ring_capacity: 4_096,
            system_log_rate_limit: 5,
            health_sample_interval_ms: 20_000,
            sidecar_restart_budget: 3,
            reconnect_backoff_ms: 2_000,
            default_server_address: "127.0.0.1:50051".to_string(),
            sidecar_dir: String::new(),
            driver_module: String::new(),
            log_file_min_level: "debug".to_string(),
            sidecar_log_level: "info".to_string(),
            trace_mode: "by-id".to_string(),
            trace_auto_scroll: true,
            trace_show_events: true,
            plot_y_axis_mode: "unified".to_string(),
            dbc_auto_reload: true,
            can_id_format: "hex".to_string(),
            trace_columns: None,
            signal_columns: None,
            float_exponential_below: 1e-4,
            float_exponential_from: 1e6,
            float_mantissa_decimals: 5,
        }
    }
}

/// The effective settings, cached for host code that needs a value
/// somewhere re-reading the file is not an option — a per-message log
/// write, a timer loop, the system-log ring. Refreshed by every
/// [`get_settings`] / [`set_settings`], and hydrated once at startup, so
/// it is never staler than the last read.
///
/// It is deliberately **not** the base of a write. Stage 1's rule
/// stands: `set_settings` merges over a fresh read of the file, because
/// the file is hand-editable and a cache can always be stale. This is a
/// read cache and nothing else.
static EFFECTIVE: OnceLock<RwLock<Arc<Settings>>> = OnceLock::new();

fn effective_cell() -> &'static RwLock<Arc<Settings>> {
    EFFECTIVE.get_or_init(|| RwLock::new(Arc::new(Settings::default())))
}

/// The current effective settings — one `Arc` clone, no filesystem, no
/// lock held past the read. Safe from any thread, including from inside
/// the system-log path, which is why it must never touch the disk.
///
/// Before the first [`hydrate`] it answers [`Settings::default`], which
/// is the same answer a missing file gives.
#[must_use]
pub fn effective() -> Arc<Settings> {
    let guard = effective_cell()
        .read()
        .unwrap_or_else(PoisonError::into_inner);
    Arc::clone(&guard)
}

fn cache(settings: &Settings) {
    let mut guard = effective_cell()
        .write()
        .unwrap_or_else(PoisonError::into_inner);
    *guard = Arc::new(settings.clone());
}

/// Fill the [`effective`] cache from disk. Called once during setup, so
/// the loops and log writers that read it start on the user's values
/// rather than on the defaults.
pub fn hydrate(app: &tauri::AppHandle) {
    let _ = get_settings(app.clone());
}

/// One persisted keybinding — the on-disk mirror of the frontend's
/// `BindingSpec` (ADR 0018). camelCase to match the TypeScript shape the
/// frontend reads and writes; `skip_editable` is omitted when unset so a
/// hand-edited file stays close to what the app writes.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub chord: String,
    pub command_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_editable: Option<bool>,
    /// A binding the user removed. Carried so the frontend can tell
    /// "removed" from "shipped after this list was written" — the
    /// customisation is a whole-list snapshot, so absence alone cannot
    /// mean both. Omitted when unset, like `skip_editable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
}

/// The smallest legal [`Settings::scratch_cap_bytes`] (ADR 0002 DS-8).
///
/// This is a **hard implementation limit, not a setting**: below it the
/// pre-allocated segment families dominate the budget — one payload segment
/// (4 MiB) plus one filter segment (8 MiB) for a single filtered view
/// already exceed a small cap — so the retained frame window thrashes a
/// whole meta segment at a time and the cap cannot be honored at all. It is
/// therefore *validation metadata on the field*: stated once, here, enforced
/// where a value enters the app ([`validate`]), and surfaced to the frontend
/// as the `min` of the field's descriptor
/// ([`crate::settings_descriptor`]) rather than re-declared there. `None`
/// (unbounded) is always legal.
pub const MIN_SCRATCH_CAP_BYTES: u64 = 100 * 1024 * 1024;

/// Check every settings value against its documented bounds, returning the
/// accepted settings plus one human-readable complaint per refused field.
///
/// A refused field falls back to its default — the same resolution an absent
/// field gets — rather than being repaired to the nearest legal value. The
/// file is a user-authored document (ADR 0034): we report what we refuse and
/// leave their text alone, exactly as a hand-edited keybinding that names an
/// unknown command is dropped and reported rather than rewritten.
///
/// Crate-visible only so the descriptor table can be tested against it —
/// `every_published_minimum_is_the_one_validate_enforces` proves the
/// bound a control publishes is the bound this function applies. The
/// ingress calls are [`get_settings`] and [`set_settings`]; there is no
/// other caller.
pub(crate) fn validate(settings: Settings) -> (Settings, Vec<String>) {
    let mut complaints = Vec::new();
    let mut settings = settings;
    if let Some(cap) = settings.scratch_cap_bytes {
        if cap < MIN_SCRATCH_CAP_BYTES {
            complaints.push(format!(
                "scratch_cap_bytes {cap} is below the {MIN_SCRATCH_CAP_BYTES}-byte minimum \
                 (a smaller cap can't be honored); ignoring it — the cache is unbounded"
            ));
            settings.scratch_cap_bytes = None;
        }
    }
    refuse_unknown_options(&mut settings, &mut complaints);
    refuse_below_minimums(&mut settings, &mut complaints);
    refuse_bad_float_format(&mut settings, &mut complaints);
    (settings, complaints)
}

/// The float-format half of [`validate`]: the two magnitude thresholds
/// are compared against `|v|`, so a negative one is not a threshold at
/// all, and the mantissa width is bounded by what a double carries
/// ([`MAX_MANTISSA_DECIMALS`]).
fn refuse_bad_float_format(settings: &mut Settings, complaints: &mut Vec<String>) {
    let d = Settings::default();
    for (key, value, default) in [
        (
            "float_exponential_below",
            &mut settings.float_exponential_below,
            d.float_exponential_below,
        ),
        (
            "float_exponential_from",
            &mut settings.float_exponential_from,
            d.float_exponential_from,
        ),
    ] {
        if *value < 0.0 {
            complaints.push(format!(
                "{key} {value} is negative, and the threshold is compared against the \
                 value's magnitude; ignoring it — using the default ({default})"
            ));
            *value = default;
        }
    }
    if settings.float_mantissa_decimals > MAX_MANTISSA_DECIMALS {
        complaints.push(format!(
            "float_mantissa_decimals {} is above the maximum of {MAX_MANTISSA_DECIMALS} \
             (a double carries no more); ignoring it — using the default ({})",
            settings.float_mantissa_decimals, d.float_mantissa_decimals
        ));
        settings.float_mantissa_decimals = d.float_mantissa_decimals;
    }
}

/// The fixed-option half of [`validate`]: one table row per field whose
/// value must be one of a published list. Split out of `validate` only
/// because the two tables together outgrew one function.
fn refuse_unknown_options(settings: &mut Settings, complaints: &mut Vec<String>) {
    let d = Settings::default();
    for (key, value, allowed, default) in [
        (
            "system_log_min_level",
            &mut settings.system_log_min_level,
            SYSTEM_LOG_LEVELS,
            d.system_log_min_level.clone(),
        ),
        (
            "log_file_min_level",
            &mut settings.log_file_min_level,
            SYSTEM_LOG_LEVELS,
            d.log_file_min_level.clone(),
        ),
        (
            "sidecar_log_level",
            &mut settings.sidecar_log_level,
            SIDECAR_LOG_LEVELS,
            d.sidecar_log_level.clone(),
        ),
        (
            "trace_mode",
            &mut settings.trace_mode,
            TRACE_MODES,
            d.trace_mode.clone(),
        ),
        (
            "plot_y_axis_mode",
            &mut settings.plot_y_axis_mode,
            Y_AXIS_MODES,
            d.plot_y_axis_mode.clone(),
        ),
        (
            "can_id_format",
            &mut settings.can_id_format,
            CAN_ID_FORMATS,
            d.can_id_format.clone(),
        ),
        ("theme", &mut settings.theme, THEMES, d.theme.clone()),
    ] {
        refuse_unknown(complaints, key, value, allowed, default);
    }
}

/// The numeric-floor half of [`validate`]: one table row per field with
/// a published minimum. Its counterpart is [`refuse_unknown_options`].
fn refuse_below_minimums(settings: &mut Settings, complaints: &mut Vec<String>) {
    let d = Settings::default();
    for (key, value, min, default) in [
        (
            "notice_dwell_ms",
            &mut settings.notice_dwell_ms,
            MIN_INTERVAL_MS,
            d.notice_dwell_ms,
        ),
        (
            "plot_fetch_interval_ms",
            &mut settings.plot_fetch_interval_ms,
            MIN_INTERVAL_MS,
            d.plot_fetch_interval_ms,
        ),
        (
            "view_refresh_interval_ms",
            &mut settings.view_refresh_interval_ms,
            MIN_INTERVAL_MS,
            d.view_refresh_interval_ms,
        ),
        (
            "follow_window_ms",
            &mut settings.follow_window_ms,
            MIN_INTERVAL_MS,
            d.follow_window_ms,
        ),
        (
            "live_update_interval_ms",
            &mut settings.live_update_interval_ms,
            MIN_INTERVAL_MS,
            d.live_update_interval_ms,
        ),
        (
            "trace_flush_interval_ms",
            &mut settings.trace_flush_interval_ms,
            MIN_INTERVAL_MS,
            d.trace_flush_interval_ms,
        ),
        (
            "reconnect_backoff_ms",
            &mut settings.reconnect_backoff_ms,
            MIN_INTERVAL_MS,
            d.reconnect_backoff_ms,
        ),
        (
            "system_log_ring_capacity",
            &mut settings.system_log_ring_capacity,
            MIN_SYSTEM_LOG_RING,
            d.system_log_ring_capacity,
        ),
        (
            "log_rotation_bytes",
            &mut settings.log_rotation_bytes,
            MIN_LOG_ROTATION_BYTES,
            d.log_rotation_bytes,
        ),
        // A page of zero would make the key a no-op rather than a
        // preference, so one is the floor.
        (
            "solo_page_size",
            &mut settings.solo_page_size,
            1,
            d.solo_page_size,
        ),
    ] {
        refuse_below(complaints, key, value, min, default);
    }
}

/// Refuse `value` if it is below `min`, reporting the field by name and
/// resolving it to `default` — the shared shape of every numeric bound
/// in [`validate`], so a new bounded field is one table row rather than
/// another hand-written `if`.
/// Refuse `value` if it is not one of `allowed`, reporting the field by
/// name and resolving it to `default` — the string counterpart of
/// [`refuse_below`], so a new fixed-option field is one table row
/// rather than another hand-written `if`.
///
/// A serde enum would refuse the value too, but by failing the *whole*
/// document on one typo'd level; a plain `String` checked here gets the
/// refuse-report-default treatment the rest of the store uses.
fn refuse_unknown(
    complaints: &mut Vec<String>,
    key: &str,
    value: &mut String,
    allowed: &[&str],
    default: String,
) {
    if allowed.contains(&value.as_str()) {
        return;
    }
    let known = allowed.join(", ");
    complaints.push(format!(
        "{key} \"{value}\" is not one of {known}; ignoring it — using the \
         default ({default})"
    ));
    *value = default;
}

fn refuse_below(complaints: &mut Vec<String>, key: &str, value: &mut u64, min: u64, default: u64) {
    if *value >= min {
        return;
    }
    complaints.push(format!(
        "{key} {value} is below the minimum of {min}; ignoring it — using the \
         default ({default})"
    ));
    *value = default;
}

/// Read the effective settings across both scopes (ADR 0042 §3):
/// `<user_dir>/settings.json` overridden per key by
/// `<workspace_dir>/settings.json`. A missing or unreadable file, or
/// junk contents, contributes nothing at that scope.
///
/// Returns the settings plus one complaint per key whose value the
/// struct refused — a hand-edit that typed a string where a number
/// belongs. [`get_settings`] reports those alongside [`validate`]'s, so
/// the two ways a value can be wrong (malformed, out of range) get the
/// same refuse-report-default treatment.
fn read_settings(user_dir: &Path, workspace_dir: &Path) -> (Settings, Vec<String>) {
    crate::persisted_json::read_scoped(user_dir, workspace_dir, SETTINGS_FILE)
}

/// Write `settings` across the two scopes, each key going to the file
/// [`SCOPES`] names for it (ADR 0042 §3). Each file is written to a temp
/// sibling and renamed over the target, so a crash mid-write can't leave
/// a half-written one.
fn write_settings(
    user_dir: &Path,
    workspace_dir: &Path,
    settings: &Settings,
) -> std::io::Result<()> {
    crate::persisted_json::write_scoped(user_dir, workspace_dir, SETTINGS_FILE, settings, SCOPES)
}

/// Report each refused field on the system log, so a hand-edit that the
/// app can't honor is visible rather than silently inert.
fn warn_refused(app: &tauri::AppHandle, complaints: &[String]) {
    for c in complaints {
        crate::sys_warn!(app, "settings", "{c}");
    }
}

/// Load the effective settings: the user scope, overridden per key by
/// the open project's workspace scope (ADR 0042 §3). Returns defaults if
/// the config dir can't be resolved or the files are missing / corrupt —
/// reading settings never fails for the caller. Malformed and
/// out-of-range values in a hand-edited file are refused here, at the
/// read boundary, and reported on the system log — one refused field
/// each, never the whole document; the caller only ever sees values the
/// app can honor.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    let (raw, mut complaints) = crate::persisted_json::config_dir(&app)
        .map(|user_dir| read_settings(&user_dir, &crate::workspace_dir(&app)))
        .unwrap_or_default();
    let (settings, refused) = validate(raw);
    complaints.extend(refused);
    cache(&settings);
    warn_refused(&app, &complaints);
    settings
}

/// The settings as the **user scope alone** resolves them — no workspace
/// overrides, no validation reporting.
///
/// One caller, and it is the reason the function exists: the project
/// directory is resolved at startup (ADR 0042 §1) from settings that
/// cannot go through the scoped read path, because the workspace scope
/// lives *inside* the directory being resolved. `state`'s
/// `user_scope_last_project` is the same restriction on the same
/// decision. Every field read this way is `Scope::User`, so nothing is
/// being quietly denied its override.
pub(crate) fn user_scope(app: &tauri::AppHandle) -> Settings {
    let Ok(dir) = crate::persisted_json::config_dir(app) else {
        return Settings::default();
    };
    // A workspace path that cannot exist: this read is deliberately
    // single-scope, and `read_settings` treats a missing file as
    // contributing nothing.
    validate(read_settings(&dir, Path::new("")).0).0
}

/// The project file a launch resumes into: the one the app was last
/// working in, unless [`Settings::reopen_last_project`] says to start
/// without one.
///
/// Pure so the decision is testable — the environment it actually runs
/// in (a `tauri::App` mid-`setup`, before the `WebView` exists) is not one
/// a test can build.
pub(crate) fn project_to_reopen(
    last: Option<std::path::PathBuf>,
    settings: &Settings,
) -> Option<std::path::PathBuf> {
    if settings.reopen_last_project {
        last
    } else {
        None
    }
}

/// The settings keys the open project's `.cannet/settings.json`
/// declares — the ones whose effective value came from the project
/// rather than from the user's own file (ADR 0042 §3). The settings view
/// marks them, so a value a project overrides is visible as such instead
/// of looking like a personal preference.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
#[must_use]
pub fn get_settings_overrides(app: tauri::AppHandle) -> Vec<String> {
    crate::persisted_json::declared_keys(&crate::workspace_dir(&app).join(SETTINGS_FILE))
}

/// Persist the whole settings struct — each key at the scope [`SCOPES`]
/// declares for it — and return what was actually stored: out-of-range
/// values are refused (and reported) before the write, so the file never
/// records a value the app would not honor and the caller can show what it
/// got. Errors (with a user-facing message) only if the config dir can't be
/// resolved or the write fails; on failure it also lands on the system log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let dir = crate::persisted_json::config_dir(&app)?;
    let (settings, complaints) = validate(settings);
    cache(&settings);
    warn_refused(&app, &complaints);
    write_settings(&dir, &crate::workspace_dir(&app), &settings).map_err(|e| {
        let msg = format!("failed to write settings: {e}");
        crate::sys_warn!(&app, "settings", "{msg}");
        msg
    })?;
    // Apply the windowed-ring scratch cap (ADR 0002 DS-8) to the live store
    // so a changed cap takes effect on the next flush, not just next launch.
    crate::apply_cache_caps(&app);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project directory with no workspace overrides — what cannet
    /// creates (`.cannet/settings.json` is written empty, so it shadows
    /// nothing). Reads through it must behave exactly as a single-scope
    /// read did.
    fn no_workspace() -> std::path::PathBuf {
        std::path::PathBuf::from("no-such-workspace-dir")
    }

    /// Write at user scope with no project overriding anything — the
    /// single-scope shape the older tests here assume.
    fn write_user_settings(dir: &Path, settings: &Settings) {
        write_settings(dir, &dir.join("unused-workspace"), settings).unwrap();
    }

    /// A user-scope settings document resolved with no workspace
    /// overrides — the same path production takes for a project that
    /// overrides nothing, without touching the filesystem. Junk and
    /// partial documents must survive it: a corrupt settings file can
    /// never brick startup.
    fn parse_settings(text: &str) -> Settings {
        crate::persisted_json::resolve_scoped(text, "").0
    }

    /// The effective settings alone. Most tests here are about what the
    /// two scopes resolve to rather than about the read boundary's
    /// complaints, which
    /// `one_malformed_value_costs_that_field_and_not_the_document`
    /// covers.
    fn resolved(user_dir: &Path, workspace_dir: &Path) -> Settings {
        read_settings(user_dir, workspace_dir).0
    }

    fn sample() -> Settings {
        Settings {
            scratch_cap_bytes: Some(8 * 1024 * 1024 * 1024),
            pyramid_retention_bytes: 4 * 1024 * 1024 * 1024,
            clear_scratch_on_exit: true,
            autosave_on_exit: true,
            keybindings: Some(vec![
                Binding {
                    chord: "Mod+k".into(),
                    command_id: "palette.show".into(),
                    skip_editable: None,
                    disabled: None,
                },
                Binding {
                    chord: "Mod+z".into(),
                    command_id: "view.undo".into(),
                    skip_editable: Some(true),
                    disabled: None,
                },
                Binding {
                    chord: "f".into(),
                    command_id: "plot.fitXAxis".into(),
                    skip_editable: None,
                    disabled: Some(true),
                },
            ]),
            show_developer_settings: true,
            system_log_min_level: "warn".to_string(),
            reopen_last_project: false,
            theme: "light".to_string(),
            notice_dwell_ms: 1_500,
            plot_fetch_interval_ms: 33,
            view_refresh_interval_ms: 500,
            follow_window_ms: 30_000,
            recent_blfs_limit: 20,
            recent_commands_limit: 3,
            recent_projects_limit: 4,
            solo_page_size: 4,
            live_update_interval_ms: 250,
            trace_flush_interval_ms: 5_000,
            log_rotation_bytes: 32 * 1024 * 1024,
            system_log_ring_capacity: 512,
            system_log_rate_limit: 0,
            health_sample_interval_ms: 0,
            sidecar_restart_budget: 1,
            reconnect_backoff_ms: 10_000,
            default_server_address: "10.0.0.5:50051".to_string(),
            sidecar_dir: "sidecar-source-tree".to_string(),
            driver_module: "my_team.driver".to_string(),
            log_file_min_level: "info".to_string(),
            sidecar_log_level: "debug".to_string(),
            trace_mode: "chronological".to_string(),
            trace_auto_scroll: false,
            trace_show_events: false,
            plot_y_axis_mode: "individual".to_string(),
            dbc_auto_reload: false,
            can_id_format: "decimal".to_string(),
            trace_columns: Some(vec![ColumnLayout {
                key: "data".to_string(),
                width: 400,
                visible: false,
            }]),
            signal_columns: None,
            float_exponential_below: 1e-3,
            float_exponential_from: 1e5,
            float_mantissa_decimals: 3,
        }
    }

    #[test]
    fn round_trips_through_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample();
        write_user_settings(dir.path(), &s);
        assert_eq!(resolved(dir.path(), &no_workspace()), s);
    }

    #[test]
    fn missing_file_reads_as_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(resolved(dir.path(), &no_workspace()), Settings::default());
    }

    #[test]
    fn defaults_are_unbounded_cap_and_keep_on_exit() {
        let d = Settings::default();
        assert_eq!(d.scratch_cap_bytes, None);
        assert!(!d.clear_scratch_on_exit);
        assert!(!d.autosave_on_exit);
        assert_eq!(d.keybindings, None);
        assert!(!d.show_developer_settings);
        assert_eq!(d.system_log_min_level, "info");
    }

    #[test]
    fn an_unknown_system_log_level_is_refused_and_reported() {
        // Same contract as the cap (ADR 0034 / Stage 1 item 3): a value
        // the app can't honor is refused and reported, and resolves to
        // the default — never silently repaired to something else.
        let (accepted, complaints) = validate(Settings {
            system_log_min_level: "verbose".to_string(),
            ..Settings::default()
        });
        assert_eq!(accepted.system_log_min_level, "info");
        assert_eq!(complaints.len(), 1, "{complaints:?}");
        assert!(
            complaints[0].contains("system_log_min_level"),
            "{complaints:?}"
        );
        assert!(complaints[0].contains("verbose"), "{complaints:?}");
    }

    #[test]
    fn the_float_format_defaults_are_the_rule_the_views_document() {
        // The magnitude rule the plot's readouts and y-axis ticks share:
        // exponential below 1e-4 and from 1e6 up, with a five-decimal
        // mantissa. An install nobody has touched must read exactly that.
        let d = Settings::default();
        assert!((d.float_exponential_below - 1e-4).abs() < f64::EPSILON);
        assert!((d.float_exponential_from - 1e6).abs() < f64::EPSILON);
        assert_eq!(d.float_mantissa_decimals, 5);
    }

    #[test]
    fn a_negative_magnitude_threshold_is_refused_and_reported() {
        // The thresholds are compared against |v|, so a negative one is
        // not a stricter setting — it is a threshold that can never
        // (or always) fire. Refused and reported, resolving to its own
        // default, like every other out-of-range value.
        let (accepted, complaints) = validate(Settings {
            float_exponential_below: -1.0,
            ..Settings::default()
        });
        assert!(
            (accepted.float_exponential_below - Settings::default().float_exponential_below).abs()
                < f64::EPSILON
        );
        assert_eq!(complaints.len(), 1, "{complaints:?}");
        assert!(
            complaints[0].contains("float_exponential_below"),
            "{complaints:?}"
        );

        let (accepted, complaints) = validate(Settings {
            float_exponential_from: -0.5,
            ..Settings::default()
        });
        assert!(
            (accepted.float_exponential_from - Settings::default().float_exponential_from).abs()
                < f64::EPSILON
        );
        assert!(
            complaints[0].contains("float_exponential_from"),
            "{complaints:?}"
        );
    }

    #[test]
    fn a_zero_magnitude_threshold_is_accepted_as_never_and_always() {
        // Zero is a legitimate setting at both ends: `|v| < 0` never
        // fires (nothing small goes exponential) and `|v| >= 0` always
        // does (everything but zero itself). Neither is out of range.
        let (accepted, complaints) = validate(Settings {
            float_exponential_below: 0.0,
            float_exponential_from: 0.0,
            ..Settings::default()
        });
        assert!(accepted.float_exponential_below.abs() < f64::EPSILON);
        assert!(accepted.float_exponential_from.abs() < f64::EPSILON);
        assert!(complaints.is_empty(), "{complaints:?}");
    }

    #[test]
    fn a_mantissa_wider_than_a_double_carries_is_refused_and_reported() {
        // The one bound that is a hard limit rather than a taste: the
        // frontend renders the mantissa with `toExponential`, so a width
        // past what a double carries is padding at best and a thrown
        // RangeError at worst.
        let (accepted, complaints) = validate(Settings {
            float_mantissa_decimals: MAX_MANTISSA_DECIMALS + 1,
            ..Settings::default()
        });
        assert_eq!(
            accepted.float_mantissa_decimals,
            Settings::default().float_mantissa_decimals
        );
        assert_eq!(complaints.len(), 1, "{complaints:?}");
        assert!(
            complaints[0].contains("float_mantissa_decimals"),
            "{complaints:?}"
        );

        // The bound itself, and zero (`1e-6` with no mantissa at all),
        // are both legal.
        for decimals in [0, MAX_MANTISSA_DECIMALS] {
            let (accepted, complaints) = validate(Settings {
                float_mantissa_decimals: decimals,
                ..Settings::default()
            });
            assert_eq!(accepted.float_mantissa_decimals, decimals);
            assert!(complaints.is_empty(), "{decimals}: {complaints:?}");
        }
    }

    #[test]
    fn every_declared_system_log_level_is_accepted() {
        for level in SYSTEM_LOG_LEVELS {
            let (accepted, complaints) = validate(Settings {
                system_log_min_level: (*level).to_string(),
                ..Settings::default()
            });
            assert_eq!(&accepted.system_log_min_level, level);
            assert!(complaints.is_empty(), "{level}: {complaints:?}");
        }
    }

    #[test]
    fn keybindings_round_trip_with_camelcase_and_optional_skip_editable() {
        let dir = tempfile::tempdir().unwrap();
        write_user_settings(dir.path(), &sample());
        assert_eq!(resolved(dir.path(), &no_workspace()), sample());
        // The on-disk shape matches the frontend `BindingSpec`: camelCase
        // `commandId`, and `skipEditable` present only when set.
        let text = serde_json::to_string(&sample()).unwrap();
        assert!(text.contains("\"commandId\":\"palette.show\""), "{text}");
        assert!(text.contains("\"skipEditable\":true"), "{text}");
        // A removal the editor recorded survives the round trip — the
        // frontend needs it to tell "removed" from "shipped later".
        assert!(text.contains("\"disabled\":true"), "{text}");
        // The first binding has no skip_editable, so it must not serialize one.
        assert!(
            !text.contains("\"chord\":\"Mod+k\",\"commandId\":\"palette.show\",\"skipEditable\""),
            "{text}"
        );
    }

    #[test]
    fn missing_keybindings_key_reads_as_none() {
        let s = parse_settings(r#"{"scratch_cap_bytes": 1024}"#);
        assert_eq!(s.keybindings, None);
    }

    #[test]
    fn junk_contents_read_as_default() {
        assert_eq!(parse_settings("not json"), Settings::default());
        assert_eq!(parse_settings("[1, 2, 3]"), Settings::default());
    }

    #[test]
    fn partial_file_keeps_present_fields_and_defaults_the_rest() {
        let s = parse_settings(r#"{"clear_scratch_on_exit": true}"#);
        assert!(s.clear_scratch_on_exit);
        assert_eq!(s.scratch_cap_bytes, None);
    }

    #[test]
    fn a_file_written_before_a_field_existed_resolves_to_that_field_s_default() {
        // The promotion promise, in its strongest form: a settings
        // document carrying only the keys the store had before Stage 3
        // must produce exactly the defaults — so an install nobody has
        // touched behaves as it did before the fields existed.
        let legacy = r#"{
            "scratch_cap_bytes": null,
            "clear_scratch_on_exit": false,
            "keybindings": null,
            "show_developer_settings": false
        }"#;
        assert_eq!(parse_settings(legacy), Settings::default());
        // Same for the empty document and the missing one.
        assert_eq!(parse_settings("{}"), Settings::default());
    }

    #[test]
    fn the_effective_cache_answers_defaults_until_something_publishes() {
        // Host code on paths that cannot read the file — the log
        // writer, the timer loops, the system-log ring — reads this
        // cache, so before the boot hydrate it must answer exactly what
        // a missing file answers.
        //
        // Deliberately exercised through `notice_dwell_ms` alone: the
        // cache is process-wide, and every other field is read by some
        // other module whose tests run concurrently with this one.
        // Nothing host-side reads the dwell, so publishing it here
        // cannot perturb them.
        let before = effective();
        assert_eq!(
            before.notice_dwell_ms,
            Settings::default().notice_dwell_ms,
            "un-hydrated cache must read as the defaults"
        );

        cache(&Settings {
            notice_dwell_ms: 12_345,
            ..(*before).clone()
        });
        assert_eq!(effective().notice_dwell_ms, 12_345);

        cache(&before);
        assert_eq!(
            effective().notice_dwell_ms,
            Settings::default().notice_dwell_ms
        );
    }

    #[test]
    fn one_malformed_value_costs_that_field_and_not_the_document() {
        // The file is a hand-editable contract (ADR 0034), so a typo in
        // one value must not silently discard everything else the user
        // set. Same treatment as an out-of-range value: refused,
        // reported, resolved to *that field's* default.
        let doc = r#"{
            "clear_scratch_on_exit": true,
            "plot_fetch_interval_ms": "fast",
            "recent_blfs_limit": 20,
            "system_log_min_level": "warn"
        }"#;
        let (settings, complaints): (Settings, _) = crate::persisted_json::resolve_scoped(doc, "");

        assert!(settings.clear_scratch_on_exit, "a good neighbour survives");
        assert_eq!(settings.recent_blfs_limit, 20);
        assert_eq!(settings.system_log_min_level, "warn");
        assert_eq!(
            settings.plot_fetch_interval_ms,
            Settings::default().plot_fetch_interval_ms,
            "the malformed field resolves to its own default"
        );
        assert_eq!(complaints.len(), 1, "{complaints:?}");
        assert!(
            complaints[0].contains("plot_fetch_interval_ms"),
            "{complaints:?}"
        );
    }

    #[test]
    fn the_last_project_is_reopened_by_default() {
        // The behaviour the app has always had, now as the field's
        // default: an install nobody has touched resumes where it left
        // off.
        let last = Some(std::path::PathBuf::from("/jobs/friday.cannet_prj"));
        assert_eq!(
            project_to_reopen(last.clone(), &Settings::default()),
            last,
            "the default must resume the last project"
        );
    }

    #[test]
    fn reopen_off_starts_without_a_project() {
        // The knob the item exists for: start empty. The pointer is
        // still on file — turning the setting back on resumes — but
        // this session resolves as if there were no last project, which
        // is the auto-located project directory (ADR 0042 §1).
        assert_eq!(
            project_to_reopen(
                Some(std::path::PathBuf::from("/jobs/friday.cannet_prj")),
                &Settings {
                    reopen_last_project: false,
                    ..Settings::default()
                },
            ),
            None
        );
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let s = parse_settings(r#"{"scratch_cap_bytes": 1024, "future_key": 42}"#);
        assert_eq!(s.scratch_cap_bytes, Some(1024));
    }

    #[test]
    fn in_range_and_unbounded_caps_are_accepted_unchanged() {
        // Unbounded is always legal; at-or-above the minimum passes through
        // untouched (ADR 0002 DS-8).
        for cap in [
            None,
            Some(MIN_SCRATCH_CAP_BYTES),
            Some(8 * 1024 * 1024 * 1024),
        ] {
            let (accepted, complaints) = validate(Settings {
                scratch_cap_bytes: cap,
                ..Settings::default()
            });
            assert_eq!(accepted.scratch_cap_bytes, cap);
            assert!(complaints.is_empty(), "{complaints:?}");
        }
    }

    #[test]
    fn below_minimum_cap_is_rejected_and_reported_not_repaired() {
        // The minimum is a hard implementation limit (ADR 0002 DS-8), not a
        // setting: an out-of-range value is refused and reported, never
        // silently repaired to the nearest legal value. A refused field
        // resolves to its default, exactly as an absent one does.
        for cap in [
            Some(0),
            Some(15 * 1024 * 1024),
            Some(MIN_SCRATCH_CAP_BYTES - 1),
        ] {
            let (accepted, complaints) = validate(Settings {
                scratch_cap_bytes: cap,
                clear_scratch_on_exit: true,
                ..Settings::default()
            });
            assert_eq!(accepted.scratch_cap_bytes, None, "cap {cap:?}");
            assert_eq!(complaints.len(), 1, "cap {cap:?}: {complaints:?}");
            assert!(
                complaints[0].contains("scratch_cap_bytes"),
                "{complaints:?}"
            );
            // Only the offending field is refused; the rest is kept.
            assert!(accepted.clear_scratch_on_exit);
        }
    }

    #[test]
    fn default_settings_serialize_with_every_key_present() {
        // Unlike state.json, settings.json lists every knob even at its
        // default so the file is discoverable when hand-edited. Checked
        // against `SCOPES` rather than a hand-written key list, which
        // `every_settings_key_declares_a_scope` already pins to the
        // struct in both directions.
        let serde_json::Value::Object(keys) = serde_json::to_value(Settings::default()).unwrap()
        else {
            panic!("settings must serialize to a JSON object");
        };
        for (name, _) in SCOPES {
            assert!(
                keys.contains_key(*name),
                "`{name}` is not in the written file"
            );
        }
    }

    #[test]
    fn a_workspace_setting_overrides_the_user_setting_for_the_same_key() {
        // ADR 0042 §3, through the real file layout: the user's
        // `settings.json` and the project's `.cannet/settings.json`.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        write_user_settings(
            &user,
            &Settings {
                scratch_cap_bytes: Some(4 * 1024 * 1024 * 1024),
                ..Settings::default()
            },
        );
        std::fs::write(
            workspace.join(SETTINGS_FILE),
            r#"{"clear_scratch_on_exit": true}"#,
        )
        .unwrap();

        let effective = resolved(&user, &workspace);

        assert!(
            effective.clear_scratch_on_exit,
            "the workspace value wins for the key it declares"
        );
        assert_eq!(
            effective.scratch_cap_bytes,
            Some(4 * 1024 * 1024 * 1024),
            "a key the workspace is silent about keeps the user's value"
        );
    }

    #[test]
    fn an_empty_workspace_file_leaves_the_user_settings_exactly_as_they_were() {
        // What a freshly created project directory holds. A user who
        // never touches workspace settings must see no change at all.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        write_user_settings(&user, &sample());
        std::fs::write(workspace.join(SETTINGS_FILE), "{}\n").unwrap();

        assert_eq!(resolved(&user, &workspace), sample());
    }

    #[test]
    fn every_settings_key_declares_a_scope() {
        // The exit criterion: a key with no declared scope fails a test
        // rather than defaulting silently. Both directions — an
        // undeclared key, and a declaration for a key that no longer
        // exists.
        let serde_json::Value::Object(keys) = serde_json::to_value(sample()).unwrap() else {
            panic!("settings must serialize to a JSON object");
        };
        for key in keys.keys() {
            assert!(
                crate::persisted_json::scope_of(SCOPES, key).is_some(),
                "settings key `{key}` declares no scope"
            );
        }
        for (name, _) in SCOPES {
            assert!(
                keys.contains_key(*name),
                "SCOPES names a stale key `{name}`"
            );
        }
    }

    #[test]
    fn writing_back_a_resolved_setting_updates_the_override_not_the_user_file() {
        // The gap the two-scope read left open: `get_settings` resolves
        // the override, the frontend echoes the whole struct back, and
        // the write used to land the project's value in the *user* file
        // — silently promoting it. The override is now maintained where
        // it lives, and the user's own value survives untouched.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        write_user_settings(
            &user,
            &Settings {
                clear_scratch_on_exit: false,
                ..Settings::default()
            },
        );
        std::fs::write(
            workspace.join(SETTINGS_FILE),
            r#"{"clear_scratch_on_exit": true}"#,
        )
        .unwrap();

        let effective = resolved(&user, &workspace);
        assert!(effective.clear_scratch_on_exit);
        write_settings(&user, &workspace, &effective).unwrap();

        assert!(
            !resolved(&user, &no_workspace()).clear_scratch_on_exit,
            "the user's own value must not be overwritten by the project's"
        );
        assert!(resolved(&user, &workspace).clear_scratch_on_exit);
    }

    #[test]
    fn a_project_that_overrides_nothing_never_gets_its_settings_file_written() {
        // ADR 0042 §2 as it applies to writes: cannet fills `.cannet/`
        // once, and a settings change with no override in play leaves
        // that empty file exactly as created.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join(SETTINGS_FILE), "{}\n").unwrap();

        write_settings(&user, &workspace, &sample()).unwrap();

        assert_eq!(
            std::fs::read_to_string(workspace.join(SETTINGS_FILE)).unwrap(),
            "{}\n"
        );
        assert_eq!(resolved(&user, &workspace), sample());
    }

    #[test]
    fn write_replaces_rather_than_merges() {
        let dir = tempfile::tempdir().unwrap();
        write_user_settings(dir.path(), &sample());
        write_user_settings(dir.path(), &Settings::default());
        assert_eq!(resolved(dir.path(), &no_workspace()), Settings::default());
    }
}
