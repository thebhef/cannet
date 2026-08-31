# 0139 — Units and Scaling for Math Signals

> **Opened 2026-09-06** by owner instruction, immediately after the
> task-135 math engine landed. **Executes now, on the current stack**
> (owner ruling): branch `task139-units` on `task135-surfaces`, with
> `doc-closeout` restacked on top. Groomed 2026-09-06; all questions
> ruled.

The ask, in the owner's words:

- apply a scalar to the upstream signals in our math channels, and
  scalars on the outputs;
- a unit library would be really nice to use for this — being able to
  choose units, and load them from the DBC;
- unit is an arbitrary field in DBC, so users add customizations to a
  selectable list of units in a settings-view section; a sparse dict
  config persists whatever the user has changed.

## Grooming notes

**2026-09-06 (owner rulings):**

1. **Unit-aware resolve ("architecture B").** The definition stores
   intent, not numbers: a target unit on the definition means the host
   derives each member's conversion from its *own* DBC unit string —
   through the unit library plus the user's customization dict — fresh
   at resolve time. Pattern members with mixed units each get their
   own correct factor; a customization edit rescales every dependent
   channel (factors join the cache fingerprint, so caches rebuild).
   Rejected: storing computed scalars with the unit picker as a
   one-shot calculator — it cannot serve pattern operands and throws
   the intent away at edit time.
2. **Affordances for what the DBC doesn't map cleanly** (accepted
   2026-09-06): manual `{gain, offset}` on any operand and on the
   output (the unit-free path, composes with or replaces conversion);
   per-operand source-unit override ("treat this operand as mA")
   local to the channel; unconvertible members pass through unscaled
   and are *reported* by resolve, never silent; a unit outside the
   library's list means manual scalars (a define-custom-unit row is
   deliberately out of scope until it bites).
3. **Conversions are affine** (gain + offset) — covers °C↔K↔°F.
4. **No mapping dialog.** The customization UI is a **section in the
   settings view**: a selectable list of units provided by the unit
   library, to which the user adds customizations (DBC unit string →
   library unit). The settings model's existing `workspace` scope
   carries it, so the sparse dict persists with the project — it
   interprets that project's DBCs and travels with them. Built-in
   recognitions cover common strings ("V", "mV", "A", "degC", "°C",
   "rpm", "%", …); the dict stores only what the user changes.
5. **Unit library: `runtime_units`** (MIT, 0.6.x) — found and adopted
   2026-09-06 at owner instruction to use a library rather than an
   in-repo table; see `plans/technology-inventory.md` § Units /
   Quantities for the evaluation and the rejected candidates
   (rink-core's GPL data file, uom/dimensioned's compile-time types).
   Wrapped behind a host-side facade so the depended-on surface stays
   narrow.

**2026-09-06, evening bench (owner ruling — integration and time):**

6. **Convertibility accounts for the function's time dimension.** An
   integration of an `A` operand with unit `Ah` was badged
   unconvertible: resolve compared operand dimension (current) to
   target (charge) as if the function were pointwise. The operand is
   right as the DBC declares it — the *decision* is wrong: integration
   multiplies by time, so the question is whether `current x time`
   reaches the requested unit. Design: the facade learns the
   rate<->integral pairings (current x t = charge, canonical A*s =
   coulomb; power x t = energy, W*s = joule); for Integration a
   requested unit in the *integrated* dimension means no operand
   conversion where the operand already speaks the rate family — the
   output affine carries coulomb->Ah (/3600) and kin, via the library.
   A unit in the operand's own family keeps operand-target semantics
   (integrate in mA), so the owner's `A` workaround stays valid. With
   no unit set, integrating a recognised operand derives a *real*
   integrated unit (coulomb, joule) instead of the `*s` string —
   best-effort, per the owner; unrecognised operands keep the suffix.
   The badge then marks only true dead ends.

**Implementation notes (read 2026-09-06):**

- `MathDefinition.unit: Option<String>` already exists (display unit,
  derived when unset) — it becomes the conversion **target**: set and
  recognised ⇒ operands convert to it; unset or unrecognised ⇒
  today's behaviour, no conversion.
- `MathOperandRef` derives `Eq + Hash`; f64 fields would break both.
  Per-operand parameters ride a wrapper (`serde(flatten)` keeps old
  project files deserialising) rather than the ref itself.
- Fingerprints (`signal_fingerprint::math_encoding`) must mix each
  operand's effective `(gain, offset)` and the output pair, so a
  changed scalar or customization rebuilds the cache.
- Per-operand affine applies before the function (on the operand's
  samples), output affine after it; `MathFunction::Scale` remains as
  the chainable standalone.
- `runtime_units` distinguishes TemperatureInterval from
  ThermodynamicTemperature; DBC temperature readings map to the
  absolute kind by default.

## Phases

**Phase 1 — model, engine, conversion** (host). The `runtime_units`
dependency behind a `units` facade (unit list, dimension, affine
gain/offset between units, built-in DBC-string recognitions, the
workspace-scoped customization dict overlaying them); the operand
wrapper schema (manual gain/offset, source-unit override) and output
gain/offset; resolve-time per-member conversion with unconverted
members reported; fingerprint mixing; kernels applying operand affine
pre-function and output affine post-function. TDD throughout.

**Phase 2 — editor and settings section** (frontend). Operand and
output scalar/unit controls in the math editor, unconverted-member
flags, the settings-view units section (library-provided selectable
list + customization rows over the workspace-scoped dict). DOM tests.

**Phase 4 — integration units** (host; opened from the evening bench,
ruling 6). The rate<->integral pairing table in the facade;
Integration-aware resolve (integrated-dimension target => output
affine, own-family target => operand semantics, else badge); derived
unit becomes the canonical integrated unit for recognised operands.
Amends `task139-units` (message updated). Tests: A->Ah (/3600),
mA->Ah, W->kWh, derived coulomb, own-family mA target, true-mismatch
badge.

## Exit criteria

- [ ] A set function over a pattern whose members carry mixed units
      (mA next to A) computes in the definition's target unit, each
      member converted by its own factor; changing a customization
      rescales the channel on the next serve.
- [ ] Manual gain/offset works on operands and output with no units
      anywhere; source-unit override converts a mislabelled operand.
- [ ] Unconvertible members pass through unscaled and the editor
      shows which; nothing converts silently wrong.
- [ ] °C/°F/K convert correctly (affine, absolute temperature).
- [ ] Old project files load unchanged; a definition saved with the
      new fields round-trips.
- [ ] The settings-view units section lists the library's units and
      persists only the user's customizations, with the project.
- [ ] Technology inventory records the dependency decision; docs
      match shipped behaviour.

## Status log

(none yet)

## Blockers / side effects

(none yet)
