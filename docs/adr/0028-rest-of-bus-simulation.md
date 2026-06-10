# ADR 0028 — Rest-of-bus simulation: the `.cannet_rbs` file and runtime model

Status: accepted (2026-06-09)

Rest-of-bus simulation (RBS) transmits a configured set of DBC
messages on a cadence with live, editable signal values — cannet
plays every node except the device under test. This ADR records the
RBS configuration file, its project wiring, and the runtime model.
The recompute-on-send counter/CRC fields RBS messages typically
carry are [ADR 0027](0027-calculated-fields-counter-crc.md)'s
mechanism; RBS is one client of it.

## Decision

### A first-class, human-editable config file: `.cannet_rbs`

An RBS configuration is a JSON document the user creates and owns —
the same category as the project file
([ADR 0011](0011-project-file-format.md)), not a sidecar
([ADR 0010](0010-no-sidecar-files.md)). It is deliberately
**human-editable**: the schema nests the way a person thinks about a
bus, and it persists **sparse overrides**, never derived data.

```jsonc
{
  "schema_version": 1,
  "fill_bit": 0,
  "disabled_messages": ["Powertrain/0x456"],  // flat mute list
  "buses": {
    "Powertrain": {                  // project logical-bus name
      "enabled": true,
      "ecus": {
        "BMS": {                     // DBC node (transmitter)
          "enabled": true,
          "messages": {
            "0x123": {               // hex CAN id; trailing "x" = extended
              "period_ms": 10,       // absent → DBC GenMsgCycleTime
              "signals": {           // sparse: only overrides
                "TargetMode": "Standby",   // enums by label
                "CmdWord": "0x1A2B",       // hex iff unity-scaled integer
                "PackVoltage": 403.2
              },
              "counter": { "signal": "AliveCtr", "increment": 1, "rollover": 15 },
              "crc": { "signal": "Crc8", "algorithm": "CRC-8/SAE-J1850",
                       "range_bits": [0, 56], "prefix": "A3" }
            }
          }
        }
      }
    }
  }
}
```

- `schema_version` has ADR 0011 semantics: current-only, no
  migrators.
- **Sparse overrides.** A signal absent from `signals` takes its DBC
  `GenSigStartValue` default, or `fill_bit` where the DBC specifies
  none. `period_ms` absent → `GenMsgCycleTime`; a message with
  neither cannot be enabled. `counter` / `crc` absent → the DBC's
  `CannetCounter` / `CannetCrc` attributes (ADR 0027); present →
  replaces the DBC default wholesale. Editing the DBC therefore
  flows through to every non-overridden value on next load — the
  point of a *simulation* config, in contrast to the transmit
  panel's frozen `dataHex`.
- **Values only.** Overrides set signal values (physical; enum
  labels as strings; `0x` hex strings accepted anywhere and written
  for unity-scaled integer signals). A signal's placement, type,
  scale, and unit always come from the DBC.
- **Messages are enabled by default** — rest-of-bus: every DBC
  message on a configured bus plays unless muted. Mutes live in the
  flat top-level `disabled_messages` list
  (`"<bus key>/<message key>"` entries); a message needs a `messages`
  entry only to carry overrides. Bus and ECU levels keep `enabled`
  flags; the three levels AND: a message transmits iff bus && ecu
  enabled and it isn't muted. Toggling an outer level off and on
  preserves the inner state. (The format's first revision carried a
  per-entry `enabled` flag; it is still read — `false` folds into
  `disabled_messages` on load — but never written.)

### Loading and resolution

- Bus keys are the project's **logical bus names**
  ([ADR 0023](0023-logical-bus-vs-interface.md)). A name with no
  match in the current project renders its rows inert (visible,
  greyed, warning) — the BLF-replay-style disconnected view — never
  a load failure. The file travels separately from the project
  precisely so configs can be switched and forked by ordinary file
  operations.
- A message id absent from the bus's DBC is **not loaded** into the
  backend; a warning goes to the system-messages panel. A message
  whose DBC transmitter disagrees with its `ecus` placement loads
  with a warning (moving it is a hand edit; not common enough for a
  workflow).

### Runtime model: a payload buffer per message, registered with the one transmitter

On load (and on Run), each enabled message gets a host-side payload
buffer reconstructed as **fill bit → DBC defaults → overrides**.
From then on the buffer is the runtime source of truth
([ADR 0017](0017-transmit-signal-encoder-and-bytes-source-of-truth.md)):
grid edits partial-encode into it; the grid displays its decode;
the fire path partial-encodes the calculated fields into it on each
send. Per-send work is two field writes, never a full re-encode.

Every DBC message on each resolved bus registers with the existing
`TransmitFrameRegistry` as a **provenance-tagged entry**
(`source: rbs:<element>` vs `project`, the tag carrying the row's
bus/ECU/message keys so schedule reconciliation needs no DBC walk),
driven by the existing host scheduler thread. Provenance
excludes them from the project's `transmit_frames` persistence and
from the transmit panel's list; everything else — live edit
semantics, the fire path, scheduling — is shared. RBS is just
another client of the one transmitter construct.

### Project wiring and run model

- New project element `kind: "rbs"` — nameable
  ([ADR 0019](0019-project-element-display-names.md)), multiple
  allowed, referencing its `.cannet_rbs` **by path** (the project
  never embeds the content, same as DBC references). A fresh element
  needs no file: it starts as an **in-memory config pre-seeded with
  the project's current logical buses** and only touches disk on the
  first explicit save (which sets the path). Until then the element's
  path is null; the dirty-tracking and exit prompt cover the unsaved
  in-memory state.
- The element carries a **Run flag, persisted in the project,
  default off**. The `.cannet_rbs` file stays portable config; the
  project records "this RBS is live here." A project saved with RBS
  running resumes transmitting on open once its bus connects — by
  design; a **global RBS kill-switch** (runtime-only, never
  persisted) is the guard rail.
- While running, actual transmission gates on **per-bus
  connectivity**: a bus that connects starts its enabled messages, a
  bus that drops stops them. Enable toggles take effect live.
  Counters seed at 0 when the element starts running; muting and
  unmuting a message mid-run resumes its counter.

### Save flow and file extensions

- RBS override edits accumulate in memory; saving is explicit.
  **Save Project** saves the project only; a **Save All** action
  saves the project plus every dirty `.cannet_rbs` (prompting for a
  path for configs never saved); the exit prompt covers all unsaved
  state. No duplicate-config affordance — forking
  a config is a file operation plus re-pointing the element's path.
- File extensions: projects default to **`.cannet_prj`**, RBS files
  to **`.cannet_rbs`**; open dialogs also accept `.json` for both.
  Extension is convention only — the content is the same JSON.

## Why

- **Sparse overrides over persisted bytes.** Persisting `dataHex`
  would freeze DBC defaults at authoring time and make the file
  meaningless to hand-edit. Overrides keep the file small, diffable,
  and DBC-tracking; the byte buffer is reconstructed deterministically.
- **Nested `bus → ecu → message` over a flat list.** The file is
  meant to be read and edited by a person; the nesting is how the
  domain is organized. The DBC remains the authority on
  transmitters — disagreement warns rather than breaks.
- **Reuse the registry and scheduler.** The transmit model already
  has live-edit-while-running semantics, a deadline heap, and a fire
  path; a parallel RBS pipeline would duplicate all three.
- **Run state in the project, not the RBS file.** Whether a config
  is *live* is a property of the working session (the project), not
  of the reusable config. Default-off means a fresh reference never
  transmits unasked.
- **Separate file rather than project-embedded.** Switching and
  forking simulation configs (per test rig, per DUT variant) is a
  stated workflow; file-level separation makes it `cp` and a path
  picker instead of project surgery.

## Rejected alternatives

- **Re-encoding the payload from the signal map on every send.**
  ADR 0017's reasons stand: bits covered by no signal get clobbered
  and multiplexed messages drift; it's also avoidable per-send
  compute. The buffer model keeps sends cheap.
- **Persisting `dataHex` per message.** Frozen defaults, opaque
  diffs, and a second source of truth beside the overrides.
- **DBC `BA_` attributes for RBS state.** Right home for the
  calculated-field *designation* (ADR 0027), wrong one for
  per-simulation values and cadence: those vary per rig and would
  churn a shared DBC.
- **A singleton RBS panel.** Multiple named elements per project
  (different node subsets, different buses) fall out of the
  element/panel architecture for free.
- **Flat message list with derived ECU grouping in the file.**
  Machine-friendlier, but the file's human editability is a design
  goal and the nesting carries the per-ECU enables naturally.
