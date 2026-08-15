# Task 70 — Live-Pass Findings on the 63–68 Batch

Owner's first live pass (2026-08-14) over the completed 63–68 stack
(tip `batch-docs-closeout` @ `11bc9b5`, not yet merged to main).
Several items read as regressions or as batch work not visible.

## Investigation item 0 — WHICH BUILD? — RESOLVED (2026-08-14)

Hypothesis (pre-batch binary) **refuted by the owner**: the session
ran `tauri dev` on the stack tip. Every finding below is live on the
current build; the [stale-build?] tags are void. Items 6/7/8 are
real defects needing root-cause work despite the tests that assert
the behavior — the tests pass but the live surface disagrees, so
each investigation starts from that contradiction.

## Findings (owner, verbatim intent)

1. **Retire the completed task files** — "we still have 63-68 .md
   files present in the repo." Owner ruling supersedes the keep
   recommendation: DELETE the task files completed on this stack
   (walks stay in git history). Owner extended the set (2026-08-14):
   "we have 41-43 as well that are implemented on this stack too."
   Deletion set: `plans/tasks/0041,0042,0043,0063,0064,0065,0066,
   0067,0068-*.md` — plus `0038-mdf-import.md` (the stack's base
   branch is task38f-closeout; standing recommendation to include
   it unless the owner objects). Simple docs commit.
2. **REGRESSION — BLF open dialog**: "opening BLF takes _ages_ to
   render the dialog and there is _no_ feedback while it's
   happening. I opened several in a row because nothing was
   happening and then got prompted with the dialog several times."
   Two defects: (a) long silent latency before the channel-map
   dialog renders (what is slow — the scan? the dialog mount?);
   (b) no busy indicator AND no reentrancy guard — repeated
   invocations queue multiple dialogs. Investigation-first; the
   Import-trace unification (task 66 phase 1) touched this path.
   Owner refinement (2026-08-14, second look): release-build load
   time is much better than `tauri dev`'s, and a status label
   change DOES exist — "not quite enough feedback," "not as far
   off as I thought." Re-scoped accordingly: the reentrancy guard
   is the hard requirement (block a second load until the first
   finishes); feedback needs strengthening (the label change is
   too subtle); latency is measured on a release build before
   being treated as a defect.
3. **Enum lanes still lag** [stale-build? — but investigate
   regardless]: "Over just a 5400 s trace for most of it their
   leading edge was lagging by 2/3 of the width of the window."
   Note for the investigator: the task-63 fix addressed *code loss*
   (min/max decimation dropping intermediate codes) and added a
   tail-splice so coarse levels reach the live edge; a *leading
   edge* lagging by fractions of the window on a long trace is a
   different signature. Related recorded asymmetry (task 63 phase 2
   blockers): the numeric serve kept the tip lag the categorical
   serve splices away — if enums lag numerics, that's backwards
   from the recorded state; measure, don't assume. 5400 s trace,
   live rendering, leading-edge currency per axis kind is the
   experiment. The task-63 phase-1 vbus rig + currency gauges are
   the reproduction tooling (see 0063's status log in git history).
   Owner detail (2026-08-14): the worst view mixes 16 cell voltages,
   the balancing-state enums, current estimates, and SOC estimates —
   reproduce with that composition, not a lone enum lane. Second
   observation, possibly the same defect seen differently: on
   another view "either the point markers aren't rendering on enum
   signals OR we're extending the enum lane beyond where we have
   data" — i.e. the lane's drawn extent may be running ahead of its
   served data. Distinguish these (marker rendering vs extent
   overdraw) as part of the same investigation.
4. **REGRESSION — project view labels centered**: "all of the
   labels in the project view now are centered instead of
   left-aligned." Likely CSS fallout from the DisclosureToggle
   migration or collapse work (task 63 phases 3–4 touched
   ProjectPanel and shared row CSS). Find the offending rule; add a
   DOM/style assertion so alignment can't silently flip again.
5. **Disclosure arrows not visibly bigger** [expectation vs
   ruling]: the groomed design deliberately kept the ink ~12 px and
   grew only the invisible hit area to ≥24×24 (dense rows don't
   bloat). The owner expected a visibly bigger arrow: "The
   disclosure arrow is not bigger anywhere, but it should be easy
   to fix now at least." **Groomed (2026-08-14)**: owner ruling —
   make the glyph big enough to fill the box, uniformly ("it's got
   plenty of space everywhere I see it"). One shared rule
   (`.disclosure-toggle-glyph` font-size); size the ink to fill the
   24px hit box (compact sites fill their row height).
6. **Database panel still titled DBC**: owner characterization
   (2026-08-14): the **dock tab strip**, in a **pre-existing
   project** — consistent with the persisted dockview layout
   carrying the old title string. Owner ruling: "our singleton
   panels should not be named based on their state" — a singleton
   panel's tab title always comes from the panel's current
   code-defined title, never from the saved layout; normalize on
   restore so every existing workspace heals. Verify the mechanism
   (confirm the saved layout is the carrier), fix, and test that a
   layout persisted with an old title restores with the current
   one.
7. **Ctrl+P "DBC" does not find the Database panel** [stale-build?]:
   the keywords alias landed with a test (task 66 phase 2). Verify
   on current build; if it reproduces, check whether the go-to-view
   command (vs the show-panel command) lacks the alias — the owner
   says "control+p for goto", which may be a different palette
   entry than the one that got `keywords`.
8. **Recents not project-specific — bleed confirmed with repro**
   (owner, 2026-08-14): existing project + BLF import → "new
   project" + several MF4s → reopen existing project + another BLF;
   Recent captures then shows all five entries across both
   projects. Storage IS project-scoped (`recent_blfs` is
   `Scope::Workspace` → the project's `.cannet/state.json`), so the
   bleed is upstream of storage. Two suspects for the
   investigation: (a) the list is a *frontend-capped MRU* — if the
   frontend's in-memory list doesn't reset on project switch, it
   accumulates across projects and persists the merged list into
   whichever project is current; (b) the "new project" (unsaved, no
   project dir) leg — where do Workspace-scoped writes and reads
   route with no project dir? Fix test-first with a two-project
   switch test.
9. **Question — can MDF carry signal information for CAN messages
   too?** Answer: yes. ASAM MDF bus-logging files can carry
   DBC-decoded per-message channel groups (the "third content
   shape" from Task 38 — our importer currently *recognizes and
   skips* those groups, reporting them), and our own exporter
   attaches the DBC file itself as an MDF attachment. **Owner
   opened the scope (2026-08-14)**: "we should definitely be
   ingesting messages from .mdf traces, definitely need to dig in
   on this one." Grooming fact (2026-08-14, `scan_mdf` census over
   the owner's example files, which stay out of this repo): the
   files carry all three shapes at once — bus-logging frame groups
   (importable today), dozens of per-message DBC-decoded groups
   (recognized-and-skipped today), and dozens of unnamed
   message-independent signal groups. **Groomed (2026-08-14)**,
   owner ruling: the import dialog offers **checkboxes for both**
   contents — _signals_ (checked by default: the file's signal
   content becomes file-backed signals, per-message decoded groups
   included) and _CAN messages_ (offered when frame groups exist:
   frames land on the timeline, and the user's own DBC decodes
   them). Attachment ruling (2026-08-14): extraction to disk is not
   in scope, but when the MDF carries a DBC attachment, **stream it
   into the same machinery that loads DBCs from disk** so the
   embedded definitions are usable directly. The investigation
   phase still establishes end-to-end behavior on the owner's files
   before implementation.
10. **File-backed signals plot no points** (found during grooming,
    2026-08-14): "when I import [an example MF4], I see signals in
    the database view but there are no points in the plot view when
    I add any of them." Refined by the owner: values DO show in the
    Signals view, but not in the plot, and not in the Database view
    when 'values' is checked. Probe facts (2026-08-14, example
    files, kept out of this repo): the data exists — the
    message-independent groups carry real series (roughly 1–26
    samples each over a ~one-minute run; a few signals have exactly
    one sample), so the plot/database value paths are dropping
    served data, not rendering an empty serve. Two more probe
    facts that shape the fix: these channels carry **no conversion
    blocks and no units** — names + already-physical values is all
    the scale information the file has; and the series are **very
    sparse** (a handful of points across the whole span), so
    line-only rendering without point markers can make even a
    correct serve invisible. Owner ruling (2026-08-14): this is
    **orthogonal** to the item-3 enum marker observation — do not
    merge the investigations. Lead for the Database-view half, from
    task 66 phase 2's recorded follow-up: the panel's live-value
    column covers DBC-backed rows only — a file-backed row renders
    no value cell, though `fetch_signal_page` already serves such
    keys. Investigation-first; fix test-first once attributed.
11. **Sparse-series rendering rules** (groomed 2026-08-14, owner
    rulings, apply once item 10's serve defect is fixed):
    (a) a series with a single point draws a horizontal line
    through that value — "we should still draw a hline through our
    one point if that's all we have"; (b) automatic point-marker
    mode gets a minimum-point-count floor: on an individual trace,
    markers keep rendering until the series has more than N points
    ("in auto we should probably have a minimum number of points
    before we stop rendering points on individual traces") — N
    picked during implementation, small and documented.

### Additional findings

- **Item 15 — REGRESSION: plot dropdown menus unclickable**
  (owner, 2026-08-14, refined): the right-click context menus work
  fine. The broken ones are the plot's **points auto/on/off**
  selector and the **cursor-type** selector — once open, clicking
  their content makes the menu "disappear with no effect." Owner
  hypothesis: "may have something to do with the cursor-following
  measurement line" — i.e. the plot's pointer/measurement handlers
  may be dismissing the popup (click-outside or mousedown handling)
  before the item's click lands. Investigation-first, then
  test-first fix.
- **Item 16 — task-number references in source comments** (found
  by the 70a dangling-reference sweep): ten comments in shipped
  code cite task numbers ("Task 41's exit criterion", "task 63
  item 1", "owner feedback, Task 65", "Task 43 phase-1 spike") in
  `DatabasePanel.dom.test.tsx`, `DisclosureToggle.dom.test.tsx`,
  `DisclosureToggle.tsx`, `traceTable.tsx`, `src-tauri/src/
  tests.rs`, `cannet-server/src/auth.rs`, `cannet-server/src/
  discovery.rs`. The working agreement forbids task numbers in
  source — cite an ADR or state the reason inline. Mechanical
  cleanup; plans/ references to task numbers are fine and stay.

## Closeout dispositions from the retired task files (2026-08-14)

The deleted task files (0038, 0041–0043, 0063–0068) were swept for
open loops before deletion; the owner dispositioned every hanging
item. Outcomes that add scope to this task:

- **Item 12 — TLS+token becomes the default for routable binds**
  (from 0042's open decision; owner rulings 2026-08-14): a routable
  bind auto-enables TLS+token instead of being refused. `--tls` is
  **removed**; `--no-tls` is the new opt-out flag (serve in the
  clear, said out loud). Loopback stays plaintext by default.
  `--insecure` dies too (owner-confirmed 2026-08-14): its only job
  was suppressing a refusal that existed because the default was
  insecure — secure-by-default removes the need. `--no-tls` is the
  single escape.
- **Item 13 — Servers panel must disambiguate same-named servers** (from
    0065's known limitation — two servers advertising the same
    instance name share one combo group header). Owner: "we have
    DNS, IP, and fingerprints to differentiate servers. Ambiguity
    here is not acceptable." Fix so identically named servers are
    always distinguishable.
- **Item 14 — Chronological trace row missing `aria-expanded`**
  (from 0063's traceTable note). Investigated 2026-08-14: NOT a
  divergent control — both trace modes sit on the shared ADR 0044
  gridview base (`TraceView.tsx` instantiates `useGridview`;
  ArrowRight/Left already expand/collapse via the adapter; rows
  carrying no `tabIndex` is the ADR's container-focus rule, not a
  gap). The real delta: ByIdTable's row declares `aria-expanded`,
  the chronological frame row declares only `aria-selected` — so
  expansion state is invisible to assistive tech. Scope: derive
  `aria-expanded` from the expanded set on expandable frame rows,
  DOM-tested. Owner ruling (2026-08-14, supersedes the keep
  recommendation): **remove the decorative caret** from the
  chronological view ("I didn't even realize it was still there")
  — the row is the disclosure, matching ByIdTable's settled call.

Other dispositions, recorded so the deletions lose nothing:

- Vector MDF Validator clause (0038): **waived** ("probably not
  going to bother with it for now").
- Unix tree-kill hardware verification (0067): **accepted** on CI
  unit coverage.
- Next-release verification checklist (0064): **owner action** —
  on the first release dispatch: .pkg installs with exec bits;
  `.deb` installs and its `$auto` `Depends:` line is read for
  over-constraint (pin explicitly if wrong); NSIS CI-only legs
  prove out; `.app`'s bundled `cannet-server` is `+x`.
- Declined for backlog (owner): 0041 perf-harness sidecar-spawn
  fold ("no"); 0043 packaging UDP-5353 allow rule, cross-machine
  mDNS walk, advertised-vs-bind address ("esoteric").
- Doc fixes folded into this task's docs phase: ADR 0021's stale
  `--virtual-bus` invocations → `cannet-server debug vbus` (done).
  The NSIS vendored-fork maintenance obligation turned out to be
  already recorded in `plans/technology-inventory.md`'s
  cargo-packager entry (re-diff the template on every version
  bump) — nothing further needed.
- 0065 pending-prompt rows: behavior presented concretely
  (a refused attempt stores nothing; the unanswered trust question
  is what holds the row, for discovered and hand-typed servers
  alike). **Ratified (2026-08-14)**: "the pending prompt as
  implemented does not seem typical, and yes, drop it." Panel =
  discovered + trusted; a dismissed prompt drops the row; a
  hand-typed address is retyped to retry. Lands with item 13.

## Process notes

- Items 2 and 4 are regressions: fix bugs test-first (failing test
  reproducing the bug, then the fix).
- Item 3 is investigation-first (scientific method in the status
  log; no fix without the attributing experiment).
- Items 5 and 9 are groomed (rulings recorded inline above); item
  9's remaining detail comes out of its investigation phase.
- Item 10 is investigation-first, then test-first fix.
- The batch's standing state when this task opened: stack complete
  and gated at `batch-docs-closeout` (`11bc9b5`); owner actions
  pending (merge to main — fast-forward, draft pre-release
  dispatch, palette PATH re-run); no re-baseline stands; the
  no-remove-×-exception on collapsed headings was ratified by the
  owner 2026-08-14 (expand first, then remove).

## Phases (groomed 2026-08-14)

One branch per phase, chained linearly off `batch-docs-closeout`;
phases run strictly sequentially in the main working tree.

1. **Quick UI fixes** — items 4 (label alignment + guard test),
   5 (disclosure glyph fills the hit box), 14 (`aria-expanded` +
   caret removal), 16 (task-number comment sweep).
2. **State/persistence correctness** — items 6 (dock-tab title
   normalization on restore), 7 (palette "DBC" alias verify), 8
   (recents cross-project bleed, two-project switch test).
3. **BLF open dialog** — item 2: reentrancy guard (hard
   requirement), stronger busy feedback, release-build latency
   measurement before latency is treated as a defect.
4. **Plot dropdowns** — item 15: points-mode and cursor-type menus
   vs the measurement line; investigation, then test-first fix.
5. **File-backed signal values** — item 10 (serve defect,
   investigation-first) then item 11 (single-point hline, auto
   marker minimum-count floor).
6. **Enum leading-edge currency** — item 3: mixed-composition
   reproduction at 5400 s, marker-rendering vs extent-overdraw
   distinguished, per-axis-kind currency measured.
7. **MDF message ingestion** — item 9: end-to-end investigation on
   the owner's example files, then the groomed checkbox dialog and
   DBC-attachment streaming.
8. **Server secure-by-default** — item 12: routable binds
   auto-enable TLS+token; `--tls` and `--insecure` removed;
   `--no-tls` is the single escape.
9. **Servers panel identity** — item 13 (same-name disambiguation)
   plus the ratified pending-prompt drop.
10. **Closeout** — exit-criteria walk, docs pass, final perf gate.

The ADR-0031 perf gate runs after phases 5, 6, and 7 (they touch
render/data-path hot spots) and again at closeout; multiple runs
per build, worst-to-worst comparison.

The owner's example capture files stay out of the repository — in
whole or in part — and are never named or referenced in any repo
document; their location travels only in phase prompts.

## Status log

- **2026-08-14, phase 1 (`task70-p1-quick-ui`, branched off
  `batch-docs-closeout`):**
  - `556480e` docs(task70): record the phase plan — the phase-plan
    edit landed as the branch's first commit, per the git contract.
  - `23576db` fix(gui): left-align the project panel's full-width
    section headers (item 4). Root cause: `.disclosure-toggle`'s base
    rule sets `justify-content: center` (correct for an icon-only
    glyph); `.project-panel .project-section-toggle` stretches the
    button to `width: 100%` for the section header row and sets
    `text-align: left`, but `text-align` has no effect on a flex
    container's item placement — the missing `justify-content:
    flex-start` override left the label centered in the full-width
    button. Added a failing declared-CSS guard test first
    (`ProjectPanel.collapse.dom.test.tsx`), confirmed it failed
    against the current rule, then added the override. Frontend: 154
    test files / 2042 tests passed; build clean.
  - `7e43d1a` fix(gui): size the disclosure glyph to fill its hit box
    (item 5). Owner ruling: one shared `.disclosure-toggle-glyph`
    font-size, not per-site overrides. Bumped 0.75rem (12px) → 1.1rem
    (17.6px) — close to the 24px default hit-box floor while still
    clearing the smallest compact row height (`dbcPanelViewport.ts`'s
    20px `ROW_HEIGHT`) without clipping. Updated the existing
    `DisclosureToggle.dom.test.tsx` assertion (it encoded the old
    "ink smaller than the box" design) and the stale doc comments
    that described the old sizing. Frontend: 154/2042 passed; build
    clean.
  - `545c91c` fix(gui): chronological frame rows expose aria-expanded,
    drop the caret (item 14). Added `expandable`/`aria-expanded` to
    `TraceView.tsx`'s `Row` (mirroring `ByIdTable.tsx`'s existing
    check), and removed the decorative glyph from `cellContent`'s
    shared `"msg"` case in `traceTable.tsx` — the row is the
    disclosure now on both trace surfaces. `isExpanded` became
    unused inside `cellContent` as a result; dropped from its
    signature and both call sites (`ByIdTable.tsx`, `TraceView.tsx`).
    Three new tests added to `TraceView.signals.dom.test.tsx`
    (aria-expanded present + tracks state, absent on an undecoded
    row, no caret in the message cell), written first and confirmed
    failing before the fix. Frontend: 154/2045 passed; build clean.
  - `cb88094` docs: drop task-number citations from source comments
    (item 16). The ten sites named in the task file plus every other
    task-number reference found by a full sweep of `apps/`, `crates/`
    and `examples/` (30 files, comment text only, no behavior
    changes) — `plans/` and `docs/` were left untouched per the
    task's scope. Where a comment already carried an ADR citation
    alongside the task number (ADR 0026, ADR 0027, ADR 0041), the ADR
    stays and only the task number is dropped; sites with no
    applicable ADR got an inline reason instead. Verification:
    frontend 154 test files / 2045 tests passed, build clean;
    `cargo test -p cannet-gui` 633 passed; `cargo test -p
    cannet-server` 111 passed; `cargo test -p cannet-perf-measurement`
    6 passed (touched by the fps_flat.rs / runner.rs comment edits);
    `cargo clippy -p cannet-gui --all-targets` and `cargo clippy -p
    cannet-server --all-targets` both clean.

- **2026-08-14, phase 2 (`task70-p2-state-persistence`, branched off
  `task70-p1-quick-ui`):**
  - `4231d4f` fix(gui): the go-to-view palette carries the Database
    panel's old name (item 7). **Verdict: reproduces, and the recorded
    suspicion was right.** Experiment: a DOM test drives the real
    Ctrl+P against the real App, types `DBC`, and reads back what the
    palette lists — zero matches, while `Database` matched the same
    entry. Data: Ctrl+P (`goto.view`) builds `gotoPaletteItems` from
    the _view catalogue_ (`gotoViews` in `useCommands.tsx`), a
    different list from the command palette's; the singleton entry was
    `{id, label}` only, and `gotoPaletteItems` mapped just those two
    fields, so the `keywords: "DBC panel"` that landed on the
    `panel.show.dbc` **command** was never on the **view**. (fzf
    confirms the rest: `DBC` is not a subsequence of `Database`.) Fix:
    an optional `keywords` on a singleton view entry, passed through to
    the palette items, aliased with the old name. Frontend: 155 test
    files / 2047 tests passed; build clean.
  - `b6bc70c` fix(gui): a singleton panel's tab title comes from the
    code, not the layout (item 6). **Mechanism confirmed** against real
    dockview serialization in `dockLayout.dom.test.ts`: `fromJSON` of a
    layout whose `panels.dbc.title` is `"DBC"` produces a panel titled
    `"DBC"` — the saved layout is the carrier, and nothing downstream
    re-titles it (the existing title-sync effect in `App.tsx` covers
    element-backed panels only, keyed on `params.elementId`). The
    controlled pair is the two tests: same layout, same dockview, the
    only difference being the normalize call, and the titles differ.
    Fix per the ruling: `SINGLETON_PANEL_TITLES` collects the nine
    code-defined titles, `normalizeSingletonTitles` retitles them in a
    serialized layout, and both restore paths (project open, boot
    reopen) run the saved layout through it — existing workspaces heal
    on their next open. Wiring guarded by a test in
    `App.bootReopen.dom.test.tsx` (falsified first: with the two
    normalize calls removed it fails, with them it passes). Frontend:
    155/2051 passed; build clean.
  - `bde1211` fix(gui): recent captures follow the project, in both
    directions (item 8). **Two carriers, both upstream of storage; the
    fix needed both.**
    - _Observation._ Owner's sequence (project + BLF → New project +
      MDFs → reopen the project + BLF) shows every capture from both
      projects in one list. `recent_blfs` is `Scope::Workspace`
      (`state.rs::SCOPES`) and `state.rs`'s scoped read/write tests
      already prove per-directory routing.
    - _Hypothesis (a)._ The frontend list is an MRU seeded once
      (`useState(() => hostState().recent_blfs)`, `App.tsx`) and never
      re-seeded, so it survives a project switch and is written back
      merged.
    - _Hypothesis (b)._ New project never re-roots the host, so the
      unsaved session's workspace-scoped writes land in the project it
      just left.
    - _Experiment._ `App.recentsScope.dom.test.tsx` replays the owner's
      sequence against a mocked host that routes reads and writes by
      workspace key, with `open_project` / `close_project` moving the
      key — the same routing the host performs by re-rooting.
    - _Data._ Run 1, unfixed: fails at the New-project step, the list
      still showing the previous project's two captures — (a)
      confirmed, since the host state was never even consulted there.
      (b) is confirmed by construction rather than by an isolating
      run: the two were fixed together, and nothing but
      `close_project` moves the workspace key, so re-reading alone
      would have re-read the project just left. Run 2, with both
      fixes but the handoff issued alongside the rest of the
      new-project work: fails at the same step, which attributed a
      third-order ordering hazard — `set_state` flushes the _whole_
      cached struct, so a write issued after the host had moved but
      before the cache was re-read (`rememberProject(null)`'s
      `last_project` flush) deposited the old project's recents into
      the new directory, and the re-read then read them back. Run 3,
      with the handoff and re-read awaited before the rest of the
      work: passes end to end.
    - _Fix._ Host: `project::close_project` re-roots the session onto
      the auto-located directory an unsaved project belongs in
      (ADR 0042 §1/§7), with `Carry::Nothing` and the project identity
      cleared. Frontend: one `rehydrateProjectState` helper (re-read
      the host state, re-seed the list) at every project switch — open,
      Save As promote, New, and the boot open (whose `--project` leg
      can name a different project than the host resolved pre-WebView).
    - _Verification._ Frontend 156 test files / 2052 tests passed,
      build clean; `cargo test -p cannet-gui` 634 passed (the new
      `leaving_a_project_lands_on_the_unsaved_directory_not_the_projects`
      pins the directory pair `close_project` relies on); `cargo clippy
      -p cannet-gui --all-targets` clean. README's project-directory
      paragraph records the New-project behavior.

- **2026-08-14, phase 3 (`task70-p3-blf-dialog`, branched off
  `task70-p2-state-persistence`):**
  - `85ccba6` fix(gui): one trace-open at a time, with a launcher that
    says so (item 2 (a) + (b)). **The queue reproduces exactly as
    reported.** Six tests written first
    (`App.importTraceGuard.dom.test.tsx`), all six failing against the
    old flow; the symptom test is the owner's sequence — stall the
    census, launch twice more, release the walks one at a time,
    dismiss the first dialog and the next one arrives (`expected 1 to
    be +0`).
    - _Entry points._ Three reach the flow — the toolbar button, the
      command palette (`trace.import`), and the Recent-captures list —
      and all three call the one `handleImportTrace`, so one check
      covers them. There is no drag-drop path to guard: `tauri.conf
      .json` sets `dragDropEnabled: false` (dockview's HTML5 tab drag
      and Tauri's OS drop handler are incompatible on WebView2), so
      files only ever arrive through the dialog plugin.
    - _Guard._ The pick-and-scan stretch is a ref, because the guard
      has to close on the synchronous call before any render; the
      dialog-is-up stretch is the `pendingBlf`/`pendingMdf` state
      itself, which cannot go stale and cannot leak the guard if a
      close path is ever missed. A seventh test pins that the guard
      releases: a second open after the first finishes still scans.
    - _Feedback._ The status-label change stays, and two stronger
      signals join it: the toolbar button that launched it becomes a
      disabled `aria-busy` "Scanning…" (full contrast, progress
      cursor — styled so it reads as working rather than unavailable),
      and an indeterminate sliding chip appears in the status line —
      the same affordance the plot already shows while its first
      sample builds, reused rather than reinvented.
    - Frontend: 157 test files / 2059 tests passed; build clean.
  - `b7f3d65` fix(gui): left-align the BLF map modal's markers
    disclosure — the latent duplicate phase 1 recorded, fixed in the
    dialog this phase was already touching. Same one-line
    `justify-content: flex-start` override, same declared-CSS guard
    test idiom (`declarations()` over `index.css?raw`), written first
    and confirmed failing. Frontend: 157/2060 passed; build clean.
  - `32b238b` docs(gui): put the measured census throughput in
    `scan_blf_channels` (item 2 (c)). **Verdict: not a defect —
    release-build latency is what the work costs, and no speculative
    optimization was built.**
    - _Observation._ Owner's second look: release load time is "much
      better than `tauri dev`'s", "not as far off as I thought."
    - _Experiment._ A release-compiled Rust timing harness (built
      outside the repository, against the real `cannet_blf::scan_blf`
      — the exact function the command calls) over two large example
      BLFs, three runs each. No GUI launched.
    - _Data._ A 46 MB example log (6.5 M messages, 1 channel):
      0.716 s cold, 0.546 / 0.540 s warm. A 470 MB example log
      (57.8 M messages, 1 channel): 5.926 s cold, 5.664 / 5.630 s
      warm. That is ~83 MB/s and ~10 M messages/s, linear in file
      size; the page cache is worth ~1.5 % of it.
    - _Attribution._ The scan is the whole of the file-size-dependent
      latency, and it is a single pass: the frontend issues exactly
      one `scan_blf_channels` per open (now pinned by the guard
      tests), and `open_log` re-opens header-only and pumps rather
      than walking the file a second time — no accidental double
      scan. Everything downstream of the scan is bounded by channel
      count plus marker count (that is the entire serialized payload),
      not by file size, so the dialog-mount half does not scale with
      the capture.
    - _Why the dev build felt so much worse._ `tauri dev` builds the
      host unoptimized, and the census is an inflate loop — precisely
      the shape debug builds punish. The rustdoc's own dev-build
      figure (20 s at the reference scale) against 5.7 s release at
      470 MB is consistent with that.
    - _Doc fix in the same commit._ The rustdoc claimed "a couple of
      seconds on a several-hundred-megabyte log" — optimistic by ~3x
      at that size. Replaced with the measured rate and both figures.
    - Verification: `cargo test -p cannet-gui` 634 passed / 6 ignored;
      `cargo clippy -p cannet-gui --all-targets` clean.

- **2026-08-14, phase 4 (`task70-p4-plot-dropdowns`, branched off
  `task70-p3-blf-dialog`):**
  - `9ae99df` fix(gui): the combobox dropdown swallows its own presses
    (item 15). **Verdict: the measurement line is not involved. The
    carrier is the plot panel's focus-claiming `mousedown` handler
    reaching the dropdown through React's portal event bubbling.**
    - _How the broken menus differ from the working ones._ The
      right-click context menus are `useDismissableMenu` menus: they
      decide outside-ness with `ref.current.contains(e.target)` on
      their own root, so nothing about focus can dismiss them. The
      points and cursor-type selectors are not menus at all — they are
      the shared `Combobox`, whose dropdown is portalled to
      `document.body` and closes on the filter input's `onBlur`. That
      is the whole difference, and it is why only these two (plus the
      per-area y-axis-mode selector, same control) broke.
    - _Observation._ Owner: once open, clicking a row makes the menu
      "disappear with no effect."
    - _Hypothesis._ The panel steals focus from the dropdown's filter
      input during the press, and the resulting blur closes the
      dropdown before the row's `click` fires.
    - _Experiment (isolating pair, run in a scratch suite)._ Two
      renders of the same `Combobox` with the same option list, driven
      with a real `mousedown` then `click` on a row. **A**: bare, no
      wrapper. **B**: wrapped in the plot panel's exact shape — a
      `tabIndex={-1}` root whose `onMouseDown` calls `root.focus()`
      unless the target `closest("input, button, select, textarea,
      a[href]")`. Nothing else differs; no measurement, cursor or
      uPlot machinery is present in either.
    - _Data._ **A** → `onChange("on")`. **B** → after the `mousedown`
      alone: `document.querySelectorAll('[role="option"]').length ===
      0`, `option.isConnected === false`, `document.activeElement` is
      the wrapper root; the ensuing `click` produces no `onChange` at
      all. The dropdown is torn down _by the press_, one event before
      the click.
    - _Conclusion (chain)._ mousedown on the `<li role="option">` →
      React dispatches it through the **React** tree (a portal escapes
      the DOM, not the component tree), so it reaches `.plot-panel`'s
      `onMouseDown` → the target is an `<li>`, matching none of the
      focusable selectors, so the handler calls `panelRef.focus()` →
      the combobox's filter input blurs → `onBlur`'s `relatedTarget`
      is the panel root, neither inside the popup nor the trigger, so
      it calls `close(false)` → the portal unmounts → the row is
      detached and its `click` never fires. The popup's pre-existing
      `preventDefault()` cannot help: it suppresses the browser's own
      focus move, never a handler's explicit `focus()` call.
    - _Corroboration across the codebase._ Making `pickCombobox` fire
      the press ahead of the click — a faithful gesture — turns 15
      existing tests red, **all of them in `PlotPanel.dom.test.tsx`**
      (points mode and y-axis mode), and none anywhere else in the 157
      frontend suites. The plot panel is the only host in the frontend
      that claims focus on `mousedown`, which is exactly the
      distribution the attribution predicts.
    - _Fix, at the shared seam._ The popup's `onMouseDown` now calls
      `stopPropagation()`: the dropdown is not inside its host,
      visually or logically, so it swallows its own presses. One line
      in `Combobox.tsx`, no per-menu patch, and every combobox in the
      GUI is covered. `useDismissableMenu` is untouched — it was never
      implicated, and the menus built on it stay green.
    - _Regression tests, written first and confirmed failing._
      `Combobox.dom.test.tsx` gains the seam's contract (an option
      click commits inside a host that claims focus on mousedown;
      falsified with `expected false to be true` on the
      still-connected assertion), and `PlotPanel.dom.test.tsx` gains
      the owner's two dropdowns driven with measurements enabled —
      the state the report was made in, though the panel's focus claim
      never consulted it (falsified with `expected 'auto' to be
      'on'`). `pickCombobox`'s press upgrade keeps every other suite
      honest for free.
    - Frontend: 157 test files / 2062 tests passed; build clean.

- **2026-08-14, phase 5 (`task70-p5-filebacked-signals`, branched off
  `task70-p4-plot-dropdowns`):**
  - `2da09d6` fix(gui): the plot's window fetch keeps a signal's
    provenance (item 10, plot half). **Verdict: the plot asked the host
    for the wrong identity — one of the area's two per-tick queries
    dropped the file-backed flag.**
    - _Observation._ Owner: an imported file's signals list in the
      Database view and read values in the Signals view, but adding one
      to a plot draws nothing. Probe facts already recorded: the series
      exist and are short (a handful of samples each).
    - _Hypothesis._ The serve is fine — the Signals view reads it — so
      the plot's *request* names a different signal than the one the
      host holds. A file-backed series is keyed host-side by its
      provenance (`SignalKey::file`), and `ensure_caches` deliberately
      mints nothing for a file-backed query, so a query arriving without
      the flag names a DBC identity nothing has ever decoded and can
      only come back empty.
    - _Experiment (a controlled pair inside one render)._ `PlotArea`
      builds two signal lists on the same tick from the same array: the
      `signal_min_max` sidecar and the `sample_signals` window fetch. A
      DOM test drops a file-backed row onto an area and reads back both
      payloads. Nothing else differs between them.
    - _Data._ Sidecar: `{signalName: "AmbientTemp", fileBacked: true}`.
      Window fetch: `{busId: null, extended: false, fileBacked: false,
      messageId: 7, signalName: "AmbientTemp"}` — the assertion diff is
      `- "fileBacked": true` / `+ "fileBacked": false`. The two lists
      are built twenty lines apart and only one carried the flag.
    - _Fix._ One line: the `sampleRange` mapping carries `fileBacked`
      the way the sidecar's already did. `useDecimatedRange` had always
      forwarded the field — it was never given a value to forward.
    - _Test fixture honesty, same commit._ The panel suite's fake host
      now models the real one: a signal it holds only as file-backed
      serves an empty series (and a `null` extent) when queried as
      DBC-backed. Without that, a caller dropping the flag is invisible
      in what the plot draws.
    - Frontend: 157 test files / 2063 tests passed; build clean.
  - `852fec8` fix(gui): the Database panel's value column covers
    file-backed rows (item 10, database half). **Verdict: a different
    defect from the plot's — the panel never asked at all.** The
    recorded lead (task 66 phase 2's follow-up: the live-value column
    covers DBC-backed rows only) was right, and there were three gates,
    not one.
    - _Experiment._ A DOM test expands a file branch, turns the values
      column on, and reads what the panel asks `fetch_signal_page` for,
      against a host that answers only for the key it was given —
      provenance included, exactly as `select_file_backed` matches.
    - _Data._ `expected 0 to be greater than 0`: with only file-backed
      rows on screen the panel issues **no `fetch_signal_page` at all**.
      `visibleSignalKeys` filtered `tag === "signal"`, so the key set
      was empty and the poll's `keys.length === 0` guard returned before
      the round-trip. Two further gates sat behind it — the `value` prop
      and the cell's render condition both required `tag === "signal"` —
      and the reply map was keyed without the provenance flag, so a
      served file-backed row would have collided with a DBC signal whose
      message id equalled its group index.
    - _Fix._ One rule per seam rather than a fourth inline branch:
      `valueColumnKey` and `valueColorTarget` answer for both
      provenances, the visible-key set carries file-backed rows with
      their group index in the message slot, and the reply is mapped by
      `recordSignalKey`. The colormap target matches the shape the
      signal view already uses for the same row, so the two surfaces
      tint alike.
    - Frontend: 157 test files / 2064 tests passed; build clean.
  - `c761298` feat(gui): a one-sample series draws as a horizontal line
    (item 11 (a)). `mergeSeries` holds a one-sample series' value across
    every column instead of opening with the pre-first-sample gap —
    that gap exists to keep a series with a *shape* from being drawn
    before it started, and a series whose entire content is one value
    has no such shape. When it is the only thing on its axis the union
    collapses to a single column, so the visible x-window supplies the
    two ends to draw between; the span is consulted in that case alone
    and never widens a union that already spans two, so no series is
    drawn past its data. Five unit tests written first, two failing
    (`expected [ null, 7, 7 ] to deeply equal [ 7, 7, 7 ]` and
    `expected [ 5 ] to deeply equal [ +0, 5, 10 ]`), plus a panel-level
    guard falsified by disabling the rule (`expected 1 to be greater
    than 1` — one x column, nothing to draw between). The enum-lane
    merge test used a one-sample signal to demonstrate the leading gap;
    it now uses two, which is what that rule is still about.
    Frontend: 157 / 2070 passed; build clean.
  - `027b665` feat(gui): auto point markers get a minimum-sample-count
    floor (item 11 (b)). **N = 32**, documented on
    `AUTO_POINT_MARKER_FLOOR` in `apps/gui/src/plotPoints.ts`, and in
    ADR 0026's implementation status. Why a floor is needed at all:
    uPlot's automatic rule measures the density of the *axis* — the
    merged x columns every series on it shares — so a series holding a
    handful of samples of its own loses its markers the moment it is
    plotted beside a fast one, which is exactly the sparse imported
    signal's case. Why 32: small enough that the markers are still
    countable at a glance and the line has not yet taken over carrying
    the shape, and a rounding error against the existing
    `MAX_POINT_MARKERS` cap of 500, so the floor can never be the reason
    a redraw is expensive. `applyAutoPointFloor` **wraps the density
    function uPlot installs during construction** rather than restating
    uPlot's rule, so the above-floor half cannot drift from uPlot's own
    definition; it reads the per-signal sample count per draw, since a
    fetch changes it without rebuilding the instance. Four unit tests
    plus a DOM guard (a sparse series marked while its dense neighbour
    is not), the latter falsified by removing the call: `expected false
    to be true`. Frontend: 157 / 2075 passed; build clean.
  - `c00632b` docs(adr): record the sparse-series render rules in
    ADR 0026 — both are render decisions, so they belong beside the rest
    of the show-points and axis behaviour rather than only in the code.
  - **Perf gate (ADR 0031, release build at `c00632b`), two runs, gated
    with `--expected-rx-fps/--expected-tx-fps 1608`: both passed,
    33 / 33 metrics, no baseline promoted.**
    - Run 1 (`docs/performance-measurements/frontend/2026-08-14-c00632b-task70-p5-run1.json`):
      rx 1606.6 fps, tx 1607.5 fps, 60 samples over 59.0 s, rx_gap
      `ids_measured` 173. longtask_ms_per_s_mean 0.000 (limit 12.600),
      lag_ms_max 4.400 (74.200), jank_fraction 0.000 (0.083),
      jsheap_mb_peak 85.6 (207.2), jsheap_mb_drift_per_min 8.584
      (16.386), renderer_mb_peak 363.2 (702.5),
      renderer_mb_drift_per_min 92.6 (106.6), host_mb_peak 59.0
      (180.8), tree_mb_peak 794.9 (1550.5), tree_mb_drift_per_min 120.9
      (165.2), flush_ms_mean 3.250 (25.000), tx_late_ms_mean 4.315
      (18.000), flush_ms_max 13.528 (55.352), tx_late_ms_max 16.075
      (176.894), rx_gap_p95_ratio_worst 1.169 (2.893),
      rx_gap_short_frac_worst 0.003 (0.041), rx/tx_fps_retention
      0.995 / 1.000 (0.800), rx/tx_fps_expected 1606.6 / 1607.5 against
      the two-sided band around 1608.
    - Run 2 (`...-task70-p5-run2.json`): rx 1605.7 fps, tx 1610.8 fps,
      `ids_measured` 173. longtask_ms_per_s_mean 0.000, lag_ms_max
      4.700, jank_fraction 0.000, jsheap_mb_peak 83.5,
      jsheap_mb_drift_per_min 8.666, renderer_mb_peak 358.0,
      renderer_mb_drift_per_min 80.9, host_mb_peak 58.2, tree_mb_peak
      788.5, tree_mb_drift_per_min 109.8, flush_ms_mean 3.116,
      tx_late_ms_mean 3.972, flush_ms_max 8.198, tx_late_ms_max 11.188,
      rx_gap_p95_ratio_worst 1.155, rx_gap_short_frac_worst 0.003.
    - Worst-to-worst, the two memory-drift metrics sit closest to their
      limits (renderer 92.6 of 106.6, tree 120.9 of 165.2) — the same
      shape the batch's earlier close-out runs show, not something this
      phase moved; every render-path timing metric is far under both the
      limit and the recorded baseline.

- **2026-08-14, phase 6 (`task70-p6-enum-leading-edge`, branched off
  `task70-p5-filebacked-signals`):** item 3, investigation-first.

  **Verdict on observation 1 — the reported signature does not
  reproduce. At the reproduction length the enum lane's leading edge is
  the most current series on the panel; the serve that lagged was the
  _numeric_ one.** That lag is real, was measured across two pyramid
  shapes and four point budgets, and is fixed here.

  **Verdict on observation 2 — extent overdraw, not marker rendering.**
  A lane is drawn to its _axis's_ last merged column, not to its own
  last sample.

  - _Reproduction tooling._ Task 63's rig: a hardware-free copy of
    `examples/ev-zonal` kept outside the repository, its two
    `interface_bindings` re-pointed at in-process `local-vbus://` buses
    (PEAK dongles untouched), driven by the ADR-0031 self-driving flags.
    The plotted area is the owner's stated composition — sixteen module
    cell-voltage numerics over eight messages, a current and an SOC
    estimate, and four enum lanes — in `per-unit` mode, so
    `deriveAxesForArea` splits it into the shared enum-lanes axis and
    three numeric axes. The RBS gives the plotted enums (and a numeric
    control) ADR-0028 `counter` specs, because a static override leaves
    a lane one segment for the whole capture and measures nothing.
    `follow_window_ms` is raised in the copy's `.cannet/settings.json`
    so the follow window grows to the whole capture — the regime where
    decimation engages at all. Temporary per-axis probes ride the
    existing `RenderReport` gauges: served leading edge per axis
    (`snapshot.lastT` minus each series' newest served sample), the
    merged x column set's own last value, the per-signal currency on
    the lane axis, and the window width. All removed before the phase
    landed.

  - _Experiment A (the serve, isolated)._ Before spending 90 minutes of
    wall clock on a live run, the question "does the serve reach the
    live edge at 5400 s" was answered where it is decidable in
    milliseconds: build `SignalCache`s directly at the reproduction
    length and read both reductions. Five series shapes — a 100 Hz
    varying numeric, a 10 Hz numeric ramp, a 10 Hz code series held in
    400 s runs, a 10 Hz code series stepping every third sample, and a
    100 Hz code series stepping every frame — each at four point
    budgets. Lag is `newest sample − newest served point`.

    | series | budget | min/max lag | runs lag |
    | --- | --- | --- | --- |
    | 100 Hz varying numeric | 2248 | 0.96 s | **0.000 s** |
    | 100 Hz varying numeric | 720 | 4.30 s | **0.000 s** |
    | 100 Hz varying numeric | 256 | 20.01 s | **0.000 s** |
    | 100 Hz varying numeric | 64 | 114.26 s | **0.000 s** |
    | 10 Hz code, long runs | 2248 | 0.70 s | **0.000 s** |
    | 10 Hz code, long runs | 720 / 256 | 11.10 s | **0.000 s** |
    | 10 Hz code, steps every 3rd | 2248 | 3.80 s | **0.000 s** |
    | 10 Hz code, steps every 3rd | 720 / 256 | 23.00 s | **0.000 s** |
    | 100 Hz code, steps every frame | 2248 | 2.21 s | **0.000 s** |
    | 100 Hz code, steps every frame | 64 | 157.07 s | **0.000 s** |
    | 10 Hz numeric ramp | 2248 | 1.60 s | **0.000 s** |

    **Twenty measurements, and the categorical serve is exact in every
    one.** The code explains it: `reduce_transitions` always appends the
    input's last point, and `window_categorical` reads through
    `level_points`, which splices each finer level's un-folded tail. The
    min/max serve read `window_slice` off the chosen level directly, so
    it stopped at that level's last _folded_ bucket — a tail whose
    wall-clock length is the level's bucket span and therefore grows
    with capture length and with how coarse the read is. This is
    task 63 phase 2's recorded asymmetry, now with a number on it.

  - _Experiment B (cold catch-up — the one mechanism that does produce a
    window-fraction lag)._ A bounded serve (`CATCH_UP_SERVE_BUDGET`)
    answers with what it has decoded, so a cold cache trails the store.
    Does it trail the enum axis further than the numeric one? Two query
    sets over one 264 000-frame store in the rig's composition (three
    message groups on the enum axis, eight on the numeric), served
    alternately.

    | serve | budget 0 (chunk at a time) | real 150 ms budget |
    | --- | --- | --- |
    | 1 | enum 112.599 s / numeric 112.599 s | enum 0.099 s (complete) / numeric 112.599 s |
    | 2 | enum 105.199 s / numeric 105.199 s | both 0.099 s, complete |
    | 3–8 | identical, decaying 7.5 s per serve | both 0.099 s, complete |

    **Under a bounded budget the two axis kinds trail by bit-identical
    amounts**, because `catch_up_keys` guarantees every message group a
    whole chunk before the deadline is consulted. Cold-serve lag is a
    shared transient (94 % of the window on serve 1), not an
    enum-specific one — and where the two _do_ differ, the smaller axis
    (the enums) finishes first. So catch-up cannot make enums lag
    numerics; it makes them lead.

  - _Fix (`cc8c1f7` `fix(gui): both reductions serve to the capture's
    live edge`)._ Read both reductions through `level_points`. Written
    test-first: `a_served_window_reaches_the_newest_sample_at_long_
    capture_length` asserts the property for both reductions over both
    pyramid shapes at three budgets and at 5400 s, and failed on the
    min/max half alone (`left: 5379.98, right: 5399.99` — 20.01 s short)
    while passing on the categorical one. `decimate_min_max` already
    forces its last bucket's final sample into the output, so the
    spliced edge survives the decimation; the splice costs fewer than
    `PYRAMID_BRANCH` points per level below the one read (measured
    4218 → 4222 points at a 2248 budget, 87 → 104 at 64). Host: 635
    tests passed / 6 ignored, `cargo clippy -p cannet-gui --all-targets`
    clean.

  - _Observation 2, attributed (deterministic controlled set)._ Four
    renders of `mergeSeries` + `enumSegments` — the two functions
    between the served series and a drawn tile — differing only in how
    the lanes' served data ends.

    | case | lane's served last sample | last tile's right edge | overdraw |
    | --- | --- | --- | --- |
    | A: lane 0's message stopped at t=10, lane 1 live to t=100 | 10 | 100 | **90** |
    | A: lane 1 (the live one) | 100 | 100 | 0 |
    | B: one-sample lane (t=40) beside a live one | 40 | drawn `[0, 100]` | **60 after, 40 _before_ its only sample** |
    | D (control): both lanes current | 99.9 | 100 | 0.1 |

    **The lane's drawn extent is the axis's, not the series'.**
    `mergeSeries` sample-and-holds a value forward with no trailing
    `null` (the leading `null` has no counterpart), and `enumSegments`
    ends its final segment at the last x column — which is the union
    over every series on the axis. So a lane whose own data ends early
    is drawn across the gap to whatever its neighbours have. Reading A
    (markers) is the same picture from the other side: on an enum lane
    the markers cannot show where the samples actually are, because in
    `auto` the lane axis's merged column count puts uPlot's density rule
    well past marking, and where markers _are_ drawn `drawEnumTiles`
    runs in the `draw` hook — which uPlot fires _after_ `drawOrder`
    renders the series (`uPlot.cjs.js`: `drawOrder.forEach(fn => fn());
    fire("draw")`) — and paints a 0.65–0.75-alpha tile over the band the
    interior codes' markers sit in. The two readings the owner could not
    separate are one situation: the lane asserts a held state over
    ground it has no sample for, and nothing in the render says so.
    Both carriers are recorded under _Blockers / side effects_ rather
    than changed here — see there for why.

  - _Experiment C — the assembled system at full length._ A 5400 s
    self-driving run on the fixed release build, the owner's
    composition, the follow window grown to the whole capture
    (`winw` last 5401.4 s, `ext` 5402.5 s, 8 692 218 frames stored,
    `tx_fps` 1609.7 with 0.9999 retention). Leading edge per axis, in
    milliseconds behind the window's own last-frame time — negative
    means the served series reaches _past_ it, which the deliberate
    fetch margin (ADR 0024) produces.

    | axis | worst signal on it | best signal on it | drawn extent vs served | growth |
    | --- | --- | --- | --- | --- |
    | **enum lanes** (4 lanes) | mean **−39.3 ms**, max **+19.3 ms** | mean −84.3 ms | **0.000 ms** | −0.17 ms/min |
    | numeric `V` (16 cell voltages) | mean **+86.9 ms**, max **+179.3 ms** | mean −73.4 ms | 0.000 ms | −0.22 ms/min |
    | numeric `A` | mean −80.9 ms | mean −80.9 ms | 0.000 ms | −0.12 ms/min |
    | numeric `%` | mean −80.9 ms | mean −80.9 ms | 0.000 ms | −0.19 ms/min |

    **The enum lanes are the most current thing on the panel, and the
    numeric axis is the laggard** — the opposite of the report, and the
    same direction as experiments A and B. The worst enum-to-numeric gap
    is 126 ms, comfortably inside one serve cadence (the loop runs at
    ~11 Hz), so the exit criterion is met with two orders of margin. As
    a fraction of the window the enum lag is 39 ms of 5401 s =
    **0.0007 %**, against the reported two thirds — a factor of ~90 000.
    Every slope is negative and noise-level, so nothing here grows with
    trace length. Per-signal: `PackState` and `PackEnableRequest` (10 ms
    messages) −0.082 s, `MainPositiveState` / `MainNegativeState`
    (100 ms message) −0.055 s.

    Two readings fall out of the same table. First, **what per-axis
    currency actually tracks is the axis's slowest message**, not its
    render mode: the `V` axis's +87 ms mean / +179 ms max is the module
    messages' 200 ms `GenMsgCycleTime` showing through, exactly as task
    63 phase 1 found ("currency tracks the message, not the axis kind").
    Second, **`over` is 0.000 on every axis** — no lane was drawn past
    its own data here, because all four enum lanes stayed equally
    current. That is the control for the overdraw above: the defect
    needs one lane to end earlier than its axis-mates, which a rig whose
    enums all transmit continuously never produces.

  - _Experiment D — what a lane's leading edge is actually made of._
    Experiments A–C all say the serve is current, which leaves the
    question the report still deserves an answer to: **what _can_ put a
    lane's leading edge a large fraction of a window behind in the
    shipped build?** The answer C hints at (per-axis currency tracks the
    axis's slowest message) is testable directly: same rig, 600 s, one
    extra lane on `ImdSelfTest` with its RBS `period_ms` overridden to
    **6667 ms**, everything else untouched.

    | lane (its message's period) | leading-edge lag |
    | --- | --- |
    | `SelfTestState` (**6667 ms**) | mean **+3.282 s**, max **+6.600 s** |
    | `MainPositiveState` / `MainNegativeState` (100 ms) | −0.036 s |
    | `PackState` / `PackEnableRequest` (10 ms) | −0.079 s |

    Four lanes on one axis, one serve, one reduction — and the slow
    lane trails by **its own message period and nothing more** (6.600 s
    measured against a 6.667 s period), while its axis-mates are ahead
    of the live edge. The axis's worst-lane gauge is entirely that lane
    (mean 3276.2 ms, max 6590.9 ms). **A lane's leading edge is its
    message's newest frame**, so what the lag is a _fraction_ of is
    whatever follow window is in use: at the shipped `follow_window_ms`
    default of 10 s, a 6.7 s message period is two thirds of the window
    — the reported magnitude, from a pipeline that is behaving
    correctly at every seam. Whether the owner's balancing-state
    messages are that slow is a one-line check against their DBC's
    `GenMsgCycleTime`, and it is the first thing to look at before
    treating the report as a defect.

    (Caveat on this run: `winw` grew to 600.8 s rather than holding the
    10 s the copy's workspace `follow_window_ms` asked for, so the
    _fraction_ was not reproduced directly — only the absolute lag,
    which is the part that is a measurement. The fraction is arithmetic
    from it.)

    The same run shows observation 2's overdraw live, which experiment
    C's rig could not produce: the slow lane's served data ends 3.36 s
    (up to 6.67 s) behind the merged x column set the axis draws to, so
    that lane's last tile is drawn across the whole gap — the 90-unit
    controlled case above, at rig scale.

  - _Verification._ Host `cargo test -p cannet-gui` **635 passed / 6
    ignored** (+1: the new serve test), `cargo clippy -p cannet-gui
    --all-targets` clean. Frontend `pnpm --dir apps/gui test` **157 test
    files / 2075 tests passed**, `pnpm --dir apps/gui build` clean.
    All probes and scratch experiments removed; the diff that landed is
    one line of serve code, its rustdoc, and one test.

  - **Perf gate (ADR 0031, release build at `cc8c1f7`), two runs,
    gated with `--expected-rx-fps/--expected-tx-fps 1608`: both passed,
    33 / 33 metrics, no baseline promoted.** The serve path changed, so
    the gate was mandatory.
    - Run 1 (`docs/performance-measurements/frontend/2026-08-14-cc8c1f7-task70-p6-run1.json`):
      rx 1607.1 fps, tx 1608.1 fps, 60 samples over 59.0 s.
      longtask_ms_per_s_mean 0.000 (limit 12.600), lag_ms_max 1.700
      (74.200), jank_fraction 0.000 (0.083), jsheap_mb_peak 83.1
      (207.2), jsheap_mb_drift_per_min 13.332 (16.386), renderer_mb_peak
      355.2 (702.5), renderer_mb_drift_per_min 83.7 (106.6),
      host_mb_peak 58.5 (180.8), tree_mb_peak 779.1 (1550.5),
      tree_mb_drift_per_min 113.1 (165.2), flush_ms_mean 3.049 (25.000),
      tx_late_ms_mean 5.324 (18.000), flush_ms_max 8.289 (55.352),
      tx_late_ms_max 82.475 (176.894), rx_gap_p95_ratio_worst 1.158
      (2.893), rx_gap_short_frac_worst 0.005 (0.041), rx/tx_fps_retention
      0.994 / 1.000 (0.800). Host tiers: tracebuffer 25000.1 fps, grpc
      2866.3, hardware-peak 999.7, all ok.
    - Run 2 (`...-task70-p6-run2.json`): rx 1594.2 fps, tx 1601.9 fps.
      longtask_ms_per_s_mean 0.000, lag_ms_max 4.600, jank_fraction
      0.000, jsheap_mb_peak 81.3, jsheap_mb_drift_per_min 13.258,
      renderer_mb_peak 372.3, renderer_mb_drift_per_min 97.6,
      host_mb_peak 58.3, tree_mb_peak 793.6, tree_mb_drift_per_min
      127.1, flush_ms_mean 3.468, tx_late_ms_mean 7.235, flush_ms_max
      17.649, tx_late_ms_max 115.379, rx_gap_p95_ratio_worst 1.248,
      rx_gap_short_frac_worst 0.017.
    - Worst-to-worst the two memory-drift metrics again sit closest to
      their limits (renderer 97.6 of 106.6, tree 127.1 of 165.2) — the
      same shape phase 5 and the batch's close-out runs record, not
      something this phase moved. Every render-path timing metric is far
      under its limit, and the serve change costs nothing measurable
      here because the gated scenario's follow window keeps the read at
      level 0, where the splice is a no-op.

- **2026-08-14, phase 7 (`task70-p7-mdf-ingestion`, branched off
  `task70-p6-enum-leading-edge`):** item 9, investigation-first, then the
  groomed checkbox design.

  **Stage 1 — what import did with each content shape.** Measured with a
  throwaway `cannet-mdf` example run against the owner's example corpus
  (kept out of this repository, and removed before anything landed).
  Fourteen files, all one CAN channel, 7 645–21 982 frames each over
  20–120 s spans.

  | content shape | per file | what import did |
  | --- | --- | --- |
  | bus-logging frame groups | 1 group, 7.6 k–22 k frames | pumped onto the timeline |
  | message-independent signal groups | 32–35 groups, 1 signal each | filled as file-backed signals |
  | per-message DBC-decoded groups | 28–29 groups, **139–144 signals** | recognised, reported, **skipped** |
  | `##AT` attachments | **0** | nothing to load |

  - _What the decoded groups actually carry._ One group per CAN message,
    `cg_flags` bit 1 set and bit 2 clear, `si_path` =
    `CAN1.CAN_DataFrame.ID=0x310 EXT=False`, `cg_acq_name` = `CAN1
    message ID=0x310 EXT=False`. Their channels are the DBC's own signal
    names (`SOC`, `CurrentBMSState`, `Contactor1AuxState`, …), each with
    a master time channel, a unit where the DBC gave one, and 322 cycles
    over the file's span in the sampled file. The message-independent
    groups are the other shape entirely: one unnamed group per signal,
    names like `cell1.voltage.set`, no unit, no conversion, 5–19 samples
    across the run — the sparse series item 10 was about.
  - _The reason they cannot be re-derived._ The skip was justified as
    "the file's own frames plus the project's DBC already imply them."
    They do not: the DBC those signals were decoded against is the
    recording tool's, and the project may not hold it — these files
    embed no attachment at all. Skipping them dropped 139 of the 172
    signals each file carries.
  - _A second defect the census turned up, before any of it was
    implemented._ Reading a decoded group naively loses a third of it
    again. In the sampled file, of its 139 decoded channels **39
    decode to zero samples**:
    they carry a value-to-**text** conversion (a DBC enumeration —
    `CurrentBMSState = 1 -> "Idle"`, `PosContactorClosed = 0 -> "Open"`),
    `apply_conversion_value` returns a `String`, and `as_f64` returned
    `None` for every sample, so the channel arrived empty and
    `fill_file_backed_signals` skipped it entirely. Tally over that
    file (decoded / numeric-reading / conversion type): 71 `Linear` ok, 29
    range-conversion ok, **39 range-to-text empty**; on the
    message-independent side 33 ok and 18 genuine string channels
    (`DecodedValue::String` raw), which have no numeric series and are
    correctly left out.
  - _Where the frames land._ Unchanged and already correct:
    `MdfCanFrameSource` merges the bus groups in timestamp order and
    `import_mdf` runs them through the shared `run_pump` with a
    `WindowedSource` range filter (ADR 0046), exactly as BLF import
    does. `BusChannel - 1` is the wire channel.
  - _What a DBC attachment looks like._ None of the owner's files carry
    one, so this is from our own writer, which every Save Capture to MDF
    exercises: one `##AT` per loaded DBC, `at_tx_filename` = the DBC's
    base name, `at_tx_mimetype` = `application/vnd.vector.dbc`, the
    file's bytes embedded (the crate's
    `an_embedded_attachment_comes_back_byte_for_byte` round-trips it
    field for field). An *external* attachment names a file instead of
    carrying one and comes back with empty `data`.

  **Stage 2 — what landed.**

  - `830293a` feat(mdf): per-message DBC-decoded groups arrive as
    file-backed signals. `signal_groups()` returns every group that is
    signals rather than frames, each tagged with `decoded_source` (the
    `si_path`, `None` for a message-independent group);
    `SkippedDecodedGroup` becomes `DecodedMessageGroup` and still lists
    the per-message subset for a caller that wants to say what a file
    holds. `decode::as_signal_f64` keeps the stored code where the
    conversion yields text — four unit tests over the pure rule, plus
    three integration tests written first against
    `sorted_finalized_dbcdecoded.mf4` (decoded groups offered as signals
    with their samples and their source path; a message-independent
    group carrying no source path) and one host test that the fill
    produces one cache entry per decoded channel. `scan_mdf` grew a
    census (`SignalGroupCensus`) that counts groups and channels off the
    block graph instead of materialising every series to read the group
    names. cannet-mdf 40 tests passed; `cargo test -p cannet-gui` 636
    passed / 6 ignored; frontend 154 files / 2075 tests; build and both
    clippy runs clean.
  - `aa7aaff` feat(gui): the MDF import dialog offers a checkbox per
    content. `import_mdf` takes `import_signals` / `import_messages`;
    the dialog renders a checkbox per content the file actually carries.
    Signals default on. CAN messages are opt-in **except** on a file
    with no signal content, where the frames are all there is and
    defaulting them off would make the dialog's default action import
    nothing — recorded as an implementation reading of "CAN messages
    opt-in", since the ruling does not cover that case. Ticking neither
    disables Open; the channel → bus mapping is disabled while the
    frames are not being imported. Frames were also the only thing
    anchoring the session timeline, so `signal_origin_ns` supplies one
    from the earliest in-range sample and the pump-less path emits
    `log-finished` itself. Nine tests written first, all failing (five
    in `BlfChannelMapModal.dom.test.tsx`, two in the new
    `App.mdfContents.dom.test.tsx` falsified by removing the two wire
    arguments — `expected undefined to be true` — and two in
    `tests.rs`). Host 637 passed; frontend 158 files / 2082 tests.
  - `01155ff` feat(gui): an MDF's embedded databases load with the
    capture. `dbc_commands::install_dbc` is `add_dbc`'s
    parse-and-install core, split out and taking an *identity* rather
    than a file, so the filesystem watch stays with the caller that has
    a file to watch. `capture::install_embedded_databases` streams each
    `##AT` DBC through it under `<capture>#<attachment name>` —
    deliberately not a path, so nothing reloads it from disk and
    re-importing the same capture replaces it in place. Attachments are
    picked by Vector's registered MIME type or a `.dbc` name; an
    external attachment carries no bytes and is left alone (chasing the
    reference would be the sidecar ADR 0010 rules out). A database that
    will not parse is reported and left out. Three tests written first,
    all failing against the missing function. Host 640 passed / 6
    ignored; clippy clean.

  **Verification of the whole against the owner's files** (same
  throwaway example, after the three commits, corpus still out of the
  repository): every file's census signal count now lands, with no empty
  series at all — the sampled file's 172 census signals → **172
  filled** (33
  message-independent + 139 decoded), 44 214 samples; across the
  fourteen files 171–176 signals each and 10 945–64 104 samples, and
  `empty = 0` everywhere. Before this phase the same files delivered the
  32–35 message-independent signals alone. Scan cost after the census
  change: 2–4 ms per file for the whole walk.

  - **Perf gate (ADR 0031, release build at `01155ff`), two runs, gated
    with `--expected-rx-fps/--expected-tx-fps 1608`: both passed,
    33 / 33 metrics, no baseline promoted.** No cannet instance held the
    dongles before either run, and the process tree was killed after
    each; `cannet.log` carries no error from either capture window.
    - Run 1 (`docs/performance-measurements/frontend/2026-08-14-01155ff-task70-p7-run1.json`):
      rx 1606.2 fps, tx 1609.8 fps, 60 samples over 59.0 s, rx_gap
      `ids_measured` 173. longtask_ms_per_s_mean 0.000 (limit 12.600),
      longtask_ms_per_s_p95 0.000 (17.000), lag_ms_max 5.300 (74.200),
      jank_fraction 0.000 (0.083), jsheap_mb_peak 90.700 (207.200),
      jsheap_mb_drift_per_min 12.914 (16.386), renderer_mb_peak 371.871
      (702.516), renderer_mb_drift_per_min 97.609 (106.605), host_mb_peak
      58.281 (180.805), tree_mb_peak 798.426 (1550.523),
      tree_mb_drift_per_min 126.221 (165.233), flush_ms_mean 3.286
      (25.000), tx_late_ms_mean 4.472 (18.000), flush_ms_max 14.720
      (55.352), tx_late_ms_max 15.767 (176.894), rx_gap_p95_ratio_worst
      1.181 (2.893), rx_gap_short_frac_worst 0.004 (0.041),
      rx/tx_fps_retention 0.995 / 1.000 (0.800). Host tiers: tracebuffer
      25000.1 fps, grpc 2889.7, hardware-peak 999.8, all ok.
    - Run 2 (`...-task70-p7-run2.json`): rx 1601.5 fps, tx 1604.5 fps,
      60 samples over 59.0 s, `ids_measured` 173. longtask_ms_per_s_mean
      0.000, lag_ms_max 2.100, jank_fraction 0.000, jsheap_mb_peak
      84.400, jsheap_mb_drift_per_min 6.998, renderer_mb_peak 344.766,
      renderer_mb_drift_per_min 81.769, host_mb_peak 58.238, tree_mb_peak
      772.590, tree_mb_drift_per_min 110.554, flush_ms_mean 3.323,
      tx_late_ms_mean 3.790, flush_ms_max 12.060, tx_late_ms_max 8.779,
      rx_gap_p95_ratio_worst 1.130, rx_gap_short_frac_worst 0.001. Host
      tiers: tracebuffer 25000.1, grpc 2855.6, hardware-peak 999.9, all
      ok.
    - Worst-to-worst the two memory-drift metrics again sit closest to
      their limits (renderer 97.6 of 106.6, tree 126.2 of 165.2) — the
      same shape phases 5 and 6 and the batch's close-out runs record,
      not something this phase moved. The gated scenario is a live
      hardware capture with no MDF in it, so nothing this phase changed
      is on its hot path; the run is a guard against collateral damage,
      and there is none.

- **2026-08-14, phase 8 (`task70-p8-secure-defaults`, branched off
  `task70-p7-mdf-ingestion`):** item 12, the production proxy's
  routable-bind default flips from refuse-unless-flagged to
  auto-enable.
  - `428867f` fix(server): a routable bind auto-enables TLS+token;
    --tls/--insecure removed. `ProxyArgs::identity` becomes bind-aware:
    operator material (`--cert`/`--key`) always wins; otherwise a
    loopback bind stays plaintext and a routable bind reaches for the
    generated identity unless `--no-tls` says to serve it in the
    clear. `--tls` had nothing left to opt into and `--insecure`
    suppressed a refusal that no longer exists on this path; both are
    removed from `ProxyArgs`. `run_proxy` drops its `guard_bind` call
    — by construction a routable bind is now either TLS-protected or
    plaintext by the operator's explicit `--no-tls`, so the refusal
    branch can no longer fire there. `guard_bind`/`Protections` stay,
    unchanged in behavior, as the guard for `debug replay`/`debug
    vbus`, which still take no certificate at all and keep their own
    `--insecure`.
    Test-first at the guard seam: four new tests cover
    {loopback, routable} × {no flags, --no-tls}, asserting what
    `identity()` returns (and, via the untouched "token follows
    identity" rule in `run_proxy`, what serves); two more assert
    `--tls` and `--insecure` are rejected as unknown arguments on the
    production proxy. Five pre-existing tests that parsed `--tls` only
    to exercise unrelated token logic had it dropped from their
    argument lists; `insecure_does_not_turn_off_configured_tls` became
    `no_tls_does_not_turn_off_configured_tls`, same property, new flag.
    `cargo test -p cannet-server`: 44 unit + 37 lib + 3 auth + 7
    end_to_end + 9 proxy + 3 tls + 14 virtual_bus passed (1 ignored,
    the hardware-sidecar test), `cargo clippy -p cannet-server
    --all-targets` clean.
  - `05bf20d` fix(server): drop a stale refusal claim from --bind's
    own doc comment — missed in the first pass, caught on a full
    re-grep of the file for `tls`/`insecure` before moving to the
    wider doc sweep.
  - `8b41cef` docs(server): update every remaining --tls/--insecure
    reference (item 12). README's flags list, three invocation
    examples, and the "Connecting to a server run `--insecure`"
    section (now `--no-tls`); `cannet-client`'s `ConnectConfig`
    rustdoc; the GUI's `server_trust.rs`/`connect_flow.rs` comments,
    which describe the _client-side_ mirror of the server's flag.
    `debug replay`/`debug vbus`'s own `--insecure` bullets are
    untouched — see the scope note below.
    Verification (GUI doc comments only, no `.tsx` touched, run
    anyway per the phase's hard rule): `cargo test -p cannet-gui` 640
    passed / 6 ignored, `cargo clippy -p cannet-gui --all-targets`
    clean, `pnpm --dir apps/gui test` 158 files / 2082 tests passed
    (unchanged from phase 7's count), `pnpm --dir apps/gui build`
    clean. `cargo test -p cannet-client` 13 end_to_end + 8 protected
    passed, `cargo clippy -p cannet-client --all-targets` clean.

  **Guard-seam matrix (all four cells green):**

  | bind | flags | serves |
  | --- | --- | --- |
  | loopback | none | plaintext |
  | loopback | `--no-tls` | plaintext (no-op) |
  | routable | none | TLS + token (auto) |
  | routable | `--no-tls` | plaintext |

  **Scope note, recorded rather than silently assumed:** the task
  prompt's "current state" description (`--tls` opts in, `--insecure`
  suppresses the refusal) matches the production proxy exactly but not
  `debug replay`/`debug vbus`, which never had a `--tls` flag to
  remove — they terminate no TLS at all, by design, and ADR 0041's
  Decision section opens with "Applies to the production cannet
  server's public endpoint," scoping the whole secure-by-default
  mechanism there. Read literally, "`--insecure` dies too" could be
  taken to mean every `--insecure` in the binary; the closest faithful
  reading given ADR 0041's stated scope is that item 12 governs the
  production endpoint only, and debug tooling's own `--insecure` (a
  different, pre-existing mechanism with no TLS on either side of it)
  is untouched. Recorded under Blockers / side effects below in case
  the owner meant the broader reading.

- **2026-08-14, phase 9 (`task70-p9-servers-panel`, branched off
  `task70-p8-secure-defaults`):** item 13 plus the ratified
  pending-prompt drop.
  - `b5e58af` fix(gui): two servers of one name are never one group
    (item 13). **The ambiguity was in the bus combo only; the Servers
    panel already separated them.**
    - _What was ambiguous._ `BusInterfaceCombo` heads each trusted
      server's interfaces with `serverLabel(row)` (`name ?? address`),
      and `Combobox` emits a group header only when an option's `path`
      differs from the previous one's — so two servers advertising one
      instance name produced **one** header over both machines'
      interfaces, whose rows carry the interface name alone. The
      closed-state label (`selectedLabel`) had the same hole: a bound
      bus said `bench-rig / can0` without saying which `bench-rig`.
    - _Fix._ `serverLabels(rows)` in `serverList.ts` names every row
      distinctly, keyed by address: a name only one server answers to is
      left alone (so nothing changes on an ordinary list), and a shared
      one carries what tells them apart — the machine it runs on
      (`bench-rig (bench-a.local)`), falling back to the address
      (`bench-rig (10.0.0.5:50051)`) when the host name is shared or
      absent. The address is the row's identity, so the fallback always
      separates them and the fingerprint is never needed as a
      differentiator; it is on the panel row already, where comparing it
      is the security check. A row nothing advertises is already named
      by its address and is never wrapped twice.
    - _The panel needed no change, and that is the finding._ A row
      renders the DNS name, the machine, the address, the version and
      the fingerprint in their own cells, is keyed by address, and
      aria-labels every action with it (`forget 10.0.0.1:50051`). The
      collision is pinned there by a test rather than restyled —
      repeating the address inside the name cell would only duplicate
      the column beside it.
    - _Tests, written first._ Four unit tests over the label rule
      (unique name left alone; two machines told apart by host name;
      the address fallback for same-name-same-host and for a null host;
      and a five-row mixture where every label is distinct), plus a DOM
      test per surface forcing the collision — two `bench-rig`s on
      different machines (asserting two headers, not one, and the
      closed label naming the bound one) and two on one machine at
      different ports. All six failed first (`serverLabels is not a
      function`, then `expected [ 'bench-rig' ] to contain 'bench-rig
      (bench-a.local)'`). README's combo paragraph records the rule.
    - Frontend: 158 test files / 2089 tests passed; build clean.
  - `029125e` fix(gui): an unanswered trust question is not a row
    (the ratified pending-prompt disposition).
    - _What was removed._ `merge`'s third row source — the loop that
      gave every pending prompt a row of its own — and, with it, the
      only way an address could sit in the panel storing nothing. The
      panel's post-add `setDialogFor(added)` went too: with no row for
      an unanswered address, `dialogRow` can never resolve, so the call
      was dead the moment the host stopped minting one. Three doc
      claims that described the old behaviour went with the code
      (`merge`'s and `add_server`'s rustdoc, the panel's module
      header), and README's add-by-address paragraph gained what a
      dismissed question leaves.
    - _Why the add-by-address flow still works._ The question a refused
      dial raises is not carried by the row: `ServerTrustDialogs` is
      mounted app-wide in `App.tsx` over `useServerPrompts()`, keyed by
      address, and asks it whether or not anything is in the list.
      Accepting writes the pin, and the store is what makes the row —
      exactly what README already described. Dismissing stores nothing
      and leaves nothing, which is the ruling.
    - _Test-first._ `an_unanswered_question_is_not_a_row` replaces
      `an_address_the_host_is_waiting_on_gets_a_row_of_its_own` and
      failed against the old merge with the phantom row printed in the
      assertion message. The panel's add test now asserts the typed
      address leaves no row, no dialog, and a cleared field to retype;
      a sibling test asserts the row appearing once the identity is
      accepted. Dismissal itself was already covered in
      `ServerTrustDialog.dom.test.tsx` ("stops asking a question the
      user waved away").
    - Host: `cargo test -p cannet-gui` 640 passed / 6 ignored,
      `cargo clippy -p cannet-gui --all-targets` clean. Frontend: 158
      test files / 2090 tests passed; build clean.

- **2026-08-14, phase 10 (`task70-p10-closeout`, branched off
  `task70-p9-servers-panel`):** exit-criteria walk, docs pass, final
  perf gate. No behavior changed in this phase — every commit is
  documentation or a measurement.
  - `5839e4a` docs(readme): rewrap the trust-prompt paragraph — a
    96-column line phase 9's edit left mid-paragraph.
  - `a21489c` docs(task70): the exit-criteria walk — see
    § "Exit-criteria walk (2026-08-14, phase 10)" below the criteria
    list. Fourteen MET, three MET-WITH-DEVIATION, nothing waived.
  - `e9c4367` docs: four doc-vs-code mismatches the nine phases left
    behind, each verified against the code before being touched.
    - `cannet-mdf`'s `scan` module doc still said import would "step
      over" the per-message DBC-decoded groups; phase 7 made them
      importable, and the struct field doc eight lines below already
      said so.
    - ADR 0026's one-sample-hline amendment **and** `mergeSeries`'s own
      JSDoc both closed with "no series is drawn past its data". The
      one-sample fill is unconditional and never consults `span`, so on
      a shared axis such a series is held across its neighbours'
      columns — after _and_ before its only sample. That is the standing
      owner decision recorded below, so the docs were what was wrong,
      not the code.
    - README's two `debug replay`/`debug vbus` flag notes sent the
      reader to § Running the production server for `--insecure`, which
      phase 8 removed from that section.
    - `MdfScanResult::signal_group_count`'s rustdoc described an
      unconditional import; signals are a checkbox now.
  - `76173da` perf: the three closeout gate reports.

  **Verification sweep at `e9c4367`** (every suite re-run at the tip,
  not carried forward from a phase log):

  | suite | result |
  | --- | --- |
  | `pnpm --dir apps/gui test` | **158 test files / 2090 tests passed** |
  | `pnpm --dir apps/gui build` | clean |
  | `cargo test -p cannet-gui` | **640 passed / 6 ignored** |
  | `cargo test -p cannet-server` | **118 passed / 2 ignored** |
  | `cargo test -p cannet-client` | **68 passed** |
  | `cargo test -p cannet-mdf` | **40 passed** |
  | `cargo clippy --workspace --all-targets` | clean — 12 crates, **0 warnings** |

  - **Perf gate (ADR 0031, release build at `e9c4367`): three runs, and
    the first one FAILED. No baseline promoted; the failure stands as a
    blocker, not an explanation.**
    - _Run 1_ (`docs/performance-measurements/frontend/2026-08-14-e9c4367-task70-p10-run1.json`)
      — **check FAILED**: `rx_gap_short_frac_worst` **0.120** against a
      limit of 0.041 (baseline 0.006). Every other gated metric passed.
      rx 1615.5 fps, tx 1623.3 fps, 60 samples over 59.0 s,
      `ids_measured` 173. Also elevated relative to the whole series
      without breaching: `rx_gap_p95_ratio_worst` 2.397 (2.893),
      `tx_late_ms_max` 160.163 (176.894), `tx_late_ms_mean` 8.663
      (18.000). longtask_ms_per_s_mean 0.000, lag_ms_max 3.900,
      jank_fraction 0.000, jsheap_mb_peak 91.100,
      jsheap_mb_drift_per_min 9.833, renderer_mb_peak 362.105,
      renderer_mb_drift_per_min 88.577, host_mb_peak 58.129,
      tree_mb_peak 791.176, tree_mb_drift_per_min 116.020,
      flush_ms_mean 3.158, flush_ms_max 8.785, rx/tx_fps_retention
      0.998 / 1.003. Host tiers: tracebuffer 25000.101, grpc 2871.3,
      hardware-peak 999.8, all ok.
    - _Run 2_ (`...-run2.json`) — **passed, 33 / 33**.
      `rx_gap_short_frac_worst` **0.002**, the lowest value in the whole
      task's gate series. rx 1602.0 fps, tx 1607.6 fps.
      rx_gap_p95_ratio_worst 1.165, tx_late_ms_max 10.603,
      tx_late_ms_mean 4.312, lag_ms_max 3.900, jsheap_mb_peak 84.600,
      jsheap_mb_drift_per_min 7.249, renderer_mb_peak 355.980,
      renderer_mb_drift_per_min 88.658, host_mb_peak 58.477,
      tree_mb_peak 785.602, tree_mb_drift_per_min 115.909,
      flush_ms_mean 3.280, flush_ms_max 8.899. Tiers 25000.102 /
      2860.6 / 999.6.
    - _Run 3_ (`...-run3.json`), added **because run 1 failed** —
      **passed, 33 / 33**, `rx_gap_short_frac_worst` **0.002** again.
      rx 1608.6 fps, tx 1610.2 fps. rx_gap_p95_ratio_worst 1.183,
      tx_late_ms_max 18.966, tx_late_ms_mean 4.491, lag_ms_max 8.200,
      jsheap_mb_peak 90.400, jsheap_mb_drift_per_min 11.933,
      renderer_mb_peak 375.082, renderer_mb_drift_per_min 99.376,
      host_mb_peak 58.531, tree_mb_peak 806.645, tree_mb_drift_per_min
      129.048, flush_ms_mean 3.424, flush_ms_max 10.223. Tiers
      25000.105 / 2868.5 / 999.9.
    - _Sanity._ All three carry 60 samples over 59.0 s with
      `ids_measured` 173 and rx in the 1602–1616 range (not 0, so each
      run held the dongles itself); no cannet instance was running
      before any of them and the process tree was killed after each.
      `cannet.log` over the three capture windows carries **no error** —
      only the two benign warnings every run on this machine emits
      (`vxlapi64` not installed, and the startup clock-offset notice at
      +174 / +179 / +191 ms).
    - _What is and is not known about run 1._ Two variables separate it
      from the two clean runs, and **neither was isolated**: it was the
      first capture after a fresh link, so the 22 MB binary and its
      DLLs were cold in the page cache; and two watcher shells were
      polling `tasklist` every 5–10 s across its whole capture window,
      which runs ~15 process-table walks through the measured machine.
      Runs 2 and 3 had neither, and both landed at the series minimum
      for the metric that failed. That is consistent with perturbation
      but does not demonstrate it — a falsifying experiment would hold
      the page cache warm and reintroduce the polling alone, which was
      not run. **Recorded as a blocker below.**
    - _Five-gate worst-to-worst._ Worst run of each gate in this task:

      | metric (limit) | p5 | p6 | p7 | p10 | trend |
      | --- | --- | --- | --- | --- | --- |
      | `renderer_mb_drift_per_min` (106.605) | 92.6 | 97.6 | 97.6 | **99.4** | **rising, now 93 % of limit** |
      | `tree_mb_drift_per_min` (165.233) | 120.9 | 127.1 | 126.2 | **129.0** | rising, 78 % of limit |
      | `jsheap_mb_drift_per_min` (16.386) | 8.7 | 13.3 | 12.9 | 11.9 | noisy, no trend |
      | `rx_gap_short_frac_worst` (0.041) | 0.003 | 0.017 | 0.004 | **0.120** | run 1 only; runs 2–3 at 0.002 |
      | `longtask_ms_per_s_mean` (12.600) | 0.000 | 0.000 | 0.000 | 0.000 | flat at zero |
      | `jank_fraction` (0.083) | 0.000 | 0.000 | 0.000 | 0.000 | flat at zero |
      | `flush_ms_max` (55.352) | 13.5 | 17.6 | 14.7 | 10.2 | flat / improving |

      **`renderer_mb_drift_per_min` is the metric to watch.** It has
      risen at every gate in this task and now sits 7.2 units under its
      limit; two more gates at this slope put it through. Nothing in
      these phases was attributed to it — phases 5, 6 and 7 each
      recorded the same shape and each concluded it predates the task —
      but four consecutive rises is a trend, and it will trip before
      anything else on this list.

## Consolidated closeout (2026-08-14)

**Branch chain**, each phase branched off the previous one, linear off
`batch-docs-closeout` (`c8de8a3`), never merged to main:

| phase | branch | tip |
| --- | --- | --- |
| — | `batch-docs-closeout` | `c8de8a3` |
| 1 | `task70-p1-quick-ui` | `7aede3d` |
| 2 | `task70-p2-state-persistence` | `a401542` |
| 3 | `task70-p3-blf-dialog` | `15b2534` |
| 4 | `task70-p4-plot-dropdowns` | `e40bcca` |
| 5 | `task70-p5-filebacked-signals` | `e66befa` |
| 6 | `task70-p6-enum-leading-edge` | `a7875c1` |
| 7 | `task70-p7-mdf-ingestion` | `d54ebbb` |
| 8 | `task70-p8-secure-defaults` | `3f38da9` |
| 9 | `task70-p9-servers-panel` | `e2f4ad8` |
| 10 | `task70-p10-closeout` | this phase's tip |

**Test counts at the tip:** frontend 158 files / 2090 tests; host
`cannet-gui` 640 / 6 ignored; `cannet-server` 118 / 2 ignored;
`cannet-client` 68; `cannet-mdf` 40. Workspace clippy clean. The task
added 2090 − 2042 = **48 frontend tests** and, on the host, `cannet-gui`
630 → 640 plus the new `cannet-mdf` and `cannet-server` coverage.

### (a) Owner decisions needed

| # | Decision | Where it came from |
| --- | --- | --- |
| 1 | **Perf gate: run 1 failed.** `rx_gap_short_frac_worst` 0.120 vs 0.041, with two runs either side at 0.002. Accept the two clean runs as the gate, or require an isolating re-run (warm cache, polling reintroduced alone) before the batch merges? | phase 10 |
| 2 | **`renderer_mb_drift_per_min` has risen at all four gates** and is at 93 % of its limit. Open a task for it, re-baseline, or keep watching? | phase 10 trend table |
| 3 | **Does the one-sample hline apply to a lane drawn _beside_ live series**, where it necessarily back-dates a held state 40 units before its only sample? Item 11 (a)'s ruling is satisfied as implemented; narrowing it would be diverging from a ruling. | phases 5 / 6 |
| 4 | **A lane's drawn extent is its axis's, not its own** — a lane whose message stopped is drawn 90 units past its newest sample, and (same decision) **enum lanes cannot show where their samples are**. Options recorded: (a) cut at the lane's last sample and accept the gap; (b) draw the held stretch differently; (c) cut after a multiple of the message's observed period. | phase 6, item 3 obs. 2 |
| 5 | **Item 3 observation 1 needs an owner check before it is a defect at all:** what is the `GenMsgCycleTime` of the balancing-state messages? A 6.7 s period is two thirds of the shipped 10 s follow window, which reproduces the reported magnitude from a correctly behaving pipeline. If they are slow, the open question is a product one — should a lane show its own sample cadence? | phase 6, item 3 obs. 1 |
| 6 | **Should a signal-only MF4 be importable?** Still rejected with `MdfSourceError::SignalFile`, so the Signals checkbox never gets a chance on a frameless file. Nothing in the live pass asked for it. | phase 7 |
| 7 | **Should a per-message decoded signal carry its value labels?** 39 of the sampled file's 139 decoded channels are enumerations whose text table is in the MDF; the code lands, the label is dropped at the seam. Two ways out recorded. | phase 7 |
| 8 | **Item 12's scope:** should `debug replay`/`debug vbus` also auto-enable TLS+token on a routable bind, or does ADR 0041's "production endpoint" scope stand? Implemented as the narrow reading. | phase 8 |
| 9 | **The pending-prompt drop's scope:** should a row stop carrying its pending question too, accepting that the identity-changed badge and the panel's re-raise go with it? Implemented as "a question never holds a row". | phase 9 |
| 10 | **Trusting from the Servers panel raises two identical dialogs** (pre-existing). Either the panel's dialog defers to the app-wide one and re-raising becomes "un-dismiss", or the app-wide one skips questions a panel is showing. Not verified against a running GUI — the phases forbid launching it. | phase 9 |

### (b) FYI — recorded, no decision asked

| # | Item | Where |
| --- | --- | --- |
| 1 | `close_project`'s re-root is exercised only through the frontend's mocked host; a real end-to-end test needs a command-level Tauri harness, which is its own work. | phase 2 |
| 2 | New project no longer stomps the previous project's layout snapshot — a behavior change nobody asked about, falling out of item 8's ordering. | phase 2 |
| 3 | The BLF map modal's markers disclosure had item 4's identical CSS defect. **Closed** in phase 3 (`b7f3d65`). | phases 1 / 3 |
| 4 | A blocked trace-open is silent by design: with the guard in place, invoking Import trace during a census does nothing, and the busy launcher is what says why. | phase 3 |
| 5 | The whole-capture follow window is expensive at 90 minutes (`longtask_ms_per_s` mean 95.4, `jank_fraction` 0.439 at a 5401 s window) — outside the gated scenario, unattributed, and superlinear in window length somewhere. | phase 6 rig |
| 6 | An embedded database is a session load, not a project file: it decodes and shows up, but is not persisted with the project, so reopening drops it until the capture is imported again. | phase 7 |
| 7 | A bus bound to an unaccepted server now reads "unknown server" rather than "not trusted" — wording nobody asked to change, both notices ending in the same place. | phase 9 |
| 8 | Exit criterion 4's stated yardstick does not hold on its own arithmetic (126.2 ms axis-to-axis vs a ~91 ms serve period); the criterion's substance does. Recorded in the exit-criteria walk. | phase 10 |
| 9 | Source still carries phase-number and `plans/` references that the working agreement forbids for the same reason task numbers are. All pre-date `batch-docs-closeout`; outside item 16's task-number scope, so left alone. | phase 10 |

Owner actions already standing from the batch, unchanged by this task:
merge to main (fast-forward), draft pre-release dispatch, palette PATH
re-run, and 0064's next-release verification checklist (`.pkg` exec
bits, the `.deb` `$auto` `Depends:` line, the NSIS CI-only legs, the
`.app`'s bundled `cannet-server` being `+x`).

### Owner rulings on the decision list (2026-08-14, closeout review)

1. **Perf gate run 1 + renderer-drift trend → follow-up task.** Both
   perf questions (isolating the run-1 `rx_gap_short_frac_worst`
   failure; attributing the four-gate `renderer_mb_drift_per_min`
   rise) are captured as
   [Task 71 — Perf Grooming](0071-perf-grooming.md). The gate stands
   on runs 2–3 for this task's closeout.
2. (Folded into ruling 1.)
3. **RULED (2026-08-14, third round, explicit confirm): extrapolated
   stretches render visibly as extrapolation.** Wherever a series is
   drawn beyond (or before) its actual samples — a held enum tile, a
   one-sample hline's both sides, any held line stretch — that
   stretch is rendered differentiated (dashed for lines; a
   muted/hatched treatment for lane tiles), while data-backed
   stretches keep the solid rendering. Nothing is cut; the
   information stays, honestly labeled. Styling specifics groomed in
   the follow-up task. **Owner refinement (same day): the cue is
   universal — anywhere the plot extrapolates, not just the hline
   and enum lanes — and the definition of an extrapolated section
   is testable:** (a) a section not bounded by a sample on each
   side is extrapolation; (b) a gap longer than **10× the series'
   typical sample interval** is extrapolation even between samples.
   Orchestrator's perf assessment, to be verified at task 72's
   gate: no major adverse impact expected — the classification is
   O(window points) beside a serve that is already O(window
   points) — with one design trap: the 10× test must be computed
   against the RAW series cadence host-side (the pyramid knows it),
   never against decimated serve spacing, or every coarse-zoom
   window would read as extrapolation.
4. **RULED — same ruling as 3**: it is the rule for lane extent too,
   superseding the three sketched options. The lane-marker
   visibility questions (density suppression, tile over-paint) ride
   along in the same follow-up scope.
5. **CLARIFIED (2026-08-14, third round) — the observation was
   misread by the investigation; item 3 obs. 1 is OPEN as a real
   defect with a sharper repro spec.** The owner was watching the
   **full trace as it grew**, not a short follow window: the enum
   lanes' leading edge fell behind by ~2/3 of the _whole-trace_
   window — reaching **hours** on a long capture — and "it can be
   observed on a live bus if you collect for long enough with
   enough signals." The cycle-time question was therefore
   meaningless (seconds-scale mechanism offered for an hours-scale
   observation). Constraints for the investigation: phase 6's rig
   run did NOT reproduce this at 5400 s / ~20 signals on the fixed
   build (drawn-vs-served 0.000, edge lag ms-scale), so the repro
   needs longer collection, more signals, the owner's real
   composition, or a consumer the rig's gauges don't measure.
   **Owner-suggested lead**: the proportional shortfall (a constant
   _fraction_ of the window, growing with it) smells like something
   consuming **relative index rather than timestamp** — e.g. an
   extent mapped from point count where sparse series cover only
   their fraction of the axis. Lands in the plot-rendering
   follow-up task as its investigation phase.
6. **Signal-only MF4s become importable** — lift the
   `MdfSourceError::SignalFile` rejection so the Signals checkbox
   gets its chance on a frameless file.
7. **Decoded enum channels should carry their value labels** —
   "yes, ideally"; pick between the two recorded ways out during
   implementation.
8. **Item 12's narrow scope stands** ("fine") — `debug replay` /
   `debug vbus` keep their `--insecure`; no further work.
9. **RULED (2026-08-14, second round): identity/token change on a
   passively discovered server is an indicator, not a modal.** The
   owner's actual objection: being shown a modal dialog because a
   known server's token/identity changed, when all that happened is
   the server was seen on the network and its interfaces couldn't
   be fetched — "a nuisance." Ruling: that state surfaces as an
   indicator in the project view and the Servers panel. A modal is
   appropriate only when the user directly attempts to connect and
   the trust question blocks that attempt. (The prompt fact on the
   row therefore survives — it is what feeds the indicator — but
   its presentation changes from dialog-driven to indicator-driven.)
10. **RULED (2026-08-14, second round): one dialog, used sparingly.**
    The duplicate is "absolutely a no." The Servers panel either
    uses the app-wide dialog (modal reserved for direct user input
    that needs it) OR offers inline editing on the row, paired with
    the ruling-9 indicators. No panel-owned second modal.

Where the ruled work lands (72–74 numbering pending owner
confirmation): the 3+4+5 clarification round decides the
plot-rendering follow-up's scope; rulings 6+7 one MDF follow-up
task; rulings 9+10 one trust-flow follow-up task (indicator-driven
trust surfacing, single dialog, modal only on direct connect).

## Blockers / side effects

- **The host command's re-root is exercised only through the
  frontend's mocked host.** `close_project` takes an `AppHandle`, and
  the GUI crate has no Tauri `App` test harness (`open_project` and
  `save_project_as` are untested at command level for the same
  reason). Its parts are covered — `project_dir::resolve(None, …)`,
  `ActiveProjectDir::set`, and `state.rs`'s scoped write routing — and
  the behavior is pinned by the two-project switch test, whose mock
  reproduces the host's scope routing. A real end-to-end test needs a
  command-level harness, which is its own piece of work.
- **New project no longer stomps the previous project's layout
  snapshot** — a side effect of item 8's ordering, recorded because it
  changes behavior nobody asked about. `seedDefaultLayout`'s layout
  change is persisted while `projectPathRef` still holds the previous
  project's path (the ref updates an effect later), so it used to be
  written into that project's `.cannet/state.json`. It now lands in
  the unsaved project's, because the re-root happens first. The stale
  `projectPathRef` read is still there; nothing depends on it beyond
  this.
- **Latent duplicate of item 4's bug, out of scope.** During item 4's
  investigation, `apps/gui/src/index.css`'s `.blf-map-markers-toggle`
  rule (BLF channel-map modal's "Markers (n)" disclosure) was found
  to have the identical defect: `width: 100%; text-align: left;`
  with no `justify-content: flex-start` override, so it inherits
  `.disclosure-toggle`'s `justify-content: center` the same way the
  project panel did. Not fixed here — item 4 is scoped to the project
  view — but it will visibly mis-center the same way if exercised.
  Left as a candidate for a future pass; the task file (not
  `plans/backlog.md`, per this phase's hard rules) is the record.
  **Closed 2026-08-14 in phase 3** (`b7f3d65`), fed forward into the
  phase that was already in that dialog.

- **The one-sample hline applies to enum lanes too** (phase 5 side
  effect, recorded for the phase that owns item 3). The item-11 (a)
  ruling says "a series with a single point" with no qualifier, and
  `mergeSeries` is shared by the numeric and the lane render paths, so a
  one-sample enum lane is now held across the window rather than
  starting at its own sample. That is the closest faithful reading of
  the ruling, but it does widen a lane's *drawn extent* in exactly that
  degenerate case, and item 3's second observation is about lane extent
  running ahead of served data. Narrow — it fires only at exactly one
  sample — but item 3's investigation should know it is there.
  **Ruled IN, phase 6, and left standing.** Measured: a one-sample lane
  (its sample at t=40) beside a live neighbour is drawn `[0, 100]` — 60
  units past its sample and, worse, **40 units _before_ it**, over
  ground where the leading `null` rule has always said a step signal
  has nothing to assert. Phase 5's own comment reasons about the case
  where the union collapses to one column; the `s.t.length === 1` branch
  fills unconditionally, so it fires on a lane axis whose other series
  supply plenty of columns. Not changed here: the owner's item-11 (a)
  ruling ("a series with a single point draws a horizontal line through
  that value") is satisfied exactly as implemented, and narrowing it to
  lone-series axes would be landing a divergence from a ruling.
  **Owner decision needed**: does the hline apply to a lane drawn
  _beside_ live series, where it necessarily back-dates a held state?

- **A lane's drawn extent is its axis's, not its own** (phase 6, item 3
  observation 2 — attributed, deliberately not changed). Measured: two
  enum lanes on one axis, lane 0's message stopping at t=10 while lane 1
  runs to t=100, and lane 0's last tile is drawn to **t=100 — 90 units
  past its newest sample**. `mergeSeries` sample-and-holds forward with
  no trailing `null` (only a leading one), and `enumSegments` ends its
  final segment at the last merged x column, which is the union over
  every series on the axis. Whether that is a defect is a **design
  question for the owner, not an implementation choice**: for a step
  signal that is still transmitting, holding the last state forward is
  the correct semantics and the reason the trailing hold exists at all —
  cutting every series at its own last sample would open a visible gap
  at the live edge on every slow signal beside a fast one. It is only
  dishonest where the message has _stopped_, and the render has no way
  to tell the two apart today. Options, if the owner wants it fixed:
  (a) end a lane's last tile at its own last sample and accept the gap;
  (b) draw the held-past-data stretch differently (hatched, faded) so it
  reads as "still held, not confirmed"; (c) cut it after some multiple
  of the message's own observed period, which the host already
  estimates. Not started — no ruling.

- **Enum lanes cannot show where their samples are** (phase 6, same
  investigation, same recommendation). The owner's alternative reading —
  "the point markers aren't rendering on enum signals" — is also true,
  by two independent mechanisms. In `auto` (the shipped default) uPlot's
  density rule measures the axis's merged column count, which on a lane
  axis over a long window is far past marking; and where markers do
  draw, `drawEnumTiles` runs in uPlot's `draw` hook, which fires
  **after** `drawOrder` has rendered the series, painting a
  0.65–0.75-alpha tile over the band the interior codes' markers sit in
  (the extreme codes' positions fall outside the central 60 % tile and
  stay visible, which is why the effect reads as inconsistent). So a
  lane that is drawing past its data also cannot say so. Fixing this is
  the same owner decision as the entry above.

- **A lane's leading edge is its message's cadence, and nothing in the
  view says which message a lane rides** (phase 6, the standing
  explanation for item 3's observation 1 — no change made). Measured:
  four lanes on one axis, the one whose message ticks every 6667 ms
  trails by 6.600 s while its neighbours sit 0.036–0.079 s _ahead_ of
  the live edge. That is correct behaviour at every seam, but it is
  indistinguishable, on screen, from the defect the owner reported —
  and as a fraction of the shipped 10 s default follow window a 6.7 s
  period _is_ two thirds. **Before treating item 3's observation 1 as a
  live defect, check the `GenMsgCycleTime` of the owner's
  balancing-state messages.** If they are slow, the open question is a
  product one (should a lane show its own sample cadence — markers, a
  tick strip, a per-lane "last seen" readout?), not a serve one.

- **The whole-capture follow window is expensive at 90 minutes**
  (phase 6 rig observation, outside the gated scenario). The 5400 s
  confirmation run held `follow_window_ms` at 6 000 000 so the window
  grew to the entire 5401 s capture over 22 signals — a regime the
  shipped defaults never enter, but Fit Data over a long capture does.
  It measured `longtask_ms_per_s` mean 95.4 / p95 340.1 / max 623 and
  `jank_fraction` 0.439, against 0.000 / 0.000 in the gated 10 s-window
  scenario. Not attributed and not this item's defect — recorded because
  it was measured and because task 63 phase 2 drove the same gauges to
  zero at 300 s, so the cost is superlinear in window length somewhere.

- **A blocked trace-open is silent, by design** (phase 3 side effect).
  With the guard in place, invoking Import trace from the palette or
  the Recent-captures list while a census is walking does nothing at
  all — no error, no queued open. The busy launcher and the status
  line are what say why, which is the point of strengthening them; but
  it is a behavior change nobody asked about, so it is recorded here.

- **A signal-only MF4 still cannot be imported** (phase 7, item 9,
  deliberately out of scope). A file with no bus-logging group at all is
  still rejected with `MdfSourceError::SignalFile`, from both
  `scan_mdf` and `MdfCanFrameSource::open`, so the dialog never opens
  for one and the Signals checkbox never gets a chance. The owner's
  example files all carry frames, and the ruling scopes the messages
  checkbox to "offered when frame groups exist" — which only says the
  checkbox hides, not that a frameless file imports. Lifting it means
  removing the `SignalFile` rejection (a documented deliberate
  behaviour, README and crate docs included) and giving the frames-less
  path a source-free open; that is its own change, and nothing in the
  live pass asked for it. **Owner decision**: should a post-processed
  measurement MF4 be importable for its signals?

- **An embedded database is a session load, not a project file**
  (phase 7 side effect). A DBC streamed out of a capture's `##AT` chain
  goes into the host's loaded set — so it decodes frames, and it shows
  up in the Database view and the signal catalog — but it is *not*
  added to the frontend's `dbcPaths`, and therefore not to the
  project's DBC list and not persisted with the project. That is
  deliberate: `dbcPaths` is persisted as project-relative file
  references (ADR 0030) and re-added through `add_dbc` on the next
  project open, which reads from disk; an identity like
  `<capture>#<name>.dbc` has no disk to read, so persisting it would
  guarantee an error on every reopen. The consequence is that the
  project panel's DBC list and the loaded set can differ after an MDF
  import, and closing/reopening the project drops the embedded
  definitions until the capture is imported again.

- **A per-message decoded signal arrives as raw codes with no labels**
  (phase 7, recorded because it is the visible half of a decision made
  during implementation). In the sampled file 39 of its 139 decoded
  channels are
  enumerations whose value-to-text table lives in the MDF's own
  conversion block. The import keeps the **code** — the alternative was
  dropping the sample, which lost the whole channel — but a file-backed
  signal has nowhere to carry a value table, so those lanes render as
  numbers where a DBC-backed enum would render its label. The
  information is in the file and is being thrown away at the seam. Two
  ways out if the owner wants the labels: give `FileSignal` a value
  table and teach the file-backed cache to carry one, or (narrower)
  match a file-backed signal against a loaded DBC by name. Neither is
  started — no ruling, and the ruling that exists is satisfied.

- **Item 12 was implemented as scoped to the production proxy only;
  `debug replay`/`debug vbus` keep their own, unchanged `--insecure`**
  (phase 8). The task's "current state" framing — `--tls` opts in,
  `--insecure` suppresses a refusal — describes `ProxyArgs` exactly,
  but `debug replay`/`debug vbus` never had a `--tls` flag: they
  terminate no TLS at all, by design (dev/test tooling), and their
  `--insecure` only ever suppressed the loopback-only refusal, never a
  choice about encryption. ADR 0041's Decision section states its
  scope explicitly — "Applies to the production cannet server's public
  endpoint" — so the closest faithful reading of "`--insecure` dies
  too" is the production endpoint's `--insecure`, not every
  `--insecure` in the binary. Auto-enabling TLS+token for the debug
  subcommands too was considered and rejected as an unscoped
  expansion: it would mean generating certificates and tokens for
  ephemeral BLF-replay and virtual-bus test tooling, which nothing in
  the groomed rulings, the task prompt, or ADR 0041 asks for. **Owner
  decision, if the broader reading was intended**: should `debug
  replay`/`debug vbus` also auto-enable TLS+token on a routable bind,
  bringing ADR 0041's coverage to every gRPC endpoint the binary can
  serve rather than just the production one?

- **The pending-prompt drop was read as "a question never holds a row",
  not "a row never carries a question"** (phase 9, recorded because it
  is a judgment call on a ratified ruling). What the ratification
  quotes as the presented behaviour is _"the unanswered trust question
  is what holds the row"_, and that is what was removed in full — no
  row source, no legacy path, nothing vestigial behind it.
  `ServerRow.prompt` stays, on rows that exist for their own reason,
  because two things ride it that the ruling does not touch and the
  store cannot supply: the **identity-changed badge**, which is a
  refused connection's observation (`server_list.rs`'s own module doc
  calls it the one state that cannot be read off the trust store), and
  the panel's **re-raise** of a question this window already dismissed
  (the app-wide dialog deliberately stops asking a dismissed one, so
  _Review identity…_ would otherwise have nothing to show). Removing
  the field would have deleted both, neither of which the owner
  dispositioned. **Owner decision, if the broader reading was
  intended**: should a row stop carrying its pending question too —
  accepting that the identity-changed badge and the panel's re-raise go
  with it?
- **A bus bound to an unaccepted server now reads "unknown server"
  rather than "not trusted"** (phase 9 side effect, recorded because it
  changes wording nobody asked about). `busServerTrust` distinguishes
  the two by whether the address has a row: with a pending prompt no
  longer minting one, a hand-typed address that was dialled and refused
  falls to `unknown` until it is accepted. Both notices name the
  address and send the user to the same place ("trust it in the Servers
  panel"), and both disappear the moment the identity is accepted.
- **Trusting from the Servers panel raises two identical dialogs**
  (phase 9, pre-existing, found by reading the code in scope and left
  alone). The panel renders its own `ServerTrustDialog` for the row's
  prompt while `App.tsx` renders `ServerTrustDialogs` over the same
  pending question, so a fresh question — one the window has not
  dismissed — is on screen twice, one modal over the other. The two are
  not redundant in general (the panel's is the only way to re-raise a
  question already waved away), which is why this is a design question
  rather than a deletion: either the panel's dialog defers to the
  app-wide one and re-raising becomes "un-dismiss", or the app-wide one
  skips questions a panel is already showing. **Not verified against a
  running GUI** — the phase forbids launching it — and not changed,
  because nothing in item 13 or the pending-prompt disposition touches
  it.

## Exit criteria (draft — firm at grooming)

- Item-0 verdict recorded (done: tauri dev at stack tip — all
  findings live).
- The completed task files removed per the item-1 deletion set.
- BLF/Import-trace open: dialog appears promptly or shows busy
  feedback within ~100 ms; reentrant invocations guarded (one
  dialog), both regression-tested.
- Enum leading-edge currency at long trace length measured; if the
  lag reproduces, root cause written up with data and fixed; enum
  and numeric leading edges within normal serve cadence of each
  other at the 5400 s reproduction length.
- Project-view label alignment restored with a guard test.
- Disclosure ink size resolved per owner grooming and applied via
  the shared component.
- Database title + palette alias verified correct on the current
  build (fixes if either reproduces).
- Recents verified project-scoped on the current build (fix if
  bleed reproduces).
- Item-9 dig-in complete: what MDF import ingests today vs should
  ingest is written up with data; the groomed checkbox design
  (signals default-on, CAN messages opt-in) implemented (or split
  to its own task with owner sign-off if it outgrows this one).
- Item 10: plotting an imported MDF file-backed signal renders its
  points, and its values appear in the Database view's values mode;
  root cause recorded with the attributing experiment and guarded
  by a regression test.
- Item 11: a single-point series renders as an hline through its
  value; auto marker mode keeps markers below the documented
  minimum point count. Both regression-tested.
- Item 12: a routable bind serves TLS+token with no flags; `--tls`
  (and `--insecure`, per the recorded reading) are gone; `--no-tls`
  serves in the clear; loopback plaintext by default. Tested at the
  guard seam.
- Item 13: two servers with the same instance name are always
  distinguishable in the Servers panel and connection combo
  (DNS/IP/fingerprint), with a test forcing the collision.
- Item 14: chronological frame rows expose `aria-expanded`; the
  decorative caret is gone; DOM-tested.
- Item 15: the plot's points-mode and cursor-type dropdowns take
  clicks with the measurement line active, regression-tested.
- Pending-prompt disposition (ratified): a dismissed trust prompt
  drops the row; panel = discovered + trusted; tested.
- Item 16: no task-number references remain in source comments
  (plans/ excluded); each replaced with an ADR citation or the
  inline reason.

## Exit-criteria walk (2026-08-14, phase 10)

Every criterion above walked against the **code at the branch tip**,
not against the status log: each artifact was grepped for and each
suite re-run. Nothing is waived here — anything not cleanly met is
recorded as awaiting the owner.

| # | Criterion | Verdict | Evidence checked at the tip |
| --- | --- | --- | --- |
| 1 | Item-0 verdict recorded | **MET** | § "Investigation item 0 — RESOLVED": owner refuted the stale-build hypothesis; every finding treated as live. |
| 2 | Completed task files removed (item-1 deletion set) | **MET** | `plans/tasks/` holds none of `0038`, `0041`–`0043`, `0063`–`0068`. Removed in `c8de8a3`, i.e. already absent at `batch-docs-closeout`, so no phase of this task had anything to delete — verified with `git ls-tree batch-docs-closeout plans/tasks/`. |
| 3 | Import-trace: prompt feedback + reentrancy guard, both regression-tested | **MET** | `85ccba6`. Guard + 7 tests in `App.importTraceGuard.dom.test.tsx`. Feedback is synchronous: `App.tsx` sets `scanningBlfPath`/`scanningMdfPath` on the line after the picker returns and before the scan is awaited, so the busy launcher (`aria-busy` "Scanning…") and the `trace-scan-bar` chip are up on the same tick — inside ~100 ms by construction, not by measurement. Latency itself measured and cleared in `32b238b` (~83 MB/s release: 0.716 s at 46 MB, 5.926 s at 470 MB) with the rustdoc's stale figure corrected. |
| 4 | Enum leading-edge currency measured; fixed if it reproduces; enum and numeric edges within normal serve cadence at 5400 s | **MET WITH DEVIATION** | Measured (phase 6, experiments A–D); the reported signature did **not** reproduce — the enum lanes were the most current series on the panel and the _numeric_ serve was the laggard. That lag was real and is fixed in `cc8c1f7` (both reductions read through `level_points`), test-first. **Deviation, recorded rather than waived:** the criterion's comparison clause is not met on its own arithmetic. The measured axis-to-axis gap at 5400 s is 126.2 ms (enum mean −39.3 ms vs numeric-`V` mean +86.9 ms; worst-max-to-worst-max 160.0 ms) against a ~91 ms period for the ~11 Hz serve loop — about 1.4 serve cadences, where the phase-6 log reads "comfortably inside one serve cadence." The gap **is** inside the `V` axis's own 200 ms `GenMsgCycleTime`, which is what phase 6 attributed it to ("currency tracks the message, not the axis kind"), so the criterion's _substance_ holds and only its stated yardstick does not. No re-measurement was run to settle it. |
| 5 | Project-view label alignment restored with a guard test | **MET** | `23576db`. `index.css:1553` `.project-panel .project-section-toggle` carries the `justify-content: flex-start` override; guarded by the declared-CSS test in `ProjectPanel.collapse.dom.test.tsx`. |
| 6 | Disclosure ink resolved per owner grooming, applied via the shared component | **MET** | `7e43d1a`. One shared rule, `index.css:2373` `.disclosure-toggle-glyph { font-size: 1.1rem }` — no per-site override anywhere; `DisclosureToggle.dom.test.tsx` asserts the new size. |
| 7 | Database title + palette alias verified on the current build | **MET** | Both reproduced and were fixed. Title: `b6bc70c` — `SINGLETON_PANEL_TITLES` / `normalizeSingletonTitles` (`dockLayout.ts:99,123`) called on both restore paths (`App.tsx:1704`, `App.tsx:2677`), mechanism pinned in `dockLayout.dom.test.ts`, wiring in `App.bootReopen.dom.test.tsx`. Palette: `4231d4f` — `keywords` carried onto the _view_ entry and through `gotoPaletteItems` (`useCommands.tsx:699,738`). |
| 8 | Recents verified project-scoped, fixed if the bleed reproduces | **MET** | Reproduced, two carriers, both fixed: `bde1211`. `App.recentsScope.dom.test.tsx` replays the owner's sequence; host side pinned by `leaving_a_project_lands_on_the_unsaved_directory_not_the_projects`. |
| 9 | Item-9 dig-in written up with data; groomed checkbox design implemented | **MET** | Stage-1 census recorded in the phase-7 log (14 files, three content shapes, the 39 range-to-text channels that decoded empty). Implemented across `830293a`, `aa7aaff`, `01155ff`; end-to-end re-verified on the owner's corpus (172 census signals → 172 filled, `empty = 0` across all fourteen files). Not split to its own task. |
| 10 | File-backed signal plots its points and shows values in the Database view; root cause recorded; regression-tested | **MET** | Two distinct defects, each with its attributing experiment. Plot: `2da09d6` — `PlotArea.tsx:1436` now carries `fileBacked` on the window fetch as the sidecar query already did. Database: `852fec8` — `valueColumnKey` / `valueColorTarget` / `recordSignalKey` in `DatabasePanel.tsx` answer for both provenances. |
| 11 | Single-point series renders as an hline; auto markers keep a documented minimum point count; both regression-tested | **MET** | `c761298` (one-sample hold in `mergeSeries`, 5 unit + 1 panel test) and `027b665` (`AUTO_POINT_MARKER_FLOOR = 32`, `plotPoints.ts:60`, documented there and in ADR 0026, 4 unit + 1 DOM test). **Note, not a deviation:** the hline's behaviour on an enum lane sitting beside live series is an open owner decision (see Blockers) — the ruling as written is satisfied. |
| 12 | Routable bind serves TLS+token with no flags; `--tls`/`--insecure` gone; `--no-tls` serves in the clear; loopback plaintext; tested at the guard seam | **MET WITH DEVIATION** | `428867f`, `05bf20d`, `8b41cef`. All four guard-seam cells tested; `main.rs:1018–1022` asserts `--tls` is rejected, and the same for `--insecure`, on the production proxy. **Deviation:** scoped to the production proxy — `debug replay` / `debug vbus` keep their own pre-existing `--insecure`, per ADR 0041's stated scope. Recorded in the phase-8 scope note and standing as an owner decision under Blockers. |
| 13 | Two same-named servers always distinguishable in panel and combo, with a test forcing the collision | **MET** | `b5e58af`. `serverLabels()` (`serverList.ts:198`) consumed by `ConnectionManagement.tsx:387`; 4 unit tests over the rule plus a DOM test per surface forcing the collision. The panel already separated them by address and is pinned by test rather than restyled. |
| 14 | Chronological frame rows expose `aria-expanded`; decorative caret gone; DOM-tested | **MET** | `545c91c`. `TraceView.tsx:400,726`; `isExpanded` no longer appears anywhere in `traceTable.tsx` (grep clean), so the caret is gone from both trace surfaces; 3 DOM tests in `TraceView.signals.dom.test.tsx`. |
| 15 | Points-mode and cursor-type dropdowns take clicks with the measurement line active, regression-tested | **MET** | `9ae99df`. Fixed at the shared seam — the `Combobox` popup's `onMouseDown` stops propagation — with the attribution showing the measurement line was never involved. Covered in `Combobox.dom.test.tsx` and by `PlotPanel.dom.test.tsx` cases driven with measurements enabled; `pickCombobox` now fires the press, so every other suite exercises the seam too. |
| 16 | Pending-prompt disposition: dismissed prompt drops the row; panel = discovered + trusted; tested | **MET WITH DEVIATION** | `029125e`. `merge`'s pending-row source removed outright; `an_unanswered_question_is_not_a_row` (`server_list.rs:658`) replaces the old test. **Deviation:** read as "a question never holds a row" rather than "a row never carries a question" — `ServerRow.prompt` survives on rows that exist for their own reason, carrying the identity-changed badge and the panel's re-raise. Standing as an owner decision under Blockers. |
| 17 | No task-number references remain in source comments (plans/ excluded) | **MET** | `cb88094`, re-verified at this tip: `git grep -niE "task[- ]?[0-9]+" -- apps crates examples servers` returns **zero** hits (`servers/` swept too, beyond the original scope). |

**Out-of-scope drift noticed during the item-17 re-sweep, recorded not
fixed.** Source still carries _phase_-number and `plans/` references,
which the working agreement forbids for the same reason task numbers
are forbidden: `crates/cannet-blf/Cargo.toml:12,21`,
`crates/cannet-dbc/src/calc.rs:25`, `crates/cannet-mdf/Cargo.toml:13`,
`crates/cannet-server/src/auth.rs:42`, `apps/gui/src/index.css:1136,3992`,
`apps/gui/src/DatabasePanel.tsx:263`, `apps/gui/src-tauri/src/tests.rs:1907`,
and several under `servers/cannet-python-can/`. Every one of them is
present at `batch-docs-closeout` (verified by grepping that ref), so
none was introduced by this task, and item 16's criterion is about
task numbers specifically. Left alone rather than swept, since this
phase's rule is no drive-by changes.
