# Task 45 — Settings-Store Consolidation

`settings.json` should be the single place every app-level knob lives.
Today it holds three fields, while a few dozen decisions a user might
reasonably want to change live as module constants, per-panel layout
blobs, or environment variables. This task closes that gap — and fixes
the store's own defects first, because growing a store with a
lost-update race in it just multiplies the race.

## What the store is

Worth stating plainly, because it is easy to assume otherwise: **the
settings store is ours, not Tauri's.** There is no `tauri-plugin-store`
dependency. [`settings.rs`](../../apps/gui/src-tauri/src/settings.rs)
defines a serde struct written atomically into Tauri's
`app_config_dir`; Tauri supplies the directory and nothing else. The
app has three persistence mechanisms in total:

| Store | Owner | Holds |
| --- | --- | --- |
| `settings.json` | ours ([ADR 0034](../../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md)) | user intent |
| `state.json` | ours (ADR 0034, renamed from ADR 0032's `preferences.json`) | machine state |
| window geometry | `tauri-plugin-window-state` | size + position |

The window-state plugin is **correctly** separate — it restores before
the WebView exists. No action there.

ADR 0034's contract is good and this task does not change it: every
field is written explicitly even at its default, so the file documents
itself; hand-editing is a supported path; the panel is sugar over the
file. The deciding question for placement stays *"did the user choose
this, or did the app observe it?"*

## Scope

### Stage 1 — fix the store that exists

1. **The lost-update race.** *(verified)*
   [`SettingsPanel.tsx`](../../apps/gui/src/SettingsPanel.tsx) loads
   settings once on mount and then writes the *whole* struct from that
   mount-time snapshot on every edit (`{...prev, ...patch}`).
   `useCommands`' `persistUserBindings` does it correctly — re-read,
   merge, write — and its comment even says it does so "so a concurrent
   settings edit isn't clobbered". The panels are singletons and both
   can be open at once, so: rebind a key, then tick a Settings
   checkbox, and **the rebind is silently reverted**. Make the panel
   re-read before merge, as `useCommands` already does. This is a
   user-visible bug, not just untidiness — it wants a regression test.
2. **The cap floor is duplicated by admission.** `MIN_SCRATCH_CAP_BYTES`
   (Rust) and `MIN_CAP_MB` (TS) carry a "keep in sync" comment. One
   source of truth.
3. **Flooring on read, not on write.** `floored_scratch_cap` runs where
   settings meet the store, so a hand-edited 15 MB cap stays 15 MB in
   the file, is enforced at 100 MB in the store, and is *displayed* as
   100 MB. Three answers to one question. For a file whose entire
   selling point is hand-editability, the file lying about the
   effective value is the wrong failure mode — normalise on write, or
   surface the correction.
4. **No host-side validation of `keybindings`.** The host round-trips
   any `{chord, commandId}`; a typo'd hand-edit silently disables a
   command with nothing on the system log. Validate and warn.
5. **No boot hydrate, no change notification.** Two independent
   consumers read settings lazily. A hand-edit while the app runs needs
   a restart *and* gets clobbered by the next panel edit. This
   asymmetry with `hostState` (which does hydrate) is what enables
   defect 1.
6. Stale doc comment: `hostSettings.ts` claims "settings are read only
   by the settings panel", false since `useCommands` reads them at boot.

### Stage 2 — move what is misfiled

1. **`blf_channel_maps` stays in `state.json` — no move.** A read of
   its rustdoc (*"unlike the spill caches this is user-authored and not
   recomputable, so it must not be evicted"*) suggested it fails
   ADR 0034's placement test, since the ADR asserts nothing in
   `state.json` is a user choice. That reading is wrong, and the
   distinction is worth writing down because it will come up again:

   **User-authored is not the same as a user preference.** A mapping
   keyed to *specific files* is a remembered convenience — the app
   recording what you accepted last time for this BLF — not a
   behavioural choice you set. It is state, arguably cache. The
   rustdoc's "user-authored" note is about *eviction policy* (don't
   drop it, you can't recompute it), not about its category.

   Where it *does* belong is **workspace-scoped state** — per-project,
   beside the other things scoped to that working context. That is
   [Task 47](0047-user-workspace-scoping.md), which is scheduled ahead
   of this task's Stage 2, so the move happens there rather than here.
   Until then it stays where it is; it is not misfiled badly enough to
   justify moving it twice.

   ADR 0034 therefore needs no amendment on this point. Sharpening its
   deciding question would still help — "did the user *choose* this, or
   did the app *observe* it?" reads ambiguously for a value the user
   typed into a dialog once.
2. **System-log minimum level is an app preference stuck in panel
   state.** "How verbose do I want my log view" survives a panel close
   in nobody's mental model; today it lives in an untyped dockview
   `params` blob and resets with every new panel. `filterSource`
   alongside it is correctly view-local — only the level moves.
3. **`showValues` is written to `params` but absent from that panel's
   params interface.** Right location, broken contract. Type it.

### Stage 3 — promote constants that are really policy

Ranked by how likely a real user is to want the knob. Each becomes a
`settings.json` field with the current value as its default, so an
untouched install behaves identically.

| Knob | Today | Why a user cares |
| --- | --- | --- |
| Plot fetch cadence | `RESAMPLE_INTERVAL_MS`, 67 ms | Machine-load trade-off. Gated behind [Task 44](0044-gui-render-and-idle-cost.md) Tier 2 #1 — before that it does not meaningfully change load. |
| View refresh cadence | 250 ms in **four** files | One concept, four copies. Collapse to one setting (or at minimum one constant) regardless of whether it is user-exposed. |
| `cannet.log` rotation size | 5 MiB × 1 generation | This is the artifact a field engineer ships back. A long soak silently loses its head. |
| Log verbosity | see Stage 4 | The rolling log has **no** verbosity control at all. |
| Trace flush cadence | `TRACE_FLUSH_TICK`, 2 s | Crash-durability vs I/O — the same class of decision as `scratch_cap_bytes`, which is already a setting. Inconsistent to expose one and not the other. |
| Default follow-live window width | 10 s | Site-specific; 10 s is wrong for a slow body bus. |
| Recents retention | 8 BLFs / 10 commands | Textbook setting. |
| Sidecar restart budget | 3 per session | Too few for a flaky dongle, too many for a CI soak. |
| System-log ring depth + rate limit | 4096 / 5-per-second | Debugging a message flood is exactly when you want the limiter off. |
| Health-sample cadence | 20 s | Expensive (full process-table walk); a user on a loaded machine may want it off. |

Also promoted — these were audited as "borderline, argue it", and the
argument against each was clutter or the risk of incoherent tuning by
someone who shouldn't be touching them. The `developer` tag from
[Task 46](0046-settings-framework-and-view.md) answers both objections,
so they go in:

| Knob | Today | Note |
| --- | --- | --- |
| Live update rate | `TRACE_GREW_TICK`, 100 ms | Expose as **one** "live update rate" setting, not three — it interlocks with `FPS_SMOOTHING` and `TRACE_GREW_TAIL`, and surfacing one of three invites incoherent tuning. |
| Reconnect backoff | 2 s | Fine on a LAN; a flaky VPN to a remote `cannet-server` wants longer. |
| Host-mirror poll interval | 500 ms default | Rides with the view-refresh-cadence setting above rather than standing alone. |
| Notice dwell time | `STATUS_TRANSIENT_DWELL_MS`, 3 s | Accessibility argument (slow readers); nothing is lost either way since notices mirror to the system log. |

Independent of the settings question: the DBC panel's live-value poll
is a bare `500` literal where every sibling cadence has a named
constant. Name it while in here.

**Explicitly staying constants** — recorded so this is not re-audited
every six months: page sizes, `MAX_SCROLL_HEIGHT_PX` (a browser
limit), the regex-cache cap, mux scan bounds, pyramid branch factor,
rate-estimator windows, BLF writer buffer, titlebar geometry
constants. Exposing these is a footgun. The ADR-0031 automation flags
are correctly CLI, not settings — they are per-run harness invocation,
not persistent intent.

Separately, page sizes are 512 / 1000 / 1024 for the same job across
four call sites. Not a settings question; just unexplained drift worth
normalising while in here.

### Stage 4 — env-only configuration that needs a settings equivalent

1. **`CANNET_SIDECAR_DIR`** — the only way to point the app at a
   non-default sidecar. A field engineer with a patched driver build
   cannot do it from the GUI; they must set an env var and relaunch.
2. **`CANNET_DRIVER_MODULE`** — selects the driver implementation, and
   the Tauri host **never sets it**, so it is effectively unreachable
   from the GUI. A settings field the host forwards is the right
   contract.
3. **Log verbosity, both halves.** `RUST_LOG` is env-only *and*
   governs only the dev-stderr layer; the rolling `cannet.log` — the
   artifact that actually matters in the field — has no verbosity
   control at all. The sidecar's `--log-level` is likewise unreachable
   because the host passes neither it nor `--bind`.

### Stage 5 — defaults with no way to change them

Ranked; each is "set once and keep" territory. Minimum system-log
level (see Stage 2 #2); default column sets, widths, and hidden columns
for trace and signal views; startup behaviour (always reopens the last
project — no "start empty" option); CAN-ID and timestamp formatting
(hex-only, elapsed-only — both are standard toggles in comparable
tools); theme and density (dark-only, fixed type scale — no light mode,
no font-size control). Then: default server address, default nominal
bitrate, seed layout ("save current layout as my default"), palettes
(**no global remedy for a colour-blind user** — per-signal overrides
only), DBC auto-reload opt-out, default y-axis mode, default
auto-scroll / trace mode / events overlay, confirmation-prompt
suppression.

This stage is large and mostly independent per item. It should be
sliced by surface, not landed as one change.

## Interlock with Tasks 46 and 47

This task grows the settings count past twenty-five, which is more than
a flat panel can carry and more than one scope should carry blindly.
Two sibling tasks own those halves:

- [Task 46 — Settings Framework & View](0046-settings-framework-and-view.md)
  — a per-setting descriptor with tags, fuzzy search, a tree grouped by
  tag, and a `developer` tag hidden by default.
- [Task 47 — The Project Directory](0047-user-workspace-scoping.md)
  — cannet always works in a project directory; workspace settings,
  project state, and the cache live in its `.cannet/` subdirectory.

Three hard dependencies run between them:

- **Task 47's scope rule and Task 46's tag taxonomy must both be
  settled before Stage 3 here bulk-promotes.** Every promoted field
  lands with its scope and tags attached; retrofitting twenty-five
  fields with either is the waste this ordering exists to avoid.
- **The `developer` tag is what makes Stage 3's second table
  defensible.** Those knobs were borderline precisely because exposing
  them risked clutter and incoherent tuning; hidden-by-default answers
  both, so they are promoted rather than argued one at a time.
- **Stage 1 runs before either.** The lost-update race is a live bug
  and nothing else should be built on a racy store.

The storage contract does not depend on the view — ADR 0034 says so
explicitly — so Task 46 gates the panel, never the file. Task 47 *does*
change the file layout, which is why it precedes Stage 2.

## Duplicate sources of truth to collapse

1. View refresh cadence — 250 ms in four files.
2. Scratch cap floor — Rust ↔ TS, "keep in sync by convention".
3. Default nominal bitrate 500 kbps — TS ↔ Python ↔ Rust, "kept in
   sync by convention". Crosses three languages; the most likely of
   these to drift unnoticed.
4. Panel view config — written to both element `config` and dockview
   `params`, both landing in the project file. Deliberate and
   documented, but two writers for one fact.
5. Settings defaults — Rust derive ↔ TS hand-written ↔ rustdoc prose.
6. Project schema version — Rust ↔ TS, both `7`.

## Not a finding

Recorded so it is not re-raised: `notes.json` living in the scratch dir
that `clear_scratch_on_exit` wipes **is not a data-loss bug.** The
durable home for a note is inside the BLF as a `GLOBAL_MARKER` record
(ADR 0035 / ADR 0010); the scratch copy is the session-scoped working
store for the capture those notes annotate. Clearing the scratch
discards unsaved notes exactly when it discards the unsaved capture
they belong to — which is coherent. The residual worth considering is
only whether the setting's *wording* leads a user to expect "free disk
space" rather than "discard this session", which is a copy question,
not an architecture one.

Also correct as-is: `localStorage` has **zero** production uses (fully
retired per ADR 0032), per-panel scroll/column/expanded-row state is
properly view-local, and the window-state plugin is properly separate.

## Documentation deliverables

- **ADR 0034 clarification.** Not the amendment first thought
  necessary — its `state.json` claim holds. What it needs is a sharper
  deciding question: "did the user choose this, or did the app observe
  it?" is ambiguous for a value a user typed into a dialog once. State
  the test as *is this a behavioural preference, or a memo about
  specific files/sessions?*, with `blf_channel_maps` as the worked
  example. Task 46 amends the same ADR for the descriptor/tagged-view
  decision — fold both into one amendment.
- **Open question: are we using the right base directories?** Both
  `settings.json` and `state.json` live in Tauri's `app_config_dir`,
  while the scratch lives in `app_cache_dir`. On XDG those are three
  distinct roots (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`), and `state.json` is by its own module doc *state*,
  sitting in the *config* dir. Worth checking what Tauri 2 actually
  exposes before deciding whether this is worth correcting — a base-dir
  move is a migration, and ADR 0011 says we drop rather than migrate.
  Low priority; record the answer either way so it stops being a
  recurring question.
- **Stale `localStorage` comments** at five sites (`hostState.ts` ×2,
  `types.ts`, `useElementPanel.ts` ×2) still describe an
  "unsaved-workspace `localStorage` layout" that no longer exists.
- **Comment rot is a pattern, not an incident.** Three independent
  instances surfaced in one day's reading: a `renderedThrough` dedup
  guard cited in a comment as preventing a double-fire when the guard
  had been deleted (hiding a 10 Hz render floor for however long), an
  "LRU chunk cache in `App.tsx`" cited by CLAUDE.md as a reference
  implementation of the paging rule when no such cache exists, and
  these `localStorage` remnants. Each was a comment asserting a
  mechanism that had been removed. Worth a line in CLAUDE.md's
  documentation rules: when you delete a mechanism, grep for its name
  before you commit.

## Exit criteria

- Editing a keybinding and a setting in the same session cannot lose
  either, with a regression test proving it.
- Every value in `settings.json` means what the file says: no knob
  enforced at a value the file does not show.
- One source of truth for each item in the duplicates list, or an
  explicit note saying why a copy stays.
- No user-facing knob promoted in Stage 3 changes behaviour for a user
  who never opens the settings file.
- Every promoted field lands with its Task 46 tags already attached —
  no retrofit pass.
- `settings.json` on a fresh install lists every knob the app has, at
  its default — the ADR 0034 promise, still true at the new count.
