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

## Exit criteria (firm)

- A token/identity change on a discovered-but-not-connecting server
  raises no dialog; the indicator appears in both the project view
  and the Servers panel; DOM-tested.
- A direct connect attempt blocked by a trust question raises
  exactly **one** dialog; the duplicate is impossible by
  construction (one dialog implementation, one mount), tested.
- Dismissing that dialog leaves the indicator (not nothing), and the
  user can act on it later from the panel; tested.
- The sidecar row can no longer appear; tested at the merge source, and
  its explanatory wording retired.

## Status log

### 2026-08-15 — the single phase (`task74-trust-flow`, off `task73-p2-enum-labels`)

Five commits. Baselines at the branch point: frontend **163 files /
2200 tests**, host `cannet-gui` **668 passed / 6 ignored**.

**`728dd93a` fix(gui): the app's own sidecar is never a Servers-panel
row** — grooming ruling 3.

- _What minted the row._ `merge`'s live-session source
  (`for key in clocks.keys() { rows.entry(key).or_insert_with(…) }`)
  is the only one that knows the sidecar's address: it advertises
  nowhere and stores nothing, so a bus bound to local hardware dialling
  `127.0.0.1:<ephemeral>` was what put it in the list.
- _Fix._ `merge` takes `sidecar: Option<&str>` and removes that key
  **last**, after every source has had its say, so nothing can slip one
  back in. The address comes from `sidecar::bound_address(app)` — the
  supervisor's own record of the port the OS handed this launch, which
  is the only thing that can tell "our child" from a server at some
  loopback address. Matched through `server_key`, like every other
  address in the merge.
- _Not by loopback, per the ruling._ A user's own `--bind 127.0.0.1`
  proxy stays listed; the test that pins this
  (`a_users_own_loopback_server_is_still_a_row`) would fail under an
  address-shape check.
- _Test-first, watched red._ The three new host tests failed to compile
  against the old five-argument `merge` (`unexpected argument #5`).
  `a_live_session_against_a_loopback_sidecar_mints_a_trusted_row_storing_nothing`
  — task 75's attribution test, which asserted the row exists — was
  replaced by `the_apps_own_sidecar_session_is_never_a_row`,
  `a_users_own_loopback_server_is_still_a_row`, and
  `the_sidecar_is_matched_the_way_the_store_keys_an_address`.
- _Wording retired._ README's paragraph explaining the
  `127.0.0.1:<some high port>` row, `nothingStoredNote`'s doc, and
  `ServersPanel`'s row comment all used the sidecar as their example;
  the panel test that reproduced the owner's row now uses a loopback
  proxy held by a session, which is the case that survives.
- Host **670 passed / 6 ignored**, clippy clean, fmt clean. Frontend
  163 files / **2200 tests**, build clean.

**`f9e540b7` fix(gui): one trust dialog, opened only by the user** —
rulings 1 and 2, the behavioural core.

- _Two defects, one shape._ `ServersPanel` mounted its own
  `ServerTrustDialog` while `App.tsx` mounted the app-wide
  `ServerTrustDialogs` over the same host question (two modals over one
  server), and the app-wide one opened itself for **any** pending
  question — including one the background interface watch
  (`interfaces::run_watch` → `connect_flow::ask`) raised about a server
  nobody was trying to connect to.
- _The seam, and why it is on this side._ Whether a question exists is
  a model fact and stays the host's; **whether it interrupts the user**
  is a view event — "did the user just ask for this connection" is not
  something the model holds. So the decision lives in `serverTrust.ts`
  as one module-scope raise (`useSyncExternalStore`, the same shape
  `hostSettings.ts` and `theme.ts` use), and `ServerTrustDialogs`
  renders that and nothing else.
- _The stale-raise problem, and its fix._ A raise that outlived the
  attempt that made it would re-create the very nuisance ruling 1 bans:
  press _Trust…_, get no question, and a later passive
  `identityChanged` for that server pops the modal. So
  `raiseServerTrust(address)` **asks the host at the moment of raising**
  (`get_server_prompts`, which the host has already written by the time
  a refused command returns) and raises only what is pending now. An
  attempt that raised no question arms nothing.
- _Four raise sites, all direct user input:_ a connect the question
  blocked (`App.tsx`'s `handleConnect` catch), a row's _Trust…_, a
  row's _Review…_, and a typed address (`add_server`).
- _No re-dial on review._ A row the host is already waiting on carries a
  real observation from the attempt that made it, so _Review…_ puts that
  question up directly; only a row it is waiting on nothing for dials,
  which is what produces a first-contact fingerprint. This is what lets
  a server that has since gone quiet still be reviewed — re-dialling
  first would have lost the recorded identity change.
- _Orphans removed._ `useServerPrompts` and `nextPrompt` had exactly one
  consumer between them (the auto-raise) and went with it; a remembered
  dismissal set is meaningless once nothing re-opens the dialog but the
  user. `promptKey` stays as the dialog's React key.
- _Nine tests, each falsified against a mutation of the code it pins._
  The red run was mutation-based rather than pre-implementation, and
  each mutation is named: matching on the raw address instead of
  `serverKey` kills "finds the question however the address was
  spelled"; raising a synthetic prompt when none is pending kills "opens
  nothing when the attempt raised no question" and the panel's
  dial-then-ask test; restoring the auto-raise kills "never opens itself
  for a question the host raised on its own".
- Frontend 163 files / **2206 tests**, build clean.

**`7914059f` feat(gui): a trust question the host asked on its own is an
indicator** — ruling 1's other half.

- _Identity was already carried by both surfaces_ — the row badge reads
  `identity changed` and `busServerTrust` returns `changed` — because
  the host computes `TrustState::FingerprintChanged` from the pending
  question itself. That is the "feed the indicator from the row's prompt
  fact" the ruling asks for, and it already existed.
- _A refused token was carried by neither._ The pin is still good, so
  the trust state stays `trusted` and had nothing to say. Both surfaces
  now read it off `row.prompt`: the row's token cell says `token
  refused` instead of `token stored` (the indicator goes where the token
  is, needing no new row cell), and `busServerTrust` gains a
  `tokenRefused` kind whose notice names it.
- _`noProtection` is deliberately not an indicator_ — a server that is
  not answering is the connection state's to report, not the trust
  notice's. Pinned by a test.
- _The affordance names its question_ — _Review identity…_ /
  _Review token…_ / _Review…_ / _Trust…_.
- _Falsified by deleting each new branch_ (both indicator tests failed).
- Frontend 163 files / **2211 tests**, build clean.

**`d17b2b4e` fix(gui): a server that is not trusted says so, whether or
not it is listed** — ruling 4, reconciled rather than left recorded.

- The `unknown` notice read _unknown server host:port — trust it in the
  Servers panel_ while `untrusted` read _is not trusted on this
  machine_. Two names for one fact: either way the host will not reach
  that server without an answer. Both now state the fact and differ only
  in the fix (**add** it vs **trust** it), so the distinction the old
  wording carried moves to where it is actionable.
- Watched red: the existing notice test failed on the old string before
  the change.

**`ca6f0666` test(gui): the two exit criteria the unit tests could not
see.**

- `App.connectTrustDialog.dom.test.tsx` drives the **whole App** over a
  project bound to a server whose identity changed, because the wiring
  under test is _which call sites raise_: the pending question opens
  nothing while nobody is connecting (and nothing even asks the host
  what it is waiting on), a Connect the user pressed opens **exactly
  one** dialog carrying both fingerprints, and a connect that failed for
  another reason opens none.
- The panel gains the dismissal loop end to end: review, cancel, nothing
  written, the indicator still on the row, and the row opening the same
  question again.

**Verification at `ca6f0666`** (re-run at the tip, and before every
commit):

| suite | result |
| --- | --- |
| `pnpm --dir apps/gui test` | **164 files / 2215 tests passed** (from 163 / 2200) |
| `pnpm --dir apps/gui build` | clean |
| `cargo test -p cannet-gui` | **670 passed / 6 ignored** (from 668) |
| `cargo clippy -p cannet-gui --all-targets` | clean |
| `cargo fmt --check` | clean |

**Exit-criteria walk.**

| criterion | state |
| --- | --- |
| Passive token/identity change raises no dialog; indicator in project view **and** Servers panel; DOM-tested | MET — `App.connectTrustDialog` ("opens nothing while the user is not trying to connect"), `ServersPanel` ("shows an identity that changed while nobody was connecting, without a dialog", "says on the row when the server refused the stored token"), `BusServerTrust` (the bus-row notice beside a shut dialog, and the `tokenRefused` kind) |
| A directly blocked connect raises exactly ONE dialog; the duplicate impossible by construction | MET — one implementation, one mount; `App.connectTrustDialog` asserts `findAllByRole("dialog")` has length 1, and `ServersPanel` asserts the panel mounts none of its own |
| Dismissing leaves the indicator; the user can act later from the panel | MET — `ServersPanel` "leaves the indicator when the dialog is waved away, and opens it again" |
| The sidecar row can no longer appear; tested at the merge source; wording retired | MET — `the_apps_own_sidecar_session_is_never_a_row` in `server_list.rs`; README plus two code comments and one panel test retired |
| Wording reconciliation (in-scope if touched) | MET — reconciled, `d17b2b4e` |

## Blockers / side effects

- **None blocking.** No ruling proved unimplementable as written.
- _Recorded, not acted on:_ the roadmap still lists this task as
  outstanding. Retiring the entry is left to the cycle's closeout, which
  is how tasks 63–68 were retired.
- _Behaviour change worth knowing at review:_ a **new** question about a
  server no longer interrupts the user even while an older question
  about that same server is on screen — the old dialog host walked the
  whole prompt map and would move on to the next undismissed question by
  itself. Nothing re-opens or re-targets the dialog now but a user
  action. This follows directly from ruling 1 (a question the user did
  not ask for is an indicator), and every such question is still visible
  on the row.
- _`useServerPrompts` no longer exists_, so the frontend holds no live
  subscription to `server-prompts-changed`; the map is read at the
  moment of raising. The host still emits the event, and
  `SERVER_LIST_CHANGED_EVENT` is what keeps the indicators live — that
  path is unchanged.
