# BLF feature support

Reference: every Vector BLF object type in the public spec, what it
is per Vector's own documentation, whether cannet needs it, and the
support state in `cannet-blf` today (with the leading alternative
Rust crate `ablf` shown for comparison). Maintained as cannet's BLF
implementation grows.

The full object catalogue is here so that roadmap conversations can
range over the whole format, not just what cannet decodes today.

## Sources

**Primary spec.** Vector Informatik's public C headers describing the
BLF binary format, distributed in the "Read Write BLF API 2018
Version 8" reference package available from
[NI Forums](https://forums.ni.com/t5/Example-Code/Read-and-Write-BLF-Files/ta-p/3549766)
(also linked from `ablf`'s README). Two headers carry the spec:

- `binlog.h` — the `BL*` C API (file open/close, read/peek/skip/write
  object, flush, statistics).
- `binlog_objects.h` — every object type's `#define`, signature, and
  `VBL*` struct definition with field-level comments. **This is what
  every per-row Description column below cites by line number.** The
  file ships as `Read Write BLF File/Documentation/binlog_objects.h`
  inside the ZIP.

Copyright on both: Vector Informatik GmbH, 2002. Distributed
publicly. cannet's implementation is derived from this public spec —
see [ADR 0009](adr/0009-dbc-blf-readers.md) for the clean-room
constraint.

**Alternative implementations consulted.** Both pure-Rust, MIT/Apache:

- [`blf_asc`](https://docs.rs/blf_asc) (v0.2) — cannet's current
  parser, via the `cannet-blf` wrapper. Will retire when cannet's
  own implementation reaches parity (ADR 0009). Source consulted for
  CAN FD message decoding reference, since it's the only Rust crate
  that decodes object types 100 / 101.
- [`ablf`](https://docs.rs/ablf) (v0.2.1) — alternative considered;
  source consulted for outer-container and object-framing structure.
  Shown as a comparison column below.

**Evaluated and declined.** Technica-Engineering's
[`vector_blf`](https://github.com/Technica-Engineering/vector_blf)
C++ library is the most comprehensive open BLF implementation in
any language. We considered wrapping it via FFI; declined because
cannet is a Rust project and writing a focused Rust reader/writer
against Vector's public spec is lower friction than designing and
maintaining a Rust↔C++ FFI surface for a library we'd use ~20% of.

## How to read the support columns

**Need** — cannet's current intent. The whole catalogue is here so
that any row can be re-scoped via a roadmap conversation; the marker
records intent as of today, not a permanent decision.

- `required` — without this, a current cannet feature does not work as designed
- `desired` — we want this; without it a feature is degraded or has a worked-around path
- `nice` — would be useful; no immediate plan
- `oos` — out of scope today (different bus type / domain cannet does not address)
- `reserved` — slot in the spec with no defined meaning

**`cannet` column** — what `cannet-blf` exposes to consumers today:

- `✓ read+write` — typed read + write
- `✓ read` — typed read only
- `✗` — not exposed

Both the **reader** and the **writer** are native implementations
rooted in [`cannet-blf::format`](../crates/cannet-blf/src/format/);
the `blf_asc` wrapper was retired in Phase 9.5. Native coverage:
`FileStatistics`, `LOG_CONTAINER` (zlib + uncompressed), the five
CAN-class types (`CAN_MESSAGE`, `CAN_MESSAGE2`, `CAN_FD_MESSAGE`,
`CAN_FD_MESSAGE_64`, `CAN_ERROR_EXT`), `GLOBAL_MARKER`,
`EVENT_COMMENT`, `APP_TEXT`, `CAN_STATISTIC`, `DATA_LOST_BEGIN`,
and `DATA_LOST_END`. The writer emits `CAN_MESSAGE2` for classic
CAN frames and `CAN_FD_MESSAGE_64` for CAN FD (the modern types
Vector's own tools write today); the reader still accepts both
the older types and the modern ones.

**`ablf` column** — what the leading alternative Rust crate does
(read-only, no write surface). Shown for cross-reference:

- `✓ read` — decodes into a typed structure
- `◐ skip` — recognises the type and skips its bytes cleanly (`UnsupportedPadded` — file position correct, content not parsed)
- `✗` — falls through the generic catch-all (still skipped correctly, but as unrecognised)

## Object types

All `binlog_objects.h` line citations refer to Vector's "Read Write
BLF API 2018 Version 8" reference package linked above. Italic text
in the Description column is a verbatim quote from the cited line.

### Compression wrapper

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 10 | `LOG_CONTAINER` | required | ✓ read+write | ✓ read | *container object* (binlog_objects.h:39). `[cannet]` The outer wrapper every other object lives inside; zlib/deflate-compressed. |

### CAN messages

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 1 | `CAN_MESSAGE` | desired | ✓ read+write | ✗ | *CAN message object* (binlog_objects.h:30). `[cannet]` Older format; modern captures use `CAN_MESSAGE2`. |
| 2 | `CAN_ERROR` | desired | ✗ | ✗ | *CAN error frame object* (binlog_objects.h:31). Superseded by `CAN_ERROR_EXT`. |
| 3 | `CAN_OVERLOAD` | nice | ✗ | ✗ | *CAN overload frame object* (binlog_objects.h:32). |
| 4 | `CAN_STATISTIC` | desired | ✓ read+write | ✗ | *CAN driver statistics object* (binlog_objects.h:33). The struct (`VBLCanDriverStatistic` in `binlog_objects.h`) carries channel, bus load, std/ext frame counts (data + remote), error frames, overload frames. `[cannet]` Landed Phase 9.5 Step 4 in `cannet-blf::format::diagnostics`. |
| 73 | `CAN_ERROR_EXT` | desired | ✓ read+write | ✓ read | *CAN error frame object (extended)* (binlog_objects.h:124). |
| 86 | `CAN_MESSAGE2` | required | ✓ read+write | ✓ read | *CAN message object - extended* (binlog_objects.h:140). `[cannet]` The default CAN message format in modern captures. |
| 100 | `CAN_FD_MESSAGE` | required | ✓ read+write | ✗ | *CAN FD message object* (binlog_objects.h:164). Classic CAN FD frame (≤8-byte data path). |
| 101 | `CAN_FD_MESSAGE_64` | required | ✓ read+write | ✗ | *CAN FD message object* (binlog_objects.h:166). Up to 64-byte payload via `VBLCanFdMessage64` / `VBLCanFdExtFrameData`. |
| 104 | `CAN_FD_ERROR_64` | desired | ✗ | ✗ | *CAN FD Error Frame object* (binlog_objects.h:171). |

### CAN driver / hardware events

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 31 | `CAN_DRIVER_ERROR` | nice | ✗ | ✗ | *CAN driver error object* (binlog_objects.h:65). Carries TX/RX error counts and a driver error code. |
| 44 | `CAN_DRIVER_SYNC` | nice | ✗ | ✗ | *CAN driver hardware sync* (binlog_objects.h:82). |
| 74 | `CAN_DRIVER_ERROR_EXT` | nice | ✗ | ✗ | *CAN driver error object (extended)* (binlog_objects.h:125). |

### Markers, text, and event annotations (cross-bus)

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 5 | `APP_TRIGGER` | nice | ✗ | ◐ skip | *application trigger object* (binlog_objects.h:34). `[cannet]` Application-defined slot; only useful if cannet defines its own trigger semantics. |
| 65 | `APP_TEXT` | nice | ✓ read+write | ✓ read | *text object* (binlog_objects.h:111). The struct `VBLAppText` (binlog_objects.h:2259) carries `mSource` (text-source flag: `BL_APPTEXT_MEASUREMENTCOMMENT=0`, `BL_APPTEXT_DBCHANNELINFO=1`, `BL_APPTEXT_METADATA=2`), `mTextLength`, and `mText` (MBCS). `[cannet]` Landed Phase 9.5 Step 3 in `cannet-blf::format::text`. |
| 92 | `EVENT_COMMENT` | desired | ✓ read+write | ◐ skip | `[bare in spec]` — `binlog_objects.h:150` defines the type without an enum comment. Struct `VBLEventComment` (binlog_objects.h:2363) carries `mCommentedEventType`, `mTextLength`, and `mText` (MBCS). `[cannet]` Landed Phase 9.5 Step 3 in `cannet-blf::format::text`; the user-typed annotation in Vector CANalyzer's Trace Window, important for reading third-party captures. |
| 96 | `GLOBAL_MARKER` | **required** | ✓ read+write | ◐ skip | `[bare in spec]` — `binlog_objects.h:157` defines the type without an enum comment. Struct `VBLGlobalMarker` (binlog_objects.h:2379) is a self-sized record with group name + marker name + description lengths concatenated after the fixed fields. `[cannet]` Landed Phase 9.5 Step 2 in `cannet-blf::format::marker`; unblocks retiring `<file>.blf.notes.json` per [ADR 0010](adr/0010-no-sidecar-files.md). |

### Environment / system variables

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 6 | `ENV_INTEGER` | nice | ✗ | ◐ skip | *environment integer object* (binlog_objects.h:35). |
| 7 | `ENV_DOUBLE` | nice | ✗ | ◐ skip | *environment double object* (binlog_objects.h:36). |
| 8 | `ENV_STRING` | nice | ✗ | ◐ skip | *environment string object* (binlog_objects.h:37). |
| 9 | `ENV_DATA` | nice | ✗ | ◐ skip | *environment data object* (binlog_objects.h:38). |
| 72 | `SYS_VARIABLE` | nice | ✗ | ◐ skip | *system variable object* (binlog_objects.h:122). |

### Data flow / capture-integrity events

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 51 | `REALTIMECLOCK` | nice | ✗ | ✗ | *Realtime clock object* (binlog_objects.h:93). |
| 91 | `OVERRUN_ERROR` | nice | ✗ | ✗ | *driver overrun event* (binlog_objects.h:148). |
| 125 | `DATA_LOST_BEGIN` | desired | ✓ read+write | ✗ | *Data lost begin* (binlog_objects.h:203). Struct `VBLDataLostBegin` (binlog_objects.h:2519) carries `mQueueIdentifier` (the leaking queue's id). `[cannet]` Landed Phase 9.5 Step 4 in `cannet-blf::format::diagnostics`. Pairs with `DATA_LOST_END` to bracket a capture gap; important for data-integrity surfacing when reading third-party captures. |
| 126 | `DATA_LOST_END` | desired | ✓ read+write | ✗ | *Data lost end* (binlog_objects.h:204). Struct `VBLDataLostEnd` (binlog_objects.h:2525) carries `mQueueIdentifier`, `mFirstObjectLostTimeStamp`, and `mNumberOfLostEvents`. `[cannet]` Landed Phase 9.5 Step 4 in `cannet-blf::format::diagnostics`. |
| 127 | `WATER_MARK_EVENT` | nice | ✗ | ✗ | *Watermark event* (binlog_objects.h:205). |
| 128 | `TRIGGER_CONDITION` | nice | ✗ | ✗ | *Trigger Condition event* (binlog_objects.h:206). |

### Test / diagnostic framework

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 118 | `TEST_STRUCTURE` | nice | ✗ | ✗ | *Event for test execution flow* (binlog_objects.h:192). |
| 119 | `DIAG_REQUEST_INTERPRETATION` | nice | ✗ | ✗ | *Event for correct interpretation of diagnostic requests* (binlog_objects.h:194). |

### FunctionBus (Vector CANoe-specific)

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 124 | `FUNCTION_BUS` | nice | ✗ | ✗ | *FunctionBus object* (binlog_objects.h:201). |

### Auxiliary (sensor / serial / GPS / sentinel)

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 0 | `UNKNOWN` | n/a | n/a | n/a | *unknown object* (binlog_objects.h:29). Sentinel for "unset / invalid." |
| 46 | `GPS_EVENT` | nice | ✗ | ✗ | *GPS event object* (binlog_objects.h:86). |
| 90 | `SERIAL_EVENT` | nice | ✗ | ◐ skip | `[bare in spec]` — `binlog_objects.h:146` defines the type without an enum comment. |

### LIN — Local Interconnect Network (low-speed automotive bus)

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 11 | `LIN_MESSAGE` | oos | ✗ | ✗ | *LIN message object* (binlog_objects.h:41). Superseded by `LIN_MESSAGE2`. |
| 12 | `LIN_CRC_ERROR` | oos | ✗ | ✗ | *LIN CRC error object* (binlog_objects.h:42). |
| 13 | `LIN_DLC_INFO` | oos | ✗ | ✗ | *LIN DLC info object* (binlog_objects.h:43). |
| 14 | `LIN_RCV_ERROR` | oos | ✗ | ✗ | *LIN receive error object* (binlog_objects.h:44). |
| 15 | `LIN_SND_ERROR` | oos | ✗ | ✗ | *LIN send error object* (binlog_objects.h:45). |
| 16 | `LIN_SLV_TIMEOUT` | oos | ✗ | ✗ | *LIN slave timeout object* (binlog_objects.h:46). |
| 17 | `LIN_SCHED_MODCH` | oos | ✗ | ✗ | *LIN scheduler mode change object* (binlog_objects.h:47). |
| 18 | `LIN_SYN_ERROR` | oos | ✗ | ✗ | *LIN sync error object* (binlog_objects.h:48). |
| 19 | `LIN_BAUDRATE` | oos | ✗ | ✗ | *LIN baudrate event object* (binlog_objects.h:49). |
| 20 | `LIN_SLEEP` | oos | ✗ | ✗ | *LIN sleep mode event object* (binlog_objects.h:50). |
| 21 | `LIN_WAKEUP` | oos | ✗ | ✗ | *LIN wakeup event object* (binlog_objects.h:51). |
| 42 | `LIN_CHECKSUM_INFO` | oos | ✗ | ✗ | *LIN checksum info event object* (binlog_objects.h:79). |
| 43 | `LIN_SPIKE_EVENT` | oos | ✗ | ✗ | *LIN spike event object* (binlog_objects.h:80). |
| 54 | `LIN_STATISTIC` | oos | ✗ | ✗ | *LIN statistic event object* (binlog_objects.h:97). |
| 57 | `LIN_MESSAGE2` | oos | ✗ | ✗ | *LIN frame object - extended* (binlog_objects.h:102). |
| 58 | `LIN_SND_ERROR2` | oos | ✗ | ✗ | *LIN transmission error object - extended* (binlog_objects.h:103). |
| 59 | `LIN_SYN_ERROR2` | oos | ✗ | ✗ | *LIN sync error object - extended* (binlog_objects.h:104). |
| 60 | `LIN_CRC_ERROR2` | oos | ✗ | ✗ | *LIN checksum error object - extended* (binlog_objects.h:105). |
| 61 | `LIN_RCV_ERROR2` | oos | ✗ | ✗ | *LIN receive error object* (binlog_objects.h:106). |
| 62 | `LIN_WAKEUP2` | oos | ✗ | ✗ | *LIN wakeup event object - extended* (binlog_objects.h:107). |
| 63 | `LIN_SPIKE_EVENT2` | oos | ✗ | ✗ | *LIN spike event object - extended* (binlog_objects.h:108). |
| 64 | `LIN_LONG_DOM_SIG` | oos | ✗ | ✗ | *LIN long dominant signal object* (binlog_objects.h:109). |
| 75 | `LIN_LONG_DOM_SIG2` | oos | ✗ | ✗ | *LIN long dominant signal object - extended* (binlog_objects.h:127). |
| 87 | `LIN_UNEXPECTED_WAKEUP` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:142` defines the type without an enum comment. |
| 88 | `LIN_SHORT_OR_SLOW_RESPONSE` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:143` defines the type without an enum comment. |
| 89 | `LIN_DISTURBANCE_EVENT` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:144` defines the type without an enum comment. |
| 105 | `LIN_SHORT_OR_SLOW_RESPONSE2` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:172` defines the type without an enum comment. |

### MOST — Media Oriented Systems Transport (in-vehicle multimedia bus)

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 22 | `MOST_SPY` | oos | ✗ | ✗ | *MOST spy message object* (binlog_objects.h:53). |
| 23 | `MOST_CTRL` | oos | ✗ | ✗ | *MOST control message object* (binlog_objects.h:54). |
| 24 | `MOST_LIGHTLOCK` | oos | ✗ | ✗ | *MOST light lock object* (binlog_objects.h:55). |
| 25 | `MOST_STATISTIC` | oos | ✗ | ✗ | *MOST statistic object* (binlog_objects.h:56). |
| 32 | `MOST_PKT` | oos | ✗ | ✗ | *MOST Packet* (binlog_objects.h:67). |
| 33 | `MOST_PKT2` | oos | ✗ | ✗ | *MOST Packet including original timestamp* (binlog_objects.h:68). |
| 34 | `MOST_HWMODE` | oos | ✗ | ✗ | *MOST hardware mode event* (binlog_objects.h:69). |
| 35 | `MOST_REG` | oos | ✗ | ✗ | *MOST register data (various chips)* (binlog_objects.h:70). |
| 36 | `MOST_GENREG` | oos | ✗ | ✗ | *MOST register data (MOST register)* (binlog_objects.h:71). |
| 37 | `MOST_NETSTATE` | oos | ✗ | ✗ | *MOST NetState event* (binlog_objects.h:72). |
| 38 | `MOST_DATALOST` | oos | ✗ | ✗ | *MOST data lost* (binlog_objects.h:73). |
| 39 | `MOST_TRIGGER` | oos | ✗ | ✗ | *MOST trigger* (binlog_objects.h:74). |
| 67 | `MOST_STATISTICEX` | oos | ✗ | ✗ | *MOST extended statistic event* (binlog_objects.h:115). |
| 68 | `MOST_TXLIGHT` | oos | ✗ | ✗ | *MOST TxLight event* (binlog_objects.h:116). |
| 69 | `MOST_ALLOCTAB` | oos | ✗ | ✗ | *MOST Allocation table event* (binlog_objects.h:117). |
| 70 | `MOST_STRESS` | oos | ✗ | ✗ | *MOST Stress event* (binlog_objects.h:118). |
| 76 | `MOST_150_MESSAGE` | oos | ✗ | ✗ | *MOST150 Control channel message* (binlog_objects.h:129). |
| 77 | `MOST_150_PKT` | oos | ✗ | ✗ | *MOST150 Asynchronous channel message* (binlog_objects.h:130). |
| 78 | `MOST_ETHERNET_PKT` | oos | ✗ | ✗ | *MOST Ethernet channel message* (binlog_objects.h:131). |
| 79 | `MOST_150_MESSAGE_FRAGMENT` | oos | ✗ | ✗ | *Partial transmitted MOST50/150 Control channel message* (binlog_objects.h:132). |
| 80 | `MOST_150_PKT_FRAGMENT` | oos | ✗ | ✗ | *Partial transmitted MOST50/150 data packet on asynchronous channel* (binlog_objects.h:133). |
| 81 | `MOST_ETHERNET_PKT_FRAGMENT` | oos | ✗ | ✗ | *Partial transmitted MOST Ethernet packet on asynchronous channel* (binlog_objects.h:134). |
| 82 | `MOST_SYSTEM_EVENT` | oos | ✗ | ✗ | *Event for various system states on MOST* (binlog_objects.h:135). |
| 83 | `MOST_150_ALLOCTAB` | oos | ✗ | ✗ | *MOST50/150 Allocation table event* (binlog_objects.h:136). |
| 84 | `MOST_50_MESSAGE` | oos | ✗ | ✗ | *MOST50 Control channel message* (binlog_objects.h:137). |
| 85 | `MOST_50_PKT` | oos | ✗ | ✗ | *MOST50 Asynchronous channel message* (binlog_objects.h:138). |
| 95 | `MOST_ECL` | oos | ✗ | ✗ | *MOST Electrical Control Line event* (binlog_objects.h:155). |

### FlexRay — high-speed automotive bus

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 29 | `FLEXRAY_DATA` | oos | ✗ | ✗ | *FLEXRAY data object* (binlog_objects.h:62). |
| 30 | `FLEXRAY_SYNC` | oos | ✗ | ✗ | *FLEXRAY sync object* (binlog_objects.h:63). |
| 40 | `FLEXRAY_CYCLE` | oos | ✗ | ✗ | *FLEXRAY V6 start cycle object* (binlog_objects.h:76). |
| 41 | `FLEXRAY_MESSAGE` | oos | ✗ | ✗ | *FLEXRAY V6 message object* (binlog_objects.h:77). |
| 45 | `FLEXRAY_STATUS` | oos | ✗ | ✗ | *FLEXRAY status event object* (binlog_objects.h:84). |
| 47 | `FR_ERROR` | oos | ✗ | ✗ | *FLEXRAY error event object* (binlog_objects.h:88). |
| 48 | `FR_STATUS` | oos | ✗ | ✗ | *FLEXRAY status event object* (binlog_objects.h:89). |
| 49 | `FR_STARTCYCLE` | oos | ✗ | ✗ | *FLEXRAY start cycle event object* (binlog_objects.h:90). |
| 50 | `FR_RCVMESSAGE` | oos | ✗ | ✗ | *FLEXRAY receive message event object* (binlog_objects.h:91). |
| 66 | `FR_RCVMESSAGE_EX` | oos | ✗ | ✗ | *FLEXRAY receive message ex event object* (binlog_objects.h:113). |

### Ethernet — automotive Ethernet capture

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 71 | `ETHERNET_FRAME` | oos | ✗ | ✗ | *Ethernet frame object* (binlog_objects.h:120). |
| 102 | `ETHERNET_RX_ERROR` | oos | ✗ | ✗ | *Ethernet RX error object* (binlog_objects.h:168). |
| 103 | `ETHERNET_STATUS` | oos | ✗ | ✗ | *Ethernet status object* (binlog_objects.h:169). |
| 114 | `ETHERNET_STATISTIC` | oos | ✗ | ✗ | *Ethernet statistic object* (binlog_objects.h:184). |
| 120 | `ETHERNET_FRAME_EX` | oos | ✗ | ✗ | *Ethernet packet extended object* (binlog_objects.h:196). |
| 121 | `ETHERNET_FRAME_FORWARDED` | oos | ✗ | ✗ | *Ethernet packet forwarded object* (binlog_objects.h:197). |
| 122 | `ETHERNET_ERROR_EX` | oos | ✗ | ✗ | *Ethernet error extended object* (binlog_objects.h:198). |
| 123 | `ETHERNET_ERROR_FORWARDED` | oos | ✗ | ✗ | *Ethernet error forwarded object* (binlog_objects.h:199). |

### J1708 — heavy-duty vehicle bus

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 55 | `J1708_MESSAGE` | oos | ✗ | ✗ | *J1708 message object* (binlog_objects.h:99). |
| 56 | `J1708_VIRTUAL_MSG` | oos | ✗ | ✗ | *J1708 message object with more than 21 data bytes* (binlog_objects.h:100). |

### WLAN — wireless LAN capture

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 93 | `WLAN_FRAME` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:152` defines the type without an enum comment. |
| 94 | `WLAN_STATISTIC` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:153` defines the type without an enum comment. |

### AFDX — Avionics Full-Duplex Switched Ethernet

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 97 | `AFDX_FRAME` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:159` defines the type without an enum comment. |
| 98 | `AFDX_STATISTIC` | oos | ✗ | ✗ | `[bare in spec]` — `binlog_objects.h:160` defines the type without an enum comment. |
| 106 | `AFDX_STATUS` | oos | ✗ | ✗ | *AFDX status object* (binlog_objects.h:174). |
| 107 | `AFDX_BUS_STATISTIC` | oos | ✗ | ✗ | *AFDX line-dependent busstatistic object* (binlog_objects.h:175). |
| 109 | `AFDX_ERROR_EVENT` | oos | ✗ | ✗ | *AFDX asynchronous error event* (binlog_objects.h:177). |

### A429 — ARINC 429 avionics serial bus

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 110 | `A429_ERROR` | oos | ✗ | ✗ | *A429 error object* (binlog_objects.h:179). |
| 111 | `A429_STATUS` | oos | ✗ | ✗ | *A429 status object* (binlog_objects.h:180). |
| 112 | `A429_BUS_STATISTIC` | oos | ✗ | ✗ | *A429 busstatistic object* (binlog_objects.h:181). |
| 113 | `A429_MESSAGE` | oos | ✗ | ✗ | *A429 Message* (binlog_objects.h:182). |

### K-Line — automotive diagnostics serial bus

| ID | Name | Need | cannet | `ablf` | Description |
|---:|------|------|--------|--------|-------|
| 99 | `KLINE_STATUSEVENT` | oos | ✗ | ✗ | *E.g. wake-up pattern* (binlog_objects.h:162). |

### Reserved in Vector 2018 v8

Vector's spec reserves these IDs without assigning a meaning.

| ID | Name | Need | Description |
|---:|------|------|-------------|
| 26 | `reserved_1` | reserved | binlog_objects.h:58 (bare). |
| 27 | `reserved_2` | reserved | binlog_objects.h:59 (bare). |
| 28 | `reserved_3` | reserved | binlog_objects.h:60 (bare). |
| 52 | `AVAILABLE2` | reserved | *this object ID is available for the future* (binlog_objects.h:94). |
| 53 | `AVAILABLE3` | reserved | *this object ID is available for the future* (binlog_objects.h:95). |
| 108 | `reserved_4` | reserved | binlog_objects.h:176 (bare). |
| 115 | `reserved_5` | reserved | binlog_objects.h:186 (bare). |
| 116 | `reserved_6` | reserved | binlog_objects.h:188 (bare). |
| 117 | `reserved_7` | reserved | binlog_objects.h:190 (bare). |

### Post-2018-v8 additions

Vector 2018 v8 — our reference spec — ends at object type **128**
(`TRIGGER_CONDITION`). Newer Vector spec versions assign additional
types (`CAN_SETTING_CHANGED` = 129, `DISTRIBUTED_OBJECT_MEMBER` = 130,
`ATTRIBUTE_EVENT` = 131, possibly more). These are out of cannet's
current scope and not catalogued here; if a future capture from a
modern CANalyzer needs decoding past `TRIGGER_CONDITION`, we'd locate
a newer public Vector reference and extend this table.

## Skip-past behaviour for unsupported types

A BLF file from a mixed-network capture device may contain any of
the non-CAN object types interleaved with CAN frames. cannet's
reader must skip past unrecognised objects without losing file
position. Both `cannet` (via the current `blf_asc` wrapper) and
`ablf` do this correctly via the object header's length field —
*unsupported* in this doc never means *crashes on encounter*, it
means *the payload is not surfaced to cannet*.

## Summary of cannet's gaps

Sorted by need.

**Required and not currently supported:** none.

**Desired and not currently supported:**

- `CAN_ERROR` (2) and `CAN_FD_ERROR_64` (104) — additional
  error-frame variants we don't yet decode. `CAN_MESSAGE` (1),
  `CAN_ERROR_EXT` (73), and the modern CAN-FD types are supported.

**Write-surface gap:** none. The native writer
([`cannet-blf::format::writer`](../crates/cannet-blf/src/format/writer.rs))
exposes `append_object` for any encoded object type, with
ergonomic wrappers (`append`, `append_marker`) on the higher-level
[`BlfCaptureWriter`](../crates/cannet-blf/src/lib.rs) for the
common paths.

## Decision and history

Recorded in [ADR 0009](adr/0009-dbc-blf-readers.md): cannet ships
its own focused BLF reader/writer inside `cannet-blf`. The
third-party Rust crate (`blf_asc`) was retired in Phase 9.5,
which landed in four steps:

1. **Parity** — CAN classic + FD + error + `LOG_CONTAINER`
   read+write. Let `blf_asc` retire from the dep tree.
2. **`GLOBAL_MARKER`** — read+write. Unblocked the
   `<file>.blf.notes.json` removal (ADR 0010).
3. **Annotation** — `EVENT_COMMENT` + `APP_TEXT`. Preserves
   third-party annotations.
4. **Capture-integrity** — `CAN_STATISTIC` + `DATA_LOST_BEGIN/END`.
   Surfaces gaps in third-party captures.

Each step updated this table's `cannet` column for the affected
rows in the same commit.

## Maintaining this doc

When cannet's BLF surface grows, update the relevant row in the
same change. A `✗` moves to `✓ read` or `✓ read+write` in the same
commit that adds the support. A `oos` row moves to `nice` /
`desired` / `required` when the roadmap takes on a new bus type or
use case. If Vector publishes a newer reference (post-2018-v8) and
we adopt it, update the binlog_objects.h line citations to the new
version and extend the table for any newly-defined types.
