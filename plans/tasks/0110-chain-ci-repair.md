# 0110 — Chain CI repair

> **Status 2026-08-23 — landed, awaiting acceptance.** Committed as
> `1ef20769` on the chain (nothing has merged). **This task was listed on
> neither `roadmap.md` nor the owner-review queue until 2026-08-23.** It
> carries **no exit criteria and no status log**; its verification is the
> `## Every job, green` table, which is every CI job run by hand on one
> commit. Findings still owed a verdict: owner-review-queue 2.8 (the MSI
> drop, ruled), 3.27, **3.61**, **3.62**.

## Why this task exists

24 tasks landed on one linear branch chain off `main`, and none of it
has ever run through CI: `.github/workflows/ci.yml` triggers only on
`push: branches: [main]` and `pull_request`. Nothing in the chain has
merged and no PR has been open, so every job in the table below ran,
for the first time, on this branch — at the chain tip
`task-107-phase-1-subject-model` (`c17c573b`).

Branch: `chain-ci-repair`, based on `c17c573b`.

## Failures found, their attribution, and their fix

| Job | Failing thing | Introduced by | Fix |
|---|---|---|---|
| rust — clippy | `redundant_closure`: `.is_some_and(\|c\| c.is_empty())` in `crates/cannet-dbc/src/tests.rs:615` | `16ffadf6` (task 92) | Took clippy's own suggestion: `.is_some_and(super::calc::CalculatedFieldsConfig::is_empty)`. |
| rust — test | `cannet-perf-measurement`'s `screenshot::tests::the_scenarios_drive_labels_the_frontend_still_defines` panicked: a scenario clicks `"Add transmit panel"`, which `App.tsx` no longer defines | `81d5343e` (task 108 phase 3, "The application's toolbar is the chip toolbar") | See below — three related fixes, not one. |

### The toolbar regression, in full

`81d5343e` collapsed the hand-rolled toolbar into `Toolbar.tsx`'s
chip bar: every panel-adding/showing action now dispatches a command
id (`onRun`) instead of being a literal `<button>` with the phrase as
its text, and the import chip's busy state is now an `aria-busy`
attribute instead of a relabel to `"Loading trace…"`. Three things in
`crates/cannet-perf-measurement/src/screenshot.rs` still assumed the
old shape:

1. **The guard test only reported one broken label** because
   `the_scenarios_drive_labels_the_frontend_still_defines` asserts
   inside a loop and panics at the first failure. All three
   `window.__shot.toolbar(...)` scenario steps were actually broken:
   `'Add transmit panel'`, `'Add color map'`, and `'Graph panel'` —
   none of those strings are declared as `label: "…"` in `App.tsx`
   any more (they moved to `Toolbar.tsx`/`commands.ts`, some renamed).
   `'Graph panel'` in particular was never fixable by *any* static
   string check: its chip is icon-only (`title`, no `label`), so
   `textContent` never carries that phrase at runtime — the step was
   genuinely dead on arrival, not just a stale assertion.

   **Fix:** switched all three scenario steps from `toolbar(...)` to
   `command(...)`, since each panel-adding/showing chip dispatches the
   exact same command id the palette entry does — same outcome, more
   faithful to how the app is actually driven post-refactor:
   - `toolbar('Add transmit panel')` → `command('Add transmit panel')`
     (text unchanged, still declared in `commands.ts`)
   - `toolbar('Add color map')` → `command('Add color map')` (ditto)
   - `toolbar('Graph panel')` → `command('Show project graph')` (same
     command id `panel.show.projectGraph`, but the palette's label was
     always the longer phrase — the short one only ever lived on the
     now-removed toolbar button)

2. **The guard test's own coverage check became unsatisfiable as a
   second-order effect.** Once no scenario step calls
   `window.__shot.toolbar(...)` any more, `scenario_labels("toolbar")`
   returns an empty vector, tripping the test's own
   `assert!(!labels.is_empty(), "no toolbar labels found to check")`.
   This isn't the scenario being wrong — it's a real, correct
   consequence of `81d5343e`: the toolbar is commands-only now (its
   own header comment says so), so no scenario step legitimately needs
   to click one of its buttons by raw text any more.

   **Fix:** removed the `("toolbar", &app, "App.tsx", &declared)`
   entry from the coverage loop, with a doc comment explaining why.
   `window.__shot.toolbar` stays defined (nothing asked for its
   removal, and it may still be useful for ad-hoc driving); it is just
   no longer a coverage-checked helper because nothing hard-codes a
   raw toolbar click any more.

3. **`window.__shot.importIdle()` silently stopped waiting.** It
   polled for a `.toolbar button` whose `textContent` was
   `"Loading trace…"` — the only way to prove an import had finished.
   Since `81d5343e`, the import chip's label stays `"Import"` for its
   entire lifetime; only `aria-busy` and the tooltip change. So
   `importIdle()` always returned `true`, even mid-import — the
   `EXTRAPOLATION_SCENARIO`'s `waitFor('the import to finish', …)`
   would resolve immediately and the shutter could fall on a partial
   capture. No guard test covers this (it's JS embedded in a string,
   only exercised by an actual capture run), so it was silent.

   **Fix:** `importIdle: () =>
   !document.querySelector('.toolbar button[aria-busy="true"]')`.

None of these three needed new `__shot` capabilities — `command()`
and `aria-busy` both already existed; this is composition and
correction, not new machinery.

## Escalated / recorded, not guessed

The coverage-loop change (#2 above) is a test-scope decision, not a
pure bugfix: it asserts that the toolbar is not expected to be driven
by raw text any more. It follows directly from `81d5343e`'s own stated
design ("the toolbar is commands only"), so it was made rather than
stopped on, but it is recorded here and in
`plans/owner-review-queue.md` for a sanity check.

## Also in scope: drop the MSI bundle target

Owner ruling 2026-08-22 (measured on this repo's own release build):
MSI cost ~50 s of a ~222 s Windows bundle build and nothing needs it —
the WiX MSI Tauri produces is per-machine-only and therefore requires
admin, where NSIS covers both per-user and silent install.

- `apps/gui/src-tauri/tauri.conf.json`: `"targets": "all"` →
  `["app", "dmg", "deb", "rpm", "appimage", "nsis"]`. Tauri skips
  targets that don't apply to the host platform, so one list serves
  every leg of the release matrix; `.github/workflows/release.yml`
  needed no change to its `args`.
- `README.md:26` (Windows row) and `README.md:2866` (the `bundle/msi/`
  path row) updated; the `.github/workflows/release.yml:302` comment
  naming `.msi` among the platform's bundle formats updated.
- Removed the now-done bullet from `plans/backlog.md` (the one entry
  this task is permitted to touch there).
- Verified for free by the full `pnpm --dir apps/gui tauri build` run
  below: exactly one bundle produced, at
  `target/release/bundle/nsis/cannet_0.0.0_x64-setup.exe`. (A stale
  `target/release/bundle/msi/` directory from an earlier, pre-change
  build is still on disk — gitignored, and its file's timestamp
  predates this run — not evidence against the fix.)

## Every job, green

All six commands run locally against the repaired tree, in CI order:

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | pass (no matches) |
| frontend (test) | `pnpm --dir apps/gui test` | pass — 207 files, 2762 tests |
| frontend (build) | `pnpm --dir apps/gui build` | pass |
| python (sync) | `uv sync --extra dev --frozen` (in `servers/cannet-python-can`) | pass |
| python (ruff check) | `uv run ruff check .` | pass |
| python (ruff format) | `uv run ruff format --check .` | pass — 26 files already formatted |
| python (mypy) | `uv run mypy` | pass — 9 source files |
| python (pytest) | `uv run pytest` | pass — 110 passed |
| rust (test) | `cargo test --workspace` | pass — all crates green |
| rust (clippy) | `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| mdf-export-oracle (write) | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` | pass — 30 frames, 15080 bytes |
| mdf-export-oracle (validate) | `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass — OK |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass — froze, smoke-tested, listening |

Plus the unconditional per-phase installer check:

| Check | Result |
|---|---|
| `pnpm --dir apps/gui tauri build` | pass — one bundle: `target/release/bundle/nsis/cannet_0.0.0_x64-setup.exe` |
