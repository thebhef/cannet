# ADR 0018 — Command / keybinding framework: frontend registry, code-declared bindings, context predicates

Status: accepted (2026-05-26)

A generalised command and keybinding primitive that panels and later
features register on. This ADR records the shape of that primitive
and why.

## Decision

**Frontend-only React-context registry.** The command registry, the
binding map, the dispatcher, and the palette UI all live in
`apps/gui/src/`. Commands wrap existing Tauri commands when they
need host work; no new IPC shape and no host-side command knowledge.
Panel-local commands register and unregister on mount via a React
hook.

**Code-declared bindings.** Bindings are declared in source at the
point each command is registered. There is no user-editable
`keybindings.json`, no settings UI surfacing the binding map, and no
persistence path. Customisation is a deliberate later feature, not
part of the framework's first cut.

**Typed-context predicates over a small, fixed context object.**
Each command may declare a `context` predicate over a typed shape —
fields like `focusedPanelKind: "trace" | "plot" | "transmit" | "dbc"
| …`, `hasProjectOpen: bool`, `hasActiveCapture: bool`. A missing
predicate means "always available". Two commands bound to the same
key in *overlapping* contexts is a **build-time assertion** so
binding collisions cannot reach runtime.

**Two palettes, same matcher.** `Cmd/Ctrl+Shift+P` opens the command
palette (every available command). `Cmd/Ctrl+P` opens a go-to-view
palette (every open dockview panel by display name). Both use the
fuzzy matcher adopted in `plans/technology-inventory.md` (`fzf`).

## Why

**Frontend-only because the dispatch surface is the GUI.** Every
command either runs frontend code directly or fans out to an
existing Tauri command. Putting registry / dispatch in the Rust
host would require shipping the binding map to the frontend
anyway (the key event lands there), and would split a small
problem across two languages.

**Code-declared, not user-persisted, because the cost of getting
this right later is small.** A user-customisation layer is a
schema decision and a UI decision; both can be made when there's a
real user with a real complaint. Forcing them up front would bake
in choices we'd want to revisit (where the file lives, how it
merges with defaults, how plugins / extensions interact with it).
Until then, code is the source of truth.

**Build-time conflict assertion because keystroke ambiguity at
runtime is the worst failure mode.** A registry that resolves
conflicts at runtime (last-registered-wins, or "pick one
deterministically") makes a key silently change behaviour as new
panels mount. Asserting at boot turns the silent class of bug into
a loud one before it ships.

**Context predicates over a small fixed shape, not a general
expression language.** The predicates that matter (`focused panel
is a plot`, `there's a project open`) are short and fixed.
Inventing a predicate DSL would buy generality nobody needs.

## Rejected alternatives

- **`keybindings.json` from day one (VS Code shape).** Forces the
  schema, the merge semantics, and the customisation UI in the
  same track as the framework itself. Three problems for the
  price of one. Defer until the framework is in use.
- **Host-side command registry.** Splits one small problem across
  two languages and adds an IPC surface for every command
  invocation. The host already exposes the Tauri commands the
  frontend wraps; a host-side registry would duplicate the names.
- **Runtime conflict resolution (last-registered-wins).** Reliable
  in theory; mysterious in practice. A panel that mounts later
  silently steals a key from one that mounted earlier; nothing
  in the source code says so.
- **Open predicate language.** The cost of writing a parser, an
  evaluator, and a documentation surface for predicates buys
  nothing past the fixed shape, given the tiny set of conditions
  actually needed.

## Consequences

- The `f` and `l` plot hotkeys and the lifted toolbar commands
  register on this framework; later features — e.g. the
  argument-taking `goto.traceRow` / `goto.timeInTrace` /
  `plot.setVisibleRange` / `capture.save` — register theirs too.
- Build fails fast on a binding collision; the registry's boot
  step is the integration check.
- User customisation, command arguments / forms, and a settings
  panel for bindings are all explicit non-goals here and tracked
  separately if and when needed.
