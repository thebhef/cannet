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

## Status log

- 2026-10-03 — opened; root cause from code (above); not started.
