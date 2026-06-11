# ADR 0029 — Signal value→color maps as a standalone project element

Status: accepted (2026-06-10) — records a prototype shape; see Consequences.

## Context

We want to color a signal's displayed values by what the value
*is* — an enum signal's `Drive` / `Reverse` / `Park` states each
getting a color, or a numeric signal's danger band showing red —
and have that coloring apply **everywhere the signal is shown**
(trace rows today; plots later), rather than being re-specified per
view.

Two persistence options were weighed and rejected:

- **Colors in the DBC via `BA_` custom attributes.** The DBC stack
  is parse-only — `can-dbc` has no serialiser, so there is no write
  path — and `BA_` attributes can't attach to individual `VAL_`
  entries anyway. ADR 0010 (no sidecar files) pushes data into the
  format's own mechanism *when one exists*; here it doesn't, so the
  project file is the right home.
- **Deriving colors automatically** (hash / palette). Rejected: the
  point is explicit user control over which value gets which color.

## Decision

**A value→color map is a standalone project element** —
`kind: "colormap"` — that is **not a graph node** and is **not wired
through `sources` / `sinks`**. It targets one signal and lists
value→color rules; any view that renders that signal applies it.

Shape (frontend `ProjectElement` union; mirrored in the host project
model):

```
{
  kind: "colormap";
  id: string;
  name?: string;            // display name (ADR 0019)
  busId?: string | null;    // optional bus scope; null / absent = any bus
  messageId: number;        // target message arbitration id
  extended: boolean;        // std / ext discriminator
  signalName: string;       // target signal
  rules: { min: number; max: number; color: string }[];
}
```

**Rules are inclusive raw-value ranges.** An enum value `v` is the
degenerate range `[v, v]`; a numeric band is `[lo, hi]`. One shape
covers both the enum case (DBC `VAL_` keys) and arbitrary numeric
thresholds, so the model is not enum-only. `color` is a hex string.

**Resolution is global and first-match.** When a view renders a
decoded signal — message `(messageId, extended)`, name `signalName`,
on bus `B`, current raw value `v` — it consults the project's
colormap elements: the first whose target matches the signal (and
whose `busId` is null/absent or equals `B`), then that map's first
rule whose `[min, max]` contains `v`, supplies the color. No match
⇒ no tint. This is deliberately unlike the `filter` element, which a
consumer opts into via `sources`; a colormap is **ambient**.

**Each consumer renders the color in its own idiom.** In the trace
views (chronological and by-id expanded signal cells) it is a
low-opacity background tint on the value cell, so the text stays
legible. In a plot it fills the **enum logic-analyzer lane box** (ADR
0026) for each held value — the box that already carries the value's
name — so the lane reads in color. Both consume the same resolver.

**It is not in the project graph.** Like other non-graph concerns it
is created and edited through its own config panel (mirroring the
filter editor) and listed wherever elements are listed, but the
`xyflow` graph excludes it.

## Why

- **Project element, not DBC:** the DBC is read-only in our stack;
  project state is where mutable, user-authored overlays already live
  (calculated-field overrides, layout, RBS run flags).
- **Standalone, not wired:** coloring is a presentation concern that
  should *just apply* wherever the signal appears. Wiring each
  trace/plot to a colormap (the filter model) would be ceremony with
  no benefit, and would let the same signal color differently in
  different panels — the opposite of the goal.
- **Range rules, not enum-only:** the brief was a DBC-informed
  value→color mapper, "not even just enums." Inclusive ranges
  subsume exact enum values at no extra cost.
- **First-match precedence:** simple and explicable. Overlap is the
  user's to resolve (reorder maps / rules); we don't blend colors.

## Consequences

- A new element `kind` threads through the element union, the host
  project (de)serialisation + healing, the registry, and element-label
  resolution; the graph explicitly skips it.
- Resolution runs per rendered signal value. It is a small linear scan
  (few colormaps, few rules) compiled once per render into a lookup the
  row renderers call — it must not degrade into a per-row DBC
  re-derivation.
- This ADR records a **prototype**. Trace cells and the plot enum lane
  consume it today. Deliberately deferred: a richer rule editor
  (gradients, an "else" color), numeric-signal plot rendering (only the
  enum lane is tinted so far), and whether `busId`-less maps should
  match by `(messageName, signalName)` instead of numeric id. The data
  shape above is the stable part.
