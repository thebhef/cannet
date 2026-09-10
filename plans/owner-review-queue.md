# Owner review queue

An index for the owner to walk when time allows — detail stays in the
task files' status logs; this points at it. Strike items out with the
ruling and its date rather than deleting them.

## 1. Behaviour changes needing a yes or no

- ~~**136-1 removed 17 inherited `(task 129)` comment references in
  `apps/gui/src/`** (12 GUI files in `d9c75318`, from `24e76fb6`/#450).
  Policy-aligned (CLAUDE.md forbids task refs in source) but outside a
  python-client phase's scope; orchestrator accepted rather than
  cycling the branch. Undoing = reverting those small hunks.~~
  **Ruled 2026-09-09: approved.**

- **137-2's range-bound fields are NOT the shared `Combobox`** —
  departs from the "any new select/combobox is a `Combobox`"
  convention. Measured reason: `Combobox` is a filtered *select* whose
  Enter prefers a matching option, so typing `09:20` selected the
  event "fault injected" via fuzzy match; the new `BoundField` keeps
  the anatomy but lets typed text win (what the accepted prototype
  implements). Orchestrator accepted; undoing = swapping the control
  behind the same props. **Ruled 2026-09-09: approved** ("working
  better"). Same walk found a defect: a 4-day trace's bound fields
  accept nothing beyond h:m:s — day-scale entry ordered, fixed in
  place on the introducing branch.

- **137-3's logger panel has no name field**, unlike the accepted
  prototype's, which carries one in its header and locks it while
  writing. Repo precedent won: an element's name is its dockview tab
  title and is edited through `panel.rename` (ADR 0019) — no other
  element-backed panel duplicates it in its body. Undoing = adding an
  inline name input to the panel head. **Ruled 2026-09-09: approved**
  (no name field).

- **137-3 renders Format as a two-option select with MDF disabled.** The
  prototype offers both formats enabled; ruling 21 makes live logging
  BLF-only, and the prototype demonstrates no BLF-only rendering, so the
  shape was this phase's call. The alternative is a one-option select
  (or no control at all) until MDF logging exists. **Ruled
  2026-09-09: hide the Format control until MDF logging exists** —
  fixed in place on the introducing branch.

- ~~**139-6's math editor keeps the free-text unit box** beside the new
  base × prefix picker; the accepted prototype draws no such box.~~
  **Ruled 2026-09-08: dropped** ("the 'or a label' thing is weird");
  removed on `task139-apply`, old files' spellings still load and
  display.

- **139-6 made the View-signals resolved unit a full column**, not the
  in-cell chip the grooming described — clickability and width won.
  Saved layouts migrate without reset; every open panel's layout moves
  once. Undoing = folding the picker back into the signal cell.
  **Ruled 2026-09-09: approved; the column must also sort** — added
  in place on the introducing branch.

- **139-6 removed `unit_customizations_user`'s own settings row** — the
  units table edits both scopes (the checkboxes), and a second editor
  is what `EDITED_ELSEWHERE` forbids. The key stays hand-editable in
  settings.json. Undoing = a read-only descriptor row. **Ruled
  2026-09-09: approved.** Same walk found a defect: the units table
  needs a settings-dialog relaunch to show a spelling added or
  deleted — live refresh ordered, fixed in place.

- **The normalized unit order puts the *dimension groups*
  alphabetically too** (angular velocity … voltage), not in the
  curated engineering sequence the table was written in (voltage,
  current, charge, power …). Within a group it is the ordered
  alphabetical-by-display, prefix-ladder rule. Alphabetical groups
  were chosen so every units surface reads without a key; the
  alternative keeps the curated sequence and sorts only inside it.
  Undoing = one term of `units::list_order`. Detail: 0139 § Status
  log, 2026-09-09.

- **The composed-unit entry refuses the ruling's own example**,
  `W = V * A`: `W` already reads as the watt everywhere, and letting a
  definition take a name recognition answers would silently change what
  every database in the project means by it. The example works verbatim
  under any free name (`VA = V * A`), and the refusal names the unit
  that holds `W`. The alternative is to let a definition shadow a
  shipped spelling. Detail: 0139 § Status log, 2026-09-10.

- **A composed unit takes no SI prefix** — `kVA` is a second definition
  (`1000 * V * A`) rather than a prefix on `VA`, and its picker row
  shows one scale where a shipped base unit shows the whole ladder. The
  user named the whole thing, and there is no obviously right reading of
  a prefix on a name someone chose. Undoing = a `prefixable` flag on the
  entry. Detail: 0139 § Status log, 2026-09-10.

- **A composition may carry a numeric factor in any position**, not only
  leading (`V * A / 1000` is as legal as `1000 * V * A`) — the
  tokenizer treats terms uniformly, so the wider grammar cost nothing.
  Undoing = rejecting a number after the first term. Detail: 0139
  § Status log, 2026-09-10.

## 2. Rulings the owner has made

- 2026-09-06: perf results collect during the 136/137/135 campaign and
  never gate unless truly blocking follow-on development; review and
  baseline at closeout. PEAK dongles are on this machine.
- 2026-09-06: the groomed 136 → 137 → 135 run executes ahead of the
  roadmap's older Beyond-0.10.x entries (recorded in roadmap.md).
- 2026-09-06: `rms` is instantaneous; `stats` renamed `statistic`
  (task 0135 file).
- 2026-09-06: phases skip CI lanes their diff provably cannot reach —
  declared in the CI table with the reason, never silent (folded into
  `implement-phase` § 3; judge by touched inputs, run it when in
  doubt).
- 2026-09-06 (extends the above): **verification is tiered** — a
  phase runs only checks scoped to what it touched; the FULL CI
  matrix runs once per task, on the task-final phase, and acceptance
  rests on that run. Folded into `implement-phase` § 3.
- 2026-09-06: 135's prototype rework + drafted exit criteria proceed
  without the owner's look if it hasn't landed when 135-2 is ready —
  "don't wait"; the review can still overrule afterwards.

- 2026-09-08 (bench testing of the 139 build, all fixed in place on
  the introducing branches — no fixes branch, single commit per
  branch): the free-text unit box is dropped; the unit button shows
  only its resolved unit, derivation detail in hover text; an
  override is always clearable (a "derived" picker row exists even
  where nothing composes); pattern matches fold in the operand list;
  an unplaced pattern member no longer vetoes a set's like-kind
  derived unit (a real dimension mix still derives nothing).
- 2026-09-08 (second bench round, same fix-in-place rule): the bare
  ratio scale reads `ratio` — its old display `ratio 0-1` failed the
  spelling→recognition round trip, which was also why ratio targets
  converted nothing (one bug, fixed at `task139-units`); math series
  no longer appear in the View signals panel at all (filtered at the
  push site, fixed at `task135-surfaces` — also removes their GUID
  rows). Global 0–1/0–100 ratio rendering was considered and dropped.

- 2026-09-09 (section-1 walk): items approved as landed (see the
  struck entries above); the logger Format control hides until MDF
  logging exists; the View-signals unit column gains sorting.
  **Reversing an earlier decision, composed units are supported
  after all, via string**: a simple two-field entry — a name, and a
  string composing known units (e.g. `W = V * A`).
- 2026-09-09: percent's 0–1 vs 0–100 ambiguity is settled by
  **default unit-customization spellings**: `%` → percent (0–100),
  `%1.0` → ratio (0–1), shipped as default rows in the units table
  and remappable there like any spelling. Range inference was
  considered and dropped (ranges are raw-range artifacts — 0–102 —
  floats, or unset), and a cannet `BA_` unit attribute was
  considered and dropped (it would fracture the unit-string
  facility; supporting the string convention is the gentle,
  compatible spec). DBC itself has no unit semantics to lean on.
- 2026-09-09: the units ordering the owner called "weird" (settings
  table / picker) gets investigated and normalized with the same
  round.

## 3. Open findings nobody has dispositioned

| Finding | Source | Detail |
|---|---|---|
| TLS path has no end-to-end coverage | 136-1 | Both debug servers terminate no TLS; pin/fingerprint/SAN logic is unit-tested, the handshake is not. Covering it needs a TLS-terminating debug identity in `cannet-server`. |
| ruff lock divergence | 136-1 | client resolves ruff 0.16.6, sidecar locks 0.15.16 (0.16 widens default rules). Harmless; align when convenient. |
| ~~Agents build NSIS installers~~ | 136-1, 137-1, 137-3, 139-6 | **Root-caused and fixed 2026-09-06**: `implement-phase` § "Every phase ships an installer" (written 2026-08-23) predated the owner's 2026-08-27 no-installers ruling and was never updated — agents followed the skill over prompts. The skill section now mandates `tauri build --no-bundle` and forbids bundles. Artifacts only, nothing ever committed. **Recurred 2026-09-07 (139-6)** because the skill fix rides `doc-closeout`, which phase checkouts sit below — they still read the old skill. Phase prompts forbid bundles explicitly until `doc-closeout` lands. |
| "project-directory mode" read as `!ProjectDir::is_auto_located()` | 137-1 | Rulings 12/16 never defined the term; the phase rooted relative folders only when the user chose the directory, erroring for auto-located/unsaved sessions. Orchestrator endorses: identical semantics to the autosave-on-exit close flow (`project_dir.rs:118`). Yes/no from owner welcome. |
| ~~137-2 perf run measured zero load~~ | 137-2 + orchestrator | **Resolved 2026-09-06**: orchestrator control on the same build measured full load (rx 1607 / tx 1614 fps, 174 ids) with clean timing — the agent's launch misfired, not the harness. Null report deleted; `2026-09-06-bdd49487-task137p2-control.json` is the phase's record. |
| `PlotPanel.dom.test.tsx` render-count flake | 137-2, 140-1 | One full-suite run saw 8 renders where 2 are expected (137-2); **recurred 2026-09-07** during 140-1's full run and **again 2026-09-09** at tip `a6dea0bc` (cursor-restyle gate) — always under concurrent-suite load, always passing solo and on a clean re-run. Per the standing disposition this earns a fix phase — proposed to the owner at the 139/140 review. |
| ~~`coulomb` and `newton-millimeter` fail the spelling round trip~~ | 139 bench fixes | **Ruled and fixed 2026-09-08** — owner: "we should not be relying on parsing the unit strings anywhere in our application ... anywhere we care about units in cannet, they are consumed from a lossless and unambiguous representation." The round trip is gone rather than the spellings: a unit the model holds travels as `units::UnitReading` (the unit, and the string it shows), so `C` still renders `C` while converting as a coulomb. Fixed in place on `task139-derive` (the model hand-offs, the math catalog, the unplaceable flag) and `task139-apply` (the plot's display-unit query). Recognition still refuses `C` — that rule stands, and it now only judges a *database's* wording, which is ingest. Detail: 0139 § Status log, 2026-09-08. |
| Untracked `plans/release-notes.md` appeared unordered | orchestrator | A draft release-notes file for the chain, author unknown (no agent reported writing it). Left untracked; keep/commit/delete is the owner's call. |
| `tx_late_ms_max` straddles its limit on an unchanged build | 139-6 | Six scrub captures of one build: 85/12/82/28/9.5/72 ms vs the 55.7 limit — 3 over, 3 under, 9× spread; means all clean, memory flat, load real. The diff cannot reach the tx scheduler. Read the series at close-out; the metric's worst-of-run tail looks noisier than its limit assumes (cf. the eight-run control finding, ADR 0031 notes). |
| **Math pyramids are session-scoped — owner flagged 2026-09-06: "almost certainly not ok, at least long term"** | 135-1 + owner | Review at campaign close-out with a number attached (135-3's perf math case measures the reopen-recompute cost). Expected outcome: follow-up work persisting per-kernel resume state (cursors, held values, expfilter carry) beside the level files + park-on-redefinition, restoring the original "cached the same way" ruling. Short-term the landed recompute stands. |
| ↳ its 135-1 rationale | 135-1 | A math series' pyramid is neither persisted nor parked: reopening one from its level files alone leaves it with no fill state (operand cursors, held values, kernel carry), so it could never be extended again. Recomputing reads already-decoded samples — a fraction of the decode a persisted pyramid exists to avoid — so the ADR 0047 trade runs the other way for this provenance. Detail in `plans/tasks/0135-plot-math-functions.md` § Status log. |
| Bus names reach the host only through a math command | 135-1 | Patterns match the canonical path, whose first segment is the bus *name*; the host has no standing record of project bus names, so the math commands carry the map per call (as `fetch_signal_page` does) and latch it. Until one has been called, a name-anchored pattern matches nothing. A standing project-bus map on `AppState` is the alternative. Detail in the task file § Blockers. |
| Logger writes both directions | 137-3 | A logger writes the capture, and the capture holds transmitted frames as well as received ones — a 60 s ev-zonal run with the RBS going logged 216 209 frames against an rx rate of ~1608/s. Consistent with Save Capture, but the file's frame count is about twice what an operator watching the rx rate expects. Flagging in case a filter (or a column note in phase 4's gridview) is wanted. |
| A pair's first pick lands in A | 135-2 | With no Save to press, a definition's `picks` are an ordered list with no room for a hole, so picking into B while A is empty stores the operand as A. The alternative is a slot-shaped wire form (A-or-null, B-or-null) for pair functions. Detail in the task file § Status log. |
| An undone deletion loses its place in the listing | 135-2 | Undo re-defines the definition, and `define_math_signal` appends — so a deleted math signal comes back at the end of the Computed branch rather than where it sat. Restoring the position needs an insert-at command. |
| Unfinished math definitions are now stored, not refused | 135-2 | Owner ruling 7 of 2026-09-06, implemented: `define`/`update` no longer validate, `MathDefinition::validate` became the listing's `invalid` reason and gained `Unnamed`, and an operand naming no definition stopped being an error (it would otherwise make a dependent of a deleted definition uneditable). Listed so the reach of the ruling is visible, not because it is in doubt. |
| A math row in a signal view shows no rate | 135-3 | Its cadence is its operands', not its own, so the column is blank; value / count / time are read off its own pyramid. The plot is where a computed series' rate is legible. Say if the column should carry the operands' rate instead. |
| A math row's chips ride in the *message* column of a signal view | 135-3 | The bus column is hidden by default, so chips there would be invisible on a fresh panel. The message column is empty for a math row and is where a plot's side list puts the same chips. |
| The plot side-list disclosure leads the row, not the prototype's trailing gap | 135-3 | `plans/prototypes/math-signals.html` groups the disclosure with the ✕ under a 0.9rem gap; the landed row puts the disclosure first (as a Database tree row does) so the value readout physically separates expand from remove. Stronger reading of the ruling, but a visible divergence from the prototype. |

## 4. Finished tasks awaiting acceptance

- **Task 136 — python-can Cannet Client** (2026-09-06): both phases
  landed (`task136-core-bus` → `task136-clock-detect`); all 7 exit
  criteria met (verdicts in the task file). TLS e2e-coverage caveat
  above stands.
- **Task 137 — Log Export** (2026-09-06): all four phases landed
  (`task137-templates` → `task137-export-dialog` → `task137-loggers`
  → `task137-file-grid`); all 6 exit criteria met (verdicts in the
  task file). Caveats: live 500 MB split unit-tested only; the five
  §1/§3 items above await rulings.
- **Task 135 — Plot Math Functions** (2026-09-06): all three phases
  landed (`task135-engine` → `task135-editor` → `task135-surfaces`);
  exit-criteria verdicts in the task file — 7 of 8 met clean,
  criterion 2 met in-session with the owner-flagged session-scoped-
  pyramid deviation (§ 3) as the one open ruling. Task-final full CI
  matrix green (3348 frontend / 1913 workspace tests).

- **Task 139 — Units and Scaling for Math Signals** (2026-09-07): all
  phases landed (`task139-units` → `task139-editor` → `task139-panel`
  → `task139-derive` → `task139-apply`); all 17 exit criteria met
  (verdicts in the task file). Task-final full CI matrix green on
  139-6 (re-run after the 2026-09-08 bench fixes: 3444 frontend /
  1233 host lib). Two §1 items above await rulings; § Blockers
  carries the two FYI behaviour
  notes (untargeted integrations read `A·s` not `coulomb`; a like-kind
  mixed set now converts — `1 A + 500 mA` reads 1.5, per exit
  criterion).
- **Task 140 — Project State Items** (2026-09-08): single phase landed
  (`task140-controls`); all 5 exit criteria met (verdicts in the task
  file). Frontend-only diff; scoped lanes green (3447 frontend).

## 5. Housekeeping owed at close-out

- ~~`cargo fmt` red on `interfaces.rs`~~ **fixed by 137-2** (whitespace
  only, the hook's own change; was pre-existing since #460).
- `servers/cannet-python-can/SMOKE.md:117` references `plans/backlog.md`
  (pre-existing, from #422) — long-lived docs shouldn't point into
  `plans/`; scrub with the next sidecar-touching change.
- Perf series review + baseline fold-in (owner ruling above).
- **Review the tiered-verification scheme** (owner, 2026-09-06): the
  `implement-phase` § 3 rewrite — scoped per-phase checks, full
  matrix once per task — gets reviewed at this campaign's close-out:
  did anything slip through a scoped phase to the task-final run, and
  is the tier split right?
