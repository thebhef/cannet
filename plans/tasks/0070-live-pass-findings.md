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
