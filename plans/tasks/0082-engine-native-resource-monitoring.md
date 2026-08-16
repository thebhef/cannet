# Task 82 — Engine-Native Resource Monitoring

Opened by owner ruling 2026-08-15, out of the task-78 consolidated
review's survey of the health sampler: "using the web engine API to
track web engine usage/procs/etc would be sort of the ideal, de-jure
approach to monitoring our resources."

## What the health sampler does today, and what it is for

`crash.rs::spawn_health_recorder` (cadence `health_sample_interval_ms`,
default 20 s, `0` = off) emits a periodic System Message with
`{trace_len, buffer_seconds, fps, rss_mb, tree_mb, webview_mb (split
browser/renderer/gpu/other), jsheap_mb, ui_last_ms, sys_avail_mb,
sys_total_mb}` plus the scratch byte split and (task 76) the pyramid
cache accounting. Its consumers, in order of importance:

1. **Crash forensics** — the rolling on-disk log's trail that survives
   an uncatchable death: `sys_avail_mb` diving before a crash gap =
   system OOM; `jsheap_mb` flat while `webview_mb` climbs = native
   leak, the split naming the process.
2. **Frontend hang detection** — `ui_last_ms` (the 1 Hz heartbeat's
   age) is judged every tick and announced at `warn` past the stall
   threshold; the mechanism that made a real reported hang visible.
3. **The ADR-0031 drift gates** read the samples during captures
   (`renderer_mb_drift_per_min` and siblings).
4. Incidental display: the System Messages panel; latest RSS in a
   status readout.

The family metrics come from an OS process-table walk: one
`NtQuerySystemInformation` snapshot per tick, ppid-walk from our root,
Chromium role classified by name/cmdline sniffing. Measured (task 78
B1): ~28 ms per tick on Windows ≈ 0.14 % of one core; the memory
figures are field copies out of the same snapshot, so the "targeted
refresh" variant measured **slower** (two syscalls) and was reverted.

## Common practice (surveyed 2026-08-15)

- Multi-process web-engine hosts (Chrome/Edge, Electron apps — VS
  Code, Slack, Discord) track renderer/helper memory as standard
  practice, **via the engine's own bookkeeping** (Chromium internal
  metrics, Electron `app.getAppMetrics()`), not periodic OS scans.
- VS Code's process explorer does scan the OS table
  (`windows-process-tree` / `ps`) — but on demand, not on a timer.
- Crash reporters (Crashpad, Sentry native) attach memory stats at
  crash time, own process + system.
- Classic single-process native tools sample at most their own
  process counters.

Conclusion the ruling draws: *what* we measure is normal for an app
whose UI is a web engine; *how* (periodic OS table scan) is the
workaround path. The engine API is the de-jure mechanism.

## Platform reality

- **Windows / WebView2**: `ICoreWebView2Environment8::GetProcessInfos`
  plus `ProcessInfosChanged` report the engine's own process family with
  typed roles (browser/renderer/GPU/utility) — exactly the
  authoritative source. Two adoption blockers, both above slice level
  and both this task's to resolve:
  1. The workspace forbids `unsafe_code` (`Cargo.toml`); every
     windows-rs COM call is `unsafe fn`. Needs an owner-ruled carve-out
     shape (e.g. an isolated, cfg(windows), auditably-small crate with
     `unsafe` allowed and a safe API surface).
  2. `webview2-com` becomes a direct dependency of `cannet-gui` —
     evaluate and record in `plans/technology-inventory.md` (it is
     already in the transitive tree via tauri/wry).
  Plus a thread-affinity design point: the environment interface lives
  on the main thread (`with_webview`); the sampler thread needs a
  cached PID set (e.g. subscribe to `ProcessInfosChanged`, publish to
  a shared snapshot the sampler reads).
- **macOS / WKWebView**: the current ppid walk is **broken by
  design** there — WebContent/GPU helpers are launchd-parented XPC
  services, not our children, and the "responsible process" grouping
  Activity Monitor uses is private API. `tree_mb`/`webview_mb` would
  silently exclude the web engine. WebKit exposes **no public
  per-process memory API** to the host. This task decides and
  documents the macOS behavior honestly: own process + sidecar +
  JS heap + system memory (all clean APIs), with the engine split
  recorded as unavailable — or any better mechanism found during
  design. Cross-reference task 31 (macOS integration issues).
- **Linux**: the engine-native framing does not apply — a search
  (2026-08-16) found no public webkit2gtk API exposing helper PIDs
  (only `webkit_web_view_get_page_id`, a page identifier), and no
  WebKit port is verified to publish its process family to the
  embedder. But Linux does not need it for correctness: WebKitGTK
  spawns `WebKitWebProcess` / `WebKitNetworkProcess` as direct
  children of the app, so the ppid walk finds the real family and
  the helper binary names state their roles. The Linux work is
  therefore cost, not correctness. Open measurement question
  (task 78 B1's Windows result does not transfer): on Windows the
  whole-table syscall is the floor and a targeted per-PID refresh
  measured 1.9× *slower*; on Linux there is no bulk call — discovery
  and memory are per-PID `/proc` file reads scaling with everything
  running on the machine — so ppid discovery at low cadence plus a
  targeted per-tick refresh over the known family is plausibly a
  large win. Measure both shapes during design; re-survey the
  webkit2gtk API then in case something exists the search missed.
  macOS shares the per-PID cost shape for the memory half (the bulk
  `KERN_PROC_ALL` listing carries no RSS; memory comes from per-PID
  libproc calls), so the same question applies wherever a family
  walk survives there.

## Scope

1. Design ruling with the owner: the carve-out shape for `unsafe`,
   the `webview2-com` adoption (technology-inventory entry either
   way), and the per-platform family-discovery matrix.
2. Implement engine-native family tracking on Windows (authoritative
   PIDs + roles from the engine; memory reads for those PIDs; no
   name/cmdline sniffing where the engine states the role).
3. macOS/Linux behavior decided, implemented to the decided shape,
   and documented — no silently-wrong metrics on any platform.
4. Sampler semantics preserved (sample shape, consumers, cadence,
   settings gate); costs re-measured per platform and the task-78 B1
   row updated.

## Exit criteria (draft — firm at grooming)

- The de-jure source (engine API) supplies the family on Windows;
  the OS snapshot remains only where no engine API exists, and the
  choice per platform is recorded in the sampler's rustdoc.
- `unsafe` carve-out ruled by the owner and confined to an isolated,
  auditable surface; `plans/technology-inventory.md` records the
  `webview2-com` decision.
- macOS reports no silently-wrong family figures: whatever ships is
  labeled for what it includes, and the WKWebView limitation is
  documented where the metrics are documented.
- Sample shape and consumers unchanged; per-platform tick cost
  measured and recorded; ADR-0031 gate green.
