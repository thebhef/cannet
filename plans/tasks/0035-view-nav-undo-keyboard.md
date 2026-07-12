# Task 35 — View Navigation History, Undo/Redo, and Keyboard View Actions

Make moving between views and mutating the layout keyboard-driven and
reversible: a browser-style back/forward history over focused views,
undo/redo of view-state changes (reopen a closed view, undo a layout
move), and the missing tab/window chords. Absorbs the **undo/redo on
view-state changes** item from [Task 24](0024-cross-cutting-polish.md).

Builds on the command framework from ADR 0018 (`commands.ts` registry,
code-declared bindings, `keybindings.ts` dispatcher) — every action
below lands as a palette-visible command with a default binding, not an
ad-hoc key handler.

## Items

### 1. View navigation history: previous / next view

Track the sequence of focused dockview panels (a focus history, like a
browser's back/forward stack) and add commands to walk it:

- **Previous view** — default `Alt+Left` (browser "back").
- **Next view** — default `Alt+Right` (browser "forward").

Navigating to a view that was closed in the meantime should skip it. The
history is ephemeral view state: frontend-local, bounded, not
persisted.

### 2. Undo/redo on view-state changes

Layout mutations become undoable: closing a panel, moving a panel
between groups, adding a panel. In particular, **undo after close
reopens the view** (the "reopen closed tab" affordance). Dockview
already serializes the full layout, so a bounded stack of layout
snapshots (or deltas) is the natural mechanism.

- Undo / redo as palette commands with the platform-standard chords
  (`Mod+Z` / `Mod+Shift+Z`) — scoped so they don't steal undo from
  text inputs (`dispatchStroke` already suppresses nothing for
  Mod-chords in editables; this needs an explicit carve-out).
- Panel `params` carry per-view state (search query, expand state,
  element id), so a reopened panel comes back as it was.
- Relates to the "Persist ephemeral view state" backlog item — a
  reopened session and an undo both want a captured view-state
  snapshot; share the mechanism if it falls out naturally, but don't
  expand scope to session persistence here.

### 3. `Mod+W` closes the focused view, not the window

Today `Ctrl+W` (`Cmd+W` on mac) is left to the webview / OS default,
which closes the whole window. Bind it to a **Close view** command that
closes the focused dockview panel, and prevent the default so the
window stays up. Closing the last panel should not close the window.
(With item 2 in place, an accidental `Mod+W` is undoable.)

### 4. `Ctrl+Tab` cycles tabs in the current tab group

- **Next tab in group** — `Ctrl+Tab`.
- **Previous tab in group** — `Ctrl+Shift+Tab`.

Cycles the tabs of the currently focused dockview group, wrapping.
Note: this is a literal `Ctrl` on all platforms (mac convention too),
but the chord syntax only knows `Mod`/`Shift`/`Alt`, where `Mod` is Cmd
on mac — the parser needs a literal-`Ctrl` token (or equivalent) for
this binding to be expressible on mac.

## Design questions

- **Arrow keys vs letters for back/forward.** Default assumption is
  `Alt+Left` / `Alt+Right` (the browser chords); confirm that's the
  intent behind "alt+l / alt+r".
- **One stack or two.** Focus navigation (item 1) and layout mutation
  undo (item 2) are separate stacks by default — moving focus is not
  a "change" to undo. Confirm before wiring.
- **Webview key interception.** Verify `Ctrl+Tab` and `Mod+W` are
  interceptable (keydown + `preventDefault`) in WebView2 / WKWebView /
  WebKitGTK before committing to the defaults; pick fallbacks if a
  platform reserves them.

## Exit criteria

- `Alt+Left` / `Alt+Right` walk the focus history across views;
  behaviour with since-closed views is defined and tested.
- Closing, moving, and adding panels are undoable; undo after close
  restores the panel with its params (position and per-view state).
- `Mod+W` closes only the focused panel on all platforms; the window
  close path (confirm modal, clean shutdown) is unaffected.
- `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle within the focused tab group,
  wrapping, on all platforms.
- All new actions are palette-visible commands with code-declared
  bindings; the boot-time binding-conflict assertion still passes.
- Task 24's prose no longer carries the undo/redo item.
