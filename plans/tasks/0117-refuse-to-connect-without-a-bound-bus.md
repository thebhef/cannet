# 0117 — Refuse to Connect Without a Bound Bus

> **Opened 2026-08-25** at the owner's instruction — *"loud fail. capture
> new task."* — from queue item **1.34**, out of the 2026-08-24 owner walk
> of [`owner-review-queue.md`](../owner-review-queue.md) § 1. Fully ruled;
> no open questions.

**Ruled:** *"we should refuse to connect if there's no busses in the
project, or if there's no interface assigned to the bus. We should also
default to there being one bus in a project."*

| | State today |
|---|---|
| No buses at all | **already refused** — but by the empty-binding-list guard, which tells the user to add a *binding* when what is missing is a *bus*. A message fix. |
| A bus with no interface | **the real gap.** The guard tests the list, not each bus, so any unbound bus in a multi-bus project is silently dead. `handleConnect` already has `buses` and a `busName` helper in scope. |
| A new project has a bus | **missing** — `handleNewProject` sets `setBuses([])`. |

## Work

- **Loud fail, per bus** — ruled 2026-08-25, over a disabled Connect.
  Consistent with the existing guard, and it can name the offending bus.
- **The empty-project message names the missing bus**, not a binding.
- **A new project starts with one bus, named `Bus 1`** — matching the
  existing Add bus control, which already names them
  `` `Bus ${buses.length + 1}` `` at
  [`ProjectPanel.tsx:442`](../../apps/gui/src/ProjectPanel.tsx#L442).

## Exit criteria

1. **Connecting with any unbound bus fails loudly and names it**, pinned
   by a test.
2. **The empty-project refusal names the bus**, pinned by a test.
3. **A new project has one bus called `Bus 1`**, pinned by a test.
4. **Queue row 1.34 struck** with the date.
5. **Full CI green** — six jobs, each named with its command.

## Evidence

[`App.tsx:1646-1652`](../../apps/gui/src/App.tsx#L1646-L1652) (the guard),
[`:1688-1689`](../../apps/gui/src/App.tsx#L1688-L1689) (`buses` and
`busName` in scope), [`:2071`](../../apps/gui/src/App.tsx#L2071)
(`handleNewProject`).

## Status log

- 2026-08-27: Implemented. `unboundBusError` (new, in
  `apps/gui/src/connectionStates.ts`) is the pre-flight guard: `null`
  when every bus carries a binding, else a message naming what's
  missing — "No buses in the project…" for an empty project, or "No
  interface bound for `<names>`…" for the buses that lack one.
  Unit-tested in `apps/gui/src/unboundBus.test.ts` (empty project, all
  bound, one unbound among two, none bound) — written first, watched
  fail with `unboundBusError is not a function`, then made to pass.
  `handleConnect` (`apps/gui/src/App.tsx`) now calls it in place of the
  old `interfaceBindings.length === 0` check, which read "add a
  binding" even when the real problem was "add a bus" (exit criterion
  2), and which never looked at buses individually — a bus left
  unbound in an otherwise-bound project connected as if nothing were
  missing (the real gap the task opened over, exit criterion 1).
  `handleNewProject` now seeds `buses` with one `{ id: "b1", name: "Bus
  1" }` instead of `[]` (exit criterion 3), matching the id/name scheme
  `ProjectPanel.tsx`'s own Add bus button already uses.
- 2026-08-27: Added `apps/gui/src/App.unboundBusRefusal.dom.test.tsx`,
  driving the real `App` rather than the pure function alone, since the
  point of exit criteria 1 and 3 is that the guard and the default are
  actually wired in. One test opens a two-bus project with only one
  bus bound, clicks the connection chip (live, since one bus is bound),
  and asserts the connect never reaches `connect_remote_server` and the
  status bar names the unbound bus and not the bound one. The other
  drives New project and asserts exactly one `.project-bus-row` reading
  `Bus 1`. Both were confirmed to fail before their corresponding fix
  (temporarily reverted each `App.tsx` change in turn and re-ran the
  test, then restored it) rather than trusted to have failed first.
- 2026-08-27: Queue row 1.34 could not be struck as written — see
  Blockers below for what was done instead.
- 2026-08-27: Full CI green, seven jobs (see table below; the sixth job
  this task file expected has become seven since it was drafted —
  `rustdoc` joined the workspace gate independently of this task).

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | green |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | green |
| rust | `cargo test --workspace` then `cargo clippy --workspace --all-targets -- -D warnings` | green |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <path>` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <path>` | green |
| frontend | `pnpm --dir apps/gui test` then `pnpm --dir apps/gui build` | green |
| python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`, `uv run pytest` | green |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | green |

## Blockers / side effects

- Exit criterion 4 ("Queue row 1.34 struck with the date") is stale the
  same way [task 115](0115-trace-row-menu-scope.md) found:
  `plans/owner-review-queue.md` was reframed 2026-08-26 from a numbered
  queue into a plain acceptance checklist keyed by task number, with no
  "1.34"-style row left to strike. Closest faithful reading, matching
  115's precedent: added a `117` row to that file's `## Acceptance`
  list, so it's picked up on the next owner walk.
- Exit criterion 5 says "six jobs"; `.github/workflows/ci.yml` now
  lists seven — `rustdoc` was added independently of this task. Ran
  and reported all seven rather than only the six named in the
  criterion.
