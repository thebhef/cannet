/// The **math signal** editing model (`docs/CONTEXT.md`): what each
/// function offers an editor — its operand sections and its parameter
/// fields — and the pure transforms one edit makes to a definition.
///
/// Kept free of React so the shapes can be unit-tested, and so the
/// Database panel, a signal panel row and a plot's side list all write
/// the same edit. **There is no draft here**: a math signal is created
/// the moment its function is picked and each field commits to the
/// registry as it is left, so what an editor holds is the definition
/// itself and what it produces is the next one.
///
/// The host owns the model (ADR 0025): nothing here resolves
/// membership, derives a unit or judges a definition —
/// `list_math_signals` answers all three, including *why* an unfinished
/// definition is not usable yet. What lives here is what the form needs
/// to render and what one field's commit changes.

import type {
  MathArity,
  MathDefinition,
  MathFunction,
  MathFunctionKind,
  MathOperandRef,
  MathSignalRecord,
} from "./types";

/// One parameter field of a function. `key` is the name the parameter
/// travels under inside the tagged function object — the Rust field
/// name, since the enum renames its variants and not their fields.
export interface MathParamSpec {
  key: string;
  label: string;
  /// `select` renders `options`; `number` renders a numeric input.
  kind: "number" | "select";
  default: number | string;
  options?: readonly string[];
  /// Enabled only while the parameter named here holds `value` — the
  /// statistic's Percentile field, which means nothing unless the
  /// statistic *is* a percentile.
  onlyWhen?: { key: string; value: string };
}

/// One function as the editor offers it.
export interface MathFunctionSpec {
  kind: MathFunctionKind;
  /// Menu label — what the creation menu offers and the editor titles
  /// itself with.
  label: string;
  arity: MathArity;
  params: readonly MathParamSpec[];
}

/// Every function the host computes, in the order the creation menu
/// lists them (`math_signals::MathFunction`). Arity decides the fixed
/// operand sections; a function's parameters are exactly the fields its
/// variant carries.
export const MATH_FUNCTIONS: readonly MathFunctionSpec[] = [
  { kind: "sum", label: "Sum", arity: "set", params: [] },
  { kind: "difference", label: "Difference (A − B)", arity: "pair", params: [] },
  { kind: "product", label: "Product", arity: "set", params: [] },
  {
    kind: "scale",
    label: "Scale (g·x + b)",
    arity: "one",
    params: [
      { key: "gain", label: "Gain", kind: "number", default: 1 },
      { key: "offset", label: "Offset", kind: "number", default: 0 },
    ],
  },
  { kind: "min", label: "Min of set", arity: "set", params: [] },
  { kind: "max", label: "Max of set", arity: "set", params: [] },
  { kind: "average", label: "Average of set", arity: "set", params: [] },
  { kind: "median", label: "Median of set", arity: "set", params: [] },
  { kind: "range", label: "Range of set", arity: "set", params: [] },
  {
    kind: "expfilter",
    label: "Exponential filter",
    arity: "one",
    params: [{ key: "tau_seconds", label: "τ (s)", kind: "number", default: 2 }],
  },
  { kind: "integration", label: "Integration", arity: "one", params: [] },
  {
    kind: "duty",
    label: "Duty cycle",
    arity: "one",
    params: [
      { key: "threshold", label: "Threshold", kind: "number", default: 0.5 },
      { key: "window_seconds", label: "Window (s)", kind: "number", default: 5 },
    ],
  },
  {
    kind: "frequency",
    label: "Frequency",
    arity: "one",
    params: [
      { key: "threshold", label: "Threshold", kind: "number", default: 0.5 },
      { key: "window_seconds", label: "Window (s)", kind: "number", default: 5 },
    ],
  },
  {
    kind: "statistic",
    label: "Statistic (over capture)",
    arity: "one",
    params: [
      {
        key: "statistic",
        label: "Statistic",
        kind: "select",
        default: "mean",
        options: ["min", "max", "mean", "median", "percentile"],
      },
      {
        key: "percentile",
        label: "Percentile",
        kind: "number",
        default: 95,
        onlyWhen: { key: "statistic", value: "percentile" },
      },
    ],
  },
  { kind: "rms", label: "RMS (instantaneous)", arity: "one", params: [] },
  {
    kind: "hline",
    label: "HLine",
    arity: "none",
    params: [{ key: "value", label: "Value", kind: "number", default: 0 }],
  },
];

const BY_KIND = new Map(MATH_FUNCTIONS.map((f) => [f.kind, f]));

/// The spec for one function kind. Every kind the host can answer with
/// has one — the listing above is checked against `MathFunction::kind`.
export function mathFunctionSpec(kind: MathFunctionKind): MathFunctionSpec {
  const spec = BY_KIND.get(kind);
  if (!spec) throw new Error(`no such math function: ${kind}`);
  return spec;
}

/// One prepopulated operand section. Users cannot add or remove these:
/// which sections exist is the function's arity, not a choice.
export interface OperandSection {
  label: string;
  /// The `picks` index this section fills, or `"set"` for the section
  /// that collects a whole membership.
  slot: number | "set";
}

export function operandSections(spec: MathFunctionSpec): OperandSection[] {
  switch (spec.arity) {
    case "none":
      return [];
    case "one":
      return [{ label: "Signal", slot: 0 }];
    case "pair":
      return [
        { label: "A", slot: 0 },
        { label: "B", slot: 1 },
      ];
    case "set":
      return [{ label: "Signals", slot: "set" }];
  }
}

function defaultFunction(spec: MathFunctionSpec): MathFunction {
  const fn: MathFunction = { kind: spec.kind };
  for (const p of spec.params) fn[p.key] = p.default;
  return fn;
}

/// A blank definition for a function the user just picked from the
/// creation menu.
///
/// It is stored immediately and is **unfinished**: no name, no
/// operands, parameters at their defaults. The host keeps it, marks it
/// invalid and serves it empty until the user fills it in — there is no
/// staging area between picking a function and having one.
export function newMathDefinition(kind: MathFunctionKind, id: string): MathDefinition {
  return {
    id,
    name: "",
    unit: null,
    function: defaultFunction(mathFunctionSpec(kind)),
    operands: { picks: [], patterns: [] },
  };
}

/// The stored half of a listing record — what an edit rewrites. The
/// resolved half (membership, paths, unit, validity) is the host's
/// answer about it and never travels back.
export function definitionOf(record: MathSignalRecord): MathDefinition {
  return {
    id: record.id,
    name: record.name,
    unit: record.unit,
    function: { ...record.function },
    operands: {
      picks: [...(record.operands?.picks ?? [])],
      patterns: [...(record.operands?.patterns ?? [])],
    },
  };
}

/// Is this parameter field live, given what the definition's governing
/// parameter holds? A field that is not is not rendered at all.
export function parameterEnabled(param: MathParamSpec, fn: MathFunction): boolean {
  if (!param.onlyWhen) return true;
  return fn[param.onlyWhen.key] === param.onlyWhen.value;
}

/// One parameter changed. Numbers are stored as numbers whatever the
/// input handed over, so the definition matches the tagged variant the
/// host deserialises into.
export function withParam(
  definition: MathDefinition,
  param: MathParamSpec,
  value: number | string,
): MathDefinition {
  return {
    ...definition,
    function: {
      ...definition.function,
      [param.key]: param.kind === "number" ? Number(value) : String(value),
    },
  };
}

/// One operand placed in a section.
///
/// A single-signal slot replaces what it holds; the set section
/// appends, ignoring a signal it already collects. Picking into the
/// second slot of a pair while the first is empty lands in the first —
/// the picks are an ordered list with no room for a hole, and A is
/// simply whichever operand comes first.
export function withPick(
  definition: MathDefinition,
  slot: number | "set",
  ref: MathOperandRef,
): MathDefinition {
  const picks = [...definition.operands.picks];
  if (slot === "set") {
    const key = operandRefKey(ref);
    if (picks.some((p) => operandRefKey(p) === key)) return definition;
    picks.push(ref);
  } else if (slot < picks.length) {
    picks[slot] = ref;
  } else {
    picks.push(ref);
  }
  return { ...definition, operands: { ...definition.operands, picks } };
}

/// The operand at `index` removed.
export function withoutPick(definition: MathDefinition, index: number): MathDefinition {
  return {
    ...definition,
    operands: {
      ...definition.operands,
      picks: definition.operands.picks.filter((_, i) => i !== index),
    },
  };
}

/// The section's patterns replaced. Only a set takes them; the host
/// marks a definition carrying one anywhere else invalid.
export function withPatterns(
  definition: MathDefinition,
  patterns: readonly string[],
): MathDefinition {
  return {
    ...definition,
    operands: { ...definition.operands, patterns: [...patterns] },
  };
}

/// A section's own validity, shown in its header.
export interface SectionValidity {
  ok: boolean;
  message: string;
}

/// A single-signal slot holds exactly one signal, or asks for one.
export function slotValidity(pick: MathOperandRef | null | undefined): SectionValidity {
  return pick == null
    ? { ok: false, message: "pick one" }
    : { ok: true, message: "1 signal" };
}

/// A set section counts its picks and its live pattern matches
/// together. Two is the useful floor — a set of one is legal to the
/// host, so this is guidance in the section header and not a refusal.
export function setValidity(
  picks: readonly MathOperandRef[],
  patterns: readonly { valid: boolean; matches: number }[],
): SectionValidity {
  if (patterns.some((p) => !p.valid)) return { ok: false, message: "bad regex" };
  const n = picks.length + patterns.reduce((sum, p) => sum + p.matches, 0);
  return n >= 2
    ? { ok: true, message: `${n} signals` }
    : { ok: false, message: "needs ≥ 2" };
}

/// What a math signal's drag payload carries in the message slot: a
/// math series has no message, and this is the word every surface
/// falls back to before it can look the definition up for itself.
export const MATH_MESSAGE_LABEL = "Math";

/// The line a math row shows where a DBC-backed row shows its message
/// path, given the buses feeding it (`MathSignalRecord.busIds`, which
/// the host resolves transitively).
///
/// One bus reads like a normal row's provenance; **several read as
/// "Math - Multiple Busses"** (owner ruling) rather than a list, which
/// at a plot side list's width would truncate to nothing useful. The
/// chips beside it name them individually either way.
export function mathBusLabel(
  busIds: readonly string[],
  busNames: ReadonlyMap<string, string>,
): string {
  if (busIds.length === 0) return MATH_MESSAGE_LABEL;
  if (busIds.length > 1) return `${MATH_MESSAGE_LABEL} - Multiple Busses`;
  return `${busNames.get(busIds[0]) ?? busIds[0]} · ${MATH_MESSAGE_LABEL}`;
}

/// Identity of one operand reference — the series key its provenance
/// puts it in (`plotData.ts::signalKey`'s shape), so a file-backed
/// signal and a message's cannot collide on a shared message-id slot.
export function operandRefKey(ref: MathOperandRef): string {
  const flag = ref.math ? "m" : ref.fileBacked ? "f" : ref.extended ? "x" : "s";
  return `${ref.busId ?? "*"}|${flag}:${ref.messageId}:${ref.signalName}`;
}
