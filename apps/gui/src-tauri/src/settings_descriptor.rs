//! The per-setting descriptor: the one place a setting's label, help
//! text, control shape, and tags are written down (ADR 0034).
//!
//! [`crate::settings`] owns the *values*; this module owns everything a
//! view needs to render them. It is deliberately host-side, so the
//! descriptor table and the `Settings` struct sit next to each other and
//! a test can prove they name the same keys — which is ADR 0034's "the
//! file lists every knob" promise, mechanically checked. The frontend
//! generates its controls from what [`get_setting_descriptors`] serves;
//! nothing about a setting is hand-written per setting over there.
//!
//! **Nothing here is a second copy of something that already exists.** A
//! descriptor declares only what is genuinely new — the label, the help,
//! the control shape, and the two tag axes. Its scope is read from
//! [`crate::settings::SCOPES`] and its default from
//! [`Settings::default`] when the table is served, so neither can drift
//! from the thing it describes.
//!
//! **Two tag axes, both closed enums.** [`Surface`] says which part of
//! the app a setting governs and drives the default grouping; [`Kind`]
//! says what sort of decision it is. A closed enum rather than free
//! strings because a typo'd tag would silently misfile — or, for
//! [`Kind::Developer`], silently hide — a setting, and the taxonomy is
//! small enough that adding to it is a deliberate act.

use serde::Serialize;

use crate::persisted_json::{scope_of, Scope};
use crate::settings::{
    Settings, CAN_ID_FORMATS, MIN_INTERVAL_MS, MIN_LOG_ROTATION_BYTES, MIN_SCRATCH_CAP_BYTES,
    MIN_SYSTEM_LOG_RING, SCOPES, SIDECAR_LOG_LEVELS, SYSTEM_LOG_LEVELS, TRACE_MODES, Y_AXIS_MODES,
};

/// A whole-millisecond interval control: the shape every cadence
/// setting's row takes, with the one enforced floor
/// ([`MIN_INTERVAL_MS`]) rather than a per-row copy of it.
const fn interval_ms() -> Control {
    Control::Int {
        unit: Some("ms"),
        scale: 1,
        min: Some(MIN_INTERVAL_MS),
        unset: None,
    }
}

/// An interval whose `0` means "off" rather than "as fast as
/// possible" — so it carries no floor, and the help text says what zero
/// does.
const fn interval_ms_or_off() -> Control {
    Control::Int {
        unit: Some("ms"),
        scale: 1,
        min: None,
        unset: None,
    }
}

/// A plain count with no floor — a limit of zero is a legitimate
/// "remember nothing".
const fn count() -> Control {
    Control::Int {
        unit: None,
        scale: 1,
        min: None,
        unset: None,
    }
}

/// Which part of the app a setting governs — the tag axis the settings
/// tree groups by. A setting may govern more than one surface.
///
/// [`Surface::ALL`] is the tree order; it is also what proves every
/// variant is reachable from the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Surface {
    General,
    Plot,
    Trace,
    Signals,
    ById,
    Dbc,
    Transmit,
    Connection,
    Logging,
    Storage,
}

impl Surface {
    /// Every surface, in the order the settings tree lists them, with
    /// the label the tree shows. Served alongside the descriptors so the
    /// frontend renders the taxonomy rather than restating it.
    const ALL: &'static [(Self, &'static str)] = &[
        (Self::General, "General"),
        (Self::Plot, "Plot"),
        (Self::Trace, "Trace"),
        (Self::Signals, "Signals"),
        (Self::ById, "By-ID"),
        (Self::Dbc, "DBC"),
        (Self::Transmit, "Transmit"),
        (Self::Connection, "Connection"),
        (Self::Logging, "Logging"),
        (Self::Storage, "Storage"),
    ];
}

/// What sort of decision a setting is. Exactly one per setting — the
/// field is a single value, not a list, so "exactly one kind tag" is a
/// property of the type rather than something a test has to police.
///
/// The taxonomy is deliberately complete ahead of the settings that will
/// carry it: it has to be settled *before* the store grows, or every
/// field added in the meantime needs a tag retrofitted. So a variant no
/// setting uses yet is the intended state, not dead code — hence the
/// `allow` rather than a shorter enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub(crate) enum Kind {
    /// The initial value of something the user can also change per view.
    Default,
    /// App-wide policy with no per-view equivalent.
    Behaviour,
    /// A machine-load or internal-cadence knob, exposed so that every
    /// knob lives in `settings.json` rather than because tuning it is
    /// expected. **Hidden in the settings view unless the user opts in**
    /// via `show_developer_settings`.
    Developer,
}

/// The control a setting's row renders. The view generates the widget
/// from this — there is no per-setting UI code — and the one escape
/// hatch is [`Control::Custom`], which names a renderer the view
/// dispatches through a single table.
///
/// A setting is therefore either a generated control or one named
/// renderer. There is no third case.
///
/// Like [`Kind`], this is a vocabulary rather than a set of call sites:
/// the view renders every variant (`settingControls.dom.test.tsx` covers
/// them), and a variant no setting uses yet is what makes adding that
/// setting a one-line change rather than a framework change. Rust cannot
/// see a use that lives on the other side of a serialized contract,
/// hence the `allow`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[allow(dead_code)]
pub(crate) enum Control {
    /// Checkbox over a `bool`.
    Bool,
    /// Select over a fixed set of strings.
    Enum { options: &'static [&'static str] },
    /// Whole-number input. `scale` converts between the stored value and
    /// the displayed one — stored = displayed × `scale` — so a byte
    /// count can be edited in MB without the file's units changing.
    /// `min` is in *stored* units, and is the same constant the host
    /// enforces on ingress. `unset`, when present, is the placeholder
    /// shown for an empty box and marks blank as a legal value (the
    /// field is `Option`al on the host).
    Int {
        unit: Option<&'static str>,
        scale: u64,
        min: Option<u64>,
        unset: Option<&'static str>,
    },
    /// Fractional-number input.
    Number {
        unit: Option<&'static str>,
        min: Option<f64>,
    },
    /// Free-text input.
    Text { placeholder: Option<&'static str> },
    /// Not a labelled input: the view dispatches `renderer` through its
    /// one custom-renderer table.
    Custom { renderer: &'static str },
}

/// What a row in the settings view is *about*.
///
/// Almost every row is a field of `settings.json`. A few are not: ADR
/// 0042 §5 puts the project cache list in the settings view, because that
/// is where a user looks for "reclaim the disk this project is using",
/// and it is a management surface rather than a value anyone types. Such
/// a row is marked here rather than smuggled in as a field that does not
/// exist, so `descriptors_and_settings_name_the_same_keys` still holds
/// over every row that claims to be a field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Backing {
    /// A field of `settings.json`; `key` names it, and the view shows the
    /// key because the panel teaches the file (ADR 0034).
    Field,
    /// Not a stored value at all: a surface the settings view hosts. It
    /// has no `settings.json` key, so `key` is an id for search and
    /// dispatch, the view does not present it as a field, and there is no
    /// scope, no default, and nothing to reset.
    View,
}

/// One setting's descriptor, as written in [`DESCRIPTORS`]. The scope
/// and the default are *not* here — they are joined in from the places
/// that already own them when the table is served.
struct Spec {
    /// The `settings.json` field name. The view shows it, so the panel
    /// teaches the file (ADR 0034). For a [`Backing::View`] row it is an
    /// id rather than a field name.
    key: &'static str,
    label: &'static str,
    /// One or two sentences: what it does, and what going wrong looks
    /// like. Searched, so a user who cannot name a setting can still
    /// find it.
    help: &'static str,
    surfaces: &'static [Surface],
    kind: Kind,
    control: Control,
    backing: Backing,
}

/// Every setting `settings.json` carries, in tree order within each
/// surface. `descriptors_and_settings_name_the_same_keys` is what keeps
/// this table and [`Settings`] from drifting apart.
const DESCRIPTORS: &[Spec] = &[
    Spec {
        key: "show_developer_settings",
        backing: Backing::Field,
        label: "Show developer settings",
        help: "Reveal machine-load and internal-cadence knobs in the settings \
               view. They are hidden by default because they exist so that every \
               knob lives in settings.json, not because tuning them is expected.",
        surfaces: &[Surface::General],
        kind: Kind::Behaviour,
        control: Control::Bool,
    },
    Spec {
        key: "keybindings",
        backing: Backing::Field,
        label: "Keyboard shortcuts",
        help: "Your keybinding customisation. Edited in the Keyboard Shortcuts \
               panel, which is its only editor; it is listed here because it is a \
               field of settings.json like any other. Absent means the built-in \
               default bindings.",
        surfaces: &[Surface::General],
        kind: Kind::Behaviour,
        control: Control::Custom {
            renderer: "keybindings",
        },
    },
    Spec {
        key: "scratch_cap_bytes",
        backing: Backing::Field,
        label: "Cache size cap",
        help: "Drop the oldest history once this project's on-disk cache exceeds \
               this. Below the minimum the pre-allocated segments dominate and the \
               cap cannot be honoured, so a smaller value is refused. Blank is \
               unbounded.",
        surfaces: &[Surface::Storage],
        kind: Kind::Behaviour,
        control: Control::Int {
            unit: Some("MB"),
            scale: 1024 * 1024,
            min: Some(MIN_SCRATCH_CAP_BYTES),
            unset: Some("unbounded"),
        },
    },
    Spec {
        key: "clear_scratch_on_exit",
        backing: Backing::Field,
        label: "Discard session on exit",
        help: "Wipe this project's on-disk cache on a clean close, instead of \
               reloading the prior session on the next launch.",
        surfaces: &[Surface::Storage],
        kind: Kind::Behaviour,
        control: Control::Bool,
    },
    Spec {
        key: "project_caches",
        // Not a field of `settings.json`: the cache list is a management
        // surface, and it sits in the settings view because that is where
        // a user looks for it (ADR 0042 §5).
        backing: Backing::View,
        label: "Project caches",
        help: "Every project directory cannet has cached data for, and how much \
               disk each one holds. Nothing is reclaimed automatically — clearing \
               is always a deliberate action, and no action here removes a project \
               directory.",
        surfaces: &[Surface::Storage],
        kind: Kind::Behaviour,
        control: Control::Custom {
            renderer: "project-caches",
        },
    },
    Spec {
        key: "system_log_min_level",
        backing: Backing::Field,
        label: "System log minimum level",
        help: "The lowest severity the System Messages panel lists. `info` is what \
               your own actions produced; drop to `debug` for the app's internal \
               breadcrumbs. This filters the view only — what reaches the log file \
               is its own setting.",
        surfaces: &[Surface::Logging],
        kind: Kind::Behaviour,
        control: Control::Enum {
            options: SYSTEM_LOG_LEVELS,
        },
    },
    Spec {
        key: "log_file_min_level",
        backing: Backing::Field,
        label: "Log file minimum level",
        help: "The lowest severity written to cannet.log — the file you send with \
               a bug report. The default keeps everything, including the app's own \
               breadcrumbs and health samples. Raising it makes the file smaller \
               and a long soak reach further back. A crash record is always \
               written.",
        surfaces: &[Surface::Logging],
        kind: Kind::Behaviour,
        control: Control::Enum {
            options: SYSTEM_LOG_LEVELS,
        },
    },
    Spec {
        key: "sidecar_log_level",
        backing: Backing::Field,
        label: "Sidecar log level",
        help: "How much the python-can sidecar reports about itself and your \
               adapter. Its messages arrive here and in the log file like any \
               other; drop it to debug when a hardware fault will not reproduce.",
        surfaces: &[Surface::Logging, Surface::Connection],
        kind: Kind::Behaviour,
        control: Control::Enum {
            options: SIDECAR_LOG_LEVELS,
        },
    },
    Spec {
        key: "recent_blfs_limit",
        backing: Backing::Field,
        label: "Recent BLFs remembered",
        help: "How many recently-opened BLFs the File menu lists. Roughly \"every \
               BLF you opened this week\" at the default. Zero remembers none.",
        surfaces: &[Surface::General],
        kind: Kind::Behaviour,
        control: count(),
    },
    Spec {
        key: "recent_commands_limit",
        backing: Backing::Field,
        label: "Recent commands remembered",
        help: "How many recently-run commands the command palette floats to the \
               top of its list. Zero remembers none.",
        surfaces: &[Surface::General],
        kind: Kind::Behaviour,
        control: count(),
    },
    Spec {
        key: "follow_window_ms",
        backing: Backing::Field,
        label: "Default follow-live window",
        help: "How much time a plot's follow-live window shows before you have set \
               a width by zooming or panning. The default suits a fast powertrain \
               bus; a slow body bus wants more.",
        surfaces: &[Surface::Plot],
        kind: Kind::Default,
        control: Control::Int {
            unit: Some("s"),
            scale: 1000,
            min: Some(MIN_INTERVAL_MS),
            unset: None,
        },
    },
    Spec {
        key: "trace_mode",
        backing: Backing::Field,
        label: "Default trace view",
        help: "Which view a new trace panel opens in: by-ID, one row per \
               arbitration id, or the chronological row-per-frame trace. Only \
               the starting point — the panel's own buttons still switch it, \
               and a panel that is already open keeps what you set there.",
        surfaces: &[Surface::Trace],
        kind: Kind::Default,
        control: Control::Enum {
            options: TRACE_MODES,
        },
    },
    Spec {
        key: "trace_auto_scroll",
        backing: Backing::Field,
        label: "Default auto-scroll",
        help: "Whether a new chronological trace starts pinned to the live \
               edge. Turn it off to open looking at the beginning of a \
               capture. The panel's auto-scroll box — and scrolling away from \
               the tail — still wins once it is open.",
        surfaces: &[Surface::Trace],
        kind: Kind::Default,
        control: Control::Bool,
    },
    Spec {
        key: "trace_show_events",
        backing: Backing::Field,
        label: "Default events overlay",
        help: "Whether a new chronological trace interleaves timeline events — \
               your notes and the capture-truncation marker — among the frame \
               rows. The panel's events box still wins once it is open.",
        surfaces: &[Surface::Trace],
        kind: Kind::Default,
        control: Control::Bool,
    },
    Spec {
        key: "plot_y_axis_mode",
        backing: Backing::Field,
        label: "Default y-axis layout",
        help: "How a new plot area spreads its signals over y-axes: all                overlaid on one, one axis per unit, or one axis per signal.                Only the starting point — each area's own picker still wins,                and a plot you already have is left as it is drawn.",
        surfaces: &[Surface::Plot],
        kind: Kind::Default,
        control: Control::Enum {
            options: Y_AXIS_MODES,
        },
    },
    Spec {
        key: "trace_columns",
        backing: Backing::Field,
        label: "Default trace columns",
        help: "Which columns a new trace or by-ID table shows, in what order,                and how wide. Only the starting point — drag a header to                reorder, drag its right edge to resize, right-click it to show                or hide, and a panel you already have keeps what you set there.",
        surfaces: &[Surface::Trace, Surface::ById],
        kind: Kind::Default,
        control: Control::Custom {
            renderer: "column-defaults",
        },
    },
    Spec {
        key: "signal_columns",
        backing: Backing::Field,
        label: "Default signal columns",
        help: "The same, for the signal table, which has its own columns.                Count, rate and bus start hidden by default because a signal                list is usually read for values.",
        surfaces: &[Surface::Signals],
        kind: Kind::Default,
        control: Control::Custom {
            renderer: "column-defaults",
        },
    },
    Spec {
        key: "can_id_format",
        backing: Backing::Field,
        label: "CAN-ID format",
        help: "How the trace and by-ID tables spell an arbitration id:                zero-padded hex, or plain decimal. The s: / x: prefix stays                either way — 11-bit and 29-bit ids overlap as numbers. Only the                display columns follow this; the transmit and filter editors                still take hex.",
        surfaces: &[Surface::Trace, Surface::ById],
        kind: Kind::Behaviour,
        control: Control::Enum {
            options: CAN_ID_FORMATS,
        },
    },
    Spec {
        key: "dbc_auto_reload",
        backing: Backing::Field,
        label: "Reload a DBC when it changes on disk",
        help: "Re-read a loaded DBC as soon as the file is saved by another                tool, instead of waiting for Reload DBC. Turn it off when you                are editing a DBC while analysing a capture and would rather                choose the moment the decoding changes. A DBC that disappears                is reported either way.",
        surfaces: &[Surface::Dbc],
        kind: Kind::Behaviour,
        control: Control::Bool,
    },
    Spec {
        key: "notice_dwell_ms",
        backing: Backing::Field,
        label: "Status notice dwell",
        help: "How long a transient notice stays in the status bar before it \
               reverts to the resting line. Lengthen it if notices clear before \
               you have read them; nothing is lost either way, since every notice \
               is also in the system log.",
        surfaces: &[Surface::General],
        kind: Kind::Developer,
        control: interval_ms(),
    },
    Spec {
        key: "plot_fetch_interval_ms",
        backing: Backing::Field,
        label: "Plot fetch interval",
        help: "How often an open plot asks the host for a resampled window while a \
               capture runs. Raising it cuts host load on a busy machine at the \
               cost of a choppier live plot; drawing stays at display rate either \
               way.",
        surfaces: &[Surface::Plot],
        kind: Kind::Developer,
        control: interval_ms(),
    },
    Spec {
        key: "view_refresh_interval_ms",
        backing: Backing::Field,
        label: "View refresh interval",
        help: "How often a paged view re-reads the tail while a capture runs — the \
               trace, by-id, signal and transmit views. It bounds both the parse \
               cost on the UI thread and the host-side window scans under a \
               high-rate stream.",
        surfaces: &[Surface::General],
        kind: Kind::Developer,
        control: interval_ms(),
    },
    Spec {
        key: "live_update_interval_ms",
        backing: Backing::Field,
        label: "Live update rate",
        help: "How often the host tells the views a running capture has grown. \
               Covers the whole live-update loop — the rate readout's smoothing \
               and the live-tail size are tuned against this one number.",
        surfaces: &[Surface::Trace],
        kind: Kind::Developer,
        control: interval_ms(),
    },
    Spec {
        key: "trace_flush_interval_ms",
        backing: Backing::Field,
        label: "Capture flush interval",
        help: "How often the capture is flushed to disk. A crash loses at most \
               this much trailing capture; each flush costs an fsync and a \
               manifest rewrite, so lengthening it trades durability for I/O.",
        surfaces: &[Surface::Storage],
        kind: Kind::Behaviour,
        control: interval_ms(),
    },
    Spec {
        key: "log_rotation_bytes",
        backing: Backing::Field,
        label: "Log file rotation size",
        help: "Size at which cannet.log rotates. One previous generation is kept, \
               so the pair uses about twice this. The rolling log is what you send \
               with a bug report — a long soak at a small size loses its \
               beginning.",
        surfaces: &[Surface::Logging],
        kind: Kind::Behaviour,
        control: Control::Int {
            unit: Some("MiB"),
            scale: 1024 * 1024,
            min: Some(MIN_LOG_ROTATION_BYTES),
            unset: None,
        },
    },
    Spec {
        key: "system_log_ring_capacity",
        backing: Backing::Field,
        label: "System log depth",
        help: "How many system messages are kept before the oldest is dropped. The \
               System Messages panel can show no more than this, so raising it \
               makes more of a long session reachable.",
        surfaces: &[Surface::Logging],
        kind: Kind::Behaviour,
        control: Control::Int {
            unit: Some("entries"),
            scale: 1,
            min: Some(MIN_SYSTEM_LOG_RING),
            unset: None,
        },
    },
    Spec {
        key: "system_log_rate_limit",
        backing: Backing::Field,
        label: "System log rate limit",
        help: "How many identical messages one source may log per second before \
               the rest are suppressed. Set it to 0 to turn the limiter off — \
               diagnosing a message flood is exactly when you want all of it.",
        surfaces: &[Surface::Logging],
        kind: Kind::Behaviour,
        control: Control::Int {
            unit: Some("per second"),
            scale: 1,
            min: None,
            unset: None,
        },
    },
    Spec {
        key: "health_sample_interval_ms",
        backing: Backing::Field,
        label: "Health sample interval",
        help: "How often memory and capture metrics are sampled into the system \
               log at debug level. Each sample walks the whole system process \
               table, so it is not free; set it to 0 to turn sampling off.",
        surfaces: &[Surface::Logging],
        kind: Kind::Developer,
        control: interval_ms_or_off(),
    },
    Spec {
        key: "sidecar_restart_budget",
        backing: Backing::Field,
        label: "Sidecar restart budget",
        help: "How many times a crashed python-can sidecar is restarted \
               automatically before the app gives up for the session. Raise it for \
               a flaky adapter; lower it so a CI soak fails loudly. Restart \
               sidecar resets the count.",
        surfaces: &[Surface::Connection],
        kind: Kind::Behaviour,
        control: Control::Int {
            unit: Some("attempts"),
            scale: 1,
            min: None,
            unset: None,
        },
    },
    Spec {
        key: "sidecar_dir",
        backing: Backing::Field,
        label: "Sidecar directory",
        help: "Run the python-can sidecar from this directory instead of the one \
               shipped with the app — a patched or replaced build, without \
               repackaging. Blank uses the bundled sidecar. A directory with no \
               sidecar in it shows up as a spawn failure in this log.",
        surfaces: &[Surface::Connection],
        kind: Kind::Behaviour,
        control: Control::Text {
            placeholder: Some("bundled sidecar"),
        },
    },
    Spec {
        key: "driver_module",
        backing: Backing::Field,
        label: "Driver module",
        help: "Python module the sidecar loads its hardware driver from. Blank \
               uses the bundled python-can driver. Set it to run your own driver \
               implementation; the sidecar reports on startup if the module is \
               missing or does not implement the driver protocol.",
        surfaces: &[Surface::Connection],
        kind: Kind::Behaviour,
        control: Control::Text {
            placeholder: Some("cannet_python_can.driver_python_can"),
        },
    },
    Spec {
        key: "reconnect_backoff_ms",
        backing: Backing::Field,
        label: "Reconnect backoff",
        help: "How long to wait before reconnecting to a cannet-server after the \
               connection drops. Fine at the default on a LAN; a flaky link to a \
               remote server wants longer so a down server is not hammered.",
        surfaces: &[Surface::Connection],
        kind: Kind::Developer,
        control: interval_ms(),
    },
];

/// One surface, as served: the tag value and the label the tree shows.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct SurfaceInfo {
    id: Surface,
    label: &'static str,
}

/// One setting's descriptor as served to the view: [`Spec`] with the
/// scope and default value joined in from the code that owns them.
#[derive(Debug, Clone, Serialize)]
pub struct SettingDescriptor {
    key: &'static str,
    label: &'static str,
    help: &'static str,
    surfaces: &'static [Surface],
    kind: Kind,
    control: Control,
    /// Whether this row is a `settings.json` field or a surface the view
    /// hosts. See [`Backing`].
    backing: Backing,
    /// From [`crate::settings::SCOPES`] — where a write of this key
    /// lands, and therefore whether a project may override it. `None`
    /// for a [`Backing::View`] row, which stores nothing; for a field it
    /// is always `Some`, which
    /// `every_descriptor_carries_the_scope_the_store_declares` polices.
    scope: Option<Scope>,
    /// From [`Settings::default`], so "differs from its default" is
    /// answerable in the view without the default being written twice.
    default: serde_json::Value,
}

/// The taxonomy and the descriptors, in one answer — a view needs both
/// to render, and they are one static fact.
#[derive(Debug, Clone, Serialize)]
pub struct SettingsSchema {
    surfaces: Vec<SurfaceInfo>,
    settings: Vec<SettingDescriptor>,
}

/// Build the served schema: the surface taxonomy, plus every descriptor
/// with its scope and default joined in.
fn schema() -> SettingsSchema {
    let defaults = serde_json::to_value(Settings::default()).unwrap_or(serde_json::Value::Null);
    SettingsSchema {
        surfaces: Surface::ALL
            .iter()
            .map(|(id, label)| SurfaceInfo { id: *id, label })
            .collect(),
        settings: DESCRIPTORS
            .iter()
            .map(|s| SettingDescriptor {
                key: s.key,
                label: s.label,
                help: s.help,
                surfaces: s.surfaces,
                kind: s.kind,
                control: s.control,
                backing: s.backing,
                scope: scope_of(SCOPES, s.key),
                default: defaults
                    .get(s.key)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            })
            .collect(),
    }
}

/// The settings taxonomy and every setting's descriptor. The view
/// renders from this instead of carrying its own copy of the schema.
#[tauri::command]
#[must_use]
pub fn get_setting_descriptors() -> SettingsSchema {
    schema()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served() -> SettingsSchema {
        schema()
    }

    #[test]
    fn every_setting_has_at_least_one_surface_tag() {
        // Exactly-one-kind is a property of the type (`kind` is one
        // value, not a list); at-least-one-surface is not, so it is
        // policed here. A setting with no surface would be reachable
        // only by search.
        for s in DESCRIPTORS {
            assert!(
                !s.surfaces.is_empty(),
                "setting `{}` declares no surface tag",
                s.key
            );
        }
    }

    /// The keys `Settings` actually serializes — what a field-backed
    /// descriptor must name one of, and what must each have one.
    fn settings_keys() -> serde_json::Map<String, serde_json::Value> {
        let serde_json::Value::Object(fields) = serde_json::to_value(Settings::default()).unwrap()
        else {
            panic!("settings must serialize to a JSON object");
        };
        fields
    }

    #[test]
    fn descriptors_and_settings_name_the_same_keys() {
        // ADR 0034's "the file lists every knob", mechanically checked:
        // a field added to `Settings` without a descriptor fails here,
        // and so does a descriptor for a field that no longer exists.
        let fields = settings_keys();
        for key in fields.keys() {
            assert!(
                DESCRIPTORS
                    .iter()
                    .any(|s| s.key == key && s.backing == Backing::Field),
                "settings key `{key}` has no descriptor"
            );
        }
        for s in DESCRIPTORS.iter().filter(|s| s.backing == Backing::Field) {
            assert!(
                fields.contains_key(s.key),
                "descriptor names a stale key `{}`",
                s.key
            );
        }
    }

    #[test]
    fn a_view_row_stores_nothing_and_is_a_custom_renderer() {
        // The other half of the key-set rule: a row that opts out of
        // being a field must be a surface the view hosts, not a way to
        // smuggle a generated control over a key nothing stores. And it
        // must not shadow a real setting — that setting would lose its
        // editor while still passing the key-set test above.
        let fields = settings_keys();
        for s in DESCRIPTORS.iter().filter(|s| s.backing == Backing::View) {
            assert!(
                matches!(s.control, Control::Custom { .. }),
                "view row `{}` declares a generated control",
                s.key
            );
            assert!(
                !fields.contains_key(s.key),
                "view row `{}` shadows a real settings key",
                s.key
            );
        }
    }

    #[test]
    fn the_project_cache_list_is_a_view_row_naming_its_renderer() {
        // ADR 0042 §5's cache management surface, as the settings view's
        // worked example of a custom renderer.
        let caches = DESCRIPTORS
            .iter()
            .find(|s| s.key == "project_caches")
            .expect("the cache list has a descriptor");
        assert_eq!(caches.backing, Backing::View);
        assert_eq!(
            caches.control,
            Control::Custom {
                renderer: "project-caches"
            }
        );
        assert_eq!(caches.surfaces, &[Surface::Storage]);
    }

    #[test]
    fn every_descriptor_carries_the_scope_the_store_declares() {
        // The descriptor reads `settings::SCOPES` rather than keeping a
        // second copy, so a served scope that disagreed with the write
        // routing would be a bug in this join, not a drifted duplicate.
        // A view row stores nothing, so it has no scope to declare.
        for d in &served().settings {
            assert_eq!(
                d.scope,
                scope_of(SCOPES, d.key),
                "descriptor for `{}` lost its scope",
                d.key
            );
            match d.backing {
                Backing::Field => assert!(d.scope.is_some(), "`{}` declares no scope", d.key),
                Backing::View => assert!(d.scope.is_none(), "`{}` stores nothing", d.key),
            }
        }
    }

    #[test]
    fn every_descriptor_carries_the_default_the_struct_defines() {
        // The other join: the view answers "differs from its default"
        // from this, so it must be the struct's default and not a
        // transcription of it. A view row has no stored value and so no
        // default; it serves `null`, and the view shows it no reset.
        let defaults = serde_json::to_value(Settings::default()).unwrap();
        for d in &served().settings {
            match d.backing {
                Backing::Field => assert_eq!(
                    Some(&d.default),
                    defaults.get(d.key),
                    "descriptor for `{}` carries a stale default",
                    d.key
                ),
                Backing::View => assert_eq!(
                    d.default,
                    serde_json::Value::Null,
                    "`{}` stores nothing, so it has no default",
                    d.key
                ),
            }
        }
    }

    /// `Settings::default()` with one key overwritten, by its
    /// *serialized* name — the only handle a table-driven test has on a
    /// field it does not name in Rust.
    fn settings_with(key: &str, value: u64) -> Settings {
        let mut doc = serde_json::to_value(Settings::default()).unwrap();
        doc[key] = serde_json::json!(value);
        serde_json::from_value(doc).expect("a numeric key takes a number")
    }

    fn value_of(settings: &Settings, key: &str) -> serde_json::Value {
        serde_json::to_value(settings).unwrap()[key].clone()
    }

    #[test]
    fn every_published_minimum_is_the_one_validate_enforces() {
        // The general form of the cap-minimum rule below: whatever a
        // control publishes as its floor, the host must accept that
        // value and refuse the one under it — reporting the field by
        // name and resolving it to its default. A descriptor that
        // published a bound nobody enforced would let the view accept a
        // value the store then silently ignored.
        let defaults = Settings::default();
        for spec in DESCRIPTORS {
            let Control::Int { min: Some(min), .. } = spec.control else {
                continue;
            };
            assert!(min > 0, "`{}` publishes a floor of zero", spec.key);

            let (_, complaints) = crate::settings::validate(settings_with(spec.key, min));
            assert!(
                !complaints.iter().any(|c| c.contains(spec.key)),
                "`{}` refuses its own published minimum: {complaints:?}",
                spec.key
            );

            let (accepted, complaints) =
                crate::settings::validate(settings_with(spec.key, min - 1));
            assert!(
                complaints.iter().any(|c| c.contains(spec.key)),
                "`{}` accepts a value below its published minimum",
                spec.key
            );
            assert_eq!(
                value_of(&accepted, spec.key),
                value_of(&defaults, spec.key),
                "a refused `{}` must resolve to its default",
                spec.key
            );
        }
    }

    #[test]
    fn the_published_cap_minimum_is_the_one_validate_enforces() {
        // The frontend renders the descriptor's `min` rather than its
        // own copy of the limit, so the published bound and the enforced
        // one must be the same number.
        let cap = DESCRIPTORS
            .iter()
            .find(|s| s.key == "scratch_cap_bytes")
            .expect("the cap has a descriptor");
        let Control::Int { min, .. } = cap.control else {
            panic!("the cap is a whole-number control");
        };
        assert_eq!(min, Some(crate::settings::MIN_SCRATCH_CAP_BYTES));
    }

    /// `Settings::default()` with one string key overwritten, by its
    /// *serialized* name — [`settings_with`]'s counterpart for the
    /// fixed-option fields.
    fn settings_with_text(key: &str, value: &str) -> Settings {
        let mut doc = serde_json::to_value(Settings::default()).unwrap();
        doc[key] = serde_json::json!(value);
        serde_json::from_value(doc).expect("a string key takes a string")
    }

    #[test]
    fn every_published_option_set_is_the_one_validate_accepts() {
        // The `Control::Enum` counterpart of
        // `every_published_minimum_is_the_one_validate_enforces`: the
        // view offers exactly what the host accepts. A descriptor that
        // published an option the store refuses would let a user pick a
        // value that silently reverted; one that omitted an option the
        // store accepts would hide a legal value.
        let defaults = Settings::default();
        for spec in DESCRIPTORS {
            let Control::Enum { options } = spec.control else {
                continue;
            };
            assert!(!options.is_empty(), "`{}` publishes no options", spec.key);
            for option in options {
                let (_, complaints) =
                    crate::settings::validate(settings_with_text(spec.key, option));
                assert!(
                    !complaints.iter().any(|c| c.contains(spec.key)),
                    "`{}` refuses its own published option `{option}`: {complaints:?}",
                    spec.key
                );
            }
            let (accepted, complaints) =
                crate::settings::validate(settings_with_text(spec.key, "not-an-option"));
            assert!(
                complaints.iter().any(|c| c.contains(spec.key)),
                "`{}` accepts a value it does not publish",
                spec.key
            );
            assert_eq!(
                value_of(&accepted, spec.key),
                value_of(&defaults, spec.key),
                "a refused `{}` must resolve to its default",
                spec.key
            );
        }
    }

    #[test]
    fn the_sidecar_log_levels_are_pythons_ladder_not_ours() {
        // The one place the two ladders differ is the third rung —
        // Python's `warning` against our `warn` — and the host passes
        // the value through verbatim, so publishing our spelling would
        // make the sidecar exit at startup on a value the view offered.
        let level = DESCRIPTORS
            .iter()
            .find(|s| s.key == "sidecar_log_level")
            .expect("the sidecar level has a descriptor");
        let Control::Enum { options } = level.control else {
            panic!("the sidecar level is a fixed-option control");
        };
        assert_eq!(options, SIDECAR_LOG_LEVELS);
        assert!(options.contains(&"warning"), "{options:?}");
        assert_ne!(options, SYSTEM_LOG_LEVELS);
    }

    #[test]
    fn the_published_log_levels_are_the_ones_validate_accepts() {
        // Same anti-drift rule as the cap minimum: the view offers what
        // the host accepts, from the host's own list, not a second copy.
        let level = DESCRIPTORS
            .iter()
            .find(|s| s.key == "system_log_min_level")
            .expect("the level has a descriptor");
        let Control::Enum { options } = level.control else {
            panic!("the level is a fixed-option control");
        };
        assert_eq!(options, SYSTEM_LOG_LEVELS);
    }

    #[test]
    fn the_developer_toggle_is_an_ordinary_setting() {
        // It reveals the developer knobs, so it must not itself be one
        // — a toggle you can only see once you've flipped it is
        // unreachable.
        let toggle = DESCRIPTORS
            .iter()
            .find(|s| s.key == "show_developer_settings")
            .expect("the toggle has a descriptor");
        assert_ne!(toggle.kind, Kind::Developer);
    }

    #[test]
    fn the_served_taxonomy_lists_every_surface_in_tree_order() {
        let schema = served();
        assert_eq!(schema.surfaces.len(), Surface::ALL.len());
        assert_eq!(schema.surfaces[0].id, Surface::General);
        for d in &schema.settings {
            for surface in d.surfaces {
                assert!(
                    schema.surfaces.iter().any(|s| s.id == *surface),
                    "`{}` is tagged with a surface the taxonomy omits",
                    d.key
                );
            }
        }
    }
}
