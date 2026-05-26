# Per-vendor hardware smoke procedures

Procedural checklist for verifying each Phase-8 vendor end-to-end on a
real device. **CI cannot run any of these — they all require hardware
plugged into the machine running `cannet-gui`.** When picking up Phase
8, walk through whichever vendor(s) you have hardware for and update
the "last verified" line; do not silently leave a vendor as untested.

The common structure for every vendor:

1. Install the vendor SDK from the official site (link below).
2. Plug the device in.
3. Launch `cannet-gui`. The sidecar starts automatically.
4. Open the System Messages panel — there should be a
   `sidecar:python-can` entry showing the discovered channel(s).
5. Open the project graph view. Bind the channel to a logical bus.
6. Open a trace panel. Send a frame from the device (or have a
   companion node send one); see it appear in the trace.
7. Use the transmit panel to send a frame; see it on the bus through
   a second observer (or the device's own loopback if it supports
   one).

The sidecar handles enumeration through `python-can` (vendor backends:
`vector`, `kvaser`, `pcan`); if the vendor SDK is missing the
corresponding `_list_<vendor>` helper in `driver_python_can.py`
simply skips that vendor and the others still work.

---

## Vector

- **SDK**: [Vector XL Driver Library](https://www.vector.com/int/en/download/vector-driver-disk/).
  Windows is the first-class target; Linux support is partial.
- **python-can backend**: `vector`.
- **Channel id format**: `vector:<hw_name>(SN:<serial>, ch:<n>)` (for
  example `vector:VN1630A(SN:12345, ch:0)`).
- **Smoke**:
  1. Install the Vector XL Driver and confirm `Vector Hardware Config`
     can see the device.
  2. Launch `cannet-gui`. System Messages should show
     `sidecar:python-can` reporting one or more `vector:...` channels.
  3. Bind a `vector:...` channel to a logical bus.
  4. Use the Vector device's built-in or companion-device traffic; the
     trace should show the frames with `direction=Rx`.
  5. Send a frame from the transmit panel; observe it on the wire
     (second Vector channel, or external CAN analyser).
- **Loopback option**: a Vector device with two channels can echo TX
  on channel 0 to RX on channel 1. Bind both as separate logical
  buses for a single-device smoke.
- **Last verified**: <date> by <handle>.

## Kvaser

- **SDK**: [Kvaser CANlib SDK](https://www.kvaser.com/downloads/) (the
  "Drivers, library, SDK" bundle).
- **python-can backend**: `kvaser`.
- **Channel id format**: `kvaser:<n>` (zero-based channel index).
- **Smoke**: same shape as Vector. The Kvaser tool to confirm the
  install is `Kvaser Hardware`; on Linux, `lsusb` plus the
  `canlib` udev rules.
- **Loopback option**: Kvaser's `kvVirtualBus` virtual channels are
  visible to `python-can`'s `kvaser` backend and are a viable
  hardware-free smoke if installed.
- **Last verified**: <date> by <handle>.

## PEAK (PCAN)

- **SDK**: [PEAK PCAN-Basic API](https://www.peak-system.com/PCAN-Basic.239.0.html).
  Cross-platform; PEAK on Linux can alternatively go through the
  in-kernel `peak_usb` driver via socketcan, but Phase 8 uses
  PCAN-Basic for uniformity.
- **python-can backend**: `pcan`.
- **Channel id format**: `pcan:<channel_name>` (for example
  `pcan:PCAN_USBBUS1`).
- **Smoke**: same shape as Vector. Use PEAK's `PCAN-View` tool to
  confirm the install.
- **Last verified**: <date> by <handle>.

---

## When something does not work

- **The sidecar boots but reports zero interfaces** with hardware
  attached: confirm the vendor SDK is on the system path the sidecar
  is using. The sidecar's stdout banner includes
  `sidecar\tversion\t<v>` and `sidecar\tinterfaces\t<n>`; if `n=0`
  and you expected non-zero, the `_list_<vendor>` helper hit an
  `ImportError` or a runtime error — re-run with
  `--log-level debug` for the vendor-specific message.
- **The sidecar exits at startup**: the System Messages panel will
  surface the last few stderr lines as an `error`-level
  `sidecar:python-can` message; click "Restart sidecar" once. If it
  exits again, capture the stderr and file an issue.
- **Frames look corrupt**: check the bitrate / FD configuration on
  the logical bus. The wire `Subscribe` envelope does not currently
  carry bitrate (see `plans/backlog.md`); the host applies a
  per-interface configuration locally before subscribing. Most
  symptoms reduce to that path not being plumbed end-to-end for a
  given vendor yet.
