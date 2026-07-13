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

   The deciding question is *did the user choose this, or did the app
   observe it?* A field that is genuinely a user choice belongs in
   `settings.json` even if it lived in `state.json` first; at the time of
   writing, none of the existing fields do.

2. **A custom, in-repo settings panel.** The settings UI is a flat,
   hand-rolled dockview panel in `apps/gui/src`, styled in the app's own
   visual language — not a third-party schema-driven form framework.

3. **`settings.json` is editable without the GUI.** Like VS Code's
   `settings.json`, the file is the durable contract; the panel reads and
   writes it but is not required to use it.

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
- **Hand-editability is the durable win.** A real file the user can open
  is what "VS Code-like settings" actually means; it holds regardless of
  how rich the panel is.

## Consequences

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
  this rationale, so the decision is traceable if settings grow.
- **A command-palette entry opens the panel**, alongside the
  separately-added `project.close`.
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
