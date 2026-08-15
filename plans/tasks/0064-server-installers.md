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
   - **macOS**: `.dmg` (owner-specified) carrying the server binary +
     `cannet-python-can/` onedir.
   - **Windows**: NSIS installer (owner-specified) installing binary +
     onedir; Start-menu entry / PATH convenience decided in grooming.
   - **Linux**: `.deb` (recommended as the most common server-host
     format; grooming may add `.rpm`). The plain archives **stay** —
     they are the no-installer path.
2. **GUI installers also ship `cannet-server`** (owner ruling
   2026-08-12: **ship the binary only** — launching stays an
   operator/terminal act, no in-app start/stop surface). The bundled
   server reuses the GUI install's frozen sidecar: the server's
   frozen-launcher probe must find the onedir where the GUI bundle
   puts it (Tauri resource layout), not only beside its own exe.

## Non-goals

- An in-app affordance to start/stop a local server (explicitly
  declined at grooming — revisit as its own task if wanted).
- Code signing / notarization (existing backlog item; these
  installers ship unsigned exactly like the GUI's).
- Service integration / auto-start (ADR 0040 non-goal stands).

## Open (groom before implementation)

- Windows NSIS conveniences: PATH? Start-menu shortcut to a console?
- macOS dmg layout for a CLI tool (drag-to-/Applications vs a folder
  the operator places; a `.pkg` alternative if dmg proves awkward —
  owner said "at least dmg").
- `.deb` specifics: install prefix, whether a man page rides along.
- Whether the GUI-bundled server binary lands beside the app exe or
  in resources, and what the README tells a GUI user about it.

## Exit criteria

- Release workflow produces: GUI bundles (now containing
  `cannet-server`), server `.dmg` + NSIS `.exe` + `.deb`, and the
  three existing plain archives — one draft pre-release.
- A server launched from a GUI install finds the bundled sidecar and
  serves hardware (verified on at least Windows locally).
- Each installer's install → run → uninstall path exercised on its
  OS where hardware allows; CI-only legs verified on the next
  release run.
- README's Downloads/Running sections document all install paths;
  `plans/technology-inventory.md` records any packaging tooling
  adopted (e.g. `cargo-deb`, `create-dmg`).
