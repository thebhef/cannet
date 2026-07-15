# Task 31 — macOS Integration Issues

A grab-bag of macOS-specific fixes found in use. Each lands
independently with a test or a documented manual repro.

## Bug reports

### 1. Crash on exit (WebKit layer-tree teardown race)

Quitting the app (Cmd+Q) after a stable session crashes with
`EXC_BAD_ACCESS (SIGSEGV)` / `KERN_INVALID_ADDRESS at 0x10`.

Observed 2026-07-14 on macOS 26.5.1 (Mac14,2, `cannet 0.0.0`),
`tauri 2.11.1` / `wry 0.55.1` / `tao 0.35.2`. App ran ~37 min, then
crashed the moment the user quit. Report also carried a sleep/wake in
the session, but the user confirms the crash was on quit.

**Faulting stack (thread 0, main):** the crash is 100% inside Apple's
WebKit, in the compositor commit path —

```text
WebKit::RemoteLayerTreeDrawingAreaProxy::commitLayerTree(...)
  ← IPC::…didReceiveMessage
  ← WTF::RunLoop::performWork
  ← __CFRunLoopRun ← [NSApplication run]
  ← tao EventLoop::run ← wry Runtime::run ← cannet_gui_lib::run
```

`far: 0x10` (read ~16 bytes off a null pointer). No cannet frame is in
the failing call — our code appears only as the run-loop host.

**Hypothesis (not yet confirmed by experiment).** The known wry/WebKit
macOS crash-on-exit race: as the process quits, wry begins freeing the
`WKWebView`, but the CF run loop drains one last `commitLayerTree` IPC
from the WebContent process and dispatches it to a
`RemoteLayerTreeDrawingAreaProxy` that is already being torn down → null
deref. It is an upstream teardown-ordering bug, not a fault in cannet's
Rust or in the exit handler at [lib.rs:641](../../apps/gui/src-tauri/src/lib.rs#L641).

Ruled out by the backtrace / config:

- **Not** the `ExitRequested` cleanup (flush/clear) — it isn't on the
  stack and doesn't touch WebKit.
- **Not** a transparent-window trigger — the window is plain/opaque
  (`tauri.conf.json`, 1200×800, `dragDropEnabled: false`).

**Proposed fix.** After the existing synchronous cleanup in the
`ExitRequested` branch of `.run(...)`, terminate the process ourselves
(`std::process::exit(0)`) *before* handing control back to wry to free
the webview — closing the teardown window entirely. Two constraints:

- **Sidecar safety — verified.** The Python sidecar shuts down on
  stdin-EOF when the host's fds close (parent-death contract in
  [sidecar.rs:77-87](../../apps/gui/src-tauri/src/sidecar.rs#L77-L87):
  "a host crash never leaves an orphaned sidecar"). A hard exit is
  exactly the trigger it already relies on, so nothing is orphaned.
- **Window geometry — must be preserved explicitly.** A hard exit
  pre-empts `tauri-plugin-window-state`'s own on-exit save, so the
  handler must call `save_window_state(StateFlags::all())` first, or
  size/position stop persisting across quits. Verify the trait/method
  exists in the pinned plugin version before wiring it in.

**Alternatives considered:** bumping wry/tao/tauri (may carry an
upstream fix; try first / independently); explicitly stopping/hiding
the webview before exit (more fragile than the hard-exit hammer).

**Verification.** Cannot be reproduced in a Linux sandbox (no macOS
WebKit) and the crash is intermittent, so the fix stays a hypothesis
until exercised on a real macOS build: quit repeatedly, including after
a sleep/wake, and confirm no crash. Source may cite an ADR only (not
this task), so record the decision in an ADR if the fix lands.

### 2. Missing Spotlight metadata

The app does not appear in macOS Spotlight searches. Add the bundle
metadata macOS needs to index it (the app's `Info.plist` /
Tauri bundle config — e.g. a proper `CFBundleName` /
`CFBundleDisplayName`, `CFBundleIdentifier`, and any Spotlight-relevant
keys), and confirm the installed `.app` shows up in Spotlight after a
reindex.

### 3. Bundle identifier ends in `.app` — data dirs collide with the bundle extension

The Tauri bundle identifier is `dev.cannet.app`
([tauri.conf.json:5](../../apps/gui/src-tauri/tauri.conf.json#L5)), and
that identifier is what names the per-OS data directories
([lib.rs:349](../../apps/gui/src-tauri/src/lib.rs#L349),
[lib.rs:558](../../apps/gui/src-tauri/src/lib.rs#L558)) — so config /
cache / log land in `.../dev.cannet.app/`, a directory whose name ends
in `.app`. On macOS `.app` is the application-bundle extension, so
Launch Services / Finder can treat those data dirs as app bundles. (The
actual app bundle at `/Applications/cannet.app` is fine — `.app` there
is correct; the problem is only the identifier-derived support dirs.)

**Proposed fix.** Change the identifier so its last label isn't `app`
(e.g. `dev.cannet.gui`, or a reverse-DNS under an owned domain). Weigh
the migration cost:

- The identifier also drives the on-disk data-dir names, so changing it
  **moves** config / cache / log / scratch — existing installs would
  lose persisted window geometry, settings, and the scratch capture
  unless a one-time migration copies/renames the old dir. Decide
  migrate-vs-accept-reset (pre-release, a reset may be acceptable).
- It is the code-signing / bundle identity too; confirm nothing else
  (entitlements, notarization, update feed) pins `dev.cannet.app`.

## Exit criteria

- Crash-on-exit fix landed and confirmed on a real macOS build (quit,
  and quit-after-wake, no longer crash); decision recorded in an ADR
  and cited from the exit handler.
- The installed `cannet.app` appears in Spotlight search results; the
  bundle metadata change is documented (README bundling notes and/or
  the ADR/task).
- The bundle identifier no longer ends in `.app`; the per-OS data dirs
  it names no longer collide with the macOS bundle extension, with the
  data-dir migrate-vs-reset decision made and documented and nothing
  else left pinning the old identifier.
