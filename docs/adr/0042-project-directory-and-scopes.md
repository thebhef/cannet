# ADR 0042 — The project directory, and user vs. workspace scope

Status: accepted (2026-08-02)

## Context

[ADR 0034](0034-settings-vs-state-and-custom-settings-panel.md) split
machine-local config by intent: `settings.json` for choices the user
sets, `state.json` for what the app records as it works. Both are
single, machine-wide files. The disk-spill scratch
([ADR 0002](0002-disk-spill-store.md)) is likewise a single directory
in the app's cache space, shared by whatever project happens to be open.

That works while the app has one working context at a time, and stops
working as soon as it has several:

- A capture belongs to the project it was taken for, but there is one
  scratch directory, so opening a second project destroys the first
  project's capture.
- BLF channel→bus mappings are per-project by nature. They live in a
  machine-global dictionary keyed by `project_id` — a scope emulated
  with a key because there was nowhere else to put it.
- "Reclaim the disk that job from last month is using" is not
  expressible: there is one scratch, and it belongs to whatever is open
  now.
- A project's files are referenced by absolute path, so a project is not
  movable or shareable as a unit.

Beyond the concrete gaps, a larger settings surface is planned. Building
it against a single scope and retrofitting a second later is the
expensive order.

## Decision

### 1. cannet always works in a project directory

Every session is rooted in a project directory. A **project directory**
is a directory holding a `.cannet_prj` *beside* a `.cannet/` — the pair
identifies one, not either alone.

```text
<project dir>/
  .cannet/
    settings.json        workspace-scoped settings
    state.json           project-scoped view state
    blf-channel-maps     BLF channel → bus mappings
    cache/               link → cannet-managed local cache
    .gitignore           ignores cache/
  my_project.cannet_prj
  xxx.cannet_rbs
  *.dbc
```

When the user has not provided one, cannet auto-creates a project
directory **in its own cache space**. That path is not a special mode:
it is an ordinary project directory that happens to be auto-located, so
there is no anonymous or no-project code path.

### 2. cannet never creates `.cannet/` as a side effect

It writes one only where the user explicitly pointed it: its own cache
space, or a destination chosen through Save As. Otherwise **the user
creates `.cannet/` themselves** — laying one beside a `.cannet_prj` is
how they declare "this folder is the project directory".

Consequently a loose `.cannet_prj` is not a project directory; opening
one changes nothing about the user's folder and it gets an auto-located
directory like any other project. Moving a `.cannet_prj` away from its
`.cannet/` un-pairs it. Two `.cannet_prj` files in one directory is
**undefined behaviour** — they would share a `.cannet/`, which is fine
if only one is ever opened, and is not a case to write code against.

### 3. Two scopes

| Class | User scope (`app_config_dir`) | Workspace scope (`.cannet/`) |
| --- | --- | --- |
| Settings | preferences that follow the person | overrides for this project |
| State | last project, palette MRU | project view state, BLF channel maps, recent BLFs |
| Cache | — | disk-spill scratch, signal caches, filter index, notes |

**A workspace value overrides the user value** for the same key. Which
keys may be overridden is per-setting metadata, not a property of the
scope mechanism.

**The path carries the scope, not the filename.** `.cannet/settings.json`
is the workspace file; `settings.json` in `app_config_dir` is the user
file. A file named `user.*` never appears inside a project directory.

Cache is workspace-only by nature — it is derived from one capture in
one project.

### 4. The cache is a link to cannet-managed local storage

`.cannet/cache/` is a link (a directory junction on Windows) to a cache
directory cannet creates in machine-local storage, keyed by a hash of
the project directory's path.

### 5. Workspace data is expendable; the capture is not surprising

Losing `.cannet/` costs per-project view state and a re-do of the BLF
mappings — no migration guarantees, consistent with
[ADR 0011](0011-project-file-format.md).

But the capture now lives in the project's workspace directory, so
returning to a project finds its capture still there rather than
destroyed by whatever was opened in between.

`clear_scratch_on_exit` clears the **active** project only. Reclaiming
any other project's disk is a deliberate action from the settings view,
which lists every project directory cannet holds cached data for — with
two distinct actions:

| Action | Cached data | Cache directory | Registry entry | Project directory |
| --- | --- | --- | --- | --- |
| Clear | emptied | kept | kept | untouched |
| Delete | gone | removed | forgotten | untouched |

Clear means "free the disk, keep working here"; Delete means "stop
tracking this project". **Neither can touch a directory the user owns.**
That is decision 2 applied to the reclaim path: if the app may not
create a `.cannet/` unasked, it certainly may not remove one. Nothing
deletes a cache behind the user's back, and no automatic policy
reclaims one.

### 6. Save As migrates; a hand-created `.cannet/` does not

Both promote a project off its auto-located directory, and they differ
on purpose. **Save As is cannet's managed workflow**, so it carries the
contents across — the user asked cannet to put the project somewhere,
and arriving without its data would be a surprise. **A hand-created
`.cannet/` starts clean**: the user made a directory, cannet fills it
and moves on. That is a declaration of intent going forward, not a
request to relocate anything.

### 7. Terminology: "project", not "workspace"

The thing a user works on is a **project**. What the code called "an
unsaved workspace" is an unsaved project. "Workspace" is reserved for
the scoped data: `.cannet/` is the workspace directory, and workspace
scope is the per-project half of the scope matrix.

## Why

**Why always a project directory.** The alternative — a directory only
when the user has one — means every read carries an "or the global
fallback" branch, and every feature has two modes to test. Making the
auto-located directory an ordinary project directory collapses that to
one path. It is the same reasoning that makes a null object cheaper
than a null check.

**Why the user creates `.cannet/`.** A tool that writes dotfolders into
directories because you opened a file in them is a tool people
distrust. Requiring the user to create it makes the folder's status
explicit and unambiguous, and removes an entire category of design
question — no adoption prompt, no first-open dialog, no "is this folder
mine yet" state. Save As is the exception precisely because the user
named the destination in a save dialog.

**Why the cache is a link rather than a real directory.** The
disk-spill store is memory-mapped. A project directory on a network
share — an entirely plausible shared project folder — would put an
mmap'd, multi-GB, continuously-appended store on a network filesystem,
which is a known route to corruption and stalls. A link keeps the
layout honest — `.cannet/cache/` is where a user looks and finds their
cache — while the bytes land somewhere that can carry them.

**The store opens the link's target, not the link.** This is the one
place where following the layout literally would defeat it: a project
directory on an SMB share cannot hold a reparse point at all, so a
store that opened `.cannet/cache/` would fail in exactly the case the
link exists to protect. The link is the browsable view of the cache,
not the path the store resolves; failing to create it is a logged
warning, not an error. The `.gitignore` covers the
adjacent hazard: a project directory is plausibly a repo, and a
multi-GB scratch tree has no business in someone's `git status`.

**Why hash-of-path rather than `project_id`.** The cache belongs to the
directory, not to the document inside it — the directory is what is
being cached *for*, and a project file can be replaced or renamed
inside a directory that keeps its identity.

**Why content files are not symlinked.** An earlier sketch had DBCs
symlinked in from wherever they are generated. The DBC auto-reload
watcher watches *parent directories*, so a linked file whose target
changes elsewhere would silently never fire — worst for generated
DBCs, which are exactly the files that change most. Generators should
output into the project directory instead. The failure mode matters
more than the convenience: the file would load fine, and only the
reload would quietly not work.

**Why two scopes rather than one file with scoped keys.** Two files
have two lifetimes. A user file follows the person across projects and
machines; a workspace file travels with the project or is thrown away
with it. Encoding that in key prefixes inside one file makes "reset my
preferences" and "throw away this project's state" the same dangerous
operation.

## Consequences

- Files referenced by a project that live inside the project directory
  are recorded **relative**, not absolute. Reading relative references
  already works ([ADR 0030](0030-project-relative-file-references.md)); the GUI's
  write path changes to match. A project directory becomes movable and
  shareable as a unit.
- `blf_channel_maps` loses its `project_id` key — the directory is the
  scoping.
- `recent_blfs` becomes per-project, so one job's BLF list stops
  bleeding into the next.
- Disk use multiplies by the number of projects with captures. The
  settings view's cache list is the relief valve, and it is required,
  not optional — a per-project Clear, a Delete that also forgets the
  project, and a clear-all that empties every cache without removing
  anything.
- Re-opening a project directory that is already open is **undefined
  behaviour** for now. Detect-and-focus is the behaviour worth having,
  but it needs single-instance / inter-window messaging the app does
  not have; that is tracked in the backlog as a dependency decision.
- ADR 0034's two files become two files × two scopes. Its
  settings-vs-state distinction is unchanged and still correct.
- ADR 0002's scratch root becomes the per-project cache that
  `.cannet/cache/` points at, and its DS-7 reload story becomes
  per-project rather than per-app.
- Projects predating this get **hand-migrated**, not migrated by
  shipped code. The affected population is one install.
