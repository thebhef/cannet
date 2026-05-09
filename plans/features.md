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
- dbc ingestion: cover the common features and attributes of DBC, not just
  basic signals (value tables, comments, attribute definitions/values, signal
  groups, transmitter nodes, cycle times)
- multiplexing values: first-class support for both classic and extended
  multiplexing. Decoded views must show only the signals applicable to the
  currently-active multiplexor selection.
- custom DBC attributes as an application design surface: project-defined
  attributes (CRC fields, sequence counters, transmit hints, naming
  overrides) configure application behavior through the DBC itself rather
  than a parallel sidecar config.
- eds ingestion
- can traffic decoding
- CANopen SDO and PDO decoding from EDS
- projects - includes window layouts, bus configs, references DBCs. Should be
  json file. DBC should be reloadable from disk at any time, and reload must
  update existing signals **in place** — open trace views, plots, and
  subscriptions on unchanged signals keep working without being torn down
  and rebuilt.
- virtual CAN bus layer: allow mapping CAN channels to logical project channels
- reading from .blf logs (should just stream messages through our CAN abstraction)
