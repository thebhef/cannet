/// **The remap pick**: re-pointing every persisted reference to one
/// signal at the signal that replaced it — as *one* operation.
///
/// A view stores its own copy of a signal reference: the identity
/// `(bus, message id, extended, signal name)`
/// ([ADR 0038](../../docs/adr/0038-canonical-signal-path.md)) plus,
/// where the view records them, the fields a drift is measured against.
/// When a database renames a signal, every one of those copies goes
/// dead at once, and the repair is to point them at the new name. That
/// is a *rewrite*, not a lookup: the alternative — a durable
/// old-name → new-signal alias table consulted on every resolution —
/// outlives the reason it was created and mis-resolves quietly, so the
/// references themselves are what change.
///
/// **One operation, every store behind it.** {@link remapSignal} is a
/// single function over every store rather than a call per store, and
/// that is the whole point of the module: one signal is one row and a
/// user must never repeat a fix per view, so a rewrite spread across
/// five call sites is five chances to miss one — and the miss is
/// silent, because the repair surface reports success while one view
/// still points at the dead name. **A new persisted signal reference
/// anywhere in the app belongs in here.**
///
/// The stores it rewrites:
///
/// A reference that names **no bus** is repaired the same way, and this
/// is the only remap that moves a bus: the panel offers it the
/// definitions on every bus that decodes, and choosing one rewrites
/// every stored reference onto that bus.
///
/// | Store | What holds the reference |
/// | --- | --- |
/// | plot element `config` | each area's manual `signals`, and the area's `primarySignalKey` |
/// | signals element `config` | the manual `selection.keys`, and the `sections.assignments` entry keyed on the signal |
/// | colormap element | its one target signal (ADR 0029) |
/// | transmit pool (host) | a frame's calculated-field counter / CRC target signal (ADR 0027) |
/// | project `signal_colors` | the user's colour override for the signal (ADR 0026) |
///
/// **What holds no reference to rewrite**, and why it is not an
/// omission: a *pattern* — a plot area's `patterns`, the signals view's
/// selection patterns, the plot's solo pattern, a signal-generator rule
/// — is a regex re-evaluated against the live catalog on every render,
/// with no stored identity for a rename to break; it simply starts
/// matching the new name (or stops matching), which is the behaviour
/// the user asked for when they typed a pattern. A transmit frame's
/// byte-level signal edits are resolved against the assigned database
/// at edit time and flattened to bytes immediately, leaving no
/// persisted pick behind. This is the same split
/// `viewSignalsPush.ts` draws for what a view *reports* to the repair
/// surface, and for the same reason.
///
/// **The choice is the whole answer** (ADR 0054: a decoded value has
/// exactly one definition). The picker offers `(database, signal)`
/// pairs, so acting on a pick means both halves: the references move to
/// the chosen *signal*, and the chosen *database* is recorded for it
/// where that is not already what load order resolves — the host keeps
/// only a real, non-default choice, so the common case (one database
/// defines the target) records nothing. Any choice recorded against the
/// old name is dropped in the same breath: nothing references it any
/// more, and a pick nothing consults is exactly the durable indirection
/// this design rejected.

import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import { signalKey } from "./plotData";
import { useElementRegistry } from "./projectElements";
import { usePanelEditRecorder } from "./panelEditRecorder";
import { useUndoGesture } from "./undoGesture";
import type { PanelEditOp, PanelEditStep } from "./panelEditHistory";
import { useProjectContext } from "./projectContext";
import {
  configToFrame,
  recordToConfig,
  type TransmitFrameConfig,
} from "./transmitFrameConfig";
import type {
  CalcFieldsSpec,
  PanelViewConfig,
  ProjectElement,
  TransmitFrameRecord,
} from "./types";

/// One remap: the reference every store currently holds, and the
/// definition it is re-pointed at. The target is always a definition of
/// the *same* message — the repair surface's candidates are the
/// definitions that message offers — so the message id and its std/ext
/// flag never move.
///
/// The **bus** does move, in exactly one case: a reference saved before
/// per-bus signal binding names none, decodes nothing
/// ([ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)),
/// and the only repair open to it is being re-pointed at a bus that
/// does decode. Everywhere else {@link toBusId} equals
/// {@link fromBusId} and the rename is the whole of the change.
export interface SignalRemap {
  /// The bus every stored reference names today. `null` for the
  /// busless references the re-point exists for.
  fromBusId: string | null;
  /// The bus they are rewritten to. Equal to {@link fromBusId} for an
  /// ordinary rename.
  toBusId: string | null;
  messageId: number;
  extended: boolean;
  /// The name every stored reference holds today.
  from: string;
  /// The name they are all rewritten to.
  to: string;
  /// The pick recorded for the *from* signal today, if any — the undo
  /// step's inverse for the pick this rewrite drops (task 129). Read
  /// by the caller from the row before the write erases it.
  fromPickedDbc?: string | null;
  /// The target definition's message name — what a view that records
  /// one is re-recorded against.
  messageName: string;
  /// The target definition's unit, likewise.
  unit: string;
  /// The database whose definition was chosen. Recorded for the target
  /// signal where it is not the load-order default.
  dbcPath: string;
}

/// The stores {@link remapSignal} cannot reach on its own: the element
/// registry and the project's colour overrides both live in React
/// state. The host-owned stores (the transmit pool, the per-signal
/// database choice) it reaches through commands itself.
export interface SignalRemapStores {
  elements: readonly ProjectElement[];
  updateElement: (id: string, patch: Partial<ProjectElement>) => void;
  signalColors: Readonly<Record<string, string>>;
  setSignalColor: (key: string, color: string | null) => void;
  /// Record the whole rewrite as one undo step (task 129). Optional —
  /// a caller with no history (a test) just doesn't record.
  recordEdit?: (step: PanelEditStep) => void;
}

/// The identity the references hold today.
export function remapFromKey(remap: SignalRemap): string {
  return signalKey(remap.fromBusId, remap.messageId, remap.extended, remap.from);
}

/// The identity they are rewritten to.
export function remapToKey(remap: SignalRemap): string {
  return signalKey(remap.toBusId, remap.messageId, remap.extended, remap.to);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/// The canonical identity of a stored reference in an opaque panel
/// config blob, or `null` for anything that isn't shaped like one. A
/// file-backed series keys under its own flag and so can never match a
/// database rename — no database ever bore on it.
function storedRefKey(o: Record<string, unknown>): string | null {
  const messageId = o.messageId;
  const signalName = o.signalName;
  if (typeof messageId !== "number" || typeof signalName !== "string") return null;
  return signalKey(
    typeof o.busId === "string" ? o.busId : null,
    messageId,
    o.extended === true,
    signalName,
    o.fileBacked === true,
  );
}

/// Rewrite one list of stored references — a plot area's `signals`, the
/// signals view's `selection.keys`. Returns `null` when nothing in the
/// list names the old signal, so a caller can leave its config
/// identity-stable.
///
/// A rewritten entry keeps every field it carried that isn't part of
/// what the rename changed (a series' colour pick, its hidden flag),
/// and is **dropped** where the list already holds the target: the
/// rename would otherwise leave one view showing the same series twice.
function remapRefList(list: unknown, remap: SignalRemap): unknown[] | null {
  if (!Array.isArray(list)) return null;
  const fromKey = remapFromKey(remap);
  const toKey = remapToKey(remap);
  // Identities the entries this remap does *not* touch already hold.
  const taken = new Set<string>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const key = storedRefKey(entry);
    if (key !== null && key !== fromKey) taken.add(key);
  }
  let changed = false;
  const out: unknown[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || storedRefKey(entry) !== fromKey) {
      out.push(entry);
      continue;
    }
    changed = true;
    if (taken.has(toKey)) continue;
    taken.add(toKey);
    const next: Record<string, unknown> = {
      ...entry,
      signalName: remap.to,
      messageName: remap.messageName,
      unit: remap.unit,
    };
    // The bus is written only where it moves, so an ordinary rename
    // leaves an entry that never carried one exactly as it found it.
    if (remap.toBusId !== remap.fromBusId) next.busId = remap.toBusId;
    out.push(next);
  }
  return changed ? out : null;
}

/// A plot element's config: every area's manual series, and the area's
/// primary-signal key (which is a stored identity of its own).
export function remapPlotConfig(config: unknown, remap: SignalRemap): PanelViewConfig | null {
  if (!isRecord(config) || !Array.isArray(config.areas)) return null;
  const fromKey = remapFromKey(remap);
  const toKey = remapToKey(remap);
  let changed = false;
  const areas = config.areas.map((raw) => {
    if (!isRecord(raw)) return raw;
    const signals = remapRefList(raw.signals, remap);
    const primaryMoves = raw.primarySignalKey === fromKey;
    if (signals === null && !primaryMoves) return raw;
    changed = true;
    const next: Record<string, unknown> = { ...raw };
    if (signals !== null) next.signals = signals;
    if (primaryMoves) next.primarySignalKey = toKey;
    return next;
  });
  return changed ? { ...config, areas } : null;
}

/// A signals element's config: the manual selection keys, and the
/// section the signal was filed under — an assignment map keyed on the
/// canonical identity, so the rename moves the entry. A target that
/// already has a section of its own keeps it.
export function remapSignalsConfig(config: unknown, remap: SignalRemap): PanelViewConfig | null {
  if (!isRecord(config)) return null;
  const fromKey = remapFromKey(remap);
  const toKey = remapToKey(remap);
  let changed = false;
  const next: Record<string, unknown> = { ...config };
  const selection = config.selection;
  if (isRecord(selection)) {
    const keys = remapRefList(selection.keys, remap);
    if (keys !== null) {
      next.selection = { ...selection, keys };
      changed = true;
    }
  }
  const sections = config.sections;
  if (isRecord(sections) && isRecord(sections.assignments) && fromKey in sections.assignments) {
    const { [fromKey]: moved, ...rest } = sections.assignments;
    next.sections = {
      ...sections,
      assignments: toKey in rest ? rest : { ...rest, [toKey]: moved },
    };
    changed = true;
  }
  return changed ? next : null;
}

/// A colormap element's one target signal (ADR 0029). The rules the
/// user authored are value→colour and say nothing about the signal's
/// name, so they ride across unchanged.
export function remapColorMapPatch(
  element: Extract<ProjectElement, { kind: "colormap" }>,
  remap: SignalRemap,
): Partial<ProjectElement> | null {
  const key = signalKey(
    element.busId ?? null,
    element.messageId,
    element.extended,
    element.signalName,
  );
  if (key !== remapFromKey(remap)) return null;
  return remap.toBusId === remap.fromBusId
    ? { signalName: remap.to }
    : { signalName: remap.to, busId: remap.toBusId };
}

/// The patch one project element needs, or `null` when it holds no
/// reference to the old signal. The `kind` switch is the enumeration of
/// which element kinds store a signal identity at all.
export function remapElementPatch(
  element: ProjectElement,
  remap: SignalRemap,
): Partial<ProjectElement> | null {
  switch (element.kind) {
    case "plot": {
      const config = remapPlotConfig(element.config, remap);
      return config === null ? null : { config };
    }
    case "signals": {
      const config = remapSignalsConfig(element.config, remap);
      return config === null ? null : { config };
    }
    case "colormap":
      return remapColorMapPatch(element, remap);
    // A generator's rules are patterns; a transmit element holds only
    // its frames' ids (the frames themselves are host-owned, rewritten
    // by `remapTransmitFrames`); trace / filter / rbs elements name no
    // signal at all.
    default:
      return null;
  }
}

/// The transmit frames whose calculated fields (ADR 0027) name the old
/// signal, rewritten — only the ones that actually changed, so the
/// caller writes back exactly those.
export function remapTransmitFrames(
  frames: readonly TransmitFrameConfig[],
  remap: SignalRemap,
): TransmitFrameConfig[] {
  // A bus re-point moves no transmit frame: the frame sits on the bus
  // it transmits to, which is not the reference being repaired, and its
  // calculated field still names the same signal.
  if (remap.to === remap.from) return [];
  const out: TransmitFrameConfig[] = [];
  for (const frame of frames) {
    if (
      (frame.busId ?? null) !== remap.fromBusId ||
      frame.canId !== remap.messageId ||
      frame.extended !== remap.extended ||
      frame.calc == null
    ) {
      continue;
    }
    const calc: CalcFieldsSpec = { ...frame.calc };
    let changed = false;
    if (calc.counter != null && calc.counter.signal === remap.from) {
      calc.counter = { ...calc.counter, signal: remap.to };
      changed = true;
    }
    if (calc.crc != null && calc.crc.signal === remap.from) {
      calc.crc = { ...calc.crc, signal: remap.to };
      changed = true;
    }
    if (changed) out.push({ ...frame, calc });
  }
  return out;
}

/// **The operation.** Rewrite every persisted reference to
/// `remap.from` so it names `remap.to` instead — see the module doc for
/// the stores and for what deliberately holds nothing to rewrite.
///
/// There is no apply step and nothing to confirm: the element writes
/// land synchronously (every mounted panel on a rewritten element
/// resyncs, since the writes carry no writer token), and the host
/// stores announce their own changes, which is what brings the repair
/// surface's own rows back with the new answer.
export async function remapSignal(
  stores: SignalRemapStores,
  remap: SignalRemap,
): Promise<void> {
  const fromKey = remapFromKey(remap);
  const toKey = remapToKey(remap);
  // Judged on the whole identity, not on the name alone: a re-point
  // keeps the name and moves the bus, and is a real change.
  if (fromKey === toKey) return;

  // The views' own stored references.
  for (const element of stores.elements) {
    const patch = remapElementPatch(element, remap);
    if (patch !== null) stores.updateElement(element.id, patch);
  }

  // The project's colour override for the signal — the same series
  // under a new name, so the colour the user picked travels with it.
  // A target that already carries a colour of its own keeps it.
  const color = stores.signalColors[fromKey];
  if (color != null && stores.signalColors[toKey] == null) {
    stores.setSignalColor(toKey, color);
    stores.setSignalColor(fromKey, null);
  }

  // The host-owned transmit pool.
  const undoOps: PanelEditOp[] = [];
  const redoOps: PanelEditOp[] = [];
  // Mirrors the colour move above, which has already happened —
  // `color` is the pre-move read from the same closure.
  if (color != null && stores.signalColors[toKey] == null) {
    redoOps.push({ kind: "signalColor", key: toKey, color });
    redoOps.push({ kind: "signalColor", key: fromKey, color: null });
    undoOps.push({ kind: "signalColor", key: fromKey, color });
    undoOps.push({ kind: "signalColor", key: toKey, color: null });
  }
  const pool = await invoke<TransmitFrameRecord[]>("list_transmit_frames").catch(
    () => [] as TransmitFrameRecord[],
  );
  for (const frame of remapTransmitFrames(pool.map(recordToConfig), remap)) {
    const before = pool.find((r) => r.id === frame.id);
    const after = configToFrame(frame);
    if (before !== undefined) {
      undoOps.push({ kind: "transmitFrame", id: frame.id, frame: configToFrame(recordToConfig(before)) });
      redoOps.push({ kind: "transmitFrame", id: frame.id, frame: after });
    }
    await invoke("set_transmit_frame", { id: frame.id, frame: after }).catch(() => {});
  }

  // The per-signal database choice: record the chosen definition's
  // database for the target (the host keeps it only where it differs
  // from load order) and drop whatever was recorded for the name
  // nothing references any more.
  redoOps.push({ kind: "pick", signal: toKey, dbcPath: remap.dbcPath });
  redoOps.push({ kind: "pick", signal: fromKey, dbcPath: null });
  undoOps.push({ kind: "pick", signal: fromKey, dbcPath: remap.fromPickedDbc ?? null });
  undoOps.push({ kind: "pick", signal: toKey, dbcPath: null });
  await invoke("set_signal_dbc_pick", { signal: toKey, dbcPath: remap.dbcPath }).catch(() => {});
  await invoke("set_signal_dbc_pick", { signal: fromKey, dbcPath: null }).catch(() => {});

  // One undo step for the whole host half; the element half coalesces
  // with it through the gesture the caller opened (task 129).
  stores.recordEdit?.({ undo: undoOps, redo: redoOps });
}

/// {@link remapSignal} bound to the live element registry and the
/// project's colour overrides — what a repair surface calls.
export function useRemapSignal(): (remap: SignalRemap) => void {
  const registry = useElementRegistry();
  const { signalColors, onSetSignalColor } = useProjectContext();
  const { entries, update } = registry;
  const recordEdit = usePanelEditRecorder();
  const gesture = useUndoGesture();
  return useCallback(
    (remap: SignalRemap) => {
      // One gesture over the whole rewrite (task 129): the element
      // patches' snapshot and the host half's step coalesce into one
      // undo entry. The gesture stays open across the async host tail
      // and closes only when the rewrite has finished.
      gesture.begin();
      void remapSignal(
        {
          elements: entries.map((e) => e.element),
          updateElement: update,
          signalColors,
          setSignalColor: onSetSignalColor,
          recordEdit,
        },
        remap,
      ).finally(() => gesture.end());
    },
    [entries, update, signalColors, onSetSignalColor, recordEdit, gesture],
  );
}
