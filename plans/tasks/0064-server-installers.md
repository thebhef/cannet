# Task 64 — Server Installers, and the Server in the GUI Install

Give `cannet-server` the same class of installers the GUI has, and
make every GUI install a potential server host.

Today (Task 41) the server ships as bare per-OS archives
(`tar.gz`/`zip`: binary + frozen sidecar onedir) beside the GUI's
real installers (`.dmg` macOS, `.msi`/NSIS `.exe` Windows). This task
closes that gap.

## Scope

1. **Server installers**, built in the release workflow beside the
   existing artifacts:
   - **macOS**: `.pkg` (revised from `.dmg` at grooming — the
     canonical CLI installer) carrying the server binary +
     `cannet-python-can/` onedir.
   - **Windows**: NSIS installer (owner-specified) installing binary +
     onedir, adding the install dir to the user `PATH`.
   - **Linux**: `.deb` (the most common server-host format). The
     plain archives **stay** — they are the no-installer path.
2. **GUI installers also ship `cannet-server`** (owner ruling
   2026-08-12: **ship the binary only** — launching stays an
   operator/terminal act, no in-app start/stop surface). The bundled
   server reuses the GUI install's frozen sidecar: the server's
   frozen-launcher probe must find the onedir where the GUI bundle
   puts it (Tauri resource layout), not only beside its own exe.
3. **GUI palette command "Add cannet-server to PATH"** — user-scope,
   cross-platform, operating on the bundled binary (see grooming
   notes for per-OS mechanism).
4. **`--sidecar-dir` flag on the server**, matching the GUI
   setting's precedence (env var wins).

## Non-goals

- An in-app affordance to start/stop a local server (explicitly
  declined at grooming — revisit as its own task if wanted).
- Code signing / notarization (existing backlog item; these
  installers ship unsigned exactly like the GUI's).
- Service integration / auto-start (ADR 0040 non-goal stands).

## Grooming notes (2026-08-13)

- **Packaging tooling: `cargo-packager`** (owner-agreed) — the Tauri
  bundler extracted for arbitrary binaries; one config for NSIS +
  dmg + deb, same NSIS engine the GUI already ships. Phase 1 is the
  evaluate-dependency pass (repo rule); the per-format trio (hand
  NSIS + `create-dmg` + `cargo-deb`) is the recorded fallback if the
  eval finds it can't express the onedir layout. **Superseded in part
  by the phase-1 eval below**: `cargo-packager` is adopted for the NSIS
  leg only; the `.deb` leg goes to `cargo-deb` and the `.pkg` leg to
  `pkgbuild`.
- **Windows NSIS** (owner-agreed): installer adds the install dir to
  the user `PATH`; **no Start-menu shortcut** (console app — a
  shortcut invites the double-click-launch pattern declined with the
  no-in-app-launch ruling). Uninstall entry standard.
- **macOS: `.pkg`, not `.dmg`** (owner-agreed after canonical-format
  discussion): flat package via Apple's own `pkgbuild` (present on
  mac runners, no new dependency; `cargo-packager` doesn't emit
  pkg). Unsigned, same Gatekeeper caveat as the GUI dmg.
- **Install layouts keep the exe-adjacent sidecar probe working**
  (owner-agreed):
  - NSIS: `<installdir>\cannet-server.exe` + `cannet-python-can\`.
  - pkg: everything under `/usr/local/cannet-server/`;
    `/etc/paths.d/cannet-server` points there.
  - deb: binary + onedir in `/usr/lib/cannet-server/`;
    `/usr/bin/cannet-server` symlink (`current_exe` resolves it).
  - GUI bundle: server as a Tauri resource — Windows beside the GUI
    exe, macOS `Contents/Resources/`. **Amended by phase 3**: putting
    the server binary itself in the resource root (rather than via
    `externalBin`, which lands in `Contents/MacOS/` on macOS) leaves it
    beside the onedir on *both* platforms, so no probe extension is
    needed at all.
- **GUI palette command "Add cannet-server to PATH"** (owner-asked):
  cross-platform, user-scope, no elevation — Windows appends the
  bundled server's dir to the `HKCU` user `PATH`; macOS appends the
  export line to `~/.zprofile`. Reports what it changed; new
  terminals see it. Not a launch surface — the no-in-app-launch
  ruling stands.
- **`.deb` specifics** (owner-agreed): no man page for now
  (`--help` + README cover it); prefix per the layout above.
- **Server gains `--sidecar-dir`** (owner-confirmed expectation that
  the sidecar path is configurable): flag beside the existing
  `--sidecar-*` set, `CANNET_SIDECAR_DIR` env still winning,
  matching the GUI's `sidecar_dir` setting precedence. The GUI
  setting already exists (`settings.rs` `sidecar_dir`,
  user-overridable). Both point at a *source tree*; picking a
  different frozen onedir stays inexpressible on both hosts —
  deliberately out of scope.

## Exit criteria

- Release workflow produces: GUI bundles (now containing
  `cannet-server`), server `.pkg` + NSIS `.exe` + `.deb`, and the
  three existing plain archives — one draft pre-release.
- The palette command puts the GUI-bundled server on the user PATH
  (verified on Windows locally; macOS leg code-reviewed + next
  release).
- `cannet-server --sidecar-dir` overrides the source-tree
  resolution with the same precedence the GUI's setting has.
- A server launched from a GUI install finds the bundled sidecar and
  serves hardware (verified on at least Windows locally).
- Each installer's install → run → uninstall path exercised on its
  OS where hardware allows; CI-only legs verified on the next
  release run.
- README's Downloads/Running sections document all install paths;
  `plans/technology-inventory.md` records any packaging tooling
  adopted (e.g. `cargo-deb`, `create-dmg`).

## Status log

### 2026-08-13 — phase 1, evaluate-dependency: `cargo-packager`

**Verdict: adopt partially.** `cargo-packager` 0.11.8 for the Windows
NSIS leg only; `cargo-deb` 3.7.0 for the `.deb` leg; Apple `pkgbuild`
for the `.pkg` leg (confirmed: `cargo-packager`'s format list is `app`,
`dmg`, `wix`, `nsis`, `deb`, `appimage`, `pacman` — no flat package).
The recorded fallback (hand NSIS script) is *not* needed: every Windows
requirement is reachable, though the no-shortcut one costs a vendored
template.

Trial method: `cargo install cargo-packager --locked` (0.11.8, 1m30s),
a standalone `Packager.toml` pointed at the real
`target/release/cannet-server.exe` and the **real** frozen
`apps/gui/src-tauri/sidecar-dist/cannet-python-can` onedir (42 MB, not a
stand-in), packaged, installed, run, uninstalled on the owner's Windows
11 box. Nothing from the trial is checked in; it lived outside the repo.

**The config that worked** (installer: 17.4 MB):

```toml
name = "cannet-server"          # required: without it, config discovery
productName = "cannet-server"   # dies in find_nearset_pkg_name (below)
version = "0.1.0"
identifier = "co.hefnet.cannet-server"
publisher = "cannet"
outDir = "dist"
binariesDir = "stage"
formats = ["nsis"]

[[binaries]]
path = "cannet-server"          # no .exe suffix
main = true

[[resources]]
src = "stage/cannet-python-can" # can point straight at sidecar-dist/
target = "cannet-python-can"    # → <installdir>\cannet-python-can\

[nsis]
installMode = "currentUser"
template = "installer-cli.nsi"  # forked; see below
preinstallSection = "…"         # PATH sections; see below
```

**PATH-append mechanism.** There is no config field for it. The NSIS
template exposes exactly one insertion point, `preinstallSection`, and
it injects verbatim NSIS at *top level* — so it takes both an install
section and an `un.` section, giving symmetric add/remove:

```nsis
Section "-AddToUserPath"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" … '
SectionEnd

Section "un.RemoveFromUserPath"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" … '
SectionEnd
```

The edit has to go through PowerShell
(`[Environment]::GetEnvironmentVariable/SetEnvironmentVariable(…,
'User')`), not NSIS registry instructions: `makensis -HDRINFO` on the
toolchain `cargo-packager` downloads reports **`NSIS_MAX_STRLEN=1024`**,
so `ReadRegStr` + `WriteRegExpandStr` would silently truncate — and thus
destroy — any user `PATH` longer than 1023 characters. The install side
appends to the raw string rather than splitting and rejoining it, so
existing entries (the owner's `PATH` contains an empty one) survive
untouched; the uninstall side splits on `;` and drops only the exact
install dir, preserving empties.

**Template fork.** `no Start-menu shortcut` is *not* expressible in
config: the stock template inserts `MUI_PAGE_STARTMENU`, calls
`CreateStartMenuShortcut` unconditionally from the install section, adds
both shortcuts on silent/passive installs unless `/NS` is passed, and
puts a "create desktop shortcut" checkbox plus a
`MUI_FINISHPAGE_RUN "$INSTDIR\cannet-server.exe"` button on the finish
page — the last being precisely the double-click-launch pattern the
no-in-app-launch ruling declined. `nsis.template` takes a vendored copy;
the fork needed is **deletion-only, 47 lines of 671** (624 remain), so a
version bump re-applies it mechanically. The five blocks removed:

1. the `; 6. Start menu shortcut page` block (`Var AppStartMenuFolder` +
   `MUI_PAGE_STARTMENU`);
2. the finish-page `MUI_FINISHPAGE_SHOWREADME*` defines (desktop
   shortcut) and `MUI_FINISHPAGE_RUN`;
3. in `Section Install`: the `MUI_STARTMENU_WRITE_BEGIN` block and the
   silent/passive `/NS` shortcut block;
4. in `Section Uninstall`: the start-menu and desktop shortcut removal
   (which references the now-absent `$AppStartMenuFolder`);
5. the `CreateDesktopShortcut` / `CreateStartMenuShortcut` functions.

**Install / uninstall observations** (forked-template build, `/S`):

- Layout: `%LOCALAPPDATA%\cannet-server\cannet-server.exe` beside
  `cannet-python-can\` — the exe-adjacent probe layout, as agreed.
- User `PATH` gained `C:\Users\…\AppData\Local\cannet-server`; a fresh
  process resolved `cannet-server` from it and `--version` ran.
- **End-to-end**: the installed server started from `C:\` (unrelated
  cwd), logged `exec:
  …\cannet-server\cannet-python-can\cannet-python-can.exe`, and
  enumerated both PEAK PCAN-USB FD channels. The install layout keeps
  the sidecar probe working.
- Standard `HKCU\…\Uninstall\cannet-server` entry (DisplayName,
  DisplayVersion, Publisher, InstallLocation, UninstallString,
  EstimatedSize). No Start-menu entry, no desktop shortcut.
- Uninstall removed the binary, the onedir contents, the uninstaller and
  the registry entry, and restored the user `PATH` **byte-identical** to
  the pre-install capture. Residue: the empty `cannet-python-can\`
  directory tree is left behind (the template deletes resource files but
  does not `RMDir /r` their directories) — cosmetic, worth a look in
  phase 2.
- Note for phase 2: the default `currentUser` install dir
  `%LOCALAPPDATA%\cannet-server` **collides with the server's own data
  directory** (`access-token`, `server-*.pem`, logs already lived
  there). The uninstaller only deletes what it installed, so nothing was
  lost, but the install dir should probably be
  `%LOCALAPPDATA%\Programs\cannet-server` to keep program files and
  state apart.

**`.deb` leg — split to `cargo-deb`.** `cargo-packager`'s deb writer
cannot express the agreed layout: `binaries` are copied into `/usr/bin`
as real files (no way to suppress or relocate), `resources` land in
`/usr/lib/<main binary name>/`, there is no maintainer-script hook, and
`deb.files` copies via `fs::copy` (directories are walked file-by-file),
so a `/usr/bin/cannet-server` **symlink** is impossible — and a real
copy there breaks the exe-adjacent sidecar probe. The module is also
`cfg`-gated to Linux/BSD: `cargo packager -f deb` on this Windows box
prints `WARN ignoring deb`, so the leg could not be exercised locally
regardless. `cargo-deb` 3.7.0 expresses it directly — `assets` entries
take a target path plus octal mode, and a symlink is an asset table of
`dest` + `link_name`. Deb leg is **CI-verified-later** (needs a Linux
runner).

**CI shape.** `cargo-packager` is a CI/dev tool, not a workspace
dependency: `cargo install cargo-packager --locked --version 0.11.8` on
the Windows runner (or a binstall/install-action equivalent). The config
must set `name` — auto-discovery and `-c <file>` both route through
`find_nearset_pkg_name`, which calls `set_current_dir` on the *config
file* path and fails ("The directory name is invalid", os error 267)
whenever `name` is absent. There is no version-override flag, so the
release version gets patched into the config before the run, the same
way `tauri.conf.json`'s already is. `resources.src` can point straight
at `apps/gui/src-tauri/sidecar-dist/cannet-python-can`, so no staging
step is needed beyond what the release workflow already does.

### 2026-08-13 — phase 2: `--sidecar-dir` flag

`cannet-server` gains `--sidecar-dir <PATH>`, beside the other
`--sidecar-*` flags on `ProxyArgs`. `CliSidecarHost::config()` resolves
it against `CANNET_SIDECAR_DIR` through
`cannet_sidecar::env_over_setting` — the same function
`apps/gui/src-tauri/src/sidecar.rs` uses for the `sidecar_dir` setting
— so the env var wins over the flag, the flag wins over nothing, and a
shadowed flag is logged rather than silently dropped. The `debug`
subcommands (`replay`, `vbus`) don't spawn a sidecar and so don't take
the flag.

Commit `1fbef59`. Tests: 3 new (`sidecar_dir_flag_parses_and_plumbs_through`,
`the_environment_wins_over_the_sidecar_dir_flag`,
`absent_both_resolves_to_none`) + 33 pre-existing bin-target tests, all
passing (36 total); `cargo clippy -p cannet-server --all-targets -- -D
warnings` and `cargo build -p cannet-server` both clean.

### 2026-08-13 — phase 3: the server inside the GUI bundle, and the PATH command

**Placement: a Tauri `resources` entry, not `externalBin`.** The server
is staged into `apps/gui/src-tauri/server-dist/` and declared as
`"server-dist": ""` — a directory entry whose *contents* land at the
bundle's resource root. Rationale, against the three criteria:

- *Probe*: the resource root is where the frozen onedir already lives,
  so `<server exe>/..` contains `cannet-python-can/` on **both**
  platforms — Windows install dir beside `cannet.exe`, macOS
  `Contents/Resources/`. **No probe extension was needed**, which
  amends the grooming note above (it assumed the macOS copy would land
  in `Contents/MacOS/`, which is exactly what `externalBin` would have
  done). `frozen_launcher_in`'s doc comment now names the bundle case
  and a new test, `the_gui_bundles_resource_root_is_the_same_adjacency`,
  is the guard against a future layout change breaking it silently.
  `externalBin` would additionally have demanded target-triple-suffixed
  file names.
- *macOS exec bit*: not directly verifiable from this machine, but the
  frozen sidecar launcher is **already** an executable shipped inside a
  resource *directory* and executed from `Contents/Resources/` in
  released macOS builds (`sidecar.rs::frozen_launcher_path` resolves it
  through `resource_dir()`), so the resource path demonstrably preserves
  the bit. The staging script copies with `shutil.copy2` (mode
  preserved) for the same reason. Recorded as the one open risk for the
  next release run: confirm `Contents/Resources/cannet-server` is `+x`
  in the built `.app`.
- *Dev ergonomics*: `build.rs` creates the empty `server-dist/` in debug
  builds, exactly as it already does for `sidecar-dist/`, so `tauri dev`
  and a bare `cargo build -p cannet-gui` work in a tree that has never
  built the server (verified: built clean after deleting the directory).

**Staging: `scripts/stage-server.py`**, called from
`beforeBuildCommand` beside `build-sidecar.py`. It builds
`cargo build --release -p cannet-server` and copies the binary in, so a
bundle can never be built around a stale or absent server. The target
triple comes from `CANNET_SERVER_TARGET`; the release workflow sets it
job-wide, so its own fail-fast server build and the beforeBuildCommand
run share one `target/<triple>/release/` artifact instead of building
the server twice (the workflow's old explicit `cargo build` step is now
that same script).

**Palette command `server.addToPath` — "Add cannet-server to PATH"**
(category `App`, `apps/gui/src-tauri/src/server_path.rs`). Host command
`add_server_to_path` resolves the bundled server through
`resource_dir()`, refuses when the binary is not there (a dev build
stages none), edits the user environment, and reports both outcomes
itself via `sys_info!`/`sys_error!` — the System Messages panel is where
command results are read in this app, and the status-bar transient is
derived from `LogState` and not addressable from a command. The
frontend handler is therefore one `invoke` and no view state.

- *Windows*: `HKCU\Environment\Path`, read and written through
  PowerShell (absolute interpreter path — this must not depend on the
  `PATH` it is editing). Two lessons from phase 1 are carried over: the
  read is explicitly `DoNotExpandEnvironmentNames`, and the new entry is
  appended to the raw string rather than to a split-and-rejoined list,
  so empty entries survive (**the owner's own PATH contains one** — see
  the round-trip below). Beyond phase 1: the value's registry *kind* is
  read and written back unchanged, so a `REG_EXPAND_SZ` PATH is not
  demoted to `REG_SZ` (which would stop `%USERPROFILE%`-style entries
  expanding). PowerShell rather than `winreg`: no new dependency, and
  the `mklink` precedent in `project_dir.rs` is the house pattern for
  one-off Windows work under `unsafe_code = "forbid"`.
- *The `WM_SETTINGCHANGE` broadcast is not skipped.* Broadcasting it
  directly needs Win32 FFI this crate forbids, but .NET's user-scope
  `SetEnvironmentVariable` broadcasts as part of its contract, so the
  write script ends by *deleting* a variable that was never set: a
  registry no-op with exactly the wanted side effect. Without it a new
  terminal would keep the old PATH until the next logon, because
  Explorer hands out its cached environment block.
- *macOS*: one marked `export` line appended to `~/.zprofile`. A
  directory containing `"`, `$`, `` ` `` or `\` is refused rather than
  written into a login profile.
- Both idempotent; the deciding logic is pure functions
  (`user_path_with`, `zprofile_with`, `parse_user_path`) compiled on
  every platform behind `cfg_attr(…, allow(dead_code))`, so Linux CI
  runs the Windows *and* macOS semantics even though it executes
  neither.

Commits `540b618` (bundle placement) and `0a3e88e` (palette command).
Tests: **cannet-server** 37 (1 new); **cannet-gui host** 588 (14 new in
`server_path`); **frontend** 1930 across 151 files (2 new in
`App.addServerToPath.dom.test.tsx`, which drives the real App through
the real palette chord). `cargo clippy -p cannet-gui --all-targets -- -D
warnings` and `-p cannet-server` both clean; `pnpm --dir apps/gui build`
clean.

**Live verification.** The GUI NSIS bundle was installed at
`%LOCALAPPDATA%\cannet` (`cannet-gui.exe`, `cannet-server.exe`,
`cannet-python-can\`, `uninstall.exe`).

- *Palette command, owner-verified (2026-08-13).* The owner ran "Add
  cannet-server to PATH" from the installed GUI's command palette and
  confirmed a fresh terminal resolves `cannet-server` — the palette
  command's exit criterion.
- *Bundled server, terminal-verified.* `cannet-server.exe --bind
  127.0.0.1:50051` launched directly from `%LOCALAPPDATA%\cannet`, cwd
  the user's home directory (not the install dir). Startup log: `exec:
  %LOCALAPPDATA%\cannet\cannet-python-can\cannet-python-can.exe`
  — the frozen sidecar beside the GUI install, confirming the
  resource-root placement's no-probe-extension claim above. Two PCAN
  interfaces enumerated: `pcan:PCAN_USBBUS1` and `pcan:PCAN_USBBUS2`
  (PEAK PCAN-USB FD, both `fd`). The sidecar's own log,
  `%LOCALAPPDATA%\cannet-server\sidecar-python-can.log`, independently
  records the same logfile path, timestamp, and interface pair. The
  process was killed after the check; `ps aux` and
  `tasklist` afterward show no `cannet-server` or `cannet-python-can`
  process remaining (the kill did not produce a graceful
  `shutdown reason=` line in the sidecar log the way a stdin-EOF exit
  does, but no process was left behind).
- *Registry, read-only.* `HKCU\Environment\Path` (queried via
  PowerShell `Get-ItemProperty`, no write) contains exactly one
  `cannet` entry: `\\?\%LOCALAPPDATA%\cannet` (extended-length-prefixed),
  appended by the palette command. Not modified by this check.
- *Installed bundle left untouched*: the uninstaller was not run, the
  GUI was not launched, and nothing under `%LOCALAPPDATA%\cannet` or
  `%LOCALAPPDATA%\cannet-server` was edited beyond the log entries the
  verification run itself produced.
- *Note for future phases:* an earlier attempt at this verification
  was aborted because it required driving the installed GUI (clicking
  the palette command, reading its result) — synthetic input and
  window-focus dependence are forbidden on this machine. The palette
  command's own verification was therefore split off to the owner
  (who ran it by hand), while everything reachable from a terminal
  (the bundled server's process, the registry) was verified directly.

### 2026-08-13 — defect: verbatim `\\?\` path written into PATH

The registry read-only check above recorded the owner's live entry as
`\\?\%LOCALAPPDATA%\cannet` — `resource_dir()` returns a `\\?\`-prefixed
verbatim path on Windows, and the palette command wrote it into
`HKCU\Environment\Path` unnormalized. It resolves, but a verbatim entry
in PATH confuses some tools and reads as broken.

Fix: `bundled_server_dir` now strips the `\\?\` (and `\\?\UNC\` → `\\`)
prefix via a new hand-rolled `strip_verbatim_prefix` helper before the
directory is compared against or written into PATH — no new dependency
(the workspace only carries `dunce` transitively, not as a direct
dependency, so it wasn't pulled in for this). `user_path_with` also
now recognizes a pre-existing verbatim entry as the same directory and
*replaces* it with the plain form instead of appending a duplicate;
re-running the palette command against the owner's current PATH will
fix that entry in place. Re-running once more reports already-present.
Four new tests in `server_path` cover this: plain-append (pre-existing
coverage), verbatim-entry replacement, replacement idempotency, and the
`\\?\UNC\` share form, plus a direct test of the helper. macOS's
`~/.zprofile` line was checked and already writes a plain absolute
path — no `\\?\` equivalent there, no change needed.

### 2026-08-13 — phase 4a: the Windows NSIS installer, shipped

`crates/cannet-server/packaging/` carries `packager.toml` and the
vendored `installer-cli.nsi`; the release workflow's Windows leg
installs `cargo-packager` pinned, packages after the Tauri bundle step
(which is what produced this runner's `sidecar-dist/` onedir), and
uploads the installer beside the zip.

**Config decisions beyond phase 1's trial.**

- *Inputs need no staging.* `binariesDir` is
  `apps/gui/src-tauri/server-dist` and the resource `src` is
  `apps/gui/src-tauri/sidecar-dist/cannet-python-can` — both stable
  paths that `scripts/stage-server.py` and the sidecar freeze already
  fill, on every runner and locally, with no target triple or profile
  directory in them. Only `version` is patched by CI, in the same step
  that patches `tauri.conf.json` and into the same local commit, so the
  vergen cleanliness assert still passes.
- *Install directory* is `%LOCALAPPDATA%\Programs\cannet-server`, via an
  `InstallDir` line in `preinstallSection` (NSIS takes that attribute at
  top level). Setting it means `$INSTDIR` is already non-empty when the
  template's `.onInit` runs, so `RestorePreviousInstallLocation` is
  skipped — an upgrade takes the default rather than a previously chosen
  directory, which is acceptable for a tool whose install location is
  not a documented choice.
- *The PATH scripts are phase 3's semantics, not phase 1's.* Phase 1
  used `[Environment]::GetEnvironmentVariable/SetEnvironmentVariable`,
  which expands `%VAR%` entries on read and can demote a
  `REG_EXPAND_SZ` `PATH` to `REG_SZ` on write. The shipped scripts read
  `HKCU\Environment` with `DoNotExpandEnvironmentNames`, write the value
  back with its own registry kind, and append to the raw string rather
  than a split-and-rejoined list — the same three rules
  `apps/gui/src-tauri/src/server_path.rs` follows. Install and uninstall
  are exact inverses: install appends `;<dir>`, uninstall splits on `;`,
  drops only entries naming that directory, and rejoins, which
  reproduces the original string including empty entries.
- *Two residues phase 1 saw are fixed*, in a `Function un.onUninstSuccess`
  (a callback the template does not define) rather than a section, so an
  uninstall that aborts because the server is still running has not
  already had its directory removed: `RMDir /r` on the onedir directory
  tree the template only shallow-`RMDir`s, and `DeleteRegKey` on
  `HKCU\Software\cannet\cannet-server`, which the template writes and
  never removes.
- *The fork is 48 lines of 671, all deletions* (623 remain); `diff`
  against the pinned upstream copy shows no added line, which is the
  check that it has not drifted. The inventory's "47" was off by one.

**Local verification** (owner's Windows 11 box, silent throughout — no
installer window was ever shown; `Start-Process … '/S' -Wait`).

- Round trip, one run: install exit 0 → user `PATH` gained exactly one
  entry, `C:\…\AppData\Local\Programs\cannet-server`, **plain, not
  `\\?\`-verbatim**, appended at the end; value kind still `String`; the
  owner's pre-existing empty entry and their `\\?\`-prefixed GUI entry
  both untouched. Uninstall exit 0 → install directory gone entirely (0
  files, 0 directories), both registry keys gone, and the user `PATH`
  **byte-identical to the pre-install capture**: SHA-256 of the raw
  (unexpanded) value `6FB8105D…BC6E24A0` before and after. The server's
  own data directory `%LOCALAPPDATA%\cannet-server` (access token, TLS
  key pair, logs) was untouched throughout — the reason for the
  `Programs\` install path.
- Installed layout: `cannet-server.exe`, `cannet-python-can\` (131
  files), `uninstall.exe`. Add/Remove Programs entry present with
  DisplayName / DisplayVersion / Publisher / InstallLocation /
  UninstallString / EstimatedSize. **No Start-menu entry, no desktop
  shortcut, no run-on-finish.**
- End to end from a shell whose `PATH` was rebuilt from the machine +
  user registry values (what a fresh logon gets), cwd `C:\`:
  `cannet-server` resolved to
  `…\Programs\cannet-server\cannet-server.exe`, and the running server
  logged `exec:
  …\Programs\cannet-server\cannet-python-can\cannet-python-can.exe` and
  enumerated both PEAK PCAN-USB FD channels (`pcan:PCAN_USBBUS1`,
  `pcan:PCAN_USBBUS2`). Killed by process tree afterwards; no
  `cannet-server` or `cannet-python-can` process survived.
- Idempotency: a second `/S` install over the first left the `PATH`
  string unchanged (one entry naming the install directory, not two).

`actionlint` 1.7.7 (downloaded for the check, not committed) reports the
edited `release.yml` clean.

### 2026-08-13 — phase 4b: the Linux `.deb`

`[package.metadata.deb]` in `crates/cannet-server/Cargo.toml`; the
release workflow's server-only job installs `cargo-deb` pinned and runs
`cargo deb -p cannet-server --no-build --no-strip --target
"$RUST_TARGET" --deb-version <version>` after its existing build,
freeze and tar steps, then uploads the `.deb` beside the tar.gz.

- *No triple in the config.* cargo-deb **rejects** an asset source that
  spells out a cross-compilation path; `target/release/…` is a magic
  prefix it rewrites for whatever `--target` it is given. So the
  binary asset is `target/release/cannet-server` and the config is
  target-agnostic.
- *No `mode` on the onedir asset.* Omitting it makes cargo-deb read each
  file's own mode from disk, which is what keeps the frozen launcher
  executable; forcing one mode over the whole tree would not.
- *`--no-strip`* so the packaged binary is byte-for-byte the one in the
  tar.gz — a panic backtrace from a `.deb` install says the same thing
  as one from the archive.
- *Version* comes from `--deb-version` on the command line, so unlike
  the NSIS config there is no placeholder in the manifest to patch. The
  crate version stays 0.0.0.
- `[package] description` was added to the crate: a Debian
  `Description:` field needs a first line, and cargo-deb takes it from
  there.

**Local verification.** cargo-deb is pure Rust, so it built a real
`.deb` on this Windows box against a stand-in Linux binary and the real
(Windows) onedir as a stand-in tree. Two things needed a temporary
local edit that is **not** committed — a forced `mode` on the onedir
asset, because file modes are unreadable on Windows — and one flag that
is committed, `--no-strip`, because `strip` does not exist here either.
The resulting `cannet-server_0.1.0_amd64.deb` was unpacked by parsing
the `ar` container and the xz tarballs directly (no `dpkg` on this
machine):

- `control`: well-formed, `Package: cannet-server`, `Version: 0.1.0`,
  `Architecture: amd64`, `Section: net`, `Priority: optional`,
  maintainer set, `Description:` first line plus the wrapped extended
  description, correctly UTF-8 encoded.
- `data.tar.xz`, 167 entries, all `uid=0:0`:
  `./usr/lib/cannet-server/cannet-server` (regular, `0o755`),
  `./usr/lib/cannet-server/cannet-python-can/…` (the onedir tree, its
  directory structure preserved by the `**/*` glob), and
  `./usr/bin/cannet-server` as a **symlink** whose target cargo-deb
  rewrote to the Debian-policy relative form
  `../lib/cannet-server/cannet-server`. Plus
  `./usr/share/doc/cannet-server/copyright`.

**Still CI-only** (recorded for the next release run): `dpkg-shlibdeps`
cannot run here, so the built `Depends:` was empty. On the Linux runner
`$auto` will fill it — and it resolves over *every* ELF in the package,
including the `.so` files PyInstaller already bundles, so the generated
`Depends:` line is worth reading once. If it over-constrains the
package (a dependency on a library the bundle carries itself), pin
`depends` explicitly instead. Installing and running the `.deb` on a
Debian/Ubuntu host is the other next-release check.

- **New maintenance obligation (phase 1, accepted):** the Windows leg
  carries a vendored fork of `cargo-packager`'s `installer.nsi`. The
  fork is deletion-only and `cargo-packager` is version-pinned, so the
  cost is a re-diff on each bump — but it is a standing cost, and the
  only alternative is dropping the "no Start-menu shortcut / no
  run-on-finish" ruling, which no config knob can satisfy.
