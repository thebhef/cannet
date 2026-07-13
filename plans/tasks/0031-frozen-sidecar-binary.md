# Task 31 — Frozen python-can Sidecar Binary

Ship the `cannet-python-can` sidecar to end users as a **frozen,
self-contained binary** (PyInstaller onedir), so an installed cannet
launches the sidecar with no Python, no `uv`, and no network on the
user's machine. See [ADR 0036](../../docs/adr/0036-frozen-python-can-sidecar.md).

This is the robust replacement for the never-built "fetch `uv` at
install/first-run" flow the earlier distribution planning (former
Task 26) deferred. The triggering bug: an installer built today ships
only the GUI exe — no sidecar source, no `uv` — so the sidecar never
launches.

## Background — the pinned freeze recipe

The recipe below is proven by a spike (built and run on Windows; the
frozen binary enumerated real PEAK hardware and emitted its
`sidecar\tlistening\t<addr>` banner). Two dynamic-import hazards make
the flags non-optional:

- The sidecar loads its driver via `importlib.import_module(...)`
  (`server.py:load_driver`) — invisible to PyInstaller's static graph.
- `python-can` discovers backends via entry points — likewise invisible.

Flags (onedir, entry is a committed shim
`servers/cannet-python-can/pyinstaller_entry.py` that calls
`cannet_python_can.__main__:main`, since `__main__` uses relative
imports and PyInstaller needs a concrete `.py` entrypoint, not a
`module:function`):

```
--onedir --name cannet-python-can
--collect-submodules cannet_python_can    # our importlib-loaded driver
--collect-submodules can                  # python-can backend plugins
--copy-metadata python-can
--collect-all grpc
--copy-metadata grpcio
--copy-metadata protobuf
```

Artifact (~40 MB): the launcher
`<distpath>/cannet-python-can/cannet-python-can[.exe]` beside its
`_internal/` directory. The launcher runs only from within its own
directory.

**Interpreter pin.** The `uv.lock` `requires-python` is a *range*
(`>=3.13`) and the dev `.venv` has already floated to 3.14.2, so nothing
today fixes which CPython gets frozen — Windows and macOS runners would
each embed whatever their `uv` default resolves to. A committed
`servers/cannet-python-can/.python-version` (`3.14`, written by
`uv python pin 3.14`) is the single interpreter pin, honoured by dev
`uv run`, the build script, and CI alike. Minor-only: patch floats so
security fixes land; the minor is pinned because per-minor wheel
availability (`grpcio`/`python-can` ship `cpXX` wheels) is where
cross-minor drift bites.

## Steps

1. **Build script** — `scripts/build-sidecar.py` encoding the recipe
   above; reproducible, per-OS. Runs via `uv run --with pyinstaller`,
   honours the committed `.python-version`, and emits `--distpath
   apps/gui/src-tauri/sidecar-dist` so the onedir lands at
   `apps/gui/src-tauri/sidecar-dist/cannet-python-can/` (gitignore that
   dir). **It smoke-tests the artifact it just built by default** (see
   Step 4) — a `--no-smoke` escape exists but the happy path proves
   "built *and* runnable" in one exit code. On macOS it guarantees the
   launcher's exec bit and asserts the PyInstaller ad-hoc arm64
   signature (see § macOS). → verify: from a clean tree it produces a
   runnable onedir whose launcher emits the `listening` banner.
2. **Host launcher** — add a top-priority `LaunchPath::Frozen` in
   `apps/gui/src-tauri/src/sidecar.rs`. Resolve the launcher via
   Tauri's framework-canonical `app.path().resource_dir()` joined with
   `cannet-python-can/cannet-python-can[.exe]` — **not** the exe
   walk-up `resolve_sidecar_dir` uses, because on macOS the bundled
   resources land in `Contents/Resources/` (a sibling of the exe's
   `Contents/MacOS/`, never an ancestor). The frozen resolver therefore
   needs the `AppHandle`; the `uv`/`python3` dev paths stay handle-free
   and CWD-independent as before. Run the frozen launcher directly (no
   `sidecar_dir`, no `uv`). TDD the resolver + `build_command`. →
   verify: `cargo test -p cannet-gui` green.
3. **Bundle wiring** — `tauri.conf.json` `bundle.resources` in **map
   form**: `{ "sidecar-dist/cannet-python-can": "cannet-python-can" }`,
   pinning the target folder name to `cannet-python-can/` regardless of
   the source path, so it lands at `<resource_dir>/cannet-python-can/`
   on both OS. The output path stays *inside* `src-tauri/` (Tauri
   breaks on resources escaping the config dir upward). → verify:
   `tauri build` places the folder; an installed app spawns the frozen
   sidecar (System Messages shows "starting sidecar via frozen binary"
   then the `listening` line).
4. **CI** — the smoke check runs the **frozen** launcher (not `uv run`
   against source — only executing the artifact exercises the
   `--collect-submodules` / `importlib` driver-load paths and proves the
   embedded interpreter boots): stdin held open (the parent-death
   contract), read stdout until `sidecar\tlistening\t<addr>`, success on
   that prefix, **30s** failure ceiling, kill on the way out. Wiring:
   - `ci.yml` (Linux) — a freeze + smoke job so a collection regression
     fails per-PR, cheaply and OS-independently.
   - `release.yml` — a dedicated **"Build frozen sidecar"** step (not
     folded into `beforeBuildCommand`) *before* the `tauri-action` step
     on each native runner (Windows x64, macOS arm64), then the smoke
     gate, then the bundle. `astral-sh/setup-uv` provisions uv; uv
     provisions the pinned CPython — no separate `setup-python`.
5. **Docs** — README: replace the fetch-`uv` prose (§ sidecar,
   Downloads) with the frozen-sidecar story; note `uv` is now dev-only.
   **Add the `technology-inventory.md` PyInstaller entry and update the
   `python-can` entry — it is now redistributed, and its license string
   is currently wrong (`Apache-2.0` → `LGPL-3.0-only`). Not yet done;
   this task owns both fixes.** Also fix `CLAUDE.md`'s stale "committed
   `.venv`" claim (the `.venv` is untracked). One present-tense
   statement becomes false only once the freeze ships and must flip **in
   the same change**:
   - [ADR 0008](../../docs/adr/0008-python-can-sidecar.md) — "the
     sidecar's first launch materialises the venv" describes the dev
     flow; end users now get the frozen binary.

   [`servers/cannet-python-can/LICENSING.md`](../../servers/cannet-python-can/LICENSING.md)
   has already been rewritten for the frozen model (bundles
   `python-can` / `grpcio` / `protobuf` / CPython; LGPL-3.0 §4
   compliance via the onedir layout). When the build lands, **verify
   the onedir path and collection flags it describes match what the
   build produces**, and adjust if they diverged.
6. **Third-party license file** — a committed static
   `THIRD-PARTY-LICENSES` (four fixed deps, stable texts — no
   generation machinery) carrying the LGPL-3.0 + GPL-3.0 texts (for
   `python-can`) and the Apache-2.0 `NOTICE` / BSD / PSF texts (for
   `grpcio` / `protobuf` / CPython), per LICENSING.md § `python-can`.
   It is the single source: shipped as a top-level `bundle.resources`
   entry (installer) **and** `include_str!`'d into the host for the
   About view (Step 7). → verify: the file is present in the built
   installer.
7. **About view** — extract the About out of `SettingsPanel` into a new
   singleton `AboutPanel` (fixed dockview id, its own command-palette
   entry), holding the build version **plus** a third-party-licenses
   section fed by the `include_str!`'d `THIRD-PARTY-LICENSES` via a
   small Tauri command. **Remove** the About `<fieldset>` from
   `SettingsPanel` entirely — nothing retained there. This completes the
   LGPL §4a–c "prominent notice" runtime surface and **retires the
   backlog `[docs]` "Runtime about third-party attribution surface"
   item** (delete it from `plans/backlog.md`). → verify: `pnpm --dir
   apps/gui test` green; the palette opens AboutPanel; Settings no
   longer shows About.

## macOS: making the nested binary execute (unsigned posture)

Signing/notarization is out of scope, but three macOS hazards must be
handled so the arm64 installer actually *launches* the sidecar:

- **Exec bit.** Tauri's resource copy does not reliably preserve the
  executable permission; the build (and a post-bundle check) guarantees
  the launcher is `+x`.
- **arm64 mandatory signature.** Apple Silicon refuses to execute any
  mach-o lacking at least an **ad-hoc** signature. PyInstaller
  ad-hoc-signs its output; the macOS smoke run asserts the launcher is
  signed so a toolchain change that drops it fails the build.
- **Quarantine / Gatekeeper.** Bundles ship unsigned, so a downloaded
  `.app` is quarantined and the user does the standard right-click-Open
  (same as today's GUI); the nested sidecar inherits that admission.

The long-term fix (no quarantine friction) is Developer ID signing +
notarization + stapling — an Apple Developer account ($99/yr) + CI
secrets, applied to the whole `.app` (nested `_internal/*.dylib`
included) by `tauri-action`. It re-signs the *same* onedir tree, so
nothing here blocks or is wasted by it. It stays the deferred signing
follow-up (backlog § signing).

## Decisions (resolved)

- **onedir, not onefile.** Faster start, no `%TEMP%` self-extraction —
  more robust on Windows against locked-down temp and AV re-scans. See
  ADR 0036.
- **Frozen path is top priority; `uv`/`python3` stay as dev fallbacks.**
- **Frozen launcher resolves via `resource_dir()`**, not the exe
  walk-up — the framework-canonical answer, and the only one that finds
  `Contents/Resources/` on macOS.
- **Interpreter pinned minor-only** (`.python-version = 3.14`); the
  lockfile is a range and cannot serve as the interpreter pin.
- **`THIRD-PARTY-LICENSES` is one committed static file**, shipped as a
  resource *and* `include_str!`'d into the About view.
- **Vendor DLLs stay user-installed**, loaded via `ctypes` at runtime —
  not frozen in (licensing; they are the user's hardware SDK).

## Out of scope

- Code signing / notarization of the frozen binary — rides on the
  signing follow-up in the backlog (§ signing). Ad-hoc arm64 signing
  (free, no account) is in scope only insofar as it's what lets the
  binary execute unsigned.
- Removing the `uv`/`python3` launch paths — they remain the dev flow.
- A user-chosen sidecar-path override — separate backlog `[sidecar]`
  item.

## Exit criteria

- `scripts/build-sidecar.py` produces a runnable onedir sidecar on a
  clean tree and smoke-passes the frozen launcher by default;
  `.python-version` and the committed entry shim are in place.
- An installed cannet (from `tauri build`) launches the frozen sidecar
  via `resource_dir()` with no `uv`/Python present on `PATH` and no
  network, on Windows x64 and macOS arm64.
- CI smoke-runs the frozen sidecar on Linux (`ci.yml`) and builds +
  smoke-runs it on the Windows/macOS release runners (`release.yml`),
  producing versioned installers.
- Remaining planning-doc references to the end-user `uv` fetch flow are
  reconciled to point at this task's frozen approach.
- README + `technology-inventory.md` + `CLAUDE.md` match the shipped
  behavior (PyInstaller and updated `python-can` entries; `.venv` no
  longer described as committed). ADR 0036 carries the durable
  decisions — corrected for the `resource_dir()`/macOS layout and
  extended with the interpreter-pin and macOS-execution consequences
  (no new ADR: these are refinements of the freeze decision, not
  standalone ones).
- The installer carries a `THIRD-PARTY-LICENSES` file (LGPL-3.0 +
  GPL-3.0 + Apache `NOTICE` / BSD / PSF), satisfying LICENSING.md's
  §4 obligations for the redistributed frozen dependencies.
- The About lives in a singleton `AboutPanel` (version + third-party
  licenses); Settings no longer carries an About section; the backlog
  `[docs]` attribution item is deleted.
