//! Crash forensics by persisting the System Messages stream to disk.
//!
//! The host's logs are otherwise ephemeral: the System Messages ring
//! ([`crate::system_log`]) lives in memory and dies with the process,
//! and the `tracing` stderr fan-out goes nowhere in a release build
//! (`windows_subsystem = "windows"`, no console). So an instant,
//! silent death — an `abort()` (OOM `handle_alloc_error`, a giant
//! single allocation failing), a stack overflow, a native segfault
//! (`WebView`, a vendor driver), or an OS `TerminateProcess` — leaves no
//! trace. None of those even run a panic hook.
//!
//! This module's job is to make the log durable. Every message that
//! reaches the System Messages ring is mirrored, line for line, to a
//! single **rolling log** ([`log_dir`]/`cannet.log`), flushed each
//! write. The log lives in the idiomatic per-OS location (Tauri's
//! `app_log_dir`: `%LOCALAPPDATA%\<id>\logs` on Windows,
//! `~/Library/Logs/<id>` on macOS, `~/.local/share/<id>/logs` on Linux),
//! resolved at `setup`; a panic in the brief pre-`setup` window falls
//! back to a temp directory (temp can be swept by the OS, so it is only
//! the stopgap). On top of that:
//!
//! - [`install_panic_hook`] appends the panic message, location,
//!   thread, and backtrace to the same log (the catchable-death path),
//!   then chains the previous hook so stderr/`tracing` still fire.
//! - [`spawn_health_recorder`] emits a once-a-second System Message with
//!   `{trace_len, buffer_seconds, fps, rss_mb, tree_mb, webview_mb (split
//!   browser/renderer/gpu/other), jsheap_mb, sys_avail_mb, sys_total_mb}`
//!   — so it rides the normal logging pipe and lands in the same rolling
//!   log. That trail is what survives an uncatchable death: `sys_avail_mb`
//!   diving toward zero before a crash gap means system memory exhaustion
//!   (which kills every memory-hungry app at once and often leaves no
//!   per-process crash record). The `webview` split plus `jsheap_mb`
//!   localises a leak: `jsheap_mb` flat while `webview_mb` climbs ⇒ it's
//!   native, and the `gpu`/`renderer`/`browser` breakdown names which
//!   process holds it. `jsheap_mb` is reported by the frontend through
//!   [`record_js_heap`] (the host can't read another process's V8 heap).
//!
//! Memory is read via the `sysinfo` crate (the workspace forbids
//! `unsafe`, so a crate is needed to wrap the per-OS process APIs). The
//! sample reports two numbers: `rss_mb`, the Rust host alone, and
//! `tree_mb`, the host plus every descendant process — which on Windows
//! and Linux folds in the `WebView`'s separate processes (`WebView2` /
//! `WebKitGTK`). On macOS the `WebKit` helpers are launchd-owned XPC
//! services, not our descendants, so `tree_mb` there counts the host
//! only (attributing them needs a private API + `unsafe`).

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager};

use crate::sys_info;
use crate::system_log::{LogLevel, SystemMessage};
use crate::AppState;

/// Rolling log file name under [`log_dir`].
pub const LOG_FILE: &str = "cannet.log";

/// Rotate the log once it passes this size: the current file is renamed
/// to `cannet.log.1` (one generation kept) and a fresh one started, so
/// disk use is bounded to ~2× this.
const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;

/// How often [`spawn_health_recorder`] emits a resource sample.
const HEALTH_INTERVAL: Duration = Duration::from_secs(1);

/// Serializes writes from the many threads that log concurrently (pump,
/// recorder, command handlers) so their lines don't interleave.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Latest renderer JS-heap reading (`performance.memory.usedJSHeapSize`),
/// in bytes, pushed by the frontend ~1 Hz through [`record_js_heap`].
/// `0` means "not yet reported". The host can't read another process's
/// V8 heap, so this is the one number that must originate in the
/// `WebView` — pairing it with the host-measured `webview_mb` splits a
/// JS-heap leak from native/GPU growth.
static LAST_JS_HEAP: AtomicU64 = AtomicU64::new(0);

/// Record the frontend's latest JS-heap size (bytes). Called from the
/// `report_js_heap` Tauri command.
pub fn record_js_heap(bytes: u64) {
    LAST_JS_HEAP.store(bytes, Ordering::Relaxed);
}

/// The last JS-heap reading, or `None` if the frontend hasn't reported
/// one yet.
fn js_heap_bytes() -> Option<u64> {
    match LAST_JS_HEAP.load(Ordering::Relaxed) {
        0 => None,
        v => Some(v),
    }
}

/// The idiomatic per-OS log directory, set once at `setup` from Tauri's
/// [`app_log_dir`] (`%LOCALAPPDATA%\<id>\logs` on Windows,
/// `~/Library/Logs/<id>` on macOS, `~/.local/share/<id>/logs` on Linux).
/// Until then [`log_dir`] falls back to a temp directory — only relevant
/// for a panic during the brief pre-`setup` window.
///
/// [`app_log_dir`]: tauri::path::PathResolver::app_log_dir
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Record the resolved per-OS log directory. Idempotent: the first call
/// wins, later calls are ignored. Called from [`spawn_health_recorder`],
/// which runs in `setup` with an `AppHandle` in hand.
fn set_log_dir(dir: PathBuf) {
    let _ = LOG_DIR.set(dir);
}

/// Pre-`setup` fallback: a temp subdirectory, writable and resolvable
/// with no `AppHandle` on every supported OS (`%TEMP%` on Windows,
/// `$TMPDIR` / `/tmp` elsewhere). Temp can be swept by the OS, so it's
/// only the stopgap before [`set_log_dir`] installs the durable path.
fn temp_fallback_dir() -> PathBuf {
    std::env::temp_dir().join("cannet")
}

/// Directory that holds the rolling log: the idiomatic per-OS log dir
/// once [`set_log_dir`] has run, else the temp fallback.
#[must_use]
pub fn log_dir() -> PathBuf {
    LOG_DIR.get().cloned().unwrap_or_else(temp_fallback_dir)
}

/// Mirror one already-rung System Message to the rolling log. Called
/// from the logging chokepoint (`crate::emit_system_log`) so every
/// message the panel shows is also on disk. Best-effort: a write
/// failure is swallowed (there's nowhere better to report it).
pub fn persist_message(msg: &SystemMessage) {
    persist_block(&format_log_line(msg));
}

/// Append a block of text to the rolling log under [`WRITE_LOCK`],
/// rotating first if needed. Errors are swallowed.
fn persist_block(block: &str) {
    let _guard = WRITE_LOCK.lock();
    let _ = append_block(&log_dir(), LOG_FILE, LOG_CAP_BYTES, block);
}

/// Install the process-wide panic hook, chaining the previous one so
/// the default stderr/`tracing` behaviour still runs after we've
/// persisted the record.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let location = info.location().map_or_else(
            || "<unknown>".to_string(),
            |l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
        );
        let message = payload_message(info.payload());
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let block = format_panic_block(unix_ms(), &thread, &message, &location, &backtrace);
        // Bypass WRITE_LOCK on this terminal path: if the panicking
        // thread already held it we'd deadlock. A rare interleave with a
        // concurrent line is an acceptable price during a crash.
        let _ = append_block(&log_dir(), LOG_FILE, LOG_CAP_BYTES, &block);
        previous(info);
    }));
}

/// Spawn the 1 Hz health recorder on a named OS thread. It reads only
/// the cheap O(1) trace metrics plus process RSS and emits them as a
/// System Message, so the sample lands in the ring, the panel, and the
/// rolling log through the normal pipe. Info level keeps it below the
/// panel's default `warn` filter while still being on disk. Logs the
/// log-file path once on start so the user knows where to look.
pub fn spawn_health_recorder(app: AppHandle) {
    // Switch off the temp fallback onto the idiomatic per-OS log dir now
    // that we have an `AppHandle`. A read-only `app_log_dir` (or an
    // exotic platform) leaves the temp fallback in place.
    if let Ok(dir) = app.path().app_log_dir() {
        set_log_dir(dir);
    }
    sys_info!(
        &app,
        "crash",
        "rolling log + crash records → {}",
        log_dir().join(LOG_FILE).display()
    );
    // One `System` is reused across ticks; refreshing is cheaper than
    // rebuilding, and only the process list + system memory are refreshed.
    let mut sys = System::new();
    let own_pid = sysinfo::get_current_pid().ok();
    let _ = std::thread::Builder::new()
        .name("cannet-health-recorder".into())
        .spawn(move || loop {
            std::thread::sleep(HEALTH_INTERVAL);
            let state: tauri::State<'_, AppState> = app.state();
            let trace_len = state.trace_store.len();
            let buffer_seconds = state.trace_store.buffer_seconds();
            let fps = state.trace_store.frames_per_second();
            let mem = read_memory(&mut sys, own_pid);
            sys_info!(
                &app,
                "health",
                "{}",
                format_health_message(trace_len, buffer_seconds, fps, &mem)
            );
        });
}

/// Which Chromium child role a `WebView` process plays, parsed from its
/// `--type=` argument. The browser (no `--type`) and renderer hold JS;
/// the GPU process holds the compositor / GPU buffers a heap snapshot
/// can't see — the split tells a native/GPU leak from a renderer one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebviewKind {
    Browser,
    Renderer,
    Gpu,
    Other,
}

/// A memory snapshot for one health tick. All fields are bytes, `None`
/// when the read failed (or, for the per-process fields, when our own
/// PID couldn't be resolved).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct MemorySample {
    /// The Rust host process alone, in bytes.
    host: Option<u64>,
    /// Host + every descendant (folds in the `WebView` on Windows / Linux).
    tree: Option<u64>,
    /// Descendant `WebView` processes only (`msedgewebview2` / `WebKit`).
    webview: Option<u64>,
    /// `WebView` browser (main) process(es).
    webview_browser: Option<u64>,
    /// `WebView` renderer process(es) — where the JS heap lives.
    webview_renderer: Option<u64>,
    /// `WebView` GPU process(es) — compositor / GPU buffers, invisible to
    /// a JS heap snapshot.
    webview_gpu: Option<u64>,
    /// `WebView` utility / crashpad / other helper process(es).
    webview_other: Option<u64>,
    /// Renderer JS heap (`performance.memory.usedJSHeapSize`), reported by
    /// the frontend. Flat here while `webview`/`webview_gpu` climb ⇒ the
    /// leak is native/GPU, not JS.
    js_heap: Option<u64>,
    /// System-wide available memory — the OOM tell. If this dives toward
    /// zero just before a crash gap, the death was memory exhaustion.
    sys_avail: Option<u64>,
    /// Total physical memory, for context on `sys_avail`.
    sys_total: Option<u64>,
}

/// Classify a process by name + command line into a [`WebviewKind`], or
/// `None` if it isn't a `WebView` process. Pure (takes the joined
/// command line as a string) so it's unit-testable without `sysinfo`.
fn webview_kind(name_lower: &str, cmd_joined: &str) -> Option<WebviewKind> {
    if !(name_lower.contains("webview") || name_lower.contains("webkit")) {
        return None;
    }
    let kind = match cmd_joined.split("--type=").nth(1) {
        None => WebviewKind::Browser, // no `--type` ⇒ the main browser process
        Some(rest) => {
            let ty = rest
                .split([' ', '"'])
                .next()
                .unwrap_or("");
            match ty {
                "renderer" => WebviewKind::Renderer,
                "gpu-process" => WebviewKind::Gpu,
                _ => WebviewKind::Other, // utility, crashpad-handler, …
            }
        }
    };
    Some(kind)
}

/// Refresh `sys` and snapshot memory: the host alone, the whole process
/// tree, the `WebView` subset split by Chromium role, the renderer JS
/// heap, and system-wide available / total memory. `own_pid` is `None`
/// only if the current PID couldn't be resolved, in which case the
/// per-process figures are `None` but system memory is still reported.
fn read_memory(sys: &mut System, own_pid: Option<Pid>) -> MemorySample {
    sys.refresh_memory();
    // Command lines are immutable per process, so refresh them only for
    // processes that don't have one cached yet (new spawns) — cheaper
    // than re-reading every PEB each second.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    let mut sample = MemorySample {
        sys_avail: Some(sys.available_memory()),
        sys_total: Some(sys.total_memory()),
        js_heap: js_heap_bytes(),
        ..MemorySample::default()
    };
    let Some(root) = own_pid.map(sysinfo::Pid::as_u32) else {
        return sample;
    };
    // `(pid, parent, mem_bytes, webview-kind)` for every process.
    let entries: Vec<(u32, Option<u32>, u64, Option<WebviewKind>)> = sys
        .processes()
        .values()
        .map(|p| {
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            let cmd = p
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            (
                p.pid().as_u32(),
                p.parent().map(sysinfo::Pid::as_u32),
                p.memory(),
                webview_kind(&name, &cmd),
            )
        })
        .collect();
    let links: Vec<(u32, Option<u32>)> = entries.iter().map(|(p, par, _, _)| (*p, *par)).collect();
    let family = descendant_pids(&links, root);
    sample.host = entries
        .iter()
        .find(|(pid, _, _, _)| *pid == root)
        .map(|(_, _, mem, _)| *mem);
    // Only report the tree if the root was actually found in the table.
    if sample.host.is_some() {
        let in_family = |pid: &u32| family.contains(pid);
        sample.tree = Some(
            entries
                .iter()
                .filter(|(pid, _, _, _)| in_family(pid))
                .map(|(_, _, mem, _)| *mem)
                .sum(),
        );
        let wv_sum = |want: Option<WebviewKind>| -> u64 {
            entries
                .iter()
                .filter(|(pid, _, _, kind)| in_family(pid) && (want.is_none() || *kind == want))
                .filter(|(_, _, _, kind)| kind.is_some())
                .map(|(_, _, mem, _)| *mem)
                .sum()
        };
        sample.webview = Some(wv_sum(None));
        sample.webview_browser = Some(wv_sum(Some(WebviewKind::Browser)));
        sample.webview_renderer = Some(wv_sum(Some(WebviewKind::Renderer)));
        sample.webview_gpu = Some(wv_sum(Some(WebviewKind::Gpu)));
        sample.webview_other = Some(wv_sum(Some(WebviewKind::Other)));
    }
    sample
}

/// The set of `root` plus every process reachable from it through the
/// parent links in `links` (`(pid, parent_pid)`). Pure and unit-testable
/// — no `sysinfo` in the signature. The visited set makes it robust to a
/// malformed parent chain (a cycle).
fn descendant_pids(links: &[(u32, Option<u32>)], root: u32) -> std::collections::HashSet<u32> {
    let mut set = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !set.insert(pid) {
            continue;
        }
        for (child, parent) in links {
            if *parent == Some(pid) && !set.contains(child) {
                stack.push(*child);
            }
        }
    }
    set
}

/// The health-sample message body. Pure so it's unit-testable. Memory is
/// shown in whole MB for readability; an absent reading prints `?`.
/// `rss_mb` is the Rust host alone, `tree_mb` host + descendants,
/// `webview_mb` the `WebView` subset split into `browser`/`renderer`/`gpu`/
/// `other`, `jsheap_mb` the renderer JS heap, and `sys_avail_mb` /
/// `sys_total_mb` the machine-wide figures that reveal an OOM.
fn format_health_message(
    trace_len: usize,
    buffer_seconds: f64,
    fps: f64,
    mem: &MemorySample,
) -> String {
    let mb =
        |b: Option<u64>| b.map_or_else(|| "?".to_string(), |v| (v / (1024 * 1024)).to_string());
    format!(
        "trace_len={trace_len} buffer_s={buffer_seconds:.1} fps={fps:.0} \
         rss_mb={} tree_mb={} webview_mb={}[browser={} renderer={} gpu={} other={}] \
         jsheap_mb={} sys_avail_mb={} sys_total_mb={}",
        mb(mem.host),
        mb(mem.tree),
        mb(mem.webview),
        mb(mem.webview_browser),
        mb(mem.webview_renderer),
        mb(mem.webview_gpu),
        mb(mem.webview_other),
        mb(mem.js_heap),
        mb(mem.sys_avail),
        mb(mem.sys_total),
    )
}

/// Render one System Message as a single log line (trailing newline).
/// Pure; unit-testable.
fn format_log_line(msg: &SystemMessage) -> String {
    format!(
        "{} {} {}: {}\n",
        iso8601_from_ms(msg.ts_ms),
        level_tag(msg.level),
        msg.source,
        msg.message
    )
}

/// Format an epoch-millisecond instant as an ISO-8601 / RFC-3339 UTC
/// timestamp, e.g. `2026-06-21T14:30:45.123Z`. Falls back to the raw
/// millisecond count if the value is somehow out of `chrono`'s range
/// (not reachable for real wall-clock times).
fn iso8601_from_ms(ts_ms: u64) -> String {
    i64::try_from(ts_ms)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map_or_else(
            || ts_ms.to_string(),
            |dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
}

fn level_tag(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Info => "INFO",
        LogLevel::Warn => "WARN",
        LogLevel::Error => "ERROR",
    }
}

/// Render a panic into the multi-line block appended to the log. Pure
/// (no IO, no `PanicHookInfo`) so it's unit-testable.
fn format_panic_block(
    ts_ms: u64,
    thread: &str,
    message: &str,
    location: &str,
    backtrace: &str,
) -> String {
    format!(
        "==== cannet panic ({iso}) ====\n\
         thread:   {thread}\n\
         location: {location}\n\
         message:  {message}\n\
         backtrace:\n{backtrace}\n\n",
        iso = iso8601_from_ms(ts_ms)
    )
}

/// Pull a human-readable message out of a panic payload (a `&str` for
/// `panic!("literal")`, a `String` for `panic!("{fmt}")`).
fn payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Append `block` to `dir/name`, creating the dir, rotating first if the
/// file has grown past `cap`.
fn append_block(dir: &Path, name: &str, cap: u64, block: &str) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    rotate_if_needed(&path, cap)?;
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    f.write_all(block.as_bytes())?;
    f.flush()
}

/// If `path` exists and exceeds `cap`, rename it to `<path>.1` (one
/// retained generation), clobbering any previous `.1`. A missing file or
/// a stat failure is a no-op — the caller will create it fresh.
fn rotate_if_needed(path: &Path, cap: u64) -> io::Result<()> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(());
    };
    if meta.len() > cap {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        std::fs::rename(path, PathBuf::from(rotated))?;
    }
    Ok(())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_dir_falls_back_to_temp_before_setup() {
        // With `set_log_dir` never called (the test process never runs
        // `setup`), `log_dir` returns the temp fallback.
        let dir = log_dir();
        assert_eq!(dir.file_name().and_then(|s| s.to_str()), Some("cannet"));
        assert!(dir.starts_with(std::env::temp_dir()));
    }

    #[test]
    fn log_line_carries_ts_level_source_message() {
        let msg = SystemMessage {
            seq: 9,
            ts_ms: 1700,
            source: "flight".to_string(),
            level: LogLevel::Warn,
            message: "trace_len=180000 rss_mb=2048".to_string(),
        };
        assert_eq!(
            format_log_line(&msg),
            "1970-01-01T00:00:01.700Z WARN flight: trace_len=180000 rss_mb=2048\n"
        );
    }

    #[test]
    fn health_message_formats_present_and_absent_memory() {
        let mem = MemorySample {
            host: Some(2_147_483_648),
            tree: Some(6_442_450_944),
            webview: Some(4_294_967_296),
            webview_browser: Some(536_870_912),
            webview_renderer: Some(1_073_741_824),
            webview_gpu: Some(2_147_483_648),
            webview_other: Some(536_870_912),
            js_heap: Some(268_435_456),
            sys_avail: Some(1_073_741_824),
            sys_total: Some(34_359_738_368),
        };
        assert_eq!(
            format_health_message(180_000, 392.5, 440.4, &mem),
            "trace_len=180000 buffer_s=392.5 fps=440 rss_mb=2048 tree_mb=6144 \
             webview_mb=4096[browser=512 renderer=1024 gpu=2048 other=512] \
             jsheap_mb=256 sys_avail_mb=1024 sys_total_mb=32768"
        );
        assert_eq!(
            format_health_message(0, 0.0, 0.0, &MemorySample::default()),
            "trace_len=0 buffer_s=0.0 fps=0 rss_mb=? tree_mb=? \
             webview_mb=?[browser=? renderer=? gpu=? other=?] \
             jsheap_mb=? sys_avail_mb=? sys_total_mb=?"
        );
    }

    #[test]
    fn webview_kind_classifies_by_type_arg() {
        let bw = "C:/x/msedgewebview2.exe";
        assert_eq!(webview_kind(bw, "msedgewebview2.exe --embedded"), Some(WebviewKind::Browser));
        assert_eq!(
            webview_kind(bw, "msedgewebview2.exe --type=renderer --lang=en"),
            Some(WebviewKind::Renderer)
        );
        assert_eq!(
            webview_kind(bw, "msedgewebview2.exe --type=gpu-process"),
            Some(WebviewKind::Gpu)
        );
        assert_eq!(
            webview_kind(bw, "msedgewebview2.exe --type=utility --x"),
            Some(WebviewKind::Other)
        );
        // Not a webview process at all.
        assert_eq!(webview_kind("python.exe", "python -m cannet --type=renderer"), None);
    }

    #[test]
    fn descendant_pids_collects_subtree_and_excludes_unrelated() {
        // host(1) → webview(2) → renderer(3); gpu(4) child of webview;
        // unrelated(9) must be excluded.
        let links = [
            (1u32, None),
            (2u32, Some(1)),
            (3u32, Some(2)),
            (4u32, Some(2)),
            (9u32, None),
        ];
        let fam = descendant_pids(&links, 1);
        assert_eq!(fam, [1, 2, 3, 4].into_iter().collect());
        assert!(!fam.contains(&9));
        // A leaf is just itself.
        assert_eq!(descendant_pids(&links, 3), [3].into_iter().collect());
    }

    #[test]
    fn descendant_pids_tolerates_a_parent_cycle() {
        // Malformed: 2's parent is 3 and 3's parent is 2. Must terminate.
        let links = [(1u32, None), (2u32, Some(3)), (3u32, Some(2))];
        assert_eq!(descendant_pids(&links, 2), [2, 3].into_iter().collect());
    }

    #[test]
    fn panic_block_carries_all_fields() {
        let block = format_panic_block(
            42,
            "cannet-blf-pump",
            "boom: index out of bounds",
            "src/trace_store.rs:123:7",
            "  0: some::frame\n  1: another::frame",
        );
        assert!(block.contains("1970-01-01T00:00:00.042Z"));
        assert!(block.contains("cannet-blf-pump"));
        assert!(block.contains("boom: index out of bounds"));
        assert!(block.contains("src/trace_store.rs:123:7"));
        assert!(block.contains("some::frame"));
        // Trailing blank line separates consecutive records.
        assert!(block.ends_with("\n\n"));
    }

    #[test]
    fn iso8601_from_ms_renders_rfc3339_utc_millis() {
        // 1_000 ms after the epoch, with sub-second millis preserved.
        assert_eq!(iso8601_from_ms(1_700), "1970-01-01T00:00:01.700Z");
        assert_eq!(iso8601_from_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn payload_message_reads_str_and_string_payloads() {
        let s: &str = "literal panic";
        assert_eq!(payload_message(&s), "literal panic");
        let owned: String = "formatted panic".to_string();
        assert_eq!(payload_message(&owned), "formatted panic");
        let other: u32 = 7;
        assert_eq!(payload_message(&other), "<non-string panic payload>");
    }

    #[test]
    fn append_block_accumulates_across_calls() {
        let dir = tempfile::tempdir().unwrap();
        append_block(dir.path(), LOG_FILE, LOG_CAP_BYTES, "first\n").unwrap();
        append_block(dir.path(), LOG_FILE, LOG_CAP_BYTES, "second\n").unwrap();
        let body = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert_eq!(body, "first\nsecond\n");
    }

    #[test]
    fn append_block_rotates_past_cap() {
        let dir = tempfile::tempdir().unwrap();
        // Cap of 0 forces a rotation on every call after the first write.
        append_block(dir.path(), LOG_FILE, 0, "first\n").unwrap();
        append_block(dir.path(), LOG_FILE, 0, "second\n").unwrap();
        // The first file was rotated aside; both exist.
        assert!(dir.path().join(LOG_FILE).exists());
        assert!(dir.path().join(format!("{LOG_FILE}.1")).exists());
        // The live file starts fresh with only the latest write.
        let live = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert_eq!(live, "second\n");
        let rotated = std::fs::read_to_string(dir.path().join(format!("{LOG_FILE}.1"))).unwrap();
        assert_eq!(rotated, "first\n");
    }
}
