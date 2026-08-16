//! Vendor-driver sidecar lifecycle, GUI-host side.
//!
//! At startup the host spawns the `cannet-python-can` sidecar (a
//! Python process that uses `python-can` to enumerate Vector,
//! Kvaser, and PEAK hardware). The sidecar speaks the same `.proto`
//! as `cannet-server`; supervising it — spawning, parsing its banner,
//! restarting it within a budget, holding its stdin open so it dies
//! with us — is [`cannet_sidecar`]'s job, shared with the server.
//!
//! What lives here is the half only a Tauri app can answer, expressed
//! as that crate's `SidecarHost`: `settings.json` and the escape-hatch
//! environment variables on the way in; System Messages tagged
//! [`SOURCE`], the [`STATUS_EVENT`] the connection panel listens for,
//! and the interface watch on the way out.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_sidecar::{env_over_setting, Resolved, SidecarConfig, SidecarHost, SidecarSupervisor};
pub use cannet_sidecar::{SIDECAR_LOG_FILE, SOURCE};

use crate::system_log::LogLevel;
use crate::{emit_system_log, sys_debug, sys_error, sys_info, sys_warn};

/// The shared crate's classification of a sidecar line, said in the
/// host's own [`LogLevel`] ladder. Same four levels, so this is a
/// rename and never a judgement call.
fn host_level(level: cannet_sidecar::LogLevel) -> LogLevel {
    match level {
        cannet_sidecar::LogLevel::Debug => LogLevel::Debug,
        cannet_sidecar::LogLevel::Info => LogLevel::Info,
        cannet_sidecar::LogLevel::Warn => LogLevel::Warn,
        cannet_sidecar::LogLevel::Error => LogLevel::Error,
    }
}

/// Tauri event name fired on every transition between [`SidecarPhase`]
/// states (including bound-address changes). Frontend subscribers
/// re-fetch with [`get_sidecar_status`] after listening — the payload
/// is the same struct the command returns.
pub const STATUS_EVENT: &str = "sidecar-status-changed";

/// Per-app state: the supervisor that owns the sidecar's process,
/// counters, and published status. A newtype rather than the
/// supervisor itself so Tauri's managed-state lookup is keyed on a
/// name that says what it is here.
#[derive(Default)]
pub struct SidecarState {
    supervisor: Arc<SidecarSupervisor>,
}

/// Coarse lifecycle of the sidecar process, in the shape the frontend
/// reads it. A mirror of [`cannet_sidecar::SidecarPhase`] rather than
/// a re-export because the serialized names are this app's contract
/// with its own frontend (`types.ts`), not the supervisor's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarPhase {
    /// No child has been spawned in this session yet, or the last
    /// child exited and we are not currently spawning a replacement.
    #[default]
    Offline,
    /// A child has been spawned and we are waiting for its
    /// `listening` banner. The GUI shows this as "starting…".
    Starting,
    /// The child has reported its bound address; ready to accept
    /// `connect_remote_server`.
    Ready,
}

/// Wire-shape for [`get_sidecar_status`] and [`STATUS_EVENT`]. Kept in
/// one place so the Tauri command and the event always agree, since
/// the frontend uses the event as a "refetch now" prompt.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub phase: SidecarPhase,
    /// `Some(host:port)` once the sidecar has reported its bound
    /// address. The frontend feeds this straight into
    /// `connect_remote_server` — replacing the hard-coded 50061 the
    /// project bindings previously assumed.
    pub address: Option<String>,
}

/// The supervisor's status in the frontend's shape.
fn wire_status(status: &cannet_sidecar::SidecarStatus) -> SidecarStatus {
    SidecarStatus {
        phase: match status.phase {
            cannet_sidecar::SidecarPhase::Offline => SidecarPhase::Offline,
            cannet_sidecar::SidecarPhase::Starting => SidecarPhase::Starting,
            cannet_sidecar::SidecarPhase::Ready => SidecarPhase::Ready,
        },
        address: status.address.clone(),
    }
}

/// Absolute path to the frozen sidecar launcher inside the Tauri
/// resource directory, or `None` if the frozen artifact isn't present
/// (the developer flow). Resolved through Tauri's framework-canonical
/// `resource_dir()` -- not the exe walk-up the dev paths use -- because
/// on macOS the bundled resources live in `Contents/Resources/`, a
/// sibling of the exe's `Contents/MacOS/` and never an ancestor (see
/// ADR 0036). Which is why the shared crate cannot resolve it: only a
/// Tauri app knows where a Tauri app keeps its resources.
///
/// Not unit-tested: it needs a live `AppHandle` to reach
/// `resource_dir()`, which can't be constructed in a plain unit test.
/// Its two moving parts — the platform suffix and the "no args" launch
/// shape — are covered in [`cannet_sidecar`].
fn frozen_launcher_path(app: &AppHandle) -> Option<PathBuf> {
    let launcher = app
        .path()
        .resource_dir()
        .ok()?
        .join("cannet-python-can")
        .join(cannet_sidecar::frozen_launcher_name());
    launcher.is_file().then_some(launcher)
}

/// Where to tell the sidecar to write its logfile, creating the
/// directory if it isn't there yet (the sidecar creates it too, but the
/// host knows the path first and a missing directory is the one failure
/// mode that would silently cost the whole log). `None` — and no
/// `--log-file` argument — when the directory can't be created, since a
/// sidecar that serves hardware without a logfile beats one that
/// doesn't start.
///
/// The file is a sibling of the host's own [`crate::crash::LOG_FILE`]
/// in the same per-OS log directory — one place to look, and one
/// directory to attach to a bug report.
fn sidecar_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::crash::log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        sys_warn!(
            app,
            SOURCE,
            "could not create the log directory {}: {e}; the sidecar will not write a logfile",
            dir.display()
        );
        return None;
    }
    Some(dir.join(SIDECAR_LOG_FILE))
}

/// Where to look for the `cannet-python-can` package: the
/// [`cannet_sidecar::SIDECAR_DIR_ENV`] variable, else the `sidecar_dir`
/// setting, else nowhere (the shared crate's walk-up applies).
fn sidecar_dir_override() -> Resolved {
    env_over_setting(
        cannet_sidecar::SIDECAR_DIR_ENV,
        "sidecar_dir",
        std::env::var_os(cannet_sidecar::SIDECAR_DIR_ENV),
        &crate::settings::effective().sidecar_dir,
    )
}

/// Which driver module the sidecar should load: the
/// [`cannet_sidecar::DRIVER_MODULE_ENV`] variable already in the host's
/// environment, else the `driver_module` setting, else nothing (the
/// sidecar's own default).
fn driver_module_override() -> Resolved {
    env_over_setting(
        cannet_sidecar::DRIVER_MODULE_ENV,
        "driver_module",
        std::env::var_os(cannet_sidecar::DRIVER_MODULE_ENV),
        &crate::settings::effective().driver_module,
    )
}

/// This app as the supervisor's host.
fn host(app: &AppHandle) -> Arc<dyn SidecarHost> {
    Arc::new(GuiSidecarHost { app: app.clone() })
}

/// The GUI's half of the sidecar contract: `settings.json` plus the
/// escape-hatch environment variables on the way in, System Messages
/// and the connection panel's status row on the way out. Everything
/// else about running a sidecar is [`cannet_sidecar`]'s.
struct GuiSidecarHost {
    app: AppHandle,
}

impl SidecarHost for GuiSidecarHost {
    fn config(&self) -> SidecarConfig {
        let sidecar_dir = sidecar_dir_override();
        let driver_module = driver_module_override();
        for note in [&sidecar_dir.shadowed, &driver_module.shadowed]
            .into_iter()
            .flatten()
        {
            sys_warn!(&self.app, SOURCE, "{note}");
        }
        SidecarConfig {
            frozen_launcher: frozen_launcher_path(&self.app),
            // Tauri emits the `dev` cfg for `tauri dev`, where the
            // editable source tree must win over the frozen resource
            // bundled beside the dev binary (ADR 0036).
            prefer_source_tree: cfg!(dev),
            sidecar_dir: sidecar_dir.value,
            log_level: crate::settings::effective().sidecar_log_level.clone(),
            log_file: sidecar_log_file(&self.app),
            driver_module: driver_module.value,
        }
    }

    fn log(&self, level: cannet_sidecar::LogLevel, message: String) {
        // Through the macros, not `emit_system_log`, so these lifecycle
        // lines keep their `tracing` mirror to dev stderr.
        match level {
            cannet_sidecar::LogLevel::Debug => sys_debug!(&self.app, SOURCE, "{message}"),
            cannet_sidecar::LogLevel::Info => sys_info!(&self.app, SOURCE, "{message}"),
            cannet_sidecar::LogLevel::Warn => sys_warn!(&self.app, SOURCE, "{message}"),
            cannet_sidecar::LogLevel::Error => sys_error!(&self.app, SOURCE, "{message}"),
        }
    }

    fn log_sidecar_output(&self, level: cannet_sidecar::LogLevel, message: String) {
        // Straight to the ring, skipping the `tracing` mirror the
        // lifecycle lines get: this is every line the child writes, at
        // whatever rate it writes them.
        emit_system_log(&self.app, SOURCE, host_level(level), message);
    }

    fn restart_budget(&self) -> u64 {
        crate::settings::effective().sidecar_restart_budget
    }

    fn status_changed(
        &self,
        previous: &cannet_sidecar::SidecarStatus,
        current: &cannet_sidecar::SidecarStatus,
    ) {
        let _ = self.app.emit(STATUS_EVENT, wire_status(current));
        // Lifecycle drives the local-address watch. The subscription
        // manager itself lives in `interfaces.rs`; this just decides
        // which transitions add or remove the local address from its
        // managed set.
        let ready =
            |s: &cannet_sidecar::SidecarStatus| s.phase == cannet_sidecar::SidecarPhase::Ready;
        match (ready(previous), ready(current)) {
            (false, true) => {
                if let Some(addr) = current.address.clone() {
                    crate::interfaces::watch(&self.app, addr);
                }
            }
            (true, false) => {
                if let Some(addr) = &previous.address {
                    crate::interfaces::unwatch(&self.app, addr);
                }
            }
            // A restart re-binds an ephemeral port, so `Ready` to
            // `Ready` at a new address has to move the watch across.
            (true, true) if previous.address != current.address => {
                if let Some(addr) = &previous.address {
                    crate::interfaces::unwatch(&self.app, addr);
                }
                if let Some(addr) = current.address.clone() {
                    crate::interfaces::watch(&self.app, addr);
                }
            }
            _ => {}
        }
    }

    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send + 'static>) {
        tauri::async_runtime::spawn_blocking(task);
    }
}

/// Spawn the sidecar in the background. Safe to call from `setup`; on
/// success the child runs until shutdown or crash, and every lifecycle
/// event is published as a System Message tagged [`SOURCE`].
///
/// Auto-restart on crash, capped by the `sidecar_restart_budget`
/// setting.
pub fn spawn_sidecar(app: &AppHandle) {
    // The supervisor is managed state, installed before `setup` runs,
    // so the `None` arm is unreachable in a built app — and a missing
    // one is nothing this call can fix.
    if let Some(state) = app.try_state::<SidecarState>() {
        state.supervisor.spawn(&host(app));
    }
}

/// The address this app's own sidecar is listening on, when it has
/// reported one. `None` before the banner is parsed and after the child
/// exits.
///
/// The one way anything else in the host can tell "our sidecar" from a
/// server at some loopback address: the port is the OS's pick for this
/// launch, so nothing but the supervisor knows it.
pub(crate) fn bound_address(app: &AppHandle) -> Option<String> {
    app.try_state::<SidecarState>()
        .and_then(|state| state.supervisor.status().address)
}

/// Tauri command — snapshot the current sidecar status. The
/// connection panel calls this on mount to pick up the address the
/// host learned before the panel listened for [`STATUS_EVENT`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_sidecar_status(state: State<'_, SidecarState>) -> SidecarStatus {
    wire_status(&state.supervisor.status())
}

/// Manual restart, exposed to the frontend as a Tauri command. Clears
/// the crash counter so the user gets the full retry budget again,
/// then kills the previous child before spawning a replacement (see
/// [`cannet_sidecar::SidecarSupervisor::restart`]).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn restart_sidecar(app: AppHandle, state: State<'_, SidecarState>) {
    state.supervisor.restart(&host(&app));
}
