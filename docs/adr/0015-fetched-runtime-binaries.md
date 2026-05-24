# ADR 0015 — External runtime binaries are fetched at a pinned version, not committed or bundled

Status: accepted (2026-05-23)

## Decision

External runtime binaries cannet depends on are **fetched from
their upstream release channel at a pinned version**. They are not
committed to this repo, and not packed into the installer artefact.

Today this means `uv` (Apache-2.0/MIT, Astral's Python toolchain
manager used by the python-can sidecar — see
[ADR 0008](0008-python-can-sidecar.md) once it lands). The rule
generalises: any future third-party runtime binary we depend on
follows the same pattern.

First-party code we maintain (the GUI, our Rust crates, the
sidecar Python package) is bundled as usual. The split is **by who
maintains it**, not by language or runtime role.

The **pin** — the specific upstream version cannet expects — is
the single source of truth across every fetch flow (dev-side,
end-user installer, host first-run). It lives in one place;
revisiting the pin is one edit.

The host's runtime lookup chain treats every fetch flow uniformly:
a known install-dir location, then a copy on `PATH`, then a
documented fallback. The host does not care which flow populated
the install-dir copy.

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

- **Two fetch flows are needed**: a dev-side fetch (today
  `scripts/fetch-uv.sh`) and an end-user fetch as part of the
  installer or first-run host flow. The end-user-side mechanism is
  still TBD — see `plans/phased-implementation.md` §
  "Third-party runtime tool fetching strategy" for the remaining
  implementation choice and per-OS specifics.
- **An offline first-run on a fresh install must surface a clear
  error** with the manual install instructions; "tool not found"
  cannot fail silently.
- **The pin is brittle by design.** When upstream yanks or breaks
  the pinned version, the fetch fails everywhere at once. That's
  preferable to a stale committed snapshot that silently keeps
  working past a known-bad version.
