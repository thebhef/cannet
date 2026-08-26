# 0120 — Group I Cleanups

> **Opened 2026-08-25** from the owner's walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 3 group I. Four
> findings that needed work; the other seven closed with none. Fully
> ruled; no open questions.

Unrelated to each other beyond being small and settled — one task rather
than four so they land in one reviewable commit.

## 1. Delete the stale "Phase N" labels · 3.3

**Ruled:** *"can't we just remove the stale labels?"* Yes.

Six sites naming an older numbering scheme that means nothing now: five
in [`index.css`](../../apps/gui/src/index.css) and one in
[`crates/cannet-blf/Cargo.toml`](../../crates/cannet-blf/Cargo.toml). They
name no task and point at no `plans/` path, so both the rule and the CI
lint pass them — they are simply stale.

**Work:** delete the labels. Where one is the only thing explaining a
block, state the reason inline instead.

## 2. Fix the rustdoc warnings and gate them · 3.5

**Ruled:** *"fix it, add to pre-commit."*

`cargo doc -p cannet-gui` emits **47 warnings** — unresolved links, public
docs pointing at private items. All pre-existing; none from this chain.

**Work:**

- Fix all 47.
- Add a rustdoc hook to
  [`.pre-commit-config.yaml`](../../.pre-commit-config.yaml), matching the
  file's own convention: `repo: local`, `language: system`, and a comment
  saying what it leaves to CI.
- **Add it to the CI workflow too**, and to the gate list both agent
  skills run by hand — [`implement-phase`](../../.claude/skills/implement-phase)
  and [`oversee-roadmap`](../../.claude/skills/oversee-roadmap). Agents
  commit with `--no-verify` in a shared tree and run the gates
  themselves, so a hook alone would not reach them.

Use `-D warnings` so the count cannot creep back.

## 3. Make a Cancel during the MDF open effective · 3.11

**Ruled:** *"can we cache the cancel request for when it's effective?"*
The plumbing already caches it.

`census_mdf` publishes its `Arc<AtomicBool>` to `state.import_cancel()`
**before** calling `scan_mdf_cancellable`
([`capture.rs:2123-2125`](../../apps/gui/src-tauri/src/capture.rs#L2123-L2125)),
so a Cancel pressed during `Mdf4File::open` already sets the flag. Nothing
reads it until the walk's first checkpoint, which is after the open
returns — so the press is swallowed.

**Work:** check the flag in `scan_mdf_cancellable` immediately after the
open and before the walk, returning `ScanOutcome::Cancelled`. A test that
sets the flag before the scan starts and asserts the outcome.

**Explicitly still accepted:** the progress bar does not move during the
open. Reporting progress there means restructuring how every MDF is read,
which this does not do. Only the Cancel becomes effective.

## 4. Delete `NotesStore::linked_events` · 3.33

**Ruled:** *"agree, delete."*

Two phases without a caller. The free `linked_event_ids` it delegates to
has a production caller and states the same contract.

**Work:** delete the wrapper and any test that exists only to cover it.

## Exit criteria

1. **No "Phase N" label remains** under `apps/` or `crates/`.
2. **`cargo doc -p cannet-gui` is warning-free**, gated in pre-commit, in
   CI, and in both skills' hand-run gate lists.
3. **A Cancel pressed during an MDF open lands**, pinned by a test.
4. **`NotesStore::linked_events` is gone** and the workspace builds.
5. **Queue rows 3.3, 3.5, 3.11 and 3.33 struck** with the date.
6. **Full CI green** — with the new rustdoc job, seven.
