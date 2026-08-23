# ADR 0034 — User settings vs machine state: `settings.json`, `state.json`, and a custom settings panel

Status: accepted (2026-06-28)

## Context

[ADR 0032](0032-machine-local-ui-state-host-side.md) put machine-local UI
config in one host-written JSON under `app_config_dir`
(`preferences.json`), read and written through Tauri commands. Everything
in it — last project, no-project layout snapshot, recent BLFs, recent
commands — is state the app *records as the user works*, not choices the
user *sets*. There were no user-facing settings at all, and no UI to edit
one.

Task 18 Step 6 introduces the first genuine user settings — a disk-spill
scratch-size cap and a `clear scratch cache on exit` toggle — and needs
both a place to persist them and a way to edit them.

## Decision

1. **Two files, split by intent.** Machine-local config under
   `app_config_dir` becomes:
   - **`settings.json`** — *user intent*: choices the user deliberately
     sets (scratch cap, clear-on-exit, future preferences). Typed,
     defaulted, and **hand-editable** — editing the file directly is a
     supported path; the GUI is sugar over it. Source of truth for
     behaviour the user controls.
   - **`state.json`** — *app state*: things the app records for
     convenience (last project, no-project layout snapshot, recent BLFs,
     recent commands). This is the file ADR 0032 introduced as
     `preferences.json`, renamed because none of its contents are
     preferences. Best-effort, unversioned, regenerated as the user works.

   The deciding question is *is this a behavioural preference, or a memo
   about specific files and sessions?* A field that is genuinely a
   preference belongs in `settings.json` even if it lived in
   `state.json` first.

   *Sharpened 2026-08-03.* It used to read "did the user choose this, or
   did the app observe it?", which is ambiguous for a value a user typed
   into a dialog once. `blf_channel_maps` is the worked example: the
   user *did* choose those channel-to-bus assignments, and its own
   rustdoc calls them "user-authored" — yet it is state, because
   **user-authored is not the same as a user preference**. A mapping
   keyed to specific files is the app remembering what you accepted last
   time for *that* BLF, not a behavioural choice you set. (The rustdoc's
   "user-authored" note is about eviction policy — don't drop it, you
   can't recompute it — not about its category.) Ask what the value is
   *about*: the app's behaviour, or a particular file or session.

2. **A custom, in-repo settings panel.** The settings UI is a
   hand-rolled dockview panel in `apps/gui/src`, styled in the app's own
   visual language — not a third-party schema-driven form framework.

   *Amended 2026-08-03:* it is no longer **flat**. Once the store passed
   a handful of fields, a wall of controls stopped being usable, so each
   setting now carries an in-repo **descriptor** — label, help text,
   control shape, and two tags — and the panel is *generated* from it:
   search, a tag-grouped list, and one row per setting whose widget
   comes from its declared type. See "The descriptor" below.

3. **`settings.json` is editable without the GUI.** Like VS Code's
   `settings.json`, the file is the durable contract; the panel reads and
   writes it but is not required to use it.

4. **The descriptor is host-side, and joins rather than copies.**
   *(Added 2026-08-03.)* One static table beside the `Settings` struct
   declares, per setting, only what is genuinely new: a label, help
   text, the control shape, and two tags. A setting's **scope** is read
   from the store's own scope table (ADR 0042 §3) and its **default**
   from `Settings::default()`, so the descriptor is a *view* of those
   facts, not a transcription of them. It is served to the frontend
   through a command; the frontend declares no schema of its own.

   The tags are two closed enums: a **surface** (which part of the app
   the setting governs — what the panel groups by) and a **kind**
   (`default`, `behaviour`, or `developer`). `developer` marks the
   machine-load and internal-cadence knobs that exist so that every knob
   is *in the file*, not because tuning them is expected: the panel
   hides them unless an ordinary setting, `show_developer_settings`,
   says otherwise, and **nothing in the panel advertises what is
   hidden** — no banner, no count. The toggle is itself a searchable
   row.

   A row's control is generated from the descriptor's type. The one
   exception declares `type: "custom"` and names a renderer dispatched
   through a single table; that table is the entire extension surface,
   and there is no third case.

## Why

- **Settings and state have different contracts.** Settings are a
  user-authored document one might hand-edit, diff, or carry between
  machines; state is disposable scaffolding. Mixing them obscures which
  keys are safe to touch and makes "reset my settings" also mean "lose my
  recents." Two files keep the contract clear.
- **A form framework is premature.** `react-jsonschema-form` (@rjsf) and
  peers generate a settings UI from a schema, but the frontend stack is
  deliberately lean (React + dockview + uplot, no component/form library)
  and the initial settings count is two. A schema-driven framework for two
  controls is an abstraction for single-use code, and its generic styling
  fights the app's bespoke panels. A flat panel is smaller to read and
  matches the rest of the UI. The storage contract doesn't depend on it,
  so the panel can be swapped if settings proliferate.
- **A descriptor is not that framework.** *(2026-08-03.)* The rejection
  above is of a *third-party* library that owns the schema language, the
  widgets, and the styling. What decision 4 adds is none of those: no
  dependency, a schema that is a Rust table beside the struct it
  describes, and the app's own visual language. What it buys is what the
  rejection anticipated ("if settings proliferate") — the panel stops
  growing per setting, and the settings themselves stay one table entry
  each. The matcher and the tree pattern are ones the app already ships
  (`fzf`, the DBC panel), so the lean-stack argument is untouched.
- **Host-side, because that is where the promise can be checked.**
  Putting the descriptor beside `Settings` lets a test assert the two
  name the same keys — which turns "the file lists every knob" from a
  convention into something that fails a build. A frontend registry
  could not do that, and would have kept the hand-written mirror this
  replaces.
- **Hand-editability is the durable win.** A real file the user can open
  is what "VS Code-like settings" actually means; it holds regardless of
  how rich the panel is.

## Consequences

- **Extended by [ADR 0042](0042-project-directory-and-scopes.md): two
  files × two scopes.** The pair above is the *user* scope, and each
  project directory carries the same pair at *workspace* scope in its
  `.cannet/`. A workspace value overrides the user value for the same
  key; the path carries the scope, not the filename, so
  `.cannet/settings.json` is the workspace file and a name like `user.*`
  never appears inside a project directory. The settings-vs-state
  distinction this ADR draws is unchanged and still correct — it is the
  question of *what a field is*, orthogonal to *whose it is*. Both
  questions have to be answered for every field: settings or state, and
  user or workspace.
- **Refines [ADR 0032](0032-machine-local-ui-state-host-side.md).** Its
  single `preferences.json` becomes `state.json` (same contents, new
  name); a sibling `settings.json` joins it. The "host-side, not
  `localStorage`" principle and the `app_config_dir` home are unchanged.
- **Defaults make absence inert.** A missing file or missing key resolves
  to the documented default (scratch cap off / unbounded; clear-on-exit
  off), so a fresh install and a hand-deleted file behave identically.
- **No migration** (per ADR 0011): the rename drops the old
  `preferences.json` rather than reading it — it was best-effort to begin
  with; recents and the last-project pointer regenerate as the user works.
- **`plans/technology-inventory.md` records @rjsf as `rejected`** with
  this rationale, so the decision is traceable if settings grow. It
  stays rejected: settings did grow, and the answer was an in-repo
  descriptor, not a form library.
- **Every field carries a descriptor, or a test fails.** Adding a field
  to `Settings` without one — or leaving a descriptor behind for a field
  that was removed — breaks the build, as does a setting with no surface
  tag. Exactly one kind tag is a property of the type rather than a
  test.
- **A descriptor may also be a *view* rather than a field.** *(2026-08-03.)*
  The settings view hosts one thing that is not a stored value: the
  project cache list ([ADR 0042](0042-project-directory-and-scopes.md)
  §5), which belongs there because that is where a user looks for
  "reclaim the disk this project is using". Such a row declares itself a
  view, so the key-set rule above still holds over every row that claims
  to be a field, and it is bounded by two further tests — a view row must
  be a custom renderer, and must not shadow a real settings key. It shows
  no key: the panel teaches the file, and pointing at a key nothing
  stores would teach the wrong thing.
- **A command-palette entry opens the panel**, alongside the
  separately-added `project.new`.
- **Keybinding customisation rides this file.** Per
  [ADR 0018](0018-command-keybinding-framework.md), user-edited
  keybindings persist as a `keybindings` field in `settings.json` (they
  are a user choice, not observed state) rather than a separate
  `keybindings.json`. They are edited from the shortcuts panel, not the
  settings panel, but share the same durable, hand-editable contract:
  `null`/absent = use the built-in defaults.

## Rejected alternatives

- **One file for both.** Keeps the settings/state contract muddy; "reset
  settings" can't be separated from "clear state."
- **`react-jsonschema-form` / schema-driven UI now.** A dependency and a
  styling mismatch to render two controls; justified only once settings
  are many.
- **`localStorage` for settings.** Already rejected wholesale by ADR 0032.
