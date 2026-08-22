import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  DbcCollisionRecord,
  DbcContentRecord,
  DbcMessageContentRecord,
  DbcSignalContentRecord,
  DbcSignalMux,
  FileBackedContentRecord,
  FileBackedSignalRecord,
} from "./types";
import type { SignalSnapshotRecord } from "./types";
import { useProjectContext } from "./projectContext";
import { useDbcGeneration } from "./dbcChanged";
import { useElementRegistry } from "./projectElements";
import { DisclosureToggle } from "./DisclosureToggle";
import { buildColorResolver, type ColorResolver, type ColorTarget } from "./colorMap";
import { SignalValueCell } from "./SignalValueCell";
import { recordSignalKey, signalKey } from "./plotData";
import {
  dedupeSignalRefs,
  setSignalDragData,
  type DraggableSignalRef,
} from "./dragSignals";
import { toggleInSet } from "./toggleSet";
import { diagCount } from "./diag";
import {
  ASSUMED_VIEWPORT_HEIGHT,
  ROW_HEIGHT,
  buildOffsets,
  scrollToShow,
  totalHeight,
  visibleRange,
} from "./dbcPanelViewport";
import { GridviewFilterBox, useGridviewFilter, type GridviewFilterEntry } from "./gridviewFilter";
import { useGridview } from "./useGridview";
import type { GridviewAdapter, GridviewRow as GridviewRowModel } from "./gridviewRows";
import { arrayRowSpace } from "./gridviewRows";
import { usePanelCommands } from "./panelCommands";
import { DBC_PANEL_ID } from "./dockLayout";
import { NameText } from "./NameText";
import { ChipButton } from "./ChipButton";
import { Icon } from "./Icon";

/**
 * The **Database** panel: the one catalog surface over every
 * signal-defining artifact the session holds (ADR 0052). Today that is
 * the loaded DBCs' messages and signals — the spatial / search
 * counterpart to the project panel's DBC inventory (ADR 0012 keeps the
 * inventory role on the project panel; this is the discovery role).
 * Each format is organised per its own canon, so a DBC branch is
 * bus → DBC → ECU → message → signal and a future format lands as its
 * own branch shape rather than being normalised into this one.
 *
 * **Singleton** — same pattern as the project, graph, and
 * system-messages panels. The DBC set lives on the host, so a second
 * instance would have no per-panel differentiation worth carrying.
 * The toolbar button toggles show/focus.
 *
 * The host owns the DBC set; the panel is a pure viewer over
 * [`list_dbc_content`]. The tree is organised
 * bus → DBC → ECU → message → signal (the ECU level mirrors the RBS
 * panel's per-transmitter grouping). Search runs against an
 * [`fzf`](https://github.com/ajitid/fzf-for-js)-backed matcher; while
 * a filter is active only matches, the paths to them, and expanded
 * children of matches render — everything else is removed, so a
 * filtered render is bounded by the match set however large the
 * database is.
 *
 * The row list is **virtualized**: the tree flattens to a row array and
 * only the viewport's slice plus an overscan margin becomes DOM (see
 * `dbcPanelViewport.ts` for the geometry). Layout cost is bounded by
 * the panel's height rather than the database's size — without this a
 * large DBC set puts tens of thousands of boxes in the document and
 * every keystroke pays a full synchronous relayout.
 *
 * Interaction — the cursor, the selection, the key table and the
 * dispatcher suppression — is the shared gridview's (ADR 0044). Bus /
 * DBC / ECU nodes are unselectable branches, message nodes selectable
 * branches, signals plain leaves; search runs through the layer's filter
 * slot. Rows are drag sources for signals (see {@link setSignalDragData}).
 */

interface PanelParams {
  /// Search query the panel was last typing in. Persisted so reopening
  /// the panel from a saved layout restores the same filter.
  filter?: unknown;
  /// Node ids the user has manually expanded (see `nodeId`). Persisted
  /// as an array; loaded back as a Set on mount.
  expanded?: unknown;
  /// Panel-wide "show details" toggle. When `true`,
  /// each message / signal row renders a detail block underneath
  /// showing bit layout, scale, range, mux, attributes, value table,
  /// etc. — every DBC field we have a frontend representation for.
  showDetails?: unknown;
  /// Panel-wide "live values" toggle: whether each signal row carries a
  /// live-latest decoded value column. Persisted like the other
  /// toggles, so reopening from a saved layout restores it.
  showValues?: unknown;
}

function filterFromParams(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

export function expandedFromParams(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const v of raw) {
    // Drop legacy ids that embedded the DBC's on-disk path. Node ids are
    // now keyed by index + filename, which never contains a path
    // separator, so such an id matches no current node — and
    // re-persisting it would write a machine-local absolute path back
    // into the project file on the next save.
    if (typeof v === "string" && !/[/\\]/.test(v)) out.add(v);
  }
  return out;
}

function showDetailsFromParams(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : false;
}

/// Stable, project-local identity for a DBC in the tree: its index in
/// the loaded DBC list plus its filename. The filename is the
/// meaningful handle — rename the file on disk and the project loses
/// the reference anyway — and the index disambiguates two loaded DBCs
/// that happen to share a filename. Deliberately *not* the on-disk
/// path: node ids are persisted into the saved layout's `expanded` set
/// (below), and an absolute path would bake a machine-specific location
/// into the committed project file. The index is stable across a
/// save/load round-trip because the layout and the DBC list live in the
/// same project file and are written together.
export function dbcKey(index: number, path: string): string {
  return `${index}:${basename(path)}`;
}

/// Stable id for one tree node. The bus-prefix in every node id below
/// the bus root scopes the rest — a DBC under bus-a is a distinct
/// expand-state key from the same DBC under bus-b, so the user's
/// expand/collapse choices per bus group survive a layout save. The DBC
/// segment is a `dbcKey`, never a path.
///
/// Bus ids: `bus:<bus_id>` for a project bus, `bus:::unassigned` for
/// the orphan group (DBCs scoped to no current bus), and `bus:::all`
/// for the no-buses-configured fallback. The `:::` separator avoids
/// collision with a literal bus id of "unassigned" or "all".
function busNodeId(busId: string): string {
  return `bus:${busId}`;
}
export function dbcNodeId(busId: string, key: string): string {
  return `dbc:${busId}::${key}`;
}
/// `ecu` is the DBC transmitter name, or the `:::none` sentinel for
/// messages whose `BO_` line carries the `Vector__XXX` placeholder
/// (`:::` can't collide with a real node name).
function ecuNodeId(busId: string, key: string, ecu: string): string {
  return `ecu:${busId}::${key}::${ecu}`;
}
function messageNodeId(
  busId: string,
  key: string,
  messageId: number,
  extended: boolean,
): string {
  return `msg:${busId}::${key}::${extended ? "x" : "s"}${messageId}`;
}
function signalNodeId(
  busId: string,
  key: string,
  messageId: number,
  extended: boolean,
  signalName: string,
): string {
  return `sig:${busId}::${key}::${extended ? "x" : "s"}${messageId}::${signalName}`;
}

/// Stable identity for one source file's file-backed branch, built the
/// same way [`dbcKey`] is and for the same reason: node ids are
/// persisted into the layout's `expanded` set, so they carry the
/// basename (plus the list index, to separate two files that share
/// one) and never the machine-local path.
export function fileKey(index: number, sourcePath: string): string {
  return `${index}:${basename(sourcePath)}`;
}
/// Node ids for the file-backed half of the tree (ADR 0052): source
/// file → signal channel group → signal. Distinct prefixes from the
/// DBC half, so the two never share an expand-state key.
export function fileNodeId(key: string): string {
  return `file:${key}`;
}
export function fileGroupNodeId(key: string, group: number): string {
  return `fgrp:${key}::${group}`;
}
export function fileSignalNodeId(key: string, group: number, signalName: string): string {
  return `fsig:${key}::${group}::${signalName}`;
}

/// Sentinel bus ids. Real project bus ids are UUIDs, so the `:::`
/// prefix can't collide.
const UNASSIGNED_BUS_ID = ":::unassigned";
const ALL_BUSES_BUS_ID = ":::all";

/// Sentinel ECU key + display label for messages with no `BO_`
/// transmitter (`Vector__XXX`). The label matches the RBS panel's
/// fallback so the two per-ECU groupings read the same.
const NO_TRANSMITTER_ECU_KEY = ":::none";
const NO_TRANSMITTER_LABEL = "(no transmitter)";

/// Spacing between live-value refreshes while the value column is on
/// and the panel is on screen. Dirty-gated on `trace-grew`, so a quiet
/// capture costs nothing; this only bounds how often a *growing* one
/// pays the decode-and-join round-trip.
const VALUE_POLL_MS = 500;

/// One per-transmitter group of a DBC's messages — the ECU tree
/// level. `key` feeds the node id (stable across renames of the
/// display label); `transmitter` is `null` for the no-sender group.
interface EcuGroup {
  key: string;
  label: string;
  transmitter: string | null;
  messages: DbcMessageContentRecord[];
}

/// Group a DBC's host-ordered message list per transmitter ECU,
/// mirroring the RBS panel's grouping. ECUs sort alphabetically
/// (case-insensitive); the "(no transmitter)" group, when present,
/// sorts last. Message order within a group stays the host's
/// `(extended, messageId)` order.
function groupByEcu(messages: readonly DbcMessageContentRecord[]): EcuGroup[] {
  const byEcu = new Map<string, EcuGroup>();
  for (const m of messages) {
    const key = m.transmitter ?? NO_TRANSMITTER_ECU_KEY;
    let g = byEcu.get(key);
    if (!g) {
      g = {
        key,
        label: m.transmitter ?? NO_TRANSMITTER_LABEL,
        transmitter: m.transmitter,
        messages: [],
      };
      byEcu.set(key, g);
    }
    g.messages.push(m);
  }
  return [...byEcu.values()].sort((a, b) => {
    if (a.transmitter === null) return b.transmitter === null ? 0 : 1;
    if (b.transmitter === null) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

/// Last path component for display — DBC file paths can get long; the
/// basename is what the user actually recognises. Falls back to the
/// whole path when there's no separator.
function basename(path: string): string {
  const slashed = path.lastIndexOf("/");
  const backed = path.lastIndexOf("\\");
  const cut = Math.max(slashed, backed);
  return cut < 0 ? path : path.slice(cut + 1);
}

/// Concatenated search haystack for one node — every text fragment
/// the phase-12 spec requires we match against, joined with spaces.
/// fzf's matcher then does the fuzzy work over this single string.
///
/// The dotted ancestry is woven in as `${bus}.${ecu}.${msg}.${sig}`
/// — the same hierarchy the tree renders — so queries like
/// `chassis.BrakeStatus.Speed`, `bmsstatus` (ECU + message-name
/// fragment), or fzf's abbreviation form (`c.BrSt.Sp`, `c.brsps`)
/// home in on the right node. The ADR-0020 plot-target shape
/// (`bus.msg.sig`) remains a subsequence of this, so target-shaped
/// queries keep working. Bus-prefix is empty for the sentinel groups
/// ("(All DBCs)", "(Unassigned)") where there's no real bus context;
/// the ECU segment is absent for `Vector__XXX` messages.
function messageHaystack(busPrefix: string, m: DbcMessageContentRecord): string {
  const decId = m.messageId.toString(10);
  const hexId = `0x${m.messageId.toString(16).toUpperCase()}`;
  const attrs = m.attributes
    .map((a) => `${a.name}=${a.value}`)
    .join(" ");
  const dotted = [busPrefix, m.transmitter ?? "", m.name]
    .filter((p) => p !== "")
    .join(".");
  return `${dotted} ${m.comment} ${decId} ${hexId} ${attrs}`.trim();
}
function signalHaystack(
  busPrefix: string,
  m: DbcMessageContentRecord,
  s: DbcSignalContentRecord,
): string {
  const vals = s.valueTable
    .map((e) => `${e.raw} ${e.label}`)
    .join(" ");
  const attrs = s.attributes.map((a) => `${a.name}=${a.value}`).join(" ");
  const dotted = [busPrefix, m.transmitter ?? "", m.name, s.name]
    .filter((p) => p !== "")
    .join(".");
  // Other fields are appended so a query against units / comments /
  // value-table labels / attribute names still hits.
  return `${dotted} ${s.unit} ${s.comment} ${vals} ${attrs}`.trim();
}

/// Bus-name prefix used when building haystacks. Empty for sentinel
/// groups (no real bus context to disambiguate against).
function busSearchPrefix(g: BusGroup): string {
  if (g.busId === ALL_BUSES_BUS_ID || g.busId === UNASSIGNED_BUS_ID) {
    return "";
  }
  return g.label;
}

/// One row the panel renders. Carries `expanded`/`hasChildren` flags
/// so the row renderer is a flat map. The `kind` discriminator picks
/// between the five row layouts; signal / message / dbc rows carry
/// their owning DBC path so the drag handler can resolve per-DBC bus
/// scoping at drag time. While a filter is active, rows outside the
/// match set (and not on a path to / under a match) are not built at
/// all — hiding is structural, not a style.
interface RenderRow {
  id: string;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  kind:
    | { tag: "bus"; busId: string; label: string }
    | {
        tag: "dbc";
        path: string;
        /// Why this row decodes nothing, or `null` under a real bus
        /// group (its position there already says what it's assigned
        /// to). Set only under the `(Unassigned)` / `(All DBCs)`
        /// sentinel groups — the discoverability rule is this row, and
        /// nothing more (no status-line warning, no open-project
        /// prompt).
        note: string | null;
        /// A compact summary of every id this database loses to
        /// another database assigned to the *same* bus, or `null` when
        /// it has none there. `title` is the same information, one
        /// collision per line, for the row's tooltip. Detected
        /// host-side (`list_dbc_collisions`) — naming the winner is
        /// all this warns about; choosing one is a different surface.
        collision: { summary: string; title: string } | null;
      }
    | { tag: "ecu"; label: string }
    | {
        tag: "message";
        /// Bus context — set from the bus group this row was
        /// rendered under. `null` for the `(All DBCs)` /
        /// `(Unassigned)` sentinel groups (no real bus context). A
        /// drag from this row produces a `SignalRef` carrying this
        /// `busId`; that's what makes the per-bus tree's visual
        /// position determine the drag destination.
        busId: string | null;
        dbcPath: string;
        message: DbcMessageContentRecord;
      }
    | {
        tag: "signal";
        busId: string | null;
        dbcPath: string;
        messageId: number;
        extended: boolean;
        messageName: string;
        signal: DbcSignalContentRecord;
      }
    /// A capture file that carried signal definitions (ADR 0052) — the
    /// root of its own branch, beside the bus groups.
    | { tag: "file"; path: string }
    /// One signal channel group inside that file.
    | { tag: "filegroup"; label: string }
    /// One file-backed signal. `group` is its source group's index —
    /// the message-id slot of its provenance-keyed identity — and
    /// `groupLabel` stands where a DBC-backed signal names its message.
    | {
        tag: "filesignal";
        group: number;
        groupLabel: string;
        signal: FileBackedSignalRecord;
      };
}

/// Group [`DbcContentRecord`]s by the bus(es) they are **assigned
/// to**. Each project bus gets its own group; a database appears once
/// per bus it is assigned to — never more, never zero for a bus it
/// isn't assigned to. A database assigned to nothing (never scoped, or
/// scoped only to bus ids no longer in the project) decodes nothing
/// ([`filter::dbc_applies`] on the host) and falls into a single
/// `(Unassigned)` group at the end, each carrying a `note` saying why.
/// When the project has zero buses configured we collapse to a single
/// `(All DBCs)` group instead, so the tree still has one root pattern
/// — such a project can assign nothing either, so every entry there
/// decodes nothing too.
interface BusGroup {
  busId: string;
  label: string;
  dbcs: Array<{ dbc: DbcContentRecord; key: string; note: string | null }>;
}

export function groupByBus(
  content: readonly DbcContentRecord[],
  buses: readonly { id: string; name: string }[],
  dbcBuses: Readonly<Record<string, string[]>>,
): BusGroup[] {
  if (buses.length === 0) {
    // No project buses → nothing can be assigned to anything; collapse
    // to a single "All DBCs" group so the tree still has one root
    // pattern.
    return [
      {
        busId: ALL_BUSES_BUS_ID,
        label: "All DBCs (no buses configured)",
        dbcs: content.map((d, i) => ({
          dbc: d,
          key: dbcKey(i, d.dbcPath),
          note: "no project bus is configured — decodes nothing",
        })),
      },
    ];
  }
  const knownBusIds = new Set(buses.map((b) => b.id));
  const groups: BusGroup[] = buses.map((b) => ({
    busId: b.id,
    label: b.name || b.id,
    dbcs: [],
  }));
  const groupByBusId = new Map(groups.map((g) => [g.busId, g]));
  const unassigned: BusGroup = {
    busId: UNASSIGNED_BUS_ID,
    label: "(Unassigned — decodes nothing)",
    dbcs: [],
  };
  for (const [i, d] of content.entries()) {
    const key = dbcKey(i, d.dbcPath);
    const scope = dbcBuses[d.dbcPath] ?? [];
    if (scope.length === 0) {
      unassigned.dbcs.push({
        dbc: d,
        key,
        note: "not assigned to a bus — decodes nothing",
      });
      continue;
    }
    const liveScope = scope.filter((b) => knownBusIds.has(b));
    if (liveScope.length === 0) {
      unassigned.dbcs.push({
        dbc: d,
        key,
        note: "assigned only to a bus no longer in the project — decodes nothing",
      });
      continue;
    }
    for (const busId of liveScope) {
      const g = groupByBusId.get(busId);
      // A row under a real bus group needs no extra note — its
      // position there is the assignment.
      if (g) g.dbcs.push({ dbc: d, key, note: null });
    }
  }
  if (unassigned.dbcs.length > 0) groups.push(unassigned);
  return groups;
}

/// Walk the bus-grouped content tree, applying `effectiveExpanded`
/// (= user's expand state ∪ ancestors-of-matches when filtering),
/// and produce a flat row list ready to render.
///
/// While a filter is active the walk *removes* everything outside the
/// match structure instead of rendering it dimmed: a container (bus /
/// DBC / ECU) renders only when its subtree holds a match
/// (`ancestorsOfMatches`); a message renders when it matched or a
/// signal under it matched; a signal renders when it matched or its
/// message matched (so expanding a matched message still reveals its
/// children). This bounds a filtered render by the match set, the
/// responsiveness rule a large DBC (thousands of messages) depends on.
///
/// Deliberately **not** a function of the selection: the gridview's
/// selection follows the cursor, so folding it in here would rebuild
/// every row object on every arrow press and defeat [`DbcRow`]'s memo.
/// The highlight is a per-row prop instead.
/// Render text for one DBC row's duplicate-id collisions on the bus it
/// sits under — every `DbcCollisionRecord` the host reported for that
/// (bus, database) pair, i.e. every id this database *loses*.
/// Presentational grouping only (by winner, so "a.dbc wins X, Y" reads
/// once rather than once per signal); the collision itself is detected
/// host-side and handed over already resolved
/// ([`list_dbc_collisions`]). `null` when the database has no
/// collision on this bus.
function formatCollisionNote(
  lostHere: readonly DbcCollisionRecord[],
): { summary: string; title: string } | null {
  if (lostHere.length === 0) return null;
  const byWinner = new Map<string, string[]>();
  for (const c of lostHere) {
    const names = byWinner.get(c.winnerPath) ?? [];
    names.push(c.signalName);
    byWinner.set(c.winnerPath, names);
  }
  const summary = [...byWinner.entries()]
    .map(([winner, names]) => `${basename(winner)} wins ${names.join(", ")}`)
    .join("; ");
  const title = lostHere
    .map(
      (c) =>
        `${c.signalName} (0x${c.messageId.toString(16)}) is also defined in ${basename(c.winnerPath)} — ${basename(c.winnerPath)} wins`,
    )
    .join("\n");
  return { summary: `⚠ duplicate id — ${summary}`, title };
}

function buildRows(
  groups: readonly BusGroup[],
  files: readonly FileBackedContentRecord[],
  effectiveExpanded: ReadonlySet<string>,
  matchSet: ReadonlySet<string>,
  ancestorsOfMatches: ReadonlySet<string>,
  filterActive: boolean,
  collisions: readonly DbcCollisionRecord[],
): RenderRow[] {
  const out: RenderRow[] = [];
  for (const g of groups) {
    const bId = busNodeId(g.busId);
    if (filterActive && !ancestorsOfMatches.has(bId)) continue;
    const bExpanded = effectiveExpanded.has(bId);
    // `dragBusId` is what message / signal rows under this group
    // carry as their `busId` — the destination bus a drag from this
    // visual position should produce. Sentinel groups (no real bus)
    // contribute `null` (legacy "any bus" path).
    const dragBusId =
      g.busId === ALL_BUSES_BUS_ID || g.busId === UNASSIGNED_BUS_ID ? null : g.busId;
    out.push({
      id: bId,
      depth: 0,
      expanded: bExpanded,
      hasChildren: g.dbcs.length > 0,
      kind: {
        tag: "bus",
        busId: g.busId,
        label: g.label,
      },
    });
    if (!bExpanded) continue;
    for (const { dbc, key, note } of g.dbcs) {
      const dId = dbcNodeId(g.busId, key);
      if (filterActive && !ancestorsOfMatches.has(dId)) continue;
      const dExpanded = effectiveExpanded.has(dId);
      const lostHere = collisions.filter(
        (c) => c.busId === g.busId && c.loserPath === dbc.dbcPath,
      );
      out.push({
        id: dId,
        depth: 1,
        expanded: dExpanded,
        hasChildren: dbc.messages.length > 0,
        kind: {
          tag: "dbc",
          path: dbc.dbcPath,
          note,
          collision: formatCollisionNote(lostHere),
        },
      });
      if (!dExpanded) continue;
      for (const ecu of groupByEcu(dbc.messages)) {
        const eId = ecuNodeId(g.busId, key, ecu.key);
        if (filterActive && !ancestorsOfMatches.has(eId)) continue;
        const eExpanded = effectiveExpanded.has(eId);
        out.push({
          id: eId,
          depth: 2,
          expanded: eExpanded,
          hasChildren: ecu.messages.length > 0,
              kind: { tag: "ecu", label: ecu.label },
        });
        if (!eExpanded) continue;
        for (const m of ecu.messages) {
          const mId = messageNodeId(g.busId, key, m.messageId, m.extended);
          const mMatched = matchSet.has(mId);
          if (filterActive && !mMatched && !ancestorsOfMatches.has(mId)) {
            continue;
          }
          const mExpanded = effectiveExpanded.has(mId);
          out.push({
            id: mId,
            depth: 3,
            expanded: mExpanded,
            hasChildren: m.signals.length > 0,
            kind: { tag: "message", busId: dragBusId, dbcPath: dbc.dbcPath, message: m },
          });
          if (!mExpanded) continue;
          for (const s of m.signals) {
            const sId = signalNodeId(
              g.busId,
              key,
              m.messageId,
              m.extended,
              s.name,
            );
            // Under a matched message every signal shows (the user
            // explicitly expanded it); under a merely-expanded
            // message only matched signals do.
            if (filterActive && !mMatched && !matchSet.has(sId)) continue;
            out.push({
              id: sId,
              depth: 4,
              expanded: false,
              hasChildren: false,
              kind: {
                tag: "signal",
                busId: dragBusId,
                dbcPath: dbc.dbcPath,
                messageId: m.messageId,
                extended: m.extended,
                messageName: m.name,
                signal: s,
              },
            });
          }
        }
      }
    }
  }
  // The file-backed branches sit after the bus groups, each organised
  // per the MDF's own canon — file → channel group → signal (ADR
  // 0052) — rather than folded into the DBC hierarchy above.
  for (const [i, file] of files.entries()) {
    const key = fileKey(i, file.sourcePath);
    const fId = fileNodeId(key);
    if (filterActive && !ancestorsOfMatches.has(fId)) continue;
    const fExpanded = effectiveExpanded.has(fId);
    out.push({
      id: fId,
      depth: 0,
      expanded: fExpanded,
      hasChildren: file.groups.length > 0,
      kind: { tag: "file", path: file.sourcePath },
    });
    if (!fExpanded) continue;
    for (const group of file.groups) {
      const gId = fileGroupNodeId(key, group.group);
      if (filterActive && !ancestorsOfMatches.has(gId)) continue;
      const gExpanded = effectiveExpanded.has(gId);
      out.push({
        id: gId,
        depth: 1,
        expanded: gExpanded,
        hasChildren: group.signals.length > 0,
        kind: { tag: "filegroup", label: group.label },
      });
      if (!gExpanded) continue;
      for (const s of group.signals) {
        const sId = fileSignalNodeId(key, group.group, s.name);
        if (filterActive && !matchSet.has(sId)) continue;
        out.push({
          id: sId,
          depth: 2,
          expanded: false,
          hasChildren: false,
          kind: {
            tag: "filesignal",
            group: group.group,
            groupLabel: group.label,
            signal: s,
          },
        });
      }
    }
  }
  return out;
}

/// Indexed lookup of every searchable node — one entry per message
/// and per signal. The flat shape lets the filter slot's matcher rank a
/// single list and the result includes both kinds.
export function buildSearchIndex(groups: readonly BusGroup[]): GridviewFilterEntry[] {
  const out: GridviewFilterEntry[] = [];
  for (const g of groups) {
    const bId = busNodeId(g.busId);
    const prefix = busSearchPrefix(g);
    for (const { dbc, key } of g.dbcs) {
      const dId = dbcNodeId(g.busId, key);
      for (const m of dbc.messages) {
        const eId = ecuNodeId(
          g.busId,
          key,
          m.transmitter ?? NO_TRANSMITTER_ECU_KEY,
        );
        const mId = messageNodeId(g.busId, key, m.messageId, m.extended);
        out.push({
          id: mId,
          ancestors: [bId, dId, eId],
          haystack: messageHaystack(prefix, m),
        });
        for (const s of m.signals) {
          out.push({
            id: signalNodeId(g.busId, key, m.messageId, m.extended, s.name),
            ancestors: [bId, dId, eId, mId],
            haystack: signalHaystack(prefix, m, s),
          });
        }
      }
    }
  }
  return out;
}

/// The file-backed half of the search index: one entry per signal
/// channel group and per signal under it. The haystack is the same
/// dotted-ancestry shape the DBC half uses — `file.group.signal` — so
/// one query ranks both formats' nodes in a single list and a match
/// under either lands with its path expanded.
export function buildFileSearchIndex(
  files: readonly FileBackedContentRecord[],
): GridviewFilterEntry[] {
  const out: GridviewFilterEntry[] = [];
  for (const [i, file] of files.entries()) {
    const key = fileKey(i, file.sourcePath);
    const fId = fileNodeId(key);
    const name = basename(file.sourcePath);
    for (const group of file.groups) {
      const gId = fileGroupNodeId(key, group.group);
      out.push({
        id: gId,
        ancestors: [fId],
        haystack: `${name}.${group.label}`,
      });
      for (const s of group.signals) {
        out.push({
          id: fileSignalNodeId(key, group.group, s.name),
          ancestors: [fId, gId],
          haystack: `${name}.${group.label}.${s.name} ${s.unit}`.trim(),
        });
      }
    }
  }
  return out;
}

/// Auto-expand every bus group, its DBC children, and their ECU
/// groups when the panel first loads content, so the user sees the
/// messages without an extra click (messages themselves stay
/// collapsed — the rendered row count is bounded by the message
/// count, not the signal count). Used once on mount /
/// content-arrival; subsequent toggle clicks override.
///
/// The file-backed branches follow the same rule one level shallower:
/// a source file opens to show its channel groups, and the groups —
/// the last container above the signals — stay closed.
function initialExpandedRoots(
  groups: readonly BusGroup[],
  files: readonly FileBackedContentRecord[],
): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    out.add(busNodeId(g.busId));
    for (const { dbc, key } of g.dbcs) {
      out.add(dbcNodeId(g.busId, key));
      for (const ecu of groupByEcu(dbc.messages)) {
        out.add(ecuNodeId(g.busId, key, ecu.key));
      }
    }
  }
  for (const [i, file] of files.entries()) {
    out.add(fileNodeId(fileKey(i, file.sourcePath)));
  }
  return out;
}

/// Resolve a render row to the draggable signals it contributes.
/// For message rows that's every signal in the message; for signal
/// rows it's just the one. Returns an empty list for bus / DBC rows
/// (those aren't draggable).
///
/// **Bus context comes from the row's visual position**, not a second
/// lookup into `dbcBuses`. A database assigned to two buses is
/// rendered once per bus it's assigned to; a drag from the bus-a copy
/// of `EngineSpeed` produces a ref with `busId: "bus-a"` even though
/// the same DBC also appears under bus-b. This matches what the user
/// expects from the visual layout — they explicitly chose to drag from
/// bus-a's view.
///
/// Sentinel groups ("(All DBCs)", "(Unassigned)") carry `busId:
/// null` on their rows — a database rendered there decodes nothing on
/// any bus, so there is no destination to carry.
function rowToSignalRefs(
  row: RenderRow,
  content: readonly DbcContentRecord[],
): DraggableSignalRef[] {
  if (
    row.kind.tag === "bus" ||
    row.kind.tag === "dbc" ||
    row.kind.tag === "ecu" ||
    row.kind.tag === "file" ||
    row.kind.tag === "filegroup"
  ) {
    return [];
  }
  if (row.kind.tag === "filesignal") {
    // A file-backed signal's provenance-keyed reference (ADR 0052): no
    // bus and no message carry it, so its source group's index rides in
    // the message slot and `fileBacked` keeps that number out of the
    // message-id namespace. Every drop target already reads this shape,
    // so nothing downstream has to know which branch the drag left.
    const { group, groupLabel, signal } = row.kind;
    return [
      {
        busId: null,
        messageId: group,
        extended: false,
        signalName: signal.name,
        messageName: groupLabel,
        unit: signal.unit,
        fileBacked: true,
      },
    ];
  }
  const busId = row.kind.busId;
  if (row.kind.tag === "signal") {
    const s = row.kind.signal;
    return [
      {
        busId,
        messageId: row.kind.messageId,
        extended: row.kind.extended,
        signalName: s.name,
        messageName: row.kind.messageName,
        unit: s.unit,
      },
    ];
  }
  // Message row → contribute every signal that belongs to it. Find
  // the message in `content` so the source-order signal list is
  // what the panel rendered.
  const messageKind = row.kind; // narrows to the message arm.
  const dbc = content.find((d) => d.dbcPath === messageKind.dbcPath);
  const msg = dbc?.messages.find(
    (m) =>
      m.messageId === messageKind.message.messageId &&
      m.extended === messageKind.message.extended,
  );
  if (!msg) return [];
  return msg.signals.map((s) => ({
    busId,
    messageId: msg.messageId,
    extended: msg.extended,
    signalName: s.name,
    messageName: msg.name,
    unit: s.unit,
  }));
}

/// Bus / DBC / ECU / source-file / channel-group nodes structure the
/// tree and nothing else; message and signal nodes (of either format)
/// are the things a user picks and drags. The gridview asks per row
/// rather than per kind for exactly this shape — a message is a
/// *selectable branch* (ADR 0044).
function isSelectableRow(row: RenderRow): boolean {
  return isSignalRow(row) || row.kind.tag === "message";
}

/// A row that stands for one signal, of either provenance — a leaf in
/// the gridview's row space and a drag source.
function isSignalRow(row: RenderRow): boolean {
  return row.kind.tag === "signal" || row.kind.tag === "filesignal";
}

/// The canonical identity a row's live value is looked up under, or
/// `null` for a row that has no value (a bus / DBC / ECU / file /
/// group container).
///
/// One rule for both provenances (ADR 0052), so the key the panel asks
/// the host for and the key it renders under cannot drift — and a
/// file-backed signal whose source group index equals some message's id
/// still keys distinctly, because the provenance is part of the key.
function valueColumnKey(kind: RenderRow["kind"]): string | null {
  if (kind.tag === "signal")
    return signalKey(kind.busId, kind.messageId, kind.extended, kind.signal.name);
  if (kind.tag === "filesignal")
    return signalKey(null, kind.group, false, kind.signal.name, true);
  return null;
}

/// The colormap identity (ADR 0029) of the row's value cell, or `null`
/// for a row that has no value. The same shape the signal view's value
/// column uses for the same row, so the two surfaces tint alike: a
/// file-backed signal has no bus and carries its source group index in
/// the message slot.
function valueColorTarget(kind: RenderRow["kind"]): ColorTarget | null {
  if (kind.tag === "signal")
    return {
      messageId: kind.messageId,
      extended: kind.extended,
      signalName: kind.signal.name,
      busId: kind.busId,
    };
  if (kind.tag === "filesignal")
    return {
      messageId: kind.group,
      extended: false,
      signalName: kind.signal.name,
      busId: null,
    };
  return null;
}

/// The tree's rows as the gridview's row space: everything above a
/// signal is a branch (expandable when it has children), a signal is a
/// plain leaf. "Details" is taller cell content, not a disclosed content
/// block, so no row here is a leaf-with-content.
function gridviewRowsOf(rows: readonly RenderRow[]): GridviewRowModel[] {
  return rows.map((r) => ({
    id: r.id,
    kind: isSignalRow(r) ? "leaf" : "branch",
    expandable: r.hasChildren,
    depth: r.depth,
  }));
}

export function DatabasePanel(props: IDockviewPanelProps) {
  const { api } = props;
  const params = props.params as PanelParams | undefined;
  const { dbcPaths, dbcBuses, buses } = useProjectContext();

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandedFromParams(params?.expanded),
  );
  const [showDetails, setShowDetails] = useState<boolean>(() =>
    showDetailsFromParams(params?.showDetails),
  );
  /// Live value column: when on, every rendered signal row
  /// shows its live-latest decoded value via the shared value renderer
  /// (`SignalValueCell`) — the same `fetch_signal_page` rows the signal
  /// view reads, so the two surfaces cannot drift. Live-only: the DBC
  /// panel is a singleton navigator with no trace-window state
  /// (pausing belongs to signal-view elements).
  const [showValues, setShowValues] = useState<boolean>(
    () => params?.showValues === true,
  );
  const [content, setContent] = useState<DbcContentRecord[]>([]);
  /// The capture's file-backed signals, per source file (ADR 0052).
  /// Capture-scoped, not project-scoped: it arrives with an import that
  /// carried signal definitions and empties when the capture does, so
  /// it is refetched off the capture's own change signals below rather
  /// than off the project's DBC set.
  const [fileContent, setFileContent] = useState<FileBackedContentRecord[]>([]);
  /// Whether the panel is on screen — false while it sits in a
  /// background tab of its dockview group. The value poll below is a
  /// standing host round-trip that decodes and joins one row per
  /// visible signal; a hidden panel has no rows anyone can read, so it
  /// stops polling entirely rather than paying that every
  /// `VALUE_POLL_MS`.
  const [panelVisible, setPanelVisible] = useState<boolean>(api.isVisible);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setPanelVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);
  /// Bus-grouped view of the loaded DBC content. Reshapes the host's
  /// flat list into one entry per bus (+ optional Unassigned /
  /// All-DBCs fallback groups). Memoised so a re-render that doesn't
  /// touch `content` / `buses` / `dbcBuses` doesn't rebuild it.
  const busGroups = useMemo(
    () => groupByBus(content, buses, dbcBuses),
    [content, buses, dbcBuses],
  );

  // --- the filter slot (ADR 0044) ---
  // The tree holds its whole row space client-side, so it opts into the
  // layer's fzf: query → matching messages / signals plus the path to
  // each, with those ancestors treated as expanded so a deep match is
  // visible without the user unfolding to it.
  const buildFilterEntries = useCallback(
    () => [...buildSearchIndex(busGroups), ...buildFileSearchIndex(fileContent)],
    [busGroups, fileContent],
  );
  const filter = useGridviewFilter(buildFilterEntries, filterFromParams(params?.filter));
  /// The search box, so `panel.find` (Mod+F, ADR 0018) can focus and
  /// select it. Registered under the panel's fixed dockview id — the
  /// Database panel is a singleton with no element id of its own
  /// (`runFocusedPanelCommand` in `useCommands.tsx` falls back to it).
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  usePanelCommands(DBC_PANEL_ID, {
    "panel.find": () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  });
  const mergeExpanded = filter.effectiveExpanded;
  const effectiveExpanded = useMemo(
    () => mergeExpanded(expanded),
    [mergeExpanded, expanded],
  );

  /// Whether the expand state is the *user's* — restored from a saved
  /// layout, or their own clicks. Until it is, each format's content
  /// opens its own roots as it arrives.
  const userExpandedRef = useRef(expanded.size > 0);
  /// Fold one format's auto-expand roots in. A union rather than a
  /// replacement, and gated on the flag above rather than on "nothing
  /// is expanded yet": the two catalogs answer independently, and
  /// whichever lands first must not leave the other's branches shut.
  const seedExpanded = useCallback((seed: ReadonlySet<string>) => {
    if (seed.size === 0) return;
    setExpanded((prev) => {
      if (userExpandedRef.current) return prev;
      const next = new Set(prev);
      for (const id of seed) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  /// Pull a fresh `list_dbc_content` snapshot and slot it in. Used
  /// both for the dependency-driven refresh (project's DBC set
  /// changed) and the event-driven refresh (host's filesystem
  /// watcher saw the file change on disk).
  const refreshContent = useCallback(() => {
    let cancelled = false;
    void invoke<DbcContentRecord[]>("list_dbc_content").then((next) => {
      if (cancelled) return;
      setContent(next);
      // Auto-expand each bus group the first time content arrives
      // if the user has no expand-state of their own. Compute the
      // groups locally — the memoised `busGroups` reflects state
      // from a previous render.
      seedExpanded(initialExpandedRoots(groupByBus(next, buses, dbcBuses), []));
    });
    return () => {
      cancelled = true;
    };
  }, [buses, dbcBuses, seedExpanded]);

  /// Duplicate-id collisions the host detected across the loaded set:
  /// two databases assigned to the same bus defining the same id,
  /// naming which one wins. Fetched off the same triggers as `content`
  /// — detection is host-side, over the same set — and re-fetched here
  /// rather than carried by `list_dbc_content`'s response so the
  /// tree's per-bus shape and the collision facts stay two
  /// independently testable calls. `Array.isArray` guards a
  /// malformed / missing answer down to "no collisions" rather than
  /// letting `buildRows` fail on it.
  const [collisions, setCollisions] = useState<DbcCollisionRecord[]>([]);
  const refreshCollisions = useCallback(() => {
    let cancelled = false;
    void invoke<DbcCollisionRecord[]>("list_dbc_collisions")
      .then((next) => {
        if (!cancelled) setCollisions(Array.isArray(next) ? next : []);
      })
      .catch(() => {
        /* best effort — the tree renders without collision warnings */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /// Pull a fresh `list_file_backed_content` snapshot — the capture's
  /// file-backed branches. Runs on mount and on each of the capture's
  /// change signals below; an empty answer is how the branches vanish
  /// with the capture that carried them.
  const refreshFileContent = useCallback(() => {
    let cancelled = false;
    void invoke<FileBackedContentRecord[]>("list_file_backed_content")
      .then((next) => {
        if (cancelled) return;
        setFileContent(next);
        seedExpanded(initialExpandedRoots([], next));
      })
      .catch(() => {
        /* best effort — the DBC branches render regardless */
      });
    return () => {
      cancelled = true;
    };
  }, [seedExpanded]);

  // The capture's own change signals. `file-signals-changed` is the
  // host saying the file-backed set moved (an import filled it, a
  // cleared or restored capture replaced it); `log-finished` covers an
  // import of a format that carries none, which empties the set by
  // starting a new capture.
  useEffect(() => refreshFileContent(), [refreshFileContent]);
  useEffect(() => {
    const unlisten = Promise.all([
      listen("file-signals-changed", () => refreshFileContent()),
      listen("log-finished", () => refreshFileContent()),
    ]);
    return () => {
      void unlisten.then((fns) => {
        for (const fn of fns) fn();
      });
    };
  }, [refreshFileContent]);

  // Re-fetch on mount and whenever the loaded-DBC set changes. The
  // project context's `dbcPaths` mirrors the host's set so it's the
  // right dependency for add/remove/reload-via-UI; the host's
  // DBC-change carrier covers what the frontend did not do — a file
  // edited on disk, a capture's embedded databases — and the panel
  // reads it through the shared subscription rather than listening for
  // `dbc-changed` itself (ADR 0053 §3).
  const dbcGeneration = useDbcGeneration();
  useEffect(() => refreshContent(), [dbcPaths, dbcGeneration, refreshContent]);
  useEffect(() => refreshCollisions(), [dbcPaths, dbcGeneration, refreshCollisions]);

  // Persist filter + expanded + showDetails into the dockview panel
  // params so the saved layout round-trips them. Selection
  // deliberately doesn't ride along — it's transient state, like an
  // editor's text caret.
  useEffect(() => {
    api.updateParameters({
      filter: filter.input,
      expanded: Array.from(expanded),
      showDetails,
      showValues,
    });
  }, [api, filter.input, expanded, showDetails, showValues]);

  const rows = useMemo(
    () =>
      buildRows(
        busGroups,
        fileContent,
        effectiveExpanded,
        filter.matchSet,
        filter.ancestorsOfMatches,
        filter.active,
        collisions,
      ),
    [
      busGroups,
      fileContent,
      effectiveExpanded,
      filter.matchSet,
      filter.ancestorsOfMatches,
      filter.active,
      collisions,
    ],
  );

  // --- row-list virtualization ---
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A zero measurement means the container hasn't been laid out yet (or
  // the panel is collapsed) — assume a screenful rather than rendering
  // a single row into the first paint.
  const windowHeight = viewportHeight > 0 ? viewportHeight : ASSUMED_VIEWPORT_HEIGHT;
  const offsets = useMemo(
    () => buildOffsets(rows.length, (i) => detailLinesFor(rows[i], showDetails)),
    [rows, showDetails],
  );
  const { first, last } = visibleRange(offsets, scrollTop, windowHeight);
  const visibleRows = useMemo(() => rows.slice(first, last), [rows, first, last]);
  const onTreeScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // --- live value column ---
  const registry = useElementRegistry();
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );
  /// The on-screen signal rows' descriptor keys — the windowed slice,
  /// not the whole tree, so the host's per-call snapshot work is bounded
  /// by the viewport like every other view over the model.
  ///
  /// Both provenances (ADR 0052). A file-backed row is keyed the way it
  /// is everywhere else — no bus, its source group index in the message
  /// slot, `fileBacked` keeping that number out of the message-id
  /// namespace — which is exactly the manual key the host's file-backed
  /// selection matches on.
  const visibleSignalKeys = useMemo(() => {
    if (!showValues) return [];
    return visibleRows.flatMap((r) => {
      if (r.kind.tag === "signal") {
        const k = r.kind;
        return [
          {
            busId: k.busId,
            messageId: k.messageId,
            extended: k.extended,
            signalName: k.signal.name,
          },
        ];
      }
      if (r.kind.tag === "filesignal") {
        const k = r.kind;
        return [
          {
            busId: null,
            messageId: k.group,
            extended: false,
            signalName: k.signal.name,
            fileBacked: true,
          },
        ];
      }
      return [];
    });
  }, [visibleRows, showValues]);
  /// Latest keys for the poll below to read. Held in a ref so scrolling
  /// (which changes the key set on every wheel notch) re-aims the next
  /// tick instead of tearing down and restarting the interval — and
  /// firing an IPC round-trip — per scroll event.
  const visibleSignalKeysRef = useRef(visibleSignalKeys);
  visibleSignalKeysRef.current = visibleSignalKeys;
  const [valuesByKey, setValuesByKey] = useState<ReadonlyMap<string, SignalSnapshotRecord>>(
    new Map(),
  );
  /// Dirty gate under the poll below. Only two things can change a
  /// rendered value: a frame arriving (`trace-grew`, which stops firing
  /// when the capture does) and the viewport moving over rows whose
  /// value hasn't been fetched yet. Without it the panel re-snapshotted
  /// the whole id space twice a second forever — with no capture running
  /// at all.
  const valuesDirtyRef = useRef(true);
  useEffect(() => {
    valuesDirtyRef.current = true;
  }, [visibleSignalKeys]);
  useEffect(() => {
    if (!showValues || !panelVisible) {
      setValuesByKey(new Map());
      return;
    }
    let live = true;
    const fetchValues = () => {
      const keys = visibleSignalKeysRef.current;
      if (keys.length === 0) return;
      void invoke<{ rows: SignalSnapshotRecord[] }>("fetch_signal_page", {
        selection: { keys, patterns: [] },
        // No sections: this is a keyed value lookup, not a view.
        sections: null,
        // Live-latest only: scan to the buffer tip (host clamps).
        scanStart: 0,
        scanEnd: Number.MAX_SAFE_INTEGER,
        sortKey: null,
        sortDir: null,
        busNames: buses.map((b) => [b.id, b.name]),
        sourceBuses: null,
        offset: 0,
        limit: keys.length,
      })
        .then((page) => {
          if (!live) return;
          // `recordSignalKey` reads the row's own provenance, so a
          // file-backed row cannot collide with a DBC-backed signal
          // whose message id happens to equal its group index.
          setValuesByKey(new Map(page.rows.map((r) => [recordSignalKey(r), r])));
        })
        .catch(() => {
          /* best effort — the tree renders without values */
        });
    };
    const unlisten = listen("trace-grew", () => {
      valuesDirtyRef.current = true;
    });
    const tick = () => {
      if (!valuesDirtyRef.current) return;
      valuesDirtyRef.current = false;
      fetchValues();
    };
    // Turning the column on (or coming back into view) shows something
    // at once rather than after a tick.
    valuesDirtyRef.current = true;
    tick();
    const id = window.setInterval(tick, VALUE_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
      void unlisten.then((fn) => fn());
    };
    // Deliberately not keyed on `visibleSignalKeys`: scrolling re-aims the
    // next tick through the ref above, rather than tearing the interval
    // (and the listener) down and firing a round-trip per wheel notch.
  }, [showValues, panelVisible, buses]);

  // --- the gridview (ADR 0044) ---
  // The flattened tree *is* the row space. Everything the panel used to
  // hand-roll here — the roving cursor, the selection set and its anchor,
  // the arrow-key table — is the layer's now; the panel keeps only the
  // three things only it can do: scroll its own viewport, change its own
  // expansion, and say which rows may be selected.
  const gridRows = useMemo(() => gridviewRowsOf(rows), [rows]);
  const selectableIds = useMemo(
    () => new Set(rows.filter(isSelectableRow).map((r) => r.id)),
    [rows],
  );
  /// The virtualizer's live geometry, read by `scrollToRow` without
  /// making the adapter a fresh object on every scroll.
  const geometry = useRef({ offsets, windowHeight });
  geometry.current = { offsets, windowHeight };
  const scrollToRow = useCallback((index: number) => {
    const el = treeRef.current;
    if (!el) return;
    const g = geometry.current;
    // The element's own `scrollTop` is authoritative — the state lags a
    // frame behind a wheel gesture.
    const next = scrollToShow(g.offsets, index, el.scrollTop, g.windowHeight);
    if (next === el.scrollTop) return;
    el.scrollTop = next;
    setScrollTop(next);
  }, []);
  const setRowExpanded = useCallback((id: string, want: boolean) => {
    // From here on the expand state is the user's, so arriving content
    // stops opening its own roots under them.
    userExpandedRef.current = true;
    setExpanded((prev) => {
      if (prev.has(id) === want) return prev;
      return toggleInSet(prev, id);
    });
  }, []);
  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, (id) => effectiveExpanded.has(id));
    return {
      ...space,
      scrollToRow,
      setExpanded: setRowExpanded,
      isSelectable: (row) => selectableIds.has(row.id),
    };
  }, [gridRows, selectableIds, effectiveExpanded, scrollToRow, setRowExpanded]);
  const grid = useGridview({
    adapter,
    pageRows: Math.max(1, Math.floor(windowHeight / ROW_HEIGHT)),
    // Keeps the row DOM ids `aria-activedescendant` names exactly what
    // they were before the migration.
    idPrefix: "dbcnode",
  });
  /// The rows are memoised and the hook hands back fresh callbacks every
  /// render (its adapter moves with the tree), so the row-facing handlers
  /// read the live gridview — and the live tree — through refs. Otherwise
  /// every rendered row repaints on every cursor move.
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const dragContext = useRef({ rows, content });
  dragContext.current = { rows, content };
  const handleRowClick = useCallback(
    (id: string, modifiers: { shift: boolean; mod: boolean }, target: HTMLElement | null) => {
      gridRef.current.onRowClick(id, modifiers);
      // Clicking a row hands the grid the keyboard — the container is
      // the only thing in a gridview that holds focus (ADR 0044) —
      // unless the click was aimed at a control that wants it itself.
      if (target?.closest("button, input") == null) treeRef.current?.focus();
    },
    [],
  );

  /// What one grab carries: the grabbed row's signals, or — when that
  /// row is in the selection — every selected row's (matching the
  /// file-manager / IDE convention; the panel's visible selection is
  /// unchanged so the user can keep it). Resolved at drag time through
  /// the refs above, so a cursor move costs no row repaints.
  const handleDragStart = useCallback((e: React.DragEvent, row: RenderRow) => {
    const { rows: liveRows, content: liveContent } = dragContext.current;
    const selection = gridRef.current.selection;
    const draggedRows = selection.has(row.id)
      ? liveRows.filter((r) => selection.has(r.id))
      : [row];
    const refs = dedupeSignalRefs(
      draggedRows.flatMap((r) => rowToSignalRefs(r, liveContent)),
    );
    if (refs.length === 0) return;
    setSignalDragData(e, refs);
  }, []);

  return (
    <div className="dbc-panel">
      <div className="dbc-panel-toolbar">
        <span className="chip-field dbc-panel-search" title="search messages, signals, comments, attributes…">
          <Icon name="search" />
          <GridviewFilterBox
            filter={filter}
            placeholder="search messages, signals, comments, attributes…"
            ariaLabel="search database content"
            matchCountClassName="dbc-panel-match-count"
            inputRef={searchInputRef}
          />
        </span>
        <ChipButton
          label="Details"
          title="show bit layout, scale, range, attributes, value table for every signal"
          pressed={showDetails}
          onPress={() => setShowDetails((v) => !v)}
        />
        <ChipButton
          label="Values"
          title="show each signal's live decoded value (latest frame; mux-aware)"
          pressed={showValues}
          onPress={() => setShowValues((v) => !v)}
        />
      </div>
      {/* The tree is the gridview container: it holds focus and names
          the active row, and its marker keeps the global dispatcher off
          the keys the grid consumes (ADR 0044). */}
      <div
        ref={treeRef}
        className="dbc-panel-tree"
        role="tree"
        {...grid.containerProps}
        onScroll={onTreeScroll}
      >
        {content.length === 0 && fileContent.length === 0 && (
          <div className="dbc-panel-empty">
            Nothing to browse yet. Add a database from the toolbar's{" "}
            <em>Add DBC…</em>, or import a trace whose file carries signal
            definitions.
          </div>
        )}
        {/* Spacer at the full list height carries the scrollbar; the
            inner element is translated so the rendered slice lands where
            its rows belong. Both are presentational — the `tree` role's
            children are the `treeitem` rows inside. */}
        <div role="presentation" style={{ height: totalHeight(offsets) }}>
          <div
            role="presentation"
            style={{ transform: `translateY(${offsets[first]}px)` }}
          >
            {visibleRows.map((row) => {
              const vk = showValues ? valueColumnKey(row.kind) : null;
              return (
                <DbcRow
                  key={row.id}
                  row={row}
                  active={row.id === grid.cursor}
                  selected={grid.selection.has(row.id)}
                  rowDomId={grid.rowDomId}
                  showDetails={showDetails}
                  value={vk ? valuesByKey.get(vk) ?? null : undefined}
                  resolveColor={resolveColor}
                  onToggle={setRowExpanded}
                  onClick={handleRowClick}
                  onDragStart={handleDragStart}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/// How many `dt`/`dd` lines the row's details block renders. The
/// virtualizer needs a row's height before the row is in the DOM, and
/// the details block is the only part of a row whose height varies.
/// `0` means no details block at all: the panel-wide toggle is off, or
/// the row is a bus / DBC / ECU container.
///
/// The per-kind counts live next to the components that render them
/// ([`MessageDetails`] / [`SignalDetails`]) so a field added to one is
/// added to the other.
function detailLinesFor(row: RenderRow, showDetails: boolean): number {
  if (!showDetails) return 0;
  if (row.kind.tag === "message") return messageDetailLines(row.kind.message);
  if (row.kind.tag === "signal") return signalDetailLines(row.kind.signal);
  return 0;
}

interface DbcRowProps {
  row: RenderRow;
  /// The gridview's cursor is on this row.
  active: boolean;
  /// This row is in the gridview's selection. A prop rather than a field
  /// on `row`, so the selection following the cursor doesn't rebuild
  /// every row object and defeat the memo below.
  selected: boolean;
  /// The layer's row-id → DOM-id mapping, for `aria-activedescendant`.
  rowDomId: (id: string) => string;
  showDetails: boolean;
  /// The signal row's live snapshot when the value column is on:
  /// a record (render its value), `null` (no update yet — blank), or
  /// `undefined` (column off / not a signal row).
  value?: SignalSnapshotRecord | null;
  resolveColor: ColorResolver | null;
  onToggle: (id: string, expanded: boolean) => void;
  onClick: (
    id: string,
    modifiers: { shift: boolean; mod: boolean },
    target: HTMLElement | null,
  ) => void;
  onDragStart: (e: React.DragEvent, row: RenderRow) => void;
}

/// One tree row. **Memoised**: most panel state changes (the keyboard
/// cursor moving, a value tick, a scroll that shifts the window by a
/// row) leave the great majority of the rendered rows' props identical,
/// and re-executing them all is what turns a cheap interaction into a
/// full-window relayout. The props are referentially stable by
/// construction — `row` objects come from the memoised `rows` array and
/// every callback is a `useCallback` — so the shallow comparison is
/// meaningful.
const DbcRow = memo(function DbcRow({
  row,
  active,
  selected,
  rowDomId,
  showDetails,
  value,
  resolveColor,
  onToggle,
  onClick,
  onDragStart,
}: DbcRowProps) {
  diagCount("dbcpanel.rowRender"); // DIAG
  const indent = `${row.depth * 14}px`;
  // Container rows (bus / DBC / ECU, source file / channel group):
  // clicking anywhere toggles expand (they aren't selectable). Message
  // / signal rows: row body selects, chevron toggles expand separately.
  // A draggable row carries the drag-source handlers.
  const isContainerRow =
    row.kind.tag === "bus" ||
    row.kind.tag === "dbc" ||
    row.kind.tag === "ecu" ||
    row.kind.tag === "file" ||
    row.kind.tag === "filegroup";
  const selectable = !isContainerRow;
  const draggable = !isContainerRow;
  const baseClass = [
    "dbc-row",
    `dbc-row-${row.kind.tag}`,
    selected ? "dbc-row-selected" : "",
    active ? "dbc-row-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const onRowClick = (e: React.MouseEvent) => {
    // Every click moves the gridview's cursor here; on a container row
    // that is all it does (they aren't selectable) and the row doubles
    // as its own disclosure.
    onClick(
      row.id,
      { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey },
      e.target as HTMLElement | null,
    );
    if (isContainerRow && row.hasChildren) onToggle(row.id, !row.expanded);
  };
  const onChevronClick = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onToggle(row.id, !row.expanded);
  };
  // The details block sits below the row at the same indent + 14 px
  // (so it's visually associated with the row's content column).
  const detailIndent = `${row.depth * 14 + 14}px`;
  return (
    <>
      <div
        id={rowDomId(row.id)}
        className={baseClass}
        role="treeitem"
        aria-selected={selectable ? selected : undefined}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-level={row.depth + 1}
        data-active={active || undefined}
        style={{ paddingLeft: indent }}
        onClick={onRowClick}
        draggable={draggable}
        onDragStart={draggable ? (e) => onDragStart(e, row) : undefined}
      >
        {/* ADR 0044: a disclosure is a real control whose hit area is
            the full row height and comfortably wide — the caret glyph
            inside it is decoration. A row with nothing to disclose keeps
            the same slot so the indents line up. */}
        {row.hasChildren ? (
          <DisclosureToggle
            className="dbc-row-chevron"
            compact
            tabIndex={-1}
            expanded={row.expanded}
            ariaLabel={`toggle ${row.id}`}
            onToggle={onChevronClick}
          />
        ) : (
          <span className="dbc-row-chevron" aria-hidden="true" />
        )}
        <DbcRowContent kind={row.kind} />
        {value !== undefined && valueColorTarget(row.kind) && (
          <span className="dbc-row-value">
            <SignalValueCell
              value={value?.value}
              unit={value?.unit ?? ""}
              label={value?.label}
              displayHex={value?.display_hex}
              target={valueColorTarget(row.kind)!}
              resolveColor={resolveColor}
            />
          </span>
        )}
      </div>
      {showDetails && row.kind.tag === "message" && (
        <MessageDetails message={row.kind.message} indent={detailIndent} />
      )}
      {showDetails && row.kind.tag === "signal" && (
        <SignalDetails signal={row.kind.signal} indent={detailIndent} />
      )}
    </>
  );
});

/// Compact human-readable summary of a signal's bit-layout. Mirrors
/// what a DBC editor would show on the signal line: start bit + size,
/// byte order, signedness, float kind.
function formatBitLayout(s: DbcSignalContentRecord): string {
  const order = s.byteOrder === "little" ? "@1" : "@0";
  const sign = s.signed ? "-" : "+";
  const endBit = s.startBit + s.length - 1;
  const float = s.floatKind === "integer" ? "" : ` · ${s.floatKind}`;
  return `bits ${s.startBit}–${endBit} (${s.length})${order}${sign}${float}`;
}

/// `physical = raw * factor + offset`, formatted for display. We
/// preserve the DBC's literal `(factor,offset)` shape so the text is
/// recognisable to anyone reading the DBC source.
function formatScale(s: DbcSignalContentRecord): string {
  return `(${s.factor}, ${s.offset})`;
}

/// `[min, max]` physical range. DBCs frequently declare `[0|0]` to
/// mean "no constraint" — surface that explicitly rather than
/// printing the literal `[0, 0]` which would mislead a reader.
function formatRange(s: DbcSignalContentRecord): string {
  if (s.min === s.max) return "[no range]";
  return `[${s.min}, ${s.max}]${s.unit ? ` ${s.unit}` : ""}`;
}

/// Mux indicator as a short label — `mux`, `m<N>`, `m<N>M`, or empty
/// for plain signals.
function formatMux(mux: DbcSignalMux): string {
  switch (mux.kind) {
    case "plain":
      return "";
    case "multiplexor":
      return "mux switch (M)";
    case "multiplexed":
      return `mux arm m${mux.selector}`;
    case "multiplexor_and_multiplexed":
      return `extended mux m${mux.selector}M`;
  }
}

interface SignalDetailsProps {
  signal: DbcSignalContentRecord;
  indent: string;
}

/// Lines [`SignalDetails`] renders, for [`detailLinesFor`]. Layout /
/// scale / range are unconditional; mux, attributes, and the value
/// table each add one when present.
function signalDetailLines(s: DbcSignalContentRecord): number {
  return (
    3 +
    (formatMux(s.mux) === "" ? 0 : 1) +
    (s.attributes.length > 0 ? 1 : 0) +
    (s.valueTable.length > 0 ? 1 : 0)
  );
}

function SignalDetails({ signal, indent }: SignalDetailsProps) {
  const mux = formatMux(signal.mux);
  return (
    <div className="dbc-row-details" style={{ paddingLeft: indent }}>
      <dl className="dbc-details-grid">
        <dt>layout</dt>
        <dd>{formatBitLayout(signal)}</dd>
        <dt>scale</dt>
        <dd>{formatScale(signal)}</dd>
        <dt>range</dt>
        <dd>{formatRange(signal)}</dd>
        {mux && (
          <>
            <dt>mux</dt>
            <dd>{mux}</dd>
          </>
        )}
        {signal.attributes.length > 0 && (
          <>
            <dt>attrs</dt>
            <dd>
              {signal.attributes.map((a) => (
                <span key={a.name} className="dbc-details-attr">
                  {a.name}=<em>{a.value}</em>
                </span>
              ))}
            </dd>
          </>
        )}
        {signal.valueTable.length > 0 && (
          <>
            <dt>values</dt>
            <dd>
              {signal.valueTable.map((v) => (
                <span key={v.raw} className="dbc-details-value">
                  {v.raw}={v.label}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/// `0x<hex id>` with a trailing `x` for an extended id (`0x1FFFFFFFx`,
/// `0x100`) — the tree row's id-label convention. Distinct from
/// `format.ts`'s `formatId` (`x:`/`s:`-prefixed, zero-padded), which is
/// the trace-view convention instead.
function dbcIdLabel(m: { messageId: number; extended: boolean }): string {
  return `0x${m.messageId.toString(16).toUpperCase()}${m.extended ? "x" : ""}`;
}

interface MessageDetailsProps {
  message: DbcMessageContentRecord;
  indent: string;
}

/// Lines [`MessageDetails`] renders, for [`detailLinesFor`]. Id and
/// length are unconditional; extended mux and attributes each add one
/// when present.
function messageDetailLines(m: DbcMessageContentRecord): number {
  return 2 + (m.usesExtendedMux ? 1 : 0) + (m.attributes.length > 0 ? 1 : 0);
}

function MessageDetails({ message, indent }: MessageDetailsProps) {
  const decId = message.messageId.toString(10);
  const hexId = dbcIdLabel(message);
  return (
    <div className="dbc-row-details" style={{ paddingLeft: indent }}>
      <dl className="dbc-details-grid">
        <dt>id</dt>
        <dd>
          {hexId} <span className="dbc-details-aside">({decId})</span>
        </dd>
        <dt>length</dt>
        <dd>
          {message.expectedLen} B{message.isFd ? " · FD" : ""}
          {message.isFd && message.brs ? " · BRS" : ""}
        </dd>
        {message.usesExtendedMux && (
          <>
            <dt>mux</dt>
            <dd>extended (m&lt;N&gt;M) — bytes-only in TX</dd>
          </>
        )}
        {message.attributes.length > 0 && (
          <>
            <dt>attrs</dt>
            <dd>
              {message.attributes.map((a) => (
                <span key={a.name} className="dbc-details-attr">
                  {a.name}=<em>{a.value}</em>
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function DbcRowContent({ kind }: { kind: RenderRow["kind"] }) {
  if (kind.tag === "bus") {
    return <span className="dbc-row-label">{kind.label}</span>;
  }
  if (kind.tag === "dbc") {
    return (
      <>
        <span className="dbc-row-label" title={kind.path}>
          {basename(kind.path)}
        </span>
        {kind.note && (
          <span className="dbc-row-meta dbc-row-scope">{kind.note}</span>
        )}
        {kind.collision && (
          <span
            className="dbc-row-meta dbc-row-collision"
            title={kind.collision.title}
          >
            {kind.collision.summary}
          </span>
        )}
      </>
    );
  }
  if (kind.tag === "ecu") {
    return (
      <span className="dbc-row-label">
        <NameText name={kind.label} />
      </span>
    );
  }
  if (kind.tag === "message") {
    const m = kind.message;
    const idLabel = dbcIdLabel(m);
    return (
      <>
        <span className="dbc-row-label">
          <NameText name={m.name} />
        </span>
        <span className="dbc-row-meta">{idLabel}</span>
        {m.comment && <span className="dbc-row-comment">{m.comment}</span>}
      </>
    );
  }
  if (kind.tag === "file") {
    // Labelled by the capture file's name, like a DBC branch is by its
    // file's — the file plays the same structural role (ADR 0052).
    return (
      <span className="dbc-row-label" title={kind.path}>
        {basename(kind.path) || "(imported signals)"}
      </span>
    );
  }
  if (kind.tag === "filegroup") {
    return (
      <span className="dbc-row-label">
        <NameText name={kind.label} />
      </span>
    );
  }
  if (kind.tag === "filesignal") {
    // Name + unit, and nothing else: a file-backed signal has no
    // comment, no value table and no bit layout to show.
    return (
      <>
        <span className="dbc-row-label">
          <NameText name={kind.signal.name} />
        </span>
        {kind.signal.unit && <span className="dbc-row-meta">[{kind.signal.unit}]</span>}
      </>
    );
  }
  const s = kind.signal;
  return (
    <>
      <span className="dbc-row-label">
        <NameText name={s.name} />
      </span>
      {s.unit && <span className="dbc-row-meta">[{s.unit}]</span>}
      {s.comment && <span className="dbc-row-comment">{s.comment}</span>}
    </>
  );
}
