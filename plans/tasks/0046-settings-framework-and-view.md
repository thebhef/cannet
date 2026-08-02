# Task 46 — Settings Framework & View

[Task 45](0045-settings-store-consolidation.md) takes `settings.json`
from three fields past twenty-five. A flat hand-rolled panel was the
right call at three ([ADR 0034](../../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md)
§2, and it says so explicitly); at twenty-five it is a wall of
controls. This task builds the surface that makes a settings store that
size usable: **tagged settings, fuzzy search, a grouped tree, and
developer settings hidden by default.**

It also settles the design question Task 45 raises. ADR 0034 rejected a
*third-party schema-driven form framework* — that rejection stands.
What this task builds is a small in-repo descriptor + view, in the
app's own visual language, reusing components the repo already has. The
storage contract does not change: `settings.json` stays the durable,
hand-editable source of truth and this panel stays sugar over it.

## Sequencing

**The tag taxonomy must be settled before Task 45 Stage 3 bulk-promotes
its constants**, or every promoted field needs tags retrofitted — the
same reason [Task 47](0047-user-workspace-scoping.md)'s scope rule must
be settled first. Order of work:

1. Task 45 Stage 1 — fix the store's existing defects.
2. Task 47 — the project directory, and with it the workspace scope
   this task's descriptor records per setting.
3. This task's "Descriptor model" and "Tag taxonomy" sections — design
   only, no view yet.
4. Task 45 Stages 2–5 — move and promote settings, each landing with
   its scope and tags already attached.
5. This task's view work.

## Reuse — do not build these from scratch

The repo already contains both halves of what this view needs:

- **`fzf`** is an adopted dependency
  ([`technology-inventory.md`](../technology-inventory.md)) — the VS
  Code / fzf matcher port, with camelHump matching. It already backs
  the command palette (`PaletteModal.tsx`, which is types-to-filter
  over a flat item list) and the DBC panel. Use it; do not hand-roll a
  matcher.
- **The DBC panel is already a tree-with-fuzzy-search over a large
  item set**, and has solved the exact problems this view will hit:
  `buildSearchIndex` / `buildRows` producing a flat `RenderRow[]` from
  a tree, "expanded = user's expand state ∪ ancestors-of-matches while
  filtering", a debounced query so typing re-renders only the
  `<input>`, and bounded rendering under a broad filter. Read
  `DbcPanel.tsx` before designing this panel's tree; lift the pattern
  (and, where it is genuinely the same logic, the helpers) rather than
  reinventing it.

If the two panels end up wanting the same tree-with-filter machinery,
factor it into a shared module — but only once the second consumer
exists and the shape is proven, not upfront.

## Scope

### 1. Descriptor model

Settings need metadata the view can render from: tags, a label, a
help string, a type/range, and a default. Today the schema exists only
as a Rust struct plus a hand-written TS mirror plus rustdoc prose —
three copies (Task 45's duplicate list, item 5).

Design question to answer here: **where does the descriptor live?**
The candidates, given ADR 0034 makes the host authoritative:

- Host-side static descriptor table, served to the frontend through a
  command, with the panel generated from it. Keeps one source of truth
  and collapses Task 45's triplicate-defaults problem.
- Frontend-side registry, with the host staying a dumb
  serde round-trip as it is today. Simpler, but keeps the copies.

Prefer whichever removes a duplicate source of truth rather than adding
a fourth. Note that a host-served descriptor also makes
`settings.json`'s self-documenting promise checkable — the file's key
set and the descriptor's key set must match, which is a test.

### 2. Tag taxonomy

Two independent axes; a setting carries tags from both.

**Surface** — which part of the app the setting governs. Drives the
default tree grouping: plot, trace, signal, by-ID, DBC, transmit,
project, connection, logging, storage.

**Kind** — what sort of decision it is:

- `default` — the initial value of something the user can also change
  per-view (default y-axis mode, default auto-scroll, default column
  set).
- `behaviour` — app-wide policy with no per-view equivalent (startup
  behaviour, DBC auto-reload, confirmation prompts).
- `developer` — machine-load and internal-cadence knobs that exist for
  consistency rather than because a user wants them: the plot fetch
  cadence, view refresh cadence, trace flush cadence, health-sample
  cadence, system-log ring depth and rate limit, sidecar restart
  budget. **Hidden unless the user opts in.**

The `developer` tag is what makes Task 45's "borderline" constants safe
to expose. They were borderline precisely because surfacing them risked
clutter and incoherent tuning; a hidden-by-default tag answers both
objections, which is why Task 45 now promotes them rather than arguing
each one.

Settle whether tags are a closed enum (typo-proof, needs a code change
to add) or open strings (flexible, drifts). Lean closed — the taxonomy
is small and a typo'd tag silently hides a setting.

### 3. The view

- **Search at the top**, fzf-backed, matching over label, key, help
  text, and tag names. Debounced, following the DBC panel's pattern.
  A query should be able to find a setting the user cannot name — that
  is the whole point of searching help text as well as labels.
- **Tree grouped by tag**, VS Code-style, with the surface axis as the
  default grouping. Expand state persists per-panel; while filtering,
  matches and their ancestors show.
- **Developer settings hidden by default**, behind a toggle that is
  itself discoverable. When a search would have matched a hidden
  developer setting, say so rather than silently returning nothing —
  "3 developer settings match" with a way to reveal them. A search that
  lies about having no results is worse than one that shows too much.
- **Every setting shows its key** (the `settings.json` field name), so
  the panel teaches the file. ADR 0034's promise is that the file is
  the contract; the panel should make hand-editing easier, not hide
  that the file exists.
- Reset-to-default per setting, and a visible marker for settings that
  differ from their default — the cheapest way to answer "what have I
  changed?" without diffing the file.

### 4. Project settings

The requested grouping includes project-scoped settings alongside app
settings. With [Task 47](0047-user-workspace-scoping.md) landing first,
this is the workspace scope rather than a separate concept — but the
files still have different lifetimes, and the view must not blur them.

A user who edits what they think is a personal preference and finds it
in a teammate's project diff has been misled by the UI. Whatever the
tree looks like, the scope of every value must be unmistakable at a
glance, not one click away.

This task also surfaces Task 47's **project-directory list** — known
project directories, their cache sizes, and clear-one / clear-all. That is a
settings-panel element rather than a per-setting control, so the view
needs room for panels that are not simply a labelled input.

### 5. Scope is a first-class part of the descriptor

[Task 47](0047-user-workspace-scoping.md) establishes the project
directory, and with it a workspace scope for settings, state, and
cache. It lands before this task, so scope is not a later addition to
the descriptor — it ships with it, alongside tags:

- Every setting declares which scopes it is valid at (user-only, or
  user-with-workspace-override).
- The view shows, per setting, **which scope the effective value came
  from** and lets the user set it at either. A value silently
  overridden by a workspace file, with no indication in the UI, is
  exactly the confusion this feature invites.
- Search matches across scopes; a workspace override should be
  findable, not hidden behind a scope selector.
- The "differs from default" marker becomes "differs from default" and
  "overridden at workspace scope" — related but distinct states, both
  worth showing.

Task 47's design question 3 settles the *rule* (which keys may be
overridden); this task carries the *metadata* and renders it.

## Non-goals

- A third-party form framework. ADR 0034's rejection stands and this
  task does not revisit it — the frontend stack stays lean, and a
  descriptor-driven panel of our own is not the same thing.
- Changing the storage contract. `settings.json` stays hand-editable
  and authoritative; this is a view over it.
- Per-view settings UI. A setting that is genuinely per-panel state
  belongs in that panel, not here.

## Documentation deliverables

- **ADR 0034 amendment** recording the descriptor + tagged-view
  decision and why it is not the framework the ADR rejected. This is
  the same amendment Task 45 needs for its `blf_channel_maps`
  resolution — one amendment, both changes.
- README settings section: how to find a setting, what `developer`
  means, and that the file remains editable directly.

## Exit criteria

- Every field in `settings.json` has a descriptor with at least one
  surface tag and exactly one kind tag, enforced by a test that fails
  when a field is added without one.
- The descriptor's key set and the serialized `settings.json` key set
  are proven identical by a test — the ADR 0034 "lists every knob"
  promise, mechanically checked.
- Fuzzy search finds a setting by label, key, help text, or tag; a
  query matching only hidden developer settings reports them rather
  than showing an empty result.
- Developer-tagged settings are hidden by default and revealed by one
  discoverable toggle.
- No new matcher and no new tree implementation: the panel uses `fzf`
  and the DBC panel's established tree-filter pattern.
- A user who never opens the panel is unaffected — defaults unchanged,
  file format compatible.
