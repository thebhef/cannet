//! Finding a sidecar to run, and building the `Command` that runs it.
//!
//! Everything here stops short of spawning: the discovery chain, the
//! per-flavour command shapes, and the settings the host applies to
//! whichever flavour won. See the crate root for the launch strategy
//! this implements.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{LogLevel, SidecarHost};

/// The environment variable that names the sidecar package directory —
/// the escape hatch a host's persistent `sidecar_dir` setting is the
/// non-volatile form of.
pub const SIDECAR_DIR_ENV: &str = "CANNET_SIDECAR_DIR";

/// The environment variable the *sidecar* reads to pick its driver
/// implementation. Must match `helpers.DRIVER_MODULE_ENV` in the Python
/// sidecar; the host forwards its resolved `driver_module` to the child
/// through it.
pub const DRIVER_MODULE_ENV: &str = "CANNET_DRIVER_MODULE";

/// Which **developer-machine** launcher to use. The frozen end-user
/// path is resolved separately (the host hands it over in
/// [`SidecarConfig::frozen_launcher`] → [`build_frozen_command`]) and
/// never routed through this enum, so its variants are exactly the dev
/// fallbacks. They exist as discrete states so the launcher can tell
/// the user what flow they just got — the log line is different per
/// branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchPath {
    /// Bundled `uv` binary under `tools/uv/...` next to the host binary.
    BundledUv,
    /// `uv` resolved through `PATH`.
    PathUv,
    /// `python3 -m cannet_python_can` — last-resort fallback when
    /// `uv` is not available.
    SystemPython,
}

/// The resolved launch decision: which flavour of sidecar to run,
/// with everything needed to build its `Command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchPlan {
    /// Run the frozen self-contained launcher at this path.
    Frozen(PathBuf),
    /// Run a developer launcher against this sidecar source directory.
    Source(LaunchPath, PathBuf),
}

/// Everything a host decides about *its* sidecar, resolved fresh for
/// each spawn attempt. The crate owns how a sidecar is found and run;
/// the host owns where these values come from — its settings file, its
/// CLI flags, its resource directory.
pub struct SidecarConfig {
    /// Absolute path to the frozen self-contained launcher, or `None`
    /// when the frozen artifact isn't present (the developer flow).
    /// Resolving it is the host's job because only the host knows how
    /// its own resources are laid out — on macOS a Tauri bundle puts
    /// them in `Contents/Resources/`, never above the executable
    /// (ADR 0036).
    pub frozen_launcher: Option<PathBuf>,
    /// Prefer the editable sidecar source tree over the frozen binary.
    /// Dev builds set this so edits to `servers/cannet-python-can` take
    /// effect on the next sidecar restart without re-freezing; release
    /// builds leave it `false` (ADR 0036).
    pub prefer_source_tree: bool,
    /// Where the `cannet-python-can` package directory is, when the
    /// host was told; `None` lets the walk-up from the host binary
    /// find it.
    pub sidecar_dir: Option<OsString>,
    /// The sidecar's own `--log-level`, governing how much it writes
    /// to stderr — which is what the host turns into log lines.
    pub log_level: String,
    /// Where the sidecar writes its rolling, **always-debug** logfile
    /// ([`crate::SIDECAR_LOG_FILE`]). `None` means "don't write one",
    /// which is also the sidecar's own default.
    pub log_file: Option<PathBuf>,
    /// Which driver module the sidecar should load, forwarded through
    /// [`DRIVER_MODULE_ENV`]. `None` leaves the child environment
    /// alone so the sidecar uses its own default.
    pub driver_module: Option<OsString>,
}

/// Pick between the frozen binary and the source tree, given what's
/// actually resolvable. Dev builds prefer the editable source tree so
/// edits to `servers/cannet-python-can` take effect on the next
/// sidecar restart without re-freezing — the frozen artifact is
/// bundled as a resource even in dev, and would otherwise shadow
/// them. Release builds prefer the frozen binary (ADR 0036). Either
/// way the other flavour is the fallback. Pure; testable.
pub(crate) fn plan_launch(
    prefer_source_tree: bool,
    frozen: Option<PathBuf>,
    source: Option<(LaunchPath, PathBuf)>,
) -> Option<LaunchPlan> {
    let frozen = frozen.map(LaunchPlan::Frozen);
    let source = source.map(|(launcher, dir)| LaunchPlan::Source(launcher, dir));
    if prefer_source_tree {
        source.or(frozen)
    } else {
        frozen.or(source)
    }
}

/// Resolve which developer launcher to use without spawning the child
/// yet. Split out so tests can inspect the choice without touching the
/// process table.
pub(crate) fn resolve_launch_path() -> Option<LaunchPath> {
    if bundled_uv_path().is_some() {
        return Some(LaunchPath::BundledUv);
    }
    if which_uv().is_some() {
        return Some(LaunchPath::PathUv);
    }
    if which_python().is_some() {
        return Some(LaunchPath::SystemPython);
    }
    None
}

/// Build the `Command` for a given launch path. Pure; no spawning
/// happens here. `sidecar_dir` is the absolute path to the
/// `cannet-python-can` package directory — see [`resolve_sidecar_dir`]
/// for how it is obtained.
///
/// No `--bind` is passed: the sidecar's own default is `127.0.0.1:0`
/// (let the OS pick a free ephemeral port), and the actual address is
/// read back from the `sidecar\tlistening\t<addr>` banner. Hard-coding
/// a port here would just re-create the "stale instance holds 50061"
/// failure mode the random-port selection was added to fix.
pub(crate) fn build_command(launcher: LaunchPath, sidecar_dir: &Path) -> Command {
    match launcher {
        LaunchPath::BundledUv => {
            let mut cmd = Command::new(bundled_uv_path().expect("local uv pre-checked"));
            cmd.arg("--directory").arg(sidecar_dir);
            cmd.args(["run", "cannet-python-can"]);
            cmd
        }
        LaunchPath::PathUv => {
            let mut cmd = Command::new("uv");
            cmd.arg("--directory").arg(sidecar_dir);
            cmd.args(["run", "cannet-python-can"]);
            cmd
        }
        LaunchPath::SystemPython => {
            let mut cmd = Command::new(which_python().unwrap_or_else(|| PathBuf::from("python3")));
            cmd.env("PYTHONPATH", sidecar_dir);
            cmd.args(["-m", "cannet_python_can"]);
            cmd
        }
    }
}

/// The frozen launcher's file name — platform-suffixed to match what
/// `PyInstaller` emits (`.exe` on Windows, bare elsewhere). Public
/// because the *host* resolves the directory the launcher sits in (a
/// Tauri resource dir, an archive layout), and needs the file name to
/// finish the path.
pub fn frozen_launcher_name() -> &'static str {
    if cfg!(windows) {
        "cannet-python-can.exe"
    } else {
        "cannet-python-can"
    }
}

/// Build the `Command` for the frozen self-contained launcher. Pure;
/// no spawning. The frozen onedir bundles its own interpreter and deps,
/// so unlike the dev paths there is no `--directory` / `PYTHONPATH` /
/// `--bind` -- the sidecar's own `127.0.0.1:0` default still applies and
/// the bound address is read back from the `listening` banner.
pub(crate) fn build_frozen_command(launcher: &Path) -> Command {
    Command::new(launcher)
}

/// Apply the host-resolved sidecar configuration to an already-built
/// command, whichever launcher flavour built it — the frozen binary and
/// the dev launchers differ in how they *find* the sidecar, not in how
/// it is configured, so this is stated once here rather than in each
/// `build_*_command`.
///
/// `log_level` is the sidecar's own `--log-level`. It governs how much
/// the sidecar writes to stderr, which is what
/// [`crate::classify_stderr_line`] turns into host log lines — so it is
/// the verbosity of everything the sidecar contributes to a log a user
/// ships back.
///
/// `driver_module` is forwarded as [`DRIVER_MODULE_ENV`], which the
/// sidecar reads to pick its driver implementation; `None` leaves the
/// child environment alone so the sidecar uses its own default.
///
/// `log_file` is the sidecar's own rolling, **always-debug** logfile. It
/// is a separate sink from stderr, on purpose: stderr stays at
/// `log_level`, while the file records every gRPC command with its
/// arguments and outcome plus every driver traceback — the detail a
/// per-channel connect failure needs after the fact, without making the
/// host's log noisier for everyone. `None` means "don't write one",
/// which is also the sidecar's own default when the flag is absent.
///
/// `--bind` is still deliberately not passed — see [`build_command`].
pub(crate) fn apply_settings(
    cmd: &mut Command,
    log_level: &str,
    log_file: Option<&Path>,
    driver_module: Option<&OsStr>,
) {
    cmd.arg("--log-level").arg(log_level);
    if let Some(path) = log_file {
        cmd.arg("--log-file").arg(path);
    }
    if let Some(module) = driver_module {
        cmd.env(DRIVER_MODULE_ENV, module);
    }
}

/// Windows: suppress the console window a console-subsystem child would
/// otherwise pop up. A GUI host is built `windows_subsystem = "windows"`,
/// so it has no console of its own; spawning a console-subsystem
/// executable — the frozen `PyInstaller` launcher, or `uv`/`python` on the
/// dev paths — makes Windows allocate a fresh console window for it.
/// `CREATE_NO_WINDOW` runs the child with no console at all;
/// stdin/stdout/stderr are piped regardless, so the tab-separated banner
/// protocol is unaffected. No-op off Windows, where a console app never
/// spawns a stray window.
#[cfg_attr(
    not(windows),
    allow(unused_variables, clippy::needless_pass_by_ref_mut)
)]
pub(crate) fn suppress_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW from winbase.h; inlined to avoid a whole
        // winapi dependency for a single constant.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// What an environment-versus-setting resolution decided.
pub struct Resolved {
    /// The effective value; `None` when neither source said anything,
    /// so the built-in behaviour applies.
    pub value: Option<OsString>,
    /// The line to put on the host's log when the environment shadowed
    /// a value the host's settings show. `None` when nothing was
    /// shadowed.
    pub shadowed: Option<String>,
}

/// Precedence between an environment variable and its persisted-setting
/// equivalent: **the environment wins**, and the shadowed setting is
/// reported rather than silently dropped.
///
/// The env vars predate the settings and exist as escape hatches — for
/// tests, CI, packaging experiments, and deployment shapes nobody
/// foresaw. An escape hatch a persisted file can override is not an
/// escape hatch; and harnesses already drive cannet by setting these,
/// so a settings file must not quietly change what such a run does.
/// The setting is therefore the *persistent default* that the
/// environment overrides for one run.
///
/// The cost of that order is that a settings file can show a value the
/// process is not using, which ADR 0034 does not let pass silently —
/// hence [`Resolved::shadowed`], which the caller puts on its log, the
/// same treatment a refused value gets.
///
/// Blank means "nothing here" on both sides, so an empty env var falls
/// through to the setting rather than resolving to an empty path.
pub fn env_over_setting(var: &str, key: &str, env: Option<OsString>, setting: &str) -> Resolved {
    let setting = setting.trim();
    let from_setting = (!setting.is_empty()).then(|| OsString::from(setting));
    let from_env = env.filter(|v| !v.is_empty());
    match from_env {
        Some(value) => {
            let shadowed = from_setting.is_some().then(|| {
                format!(
                    "{var}={} in the environment overrides the {key} setting (\"{setting}\") \
                     for this run",
                    value.to_string_lossy()
                )
            });
            Resolved {
                value: Some(value),
                shadowed,
            }
        }
        None => Resolved {
            value: from_setting,
            shadowed: None,
        },
    }
}

/// Resolve the absolute path to the `cannet-python-can` package
/// directory, deliberately **independent of the host's CWD**.
///
/// Resolution order (first hit wins):
///
/// 1. **`override_dir`** — what the host resolved from the
///    [`SIDECAR_DIR_ENV`] variable and its own `sidecar_dir` setting.
///    Used verbatim; if it's a non-existent path, the launcher will
///    surface the resulting spawn failure.
/// 2. **Walk up from the host binary's location** looking for
///    `pyproject.toml` under either:
///    - `<ancestor>/servers/cannet-python-can/` (dev / `cargo build`
///      layouts — workspace root is somewhere above `target/`), or
///    - `<ancestor>/cannet-python-can/` (production layout — the
///      sidecar source sits next to the host binary inside the
///      bundle).
///
///    Capped at 8 ancestors so a misconfigured deployment fails
///    loudly instead of crawling the filesystem.
///
/// The returned path is the directory containing `pyproject.toml`,
/// suitable for `uv --directory <path>` or `PYTHONPATH=<path>`.
pub(crate) fn resolve_sidecar_dir(override_dir: Option<OsString>) -> Option<PathBuf> {
    if let Some(override_dir) = override_dir {
        return Some(PathBuf::from(override_dir));
    }
    let exe = std::env::current_exe().ok()?;
    let mut cursor = exe.parent()?.to_path_buf();
    for _ in 0..8 {
        // Dev / workspace layout.
        let nested = cursor.join("servers").join("cannet-python-can");
        if nested.join("pyproject.toml").is_file() {
            return Some(nested);
        }
        // Production "next to the binary" layout.
        let sibling = cursor.join("cannet-python-can");
        if sibling.join("pyproject.toml").is_file() {
            return Some(sibling);
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

/// Where [`resolve_sidecar_dir`] looked, formatted for the host's log
/// so the user can see what we tried.
fn sidecar_dir_search_summary() -> String {
    let exe = std::env::current_exe().map_or_else(
        |e| format!("<current_exe failed: {e}>"),
        |p| p.display().to_string(),
    );
    format!(
        "{SIDECAR_DIR_ENV} and the sidecar_dir setting (both unset) → walk up from {exe} looking for `servers/cannet-python-can/pyproject.toml` or `cannet-python-can/pyproject.toml`"
    )
}

fn bundled_uv_path() -> Option<PathBuf> {
    // Resolved relative to the host binary directory. A real bundle
    // will sit it alongside the executable; in development
    // (cargo run) it'll be next to the workspace `target/`, which is
    // also fine for the developer flow.
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = exe_dir.join("tools").join("uv").join(uv_filename());
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn uv_filename() -> &'static str {
    if cfg!(windows) {
        "uv.exe"
    } else {
        "uv"
    }
}

fn which_uv() -> Option<PathBuf> {
    which_binary(if cfg!(windows) { "uv.exe" } else { "uv" })
}

fn which_python() -> Option<PathBuf> {
    which_binary("python3").or_else(|| which_binary("python"))
}

fn which_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Resolve the sidecar invocation to a ready-to-spawn [`Command`] plus
/// a human-readable "source" line for the invocation summary (there is
/// no `sidecar_dir` on the frozen path, so the frozen and dev branches
/// converge here and share the whole spawn tail). Frozen-vs-source
/// preference comes from [`SidecarConfig::prefer_source_tree`].
/// `None` — after logging an
/// error-level line through the host — when neither flavour resolves.
///
/// The command is fully configured but not spawned: stdio is the
/// caller's to set, because the piped-stdin parent-death contract is
/// the supervisor's business.
pub fn resolve_command(host: &dyn SidecarHost) -> Option<(Command, String)> {
    let config = host.config();
    let launcher = resolve_launch_path();
    let configure = |mut cmd: Command| {
        apply_settings(
            &mut cmd,
            &config.log_level,
            config.log_file.as_deref(),
            config.driver_module.as_deref(),
        );
        // Keep the console-subsystem child from popping a terminal
        // window (Windows only); stdio is piped by the supervisor
        // regardless, so the banner protocol still works.
        suppress_console_window(&mut cmd);
        cmd
    };
    // Resolve the sidecar source directory to an absolute path
    // BEFORE we build the command — uv's `--directory` and Python's
    // `PYTHONPATH` are then independent of whatever CWD the host was
    // launched with. The previous relative-path version blew up with
    // a terse "No such file or directory" any time the host's CWD
    // wasn't the workspace root.
    let source = launcher.zip(resolve_sidecar_dir(config.sidecar_dir.clone()));
    match plan_launch(
        config.prefer_source_tree,
        config.frozen_launcher.clone(),
        source,
    ) {
        Some(LaunchPlan::Frozen(path)) => {
            host.log(
                LogLevel::Debug,
                "starting sidecar via frozen binary".to_string(),
            );
            Some((
                configure(build_frozen_command(&path)),
                "source: frozen self-contained binary".to_string(),
            ))
        }
        Some(LaunchPlan::Source(launcher, sidecar_dir)) => {
            match launcher {
                LaunchPath::BundledUv => host.log(
                    LogLevel::Debug,
                    "starting sidecar via local uv".to_string(),
                ),
                LaunchPath::PathUv => {
                    host.log(LogLevel::Debug, "starting sidecar via PATH uv".to_string());
                }
                LaunchPath::SystemPython => host.log(
                    LogLevel::Warn,
                    "uv not found; falling back to python3 -m cannet_python_can. Install uv for the supported flow.".to_string(),
                ),
            }
            host.log(
                LogLevel::Debug,
                format!("sidecar dir: {}", sidecar_dir.display()),
            );
            Some((
                configure(build_command(launcher, &sidecar_dir)),
                format!("sidecar dir: {}", sidecar_dir.display()),
            ))
        }
        None if launcher.is_none() => {
            host.log(
                LogLevel::Error,
                "no sidecar launcher found (frozen binary, local uv, PATH uv, or python3); install uv: https://docs.astral.sh/uv/".to_string(),
            );
            None
        }
        None => {
            host.log(
                LogLevel::Error,
                format!(
                    "could not locate the cannet-python-can package directory. Searched: {}",
                    sidecar_dir_search_summary()
                ),
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-platform stand-in for the sidecar directory in tests —
    /// `/tmp/...` is Unix-only, and `std::env::temp_dir()` returns an
    /// absolute path on every supported OS.
    fn sample_sidecar_dir() -> PathBuf {
        std::env::temp_dir().join("cannet-python-can")
    }

    #[test]
    fn build_command_uses_expected_program_for_each_path() {
        let cmd = build_command(LaunchPath::SystemPython, &sample_sidecar_dir());
        let program = cmd.get_program().to_string_lossy().to_string();
        assert!(
            program.ends_with("python3") || program.ends_with("python"),
            "expected python program, got {program}",
        );
    }

    #[test]
    fn build_command_passes_absolute_sidecar_dir_to_uv() {
        let dir = sample_sidecar_dir();
        let cmd = build_command(LaunchPath::PathUv, &dir);
        let args: Vec<OsString> = cmd.get_args().map(OsStr::to_os_string).collect();
        let idx = args
            .iter()
            .position(|a| a == "--directory")
            .expect("uv invocation must include --directory");
        assert_eq!(args[idx + 1], dir.as_os_str());
    }

    #[test]
    fn build_command_threads_sidecar_dir_into_pythonpath_for_system_python() {
        let dir = sample_sidecar_dir();
        let cmd = build_command(LaunchPath::SystemPython, &dir);
        let pythonpath = cmd
            .get_envs()
            .find_map(|(k, v)| (k == "PYTHONPATH").then(|| v.map(OsStr::to_os_string)))
            .flatten()
            .expect("SystemPython launcher must set PYTHONPATH");
        assert_eq!(pythonpath, dir.as_os_str());
    }

    #[test]
    fn build_command_does_not_pin_a_bind_address() {
        // The sidecar's own default (`127.0.0.1:0`) is the contract
        // for "host doesn't care about the port" — if we ever start
        // passing `--bind` from here again we'd silently re-create
        // the stale-instance-holds-50061 wedge that random-port
        // selection was added to fix.
        for launcher in [LaunchPath::PathUv, LaunchPath::SystemPython] {
            let cmd = build_command(launcher, &sample_sidecar_dir());
            let has_bind = cmd.get_args().any(|a| a == "--bind");
            assert!(
                !has_bind,
                "{launcher:?} command should not pass --bind; got {:?}",
                cmd.get_args().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn build_frozen_command_runs_the_launcher_with_no_args() {
        // The frozen onedir is self-contained: the launcher embeds its
        // own interpreter and deps, so the command is just the launcher
        // path — no `--directory`, no `--bind`, no `run` subcommand.
        let launcher = std::env::temp_dir().join(frozen_launcher_name());
        let cmd = build_frozen_command(&launcher);
        assert_eq!(cmd.get_program(), launcher.as_os_str());
        assert_eq!(
            cmd.get_args().count(),
            0,
            "frozen launcher takes no args; got {:?}",
            cmd.get_args().collect::<Vec<_>>()
        );
    }

    #[test]
    fn frozen_launcher_name_matches_target_os_suffix() {
        #[cfg(windows)]
        assert_eq!(frozen_launcher_name(), "cannet-python-can.exe");
        #[cfg(not(windows))]
        assert_eq!(frozen_launcher_name(), "cannet-python-can");
    }

    fn frozen_path() -> PathBuf {
        PathBuf::from("/res/cannet-python-can/launcher")
    }

    fn source_tree() -> (LaunchPath, PathBuf) {
        (
            LaunchPath::BundledUv,
            PathBuf::from("/repo/servers/cannet-python-can"),
        )
    }

    #[test]
    fn plan_launch_dev_prefers_source_tree_over_frozen() {
        // The regression this locks in: with the frozen resource bundled
        // (it is, since the sidecar became a Tauri resource), a dev build
        // must still run the editable source tree so sidecar edits take
        // effect without re-freezing.
        let (launcher, dir) = source_tree();
        assert_eq!(
            plan_launch(true, Some(frozen_path()), Some(source_tree())),
            Some(LaunchPlan::Source(launcher, dir)),
        );
    }

    #[test]
    fn plan_launch_release_prefers_frozen_over_source_tree() {
        assert_eq!(
            plan_launch(false, Some(frozen_path()), Some(source_tree())),
            Some(LaunchPlan::Frozen(frozen_path())),
        );
    }

    #[test]
    fn plan_launch_falls_back_when_the_preferred_flavour_is_missing() {
        assert_eq!(
            plan_launch(true, Some(frozen_path()), None),
            Some(LaunchPlan::Frozen(frozen_path())),
        );
        let (launcher, dir) = source_tree();
        assert_eq!(
            plan_launch(false, None, Some(source_tree())),
            Some(LaunchPlan::Source(launcher, dir)),
        );
    }

    #[test]
    fn plan_launch_none_when_nothing_is_resolvable() {
        assert_eq!(plan_launch(true, None, None), None);
        assert_eq!(plan_launch(false, None, None), None);
    }

    // The *reads* of the process environment stay untested — the
    // workspace forbids `unsafe` (`unsafe_code = "forbid"` in the
    // top-level Cargo.toml) and `std::env::set_var` is `unsafe` since
    // Rust 2024, so a test cannot set one. What the reads feed is
    // `env_over_setting`, which is pure and is covered below.

    /// `value` as the environment (or a setting) hands it over.
    fn os(value: &str) -> OsString {
        value.into()
    }

    #[test]
    fn the_environment_wins_over_the_setting_and_says_so() {
        // The env vars are escape hatches — tests, CI, packaging
        // experiments — and an escape hatch a persisted file can
        // override is not an escape hatch. But a settings file must not
        // then show a value nothing is using without a word (ADR 0034),
        // so the shadowing is reported.
        let r = env_over_setting(
            SIDECAR_DIR_ENV,
            "sidecar_dir",
            Some(os("from-the-environment")),
            "from-the-file",
        );
        assert_eq!(r.value, Some(os("from-the-environment")));
        let note = r.shadowed.expect("a shadowed setting is reported");
        assert!(note.contains("CANNET_SIDECAR_DIR"), "{note}");
        assert!(note.contains("sidecar_dir"), "{note}");
        assert!(note.contains("from-the-file"), "{note}");
        assert!(note.contains("from-the-environment"), "{note}");
    }

    #[test]
    fn the_setting_applies_when_the_environment_is_silent() {
        let r = env_over_setting(SIDECAR_DIR_ENV, "sidecar_dir", None, "from-the-file");
        assert_eq!(r.value, Some(os("from-the-file")));
        assert_eq!(r.shadowed, None, "nothing was shadowed");
    }

    #[test]
    fn the_environment_alone_is_not_a_shadowing() {
        // The untouched install: the setting is blank, so there is no
        // file value to report as overridden.
        let r = env_over_setting(SIDECAR_DIR_ENV, "sidecar_dir", Some(os("only-the-env")), "");
        assert_eq!(r.value, Some(os("only-the-env")));
        assert_eq!(r.shadowed, None);
    }

    #[test]
    fn a_blank_value_on_either_side_means_unset() {
        // Blank is how both sources say "nothing here", so the built-in
        // behaviour applies and neither shadows the other.
        for (e, setting) in [
            (None, ""),
            (None, "   "),
            (Some(os("")), ""),
            (Some(os("")), "  "),
        ] {
            let r = env_over_setting(SIDECAR_DIR_ENV, "sidecar_dir", e.clone(), setting);
            assert_eq!(r.value, None, "env {e:?} setting {setting:?}");
            assert_eq!(r.shadowed, None);
        }
        // An empty env var does not shadow a real setting either.
        let r = env_over_setting(
            SIDECAR_DIR_ENV,
            "sidecar_dir",
            Some(os("")),
            "from-the-file",
        );
        assert_eq!(r.value, Some(os("from-the-file")));
        assert_eq!(r.shadowed, None);
    }

    #[test]
    fn an_override_is_used_verbatim_as_the_sidecar_dir() {
        let dir = sample_sidecar_dir();
        assert_eq!(
            resolve_sidecar_dir(Some(dir.clone().into_os_string())),
            Some(dir),
            "the override short-circuits the walk-up entirely"
        );
    }

    #[test]
    fn the_sidecar_log_level_reaches_the_child_and_bind_still_does_not() {
        // The sidecar's `--log-level` was unreachable because the host
        // passed no arguments at all. `--bind` stays unpassed for the
        // reason `build_command_does_not_pin_a_bind_address` gives —
        // adding one argument must not smuggle in the other.
        for mut cmd in [
            build_command(LaunchPath::PathUv, &sample_sidecar_dir()),
            build_command(LaunchPath::SystemPython, &sample_sidecar_dir()),
            build_frozen_command(&std::env::temp_dir().join(frozen_launcher_name())),
        ] {
            apply_settings(&mut cmd, "warning", None, None);
            let args: Vec<OsString> = cmd.get_args().map(OsStr::to_os_string).collect();
            let at = args
                .iter()
                .position(|a| a == "--log-level")
                .unwrap_or_else(|| panic!("no --log-level in {args:?}"));
            assert_eq!(args[at + 1], OsStr::new("warning"));
            assert!(!args.iter().any(|a| a == "--bind"), "{args:?}");
        }
    }

    #[test]
    fn the_sidecar_logfile_path_reaches_the_child_on_every_launcher() {
        // The always-debug file is the only place a per-channel connect
        // failure is diagnosable after the fact, and the sidecar writes
        // one only when told where — so the flag has to be on every
        // launch flavour, frozen included.
        let path = std::env::temp_dir()
            .join("logs")
            .join(crate::SIDECAR_LOG_FILE);
        for mut cmd in [
            build_command(LaunchPath::PathUv, &sample_sidecar_dir()),
            build_command(LaunchPath::SystemPython, &sample_sidecar_dir()),
            build_frozen_command(&std::env::temp_dir().join(frozen_launcher_name())),
        ] {
            apply_settings(&mut cmd, "info", Some(&path), None);
            let args: Vec<OsString> = cmd.get_args().map(OsStr::to_os_string).collect();
            let at = args
                .iter()
                .position(|a| a == "--log-file")
                .unwrap_or_else(|| panic!("no --log-file in {args:?}"));
            assert_eq!(args[at + 1], path.as_os_str());
        }
    }

    #[test]
    fn no_logfile_path_means_no_flag_at_all() {
        // `None` must not degrade into an empty argument: the sidecar
        // reads a bare `--log-file` as an error, and its own default is
        // exactly "write no file".
        let mut cmd = build_frozen_command(&std::env::temp_dir().join(frozen_launcher_name()));
        apply_settings(&mut cmd, "info", None, None);
        assert!(
            !cmd.get_args().any(|a| a == "--log-file"),
            "{:?}",
            cmd.get_args().collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_driver_module_is_forwarded_to_the_sidecar_process() {
        // `CANNET_DRIVER_MODULE` is read by the *sidecar*, and the host
        // never set it — so the only way to select a driver was to
        // launch the host from a shell that already had it. The setting
        // is the host-side half of that contract.
        let mut cmd = build_command(LaunchPath::PathUv, &sample_sidecar_dir());
        apply_settings(&mut cmd, "info", None, Some(OsStr::new("my_team.driver")));
        let value = cmd
            .get_envs()
            .find_map(|(k, v)| (k == DRIVER_MODULE_ENV).then_some(v))
            .flatten()
            .expect("the driver module must reach the child");
        assert_eq!(value, OsStr::new("my_team.driver"));
    }

    #[test]
    fn no_driver_module_leaves_the_child_environment_alone() {
        // The untouched install must launch exactly as it did before
        // the setting existed: the sidecar picks its own default.
        let mut cmd = build_frozen_command(&std::env::temp_dir().join(frozen_launcher_name()));
        apply_settings(&mut cmd, "info", None, None);
        assert!(
            !cmd.get_envs().any(|(k, _)| k == DRIVER_MODULE_ENV),
            "nothing should be set when neither the env nor the setting names one"
        );
    }
}
