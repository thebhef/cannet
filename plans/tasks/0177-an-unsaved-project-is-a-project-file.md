# Task 177 — An Unsaved Project Is a Project File

> Opened by owner observation 2026-11-20: *"it looks like we don't
> restore the trace or a virtual bus if we close/reopen cannet after
> opening the MDF into a new project."* Grooming in progress — the
> design below is ruled; the questions under it are not.

## Problem

Everything a relaunch brings back hangs off reopening a project
**file**:

- The launch opens the file the user-scope last-project pointer names.
  A project that was never saved has no file, so the pointer is empty
  and nothing is opened — its buses, virtual buses, bindings, layout
  and DBC assignments are gone, and the default layout comes up.
- The capture restore (ADR 0002 DS-7) is the last step of opening a
  project and reloads only a scratch stamped with that project's
  identity. With no project opened it is never asked for, so the frames
  stay in the cache with nothing to load them. A capture's own
  databases (task 84) sit behind the same step.

So importing an MF4 into a new project and relaunching loses the trace,
the virtual buses and the bus assignments, unless the project was saved
first.

ADR 0042 §1 already says an unsaved project has an ordinary,
auto-located project directory and that there is "no anonymous or
no-project code path". The directory exists; the project document is
never written into it. That is the gap.

## Design (owner rulings, 2026-11-20)

- **An unsaved project is kept as a real project file** in its
  auto-located directory in cannet's cache space. It has an identity
  and the last-project pointer names it, so a relaunch reopens it
  through the path every saved project takes: buses, virtual buses,
  capture, capture databases.
- **Importing an MF4 creates a temporary project directory with the
  temporary project in it.**

## Open with the owner

1. When an MF4 import creates a temporary project: on every import, or
   only when the open project has never been saved.
2. What a temporary project directory is keyed on — the capture file
   (re-importing the same MF4 returns to the same project and cache),
   or a fresh one per import.
3. Whether the same holds for a BLF import, and for a new project that
   only ever connects live.
4. What closing a temporary project asks, now that closing it loses
   nothing.
5. How temporary projects are listed and reclaimed (recent projects,
   the project-caches list).

## Exit criteria

Firm at the end of grooming.
