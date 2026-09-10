/// The **math signal** case the ADR 0031 render harness measures with.
///
/// `--math-on-start` defines this set over whatever project the launch
/// opened, once its signal catalog has landed. It is a launch flag and
/// not a project of its own on purpose: the baseline project is the
/// *comparand* for every reading ever taken on this rig, and growing it
/// would invalidate the series (a recorded failure mode of this
/// harness). The same launch, twice, with and without the flag, is the
/// controlled pair.
///
/// What it defines is chosen to exercise the three kernel shapes that
/// cost differently, over the busiest signals the project has:
///
/// | definition | shape | why it is in the set |
/// |---|---|---|
/// | a set function over a **pattern** | membership resolved per serve, pointwise over a merged timeline | the widest fan-in, and the only one whose operand list moves under it |
/// | an **exponential filter** | a sequential recurrence on level 0 | cannot be decimated away — it is the reason math is host-side at all |
/// | a **statistic** | a whole-level-0 pass whenever its operand grows | the one shape that is linear in the capture on every serve |
///
/// Nothing here is written to the project file by the harness: the
/// definitions are created through the ordinary command and live for
/// the session, exactly as they would if a person had typed them.

import type { MathDefinition, SignalDescriptorRecord } from "./types";

/// One definition of the case, as a factory over the catalog it is
/// being defined against: the harness opens whatever project the launch
/// names, so a case that hard-coded signal names would silently define
/// nothing on a different one.
interface MathCaseSpec {
  id: string;
  build: (catalog: readonly SignalDescriptorRecord[]) => MathDefinition | null;
}

/// The busiest signal the catalog holds, by the crude proxy a frontend
/// has: the first signal of the message with the most signals on it.
/// Deterministic — the catalog comes back in the host's descriptor
/// order — so two runs of the same project define the same case.
function busiestSignal(
  catalog: readonly SignalDescriptorRecord[],
): SignalDescriptorRecord | null {
  const perMessage = new Map<string, number>();
  for (const s of catalog) {
    const k = `${s.bus_id ?? ""}|${s.message_id}`;
    perMessage.set(k, (perMessage.get(k) ?? 0) + 1);
  }
  let best: SignalDescriptorRecord | null = null;
  let bestCount = -1;
  for (const s of catalog) {
    const n = perMessage.get(`${s.bus_id ?? ""}|${s.message_id}`) ?? 0;
    if (n > bestCount) {
      bestCount = n;
      best = s;
    }
  }
  return best;
}

/// A regex that matches a good share of the catalog's paths without
/// matching all of it: the longest common prefix of the busiest
/// message's signal names, which on a generated database is the family
/// name a numbered set shares.
function busiestFamilyPattern(catalog: readonly SignalDescriptorRecord[]): string | null {
  const seed = busiestSignal(catalog);
  if (!seed) return null;
  const family = catalog.filter(
    (s) => s.bus_id === seed.bus_id && s.message_id === seed.message_id,
  );
  if (family.length < 2) return null;
  let prefix = family[0].signal_name;
  for (const s of family) {
    let i = 0;
    while (i < prefix.length && i < s.signal_name.length && prefix[i] === s.signal_name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  // A prefix short enough to match half the database is worse than no
  // case at all — it would measure the pattern engine, not the kernels.
  if (prefix.length < 3) return null;
  return `${prefix}\\w*$`;
}

const SPECS: readonly MathCaseSpec[] = [
  {
    id: "perf-math-max-family",
    build: (catalog) => {
      const pattern = busiestFamilyPattern(catalog);
      if (!pattern) return null;
      return {
        id: "perf-math-max-family",
        name: "",
        unit: null,
        function: { kind: "max" },
        // Pattern-only, so the host's own default name applies and the
        // membership stays live — the shape the ruling describes.
        operands: { picks: [], patterns: [pattern] },
      };
    },
  },
  {
    id: "perf-math-expfilter",
    build: (catalog) => {
      const seed = busiestSignal(catalog);
      if (!seed) return null;
      return {
        id: "perf-math-expfilter",
        name: "perf expfilter",
        unit: null,
        function: { kind: "expfilter", tau_seconds: 0.5 },
        operands: {
          picks: [
            {
              busId: seed.bus_id,
              messageId: seed.message_id,
              extended: seed.extended,
              signalName: seed.signal_name,
            },
          ],
          patterns: [],
        },
      };
    },
  },
  {
    id: "perf-math-statistic",
    build: (catalog) => {
      const seed = busiestSignal(catalog);
      if (!seed) return null;
      return {
        id: "perf-math-statistic",
        name: "perf statistic",
        unit: null,
        function: { kind: "statistic", statistic: "mean", percentile: 95 },
        operands: {
          picks: [
            {
              busId: seed.bus_id,
              messageId: seed.message_id,
              extended: seed.extended,
              signalName: seed.signal_name,
            },
          ],
          patterns: [],
        },
      };
    },
  },
  {
    id: "perf-math-on-math",
    build: () => ({
      id: "perf-math-on-math",
      name: "perf filtered max",
      unit: null,
      // Math over math: a chain the fill has to order, so a serve pays
      // for the dependency walk as well as the kernels.
      function: { kind: "expfilter", tau_seconds: 2 },
      operands: {
        picks: [
          {
            busId: null,
            messageId: 0,
            extended: false,
            signalName: "perf-math-max-family",
            math: true,
          },
        ],
        patterns: [],
      },
    }),
  },
];

/// The definitions to create for this catalog, in dependency order (a
/// definition is refused if its math operand does not exist yet).
/// Empty when the catalog is too small to define the case over — which
/// a caller should treat as "the run measured no math", not as an
/// error.
export function perfMathDefinitions(
  catalog: readonly SignalDescriptorRecord[],
): MathDefinition[] {
  const out: MathDefinition[] = [];
  const have = new Set<string>();
  for (const spec of SPECS) {
    const definition = spec.build(catalog);
    if (!definition) continue;
    // A math operand that the case could not build is dropped with the
    // definition that reads it, rather than defined dangling.
    const missing = definition.operands.picks.some((p) => p.math && !have.has(p.signalName));
    if (missing) continue;
    have.add(definition.id);
    out.push(definition);
  }
  return out;
}

/// One math signal as a view references it: no bus, no message, the
/// definition's stable id in the signal-name slot.
function caseRef(id: string) {
  return {
    busId: null,
    messageId: 0,
    extended: false,
    signalName: id,
    messageName: "Math",
    unit: "",
    math: true as const,
  };
}

/// This element's config with the case's series added to it, or `null`
/// when the element is not one that shows signals (or already holds
/// them).
///
/// Defining a math signal costs nothing on its own: a math pyramid is
/// built by a **serve**, so the case is only a case once the open views
/// ask for the series. This is the harness doing what a person
/// measuring would do by hand — drag them into the plot areas and the
/// signal views — through the ordinary element-config path, so each
/// panel rehydrates from it. Nothing is written to the project file:
/// the harness never saves.
export function withPerfMathCase(
  kind: string,
  config: unknown,
  ids: readonly string[],
): Record<string, unknown> | null {
  const cfg = (config ?? {}) as Record<string, unknown>;
  if (kind === "plot") {
    const areas = Array.isArray(cfg.areas) ? (cfg.areas as Record<string, unknown>[]) : [];
    if (areas.length === 0) return null;
    // The first area only: the case is one collection of series, not
    // one per area, and duplicating it across areas would measure the
    // duplication rather than the math.
    const first = areas[0];
    const signals = Array.isArray(first.signals) ? (first.signals as { signalName: string }[]) : [];
    if (signals.some((s) => ids.includes(s.signalName))) return null;
    return {
      ...cfg,
      areas: [{ ...first, signals: [...signals, ...ids.map(caseRef)] }, ...areas.slice(1)],
    };
  }
  if (kind === "signals") {
    const selection = (cfg.selection ?? {}) as Record<string, unknown>;
    const keys = Array.isArray(selection.keys)
      ? (selection.keys as { signalName: string }[])
      : [];
    if (keys.some((k) => ids.includes(k.signalName))) return null;
    return {
      ...cfg,
      selection: { ...selection, keys: [...keys, ...ids.map(caseRef)] },
    };
  }
  return null;
}
