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
    exe (probe works); macOS `Contents/Resources/` needs the one
    probe extension (check the resource dir on macOS).
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

## Blockers / side effects

- **New maintenance obligation (phase 1, accepted):** the Windows leg
  carries a vendored fork of `cargo-packager`'s `installer.nsi`. The
  fork is deletion-only and `cargo-packager` is version-pinned, so the
  cost is a re-diff on each bump — but it is a standing cost, and the
  only alternative is dropping the "no Start-menu shortcut / no
  run-on-finish" ruling, which no config knob can satisfy.
