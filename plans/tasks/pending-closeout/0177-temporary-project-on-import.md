# Task 177 — A Capture Imported Into an Unsaved Project Gets a Temporary Project

> Opened by owner observation 2026-11-20: *"it looks like we don't
> restore the trace or a virtual bus if we close/reopen cannet after
> opening the MDF into a new project."* Groomed and implemented the
> same day; awaiting the owner's acceptance.

## Problem

Everything a relaunch brings back hangs off reopening a project
**file**:

- The launch opens the file the user-scope last-project pointer names.
  A project that was never saved has no file, so the pointer is empty
  and nothing is opened — its buses, virtual buses, bindings, layout
  and DBC assignments are gone, and the default layout comes up.
- The capture restore (ADR 0002 DS-7) is the last step of opening a
  project and reloads only a scratch stamped with that project's
  identity. With no project opened it is never asked for. A capture's
  own databases (task 84) sit behind the same step.
- That identity was only ever learned by **opening** a file, so a
  project given a file by Save As mid-session stamped its captures with
  no owner, and they too were never restored.

So importing an MF4 into a new project and relaunching lost the trace,
the virtual buses and the bus assignments.

## Design (owner rulings, 2026-11-20)

- **A capture imported into a project that was never saved gets a
  temporary project**: a project file named after the capture, in a
  project directory of its own in cannet's cache space, created before
  the import so the capture lands in it. It is an ordinary project
  (ADR 0042 §1) — it has an identity, the last-project pointer names
  it, and the next launch reopens it through the path every project
  takes.
- **Only when the open project has never been saved.** A project the
  user saved is left alone and the capture lands in it. A temporary
  project counts as never saved, so the next import gets its own.

### Settled by the implementer, for the owner to overrule

- **BLF imports too.** The loss is the same and so is the handler.
- **Keyed by the capture's path.** Importing the same file again
  returns to the same temporary project rather than leaving another.
- **Saved on close without asking.** It exists so that nothing is lost;
  the choice that is the user's is Save As.
- **Listed like any project**: in the recent projects, and under the
  project caches, where it is cleared or deleted.
- **A session that only connects live is unchanged**: it has no file
  until it is saved.

## Exit criteria

- Importing a capture with a never-saved project open creates the
  temporary project and saves into it before the import starts —
  `App.mdfContents.dom.test.tsx`.
- A temporary project's directory is auto-located on the save that
  creates it and on every reopen, with one cache — `project_dir.rs`.
- A save records the project's identity, and a capture taken before a
  project's first save becomes that project's.
- README § settings (temporary projects, autosave), `docs/CONTEXT.md`
  and ADR 0042 say what the code does.

## Status

- 2026-11-20 — implemented. The tests above pass. **Not exercised in
  the app**: import, close, relaunch and see the trace, virtual bus and
  bus assignments return is the owner's check. The capture claim on a
  first save has no test of its own.
