# Feature List

High-performance CAN traffic analyzer.

## GUI elements

- arbitrary plotting, ability to create multiple plots
- trace windows — chronological (one row per frame, in arrival order)
  and a by-id view (one row per arbitration id holding just its latest
  frame); both are *views* over a trace (see "trace capture" below)
- filtering, which can be inserted into trace views
- bitfield views, with flag indicators per signal
- ability to dock and consistently size/resize
- transmit control panels

## Application Features

- cross-platform: windows, macos, linux (least important at the moment, but shouldn't add much complexity vs macos)
- abstraction for supporting CAN and CANFD
  - should be something we can tx/rx over a network; ZMQ might be right
- server mode - findable on network (MVP is just addressable; discovery can be later)
- rest-of-bus simulation; mvp is a gridview with live values
- crc and sequence count calculation in arbitrary fields of the CAN message
- dbc ingestion
- eds ingestion
- can traffic decoding
- CANopen SDO and PDO decoding from EDS
- projects - includes window layouts, bus configs, references DBCs. Should be json file. DBC should be reloadable from disk at any time.
- virtual CAN bus layer: allow mapping CAN channels to logical project channels
- reading from .blf logs (should just stream messages through our CAN abstraction)
- trace capture: a session-wide buffer holds every frame received since
  the current connection (replaced on a new connection; lost on app
  exit). On top of it a *trace* is a capture window — a start point and
  a running / paused / stopped state — with controls start / stop
  (stop→start clears), pause / resume (resume continues, including
  frames received while paused), clear. Each trace-style window
  (chronological trace, by-id view, plot window) has its own trace; the
  controls are a common toolbar component, the state is per-window.
  Traces live in the project (closing a window doesn't destroy its
  trace; reopen it from the project panel). The views stay *views* over
  the trace, not the source of truth for the data — that lives in the
  session buffer. A finished trace's frames are persistable to .blf.
