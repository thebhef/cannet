# Feature List

High-performance CAN traffic analyzer.

## GUI elements

- [x] Arbitrary signal plotting; multiple plot panels
- [x] Trace windows (views over a trace)
  - [x] Chronological view: one row per frame, in arrival order
  - [x] By-id view: one row per arbitration id, latest frame only
- [x] Filtering, insertable into trace views
- [x] Dockable panels with consistent sizing / resizing
- [x] Transmit control panels

## Application Features

- [x] Cross-platform: Windows, macOS, Linux
- [x] CAN and CAN FD abstraction
  - [x] Tx / rx over a network
- [ ] Server mode — network-accessible
  - [x] Addressable by host:port
  - [ ] Discoverable on the network
- [ ] Rest-of-bus simulation: gridview of ids with live signal values, transmitted on a cadence
  - [ ] External value-source binding: an out-of-repo process streams sparse signal values that RBS applies as overrides
- [ ] CRC and sequence-count calculation in arbitrary message fields
- [x] DBC ingestion
- [ ] EDS ingestion
- [x] CAN traffic decoding
- [ ] CANopen SDO and PDO decoding from EDS
- [x] Projects (JSON file)
  - [x] Window layouts
  - [x] Bus configs
  - [x] DBC references, reloadable from disk at any time
- [x] Logical CAN bus layer: map CAN channels to logical project channels
- [x] Read .blf logs
- [x] Trace capture
  - [x] Session buffer: every frame received since the current connection (replaced on new connection, lost on app exit)
  - [x] A trace is a capture window over the buffer: a start point and a running / paused / stopped state
  - [x] Controls — common toolbar, per-window state:
    - [x] Start / stop (stop→start clears the view)
    - [x] Pause / resume (resume includes frames received while paused)
    - [x] Clear (empties the window, keeps the run state)
  - [x] Traces live in the project (closing a window doesn't destroy its trace; reopen from the project panel)
  - [x] Persist a finished trace's frames to .blf