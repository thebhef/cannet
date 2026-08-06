/// The RBS tree's row identity and shape — the pure half of the panel's
/// gridview wiring (ADR 0044), kept out of the component because it is
/// where the panel's per-render cost lives and because that cost is
/// testable only as *identity*.
///
/// The panel re-renders on a 500 ms value poll: the message payloads and
/// running flags move, the tree's shape does not. So a row's id, its DOM
/// id and its click handler — all pure functions of that shape — are
/// interned rather than rebuilt, and the visible tree reuses the ECU's
/// own message array whenever no filter is narrowing it. On a
/// hundreds-of-rows RBS config, rebuilding those per row per refresh is
/// the panel's largest allocation and it answers the same thing every
/// time.

import type { MutableRefObject, MouseEvent } from "react";

import type { RbsBusView, RbsEcuView, RbsMessageView, RbsView } from "./types";
import type { Gridview } from "./useGridview";
import type { GridviewFilterEntry } from "./gridviewFilter";
import type { GridviewRow } from "./gridviewRows";

/// Stable gridview row ids. The bus and ECU forms are also the keys the
/// panel's `collapsed` set has always used, so the cursor, the expansion
/// and the selection all name one thing.
export function busRowId(busKey: string): string {
  return `b:${busKey}`;
}
export function ecuRowId(busKey: string, ecu: string): string {
  return `e:${busKey}/${ecu}`;
}
export function messageRowId(busKey: string, messageKey: string): string {
  return `m:${busKey}/${messageKey}`;
}

/// The row-id functions above, interned per panel instance. Bounded by
/// the loaded RBS config — one entry per bus, ECU and message in it.
export interface RbsRowIds {
  bus(busKey: string): string;
  ecu(busKey: string, ecu: string): string;
  message(busKey: string, messageKey: string): string;
}

function intern(
  outer: Map<string, Map<string, string>>,
  busKey: string,
  key: string,
  make: (busKey: string, key: string) => string,
): string {
  let inner = outer.get(busKey);
  if (inner === undefined) {
    inner = new Map();
    outer.set(busKey, inner);
  }
  let id = inner.get(key);
  if (id === undefined) {
    id = make(busKey, key);
    inner.set(key, id);
  }
  return id;
}

export function makeRbsRowIds(): RbsRowIds {
  const buses = new Map<string, string>();
  const ecus = new Map<string, Map<string, string>>();
  const messages = new Map<string, Map<string, string>>();
  return {
    bus(busKey) {
      let id = buses.get(busKey);
      if (id === undefined) {
        id = busRowId(busKey);
        buses.set(busKey, id);
      }
      return id;
    },
    ecu: (busKey, ecu) => intern(ecus, busKey, ecu, ecuRowId),
    message: (busKey, messageKey) => intern(messages, busKey, messageKey, messageRowId),
  };
}

/// The props every row in the panel carries so the gridview can see it:
/// the DOM id `aria-activedescendant` names, and the click that moves the
/// cursor. Both depend only on the row's id, so they are built once per
/// row and reused. The cursor class is *not* here — it changes as the
/// cursor moves, so the panel spreads it at the call site.
export interface RowGridProps {
  id: string;
  onClick: (e: MouseEvent) => void;
}

/// `gridRef` rather than a `Gridview`: the hook hands back a fresh object
/// every render, and a cached handler must reach the live one.
export function makeRowGridPropsCache(
  gridRef: MutableRefObject<Gridview>,
): (id: string) => RowGridProps {
  const cache = new Map<string, RowGridProps>();
  return (id) => {
    let props = cache.get(id);
    if (props === undefined) {
      props = {
        id: gridRef.current.rowDomId(id),
        onClick: (e) =>
          gridRef.current.onRowClick(id, { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey }),
      };
      cache.set(id, props);
    }
    return props;
  };
}

/// The tree as it will actually render, with the filter's hiding and the
/// expansion already applied. Built once per render and consumed twice:
/// by the panel's nested renderers, and — flattened — by the gridview's
/// row space, so the two cannot disagree about what is on screen.
export interface VisibleBus {
  bus: RbsBusView;
  expanded: boolean;
  ecus: VisibleEcu[];
}
export interface VisibleEcu {
  ecu: RbsEcuView;
  expanded: boolean;
  messages: readonly RbsMessageView[];
}

/// `keep` is `null` when no filter is narrowing — the common case, and
/// the one worth not paying for: it keeps everything, so the walk asks
/// nothing and hands each ECU its own message array back.
export function buildVisibleTree(
  view: RbsView | null,
  ids: RbsRowIds,
  expanded: (id: string) => boolean,
  keep: ((id: string) => boolean) | null,
): VisibleBus[] {
  if (!view) return [];
  const out: VisibleBus[] = [];
  for (const bus of view.buses) {
    const bId = ids.bus(bus.key);
    if (keep !== null && !keep(bId)) continue;
    const busExpanded = expanded(bId);
    const ecus: VisibleEcu[] = [];
    for (const ecu of bus.ecus) {
      const eId = ids.ecu(bus.key, ecu.name);
      if (keep !== null && !keep(eId)) continue;
      ecus.push({
        ecu,
        expanded: expanded(eId),
        messages:
          keep === null
            ? ecu.messages
            : ecu.messages.filter((m) => keep(ids.message(bus.key, m.key))),
      });
    }
    out.push({ bus, expanded: busExpanded, ecus });
  }
  return out;
}

/// The visible tree as the gridview's ordered row space: buses and ECUs
/// are branches, a message is a **leaf with content** — its signal table
/// grows the row in place and adds no rows (ADR 0044's node model).
///
/// Interned like the ids, and for the same reason: the row space is a
/// function of the tree's shape, so a value refresh must not rebuild one
/// row object per row. When nothing structural moved it hands back the
/// *same array*, which keeps the adapter — and every callback the
/// gridview hook derives from it — stable too.
export function makeRbsRowSpace(): (
  tree: readonly VisibleBus[],
  ids: RbsRowIds,
) => readonly GridviewRow[] {
  const byId = new Map<string, GridviewRow>();
  let last: readonly GridviewRow[] = [];
  const row = (
    id: string,
    kind: GridviewRow["kind"],
    expandable: boolean,
    depth: number,
  ): GridviewRow => {
    const cached = byId.get(id);
    if (cached !== undefined && cached.expandable === expandable) return cached;
    const fresh: GridviewRow = { id, kind, expandable, depth };
    byId.set(id, fresh);
    return fresh;
  };
  return (tree, ids) => {
    const rows: GridviewRow[] = [];
    for (const b of tree) {
      rows.push(row(ids.bus(b.bus.key), "branch", b.ecus.length > 0, 0));
      if (!b.expanded) continue;
      for (const e of b.ecus) {
        rows.push(row(ids.ecu(b.bus.key, e.ecu.name), "branch", e.messages.length > 0, 1));
        if (!e.expanded) continue;
        for (const m of e.messages) {
          rows.push(row(ids.message(b.bus.key, m.key), "leaf", true, 2));
        }
      }
    }
    if (rows.length === last.length && rows.every((r, i) => r === last[i])) return last;
    last = rows;
    return rows;
  };
}

/// One searchable entry per message, for the layer's filter slot: the
/// message and the path to it, so a match reveals its bus and ECU.
export function buildRbsFilterEntries(
  view: RbsView | null,
  ids: RbsRowIds,
): GridviewFilterEntry[] {
  const out: GridviewFilterEntry[] = [];
  for (const bus of view?.buses ?? []) {
    for (const ecu of bus.ecus) {
      for (const m of ecu.messages) {
        out.push({
          id: ids.message(bus.key, m.key),
          ancestors: [ids.bus(bus.key), ids.ecu(bus.key, ecu.name)],
          haystack: [m.name ?? "", m.key, ecu.name, ...m.signals.map((s) => s.name)].join(" "),
        });
      }
    }
  }
  return out;
}
