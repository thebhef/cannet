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

A working design prototype lives in
[`0046-settings-framework-and-view/settings-view-prototype.html`](0046-settings-framework-and-view/settings-view-prototype.html)
— open it in a browser. It carries the Task 45 inventory as real data
and implements the descriptor model, the tag taxonomy, fzf-style
search, the tree, the two scopes, and the project-cache editor. It is
the reference for what the view work should produce; where this
document and the prototype disagree, fix whichever is wrong.

## Implementation status

The running record of what landed, what deviated, and why.

**The descriptor lives host-side.** The open question in §1 is settled
in favour of a static table in
[`settings_descriptor.rs`](../../apps/gui/src-tauri/src/settings_descriptor.rs),
served by `get_setting_descriptors`. That is the option that *removes*
duplicate sources of truth rather than adding a fourth:

- The descriptor table declares only what is genuinely new — label,
  help, control shape, and the two tag axes.
- **Scope is read from `settings::SCOPES`**, the table Task 47 branch 2
  landed, not copied into the descriptor.
- **The default value is read from `Settings::default()`**, so the
  triplicate-defaults problem doesn't get a fourth copy — the descriptor
  is a *view* of the default, not a transcription.
- The key set is proven identical to the serialized `settings.json` key
  set by a test, which is what makes ADR 0034's "the file lists every
  knob" promise mechanically checkable. Host-side is the only place that
  test can live.

**Tags are closed enums** (`Surface`, `Kind`), per this document's lean.
Exactly-one-kind is a property of the type (`kind` is one value, not a
list) rather than something a test polices; at-least-one-surface is a
test.

**The taxonomy is complete ahead of the settings that will carry it** —
that is the whole point of the sequencing below — so most `Surface` and
`Kind` variants have no user yet, and the same is true of the `Control`
vocabulary the view renders. Rust's `dead_code` lint cannot see a use
that lives on the far side of a serialized contract, so those two enums
carry an `allow` with the rationale written next to it. Adding a setting
in Task 45 is then a one-line table entry, not a framework change.

**`show_developer_settings`, not `general.show_developer_settings`.**
§3 names the toggle with the `general.` prefix Task 45's namespacing
sweep will introduce. That sweep is explicitly not this task, and the
store's other three keys are flat (`scratch_cap_bytes`,
`clear_scratch_on_exit`, `keybindings`), so the field ships flat and
gains its prefix with the rest of them. It is `Scope::User`: whether
*you* see developer knobs is not a project's business.

**§2's surface list was wrong; the prototype's is right.** This document
listed `project` and omitted `general`. "Project" is a *scope*, not a
surface — ADR 0042 §3 — and app-wide knobs need somewhere to live, so
the shipped taxonomy is the prototype's: general, plot, trace, signals,
by-ID, DBC, transmit, connection, logging, storage. §2 is corrected
above.

**`keybindings` gets a descriptor, and therefore a renderer.** §1 says
keyboard shortcuts are not the worked example for `type: "custom"`,
because reproducing the shortcuts editor here would be a second home for
one fact. That stands — but `keybindings` *is* a field of
`settings.json`, so the key-set test requires it to have a descriptor,
and a descriptor has to declare a control. It declares
`custom`/`keybindings`, and that renderer is a **pointer, not an
editor**: it says where the bindings are edited and how many are
customised. §1 is corrected to say so.

**The view is generated end to end.**
[`SettingsPanel.tsx`](../../apps/gui/src/SettingsPanel.tsx) names no
setting: it renders rows from the served descriptors, and
[`settingControls.tsx`](../../apps/gui/src/settingControls.tsx) picks the
widget from `control.type`. `CUSTOM_SETTING_RENDERERS` is the one
dispatch table, and `settingControls.dom.test.tsx` exercises both halves
— every generated type, and dispatch through the table.

- **No new matcher, no new tree.** Search is `fzf` with the same
  relative score floor the DBC panel uses, for the same reason (fzf
  accepts any subsequence, so over help text a query "matches" prose
  that merely contains the letters in order). The floor is relative to
  the best score *for that query*, so a setting found only through its
  help text still survives. The tree is the prototype's one-level group
  selector rather than a nested tree, so there is no tree to implement.
- **`get_settings_bounds` is gone.** Its one consumer was the old
  panel's hard-coded cap row; the same `MIN_SCRATCH_CAP_BYTES` is now
  the descriptor's `min`, so the command was a second channel for one
  constant. Its test moved to the descriptor.
- **Deviation from the prototype: the footer counts only what is
  visible.** The prototype's footer reads `N of <all settings>`, which
  advertises the hidden ones by arithmetic. The denominator here is the
  visible universe.
- **Deferred: choosing a scope.** The prototype's User / Workspace tabs
  and its "Set for this project…" action are not built. The view shows
  *provenance* — a value the open project overrides is marked as the
  project's, from `get_settings_overrides` — which is what §4 and §5
  actually require ("the scope of every value must be unmistakable at a
  glance"). Moving a value between scopes is a different thing: it needs
  per-scope read and write commands, and it changes the premise
  `Scope::UserOverridable` was built on ("there is no UI for choosing a
  scope, so leave the value where it already is"). It belongs with the
  work that gives projects settings worth moving — Task 45's promotions
  — not with the framework. Logged in the backlog.
- **Not built: the `project-caches` renderer.** It needs Task 47 branch
  3's project registry, which lands after this task; it will be the
  dispatch table's first real entry. Building it here would mean
  building it twice. The table's production entry today is
  `keybindings`.

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

**The panel is a dictionary editor, and that is the point.** A row's
control is *generated* from the descriptor's `type` — `bool` →
checkbox, `enum` → select over `options`, `int` / `number` → number
input with a unit suffix, `text` → text input. Nothing is hand-written
per setting.

A setting that is genuinely not a labelled input declares
`type: "custom"` plus a named `renderer`, dispatched through one table.
That table is the entire extension surface: a setting is either a
generated control or one named renderer, with no third case. Custom
rows still carry the standard header — label, key, tags — so they stay
searchable and still teach the file. [Task 47](0047-user-workspace-scoping.md)'s
project-directory list is the worked example. Keyboard shortcuts are
**not** — they already have their own view, and reproducing it here
would be a second home for one fact. `keybindings` is nonetheless a
field of `settings.json` and so carries a descriptor like any other; its
renderer is a *pointer* to the shortcuts panel, never an editor.

### 2. Tag taxonomy

Two independent axes; a setting carries tags from both.

**Surface** — which part of the app the setting governs. Drives the
default tree grouping: general, plot, trace, signals, by-ID, DBC,
transmit, connection, logging, storage. There is no `project` surface:
belonging to a project is a *scope* ([ADR 0042](../../docs/adr/0042-project-directory-and-scopes.md)
§3), orthogonal to which part of the app a setting governs.

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
- **Developer settings hidden by default.** The toggle is itself a
  setting (`show_developer_settings`; the `general.` prefix arrives with
  Task 45's namespacing sweep), not panel chrome — it
  lives in the store like every other knob, and the panel grows no
  special controls of its own.
- **What is hidden is not advertised.** No banner, no "3 developer
  settings match", no count in the footer. An earlier draft of this
  task argued the opposite — that a search returning nothing while
  hidden matches exist is a search that lies. That was overruled
  deliberately: the banner is noise on every near-miss query, and the
  cost of the quiet version is bounded because the toggle is itself one
  searchable row away.
- **Developer settings form their own tree group** rather than
  appearing under their surface. Enabling them adds one group instead
  of mutating all ten, so a user who flips the toggle to find one knob
  doesn't find `Plot` has silently grown a fetch-cadence row. The cost
  is that a developer knob is no longer where its surface says it is,
  so each one shows a surface chip (`Plot` `developer`) beside its
  kind.
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
- Fuzzy search finds a setting by label, key, help text, or tag.
- Developer-tagged settings are hidden by default, revealed by a
  setting rather than by panel chrome, and collect into their own tree
  group when revealed. Nothing in the panel advertises what is hidden.
- Every control is generated from its descriptor's `type`. The only
  hand-written renderers are those declaring `type: "custom"`, and each
  is registered in one dispatch table.
- No new matcher and no new tree implementation: the panel uses `fzf`
  and the DBC panel's established tree-filter pattern.
- A user who never opens the panel is unaffected — defaults unchanged,
  file format compatible.
