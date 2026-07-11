/// Drag-and-drop plumbing for signals across the GUI. Every panel
/// that produces a draggable signal (the DBC discovery panel, the
/// trace expanded-row decoded signal lines, the by-id panel signal row, and
/// the plot panel's own side-panel signal rows) sets
/// the same mime type with the same payload shape, so any drop target
/// reads them through one parser.
///
/// The plot panel's [`PlotPanel`](./PlotPanel.tsx) drop handler is the
/// canonical sink today. It accepts both shapes the parser produces —
/// the legacy single-`SignalRef` JSON form that internal panel drags
/// have always set, and the `{signals: SignalRef[]}` form the
/// multi-select / message-row drags require.

/// Mime type carried on the `DataTransfer`. Receiving panels check
/// `e.dataTransfer.types.includes(SIGNAL_DND_MIME)` to filter
/// drop-overs.
export const SIGNAL_DND_MIME = "application/x-cannet-plot-signal";

/// The fields a draggable signal must carry — every field the plot
/// panel needs to identify and sample it. `color` is intentionally
/// absent: the receiver assigns a colour at drop time (existing plot
/// panel behaviour). Same shape as the plot panel's internal
/// `SignalRef` minus `color` / `hidden`.
export interface DraggableSignalRef {
  /// Logical bus this signal is bound to. `null` is the legacy "any
  /// bus" path — used only when the project has no buses configured.
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
  messageName: string;
  unit: string;
}

/// Validator for one draggable signal ref. Mirrors the plot panel's
/// `isSignalRefCore` so the same loose shape is accepted across drag
/// sources (the receiver re-validates anyway).
export function isDraggableSignalRef(v: unknown): v is DraggableSignalRef {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.messageId === "number" &&
    typeof o.extended === "boolean" &&
    typeof o.signalName === "string" &&
    typeof o.messageName === "string" &&
    typeof o.unit === "string" &&
    (o.busId == null || typeof o.busId === "string")
  );
}

/// Encode one or more signals onto the event's `DataTransfer`. Always
/// writes the array form (`{signals: [...], sourcePanelId?}`) so
/// receivers parse one shape; the legacy single-ref form survives
/// only on the reading side. `effectAllowed = "move"` matches the
/// plot panel's existing internal drag for consistent cursor styling.
///
/// `sourcePanelId` lets a receiving plot panel distinguish a drag
/// that started inside itself (treat as **move** between areas) from
/// a drag from anywhere else (treat as **add** / copy). The DBC
/// panel and trace / by-id signal-cell drag sources omit this, so
/// they're always external; a plot panel's internal signal-row drag
/// passes its own `elementId`.
export function setSignalDragData(
  e: { dataTransfer: DataTransfer },
  signals: readonly DraggableSignalRef[],
  sourcePanelId?: string,
): void {
  e.dataTransfer.setData(
    SIGNAL_DND_MIME,
    JSON.stringify({ signals, sourcePanelId }),
  );
  // `copyMove` lets a receiver use either dropEffect — plot panel
  // shows "copy" (the more useful "drop here" cursor); other
  // receivers can pick "move". With `effectAllowed = "move"` some
  // browsers refuse the "copy" cursor and the drop-target gets
  // the circle-slash "no drop" indicator instead.
  e.dataTransfer.effectAllowed = "copyMove";
}

/// Parsed drag payload. `sourcePanelId` is `null` for the legacy
/// single-ref form (no panel id available) and for any payload that
/// didn't set one (DBC / trace / by-id sources). The plot panel uses
/// it to decide move vs. add semantics on drop.
export interface ParsedSignalDrag {
  signals: DraggableSignalRef[];
  sourcePanelId: string | null;
}

/// Parse a drag payload's mime data into a flat list of valid
/// `DraggableSignalRef`s + the source panel id (when present).
/// Accepts both shapes — a single ref (the plot panel's legacy
/// internal drag emitted that) and the array form. Returns
/// `{ signals: [], sourcePanelId: null }` for any unparseable or
/// empty payload so call sites can no-op uniformly.
export function parseSignalDragData(raw: string): ParsedSignalDrag {
  if (!raw) return { signals: [], sourcePanelId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { signals: [], sourcePanelId: null };
  }
  if (parsed != null && Array.isArray((parsed as { signals?: unknown }).signals)) {
    const o = parsed as { signals: unknown[]; sourcePanelId?: unknown };
    return {
      signals: o.signals.filter(isDraggableSignalRef),
      sourcePanelId: typeof o.sourcePanelId === "string" ? o.sourcePanelId : null,
    };
  }
  return {
    signals: isDraggableSignalRef(parsed) ? [parsed] : [],
    sourcePanelId: null,
  };
}

/// Fan one signal out across the buses a given DBC applies to. The
/// DBC panel calls this when producing drag payloads.
///
/// - Scoped DBC (`scopedBuses.length > 0`): emit one ref per scope
///   bus. The user explicitly bound the DBC to these buses, so each
///   one is a valid (and intentional) instance worth plotting on its
///   own series.
/// - Unscoped DBC (`scopedBuses.length === 0`): emit a single
///   `busId: null` ref — the legacy "any bus" path. The host's
///   sampler treats `null` as "no bus filter" and resolves whichever
///   bus carries the frames. We deliberately do NOT fan an unscoped
///   DBC across every project bus here (which is what `list_signals`
///   does for the plot picker dropdown); on drop that would
///   manufacture N copies of every signal even though the user never
///   asked for per-bus disambiguation.
///
/// This is asymmetric with `list_signals` on purpose — the dropdown
/// needs explicit (bus, signal) entries for the user to *pick*; drag
/// is a single gesture without that disambiguation step.
export function fanOutByBus(
  base: Omit<DraggableSignalRef, "busId">,
  scopedBuses: readonly string[],
): DraggableSignalRef[] {
  if (scopedBuses.length === 0) {
    return [{ ...base, busId: null }];
  }
  return scopedBuses.map((busId) => ({ ...base, busId }));
}

/// Deduplicate signal refs by their `(busId, messageId, extended,
/// signalName)` identity — used when a multi-select drag mixes
/// message-row drags (every signal in that message) with signal-row
/// drags that happen to overlap.
export function dedupeSignalRefs(
  refs: readonly DraggableSignalRef[],
): DraggableSignalRef[] {
  const seen = new Set<string>();
  const out: DraggableSignalRef[] = [];
  for (const r of refs) {
    const k = `${r.busId ?? ""}|${r.messageId}|${r.extended ? "x" : "s"}|${r.signalName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
