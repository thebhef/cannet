# Task 161 — A Bus-Off Controller Comes Back

Opened 2026-10-03 from the owner's PEAK bench: disconnecting the CAN
side of a dongle and reconnecting it left the bus bus-off for good,
with the transmit side silent. Owner ruling: "going bus-off can be a
transient thing… the bus should just recover", and **Kvaser and Vector
behave the same as PEAK**.

## Root cause (from the code, 2026-10-03)

- PCAN channels are opened without `auto_reset`
  (`_bus_kwargs_for`, `driver_python_can.py`, `pcan` branch), so
  python-can never sets `PCAN_BUSOFF_AUTORESET`; PCAN-Basic holds the
  controller bus-off until `CAN_Reset` or a reopen, and nothing in the
  repo does either (`git log -S auto_reset` is empty; the only reopen
  path is `SharedInterface.reconfigure`, on a config change).
- Bus-off is detected (`_pcan_state` → `STATE_BUS_OFF` →
  `CONTROLLER_STATE_BUS_OFF`) and only displayed.
- Every `send` on the bus-off channel raises → `TxRejected` →
  `TX_REJECTED`; the tx pump lives on, nothing reaches the wire.
- The written design assumed otherwise: ADR 0039 § 3 ("even one that is
  bus-off… recovers on its own — the error counters fall on every
  successful transmission"), README's bus-health passage, and ADR 0022's
  rejection of a reset envelope ("recovery can come from stop + start").
  A bus-off controller transmits nothing, so its counters cannot fall.

## Scope

1. **Recover on every vendor** (one phase, Opus — the Kvaser and Vector
   behaviour must be established from CANlib / XL API documentation and
   python-can's backends, not assumed; only PEAK hardware is on the
   bench):
   - PEAK: `auto_reset=True` in the `pcan` kwargs (driver-side
     automatic bus-off reset).
   - Kvaser, Vector: whichever of the driver's own auto-recovery
     setting or an explicit bus-off reset the API offers; where
     python-can exposes neither, the sidecar backstop below is the
     mechanism.
   - **Sidecar backstop, vendor-neutral:** `SharedInterface._state_pump`
     seeing `BUS_OFF` persist past a short threshold (≈1 s; the
     controller's own 128 × 11-bit recovery is milliseconds) resets the
     channel through a driver hook (`OpenChannel.reset()` — PCAN
     `bus.reset()`; else reopen as `reconfigure` does). The state poll
     then shows `BUS_OFF → ACTIVE`, which is the user-visible recovery.
   - Tests: kwargs per vendor; fake driver reports bus-off → the pump
     resets once the threshold passes and not before; a reset that
     fails is logged and retried on the next pass, never tight-looped.
   - Docs in the same commit: ADR 0039 § 3 and its 2026-09 note,
     ADR 0022's reset-envelope paragraph, README bus-health passage —
     the premise is corrected, not annotated.
2. **Owner bench confirmation** on PEAK, same sitting as 121/160:
   disconnect the CAN side under RBS, reconnect; the bus-health panel
   shows bus-off then active; transmit resumes without a reconnect.

Branch sits in the stack **beside the last driver change**
(`task155-kvaser-unwrap`): created off the code tip, then moved onto
`task155-kvaser-unwrap` with the upstack restacked over it.

## Exit criteria

1. On every vendor the sidecar opens, a controller that goes bus-off
   returns to active without user action, within the backstop
   threshold, pinned by tests against the fake driver.
2. ADR 0039, ADR 0022 and README no longer say a bus-off controller
   recovers on its own.
3. Owner confirms on the PEAK bench.

## Blockers / side effects

- 2026-10-03 (owner bench, tip build): **after recovery there is a period
  of faster, irregular frames.** Root cause: the PEAK driver's transmit
  queue — `CAN_Write` keeps accepting frames during the open circuit
  (refusing only when full), the controller retries the head frame, and
  on reconnect the backlog drains at the bus's maximum rate; nothing
  below the host scheduler has a deadline. **Ruled accepted** ("if it's
  in the peak driver or python-can I accept it"). A sidecar-side bound
  (frames handed to the driver minus echoes received, capped, with
  `flush_tx_buffer()` past the cap) would remove it; not work.
- 2026-10-03: **The reopen backstop opens the new channel before closing
  the old one** (the `reconfigure` swap it shares). Whether PCAN-Basic
  accepts initialising a channel that is still open, and whether closing
  the old handle then disturbs the new one, is untested — on PEAK the
  driver's auto-reset recovers first, so the backstop's reopen path has
  not run on hardware. `reconfigure` carries the same exposure today.

## Status log

- 2026-10-03 — opened; root cause from code (above).
- 2026-10-03: phase 1 landed (`task161-bus-off-recovery` c49031ce as built off `fix-events-checklist-inline`; moved by the overseer onto `task155-kvaser-unwrap` per the owner's ruling → `18a99527`, the upstack restacked over it (28 branches; ADR 0039 and the PCAN kwargs test resolved both ways, sidecar 257 passed at each)). The diff stays inside the sidecar, its tests, ADR 0039, ADR 0022 and README. Nothing under apps/ or crates/ changed.
  - **What recovers the bus, per vendor:**

    | Vendor | Driver-side auto-recovery | Sidecar backstop (bus-off for at least 1 s) |
    |---|---|---|
    | PEAK | `auto_reset=True`, which sets `PCAN_BUSOFF_AUTORESET`. PCAN-Basic resets the controller on the next GetStatus, Write or Read that sees bus-off, and the poll calls GetStatus every 0.5 s | reopen (`PcanBus.reset()` is `CAN_Reset`, which clears the queues only) |
    | Vector | none that python-can exposes | in place: `VectorBus.reset()` = `xlDeactivateChannel` + `xlActivateChannel` |
    | Kvaser | none (see below) | in place: all handles `canBusOff`, then `canBusOn`, with the bus-on timer reset turned off first |
    | other / no hook | none | reopen through the same swap code as `reconfigure` |

  - **Sources:**
    - python-can 4.6.1 (`.venv/Lib/site-packages/can/interfaces/`):
      - `pcan/pcan.py:242,335`: the `auto_reset` kwarg sets `PCAN_BUSOFF_AUTORESET`. python-can's docstring says the driver reset takes about 500 ms.
      - `pcan/basic.py:773-781`: `Reset` docstring says "A reset of the CAN controller is not performed".
      - `pcan/pcan.py:698`: the `PcanBus.state` setter only toggles `PCAN_LISTEN_ONLY`. It is no reset.
      - `kvaser/canlib.py`: no `state`, no `reset`, and neither `canReadStatus` nor `canResetBus` is bound. It binds `canBusOn`, `canBusOff` and `canIoCtl`.
      - `bus.py:502-512`: the `BusABC.state` getter always returns ACTIVE, and the setter raises NotImplementedError.
      - `vector/canlib.py:978`: `reset()` = deactivate + activate.
    - Kvaser CANlib reference:
      - kvaser.com/canlib-webhelp/group___c_a_n.htm: `canResetBus` "tries to reset a CAN bus controller by taking the channel off bus and then on bus again". `canBusOff`: the channel goes off bus only "if no other handle is active".
      - canstat_8h.htm: `canSTAT_ERROR_PASSIVE` 0x1, `BUS_OFF` 0x2, `ERROR_WARNING` 0x4.
      - `canIOCTL_SET_BUSON_TIME_AUTO_RESET` resets the **CAN clock** at bus-on (default 1). It is about timestamps, not bus-off recovery.
      - The docs describe no automatic bus-off recovery.
    - Vector XL manual (idoc.pub copy of the XL Driver Library description; Vector's own PDF returned 403): "XL_CHIPSTAT_BUSOFF The bus is offline". `xlDeactivateChannel`: "channels go off the bus". The manual describes no automatic recovery.
    - PEAK (docs.peak-system.com BusOffAutoReset, documentation.help CAN_Reset): CAN_Reset clears the queues only. AUTORESET resets the controller when GetStatus, Read or Write sees bus-off, and keeps filters and configuration.
  - **Scope addition:** Kvaser state detection. python-can's KvaserBus has no state getter (BusABC's returns ACTIVE), so the backstop could never fire for Kvaser. `_KvaserApi` binds `canReadStatus` and `canReadErrorCounters` against python-can's loaded DLL, using the same `worse_state` rule as PEAK and Vector. It is unverified on hardware, like Vector, and the README says so.
  - **Falsification:** I copied the package with the three source files restored from 67692db6 and ran the new and changed tests against it: 13 failed, 9 errors (the Kvaser fixture patches a `_kvaser_api` that does not exist yet). On the branch, all 257 sidecar tests pass.
  - **Checks (scoped tier):**

    | Check | Result |
    |---|---|
    | ruff check | pass |
    | ruff format --check | pass |
    | mypy | pass |
    | pytest | 257 pass |
    | freeze + smoke | ok |
    | comment-refs grep on servers/ | empty |
    | check_local_paths | pass |

    `uv.lock` drifted during the run and was restored.
- **Blockers / side effects:**
  - While the fault persists (CAN side unplugged), the backstop resets about every 1-1.5 s. That is one INFO line per reset, as specified. On PEAK, AUTORESET should get there first.
  - The reopen fallback, like `reconfigure`, opens the new channel before closing the old one. Whether PCAN-Basic accepts a second initialize of a channel that is still initialized, and whether closing the old one then uninitializes the new one, has never been checked on the bench. This already applies to `reconfigure`. It matters for the PEAK backstop only if AUTORESET fails. Worth watching during the phase-2 bench check.
  - The Vector and Kvaser in-place resets are hardware-unverified. If a reset races an rx thread blocked in recv on the same handle, the result could be one "rx failed" warning plus a short `unavailable` reading.
- 2026-10-03 — **fix: the PEAK state read stayed error-passive after
  recovery** (owner bench). `_note_pcan_counters` took (REC, TEC) only
  from error frames, so once the wire was restored the last fault
  reading froze and `worse_state` kept answering passive. Fix on
  `fix-pcan-counters-decay` (`95431bd0`, on this task's branch): between
  error frames each received data frame lowers REC by 1 and each echo
  lowers TEC by 1 (ISO 11898-1's decrements), floor 0; an error frame
  re-syncs. Red before: `assert ('passive', 135) == ('warning', 127)`;
  7 tests (`test_counter_derived_state.py`), sidecar 264 passed at the
  restacked tip. Vector and Kvaser read live counters each poll — not
  affected.
- 2026-10-03 — **the per-echo decay was wrong on PEAK and is replaced**
  (owner bench: PEAK echoes unacknowledged frames, so an echo is not a
  success). `fix-pcan-counters-decay` amended to `e782e3df`: an error
  frame still re-syncs both counters; a 500 ms status poll that saw no
  error frame and a clean status word clears them to (0, 0) (a poll
  interval without an error frame is hundreds of error-free frames or a
  silent bus; during a fault error frames arrive with every retransmit,
  so nothing clears). Plus the **PEAK echo gate** (121 § Blockers): an
  echo arriving while TEC > 127 is dropped and counted
  (`echoes_dropped=` in the rx stats line); Vector gated as a
  precaution, Kvaser not. Red before: `AttributeError: … echoes_dropped`,
  `assert (95, 125) == (100, 130)`, `passive, tec=134` where active was
  expected. Sidecar 272 passed at the restacked tip; freeze smoke ok.
  ADR 0039's bus-off amendment carries the PEAK paragraph; README's
  transmit and bus-health passages carry the caveat.
- 2026-10-03 — **owner bench confirmation** ("that all seems like it's
  working pretty well now"): cable pulled → `Tx` rows, plot and counts
  stop and bus-health reads error-passive; replugged → the accepted
  driver-queue burst, then active and rows at rate. Vector/Kvaser paths still unverified on hardware (no bench). Phase 2 met on PEAK; every
  exit criterion met → **pending closeout**.
- 2026-10-04 — **a long disconnect did not recover** (owner bench, the
  evening after the confirmation above): CAN cable out ~21:03 with USB
  left in; both PEAK channels flooded error frames (2–4 k/s) while every
  send was refused `The transmit queue is full` (14 M refusals). Channel
  1's error frames stopped after ~50 min, channel 2's after ~2 h — the
  controller went bus-off and PCAN's `PCAN_BUSOFF_AUTORESET` reset it
  inside the next `CAN_GetStatus`, so the 0.5 s poll never read bus-off,
  the 1 s backstop never fired, and the reset left the full transmit
  queue unrestarted: the controller sat idle, status word stale at
  error-passive, and when the cable came back at 00:23 nothing was
  transmitted. (The sidecar's rx stats line was silent throughout: it
  logs only when `read > 0 or tx > 0`.) Fix on `fix-pcan-busoff-visible`
  (`6b66ab2f`, on `fix-pcan-counters-decay`): PEAK opens without
  `auto_reset`, so bus-off reaches the status word and the existing
  backstop reopens the channel (re-initialise = queue emptied,
  controller restarted); and, vendor-neutrally, a channel whose driver
  refused a send queue-full within 2 s *and* received nothing — no data,
  no error frame — for 2 s is reopened through the same swap, one INFO
  line per reopen, retried per poll. `TxRejected(queue_full=)` is set in
  one place (`_send_refused_queue_full`; PEAK's text only so far). Red
  before: collection error (`TxRejected` took no keyword) and five
  asserts; 7 shared-interface tests + 3 send-validation tests; sidecar
  282 passed at the restacked tip, freeze smoke ok. ADR 0039 dated
  amendment; README and sidecar README updated. **Retest expectation
  corrected**: a lone error-passive transmitter does not count ACK
  errors toward bus-off (ISO 11898-1), so with the cable out expect a
  long error-passive phase with error frames, then — if bus-off comes —
  a reopen within about a second; with the cable back, transmit resumes
  within ~2 s either way. Pending the owner's retest on a fresh build.

- 2026-10-07 — **Retest closed** by task 163's fault-recovery bench on the
  owner's PEAK pair (2026-10-06, phase 9b): bus-off recovered 3/3,
  error-passive 3/3, stuck queue flushed — the long pull that failed on
  2026-10-03/04 now recovers (`fix-pcan-busoff-visible` + 163's
  close-before-open). Queue § 2 block of 2026-10-03 rulings deleted: every
  item landed. Acceptance waits on the owner's integrated run with the
  installer (queue § 4).
