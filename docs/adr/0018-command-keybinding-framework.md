# ADR 0018 — Command / keybinding framework: frontend registry, user-editable bindings, context predicates

Status: accepted (2026-05-26), amended (2026-07-12)

A generalised command and keybinding primitive that panels and later
features register on. This ADR records the shape of that primitive
and why.

## Decision

**Frontend-only React-context registry.** The command registry, the
default binding map, the dispatcher, and the palette UI all live in
`apps/gui/src/`. Commands wrap existing Tauri commands when they
need host work; no new IPC shape and no host-side command knowledge.
Panel-local commands register and unregister on mount via a React
hook.

**Bindings are user-editable and persisted; code ships the
defaults.** `DEFAULT_BINDINGS` in source is the seed. The *effective*
binding set is the defaults overlaid by the user's customisation,
which persists in the host's `settings.json` (ADR 0034) as a
`keybindings` field. A shortcuts panel lists every command and its
binding and lets the user rebind, remove, or add a chord for any
command, with a one-click reset back to `DEFAULT_BINDINGS`.

Storage is the **whole effective list** (`keybindings: BindingSpec[]`
or `null`). `null` — the default — means "use `DEFAULT_BINDINGS`";
customising materialises the defaults into the array and saves it
whole; reset writes `null` again. The one cost of whole-list storage:
a user who has customised does **not** automatically receive new
built-in defaults added in a later app version (their saved list is
authoritative until they reset). This is an accepted trade for a
model that is trivial to reason about and matches how `settings.json`
already round-trips whole structs.

**No keystroke ambiguity — conflicts are rejected, not resolved.**
Two commands reachable by the same keystrokes (equal chords, or one a
prefix of another) in *overlapping* contexts remain forbidden. The
old build-time assertion is kept, now guarding `DEFAULT_BINDINGS`
(the shipped defaults must always be clean). On top of it, every user
edit is validated against the current effective set before it is
accepted: a chord that would collide is **refused with a message
naming the binding it hit** — the app never persists an ambiguous
map, so the dispatcher still sees at most one match per context. A
persisted list that somehow contains a conflict (hand-edited file) is
sanitised on load rather than trusted.

**Typed-context predicates over a small, fixed context object.**
Each command may declare a `context` predicate over a typed shape —
fields like `focusedPanelKind: "trace" | "plot" | "transmit" | "dbc"
| …`, `hasProjectOpen: bool`. A missing predicate means "always
available". Overlap between two predicates is decided by enumerating
the small finite context space, not by restricting predicates to a
declarative subset.

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

**User-editable now, because the framework is in use and the schema
decisions are no longer speculative.** The first cut of this ADR
deliberately deferred customisation ("a schema decision and a UI
decision; both can be made when there's a real user with a real
complaint"). Those decisions are now made: the schema is the same
`BindingSpec` the defaults already use, the merge is whole-list
overlay, and the persistence home is the existing `settings.json`
contract (ADR 0034). No new file format, no new IPC shape.

**Conflicts rejected at edit time, never resolved at runtime.** A
registry that resolves conflicts at runtime (last-registered-wins, or
"pick one deterministically") makes a key silently change behaviour.
Keeping keystrokes unambiguous is the whole point of the original
build-time assertion; moving bindings into user data doesn't change
that, it just moves the *check* from boot-only to boot (for defaults)
plus edit-time (for user changes). The user sees the conflict and
picks a different chord — the same loud-failure discipline, surfaced
in the UI instead of the build.

**Context predicates over a small fixed shape, not a general
expression language.** The predicates that matter (`focused panel
is a plot`, `there's a project open`) are short and fixed.
Inventing a predicate DSL would buy generality nobody needs.

## Rejected alternatives

- **Allow conflicts, report but don't block.** Considered and
  rejected: it reintroduces exactly the silent keystroke ambiguity
  the framework exists to prevent. Reporting a conflict the user can
  still trigger is worse than refusing the edit — the keystroke's
  behaviour becomes unpredictable the moment two bindings overlap.
- **Diff-based persistence (store only overrides + removals).**
  Upgrades better (new defaults reach customised users) but the merge
  and reset semantics are fiddlier and the file is harder to
  hand-read. Whole-list storage was chosen for simplicity; the
  upgrade cost is documented above.
- **`keybindings.json` as its own file (VS Code shape).** A separate
  file duplicates the `settings.json` load/save/temp-rename plumbing
  and adds a second hand-editable contract. Bindings are user
  settings; they live in the settings file.
- **Host-side command registry.** Splits one small problem across
  two languages and adds an IPC surface for every command
  invocation. The host already exposes the Tauri commands the
  frontend wraps; a host-side registry would duplicate the names.
- **Runtime conflict resolution (last-registered-wins).** Reliable
  in theory; mysterious in practice. A binding that wins silently
  steals a key; nothing the user can see says so.
- **Open predicate language.** The cost of writing a parser, an
  evaluator, and a documentation surface for predicates buys
  nothing past the fixed shape, given the tiny set of conditions
  actually needed.

## Consequences

- `DEFAULT_BINDINGS` seeds the shipped bindings; the effective set is
  `mergeBindings(defaults, user)`. The dispatcher and the palette
  hints read the *effective* set (frontend state loaded from
  `settings.json` on mount), not a compile-time constant.
- Build still fails fast on a collision in the *defaults*; user edits
  fail fast in the *shortcuts panel*. The two share one conflict
  checker.
- Panel-local commands (`plot.fitXAxis`, `plot.followLive.enable`)
  are bindable like any other, since they appear in the command
  registry.
- Multi-step sequence chords remain expressible in `DEFAULT_BINDINGS`
  and parse correctly; the shortcuts panel's chord *capture* handles
  single-step chords in its first cut (sequence capture is a later
  enhancement).
- Command arguments / forms remain an explicit non-goal here and are
  tracked separately if and when needed.
