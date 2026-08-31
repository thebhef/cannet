//! Project files: the saved project, as a JSON document, read and
//! written by the [`open_project`] / [`save_project`] /
//! [`save_project_as`] commands.
//!
//! Opening a project moves the session into that project's own directory
//! (ADR 0042 §1), and [`save_project_as`] *creates* one at the
//! destination the user picked and moves the session there with its data.
//! Plain [`save_project`] writes the file and touches no directory.
//! [`close_project`] is the way back out: the session returns to the
//! auto-located directory an unsaved project belongs in.
//!
//! The host owns the project model. The two fields it *doesn't*
//! interpret are `layout` (`dockview`'s serialized layout blob) and
//! `elements` (the project's elements — `trace` / `plot` / `transmit`
//! / `filter` / `rbs` / `colormap`, each an opaque `{kind, id, …}`
//! record the frontend defines); the host just round-trips both.
//!
//! Carries: the panel layout, the project elements, the loaded DBCs +
//! per-DBC bus scoping, the logical-bus list, the interface → bus
//! bindings, the in-process virtual buses, the transmit-message pool,
//! and the remote-server address.
//!
//! The file carries an explicit [`PROJECT_SCHEMA_VERSION`]. Only the
//! current version is accepted — see ADR 0011; older and newer
//! versions are rejected with a user-facing message rather than
//! migrated.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

/// Current project-file schema version. A file is accepted only if its
/// `schema_version` matches exactly; any other value is rejected with a
/// user-facing message rather than migrated (ADR 0011). Bump this
/// whenever the in-memory shape changes.
pub const PROJECT_SCHEMA_VERSION: u32 = 7;

/// A logical bus. `id` is a stable, project-local identifier (graph
/// edges reference it; per-DBC scoping and the filter `bus` predicate
/// both compare against it). `name` is the user-facing label.
///
/// `speed_bps`, `fd`, and `fd_data_speed_bps` are the hardware
/// configuration the host pushes to the sidecar (via `ConfigureBus`)
/// every time it opens a session for an interface binding scoped to
/// this bus. `fd_data_speed_bps` is only meaningful when `fd` is true
/// (FD's arbitration phase still runs at `speed_bps`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bus {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speed_bps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fd: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fd_data_speed_bps: Option<u32>,
    /// User-chosen graph color (`#rrggbb`). The host round-trips it
    /// without interpretation; the GUI falls back to a palette color
    /// when it's absent.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
}

/// An interface binding routes a project [`Bus`] to an interface.
/// Each binding is a uniform `(server, interface, bus_id)` triple
/// regardless of what's on the other end — see ADR 0023. The
/// optional [`Self::kind`] discriminator hints at which backend the
/// host should pick when opening a session for the binding, but the
/// effective dispatch is by the URL scheme on [`Self::server`].
///
/// Multiple bindings may target the same `(server, interface)` — the
/// hardware-server (ADR 0022) and the in-process virtual bus
/// (ADR 0021) both fan out to N subscribers, so the host stamps each
/// source frame with every matching binding's `bus_id`.
///
/// Address shapes:
/// - **remote `host:port`** — a `(server, interface)` on a remote
///   `cannet-server`.
/// - **`"local"` sentinel** — the local sidecar at whatever address
///   it's bound to this session; the port is randomised per launch
///   so the sentinel is what gets persisted.
/// - **`local-vbus://<vbus_id>`** — an in-process virtual bus owned
///   by the project ([`Project::local_virtual_buses`]). `interface`
///   is the canonical `"bus"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterfaceBinding {
    #[serde(default)]
    pub kind: BindingKind,
    pub server: String,
    pub interface: String,
    pub bus_id: String,
}

/// URI scheme that identifies an in-process virtual bus owned by the
/// project. A binding with `server = "local-vbus://<vbus_id>"` opens
/// an in-process session against the named [`LocalVirtualBusDef`].
pub const LOCAL_VBUS_URL_SCHEME: &str = "local-vbus://";

/// Canonical wire-interface name used by every `local-vbus://`
/// binding. A vbus has a single conceptual interface (the bus
/// itself); multiple project buses bound to the same vbus share this
/// interface name and rely on the multi-subscriber fan-out
/// (ADR 0022 §"shared interface").
pub const LOCAL_VBUS_INTERFACE: &str = "bus";

/// Discriminator for the three binding kinds (v6 schema).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BindingKind {
    /// A `(server, interface)` on a remote `cannet-server`. The
    /// default kind.
    #[default]
    Remote,
    /// A factory subscription against a remote virtual-bus server
    /// (ADR 0021).
    RemoteVirtualBus,
    /// A binding to an entry in [`Project::local_virtual_buses`]
    /// (ADR 0021).
    LocalVirtualBus,
}

/// A virtual bus owned by the project (ADR 0021). The host
/// instantiates one [`cannet_core::SharedBus`] per entry on project
/// open; bindings with `server = "local-vbus://<id>"` reference it.
/// Many bindings may reference the same virtual bus — each opens its
/// own participant on the shared bus when its session is connected.
///
/// A vbus has no user-configurable baud rate: it's an in-process
/// channel, not a model of a real wire, so a configurable bitrate
/// would just be misleading UI. The host instantiates each vbus
/// with a fixed default [`cannet_core::BusConfig`] that `SharedBus`
/// uses for its internal arbitration timing; the user never sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalVirtualBusDef {
    /// Stable project-local id, used in the binding's
    /// `local-vbus://<id>` URL and as the host's registry key.
    pub id: String,
    /// User-facing label.
    pub name: String,
    /// Bridges installed on the virtual bus. Each is re-instantiated
    /// on project open by opening a `cannet-client` session to its
    /// `remote_address` and calling `SharedBus::attach_bridge`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bridges: Vec<BridgeSpec>,
}

/// A persisted bridge installed on a [`LocalVirtualBusDef`].
/// `remote_address` is a `cannet-server` `host:port` (or the
/// `"local"` sentinel for the local sidecar). `interface` is the
/// wire id on that server (or its factory id for a cross-server
/// virtual-bus bridge). `name` is the user-chosen label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeSpec {
    pub remote_address: String,
    pub interface: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

/// A loaded DBC reference with its bus assignment. An empty `buses`
/// assigns it to nothing, and a database assigned to nothing decodes
/// nothing — including a project saved before that was the rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbcRef {
    pub path: String,
    #[serde(default)]
    pub buses: Vec<String>,
}

/// A saved project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// Schema version — see [`PROJECT_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Stable per-project identity, generated once when the project is
    /// first created and never changed after. It gates disk-spill scratch
    /// reload across rename/move (ADR 0002 DS-7): the scratch records the
    /// id of the project that produced it, and a launch reloads that
    /// scratch only against a project carrying the same id.
    ///
    /// Like `transmit_frames`, this is host-managed and the frontend
    /// doesn't carry it: it's an additive field with a generating default
    /// (so an older file with no id gains one on read, no schema bump),
    /// and `save_project` anchors it to the target file — preserving the
    /// id already on disk and writing a fresh one only for a brand-new
    /// file. That keeps it stable across saves even though the frontend's
    /// save payload omits it.
    #[serde(default = "generate_project_id")]
    pub project_id: Uuid,
    /// The `dockview` panel layout, verbatim. The host doesn't read
    /// this; it's the frontend's serialized layout.
    pub layout: serde_json::Value,
    /// The project's elements — `trace` / `plot` / `transmit` /
    /// `filter` / `rbs` / `colormap`, each an opaque `{kind, id, …}`
    /// record. The host doesn't read these; the frontend owns the shape.
    #[serde(default)]
    pub elements: Vec<serde_json::Value>,
    /// Logical buses the project knows about.
    #[serde(default)]
    pub buses: Vec<Bus>,
    /// Interface → bus bindings.
    #[serde(default)]
    pub interface_bindings: Vec<InterfaceBinding>,
    /// Loaded DBCs + per-DBC bus assignment. An empty `buses` on a
    /// `DbcRef` is a database assigned to nothing.
    #[serde(default)]
    pub dbcs: Vec<DbcRef>,
    /// Remote `cannet-server` address (`host:port`), if the project
    /// connects to one.
    #[serde(default)]
    pub remote_address: Option<String>,
    /// In-process virtual buses owned by the project (ADR 0021).
    /// Each entry is instantiated once on project open;
    /// `InterfaceBinding`s with `kind = local-virtual-bus`
    /// reference one by `LocalVirtualBusDef::id`.
    #[serde(default)]
    pub local_virtual_buses: Vec<LocalVirtualBusDef>,
    /// The TX-message pool. A flat, global list of
    /// transmit messages the project owns; each transmit panel groups
    /// a subset for display via its element's `frame_ids`. The host
    /// registry (`crate::transmit_frames::TransmitFrameRegistry`) is
    /// the runtime source of truth — `open_project` loads it from this
    /// list (all periodics stopped), `save_project` snapshots it back.
    /// Additive; no schema-version bump.
    #[serde(default)]
    pub transmit_frames: Vec<crate::transmit_frames::TransmitFrame>,
    /// Per-signal color overrides for the signal views: descriptor
    /// key → `#rrggbb`. Project-level (not per-panel) so a signal
    /// keeps its color across views and sessions; the frontend owns
    /// the key format (`plotData.ts::signalKey`) and the host just
    /// round-trips the map. Additive; no schema-version bump.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub signal_colors: std::collections::HashMap<String, String>,
    /// Per-signal choices of which assigned database decodes a signal:
    /// signal identity (ADR 0038) → the loaded path of the chosen
    /// database. The resolution of the ambiguous case the view-signal
    /// panel surfaces — two databases on one bus defining the same
    /// signal, which the decode path would otherwise settle silently by
    /// load order.
    ///
    /// Host-managed like [`Self::transmit_frames`], because the decoder
    /// consumes it: `open_project` loads it into
    /// `AppState::signal_dbc_picks` and `save_project` snapshots that
    /// registry back, so the frontend's save payload does not carry it.
    /// A signal appears only when the user has chosen for it, and the
    /// whole field is omitted when nothing has — a project that never
    /// met an ambiguity serialises exactly as it did before this
    /// existed. Additive; no schema-version bump.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub signal_dbc_picks: crate::signal_fingerprint::SignalDbcPicks,
}

/// A fresh random project identity. The serde default for
/// [`Project::project_id`]: an older file with no id gains one when it's
/// parsed; [`save_project`] then anchors it so it stays put thereafter.
fn generate_project_id() -> Uuid {
    Uuid::new_v4()
}

/// The `project_id` already recorded in the file at `path`, if it has
/// one. Read directly from the JSON (not a full parse) so it survives
/// even a file this build would otherwise reject on `schema_version`.
/// `None` when the file is absent, unreadable, or carries no valid id —
/// i.e. a brand-new target, which legitimately gets a freshly generated
/// identity.
fn existing_project_id(path: &str) -> Option<Uuid> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("project_id")
        .and_then(serde_json::Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
}

/// Parse project JSON. Accepts only a file whose `schema_version`
/// matches [`PROJECT_SCHEMA_VERSION`]; any other version (or a missing
/// version) is rejected with a user-facing message (ADR 0011). Split
/// from [`open_project`] so the parse is testable without touching the
/// filesystem.
pub(crate) fn parse_project(text: &str) -> Result<Project, String> {
    crate::persisted_json::parse_versioned(text, "project", PROJECT_SCHEMA_VERSION)
}

/// Read and parse a project file. Errors (with a user-facing message)
/// if it can't be read, isn't valid JSON, or has an unsupported schema
/// version (see [`parse_project`]).
///
/// Emits `project`-tagged messages on the system log — `info` on
/// success, `error` on any failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
) -> Result<Project, String> {
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("failed to read project at {path}: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            return Err(msg);
        }
    };
    match parse_project(&text) {
        Ok(p) => {
            // The session moves to this project's own directory
            // (ADR 0042 §1): its `.cannet/` is where the workspace scope
            // resolves from, and its cache is where this project's capture
            // lives. Nothing is carried across — the project that was open
            // keeps its capture where it belongs, and
            // `restore_scratch_capture` (which the frontend calls next)
            // reloads *this* project's from the directory we just moved
            // into, gated on the identity recorded below as always.
            let cache_root = app
                .state::<crate::project_dir::ActiveProjectDir>()
                .cache_root()
                .to_path_buf();
            let dir = crate::project_dir::resolve(Some(Path::new(&path)), &cache_root);
            crate::remember_project_dir(&app, &dir, Some(Path::new(&path)));
            crate::reroot_session(&app, &dir, crate::trace_store::Carry::Nothing);
            // Record the open project's identity (ADR 0002 DS-7). A prior
            // capture belonging to this project is reloaded *separately* by
            // `restore_scratch_capture`, which the frontend calls after it
            // has applied the project and cleared the trace view — so the
            // restored history isn't clobbered by open-clears-the-trace.
            *state.active_project_id() = Some(p.project_id);
            // A simulation the *previous* session armed is not this
            // project's, and no project file can arm one — the RBS Run
            // flag is session state (ADR 0028). Stopping here is what
            // makes "opening a project never transmits" true even when
            // the two projects share element ids.
            crate::rbs::stop_all_elements(&state);
            // Load the host TX-message registry from
            // the project's pool. All periodics start stopped — reopen
            // never fires traffic onto a bus the user hasn't
            // intentionally reconnected.
            state.transmit_frames().load(p.transmit_frames.clone());
            // Same shape for the per-signal database picks: the host
            // owns them because the decoder consumes them, so the open
            // path installs the project's map wholesale.
            *state.signal_dbc_picks() = std::sync::Arc::new(p.signal_dbc_picks.clone());
            // Take up the disk watch on this file, recording the text
            // just read as the content the app has for it (ADR 0053 §1;
            // `crate::project_watch`). Registered here rather than in
            // the frontend so a reload — which is this same command —
            // re-records without a second round trip.
            crate::project_watch::set_open_project(&app, Path::new(&path), text);
            // Usually a no-op here (the frontend re-adds the project's
            // DBCs after open, each add re-resolving), but covers a
            // load into an already-populated DBC set.
            crate::app_state::refresh_calc_resolutions(&app);
            crate::sys_info!(&app, "project", "opened project {path}");
            Ok(p)
        }
        Err(e) => {
            let msg = format!("project at {path}: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            Err(msg)
        }
    }
}

/// Leave the open project: the session goes back to the auto-located
/// project directory an unsaved project belongs in (ADR 0042 §1 and §7
/// — an unsaved project is a project, in a directory cannet chose, not
/// an anonymous mode).
///
/// Without this the session would stay rooted where the project it just
/// left is, and everything workspace-scoped — the layout snapshot, the
/// channel maps, the recent captures — would keep resolving to *that*
/// project's `.cannet/state.json`, which is precisely the cross-project
/// bleed the two scopes exist to prevent.
///
/// The capture does not come along ([`crate::trace_store::Carry`]
/// `Nothing`): a new project starts empty, and the project being left
/// keeps its own capture where it belongs — the same rule as opening a
/// different project.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn close_project(app: tauri::AppHandle, state: tauri::State<'_, crate::app_state::AppState>) {
    let cache_root = app
        .state::<crate::project_dir::ActiveProjectDir>()
        .cache_root()
        .to_path_buf();
    let dir = crate::project_dir::resolve(None, &cache_root);
    crate::remember_project_dir(&app, &dir, None);
    crate::reroot_session(&app, &dir, crate::trace_store::Carry::Nothing);
    // Leaving the project leaves its simulation: Run is session state
    // and a fresh project starts stopped.
    crate::rbs::stop_all_elements(&state);
    // No project file, so no project identity to stamp a capture with,
    // and nothing on disk left to watch.
    *state.active_project_id() = None;
    // The picks belong to the project that is closing, exactly as its
    // view-signal references do; a new project starts with none.
    *state.signal_dbc_picks() = std::sync::Arc::default();
    crate::project_watch::clear_open_project(&app);
    crate::sys_info!(&app, "project", "closed the open project");
}

/// Serialize `project` (pretty-printed) and write it to `path`. Returns
/// the saved file's `project_id` (anchored to the id already on disk, or
/// the freshly generated one for a brand-new file) so the frontend can
/// key per-project state without reopening the file.
///
/// Emits `project`-tagged messages on the system log —
/// `info` on success, `error` on serialise / write failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn save_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
    mut project: Project,
) -> Result<String, String> {
    // Anchor the project identity to the target file: keep the id already
    // on disk, so it stays stable across saves even though the frontend's
    // save payload omits it (the serde default would otherwise mint a new
    // one each time). A brand-new file keeps the freshly generated id.
    if let Some(id) = existing_project_id(&path) {
        project.project_id = id;
    }
    // The host registry is the source of truth for TX
    // messages — the thin-view frontend doesn't carry them in the
    // project it submits. Snapshot the registry into the project before
    // writing so save captures the current pool + order.
    project.transmit_frames = state.transmit_frames().snapshot();
    // Likewise the per-signal database picks: host-owned because the
    // decoder consumes them, and absent from the file entirely when no
    // ambiguity has been resolved.
    project
        .signal_dbc_picks
        .clone_from(state.signal_dbc_picks().as_ref());
    // Through the watch record: the file cannet just wrote *is* the open
    // project file, and the watch has to know that this write was
    // cannet's own rather than announce a change on every Save
    // (ADR 0053 §1, `crate::project_watch`).
    match crate::project_watch::record_own_write(&app, Path::new(&path), || {
        write_project_file(&path, &project)
    }) {
        Ok(()) => {
            crate::sys_info!(&app, "project", "saved project to {path}");
            Ok(project.project_id.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            let msg = format!("failed to serialize project: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            Err(msg)
        }
        Err(e) => {
            let msg = format!("failed to write project to {path}: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            Err(msg)
        }
    }
}

/// Save the project to `path` **and make the directory it lands in a
/// project directory** (ADR 0042 §6, decision 9).
///
/// This is Save As, and it is one of only two places cannet writes a
/// `.cannet/` into storage the user chose — legitimate because they named
/// the destination in a save dialog, an explicit act rather than a
/// consequence of opening something. The destination comes up complete:
/// `.cannet/` with its scope files, the cache link, the `.gitignore`, and
/// the `.cannet_prj` beside it.
///
/// It also **carries the project's contents across**, because the user
/// asked cannet to put the project somewhere and arriving without its data
/// would be a surprise: the workspace-scoped files are copied (into
/// whatever the destination has nothing to say about) and the session
/// re-roots onto the new directory with its capture. Plain Save
/// ([`save_project`]) does none of this — it writes the file and leaves
/// every directory alone.
///
/// Returns the saved file's `project_id`, as [`save_project`] does.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn save_project_as(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
    project: Project,
) -> Result<String, String> {
    let id = save_project(app.clone(), state, path.clone(), project)?;
    // A project file with no parent directory is not a path anything can
    // be rooted in; the file is saved, which is the part the user asked
    // for.
    let Some(root) = Path::new(&path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    else {
        return Ok(id);
    };
    let dest = {
        let active = app.state::<crate::project_dir::ActiveProjectDir>();
        let dest = crate::project_dir::create_at(root, active.cache_root());
        crate::project_dir::carry_workspace_scope(&active.get(), &dest);
        dest
    };
    // The directory this project is leaving stays in the registry: Save As
    // carries the capture but deliberately leaves the derived caches
    // behind (they may still be mapped, and they rebuild), and the cache
    // list is how those bytes are reclaimed.
    crate::remember_project_dir(&app, &dest, Some(Path::new(&path)));
    crate::reroot_session(&app, &dest, crate::trace_store::Carry::Contents);
    Ok(id)
}

/// Serialize and write `project` to `path`, via a temp-file + rename
/// (ADR 0011's persistence contract, shared with the RBS file): a crash
/// or failure partway through the write can't leave a truncated file
/// on disk in place of the last good save. A serialize failure surfaces
/// as [`std::io::ErrorKind::InvalidData`] so the caller can tell it
/// apart from a write failure.
fn write_project_file(path: &str, project: &Project) -> std::io::Result<()> {
    crate::persisted_json::write_json_atomic(Path::new(path), project)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            project_id: generate_project_id(),
            layout: serde_json::json!({ "grid": { "root": {} }, "panels": {} }),
            elements: vec![serde_json::json!({ "kind": "trace", "id": "abc" })],
            buses: vec![Bus {
                id: "p".into(),
                name: "Powertrain".into(),
                speed_bps: Some(500_000),
                fd: Some(false),
                fd_data_speed_bps: None,
                color: Some("#60a5fa".into()),
            }],
            interface_bindings: vec![InterfaceBinding {
                kind: BindingKind::Remote,
                server: "local".into(),
                interface: "pcan:PCAN_USBBUS1(h:0x51, ch:0)".into(),
                bus_id: "p".into(),
            }],
            dbcs: vec![DbcRef {
                path: "/some/where/bus.dbc".into(),
                buses: vec!["p".into()],
            }],
            remote_address: Some("127.0.0.1:50051".into()),
            local_virtual_buses: Vec::new(),
            transmit_frames: Vec::new(),
            signal_colors: std::collections::HashMap::new(),
            signal_dbc_picks: crate::signal_fingerprint::SignalDbcPicks::new(),
        }
    }

    #[test]
    fn a_project_with_no_database_pick_carries_no_such_field() {
        // Owner ruling: the per-signal database pick is *not persisted
        // when not set*. A project that never met an ambiguity has to
        // serialise exactly as it did before the field existed —
        // otherwise every file in existence gains a line that says
        // nothing.
        let text = serde_json::to_string_pretty(&sample()).unwrap();
        assert!(
            !text.contains("signal_dbc_picks"),
            "an empty pick map must not reach the file: {text}"
        );
        // …and a file written without it still parses, to an empty map.
        assert!(parse_project(&text).unwrap().signal_dbc_picks.is_empty());
    }

    #[test]
    fn database_picks_round_trip_when_there_are_any() {
        let mut p = sample();
        p.signal_dbc_picks
            .insert("p|s:256:PackVolts".into(), "/some/where/private.dbc".into());
        let text = serde_json::to_string_pretty(&p).unwrap();
        let parsed = parse_project(&text).unwrap();
        assert_eq!(parsed, p);
        assert_eq!(
            parsed
                .signal_dbc_picks
                .get("p|s:256:PackVolts")
                .map(String::as_str),
            Some("/some/where/private.dbc")
        );
    }

    #[test]
    fn round_trips_through_the_serializer() {
        let p = sample();
        assert_eq!(
            parse_project(&serde_json::to_string_pretty(&p).unwrap()).unwrap(),
            p
        );
    }

    #[test]
    fn parses_the_checked_in_ev_zonal_example_project() {
        // The ev-zonal fixture project (the large-DBC scaling
        // workload) must stay openable: two buses, one relative-path
        // DBC ref scoped to each (ADR 0030 resolves the relative
        // paths frontend-side).
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/ev-zonal/ev-zonal.cannet_prj");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let p = parse_project(&text).expect("fixture project must parse");
        assert_eq!(p.buses.len(), 2);
        assert_eq!(p.dbcs.len(), 2);
        assert!(p.dbcs.iter().all(|d| d.buses.len() == 1));
        assert!(p.dbcs.iter().any(|d| d.path == "dbc/pack.dbc"));
        assert!(p.dbcs.iter().any(|d| d.path == "dbc/zonal.dbc"));
    }

    /// The extrapolation screenshot fixture's project must stay
    /// openable: one bus, one relative-path DBC ref scoped to it, and a
    /// plot element whose single per-unit area carries all seven series
    /// — the four numeric shapes on one unit and the three enum lanes.
    /// A capture run opens this file and photographs that one panel, so
    /// an area that lost a signal is a picture missing a ruled state.
    #[test]
    fn parses_the_checked_in_extrapolation_example_project() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/extrapolation/extrapolation.cannet_prj");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let p = parse_project(&text).expect("fixture project must parse");
        assert_eq!(p.buses.len(), 1);
        assert_eq!(p.dbcs.len(), 1);
        assert_eq!(p.dbcs[0].path, "extrapolation.dbc");
        assert_eq!(p.dbcs[0].buses, vec!["fixture".to_string()]);
        let plot = p
            .elements
            .iter()
            .find(|e| e.get("kind").and_then(serde_json::Value::as_str) == Some("plot"))
            .expect("the fixture carries a plot element");
        let areas = plot
            .get("config")
            .and_then(|c| c.get("areas"))
            .and_then(serde_json::Value::as_array)
            .expect("the plot element carries areas");
        assert_eq!(areas.len(), 1, "every shape shares one area, and one frame");
        assert_eq!(
            areas[0]
                .get("yAxisMode")
                .and_then(serde_json::Value::as_str),
            Some("per-unit"),
            "the shared enum-lanes axis only exists in per-unit mode",
        );
        assert_eq!(
            areas[0]
                .get("signals")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(7),
        );
    }

    /// Read one of the committed example projects, or fail naming it.
    fn parse_example(relative: &str) -> Project {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples")
            .join(relative);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        parse_project(&text).unwrap_or_else(|e| panic!("{relative} must parse: {e}"))
    }

    /// The capture-features project is the hardware-free demo: one bus on
    /// an in-process virtual bus, one deliberately left unbound, and the
    /// shared demo database scoped to both. The virtual bus is what makes
    /// the whole set runnable with no adapter plugged in, and the unbound
    /// one is what a refusal to connect has to name — so a binding that
    /// quietly became a `remote` one, or an `aux` that gained a binding,
    /// would take a demo with it.
    #[test]
    fn parses_the_checked_in_capture_features_example_project() {
        let p = parse_example("capture-features/capture-features.cannet_prj");
        assert_eq!(p.buses.len(), 2);
        assert_eq!(p.local_virtual_buses.len(), 1);
        assert_eq!(p.interface_bindings.len(), 1, "only `main` is bound");
        let binding = &p.interface_bindings[0];
        assert_eq!(binding.kind, BindingKind::LocalVirtualBus);
        assert_eq!(binding.bus_id, "main");
        assert_eq!(
            binding.server,
            format!("{LOCAL_VBUS_URL_SCHEME}{}", p.local_virtual_buses[0].id),
        );
        assert_eq!(binding.interface, LOCAL_VBUS_INTERFACE);
        assert!(
            !p.interface_bindings.iter().any(|b| b.bus_id == "aux"),
            "`aux` is the unbound bus this project exists to show",
        );
        assert_eq!(p.dbcs.len(), 1);
        assert_eq!(p.dbcs[0].path, "../cannet-demo.dbc");
    }

    /// The colliding-database project assigns two databases that disagree
    /// about one arbitration id to a single bus — the ambiguity the
    /// resolution rule settles. Both on the same bus is the whole fixture.
    ///
    /// Its views are also the signal-mapping panel's acceptance script
    /// (the example README's repair walk): the plot references the
    /// contested, renamed and legacy-only signals, and the watch-list
    /// signals view shares `VehSpeed` with the plot — all recorded under
    /// the legacy definitions, which is what every drift is measured
    /// against once the legacy file is unassigned.
    #[test]
    fn parses_the_checked_in_colliding_dbcs_example_project() {
        let p = parse_example("colliding-dbcs/colliding-dbcs.cannet_prj");
        assert_eq!(p.buses.len(), 1);
        assert_eq!(p.dbcs.len(), 2);
        assert!(
            p.dbcs.iter().all(|d| d.buses == vec!["pack".to_string()]),
            "both must land on the same bus or they never collide",
        );

        let plot = p
            .elements
            .iter()
            .find(|e| e.get("kind").and_then(serde_json::Value::as_str) == Some("plot"))
            .expect("the fixture carries a plot element");
        let signals = plot
            .pointer("/config/areas/0/signals")
            .and_then(serde_json::Value::as_array)
            .expect("the plot area carries signals");
        let name = |s: &serde_json::Value| {
            s.get("signalName")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        let names: Vec<_> = signals.iter().filter_map(&name).collect();
        for expected in [
            "VehSpeed",
            "EngineRpm",
            "GearLever",
            "BrakePedal",
            "LegacyHeartbeat",
        ] {
            assert!(
                names.contains(&expected.to_string()),
                "the plot must reference {expected}"
            );
        }
        let veh_speed = signals
            .iter()
            .find(|s| name(s).as_deref() == Some("VehSpeed"))
            .expect("checked above");
        assert_eq!(
            veh_speed.get("unit").and_then(serde_json::Value::as_str),
            Some("km/h"),
            "recorded under the legacy definition, or the Scale drift never shows",
        );

        let watch = p
            .elements
            .iter()
            .find(|e| e.get("kind").and_then(serde_json::Value::as_str) == Some("signals"))
            .expect("the fixture carries the watch-list signals element");
        let key = watch
            .pointer("/config/selection/keys/0")
            .expect("the watch list holds one manual key");
        assert_eq!(
            key.get("signalName").and_then(serde_json::Value::as_str),
            Some("VehSpeed"),
            "shared with the plot, so one repair demonstrably lands on both views",
        );
        assert_eq!(
            key.get("unit").and_then(serde_json::Value::as_str),
            Some("km/h")
        );
    }

    /// The mapping-repair project is the shape of a file with nothing
    /// mapped: a database assigned to nothing, plot series with no bus
    /// behind them, and a persisted `run` flag. Reading it must not give
    /// any of that effect — the assertions here are what the file
    /// *states*, and the behaviour it exists to demonstrate is that none
    /// of it takes effect until the user maps it.
    #[test]
    fn parses_the_checked_in_mapping_repair_example_project() {
        let p = parse_example("mapping-repair/mapping-repair.cannet_prj");
        assert_eq!(p.dbcs.len(), 1);
        assert!(
            p.dbcs[0].buses.is_empty(),
            "a database assigned to nothing decodes nothing",
        );
        assert_eq!(p.transmit_frames.len(), 1);
        assert_eq!(
            p.transmit_frames[0].mode,
            crate::transmit_frames::TransmitMode::Periodic,
        );

        let plot = p
            .elements
            .iter()
            .find(|e| e.get("kind").and_then(serde_json::Value::as_str) == Some("plot"))
            .expect("the fixture carries a plot element");
        let signals = plot
            .pointer("/config/areas/0/signals")
            .and_then(serde_json::Value::as_array)
            .expect("the plot area carries signals");
        assert!(
            signals
                .iter()
                .all(|s| s.get("busId") == Some(&serde_json::Value::Null)),
            "every series must carry the null bus the mapping panel repairs",
        );
    }

    #[test]
    fn parse_defaults_the_optional_fields() {
        let p = parse_project(r#"{"schema_version": 7, "layout": {"grid": {}, "panels": {}}}"#)
            .unwrap();
        assert!(p.elements.is_empty());
        assert!(p.dbcs.is_empty());
        assert!(p.buses.is_empty());
        assert!(p.interface_bindings.is_empty());
        assert_eq!(p.remote_address, None);
    }

    #[test]
    fn parse_generates_a_project_id_when_the_file_has_none() {
        // An older file without the field gains a fresh id on read, and
        // two reads of the same id-less text get *distinct* ids (it's
        // generated, not a fixed default).
        let text = r#"{"schema_version": 7, "layout": {"grid": {}, "panels": {}}}"#;
        let a = parse_project(text).unwrap().project_id;
        let b = parse_project(text).unwrap().project_id;
        assert_ne!(a, Uuid::nil());
        assert_ne!(a, b);
    }

    #[test]
    fn parse_preserves_an_explicit_project_id() {
        let id = Uuid::new_v4();
        let text = format!(
            r#"{{"schema_version": 7, "project_id": "{id}", "layout": {{"grid": {{}}, "panels": {{}}}}}}"#
        );
        assert_eq!(parse_project(&text).unwrap().project_id, id);
        // And it survives a serialize → parse round-trip.
        let p = parse_project(&text).unwrap();
        assert_eq!(
            parse_project(&serde_json::to_string(&p).unwrap())
                .unwrap()
                .project_id,
            id
        );
    }

    /// Regression test for the non-atomic project save:
    /// `save_project` used to `std::fs::write` straight to the
    /// target path, so a write failure partway could leave a corrupted
    /// project file in place of the last good save. Force the write to
    /// fail by blocking the temp-file step (a directory sits where the
    /// `.tmp` sibling needs to go) and confirm the original, valid file
    /// on disk is left completely untouched.
    #[test]
    fn save_leaves_the_original_file_untouched_when_the_write_fails() {
        let dir = std::env::temp_dir().join(format!("cannet-save-atomic-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.cannet_prj");
        let original = serde_json::to_string_pretty(&sample()).unwrap();
        std::fs::write(&path, &original).unwrap();

        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        std::fs::create_dir(&tmp).unwrap();

        let result = write_project_file(path.to_str().unwrap(), &sample());

        assert!(
            result.is_err(),
            "the write must fail when the temp file can't be created"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "a failed save must not touch the previously-saved file"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_project_id_reads_back_a_recorded_id_and_none_otherwise() {
        let dir = std::env::temp_dir().join(format!("cannet-pid-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = Uuid::new_v4();
        let with_id = dir.join("p.cannet_prj");
        std::fs::write(
            &with_id,
            format!(r#"{{"schema_version": 7, "project_id": "{id}", "layout": {{}}}}"#),
        )
        .unwrap();
        assert_eq!(
            existing_project_id(with_id.to_str().unwrap()),
            Some(id),
            "an on-disk id is recovered"
        );
        // A file with no id, and an absent file, both yield None — a
        // brand-new target that legitimately mints its own identity.
        let no_id = dir.join("q.cannet_prj");
        std::fs::write(&no_id, r#"{"schema_version": 7, "layout": {}}"#).unwrap();
        assert_eq!(existing_project_id(no_id.to_str().unwrap()), None);
        assert_eq!(
            existing_project_id(dir.join("absent.cannet_prj").to_str().unwrap()),
            None
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A virtual-bus definition + a binding pointing at it round-trip
    /// through serialize + parse. The vbus owns the config/bridges;
    /// the binding only references the vbus by id.
    #[test]
    fn local_virtual_bus_definition_and_binding_round_trip() {
        let p = Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            project_id: generate_project_id(),
            layout: serde_json::json!({"grid": {}, "panels": {}}),
            elements: vec![],
            buses: vec![Bus {
                id: "v".into(),
                name: "Test virtual".into(),
                speed_bps: Some(500_000),
                fd: Some(true),
                fd_data_speed_bps: Some(2_000_000),
                color: None,
            }],
            interface_bindings: vec![InterfaceBinding {
                kind: BindingKind::LocalVirtualBus,
                server: format!("{LOCAL_VBUS_URL_SCHEME}vbus1"),
                interface: LOCAL_VBUS_INTERFACE.into(),
                bus_id: "v".into(),
            }],
            dbcs: vec![],
            remote_address: None,
            local_virtual_buses: vec![LocalVirtualBusDef {
                id: "vbus1".into(),
                name: "Bench".into(),
                bridges: vec![BridgeSpec {
                    remote_address: "local".into(),
                    interface: "pcan:PCAN_USBBUS1(h:0x51, ch:0)".into(),
                    name: "hw".into(),
                }],
            }],
            transmit_frames: Vec::new(),
            signal_colors: std::collections::HashMap::new(),
            signal_dbc_picks: crate::signal_fingerprint::SignalDbcPicks::new(),
        };
        let text = serde_json::to_string_pretty(&p).unwrap();
        let parsed = parse_project(&text).unwrap();
        assert_eq!(parsed, p);
    }

    /// v5 round-trips a binding that uses the `"local"` sentinel
    /// verbatim — i.e. saving and reloading doesn't drop or rewrite
    /// the sentinel.
    #[test]
    fn local_sentinel_round_trips_through_serialize_and_parse() {
        let p = Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            project_id: generate_project_id(),
            layout: serde_json::json!({"grid": {}, "panels": {}}),
            elements: vec![],
            buses: vec![Bus {
                id: "p".into(),
                name: "Powertrain".into(),
                speed_bps: None,
                fd: None,
                fd_data_speed_bps: None,
                color: None,
            }],
            interface_bindings: vec![InterfaceBinding {
                kind: BindingKind::Remote,
                server: "local".into(),
                interface: "pcan:PCAN_USBBUS1(h:0x51, ch:0)".into(),
                bus_id: "p".into(),
            }],
            dbcs: vec![],
            remote_address: None,
            local_virtual_buses: Vec::new(),
            transmit_frames: Vec::new(),
            signal_colors: std::collections::HashMap::new(),
            signal_dbc_picks: crate::signal_fingerprint::SignalDbcPicks::new(),
        };
        let text = serde_json::to_string_pretty(&p).unwrap();
        let parsed = parse_project(&text).unwrap();
        assert_eq!(parsed, p);
        assert_eq!(parsed.interface_bindings[0].server, "local");
    }

    #[test]
    fn parse_rejects_an_unsupported_schema_version() {
        // A future version, the long-since-superseded v1, and the
        // pre-current versions that used to migrate (v2–v6) — all are
        // rejected now that the migrators are gone (ADR 0011).
        assert!(parse_project(r#"{"schema_version": 999, "layout": {}}"#).is_err());
        assert!(parse_project(r#"{"schema_version": 1, "layout": {}}"#).is_err());
        for v in 2..=6 {
            assert!(
                parse_project(&format!(r#"{{"schema_version": {v}, "layout": {{}}}}"#)).is_err(),
                "schema version {v} should be rejected, not migrated"
            );
        }
        assert!(
            parse_project(r#"{"layout": {}}"#).is_err(),
            "missing version"
        );
        assert!(parse_project("not json").is_err());
    }

    /// `open_project` itself takes a `tauri::AppHandle` (system-log
    /// fanout), so the "missing file" path is exercised
    /// here against the underlying helper: a missing path yields a
    /// `std::io::Error` that the command then wraps with a
    /// user-facing prefix. The wrapping is trivial; this test guards
    /// the read step itself.
    #[test]
    fn missing_file_surfaces_as_an_io_error() {
        assert!(std::fs::read_to_string("/no/such/cannet-project.json").is_err());
    }
}
