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

Flags (onedir, entry is a tiny script that calls
`cannet_python_can.__main__:main`, since `__main__` uses relative
imports):

```
--onedir --name cannet-python-can
--collect-submodules cannet_python_can    # our importlib-loaded driver
--collect-submodules can                  # python-can backend plugins
--copy-metadata python-can
--collect-all grpc
--copy-metadata grpcio
--copy-metadata protobuf
```

Artifact (~40 MB): `dist/cannet-python-can/cannet-python-can[.exe]` +
`_internal/`. The launcher runs only from within its own directory.

## Steps

1. **Build script** — `scripts/build-sidecar.py` (or `.sh`) encoding the
   recipe above; reproducible, per-OS, output to a known `dist/` path.
   Runs via `uv run --with pyinstaller`. → verify: from a clean tree it
   produces a runnable onedir whose launcher emits the `listening`
   banner.
2. **Host launcher** — add a top-priority `LaunchPath::Frozen` in
   `apps/gui/src-tauri/src/sidecar.rs`: resolve
   `cannet-python-can/cannet-python-can[.exe]` next to the GUI exe and
   run it directly (no `sidecar_dir`, no `uv`). Keep `uv`/`python3` paths
   as developer fallbacks. TDD the resolver + `build_command`. → verify:
   `cargo test -p cannet-gui` green.
3. **Bundle wiring** — `tauri.conf.json` `bundle.resources` maps the
   onedir `dist/` folder into the install as `cannet-python-can/`, the
   layout `resolve_sidecar_dir`'s production probe already expects. → verify:
   `tauri build` places the folder; an installed app spawns the frozen
   sidecar (System Messages shows "starting sidecar via frozen binary"
   then the `listening` line).
4. **CI** — build the frozen sidecar on each native release runner
   alongside the Tauri bundle, and **smoke-run it** (assert the
   `listening` banner) so a dependency bump that breaks dynamic-import
   collection fails the build, not the user's first launch. Folds into
   the release workflow (`release.yml`, former Task 26).
5. **Docs** — README: replace the fetch-`uv` prose (§ sidecar,
   Downloads) with the frozen-sidecar story; note `uv` is now dev-only.
   **Add the `technology-inventory.md` PyInstaller entry and update the
   `python-can` entry — it is now redistributed, and its license string
   is currently wrong (`Apache-2.0` → `LGPL-3.0-only`). Not yet done;
   this task owns both fixes.** One present-tense statement becomes false only
   once the freeze ships and must flip **in the same change**:
   - [ADR 0008](../../docs/adr/0008-python-can-sidecar.md) — "the
     sidecar's first launch materialises the venv" describes the dev
     flow; end users now get the frozen binary.

   [`servers/cannet-python-can/LICENSING.md`](../../servers/cannet-python-can/LICENSING.md)
   has already been rewritten for the frozen model (bundles
   `python-can` / `grpcio` / `protobuf` / CPython; LGPL-3.0 §4
   compliance via the onedir layout). When the build lands, **verify
   the onedir path and collection flags it describes match what the
   build produces**, and adjust if they diverged.
6. **Third-party license file** — ship a `THIRD-PARTY-LICENSES` file in
   the installer carrying the LGPL-3.0 + GPL-3.0 texts (for
   `python-can`) and the Apache-2.0 `NOTICE` / BSD / PSF texts (for
   `grpcio` / `protobuf` / CPython), per LICENSING.md § `python-can`. →
   verify: the file is present in the built installer. (A runtime
   about-box attribution surface is a follow-up — see backlog.)

## Decisions (resolved)

- **onedir, not onefile.** Faster start, no `%TEMP%` self-extraction —
  more robust on Windows against locked-down temp and AV re-scans. See
  ADR 0036.
- **Frozen path is top priority; `uv`/`python3` stay as dev fallbacks.**
- **Vendor DLLs stay user-installed**, loaded via `ctypes` at runtime —
  not frozen in (licensing; they are the user's hardware SDK).

## Out of scope

- Code signing / notarization of the frozen binary — rides on the
  signing follow-up in the backlog (§ Packaging and naming).
- Removing the `uv`/`python3` launch paths — they remain the dev flow.

## Exit criteria

- `scripts/build-sidecar.py` produces a runnable onedir sidecar on a
  clean tree.
- An installed cannet (from `tauri build`) launches the frozen sidecar
  with no `uv`/Python present on `PATH` and no network.
- CI builds and smoke-runs the frozen sidecar on the release runners.
- Remaining planning-doc references to the end-user `uv` fetch flow are
  reconciled to point at this task's frozen approach.
- README + `technology-inventory.md` match the shipped behavior (the
  PyInstaller and updated `python-can` entries land here); ADR 0036
  recorded.
- The installer carries a `THIRD-PARTY-LICENSES` file (LGPL-3.0 +
  GPL-3.0 + Apache `NOTICE` / BSD / PSF), satisfying LICENSING.md's
  §4 obligations for the redistributed frozen dependencies.
