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

### Stage 1 — fix the store that exists — **complete**

All six items below are done. Stage 1 ran ahead of Task 47 (see
"Interlock"). Two of the six claims turned out to be inaccurate as
written and are corrected in place: item 3 (the cap floor is not a
clamping-strategy choice — it is validation metadata) and item 4 (the
`keybindings` validation already existed; the *reporting* did not, and
the fix is not host-side).

1. **The lost-update race.** *(done)*
   [`SettingsPanel.tsx`](../../apps/gui/src/SettingsPanel.tsx) loaded
   settings once on mount and then wrote the *whole* struct from that
   mount-time snapshot on every edit (`{...prev, ...patch}`).
   `useCommands`' `persistUserBindings` does it correctly — re-read,
   merge, write — and its comment even says it does so "so a concurrent
   settings edit isn't clobbered". The panels are singletons and both
   can be open at once, so: rebind a key, then tick a Settings
   checkbox, and **the rebind was silently reverted**. The panel now
   re-reads before merging, as `useCommands` already did; the edit still
   shows immediately in local state, only the *write* base changed.
   Regression test: `SettingsPanel.dom.test.tsx` → "keeps a keybinding
   written by another panel while it was open" (mutates the mock store
   between mount and click; fails on the pre-fix code).
2. **The cap floor is duplicated by admission.** *(done — folded into
   item 3)* `MIN_SCRATCH_CAP_BYTES` (Rust) and `MIN_CAP_MB` (TS)
   carried a "keep in sync" comment. The duplication is gone because
   the bound is no longer mirrored: `MIN_CAP_MB` is deleted and the
   panel reads the limit from the host through `get_settings_bounds`.
   Anti-drift test: `settings.rs` →
   `the_published_bound_is_the_one_validate_enforces` (the published
   bound must be the number `validate` enforces) plus
   `SettingsPanel.dom.test.tsx` → "takes the cap minimum from the host
   rather than restating it", whose fake host publishes a *different*
   minimum (64 MB) so a panel that hard-codes 100 fails.
3. **The floor is validation metadata, not settings data.** *(done)*
   This is not a choice between clamping strategies, and it should not
   be re-litigated as one. `MIN_SCRATCH_CAP_BYTES` is a **hard
   implementation limit** (ADR 0002 DS-8): below it the pre-allocated
   segment families dominate the budget, so a smaller cap cannot be
   honored at all. That makes it a *constraint on the
   `scratch_cap_bytes` field* — a `min` — not a value to flow through
   settings logic and clamp at a read boundary. So:

   - the bound is **stated once**, host-side, next to the field it
     bounds;
   - it is **enforced at ingress** — `get_settings` (a hand-edited
     file) and `set_settings` (a panel write) both run `validate`,
     which **refuses** an out-of-range value, resolves the field to its
     default, and **reports it on the system log**. Same contract as
     item 4's treatment of a typo'd keybinding: one rule for
     hand-editing the file, not two;
   - `floored_scratch_cap`'s read-time clamp is **gone**. The store
     does not silently repair a value that should never have been
     accepted;
   - the bound is **published** to the frontend
     (`get_settings_bounds`) rather than re-declared there.

   Deliberately *not* done: normalising the user's file on our own
   initiative (rewriting a refused 15 MB to 100 MB). The file is a
   user-authored document; we report what we refuse and leave their
   text alone, which is also what a dropped keybinding does. And
   deliberately not built: the per-setting descriptor. When it lands
   (Task 46), `MIN_SCRATCH_CAP_BYTES` *becomes* that descriptor's `min`
   with no behavioural change — one host-side source of truth, enforced
   on write, surfaced to the frontend.

   One consequence worth recording: because the host now refuses a
   below-minimum cap instead of clamping it, the cap box could no
   longer write through on every keystroke — "500" would be refused at
   "5" and the box reset before the last digit arrived. It now commits
   on blur / Enter, with the typed text held as local draft state.
4. **A refused `keybindings` entry said nothing.** *(done — the
   original claim was half wrong)* The claim was "no validation of
   `keybindings`: the host round-trips any `{chord, commandId}`". The
   *validation* was already there — `resolveBindings` →
   `sanitizeBindings` has always dropped unknown command ids,
   unparseable chords, and colliding bindings on load. What was missing
   is the **reporting**: a typo'd hand-edit lost its shortcut with
   nothing anywhere saying why.

   It is also not host-side work, and shouldn't become host-side work.
   The chord grammar (`keybindings.ts`) and the command registry
   (`commands.ts`) are both declared in the frontend, so the host cannot
   judge a binding without a second copy of both — exactly the
   duplication item 3 just removed for the cap bound. Validation belongs
   where the rule is stated; that is the frontend. The *report* goes
   host-side, on the system log, via `gui_emit_system_log` (the
   sanctioned frontend→syslog path, whose rustdoc already anticipates
   this use).

   `sanitizeBindings` is now a thin wrapper over `reviewBindings`, which
   returns the accepted list *and* the refusals with reasons;
   `useCommands`' load effect warns one line per refusal. Tests:
   `commands.test.ts` → `reviewBindings` (reason names the offending
   command id / chord / the binding it lost to, and the accepted half
   still matches `sanitizeBindings` exactly).
5. **No boot hydrate, no change notification.** *(done)* Two
   independent consumers read settings lazily; a hand-edit while the app
   ran needed a restart, and the asymmetry with `hostState` (which does
   hydrate) is what enabled defect 1. `hostSettings` now mirrors
   `hostState`: `hydrateSettings()` from `main.tsx` before first render,
   `hostSettings()` for synchronous reads, `subscribeSettings()` for
   change notification.

   The one place it deliberately does *not* mirror `hostState`: **the
   cache is never the base of a write.** `updateSettings(patch)` merges
   over a fresh read of the file, then caches and publishes what the
   host says it accepted. A cache-based write would have re-introduced
   defect 1 in a worse form — `hostState` can write from its cache
   because nothing else edits `state.json`, but `settings.json` is
   hand-editable by contract, so its cache can always be stale.
   Re-opening the settings panel re-hydrates, which is how a hand-edit
   made mid-session reaches the app.

   Tests: `hostSettings.test.ts` — synchronous read after hydrate,
   defaults for a partial host answer, patch merged over a fresh read
   (not the cache), subscribers notified with the *accepted* settings
   rather than what was sent, and a re-hydrate notifying subscribers.
6. **Stale doc comment** *(done, in the same change as item 5, which
   rewrote the paragraph)*: `hostSettings.ts` claimed "settings are read
   only by the settings panel", false since `useCommands` reads them at
   boot — and doubly false now that the module hydrates.

### Stage 2 — move what is misfiled — **complete**

All three items are settled. Item 1 needed no work here (Task 47 did
it); items 2 and 3 landed together.

1. **`blf_channel_maps` stays in `state.json` — no move.** *(done by
   [Task 47](0047-user-workspace-scoping.md), not here.)* It is now
   `Scope::Workspace` in `state.rs`'s scope table, so it lives in the
   project's `.cannet/state.json` — the workspace-scoped state this
   item said it belonged in. Nothing was left for this stage. The
   reasoning is kept because it is the worked example ADR 0034's
   sharpened deciding question needs. A read of
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
   where Task 47 put it.

   ADR 0034 therefore needs no amendment on this point. Its deciding
   question *is* now sharpened — "did the user choose this, or did the
   app observe it?" read ambiguously for a value the user typed into a
   dialog once, and decision 1 now asks *is this a behavioural
   preference, or a memo about specific files and sessions?*, with
   `blf_channel_maps` written up as the worked example.
2. **System-log minimum level is an app preference stuck in panel
   state.** *(done)* "How verbose do I want my log view" survives a
   panel close in nobody's mental model; it lived in an untyped
   dockview `params` blob and reset with every new panel. It is now the
   `system_log_min_level` setting (`Scope::User` — what *you* see in a
   log view is not a project's business), and the panel's "Min level"
   combobox is that setting's editor: it reads through `hostSettings`,
   subscribes so a change made in the settings view or by a hand-edit
   follows, and writes through `updateSettings`. `filterSource` stays
   in `params`, and the panel's rustdoc now says why the two filters
   sit in different places.

   The value is a `String` validated against
   [`SYSTEM_LOG_LEVELS`](../../apps/gui/src-tauri/src/settings.rs)
   rather than a serde enum: a serde enum would fail the *whole*
   document on one typo'd level, whereas the string goes through
   `validate` and gets Stage 1 item 3's treatment — refused, reported
   on the system log, resolved to the default, user's text left alone.
   The same list is what the descriptor publishes as the control's
   options, so the view offers exactly what the host accepts
   (`the_published_log_levels_are_the_ones_validate_accepts`).

   Tests: `SystemMessagesPanel.dom.test.tsx` (level comes from
   settings not params; a pick persists and never lands in
   `updateParameters`; it survives close/reopen; the source filter
   still goes to `params` and writes no setting) and `settings.rs`
   (unknown level refused and reported; every declared level accepted).
3. **`showValues` is written to `params` but absent from that panel's
   params interface.** *(done)* Right location, broken contract.
   `DbcPanel`'s `PanelParams` now declares it, and the inline
   `params as { showValues?: unknown }` cast at the `useState` seed is
   gone.

### Stage 3 — promote constants that are really policy — **complete**

Ranked by how likely a real user is to want the knob. Each becomes a
`settings.json` field with the current value as its default, so an
untouched install behaves identically. **What landed, and what
deviated, is recorded under "Stage 3 as built" below the tables.**

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
constant. Name it while in here. *(done — `VALUE_POLL_MS` in
`DbcPanel.tsx`, with the prose copy of the number in the
`panelVisible` comment replaced by the name. It stays a constant: it is
not one of the promoted knobs, and the row above about the host-mirror
poll is about `useHostMirror`, not this one.)*

**Explicitly staying constants** — recorded so this is not re-audited
every six months: page sizes, `MAX_SCROLL_HEIGHT_PX` (a browser
limit), the regex-cache cap, mux scan bounds, pyramid branch factor,
rate-estimator windows, BLF writer buffer, titlebar geometry
constants. Exposing these is a footgun. The ADR-0031 automation flags
are correctly CLI, not settings — they are per-run harness invocation,
not persistent intent.

Separately, page sizes are 512 / 1000 / 1024 for the same job across
four call sites. Not a settings question; just unexplained drift worth
normalising while in here. *(done — one exported `PAGE_ROWS = 1024` in
`useWindowedQuery.ts`; the four call sites no longer pass `pageSize` at
all, so the hook's default* is *the page size and there is nothing left
to drift. 1024 was already the value at two of the four, is a power of
two, and is within 2.4 % of the chronological view's 1000; the filtered
view's 512 was the outlier and nothing in git history ties any of the
three to a measurement. The same number also sets the scroll-back
prefetch margin (`pageSize / 4`), which the drift had moving between
128, 250 and 256 rows. Guarded by* `pages at PAGE_ROWS when the caller
names no page size` *in `useWindowedQuery.test.ts`.)*

#### Stage 3 as built

Every field below lands with its scope and both tag axes attached — no
retrofit — and with the current value as its default, so a file that
predates it resolves to exactly what the app did before
(`a_file_written_before_a_field_existed_resolves_to_that_field_s_default`).

**Shared machinery, added once.**

- **`MIN_INTERVAL_MS`.** Every promoted cadence is a millisecond count
  and zero is a busy loop, so one host-side constant states the floor,
  `validate` enforces it through a shared `refuse_below` helper, and
  each interval control publishes it as its `min` rather than restating
  it. `every_published_minimum_is_the_one_validate_enforces` is the
  general form of Stage 1's cap-minimum test: for *every* descriptor
  with an `Int` floor, the host must accept that value, refuse the one
  under it, name the field in the complaint, and resolve it to its
  default. A future field that published a bound nobody enforced fails
  that test.
- **`useSetting(key)`** in `hostSettings.ts` — `useSyncExternalStore`
  over the existing cache, for a component that must *react* to a
  change (an interval whose effect has to be rebuilt). Code that only
  needs the value at the moment it acts reads `hostSettings()`
  directly and skips the render; both kinds are in use.

**Frontend-consumed fields.**

| Field | Default | Tags | Scope |
| --- | --- | --- | --- |
| `plot_fetch_interval_ms` | 67 | plot / developer | user-overridable |
| `view_refresh_interval_ms` | 250 | general / developer | user-overridable |
| `follow_window_ms` | 10 000 | plot / default | user-overridable |
| `recent_blfs_limit` | 8 | general / behaviour | user-overridable |
| `recent_commands_limit` | 10 | general / behaviour | user-overridable |
| `notice_dwell_ms` | 3 000 | general / developer | user |

Notes on the ones that deviated from the table above:

- **The view refresh cadence took the host-mirror poll with it, and
  that is a real behaviour change.** The four 250 ms copies collapsed
  into `useWindowedQuery`'s one default, which every view now inherits
  by not passing `refreshMs` at all. `useHostMirror`'s separate 500 ms
  default is gone too — its row says it "rides with the view-refresh
  cadence rather than standing alone", and a host mirror going stale in
  place is the same "keep up with the host" job — so the transmit and
  RBS panels now poll at 250 ms while a message is running instead of
  500 ms. **This is the one place Stage 3 changes what an untouched
  install does**, and it is a consequence of the collapse, not of the
  promotion: the alternative was to keep two numbers for one concept,
  which is the drift the stage exists to remove. The poll is
  `pollWhile`-gated, so it only applies while something is actually
  running.
- **Recents retention is two fields, not one.** The table lists it as
  one row ("8 BLFs / 10 commands") but they are two independent lists
  with different natural depths, and — unlike the live-update-rate
  row — nothing interlocks them, so one shared number would have had to
  change one of the two defaults. There is no incoherent-tuning risk in
  two separate caps.
- **`follow_window_ms`, not `follow_window_seconds`.** Stored in
  milliseconds like every other duration in the file, and edited in
  seconds through the control's `scale` — the same mechanism that lets
  the cache cap be stored in bytes and typed in MB. It keeps `Settings`
  free of a float, and `PlotPanel`'s follow-live target lag (which is a
  multiple of the fetch interval) now derives from
  `plot_fetch_interval_ms` instead of the deleted module constant.
- **`notice_dwell_ms` is `Scope::User`.** The argument for the knob is
  reading speed, which follows the person, not the project — the same
  reasoning as `show_developer_settings` and `system_log_min_level`.

Behaviour tests (each mutation-checked): `useWindowedQuery.test.ts`
→ *throttles live refreshes at the configured view refresh interval*
and *pages at PAGE_ROWS…*; `PlotPanel.dom.test.tsx` → *paces the fetch
loop from the plot fetch interval setting* (a real-time counterpart to
the existing default-cadence test); `recentBlfs.test.ts` /
`recentCommands.test.ts` → *caps at the configured depth, not a
hard-coded one*.

**Host-consumed fields, and the cache they read.**

The host half needed one thing the frontend half did not: a way to read
a setting on a path where re-reading `settings.json` is out of the
question — a per-message rolling-log write, a `tokio` timer loop, the
system-log ring itself. `settings::effective()` is that: an
`Arc<Settings>` behind an `RwLock`, refreshed by every `get_settings` /
`set_settings` and hydrated once in `setup` before any of its readers
start. One `Arc` clone per read, no filesystem, safe to call from
inside the system-log path — which is the constraint that ruled out
"just read the file".

It is a **read** cache and never the base of a write. Stage 1 item 5's
rule is untouched: `set_settings` still merges over a fresh read,
because the file is hand-editable and a cache can always be stale.
Before the boot hydrate it answers `Settings::default()`, which is the
same answer a missing file gives, so the pre-hydrate window behaves
identically to a fresh install rather than specially.

| Field | Default | Tags | Reader |
| --- | --- | --- | --- |
| `live_update_interval_ms` | 100 | trace / developer | `emitters::spawn_trace_grew_emitter` |
| `trace_flush_interval_ms` | 2 000 | storage / behaviour | `emitters::spawn_trace_flusher` |
| `log_rotation_bytes` | 5 MiB | logging / behaviour | `crash::persist_block`, the panic hook |
| `system_log_ring_capacity` | 4 096 | logging / behaviour | `system_log::push_ring` **and the frontend mirror** |
| `system_log_rate_limit` | 5 | logging / behaviour | `system_log::burst_budget` |
| `health_sample_interval_ms` | 20 000 | logging / developer | `crash::spawn_health_recorder` |
| `sidecar_restart_budget` | 3 | connection / behaviour | `sidecar::maybe_restart` |
| `reconnect_backoff_ms` | 2 000 | connection / developer | `interfaces::run_watch` |

Notes:

- **The two `tokio` loops re-arm.** Both read the cadence at the top of
  each tick and rebuild their `Interval` when it moved (`retune`), so a
  changed cadence takes effect on the next tick rather than at
  relaunch. Same for the health recorder, which additionally parks on a
  short poll while sampling is switched off so switching it back on
  does not need a restart either.
- **Live update rate is one setting, per its row.** `FPS_SMOOTHING` and
  `TRACE_GREW_TAIL` stay constants and their rustdoc now says they are
  tuned *against* this cadence, which is the reason the row gives for
  not surfacing all three.
- **Three fields treat `0` as "off", not as a floor**, so they carry no
  published minimum and their help text says what zero does:
  `system_log_rate_limit` (the row's own argument — "debugging a
  message flood is exactly when you want the limiter off"),
  `health_sample_interval_ms` ("a user on a loaded machine may want it
  off"), and `sidecar_restart_budget` (never auto-restart). The
  zero-is-off mapping is split into a pure `budget_from` /
  `health_interval_from` so it is testable without touching the
  process-wide cache.
- **`RING_CAPACITY` crossed a language boundary by hand and no longer
  does.** The frontend's `SYSTEM_LOG_MIRROR_CAPACITY` was a
  hand-maintained copy of the host constant with a comment asking for
  it to be kept in sync. Both sides now read
  `system_log_ring_capacity`, so raising the depth actually makes more
  history reachable in the panel instead of only in the host.
- **`push_ring` takes its capacity as a parameter and evicts in a
  loop.** Lowering the depth mid-session leaves an over-long ring; the
  old single `==` check would have left it stuck at its old size.
- **`log_rotation_bytes` has a floor of 1 MiB, and that floor is
  mechanical rather than taste.** The control edits in MiB via its
  `scale`, so one mebibyte is the smallest value the control can
  express at all. Generation count stays structural (one `.1`) — making
  it a knob means rewriting `rotate_if_needed` into a shift loop, which
  is not what the row asks for.
- **`RATE_LIMIT_WINDOW` stays a constant.** The row promotes the ring
  depth and the burst budget; the budget is the number a user reasons
  about ("identical messages per second"), and making the window
  adjustable too would express one rate two ways.

Behaviour tests (each mutation-checked): `settings.rs` → *the effective
cache answers defaults until something publishes* (deliberately driven
through `notice_dwell_ms`, the one field no host module reads, because
the cache is process-wide and the other fields' readers have concurrent
tests); `system_log.rs` → *a rate limit of zero means no limit*, *the
ring shrinks to a lowered capacity*; `crash.rs` → *a health interval of
zero turns sampling off*; `systemLog.test.ts` → *caps at the configured
ring depth, not a hard-coded one*.

**Measured:** `cannet-perf-measurement check` passes all 12 gated
metrics (tracebuffer, grpc, hardware-peak) against the promoted
baseline after the change; the frontend tier is skipped as ever, since
Task 44 Tier 0 still owes a self-driving capture.

### Stage 4 — env-only configuration that needs a settings equivalent — **complete**

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
4. **Folded in: one malformed value resolved the whole document to
   defaults.** Not an env-var item — it is settings-store robustness,
   noticed while Stage 3 landed and taken here because it is the same
   code and it gets worse with every field added.

#### Stage 4 as built

**The precedence rule, decided once for the whole stage: the
environment wins, and the shadowed setting is reported.**

Every env var in this stage predates its setting and exists as an
*escape hatch* — for tests, CI, packaging experiments, and deployment
shapes nobody foresaw. An escape hatch a persisted file can override is
not an escape hatch, and harnesses already drive cannet by setting
these, so a settings file must not quietly change what such a run does.
The setting is therefore the **persistent default the environment
overrides for one run**, which also keeps the untouched-install
promise in its strongest form: an existing env-var user's behaviour is
unchanged whatever ends up in their settings file.

The cost is that `settings.json` can show a value the app is not using
— which the exit criteria do not let pass silently. So when the
environment shadows a *non-blank* setting, the host says so on the
system log at warn level, naming the variable, the key, and both
values: the same refuse-and-report shape a rejected value already got.
A blank setting is shadowed by nothing, so an untouched install is
silent. One pure function, `sidecar::env_over_setting`, is the whole
rule; blank means "nothing here" on both sides, so an empty
`CANNET_SIDECAR_DIR` falls through to the setting instead of resolving
to an empty path.

**`RUST_LOG` is the exception, and stays env-only.** It is not a
settings equivalent that is missing — it governs the dev-stderr
`tracing` layer, which does not exist in a release build (no console
under `windows_subsystem = "windows"`), and it is set per debugging
session, not persisted as intent. That is the same argument that keeps
the ADR-0031 automation flags as CLI. What the stage actually owed was
verbosity control over the artifact a field engineer *ships* —
`cannet.log` — and that is `log_file_min_level` below. Re-reading a
filter into an already-installed `EnvFilter` would also need a reload
layer, for a stream nobody in the field can see.

**Items 1 and 2 — `sidecar_dir` and `driver_module`.** *(done)*

| Field | Default | Tags | Scope | Reader |
| --- | --- | --- | --- | --- |
| `sidecar_dir` | `""` | connection / behaviour | user-overridable | `sidecar::resolve_sidecar_dir` |
| `driver_module` | `""` | connection / behaviour | user-overridable | forwarded to the child as `CANNET_DRIVER_MODULE` |

Notes:

- **Blank is the default, and blank means the built-in behaviour** —
  the bundled sidecar found by the existing probe, and the sidecar's
  own `cannet_python_can.driver_python_can`. So a file that predates
  the fields resolves to exactly what the app did before
  (`a_file_written_before_a_field_existed_resolves_to_that_field_s_default`).
- **Neither is validated, deliberately.** Only the sidecar can say
  whether a directory holds a sidecar or a module implements the driver
  protocol, and it already reports both — a spawn failure and a startup
  fatal, each on the system log. A host-side existence check would be a
  second, weaker opinion that goes stale between the check and the
  launch.
- **Both are `Behaviour`, not `Developer`.** They are not machine-load
  or cadence knobs, and hiding them by default would hide the LGPL §4
  replace path (`servers/cannet-python-can/LICENSING.md`) that is the
  main reason they exist.
- **`driver_module` needed the host to forward it at all.** The
  variable is read by the *sidecar*; the host never set it, so
  selecting a driver meant launching the GUI from a shell that already
  had it. `apply_sidecar_settings` now configures the built command —
  once, for both the frozen and the dev launcher flavours, which differ
  in how they *find* the sidecar, not in how it is configured.
  `--bind` is still not passed, for the reason its own test states.
- **The env-var branch is now unit-testable**, which it was not: the
  workspace forbids `unsafe`, so no test can call `set_var`, and the
  old code read the environment inside the resolver. The read is now
  one line at the edge and the decision is pure, so `sidecar.rs`'s
  standing "eyeball-verify it there" note is gone.

Tests (each mutation-checked): `sidecar.rs` → *the environment wins
over the setting and says so*, *the setting applies when the
environment is silent*, *the environment alone is not a shadowing*, *a
blank value on either side means unset*, *an override is used verbatim
as the sidecar dir*, *the driver module is forwarded to the sidecar
process*, *no driver module leaves the child environment alone*.

**Item 3 — log verbosity, both halves.** *(done)*

| Field | Default | Tags | Scope | Reader |
| --- | --- | --- | --- | --- |
| `log_file_min_level` | `debug` | logging / behaviour | user-overridable | `crash::persist_message` |
| `sidecar_log_level` | `info` | logging + connection / behaviour | user-overridable | passed to the child as `--log-level` |

Notes:

- **The two defaults are the two current behaviours.** `debug` is the
  lowest rung, so the rolling log keeps exactly what it kept when it
  had no filter at all; `info` is the sidecar's own argparse default.
  Neither changes an untouched install.
- **The log file's minimum is a second filter over a second sink, not
  a rename of `system_log_min_level`.** That one narrows the System
  Messages *view*; this one narrows the artifact a bug report carries,
  and quieting one must not quieten the other — a user who sets the
  panel to `warn` to stop the noise would otherwise silently ship a
  useless log. `system_log_min_level`'s help text used to end "the
  rolling log file keeps every level regardless", which this makes
  false, so it is rewritten in the same change.
- **A panic record ignores both.** It is written through
  `append_block` directly, on the terminal path that deliberately
  bypasses even the write lock.
- **`SIDECAR_LOG_LEVELS` is Python's ladder, not ours** — its third
  rung is `warning`, not `warn`. The host passes the value through
  verbatim, so publishing our spelling would offer the view a value
  that makes the sidecar exit at startup. Translating between the two
  would be a mapping to get wrong; the list is what the sidecar's
  argument parser accepts, and
  `the_sidecar_log_levels_are_pythons_ladder_not_ours` pins that.
- **`--bind` is still not passed.** The stage's own wording pairs the
  two ("the host passes neither it nor `--bind`"), but the reason
  `--bind` is absent is not oversight: `build_command_does_not_pin_a_bind_address`
  records that pinning a port re-creates the stale-instance wedge the
  ephemeral-port default was added to fix. The new test asserts the
  log level arrived *and* that `--bind` still did not, so adding one
  argument cannot smuggle in the other.
- **Two shared pieces, matching Stage 3's shape.** `refuse_unknown` is
  `refuse_below`'s string counterpart, so a fixed-option field is one
  table row rather than another hand-written `if`; and
  `LogLevel::from_name` / `rank` (the latter was test-only) turn a
  settings level name into a comparable rung.
  `every_published_option_set_is_the_one_validate_accepts` is the
  `Control::Enum` counterpart of Stage 3's published-minimum test: for
  *every* enum descriptor, the host must accept each published option
  and refuse one it does not publish.

Behaviour tests (each mutation-checked): `crash.rs` → *the rolling log
admits exactly what its minimum level allows* (the whole 4×4 ladder,
plus the default admitting everything and an unknown name not silencing
the log); `sidecar.rs` → *the sidecar log level reaches the child and
bind still does not*, over all three launcher flavours; `system_log.rs`
→ *every declared level name maps to a level in ladder order*;
`settings_descriptor.rs` → the two tests above.

**Item 4 — a malformed value costs its field, not the file.**
*(done)* `Settings` is `#[serde(default)]` at the *container*, which
fills an **absent** field but does not rescue one whose value is the
wrong type: `"plot_fetch_interval_ms": "fast"` failed the whole
deserialize, so every other setting silently reverted too. Survivable
at four fields; at nineteen it discards a user's whole file over one
typo, which directly undercuts ADR 0034's hand-editable contract.

The fix is in the shared merge rather than in `Settings`:
`persisted_json::resolve_scoped_reporting` parses the merged document
as a whole (the common case, and free), and **only on failure** walks
the keys, admitting each one that the type accepts and dropping —
with a complaint — each one it does not. So a refused value gets
exactly Stage 1 item 3's treatment: reported on the system log,
resolved to *that field's* default, the user's text left alone.
`get_settings` concatenates these complaints with `validate`'s, so the
two ways a value can be wrong (malformed, out of range) are reported
through one path.

Two notes:

- **It lands in `persisted_json`, so `state.json` gets it too.** That
  is the same primitive, not scope creep — the merge is where "one
  key's value" is already the unit of work, and a bad `recent_blfs`
  entry no longer costs the last-project pointer either. `state.rs`
  has nowhere to report, so it uses the discarding wrapper.
- **The complaint text is authored in `persisted_json`**, in the shape
  `validate`'s range complaints already use, so the reporting caller
  prints it verbatim rather than re-deriving prose from an error type.

Tests (mutation-checked by reverting the per-key walk to
`T::default()`): `persisted_json.rs` → *a value the document rejects
costs only its own key* and *a document with nothing wrong reports
nothing*; `settings.rs` → *one malformed value costs that field and
not the document* (a good neighbour before it, two after it, and the
bad one at its own default).

**Measured:** `cannet-perf-measurement check` passes all 12 gated
metrics (tracebuffer, grpc, hardware-peak) against the promoted
baseline after the change; the frontend tier is skipped, as in Stage 3,
because Task 44 Tier 0 still owes a self-driving capture.

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
- **Stage 1 runs before either.** *(done — it ran ahead of Task 47, and
  the roadmap now says so.)* The lost-update race was a live bug and
  nothing else should be built on a racy store.

The storage contract does not depend on the view — ADR 0034 says so
explicitly — so Task 46 gates the panel, never the file. Task 47 *does*
change the file layout, which is why it precedes Stage 2.

## Duplicate sources of truth to collapse

1. ~~View refresh cadence — 250 ms in four files.~~ *Collapsed
   (Stage 3): one `view_refresh_interval_ms` setting, defaulted in
   `useWindowedQuery` and inherited by every paged view and by
   `useHostMirror`, which gives up its own 500 ms as well.*
2. ~~Scratch cap floor — Rust ↔ TS, "keep in sync by convention".~~
   *Collapsed (Stage 1 item 3): stated once host-side as validation
   metadata, published to the frontend, no TS copy.*
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

- **ADR 0034 clarification.** *(done — Stage 3.)* Not the amendment
  first thought necessary; its `state.json` claim holds. What it needed
  was a sharper deciding question, and decision 1 now asks *is this a
  behavioural preference, or a memo about specific files and
  sessions?*, with `blf_channel_maps` as the worked example and a note
  that user-authored is not the same as a user preference. Task 46's
  descriptor/tagged-view amendment to the same ADR landed separately
  rather than folded in, because it shipped first.
- **Base directories: answered — no change, and it should stop being
  raised.** The question was whether `state.json` is misfiled by living
  in `app_config_dir` next to `settings.json`, given that XDG separates
  `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`.

  Checked against tauri 2.11.1's `PathResolver`
  (`tauri/src/path/desktop.rs`) and its `BaseDirectory` enum. It exposes
  `config`, `data`, `local_data`, `cache`, `runtime`, `home`, `temp`,
  `resource`, the `app_*` variants of those, and `app_log` — and **no
  state dir**. There is no `state_dir()` and no `BaseDirectory::State`.
  The underlying `dirs` 6.0 crate *does* have `state_dir()`, but it
  returns `Some` only on Linux (`$XDG_STATE_HOME`, else
  `~/.local/state`) and `None` on both macOS and Windows.

  So honouring `XDG_STATE_HOME` would mean bypassing Tauri's resolver,
  taking `dirs` as a direct dependency (a technology-inventory
  decision), and hand-rolling the macOS/Windows fallback that Tauri
  currently supplies — to move a best-effort, regenerable file. Against
  that: ADR 0011 says we drop rather than migrate, so the move would
  discard everyone's recents and last-project pointer. The cost is real
  and the benefit is XDG tidiness on one of three platforms.

  **Verdict: keep `state.json` in `app_config_dir`.** The scratch is
  correctly in `app_cache_dir` (it is genuinely disposable), and no
  Tauri-supported "state" root exists to move to. Revisit only if Tauri
  adds one.
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

- ~~Editing a keybinding and a setting in the same session cannot lose
  either, with a regression test proving it.~~ *(met — Stage 1 items 1
  and 5.)*
- Every value in `settings.json` means what the file says: no knob
  enforced at a value the file does not show. *(met for
  `scratch_cap_bytes` — Stage 1 item 3. Note the shape this took: a
  value the app cannot honor is **refused and reported**, not enforced
  at some other number. The file may still contain the refused text —
  it is the user's document — but nothing anywhere is running at a
  value the file doesn't show, and the system log says which value was
  refused and why. New knobs must follow the same rule.)*

  *Stage 4 extends this twice. A value of the wrong **shape** is now
  refused the same way and costs only its own field, instead of failing
  the whole document (item 4). And an **environment variable** that
  shadows a setting is the one case where the app genuinely runs at a
  value the file does not show — the escape hatch has to win, or it is
  not one — so it is reported on the system log naming the variable, the
  key, and both values. The criterion holds in its real form: nothing
  runs at a value nobody was told about.*
- One source of truth for each item in the duplicates list, or an
  explicit note saying why a copy stays.
- No user-facing knob promoted in Stage 3 changes behaviour for a user
  who never opens the settings file. *(Also met for Stage 4: each of
  its four fields defaults to the value the app already ran at — blank
  for the two paths, `debug` for the log file's minimum, `info` for the
  sidecar's — and the environment keeps winning, so an existing
  env-var user is unaffected whatever their file says.)*
- Every promoted field lands with its Task 46 tags already attached —
  no retrofit pass.
- `settings.json` on a fresh install lists every knob the app has, at
  its default — the ADR 0034 promise, still true at the new count.
