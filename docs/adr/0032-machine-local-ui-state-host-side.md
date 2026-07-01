# ADR 0032 — Machine-local UI state persists host-side in the app config dir

Status: accepted (2026-06-26)

## Decision

Durable **machine-local UI state** — settings that belong to this install
on this machine, not to a project and not to a session — is persisted by
the Rust host under Tauri's `app_config_dir`, not in the WebView's
`localStorage`.

That covers the last-opened project pointer, the no-project layout
snapshot, recent BLFs, and recent commands (formerly the
`cannet.lastProject.v1` / `.layout.v1` / `.recentBlfs.v1` /
`.recentCommands.v1` keys). They move into one host-written prefs JSON,
read and written through Tauri commands; the frontend keeps no
authoritative copy.

Window geometry already lives in the same directory, in
`tauri-plugin-window-state`'s own `.window-state.json`. We leave it
there — co-located, but plugin-managed, since re-implementing geometry
persistence is exactly the surface we adopted the plugin to avoid.

## Why

`localStorage` is the wrong home for durable settings: it is owned by the
WebView, sits in an opaque store under a different base dir than the
config dir (XDG *data* vs *config*; `%LOCALAPPDATA%` vs `%APPDATA%`), can
vanish on a WebView cache wipe, and can't be read, diffed, or copied
between machines.

Window geometry was always host-side — it restores at window creation,
before the WebView and its `localStorage` exist. That left one slice of
machine-local state host-side and the rest in `localStorage` for no
principled reason. Geometry is the exemplar; the rest follows it. The
deciding category is *machine-local and durable* (host config) versus
*project data* (the project file, ADR 0011) versus *transient
in-session* (React state only) — not the loose label "view state," which
applies equally to all of them.

## Consequences

- **Refines "frontend state is view-local" (CLAUDE.md § GUI
  architecture).** That rule is about runtime data-model ownership and
  *transient* in-session state, not the persistence layer for durable
  settings. Those now round-trip through host commands.
- **The project-embedded layout is untouched.** ADR 0005 / ADR 0011 keep
  the dockview blob inside the project file; only the separate
  no-project *snapshot* moves.
- **[ADR 0002](0002-disk-spill-store.md) updated in the same change** —
  its disk-spill identity gate referenced the frontend `localStorage`
  last-project pointer, now host-side. The UUID-based gate itself is
  unchanged.
- **No migration** (per ADR 0011): old `localStorage` values are not
  read; recents and the pointer regenerate as the user works.

## Rejected alternatives

- **Leave everything in `localStorage`.** Keeps durable settings in
  WebView-owned, base-dir-inconsistent storage and keeps geometry split
  from the rest.
- **Move the pointer and recents but leave the layout snapshot.** The
  snapshot is no more "view state" than geometry is; splitting it out
  reintroduces the inconsistency this ADR removes.
- **Fold geometry into the prefs file.** Means dropping the window-state
  plugin and re-hand-rolling multi-monitor / DPI persistence.
