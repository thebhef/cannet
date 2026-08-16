# Task 78 — Automation-Instrumentation Cost Audit

Opened by owner ruling 2026-08-15 (mid-cycle, during the task-72
phases that extended the harness): "we need to make sure all of this
automation instrumentation is lightweight and has no adverse
performance impact _or_ that it gets disabled by default and/or costs
nothing if it's not used."

## Scope

Inventory every piece of automation/measurement machinery that ships
in the product binary, classify each as **product feature** (health
sampler, UI-liveness heartbeat — deliberately always on, cost
budgeted) or **harness-only** (perf capture, perf-interact scripts,
screenshot/DevTools hooks, hover-photograph support, DIAG
counters/gauges, `--app-data-dir`), and for the harness-only set
prove one of:

- **flag-gated off**: the code path is not scheduled/registered/opened
  at all on a normal launch (not "runs but does nothing"), or
- **measurably free**: cost when unused is indistinguishable from
  zero at the gate's sensitivity.

Fix anything that fails both. Candidates known at opening: the diag
reporter's 1 Hz tick (carries the product heartbeat — budget it
explicitly), `diagCount`/`diagGauge` call sites on render hot paths
(are they no-ops without a flag, and how cheap is the no-op?), the
WebView2 DevTools port (must not open unless requested), the
perf-interact tick scheduler, and any listener the screenshot/hover
machinery installs unconditionally.

## Grooming (2026-08-15, owner-confirmed)

Two phases, investigation-then-fix:

1. **P1 — inventory.** Every measurement/automation hook in the
   shipping binary enumerated and classified (product feature vs
   harness-only), with default state, unused cost, and evidence (code
   path or measurement) per row; the table lands in the status log.
   No fixes. **Includes** a bounded side-investigation attributing
   the screenshot-scenario empty-plot flake (recorded in 0072's
   blockers: ~1 in 3 runs across three binaries, correct on re-run) —
   it lives in the same harness code the inventory walks.
2. **P2 — fix.** Anything harness-only that is neither
   flag-gated-off ("not scheduled at all") nor measured-free at the
   ADR-0031 gate's sensitivity is fixed test-first; README/ADR-0031
   gain the flag inventory; product-feature costs come back to the
   owner as a stated budget for acceptance.

The draft exit criteria below are confirmed as written.

## Exit criteria (firmed at grooming, 2026-08-15)

- The inventory table lands in this file's status log: every hook,
  its classification, its default state, its unused cost, with the
  evidence (code path or measurement) per row.
- Harness-only machinery is flag-gated off or measured-free by the
  ADR-0031 gate's own sensitivity; anything fixed lands test-first.
- Product-feature instrumentation (health sampler, heartbeat) has
  its cost stated and accepted by owner ruling.
- README/ADR-0031 document which flags enable what, so an operator
  can see the full instrumentation surface in one place.

## Status log

### Phase 1 — the instrumentation inventory (2026-08-15)

Branch `task78-p1-inventory` off `task76-p3-retention-metrics`
(`3d5a25ba`). Investigation only; no product-binary change.

**Method.** Every row's default state is established from the code path
that would have to schedule / register / open it, cited by `file:line`.
Where the path proves the machinery is never reached on a plain launch,
the row is **flag-gated off** and closed. Where the path proves it *does*
run, the row cannot be closed by reading — the classification test's
other half ("measurably free at the gate's sensitivity") demands a
measurement, and none was taken in this phase. Those rows are listed as
*scheduled, freeness unmeasured* and carried to phase 2 rather than
waved through: "runs but does nothing" is exactly the verdict the task's
test refuses.

#### A. Flag-gated **off** — not scheduled / registered / opened on a plain launch

| # | Hook | Where | Class | Default state on a plain launch | Unused cost | Evidence | Enabled by |
|---|---|---|---|---|---|---|---|
| A1 | Perf autostart config | `diag.rs:651` (`from_args`), called `lib.rs:450` | harness-only | `None` — `seen.then_some(cfg)` returns `None` when no perf flag is present; `AutomationState(None)` managed (`lib.rs:494`) | one `argv` scan at boot, then nothing | `diag.rs:685`; unit test `autostart_absent_without_flags` (`diag.rs:936`) | `--project`, `--connect-on-start`, `--perf-capture-secs`, `--perf-out`, `--perf-label`, `--perf-interact` |
| A2 | Frontend automation run | `App.tsx:2082` | harness-only | `if (!automation) return` — the whole connect / capture / interact body is unreachable | one `invoke("diag_autostart")` round-trip at boot (`App.tsx:2858`), returning `null` | `App.tsx:2082`, `diag.rs:697` | same flags as A1 |
| A3 | `--perf-interact` tick scheduler | `perfInteract.ts:177` (`startPerfInteraction`, `setInterval` @ 150 ms) | harness-only | **no interval is created**: the only call site is `App.tsx:2193`, inside A2's guard *and* behind `automation.interact != null` (`App.tsx:2192`) | zero | `App.tsx:2192-2196` | `--perf-interact <script>` |
| A4 | Perf capture machinery (`--perf-capture-secs` / `--perf-out`) | `diag.rs:495/516/544`, registered `lib.rs:600-602` | harness-only | commands are *registered* (a match arm in Tauri's generated dispatch) but never *invoked*: the frontend calls `diag_push` only while `capturing` (`diag.ts:199`), and `capturing` is set only by `beginDiagCapture` (`diag.ts:107-110`) | `DiagState::default()` is one `Mutex<Capture>` holding `active: false` and an empty `Vec` (`lib.rs:493`); no thread, no timer, no per-tick allocation | `diag.ts:199`, `diag.rs:466-482` | `--perf-capture-secs`, or `window.__cannetPerf.begin()` from the console |
| A5 | Host process-memory sampler (`MemSampler`) | `crash.rs:549` | harness-only | not constructed — built in `diag_capture_start` (`diag.rs:505`), dropped in `diag_capture_finish` (`diag.rs:552`) | zero | `diag.rs:505/552` | an armed capture |
| A6 | `exit_process` | `diag.rs:709`, registered `lib.rs:604` | harness-only | registered, never invoked — both call sites (`App.tsx:2185`, `App.tsx:2226`) are inside A2's guard | zero. (`final_exit_code` / `run_return`, `lib.rs:418/711`, are unconditional but are one branch at process exit) | `App.tsx:2082` | a failed capture run |
| A7 | `--app-data-dir` redirection | `lib.rs:456` (`config_dir_override`) | harness-only | `None` → `ConfigDirOverride(None)` (`lib.rs:486`) and the default window-state filename (`lib.rs:463`); no directory created (`lib.rs:457`) | one `argv` scan at boot | `lib.rs:456-463` | `--app-data-dir <path>` |
| A8 | **WebView2 DevTools port** | not in the product at all | harness-only | **closed.** `apps/gui/src-tauri/Cargo.toml` takes `tauri = { version = "2", features = [] }` — no `devtools` feature, so a release build carries no inspector; and no `--remote-debugging-port` or `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` exists anywhere under `apps/`. The port is opened by the **WebView2 runtime** reading an env var the *harness* sets on the child it spawns (`screenshot.rs:672-686`), alongside an isolated `WEBVIEW2_USER_DATA_FOLDER` | zero; no listening socket on a plain launch | repo-wide grep for `remote-debugging` / `ADDITIONAL_BROWSER_ARGUMENTS` hits only `crates/cannet-perf-measurement/**`, `plans/`, `docs/` | the harness (or an operator) exporting `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` before launching |
| A9 | Screenshot / hover-photograph driving | `screenshot.rs:123` (`PRELUDE_JS`), `screenshot.rs:199` (`hoverPlot`) | harness-only | **nothing ships.** The whole driving surface is JS injected over CDP into a running page by the harness. The hover-photograph step (task 72 p9) is `3e97c3ff`, whose diff is **one file, `crates/cannet-perf-measurement/src/screenshot.rs`, +86 lines** — no product change | zero | `git show --stat 3e97c3ff` | running `cannet-perf-measurement screenshot` |
| A10 | Harness selector hooks in the DOM (`data-testid` ×8 across `SplashOverlay.tsx` / `ProjectPanel.tsx` / `ConnectionManagement.tsx`; `data-area-id` at `PlotArea.tsx:3369`) | as listed | harness-only *hook*, product *markup* | present in the DOM | constant string props on an element already being rendered; nothing scheduled. `data-area-id` predates the harness (`4fcd499e`, PR #121) | `PlotArea.tsx:3369`, `SplashOverlay.tsx:37` | n/a — always present |

#### B. Product features — always on by design; the cost is a budget for the owner

| # | Hook | Where | Default state | Cost per tick | Evidence |
|---|---|---|---|---|---|
| B1 | **Health sampler** | `crash.rs:317`, spawned unconditionally at `lib.rs:672` | on, every **20 000 ms** (`settings.rs:566`); `0` switches it off, with a 5 s re-check poll (`crash.rs:99/342`) | a **full system process-table refresh** (`ProcessesToUpdate::All`, `crash.rs:475-481`) plus `refresh_memory`, then a tree walk classifying WebView children; plus `trace_store.len / buffer_seconds / frames_per_second / scratch_breakdown()`; plus **`signal_caches.usage()`** (`signal_cache.rs:1966` — takes the signal-cache mutex, the same lock a plot serve takes, and iterates every live pyramid summing `bytes()`); then one `sys_debug!` System Message into the ring, the panel and the rolling log | `crash.rs:339-398` |
| B2 | **UI liveness heartbeat** | `diag.ts:192` → `report_js_heap` (`lib.rs:220` → `crash.rs:151`) | on, 1 Hz, unconditional and deliberately so — the call's *arrival* is the only way a wedged renderer reaches `cannet.log` (`diag.ts:181-187`) | one IPC round-trip and one relaxed atomic store per second | `diag.ts:188-192`, `crash.rs:151` |
| B3 | 1 Hz diagnostic reporter tick | `diag.ts:140`, mounted unconditionally at `App.tsx:295` | on, one `setInterval(…, 1000)` | carries B2. Everything on the tick that is *not* B2 is row C1 | `App.tsx:295` |
| B4 | `trace-grew` emitter | `emitters.rs:139`, spawned `lib.rs:673` | on, **100 ms** (`settings.rs:561`); skips the emit when count / fps / session-start are unchanged | one `status_snapshot()` lock acquisition per tick; the tail decode only on a tick that emits | `emitters.rs:139-175` |
| B5 | Trace flusher | `emitters.rs:224`, spawned `lib.rs:674` | on, **2 000 ms** (`settings.rs:562`); `continue`s when the buffer hasn't grown | `flush_async` plus the pyramid harden budget | `emitters.rs:224-258` |
| B6 | Clock-status emitter | `clock_status.rs:106`, spawned `lib.rs:675` | on, **1 s** (`clock_status.rs:32`) | polls each *active* session's clock record; none when disconnected | `clock_status.rs:100-110` |
| B7 | mDNS `_cannet._tcp` browse | `server_browse::spawn`, `lib.rs:694` | on for the app's lifetime (ADR 0040) | a background browse thread and its socket. Not instrumentation — listed because it is part of the always-on background surface an operator sees | `lib.rs:693-694` |

#### C. Scheduled on a plain launch, freeness **unmeasured** → phase 2

These rows fail "the code path is not scheduled at all". None is
measured free yet, so none is closed.

| # | Hook | Where | Class | What runs unconditionally | Recommended fix shape (phase 2) |
|---|---|---|---|---|---|
| C1 | The reporter's **console line** and counter-delta build | `diag.ts:166-198` | diagnostic | every second: iterate `counts` building a delta object, `new Map(counts)` clone, build a rounded gauge object, `JSON.stringify` both, one `console.log` (`diag.ts:196`) | gate the console line and the delta / clone work behind a flag (a launch flag, or a `window.__cannetPerf` toggle), keeping B2's `report_js_heap` unconditional. The delta map is also what `diag_push` needs, so build it only when capturing or when the console stream is enabled |
| C2 | `longtask` `PerformanceObserver` and its probe line | `diag.ts:148-164` | diagnostic | one `PerformanceObserver` observing `longtask` is registered at mount and never disconnected; plus one `console.log` at mount (`diag.ts:164`) | register the observer only while a capture is armed, or behind C1's flag. `longtask` entries are consumed only by the 1 Hz reporter and the capture |
| C3 | `diagCount` | `diag.ts:78`; ~40 call sites (`App.tsx` 23, `PlotArea.tsx` 18, `PlotPanel.tsx` 7, one each in 11 more files) | diagnostic | **not a no-op.** `Map.get` + `Map.set` + add + a compare on every call. All call sites are per-render or per-event — the hottest are `render.PlotArea` (`PlotArea.tsx:1110`), `render.App` (`App.tsx:287`), `plotarea.resample` (`PlotArea.tsx:1623`) — none is per-point or per-frame | either measure it free at the gate's sensitivity (an A/B release capture with the body stubbed) and record the number, or make the body a flag-checked early return so the Map traffic disappears when off |
| C4 | `diagCount`'s **burst logger** | `diag.ts:67-91` | diagnostic | every `BURST_EVERY = 5000` counted events: clone the whole `counts` Map, build a delta object, `JSON.stringify`, `console.log` — synchronously inside `diagCount`, i.e. on a render-triggered path | same flag as C3. This is the most defensible row to gate: it exists for one past freeze hunt and does allocation and serialization inline |
| C5 | `diagGauge` / `diagTime` | `diag.ts:33` / `diag.ts:41` | diagnostic | one `Map.set` per gauge; `diagTime` adds two `performance.now()` calls per wrapped `invoke` | same flag as C3 |
| C6 | `window.__cannetPerf` global | `diag.ts:214` | harness-only | installed on **every** launch — the console-scriptable capture entry point. Cost is effectively zero; this is an always-present *automation surface* rather than an always-present *cost* | owner call: keep it (it is the documented manual path in ADR 0031) or install it only under a flag. Record the decision either way |
| C7 | `HostMetrics` max-recorders | `diag.rs:52`, called from `emitters.rs:269` and `transmit_commands.rs:350` | diagnostic | one relaxed CAS loop on an `AtomicU64` per flush tick (≈0.5 Hz) and per scheduler second (1 Hz, only while transmitting) | leave as is, but fold it into C1's A/B measurement rather than asserting it free |
| C8 | `tx-flush` / `tx-sched` dev-log lines | `emitters.rs:274`, `transmit_commands.rs:341` | diagnostic | one formatted `tracing::info!` line per flush that moved (≈0.5 Hz) and per scheduler-second with wakes (1 Hz). Routed **only** to the stderr `fmt` layer — `init_tracing_subscriber` registers `filter + fmt::layer()` and nothing else (`system_log.rs:355-364`) — so these do **not** reach the System Messages ring or `cannet.log` | leave as is, or put both behind an `EnvFilter` target opt-out. Docs note: their stderr-only routing is written down nowhere |
| C9 | `AutomationConfig::from_args` and `config_dir_override` argv scans | `lib.rs:450`, `lib.rs:456` | harness-only | two full `argv` walks at boot on every launch | none needed — a boot-time constant. Listed for completeness |

*Every row in this section is dispositioned in the phase-2 entry below;
C1–C8 are now flag-gated off, C9 is argued and left.*

#### Phase-2 fix list (rows failing both tests)

C1, C2, C3, C4, C5 — one flag closes all five, and they are the only
rows with per-render work in them. C6 is an owner call about surface,
not cost. C7, C8, C9 are argued-cheap but unmeasured; the honest
disposition is to fold them into the same measurement rather than
assert them free.

Any "measurably free" claim has to be made against the ADR-0031 gate's
own sensitivity, so the phase-2 measurement is an A/B pair of release
captures taken on one machine in one session (ADR 0031's "compare
within one session" rule), at baseline scenario length.

#### What is **not** in the product binary (established, not assumed)

- No DevTools port, no inspector, no `devtools` Cargo feature (A8).
- No screenshot / hover driving code, no injected helpers, and no
  listener the screenshot machinery installs — the entire surface is
  CDP-injected by the harness at run time (A9); task 72 p9's
  hover-photograph step changed one harness file and nothing else.
- No perf-interact interval, no capture timer, and no memory-sampler
  construction without their flags (A3, A4, A5).

### Phase 1 — the screenshot-scenario empty-plot flake, attributed (2026-08-15)

Carried in from task 0072's blockers: the `extrapolation` scenario
writes an empty `02-extrapolated-stretches` about one run in three —
x axis 0–1 s, every side readout `— %` — across three binaries and both
themes, correct on re-run. The recorded suspicion, explicitly untested,
was that something after the "Loading trace…"-clear wait is not settled
when **fit x axis** is pressed.

**That suspicion is wrong.** The fit is a bystander.

#### Observation

A frame alone cannot say whether the *buffer* was empty too, so the
harness was given a probe first (`65e27674`): after each shutter it
reads back the app's own status line and the plot panel's text, and it
taps `console.log` so the app's 1 Hz `[diag]` counters and gauges land
in a `notes.txt` beside the PNGs. Then 31 runs of the scenario against a
release build of `9eea717c` (`cargo build --release -p cannet-gui
--features custom-protocol`, i.e. the frontend embedded), each ~27 s.

The first reproduction (run 14, light theme) said this:

- Status line at the shutter: `"Open a BLF log or connect to a server to
  begin."` — the **frontend** has no capture. All four numeric readouts
  `— %`; x axis 0.0000–1.0000 s, exactly the recorded symptom.
- Host at the same moment (`cannet.log`): `trace_len=871 buffer_s=20.0`
  — the **host store is full**. The import ran and finished
  (`opened BLF …: 871 objects`, `frame source ended cleanly (871
  frames)`, `Done: 871 frames`).
- `pyramids=[live=0 …] pyr_depth=0` — the signal pyramids were wiped
  and not rebuilt, where a healthy run of the same scenario logs
  `pyramids=[live=7 …] pyr_depth=4`.
- No `trace-grew` and no `followwin.slide` in any tapped second; the
  `count` / `ext` / `winw` gauges are stale readings from before the
  import.
- And the one line no healthy run has:
  `INFO project: restored 871 frames from prior capture in 76 ms`,
  logged at boot, **before** the scenario's import.

#### Hypothesis

*The flake needs a boot-time scratch restore: a launch that restores a
prior session's capture and is then driven through a BLF import leaves
the frontend's trace view empty, while the host store refills.*

#### Experiment

Every run's `cannet.log` block says whether that launch restored. Score
all 31 runs on (restored at boot?) × (empty frame?). The hypothesis is
falsified by a single empty frame in a launch that did not restore.

#### Data

| | empty frame | good frame |
|---|---|---|
| **restored at boot** | 7 | 6 |
| **did not restore** | **0** | 18 |

Runs 1–7 shared one profile (alternating restore / no restore); 8–11
used four separate scratch project directories, so each was cold and
none restored; 12–25 shared a second profile; 26–31 verified the guard.
Not one of the 18 non-restoring launches produced an empty frame. On
the first 25 runs alone (4/10 vs 0/15) the hypergeometric probability of
all four empties landing in the restore group by chance is
C(10,4)/C(25,4) ≈ 0.017; over all 31 it is C(13,7)/C(31,7) ≈ 0.00065.
The last six runs then reproduced the recorded rate exactly — three
empty in six, alternating with the restore.

#### Conclusion

The mechanism is **restore-then-import**, and it is a product defect,
not a harness one:

1. The harness ends a run by killing the process tree, leaving a
   flushed scratch capture behind.
2. The next launch restores it (`restore_scratch_capture`) — the
   session comes up holding 871 frames.
3. The scenario then drives an import of the same BLF. The host clears
   and refills correctly (`trace_len=871`), but the frontend's trace
   view is left reporting an empty capture, and the pyramids are wiped
   without rebuild.
4. **fit x axis** is then handed nothing to fit, and
   `PlotPanel.tsx:879` falls back to `max = start + 1` — which, with
   `sharedStart()` at 0, *is* the recorded 0–1 s axis.

Step 4 is the only part the earlier suspicion saw. With the guard in
place the run now fails at **step 01**, not 02: the frame was already of
an empty app one step before the fit. `first_duplicate` never caught it
because 01 and 02 differ — by exactly the axis the fit collapsed.

The alternation is the reason the rate looks like "about a third": a
launch that restores and then imports leaves the scratch in a state the
*next* launch will not restore, so restores land on every other run, and
a fraction of those go wrong.

#### For phase 2 / the owner

- **The product defect is not fixed here** — a product-binary change is
  phase 2's, and this one is not small: an import on top of a restored
  capture leaves the view empty. It is reachable by a user (reopen the
  app, then import a trace), not only by the harness. Recommended fix
  shape: make the import path re-anchor the frontend's trace element the
  same way a fresh session's does, and cover it with a test that
  restores a capture and then imports over it.
- **The harness guard landed** (`65e27674`, test-first): a scenario
  given a capture now fails the run, naming the step, when the app
  reports an empty buffer at the shutter. This is what phase 8 asked for
  — "an eyeballed set catches it, an unattended gate would take it."
- **The scenario cannot isolate its session buffer.** `--app-data-dir`
  moves the *config* scope only (`persisted_json.rs:347-353`);
  `resolve_project_dir` reads `app.path().app_cache_dir()` directly
  (`lib.rs:246`), which the flag does not touch. So every screenshot and
  perf run shares one capture scratch with the operator's own sessions,
  and inherits whatever the previous run left in it. That is the
  harness-side root of the nondeterminism, and it is a real gap against
  ADR 0031's isolation claim.

### Phase 2 — the gate fixes (2026-08-15)

Branch `task78-p2-gate-hooks` off `task78-p1-inventory` (`6abb5686`).
The working tree was clean at start, so there is no carry-forward
commit.

**The shape of the fix.** Phase 1 found one flag closes C1–C5, and it
closes C6 with them: `--diag`, parsed host-side
(`diag::diag_enabled_from_args`) and served to the webview through a new
`diag_enabled` command, which `App` asks in the same effect that starts
the reporter. The four `--perf-*` flags **imply** it — a capture's
payload *is* those counters, so no measurement invocation has to
remember a second flag — while `--project` / `--connect-on-start` /
`--app-data-dir` do not: they open and connect, they don't record.
Disarmed, `diagCount` / `diagGauge` return before touching a Map,
`diagTime` returns the promise it was handed, no `PerformanceObserver`
is constructed, no line is logged, and nothing is installed on `window`.
The reporter's 1 Hz timer stays unconditional because it carries B2, the
UI-liveness heartbeat.

Two consumers had to keep working, and both are covered by tests. The
screenshot harness launches with `--diag` (`gui_args`) — its console tap
exists to read those counters into each run's notes. And the frontend
suite arms them in a `vitest.setup.ts`, because ~10 test files assert
render / rebuild counts through `diagCounts()` and would otherwise
compare 0 against 0 forever; `diag.gate.test.ts` disarms explicitly to
test the shipped default.

#### Per-row disposition

| Row | Fix | Test | New class |
|---|---|---|---|
| C1 reporter console line + delta build | the delta / clone / stringify / log half of the tick is behind `enabled`; the heartbeat above it is not | `diag.gate.test.ts` — "registers no longtask observer and logs no console line" and "still beats the UI-liveness heartbeat every second" | **A** (flag-gated off) |
| C2 `longtask` observer + probe line | observer moved to module scope, constructed by `setDiagEnabled(true)` and disconnected on disarm; the probe line moved with it | same test asserts **zero** `PerformanceObserver` constructions (a fake global records every construction) | **A** |
| C3 `diagCount` | `if (!enabled) return` ahead of the Map traffic | "counts nothing, so no Map traffic reaches a render path" | **A** |
| C4 burst logger | same guard — the clone / stringify / log is inside `diagCount` | "does not fire the burst logger" (12 000 counts, `console.log` never called) | **A** |
| C5 `diagGauge` / `diagTime` | same guard; disarmed, `diagTime` returns the promise without the two `performance.now()` reads | "records no gauges, and times nothing around an invoke" (spies on `performance.now`) | **A** |
| C6 `window.__cannetPerf` | installed by `setDiagEnabled(true)`, deleted on disarm — so the surface is absent on a plain launch. `beginDiagCapture` arms diag itself, so the automation path (which calls it directly) is unaffected and a manual capture can never reduce to a report of zeros | "puts no capture entry point on window"; "takes the observer and the window surface back down when disarmed"; "arms itself when a capture starts" | **A** |
| C7 `HostMetrics` max-recorders | `armed: AtomicBool`, set by `diag_capture_start` and cleared by `diag_capture_finish`. Nothing but `diag_push` ever drains these maxima, so outside a capture the CAS was pure waste; unarmed a `record_*` call is one relaxed load and a return | `host_metrics_record_nothing_until_a_capture_arms_them` (diag.rs) | **A** |
| C8 `tx-flush` / `tx-sched` | **gated, not kept.** Phase 1 established they reach stderr and nothing else — no System Messages ring, no `cannet.log` — so on a windowed launch they format ~1.5 lines a second for no reader. The default filter is now a named constant with both targets `off`; any `RUST_LOG` value brings them back (it replaces the filter wholesale), so the stall-hunt pair is intact | `the_default_filter_drops_the_transmit_dev_lines_but_keeps_the_apps_own` — a recording layer behind `EnvFilter::new(DEFAULT_LOG_FILTER)`. Verified on the release binary too: 0 lines across four 150 s runs, 20 + 38 lines in a 45 s run under `RUST_LOG=info,…` | **A** |
| C9 argv scans | **left, argued.** Now three walks of `argv` at boot rather than two (`--diag` parses separately, so the automation config's shape is untouched). It is a one-time O(argc) cost before the window exists; the gate has no metric that can see it, so no measurement is claimed | none | left (boot-time constant) |

#### The measurement

One session, one machine, the tip (`3fb20d7e`) built with
`pnpm --dir apps/gui tauri build --no-bundle` — the operator's own app
was closed for the whole run set, and nothing else was driven.

**The gate's own instrument cannot see its own absence.** A
`RenderReport` is produced by the machinery under test: with the
counters disarmed there is no capture to compare. So the A/B is taken on
the instrument that exists in *both* configurations — the health
sampler's 20 s line in `cannet.log`, whose `fps` (host receive
throughput), `webview_mb`, `rss_mb` and `jsheap_mb` are the same
quantities the gate's `rx_fps` and `mem.*` gauges report. Four 150 s
runs of the `ev-zonal` project under `--connect-on-start`, ABBA
(off, on, on, off) so run order cancels to first order, means over the
five steady-state samples of each run (the first two are boot and
connect settle):

| | off1 | on1 | on2 | off2 | **off** | **on** | Δ |
|---|---|---|---|---|---|---|---|
| `fps` | 3204.8 | 3327.2 | 3223.2 | 3208.6 | **3206.7** | **3275.2** | +2.1% *armed* |
| frames received in 150 s | 436 032 | 434 676 | 432 132 | 436 348 | **436 190** | **433 404** | −0.6% armed |
| `webview_mb` | 751.8 | 773.0 | 770.8 | 748.6 | **750.2** | **771.9** | +2.9% armed |
| `rss_mb` (host) | 63.4 | 63.2 | 63.6 | 63.4 | **63.4** | **63.4** | 0 |
| `jsheap_mb` | 60.2 | 54.8 | 71.6 | 54.2 | **57.2** | **63.2** | noise (per-run readings span 32–91) |

Read: **throughput cannot see the machinery.** The two throughput
measures disagree in sign — armed runs read 2.1% *more* frames per
second and 0.6% fewer frames overall — which is what "below the noise
floor" looks like, and host RSS is identical to the megabyte. The one
consistent signal is WebView memory: both armed runs sit above both
disarmed ones, ~+22 MB (+2.9%), which is the counter Map, the per-second
delta and gauge objects, and the console line's retained strings. With
n=2 per arm that is suggestive rather than conclusive, and it is a cost
the product now only pays when a measurement asked for it.

**The armed path is unregressed.** The ADR-0031 capture at the tip
(60 s, `ev-zonal`, `--connect-on-start --perf-capture-secs 60`, i.e.
`--diag` implied) produced a full report — 17 counters, 19 gauges,
`flush_ms` mean 4.85 / max 14.55 and `tx_late_ms` mean 7.19 / max 31.02
proving the newly-armed `HostMetrics` records — with `rx_fps.overall`
1604.7 (retention 0.99), `lag` mean 0.0083 / max 3.0, `longtask` 0, jank
0. The most recent committed frontend report (`ea9646a`, task 75 p5
run 3, a different session, so a weaker comparison per ADR 0031) reads
`rx_fps.overall` 1607.2 (retention 0.995), `lag` mean 0.0083 / max 4.6,
`longtask` 0. No baseline was promoted.

#### B rows: the health sampler's `signal_caches.usage()`

Looked at, **not implemented**, per the phase brief's condition. Keeping
the numbers without the plot-serve mutex is not a trivial
behaviour-preserving swap: `usage()` returns eight fields, and three of
them (`unread`, `unread_bytes`, and `live`) are derived by *filtering
and summing over the live map* at read time — `unread_bytes` calls
`bytes()` per unread pyramid. A relaxed-atomic mirror would have to be
maintained at every mutation site that creates, reads-from, parks,
revives or evicts a cache, and each of those is a place the mirror can
drift from the map it claims to describe. That is a real change with its
own test burden, not a seam. Left for the owner with the rest of the
B-row budget.

## Blockers / side effects

- **`--app-data-dir` does not isolate the capture scratch.** As above:
  the flag redirects `app_config_dir()` but not `app_cache_dir()`, so a
  measurement or screenshot run writes its trace segments, filter index,
  pyramids and notes into the operator's real
  `%LOCALAPPDATA%\dev.cannet.app\cache\<hash>`, and reads back whatever
  a previous run left there. ADR 0031 says a run "must not write the
  operator's state" and names `--app-data-dir` as "the whole isolation
  mechanism"; the capture scratch is outside it. Not fixed here (it is a
  product-binary change). It is also why the flake above is reachable at
  all.
- **The plot re-samples ~30×/s over a stopped, fully imported
  capture.** Read off the console tap in every healthy run:
  `plotarea.resample` 28–30/s and `followwin.slide` 14–16/s, held for
  the whole run, on an 871-frame BLF that finished importing seconds
  earlier and is not growing. The trace element still reads `RUNNING`
  after a file import ends. Noticed while instrumenting, not chased —
  but it is unused cost of exactly the kind this task exists to find,
  and it is on the render hot path.
- **`signal_cache::tests::the_invalidated_subset_rebuilds_in_one_walk_of_its_message`
  is machine-speed dependent** (phase 2, pre-existing). It failed on the
  untouched `task78-p1-inventory` tree at the start of the phase-2
  session — before any edit — passed on the next full run, then failed
  three runs in a row while the machine was busy with release builds,
  and passes every time when run alone. The mechanism is in the code it
  exercises: the catch-up scan stops on a wall-clock budget
  (`ServeLimit::Deadline`, `signal_cache.rs:2677`, checked at `:1686`),
  so on a slow moment it does one chunk where the test asserts two
  (`fetches` 1 vs `len.div_ceil(CATCH_UP_CHUNK_FRAMES)` = 2). It is a
  test that measures the machine, and it gates the pre-commit hook — two
  commits in this phase needed a retry to land. Not fixed here: it is
  outside this task's scope and the fix is a decision about how that
  test should pin the chunk count without a clock.
- **A capture cannot measure its own absence.** The `RenderReport` is
  produced by the machinery under test, so with the counters disarmed
  there is no report to compare — the phase-2 A/B had to be taken on the
  health sampler's line instead. Worth knowing before anyone asks the
  gate to prove a future instrumentation cost is zero: the gate can
  compare two armed configurations, and nothing else.
- **The release binary in `target/` was not a `tauri build`.** The
  first reproduction attempt spent a 90 s boot timeout on it: a plain
  `cargo build --release -p cannet-gui` has no embedded frontend, comes
  up on the dev-server error page, and its health line says so
  (`jsheap_mb=? ui_last_ms=?` — React never mounted). Worth knowing
  before the next screenshot run: `--features custom-protocol` is what
  embeds the frontend, and is much faster than the full `tauri build`
  because it skips the sidecar freeze and server staging.

## Exit-criteria walk (2026-08-15, orchestrator, at the cycle tip `f21aa13f`)

1. **The inventory table lands in the status log — MET.** Phase 1:
   26 rows, each with location, classification, default state, unused
   cost, and evidence (code path or measurement).
2. **Harness-only machinery flag-gated off or measured-free;
   fixes test-first — MET.** Phase 2: C1–C8 moved to class A behind
   `--diag` (off = not scheduled: zero observer constructions, no Map
   traffic, no automation surface, one relaxed load on the atomics,
   dev-log lines behind the default filter), each with its named
   test; C9 (one-time O(argc) argv scans at boot) recorded as left
   with the argument no gate metric can see it. The armed path is
   proven working by the phase's own ADR-0031 capture.
3. **Product-feature instrumentation cost stated and owner-accepted —
   STATED, acceptance PENDING.** The budget rows: 20 s health sampler
   (full process-table refresh + `signal_caches.usage()` under the
   plot-serve mutex), 1 Hz UI heartbeat (one IPC round-trip/s,
   deliberately unconditional), ~22 MB WebView memory when diag is
   armed (A/B-measured; paid only when asked). Owner ruling closes
   this criterion at the consolidated review.
4. **README/ADR-0031 document the flag surface — MET.** README's
   instrumentation-surface table (always-on vs what turns each flag
   on); ADR 0031 records `--diag` and the binding "off means not
   scheduled" property.

Verdict: **3 of 4 MET; criterion 3 stated and awaiting the owner's
acceptance ruling** — the walk closes with that ruling recorded here.
