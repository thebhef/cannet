# Task 74 — Trust-Flow Rework: Indicators First, One Dialog

Opened by owner rulings 2026-08-14 out of Task 70's closeout review
(items 9 and 10 of 0070's decision list, ruled in the second round).
Builds on Task 70 phase 9 (pending-prompt rows removed; panel =
discovered + trusted).

## The rulings

1. **Identity/token change on a passively discovered server is an
   indicator, not a modal.** Seeing a known server on the network
   and failing to get its interfaces because its token/identity
   changed must not raise a dialog — "a nuisance." That state
   surfaces as an indicator in the **project view** and the
   **Servers panel** (the row's prompt fact, which already carries
   the identity-changed observation, feeds it). A modal is
   appropriate only when the user **directly attempts to connect**
   and the trust question blocks that attempt.
2. **One dialog, used sparingly.** The duplicate-dialog defect
   (Servers panel and app-wide `ServerTrustDialogs` each rendering a
   modal over the same question) is "absolutely a no." The panel
   either invokes the single app-wide dialog — modal reserved for
   direct user input that needs it — **or** offers inline editing on
   the row, paired with the ruling-1 indicators. No panel-owned
   second modal.

## Grooming rulings (2026-08-14, cycle grooming)

- **No sidecar row.** The app's own python-can sidecar session must
  not appear as a Servers-panel row at all (owner ruling, resolving
  task 75 phase 3's recorded side effect: `server_list::merge`'s
  live-session source minted `trusted | not advertising |
  127.0.0.1:<ephemeral>` from the sidecar's per-launch listen
  socket). The panel lists user-managed servers; the sidecar is an
  implementation detail. Suppress the row at the merge source —
  identified by the session being the app's own spawned sidecar,
  not by loopback address (a user's own loopback server stays
  listable) — and retire the phase-3 README/UI wording that
  explains the row once it can no longer appear.

- **Panel shape: row affordance → the one app-wide dialog.** No
  inline editor. The indicator (project view + panel row) carries
  the passive identity/token-change state; a row's "Review
  identity…" affordance is direct user input, so it raises the
  single app-wide dialog. The re-raise path is the indicator
  itself — it opens the same dialog.

## Scope notes

- The re-raise path ("Review identity…" on a row after the question
  was dismissed) must survive in some form — under ruling 2 it
  becomes either an un-dismiss of the app-wide question or an inline
  affordance; groom the choice.
- Wording side effect recorded in Task 70 phase 9 (a refused
  hand-typed address reads "unknown server" rather than "not
  trusted") can be reconciled here if the indicator work touches the
  same notices.

## Exit criteria (draft — firm at grooming)

- A token/identity change on a discovered-but-not-connecting server
  raises no dialog; the indicator appears in both the project view
  and the Servers panel; DOM-tested.
- A direct connect attempt blocked by a trust question raises
  exactly **one** dialog; the duplicate is impossible by
  construction (one dialog implementation, one mount), tested.
- Dismissing that dialog leaves the indicator (not nothing), and the
  user can act on it later from the panel; tested.
