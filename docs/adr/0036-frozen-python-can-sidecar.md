# ADR 0036 — The python-can sidecar ships to end users as a frozen self-contained binary

Status: accepted (2026-07-10)

Supersedes, for the sidecar, the end-user runtime-fetch consequence of
[ADR 0015](0015-fetched-runtime-binaries.md). Builds on
[ADR 0008](0008-python-can-sidecar.md) (why there is a python-can
sidecar at all).

## Decision

The `cannet-python-can` sidecar is distributed to end users as a
**frozen, self-contained binary** built with PyInstaller from our
sidecar source. The frozen artifact embeds a pinned CPython and the
sidecar's Python dependencies (`grpcio`, `protobuf`, `python-can`,
`uptime`). On an installed copy the sidecar needs **no Python, no `uv`,
and no network access** to run.

`uv` and a project venv (`uv run cannet-python-can`) remain the
**developer** flow and the input to the frozen build. They are not an
end-user dependency any more.

The artifact is a PyInstaller **onedir** bundle — a launcher
`cannet-python-can[.exe]` beside an `_internal/` directory of the frozen
interpreter and libraries — not a onefile. Onedir starts without a
per-launch self-extraction step, which is faster and avoids the
`%TEMP%`-extraction failure modes (locked-down temp, AV re-scans) that
make onefile *less* robust on Windows — the opposite of this decision's
goal.

The onedir folder is bundled into the installer next to the GUI binary
(as `cannet-python-can/`). The host's launcher resolves it first, ahead
of the existing `uv` / `python3` paths, which stay as developer
fallbacks.

## Why

**Robustness — the fewest moving parts on the user's machine.** The
earlier plan (sidecar Python *source* shipped next to the exe, `uv`
fetched at install/first-run, a venv materialised over the network on
first launch) has three independent failure points, and the first
installer built against it shipped *only* the GUI exe — no sidecar
source, no `uv` — so the sidecar never launched at all. A frozen binary
removes all three: nothing is resolved, fetched, or compiled on the
user's machine.

**Offline first-run works.** No network round-trip to materialise a
venv.

**Deterministic.** The exact interpreter and dependency versions are
fixed at build time, not resolved against whatever Python/`uv`/wheels
happen to be on the user's machine.

**Consistent with ADR 0015's "split by who maintains it."** ADR 0015
bundles first-party code and fetches *external* runtime binaries we do
not build. The frozen sidecar is a **first-party build artifact**: we
build it, from our source, with a pinned toolchain — the way a
statically linked native binary embeds libc. The embedded CPython is an
implementation detail of *our* artifact, not a third-party binary we
carry. So bundling it is "first-party code, bundled as usual," even
though the artifact happens to contain an interpreter.

## Consequences

- **Installer grows ~40 MB** (embedded CPython + `grpc` + `python-can`).
  Acceptable — small next to the vendor SDKs the user already installs.
- **cannet now redistributes LGPL-3.0 `python-can`.** Freezing it in
  makes cannet a distributor of a Combined Work under LGPL-3.0 §4 (the
  developer `uv` flow redistributed nothing). Because `python-can` is
  pure Python, the onedir layout satisfies §4's relink/replace
  condition directly — a user edits the collected `can/` modules in
  place — so compliance is shipping the LGPL-3.0 + GPL-3.0 texts (and,
  later, a runtime attribution surface). `grpcio`/`protobuf`/CPython
  are permissive and only need their notices retained; PyInstaller's
  GPL-with-exception terms cover the freeze tooling, not the artifact.
  See
  [`servers/cannet-python-can/LICENSING.md`](../../servers/cannet-python-can/LICENSING.md).
- **Per-OS build.** PyInstaller cannot cross-compile; this matches
  Tauri's own constraint (see the distribution/CI task). Each platform's
  frozen sidecar is built on its native runner alongside the Tauri
  bundle, from the same pinned toolchain.
- **Dynamic imports must be force-collected.** `python-can` discovers
  backends via entry points, and the sidecar loads its driver through
  `importlib.import_module`, so PyInstaller's static graph misses both.
  The build pins the collection recipe (`--collect-submodules
  cannet_python_can`, `--collect-submodules can`, `--collect-all grpc`,
  and the matching `--copy-metadata` flags). A **smoke-run of the frozen
  binary in CI** — assert it emits its `sidecar\tlistening\t<addr>`
  banner — guards against a silent collection regression on a dependency
  bump.
- **Vendor DLLs stay user-installed.** `vxlapi`/`canlib`/`PCANBasic` are
  loaded via `ctypes` from the user's hardware SDK at runtime; they are
  **not** frozen in (licensing, and they are the user's driver install).
  A missing SDK degrades that one backend gracefully, unchanged from
  today.
- **The host keeps `uv`/`python3` launch paths** for the developer flow;
  the frozen path simply takes priority when the artifact is present
  next to the GUI binary. The host↔sidecar contract (piped stdin as the
  parent-death signal, tab-separated stdout banner) is unchanged — a
  frozen exe gets the same pipes.
- **`uv` is dev-only now.** ADR 0015's general rule still governs any
  *external* runtime binary we depend on but do not build; its specific
  consequence — "an end-user `uv`/Python fetch flow is needed" — no
  longer applies, because nothing is fetched on the user's machine.
