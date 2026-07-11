# Task 31 — Frozen python-can Sidecar Binary

Ship the `cannet-python-can` sidecar to end users as a **frozen,
self-contained binary** (PyInstaller onedir), so an installed cannet
launches the sidecar with no Python, no `uv`, and no network on the
user's machine. See [ADR 0036](../../docs/adr/0036-frozen-python-can-sidecar.md).

This is the robust replacement for the never-built "fetch `uv` at
install/first-run" flow that Task 24 and Task 26 (§ Out of scope) still
reference. The triggering bug: an installer built today ships only the
GUI exe — no sidecar source, no `uv` — so the sidecar never launches.

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
   the Task 26 release workflow.
5. **Docs** — README: replace the fetch-`uv` prose (§ sidecar,
   Downloads) with the frozen-sidecar story; note `uv` is now dev-only.
   `technology-inventory.md` PyInstaller entry (done as part of capturing
   this task). Two present-tense statements become false only once the
   freeze ships and must flip **in the same change**:
   - [ADR 0008](../../docs/adr/0008-python-can-sidecar.md) — "the
     sidecar's first launch materialises the venv" describes the dev
     flow; end users now get the frozen binary.
   - [`servers/cannet-python-can/LICENSING.md`](../../servers/cannet-python-can/LICENSING.md)
     — "ships no `python-can` binary; the user's `uv sync` fetches it
     from PyPI" is no longer true: the frozen binary **bundles**
     `python-can` / `grpcio` / `protobuf` (all permissive), and
     PyInstaller's own GPL-with-exception terms apply to the freeze
     tooling. Redo the licensing note for what we now redistribute.

## Decisions (resolved)

- **onedir, not onefile.** Faster start, no `%TEMP%` self-extraction —
  more robust on Windows against locked-down temp and AV re-scans. See
  ADR 0036.
- **Frozen path is top priority; `uv`/`python3` stay as dev fallbacks.**
- **Vendor DLLs stay user-installed**, loaded via `ctypes` at runtime —
  not frozen in (licensing; they are the user's hardware SDK).

## Out of scope

- Code signing / notarization of the frozen binary — rides on the Task
  26 signing follow-up.
- Removing the `uv`/`python3` launch paths — they remain the dev flow.

## Exit criteria

- `scripts/build-sidecar.py` produces a runnable onedir sidecar on a
  clean tree.
- An installed cannet (from `tauri build`) launches the frozen sidecar
  with no `uv`/Python present on `PATH` and no network.
- CI builds and smoke-runs the frozen sidecar on the release runners.
- Task 24 / Task 26 references to the end-user `uv` fetch flow are
  reconciled to point at this task's frozen approach.
- README + `technology-inventory.md` match the shipped behavior; ADR
  0036 recorded.
