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
