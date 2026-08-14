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
