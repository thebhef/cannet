# ADR 0015 — External runtime binaries are fetched at a pinned version, not committed or bundled

Status: accepted (2026-05-23); superseded in part by
[ADR 0036](0036-frozen-python-can-sidecar.md) — the python-can sidecar
now ships as a frozen self-contained binary, so `uv` is a developer-only
dependency and no end-user `uv`/Python fetch flow is needed. The general
rule below still governs any *external* runtime binary we depend on but
do not build.

## Decision

External runtime binaries cannet depends on are **fetched from
their upstream release channel at a pinned version**. They are not
committed to this repo, and not packed into the installer artefact.

Today this means `uv` (Apache-2.0/MIT, Astral's Python toolchain
manager used by the python-can sidecar — see
[ADR 0008](0008-python-can-sidecar.md)). The rule generalises:
any future third-party runtime binary we depend on follows the
same pattern.

First-party code we maintain (the GUI, our Rust crates, the
sidecar Python package) is bundled as usual. The split is **by who
maintains it**, not by language or runtime role.

The **pin** — the specific upstream version cannet expects — is
the single source of truth for the fetch. It lives in one place;
revisiting the pin is one edit. (For `uv` today that is only the
dev-side fetch; per [ADR 0036](0036-frozen-python-can-sidecar.md)
there is no end-user `uv` fetch.)

The host's runtime lookup chain treats the fetched tool uniformly:
a known install-dir location, then a copy on `PATH`, then a
documented fallback. The host does not care who wrote the
install-dir copy.

## Why

**Smaller distributable.** Committing per-OS binaries inflates both
the repo and the installer; users on one OS would carry binaries
for the others.

**Auditable supply chain.** Fetching from upstream's release
channel at a pinned version means the supply-chain comparison is
"us vs upstream release," not "us vs a snapshot we re-cut on every
version bump." Anyone verifying the build can re-run the fetch and
check the hash.

**One place to bump.** A single pin shared across all flows makes
version upgrades one edit, not "edit the script, rebuild the
installer, re-commit the snapshot."

**User override stays possible.** Because the tool is a plain
binary on disk in a known location, a user who wants a newer or
different version replaces it in place.

## Consequences

- **Only a dev-side fetch remains** (`scripts/fetch-uv.sh`). The
  end-user side this ADR originally anticipated — fetching `uv` as an
  installer or first-run step — is **not built and no longer planned**:
  [ADR 0036](0036-frozen-python-can-sidecar.md) ships the sidecar as a
  frozen self-contained binary, so end users fetch nothing.
- **The pin is brittle by design.** When upstream yanks or breaks
  the pinned version, the fetch fails everywhere at once. That's
  preferable to a stale committed snapshot that silently keeps
  working past a known-bad version.
