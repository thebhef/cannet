# Task 47 — The Project Directory

**Decision: cannet always has a project directory to work in.** Every
session is rooted in one, whether the user chose the location or cannet
created it. Workspace settings, project-scoped state, and the data
cache all live inside it, under `.cannet/`.

This task is **the directory concept and nothing else** — where it is,
what goes in it, how it is created, and how a user manages the ones
that accumulate. What *fields* live at which scope, and the UI for
editing them, belong to Tasks 45 and 46; see "Not in this task".

## Why now, rather than when something needs it

Nothing currently forces this. It is being done **deliberately, so the
architecture is proven to carry two scopes before anything large is
built assuming one.** [Task 45](0045-settings-store-consolidation.md)
takes the settings count past twenty-five and
[Task 46](0046-settings-framework-and-view.md) builds a
descriptor-driven view over them; both are far cheaper written
scope-aware than retrofitted. Discovering after twenty-five fields and
a settings UI exist that the architecture can't carry a second scope is
the failure mode this pre-empts.

The immediate payoffs are real, not just hygiene: a project's data
sits with the project where a user can see it, back it up, or delete
it; the BLF channel→bus mappings stop being a machine-global dictionary
keyed by project id; and "clear the cache for that job I finished last
month" becomes possible at all.

## The layout

```text
<project dir>/
  .cannet/
    settings.json        workspace-scoped settings
    state.json           view state specific to this project
    blf-channel-maps     BLF channel → bus mappings
    cache/               today's dev.cannet.app/current
  my_project.cannet_prj
  xxx.cannet_rbs
  *.dbc                  generators output here directly
```

`.cannet/` is the scoped directory, in the shape of `.git/` or
`.vscode/`. The project file, RBS files, and DBCs sit beside it as the
user's own content.

**When the user does not name a project directory, cannet creates one
in its cache space** — the same place the scratch lives today. That
path is not special: it is an ordinary project directory that happens
to be auto-located, so there is no anonymous or no-project mode to
thread through every read. This is the simplification the "always a
project directory" decision buys.

**Workspace-scoped data is expendable.** Losing `.cannet/` costs the
user their per-project view state and a re-do of the BLF mappings.
Nothing there needs migration guarantees, which matches ADR 0011's
drop-don't-migrate rule.

**One symlink, and cannet owns it.** `.cannet/cache/` is a link to a
cache directory cannet sets up in machine-local storage (see open
question 2); nothing else in the layout is a link. Content files —
DBCs, RBS configs — are real files in the project directory, and a
generator that produces DBCs should output there rather than being
linked in from elsewhere. There is no structural reason for cannet to
depend on user-created links, and one concrete reason not to: the DBC
auto-reload watcher watches *parent directories*, so a linked file's
target changing in some other directory would silently never fire.
Better to make the project directory the real home than to make the
watcher chase links.

## Scope matrix

| Class | User scope (machine) | Workspace scope (`.cannet/`) |
| --- | --- | --- |
| Settings | preferences that follow the person | overrides for this project |
| State | recents, last project, window/layout | per-project view state, BLF channel maps |
| Cache | — | `cache/`: disk-spill scratch, signal caches, filter index, notes |

Cache is workspace-only by nature — it is derived from one capture in
one project. User-scope settings and state stay in `app_config_dir`
where they are today.

## Decisions

1. **File naming: the path carries the scope, not the filename.**
   `.cannet/settings.json` is the workspace file; the machine-level
   one stays `settings.json` in `app_config_dir`. Same for
   `state.json` at each level. A file called `user.*` never appears
   inside a project directory — a file *in* the project is
   workspace-scoped by definition, and naming it otherwise would
   invite exactly the confusion the two-scope split has to avoid.

2. **`cache/` is a link to cannet-managed local storage.** The
   disk-spill store is **memory-mapped** (ADR 0002), so a project
   directory on a network share — an entirely plausible shared project
   folder — would put an mmap'd, multi-GB, continuously-appended store
   on a network filesystem, a known route to corruption and stalls.
   `.cannet/cache/` is therefore a **link (directory junction on
   Windows) to a cache directory cannet creates locally.** The layout
   is unchanged, cannet still just opens `.cannet/cache/`, and the
   bytes land somewhere safe wherever the project lives.

3. **A workspace value overrides the user value** for the same key.
   Which *keys* may be overridden is Task 46's per-setting metadata,
   not this task's problem — but the rule itself is settled here,
   because the directory is meaningless without it.

4. **`.cannet/.gitignore` ignoring `cache/`, written at creation.** A
   project directory is plausibly a repo, and a multi-GB scratch tree
   in someone's `git status` is a bad first experience. Cheap, and it
   fails safe for the common case.

5. **A project directory is a directory holding a `.cannet_prj`
   *beside* a `.cannet/`.** It is the pair that identifies one, not
   either alone.

   **cannet never creates `.cannet/` as a side effect.** It writes one
   only where the user has explicitly pointed it:
   - **its own cache space**, for auto-located project directories,
     where it is not touching anybody else's folder; or
   - **a directory the user picks through Save As** (below).

   Otherwise the user creates `.cannet/` themselves — laying one beside
   a `.cannet_prj` is how they say "this folder is the project
   directory". So there is no prompt on first open, no adopt-this-folder
   command to design, and no way for a `.cannet/` to appear in an
   unrelated directory because someone opened a file.

   Consequences:
   - **An existing loose `.cannet_prj` is not a project directory.** It
     gets an auto-located directory in cache space, exactly like a
     project with no file at all. Nothing about the user's folder
     changes.
   - **Moving the `.cannet_prj` away from its `.cannet/` un-pairs it.**
     The moved file is loose again, and the orphaned `.cannet/` is what
     the registry surfaces so its cache can be reclaimed.
   - **Two `.cannet_prj` files in one directory is undefined
     behaviour.** They would share a `.cannet/`. Fine as long as only
     one is ever opened; not a case to write code against. Do not add
     detection, warnings, or a `project_id` subdivision scheme for it —
     it is the user's directory and this is their business, not
     something to police.

6. **The capture lives in the project's workspace directory.** Per-
   project, not per-app. Coming back to a project finds its capture
   still there (ADR 0002 DS-7 reload, now scoped per project) rather
   than destroyed by whatever was opened in between. This is intended
   behaviour, not an emergent one — and it multiplies disk use by the
   number of projects, which is exactly the pressure the registry's
   clear-cache UI exists to relieve.

7. **`clear_scratch_on_exit` clears the active project only.** It never
   reaches across projects; wiping other projects' caches is a
   deliberate action taken from the registry UI.

8. **Re-opening an already-open project is undefined behaviour, for
   now.** Detect-and-focus is the behaviour worth having eventually,
   but it needs single-instance / inter-window messaging the app does
   not have, and that is a dependency decision this task should not
   drag in. Left explicitly undefined rather than half-guarded; a
   backlog entry carries the plugin evaluation.

9. **Save As creates the project directory.** `project.saveAs` already
   exists as a command ("Save project as…"); it gains the directory
   behaviour. The user picks a destination, and cannet creates the
   project directory there — `.cannet/` with its `settings.json`,
   `state.json`, `.gitignore`, and `cache/` link — then writes the
   `.cannet_prj` beside it.

   This is the promotion path off an auto-located directory, and the
   one place cannet writes a `.cannet/` into user-chosen storage. It is
   consistent with decision 5 because the user named the destination in
   a save dialog: an explicit act, not a consequence of opening
   something. It is also where a user who wants a project directory but
   does not want to hand-create `.cannet/` gets one.

10. **Save As migrates; a hand-created `.cannet/` does not.** Both
    routes promote a project off its auto-located directory in cache
    space, and they behave differently on purpose:
    - **Save As is cannet's managed workflow**, so it carries the
      contents across — capture, BLF mappings, per-project state. The
      user asked cannet to put the project somewhere; arriving without
      its data would be a surprise.
    - **A hand-created `.cannet/` starts clean.** The user made a
      directory; cannet fills it and moves on. It is a declaration of
      intent for this project going forward, not a request to relocate
      anything. The old auto-located directory stays in the registry
      to be reclaimed.

11. **No in-app migration for projects that predate this.** The one
    install with existing project directories gets hand-migrated rather
    than shipping migration code for a population of one. Consistent
    with ADR 0011's drop-don't-migrate rule. *Implementation note: do
    this manually when the task lands — find the existing project
    directories on disk and move them into the new layout.*

12. **The local cache directory is keyed by a hash of the project
    directory's path.** Reclaiming is a user action, not a garbage
    collector: the settings view lists cache directories and lets the
    user remove them, including ones whose project directory no longer
    exists. Nothing deletes a cache behind the user's back.

13. **Terminology: "project", not "workspace", for the thing the user
    works on.** What the code calls "an unsaved workspace" is an
    *unsaved project*; "the seed workspace" is a seed project. Sweep
    those usages. "Workspace" is reserved for the scoped data —
    `.cannet/` is the workspace directory, and workspace scope is the
    per-project half of the scope matrix.


## Scope-review every `UiState` field

`state.json` today mixes both scopes in one struct, which is the review
this task owes. The fields, and the obvious reading of each:

| Field | Scope | Note |
| --- | --- | --- |
| `last_project` | user | Which project to reopen is about the person, not the project. |
| `recent_commands` | user | Palette MRU follows the person across projects. |
| `layout` | project | The no-project dockview snapshot — i.e. the unsaved project's layout. |
| `recent_blfs` | project | Which BLFs you opened *in this project*. Today a single global MRU, so a list from one job bleeds into the next. |
| `blf_channel_maps` | project | Already keyed by `project_id` — the key disappears once the file lives in the project's own `.cannet/`. |

The split is not uniform, which is the point: `recent_blfs` and
`recent_commands` sit side by side in the same struct today and belong
at different scopes. Confirm each against the code rather than taking
this table on trust — it is the reading, not the verdict.

Two consequences worth naming: `blf_channel_maps` loses its
`project_id` key entirely (the directory *is* the scoping), and
per-project `recent_blfs` is a small behavioural improvement that falls
out for free.

## Write project-relative paths

A project directory makes this the natural case, and it fixes a
long-standing nuisance: **the project file records fully-qualified
paths for files that sit right beside it.**

Half the work is already done. Reading is handled — ADR 0030 and
[`projectPaths.ts`](../../apps/gui/src/projectPaths.ts) already resolve
a project-relative DBC or `.cannet_rbs` reference against the project
file's own directory, which is what lets a checked-in example open from
any clone location. What that module's own doc records as the gap is
the write side: *"or absolute (what the GUI writes when you add a file
through the picker)"*.

So: **when a referenced file lives inside the project directory, store
it relative.** Absolute stays correct and supported for genuinely
external files. The payoff is that a project directory becomes movable
and shareable as a unit — copy it, clone it, hand it to a colleague,
and its DBC references still resolve. Before the project-directory
decision there was no guarantee those files were anywhere near the
project file, which is why this was never worth doing; now it is the
common case.

Scope note: this is a small, self-contained change to the write path
and it is in this task because the directory decision is what makes it
correct — not because it is settings work.

## Not in this task

Deliberately excluded, so this stays the directory concept:

- **Per-setting scope metadata** — which keys may be overridden at
  workspace scope. That is a field on
  [Task 46](0046-settings-framework-and-view.md)'s descriptor.
- **Promoting constants into settings** — all of
  [Task 45](0045-settings-store-consolidation.md) Stage 3, including
  whether `scratch_cap_bytes` and `clear_scratch_on_exit` become
  workspace-scoped. They govern a per-directory resource, so they
  probably should; that decision rides with the rest of the promotion
  work rather than being special-cased here.
- **The settings view** — tags, search, tree, developer toggle. Task 46.
- **Fixing the settings store's existing defects** — Task 45 Stage 1,
  which lands first regardless.

What this task must deliver is the directory, its resolution, its
creation, the two-scope read path, and the management UI for
directories that pile up.

## Constraints worth knowing before designing

- **Windows symlinks need privilege; junctions do not.** Creating a
  *symbolic link* on Windows requires `SeCreateSymbolicLinkPrivilege`
  (admin) or Developer Mode. A **directory junction** (`mklink /J`)
  requires neither. The one link cannet creates is a directory
  (`cache/`), so junctions cover it unprivileged on the primary
  development platform — no elevation prompt, no Developer Mode
  requirement.
- **Why content files are not linked.** `dbc_watcher.rs` watches
  *parent directories* (with refcounting), so a linked DBC whose real
  file lives elsewhere would never fire an auto-reload — silently, and
  worst for generated DBCs, which are exactly the files that change
  most. Recorded because "just symlink it in" is an obvious-looking
  idea that would half-work: the file loads, and only the reload
  quietly doesn't.

## Workspace registry and cache management

A user-scope registry of known project directories, and a settings
surface over it. This is the user-facing half.

- **Registry**: every project directory created or opened, with its
  path, the project it holds, and last-used time.
- **A settings element listing them**, with each one's cache size. The
  existing `scratch_footprint_bytes` already computes this figure for
  the status line — reuse it. Note that walk is currently expensive and
  holds a lock (Task 44 Tier 1 #4), so size on demand, never on a
  timer.
- **Two actions per row, and they mean different things** (ADR 0042
  decision 5): **Clear** empties the cached data and keeps both the
  cache directory and the registry entry; **Delete** removes the cache
  directory and forgets the project. Neither touches the project
  directory itself. A header **clear-all** empties every cache without
  removing anything. Clearing the active project is the existing Clear
  path and means "discard this session"; Delete is unavailable for it,
  because its store is mapped.
- **`Save as…` belongs on the auto-located rows.** This list is the one
  place a user actually sees that their project is living in cache
  space, so it is where the offer to move it belongs — far more
  discoverable than a File-menu entry they have no reason to open.
  Selecting a destination runs decision 9's Save As, and the row stops
  being auto-located.
- **Stale entries.** A directory deleted outside the app must degrade
  gracefully — show it as missing, offer to forget it, never fail to
  open the panel. A missing project's row stays listed at zero bytes
  until the user deletes it, rather than vanishing on clear-all; that
  keeps Clear's meaning identical on every row.
- Auto-created directories in cache space are the ones most likely to
  accumulate; the list is how a user finds and reclaims them.

The rendered form of this list is the **Storage → Project caches**
group in [Task 46](0046-settings-framework-and-view.md)'s prototype
([`0046-settings-framework-and-view/settings-view-prototype.html`](0046-settings-framework-and-view/settings-view-prototype.html)),
where it is the worked example of a setting that declares a custom
renderer instead of a generated control. Keep the two in step.

## Implementation status

The implementation is being landed in three branches. This section is
the running record of what is done and what moved.

**Branch 1 — the foundation (`task-47-project-dir`).**

- **Done: project-directory resolution.**
  [`project_dir.rs`](../../apps/gui/src-tauri/src/project_dir.rs) —
  `resolve(project_file, cache_root)` returns a `ProjectDir`
  unconditionally. A project file with a `.cannet/` beside it resolves
  to its own directory; a loose one, an orphaned `.cannet/`, or no
  project file at all gets an auto-located directory under
  `<app_cache_dir>/projects/<key>`. Resolution is **infallible** — the
  paths are well-defined even when the filesystem refuses, so no caller
  carries a "no project directory" branch.
- **Done: the cache link.** `.cannet/cache/` is a directory junction on
  Windows (`mklink /J` through `cmd`, since `unsafe_code = "forbid"`
  rules out the `FSCTL_SET_REPARSE_POINT` ioctl and a new crate was out
  of scope) and a symlink elsewhere. It points at
  `<app_cache_dir>/cache/<hash of the project directory's path>`.
  **Deviation from decision 2 worth knowing:** the store opens the link
  *target*, not `.cannet/cache/`. A project directory on a filesystem
  that cannot hold a reparse point — an SMB share, the exact case the
  link exists for — would otherwise lose its cache entirely. The link
  stays as the browsable view, and failing to create it is a logged
  warning rather than a failure.
- **Done: `.cannet/.gitignore`** ignoring `cache/`, written at creation
  (decision 4), plus empty `settings.json` / `state.json`. They are
  written **empty** on purpose: a workspace value overrides the user
  value (decision 3), so seeding them with defaults would shadow the
  user's own settings the moment a directory was created.
- **Done: the scratch root is the project's cache** (decision 6). The
  disk-spill store, filter index, signal pyramids, and notes all root in
  `ProjectDir::cache_dir()`.
- **Done: the two-scope read path** (decision 3).
  `persisted_json::resolve_scoped` is the one precedence rule — a
  workspace value overrides the user value for the same key — and
  `read_scoped` applies it to a filename in two directories. Both
  `settings.json` and `state.json` read through it. The merge is by
  **top-level key, not deep**: overriding `keybindings` replaces the
  list rather than splicing it, so an override is always a value some
  scope actually wrote.
- **Known gap, for whoever adds workspace writes:** reads merge, writes
  go to the user scope. If a workspace override exists and the frontend
  echoes the merged value back through `set_settings`, that value is
  written into the *user* file — the override is silently promoted.
  Unreachable today (cannet creates `.cannet/settings.json` empty and
  never writes it, so an override only exists by hand-edit), but the
  per-setting scope metadata has to route the write, not just gate the
  read.

**Deferred out of branch 1, and why:**

- **Re-rooting mid-session.** The project directory is resolved **once,
  at startup**, from the user-scope `last_project`. Opening a *different*
  project without relaunching leaves the store rooted where it was, so
  that project's capture lands in the previous project's cache — the
  same outcome as today's single machine-wide scratch, so no regression,
  but not yet the full decision-6 behaviour. Re-rooting means swapping
  the live `TraceStore`'s raw store plus `SignalCacheStore`,
  `filter_index_dir`, and `NotesStore`, against a running flusher
  thread; that is a branch of its own. **Branch 2.**
- Registry, cache-management UI, `Save as…`, `blf_channel_maps` move,
  `UiState` scope split, project-relative writes, terminology sweep —
  all as originally planned for branches 2 and 3.

**Corrections to this document found while implementing:**

- The documentation deliverable claims ADR 0002 **DS-6** says "rooted at
  the scratch dir". It does not — DS-6 is only "the disk store is the
  only production path". The phrase lives in *code comments* citing
  DS-6. DS-7 is where the location was recorded, and DS-7 is what
  changed.

## Sequencing

1. Task 45 **Stage 1** — the lost-update race. Independent of scoping;
   land it first so this is not built on a racy store.
2. **This task's layout, scope rule, and ADR** — design settled.
3. This task's implementation: project-directory resolution, scope
   resolution, registry, cache management UI.
4. Task 45 **Stages 2–5** — settings promoted, each with scope and tags
   attached. `blf_channel_maps` moves into `.cannet/` here.
5. Task 46 — the view, rendering scope alongside tags.

## Documentation deliverables

- **[ADR 0042](../../docs/adr/0042-project-directory-and-scopes.md) —
  written.** Records every item under "Decisions": always-a-project-
  directory, the `.cannet/` layout, the scope matrix and precedence
  rule, cache locality and keying, Save-As-migrates, the expendability
  of workspace data, and the terminology resolution. The task file
  carries the implementation detail; the ADR carries the decision.
- **ADR 0034 amendment** — its `settings.json` / `state.json` split
  becomes two files × two scopes. The settings-vs-state distinction it
  draws is unchanged and still correct.
- **ADR 0002** — DS-6's "rooted at the scratch dir" changes when the
  root becomes `.cannet/cache/`, and DS-7's reload story becomes
  per-project rather than per-app (decision 6).
- **ADR 0030** — it documents relative *reading* with absolute
  *writing* as the GUI's behaviour. Once files inside the project
  directory are written relative, that decision needs restating, and
  `projectPaths.ts`'s module doc with it.
- **Terminology sweep.** "Workspace" currently means the in-memory
  element/panel set — "an unsaved workspace" is the no-project state,
  `seedDefaultLayout` builds "the seed workspace". With a project
  directory always present, that sense needs retiring or renaming;
  do not leave the word doing two jobs.

## Exit criteria

- Every session has a project directory; there is no no-project code
  path left.
- cannet never creates a `.cannet/` as a side effect. The only ones it
  writes are auto-located directories in its own cache space and the
  destination the user picked through Save As; any other `.cannet/`
  beside a project file got there because the user made it.
- Save As into a chosen directory produces a complete, immediately
  usable project directory — `.cannet/`, its files, the cache link, the
  `.gitignore`, and the `.cannet_prj` beside it.
- Two projects each keep their own capture: opening B and returning to
  A finds A's capture intact.
- Opening a project directory that is already open is left **undefined**
  (decision 8) — no detection, no guard, no second-view handling. This
  criterion exists to record that the absence is deliberate, not an
  oversight.
- A value set at user scope and overridden at workspace scope resolves
  to the workspace value, proven by tests at the resolution layer.
- Every persisted key declares its valid scope; a key with no scope
  fails a test rather than defaulting silently.
- `blf_channel_maps` lives in `.cannet/` and a second project cannot see
  the first's mappings.
- A user who never names a project directory sees no change: the
  auto-created one lives where today's scratch does, with identical
  defaults.
- The disk-spill store never lands on the project directory's own
  storage: `.cannet/cache/` resolves to cannet-managed local storage,
  and `cache/` never appears in version control by default.
- A project directory can be copied to another machine (or another
  path) and its DBC / RBS references still resolve — proving paths
  inside the directory are written relative, not absolute.
- A DBC that a generator rewrites in the project directory still
  auto-reloads.
- The project-directory list shows accurate cache sizes and each row's
  state — active, auto-located, or orphaned. Clear empties a cache,
  Delete removes the cache directory and forgets the project, clear-all
  empties every cache, and no action removes a project directory the
  user owns.
- An auto-located row offers `Save as…`, and taking it produces a
  complete project directory at the chosen destination.
