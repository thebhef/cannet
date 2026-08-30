# 0114 — One Name Per Thing

> **Status 2026-08-25 — groomed with the owner.** Queue items **1.37,
> 1.33b and 1.17**, from the 2026-08-24 walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 1. Fully ruled 2026-08-25; no
> open questions. No phases yet.

The chrome says one thing where the model says another. **1.37 is the
mechanism and the other two are its symptoms**, so this is one pass rather
than three string edits.

## 1. The commands are the model; the chips are a rendering · 1.37

> *"we basically* do have *a list of commands that gets rendered - that was
> the original shape, we've just added status and a different frontend
> rendering."*

That is what the code does:
[`commands.ts:1-9`](../../apps/gui/src/commands.ts#L1-L9) is a declared
50-command registry (ADR 0018) and every chip dispatches an id from it.
**The divergence is that a command carries two labels** — the chip table at
[`Toolbar.tsx:116-159`](../../apps/gui/src/Toolbar.tsx#L116-L159) declares
its own label, icon and tooltip rather than deriving anything, so
`project.new` is *New project* in the palette and **New** on the bar.
Nothing makes them agree, which is how 1.33b went stale.

**Work:** amend ADR 0055 to say what the owner said — the command list is
the model, the chip bar one rendering of it. **Optional, separable:**
declare the chip label beside the palette label so the two cannot drift
again.

## 2. The toolbar chip reads "DBC" · 1.33b

The DBC → Database rename was made everywhere else — panel title at
[`dockLayout.ts:133`](../../apps/gui/src/dockLayout.ts#L133), palette entry,
and a `normalizeSingletonTitles` migration for saved layouts pinned at
[`dockLayout.dom.test.ts:94-100`](../../apps/gui/src/dockLayout.dom.test.ts#L94-L100).
One chip is the straggler.

**Work:** label → `Database`. ~~Keep the tooltip *Add DBC…* and the
palette entry, which name the file format.~~ **Superseded by § 4
(owner, 2026-08-27):** the chip's job changes, not just its label.

## 4. The Database chip shows the view; opening a file lives in the project panel

> **Owner, 2026-08-27:** *"the database button to show the database
> view belongs in the project toolbar. The 'open database' button
> doesn't - that should only live in the project panel."*

The top bar's database chip becomes **show the Database view**
(open/focus the panel), named `Database`. The add/open-a-DBC-file
action leaves the top bar and lives only in the project panel — verify
it is reachable there today; if it is not, it gains a control there in
the same change. The palette keeps both commands (the palette is the
full command list; the bar is a curated rendering — § 1).

## 3. The virtual-bus adapter cell reads "bus" · 1.17

> *"the 'adapter' is just reported as 'bus', not blank. 'virtual bus' would
> be better."*

**The owner was right and the original finding was wrong.** The cell at
[`BusHealthPanel.tsx:136-145`](../../apps/gui/src/BusHealthPanel.tsx#L136-L145)
renders `adapter` then `applied`; the finding described `applied`. It reads
"bus" because the adapter lookup at
[`busHealth.ts:141-145`](../../apps/gui/src/busHealth.ts#L141-L145) falls
back to `binding.interface` when no interface matches, and every local-vbus
binding carries `LOCAL_VBUS_INTERFACE = "bus"`
([`types.ts:274`](../../apps/gui/src/types.ts#L274)) — a wire id reaching
the screen.

**Ruled 2026-08-25 — the generic string, not the bus's name:** *"this is
the hardware column. We already have the user's bus name on the same row."*
Column 1 is `{row.name}`
([`BusHealthPanel.tsx:112`](../../apps/gui/src/BusHealthPanel.tsx#L112));
the column in question is headed **Adapter**. Repeating the name there
would say nothing, and the honest answer to "what hardware is behind this
bus" is that there is none.

**Work:** a local-vbus binding renders `virtual bus` in the adapter cell.
No vbus list is consulted — the fix is at the fallback, not in the lookup.
`busHealth.ts`'s comment claiming the fallback matches the project panel is
wrong and goes with it.

## Exit criteria

1. **ADR 0055 says the command registry is the model and the chip bar one
   rendering of it**, amended in the same commit as any code change.
2. **The toolbar chip reads `Database`**, tooltip and palette entry
   unchanged, test table updated with it.
3. **A virtual bus's Adapter cell reads `virtual bus`**, not
   `LOCAL_VBUS_INTERFACE`, pinned by a test; the bus's own name still
   appears in column 1 and is not duplicated.
4. **If the optional leg lands**, a test pins that the bar derives its
   labels rather than declaring them.
5. **The top bar's `Database` chip opens/focuses the Database view;
   no top-bar control opens a DBC file; the project panel carries the
   open-database action** — each pinned by a test.
6. **Queue rows 1.37, 1.17 and 1.33b struck** with the date — or,
   the queue having since been drained (2026-08-26), their closures
   recorded in this file's status log instead.
7. **Full CI green** — seven jobs, each named with its command.

## Status log

### 2026-08-27 — the whole task, one phase (`task-114-one-name`)

All four sections landed together, on the branch’s single commit off
`task-117-unbound-bus-refusal` (6d7a384d). **The optional derive-labels
leg was taken** — reasoning below.

| § | What landed |
|---|---|
| 1 | ADR 0055 gains §4, *The command registry is the model; the chip bar is one rendering of it*; old §4 (combining) renumbers to §5 |
| 1 (optional) | `CommandSpec.bar` carries the bar’s words beside the palette’s; `Toolbar.tsx` derives label and tooltip from the registry |
| 2 | The bar’s Database control reads `Database` |
| 3 | A local-vbus binding renders `virtual bus` in the Adapter cell |
| 4 | The `dbc.add` chip leaves the bar; the surviving chip dispatches `panel.show.dbc` |

**The optional leg: taken.** §1 calls it separable, and the argument
for leaving it was that the bar’s word and the palette’s phrase are
deliberately *different* strings (ADR 0055 §3), so nothing can be
mechanically derived from one to the other. That argument is against
*deriving*, not against *co-locating*, which is what §1 actually asked
for. The defect it addresses is concrete rather than hypothetical: the
DBC → Database rename reached the panel title, the palette entry and
the saved-layout migration, and missed the chip, because the chip’s
label lived in a table nobody editing `commands.ts` would look at.
`CommandSpec.bar` puts both strings under one hand without merging
them. It also makes the new ADR §4 true of the code rather than only
of the intent, which CLAUDE.md’s doc-vs-code rule would otherwise
leave inconsistent.

**§4’s “verify it exists there”: it does.** The project panel’s DBC
section has carried an **Add…** button (`p.onAddDbc`,
`ProjectPanel.tsx`) all along, on an empty project as well as a
populated one — no control had to be added, only pinned.
`ProjectPanel.databases.dom.test.tsx` is that pin, and is deliberately
the other half of `Toolbar.dom.test.tsx`’s “opens no database file
from the bar”: removing a control from the bar is only safe while the
action is still reachable.

**The project panel’s section keeps the title “DBC”.** It looked like
a fourth straggler of the same rename, but ADR 0052 §3 rules the other
way: only the *panel-level surface* is format-neutral, and operations
on one format still name it (“Add DBC…” is the ADR’s own example).
That section lists DBC files and adds DBC files. Left alone.

**Consequential doc/prose fixes**, all in the same commit: the
Database panel’s empty state pointed at “the toolbar’s *Add DBC…*”,
which no longer exists, and now points at the project panel; the README
paragraphs for the toolbar chips, the first-run `tauri dev` walkthrough
and the bus-health Adapter column follow the new behaviour;
`busHealth.ts`’s comment claiming the adapter fallback matched the
project panel was wrong and went with the fix.

**Exit criteria.** 1 ✓ (ADR 0055 §4). 2 ✓ (`Toolbar.dom.test.tsx`’s
`BAR` table; tooltip *Database panel* and palette *Show Database
panel* both unchanged). 3 ✓ (`busHealth.test.ts` “says a virtual bus
has no hardware…” asserts the cell reads `virtual bus` and is *not*
the bus’s name; `BusHealthPanel.dom.test.tsx` asserts the rendered
cell). 4 ✓ (“draws each chip with the words its command declares” and
“takes the Add menu’s words from the registry too”). 5 ✓ (“shows the
Database view from the bar, and opens no database file from it”, plus
`ProjectPanel.databases.dom.test.tsx`). 6 — **criterion mismatch, per
the fallback it names**: the queue was reframed 2026-08-26 into an
acceptance checklist with no numbered rows, so items 1.37, 1.33b and
1.17 no longer exist to strike. Following tasks 115 and 117, their
closures are recorded here and a `114` row was added to the
checklist’s Acceptance list. 7 ✓ — table below.

**Tests.** Frontend suite 223 files / 3043 tests, all passing (6 tests
added: 2 bus-health, 2 toolbar-derivation + 1 toolbar behaviour, 2
project-panel; net of the removed chip row). Every new test was
watched failing against the unmodified source first.

**CI — full local run, all seven jobs**

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | pass (no match) |
| frontend | `pnpm --dir apps/gui test` → `pnpm --dir apps/gui build` | pass — 3043 tests; build OK |
| python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`, `uv run pytest` | pass |
| rust | `cargo test --workspace` → `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample` → `validate_export.py` | pass |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass |

No perf capture and no NSIS bundle: both stood down for this phase by
the overseer — the phase touches no render hot path and the render
harness is under repair.

## Blockers / side effects

- **None blocking.** One consequence worth naming: the `db-add` icon
  is now unreferenced by any view. It is left in `Icon.tsx`’s registry
  — that registry is a shared icon set rather than dead code created
  by this change, and the project panel’s **Add…** button is an
  obvious future user of it.
