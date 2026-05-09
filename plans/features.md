# Feature List

High-performance CAN traffic analyzer.

## GUI elements

- arbitrary plotting, ability to create multiple plots
- trace windows
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
- trace capture: explicit start / stop recording across all subscribed
  channels, with the captured frames persistable to .blf. The trace
  view stays a *view* over a capture (live or finished), not the
  source of truth for the data — that lives in the capture itself.
