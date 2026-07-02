# Task 26 — Distribution Bundles + CI

Stand up continuous integration and a downloadable-bundle release
pipeline so an alpha can be put in users' hands without anyone running
`tauri build` by hand.

## CI (`.github/workflows/ci.yml`)

Runs the documented test + lint suite (README § Tests and lint) on
**pull requests and every push to main**. Linux runner; the Tauri GUI
crate links the system WebView, so the webkit2gtk dev libraries are
installed before the Rust build. Building on main is cheap (Linux, 1×
minutes); the expensive cross-platform bundle build runs only at
release time.

- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `pnpm --dir apps/gui test`
- `pnpm --dir apps/gui build`

A **backend perf smoke** job also runs the perf harness's two
virtual-hardware modes (`tracebuffer`, `grpc`) plus `validate` end-to-end,
failing only if the harness errors. On a PR it posts the run's metrics as
a sticky comment, each figure beside the committed baseline as
`current (reference)`. That comparison is deliberately **display-only**,
not a `check` gate: the baseline came from a developer machine, not the
runner, and perf baselines are environment-relative (a baseline is only
meaningful on the machine that captured it — ADR 0031), so automated
absolute-number gating on an ephemeral shared runner would be flaky or
meaningless. `fps_retention` (a ratio) is the one figure that survives the
machine change. The `hardware-peak` mode is excluded — no PEAK adapters on
the runner.

## Release (`.github/workflows/release.yml`)

Triggered **manually** (`workflow_dispatch`) from the Actions tab with
a `version` input (e.g. `0.1.0`) — deliberately not on every main commit,
to avoid burning macOS runner minutes (10×) and accumulating a release
per commit. A **gate job** runs the full CI suite first (`ci.yml` is
exposed as a reusable workflow and called via `needs:`), so a release
never publishes from a commit whose tests/clippy fail. Once green, it
tags the commit `vX.Y.Z`, injects the version, and builds **unsigned**
bundles on native runners (Tauri cannot cross-compile), publishing them
to a **draft pre-release** for review before publishing:

| Target                        | Runner           | Artifacts           |
|-------------------------------|------------------|---------------------|
| macOS Apple Silicon (aarch64) | `macos-latest`   | `.dmg`, `.app`      |
| Windows x64                   | `windows-latest` | `.msi`, NSIS `.exe` |

`tauri-apps/tauri-action` does the build + release upload; the matrix
jobs converge on one release keyed by the tag.

## Versioning — `git describe` + vergen

The committed version stays `0.0.0` everywhere. The real version is
**generated at build time**:

- **Binary:** `build.rs` uses vergen to emit `git describe --tags`
  (`VERGEN_GIT_DESCRIBE`); `build_version()` in `lib.rs` reads it (with a
  Cargo-version fallback for non-git builds) and the `app_version`
  command surfaces it in the title bar.
- **Installer / bundle:** the release workflow injects the dispatch
  `version` input into `tauri.conf.json` before building and tags the
  commit `vX.Y.Z`, so installer filenames, the Windows MSI
  ProductVersion, and the binary's `git describe` all agree.

To cut a release: run the **Release** workflow from the Actions tab and
enter the version (e.g. `0.1.0`).

## Reproducible builds — pinned toolchains

Local and CI must run identical tool versions, or the `-D warnings`
clippy gate (the workspace opts into `clippy::pedantic`) breaks every
time stable clippy adds a lint. Rust is pinned in `rust-toolchain.toml`
(rustup auto-installs it + the clippy/rustfmt components); pnpm via the
`packageManager` field in `apps/gui/package.json`. Bump either
deliberately, fixing any newly-surfaced lints in the same change.

## Decisions (resolved)

- **Unsigned to start.** macOS Gatekeeper / Windows SmartScreen will
  warn; users do right-click → Open (macOS) / "More info → Run anyway"
  (Windows). Signing is a follow-up (below).
- **Manual download** from GitHub Releases. No in-app auto-updater.
- **macOS Apple Silicon only** (arm64). No Intel/universal build.

## Out of scope (follow-ups)

- **Code signing + notarization.** macOS: Apple Developer Program
  ($99/yr) + notarization. Windows: an OV/EV cert or Azure Trusted
  Signing. Wiring is straightforward once the accounts/secrets exist
  (`tauri-action` takes the signing env vars) — left out deliberately so
  the alpha isn't blocked on procurement.
- **Auto-update** (`tauri-plugin-updater`) — needs a separate update
  keypair and a release feed.
- **`uv` runtime in the bundle.** A distributed build still needs `uv`
  at runtime for the python-can sidecar (live hardware / virtual buses);
  that end-user fetch flow is Task 24. BLF/file workflows work without
  it.

## Exit criteria

- CI workflow green on a PR.
- Pushing a `v*` tag produces a draft pre-release carrying the macOS
  arm64 `.dmg` and Windows x64 `.msi`/NSIS installers.
- Running the app shows the build version in the title bar.
- README documents the download/Releases story and the tag-to-release
  flow; `technology-inventory.md` records vergen + the CI/packaging
  actions.
