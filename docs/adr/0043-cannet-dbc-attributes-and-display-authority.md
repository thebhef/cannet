# ADR 0043 — cannet's DBC custom attributes, and where display authority lives

Status: accepted (2026-08-04)

## Context

cannet already defines custom DBC attributes. `CannetCounter` and
`CannetCrc` ([ADR 0027](0027-calculated-fields-counter-crc.md)) carry
calculated-field designations, and `CannetDisplay` now carries a
signal's render mode. Nothing has ever written down that these form a
*namespace*, what the convention is, or that cannet only ever reads
them.

The rule for choosing between the DBC and the project file exists too,
but only scattered through three rejected-alternatives sections: ADR
0027 puts the calculated-field designation in the DBC because it is a
property of the signal; [ADR 0028](0028-rest-of-bus-simulation.md)
keeps per-simulation values and cadence *out* of it because those vary
per rig and would churn a shared file;
[ADR 0029](0029-signal-value-color-maps.md) sends colour maps to the
project partly because `BA_` structurally cannot attach to a `VAL_`
entry. Every future attribute re-litigates the same question.

## Decision

### The `Cannet*` namespace, and it is read-only

Attributes cannet defines are named `Cannet<Thing>` in PascalCase,
declared with a `BA_DEF_` at the appropriate scope (`SG_` for
per-signal, `BO_` for per-message) and a `BA_DEF_DEF_` default. They
are **`STRING`-typed**, and their value is a `key=value;key=value`
one-liner — not JSON, because DBC STRING values cannot portably carry
nested double quotes. **An empty value means unconfigured**, which is
what the default is, so a DBC that declares an attribute without
setting it behaves exactly like one that never heard of it.

A malformed value, an unknown key, or an unknown value for a known key
is a **parse warning plus the default behaviour** — never a load
failure and never a silent misreading. That is what lets a DBC written
for a later cannet stay usable by an earlier one.

**cannet reads these attributes and never writes them.** The DBC stack
is parse-only: `can-dbc` has no serialiser, and round-tripping a
third-party file through an AST writer would reformat it wholesale and
risk dropping constructs the parser holds lossily. A surgical
attribute editor is the eventual shape (ADR 0027 records the
deferral); until it exists, a `Cannet*` attribute is authored by hand
or by whatever generates the DBC. **Do not design a feature whose
only configuration path is cannet writing a DBC.**

The set today:

| Attribute | Scope | Keys | ADR |
| --- | --- | --- | --- |
| `CannetCounter` | `SG_` | `increment`, `rollover` | [0027](0027-calculated-fields-counter-crc.md) |
| `CannetCrc` | `SG_` | `alg` \| `width`/`poly`/`init`/`refin`/`refout`/`xorout`, `range`, `prefix` | [0027](0027-calculated-fields-counter-crc.md) |
| `CannetDisplay` | `SG_` | `radix` (`hex`) | this ADR |

`CannetDisplay` is a display-*mode slot*, not a radix flag: further
simple render modes take a key here rather than each earning their own
attribute.

### The DBC-versus-project test

> **A fact about the signal itself goes in the DBC. A fact that varies
> per rig, per session, or per user goes in the project.**

`radix=hex` passes: a signal being an opaque bit pattern — an id, a
serial, a flag word — rather than a measurement is intrinsic to it,
and stays true in every project that loads that DBC. An RBS row's send
cadence fails: it is a property of the simulation being run, not of
the message. A colour map fails twice over — it is a per-user viewing
choice, and `BA_` cannot attach to an individual `VAL_` entry anyway.

The structural half matters as much as the semantic one. When the DBC
mechanism cannot express the data (ADR 0029), the project file is the
only home regardless of how intrinsic the fact is. When it *can*, and
the fact is intrinsic, the DBC is the home even if the write path is
missing — reading an attribute a DBC already carries is a complete,
useful feature on its own.

### Precedence: the project wins

When both the DBC and the project speak about the same thing, **the
project's value wins**. The DBC is the portable default; the project
is the user's local, deliberate override. This is already how
calculated fields layer (ADR 0027: an override replaces the DBC
default wholesale per field), and it generalises.

`CannetDisplay` has no project-side override today. If one is added,
this is the rule it follows.

### Per-value facts may be signal properties; per-axis facts may not

A display fact that applies **per value** — a radix — can safely be a
signal property. Two signals rendered on the same surface can use
different radices without contradiction, because each value is
formatted on its own.

A display fact that applies **per axis** — a log scale — cannot. Every
series drawn on an axis shares its mapping from range to pixels
([ADR 0026](0026-plot-areas-compose-axes-configure.md)), so two
signals sharing an axis in `per-unit` mode, one declaring a log
scale and one not, leave the axis with no consistent answer. Log scale
is therefore an **axis** property, and no DBC hint may override an
explicit per-axis setting.

This is why `CannetDisplay` ships `radix` and not `scale`. If a
`scale=log` key is ever added it can only be a *default that seeds an
axis when nothing contradicts it* — unambiguous in `individual` mode,
and in `per-unit` only when every signal on the axis agrees — with a
mixed axis warning and staying linear.

## Why

- **An extension point with no written rule is how the next three get
  added inconsistently.** Two attributes existed with their convention
  implicit in one feature's ADR; the third is the point at which the
  convention needs its own home.
- **Read-only is a real constraint, not a temporary gap.** Stating it
  once stops each new feature designing a UI that cannot exist.
- **The DBC-versus-project test was already being applied**, three
  times, from three rejected-alternatives sections. Stating it
  positively costs one paragraph and saves the rediscovery.
- **The per-value / per-axis asymmetry is the non-obvious half.** A
  contributor who reads "display facts belong in the DBC" and ships
  `scale=log` finds the contradiction only after building it.

## Rejected alternatives

- **One attribute per display mode** (`CannetRadix`, `CannetScale`, …).
  Each one costs a `BA_DEF_` and a `BA_DEF_DEF_` line in every DBC that
  uses it, and DBC tooling shows them as separate columns. A single
  slot with a key grammar — the one `CannetCounter` and `CannetCrc`
  already use — keeps the file readable.
- **A project-side radix override instead of a DBC attribute.** It
  would be settable from the UI today, but the fact does not vary per
  project, so every project that used the DBC would have to set it
  again. That is the case ADR 0010 exists to prevent.
- **Both: DBC attribute plus a project override, shipped together.**
  The precedence rule is written down above, but nothing needs the
  override yet, and a settable-in-UI path is the half that then has to
  survive a future DBC writer.
- **Treating an attribute on an ineligible signal as a no-op.** Silence
  makes a mis-authored DBC indistinguishable from a correct one. A
  warning costs one line on the system log and names the signal.
- **A load failure on an unknown key.** A DBC written for a later
  cannet must still load in an earlier one; refusing the file makes the
  attribute a compatibility hazard.

## Consequences

- `cannet-dbc` carries the `Cannet*` reading in one place per
  attribute, and its parse warnings are the single channel for
  "the DBC said something cannet could not use".
- README's calculated-fields block is the reference list of cannet
  attributes; it grows with each new one. If the set outgrows a code
  block, it wants its own reference page.
- Raw integer bit fields render base-10 by default; hex is the
  `CannetDisplay "radix=hex"` opt-in, carried to every view as
  `display_hex` on the decoded signal and on the signal descriptor.
- ADR 0026 records the log-scale half: axis property, never overridden
  by a DBC hint.
