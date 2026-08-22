// Rest-of-bus-simulation panel (ADR 0028) — a thin view over the
// host's RBS model.
//
// The host owns everything: the parsed `.cannet_rbs` document, the
// payload buffers, the registry rows, and the schedules. This panel
// fetches one assembled tree per render generation (`rbs_view`),
// renders it as a bus → ECU → message → signal grid with ANDed enable
// checkboxes, and routes every edit through an `rbs_*` command. The
// host emits `rbs-changed` after every mutation; the panel re-fetches.
//
// Values are live: a signal cell shows the decode of the message's
// current payload buffer; an edit partial-encodes into it (and lands
// on the next emission when the row is running). Overridden cells are
// marked and carry a light × to clear back to DBC-tracking. Counter /
// CRC destination cells are read-only — their values are recomputed
// on every send — and configured through the shared editor.
//
// A fresh element needs no file: the host seeds an in-memory config
// from the project's current buses, and Save prompts for a
// `.cannet_rbs` path the first time (the element then references it).

import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import type {
  CalcFieldsSpec,
  RbsMessageStatus,
  RbsMessageView,
  RbsSignalView,
  RbsView,
} from "./types";
import { useProjectContext } from "./projectContext";
import { elementLabel } from "./elementLabel";
import { showRbsSignalsPanel } from "./dockLayout";
import { CalcFieldEditor } from "./CalcFieldEditor";
import { ChangedOnDiskNotice } from "./ChangedOnDiskNotice";
import { Combobox } from "./Combobox";
import { DisclosureToggle } from "./DisclosureToggle";
import { ValidatedInput, parsePositiveInt } from "./ValidatedInput";
import { useElementPanel } from "./useElementPanel";
import { useHostMirror } from "./useHostMirror";
import { useDismissableMenu } from "./useDismissableMenu";
import { usePanelCommands } from "./panelCommands";
import { toggleInSet } from "./toggleSet";
import { formatBytes } from "./format";
import { RbsValueCell } from "./rbsValueCell";
import { GridviewFilterBox, useGridviewFilter } from "./gridviewFilter";
import { ChipButton } from "./ChipButton";
import { Icon } from "./Icon";
import { useGridview, type Gridview } from "./useGridview";
import { arrayRowSpace, type GridviewAdapter } from "./gridviewRows";
import {
  buildRbsFilterEntries,
  buildVisibleTree,
  makeRbsRowSpace,
  makeRbsRowIds,
  makeRowGridPropsCache,
  type RbsRowIds,
  type RowGridProps,
  type VisibleBus,
} from "./rbsRowIdentity";
import { NameText } from "./NameText";

/// The message row's status cell. The words are the RBS signals grid's
/// where they overlap — *Muted* means the same thing in both: the
/// message won't play regardless of what it carries. The other two are
/// what the scheduled dot used to say, said in words.
const STATUS_LABEL: Record<RbsMessageStatus, string> = {
  running: "Running",
  stopped: "Stopped",
  muted: "Muted",
};

/// Address of one message row, as the `rbs_*` commands take it.
interface Target {
  bus: string;
  ecu: string;
  message: string;
}

/// What PageUp / PageDown move by. The panel isn't virtualized, so it
/// has no measured row geometry to derive a viewport's worth from; a
/// screenful of ~20px rows in a typical dock panel is about this.
const PAGE_ROWS = 12;

/// An open calc-field editor: the target message plus its current
/// state and an optional preset destination (right-click flow).
interface EditorState {
  target: Target;
  message: RbsMessageView;
  preset: { role: "counter" | "crc"; signal: string } | null;
}

/// A signal context menu (configure as counter / CRC).
interface MenuState {
  x: number;
  y: number;
  target: Target;
  message: RbsMessageView;
  signal: string;
}

export function RbsPanel(props: IDockviewPanelProps) {
  const { containerApi } = props;
  const project = useProjectContext();
  const { elementId, registry, element, persist } = useElementPanel(props, "rbs");
  // Persist just the elementId in panel params — no view-local
  // config: `path` lives on the element itself, written directly
  // through `registry.update` at their own call sites below. Run is
  // host session state, read off the view and written with
  // `rbs_set_run`.
  useEffect(() => {
    persist();
  }, [persist]);

  const path = element?.kind === "rbs" ? element.path : null;

  // The assembled tree. `null` only until the host's `rbs_init` /
  // `rbs_load` (driven by App's lifecycle effect) lands — re-fetched on
  // `rbs-changed` (scoped to this element or a `"*"` broadcast) and,
  // while the simulation runs, on a 500ms poll: the fire path rewrites
  // payload buffers (counter / CRC) without an `rbs-changed` per send,
  // so polling is what keeps value cells tracking.
  const fetchView = useCallback(
    () => invoke<RbsView | null>("rbs_view", { elementId }),
    [elementId],
  );
  const { value: view } = useHostMirror<RbsView | null, string>({
    fetch: fetchView,
    fallback: null,
    event: "rbs-changed",
    matches: (payload) => payload === elementId || payload === "*",
    pollWhile: (v) =>
      v?.run === true && v.buses.some((b) => b.ecus.some((e) => e.messages.some((m) => m.running))),
  });

  const run = view?.run === true;

  // ---- file picking ----
  const handleOpenFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "cannet RBS config", extensions: ["cannet_rbs", "json"] }],
    });
    if (typeof selected !== "string") return;
    registry.update(elementId, { kind: "rbs", path: selected });
  }, [registry, elementId]);

  const handleSave = useCallback(async () => {
    if (path != null) {
      void invoke("rbs_save", { elementId }).catch(() => {});
      return;
    }
    // Never saved: pick the first path.
    const target = await save({
      filters: [{ name: "cannet RBS config", extensions: ["cannet_rbs"] }],
      defaultPath: "simulation.cannet_rbs",
    });
    if (typeof target !== "string" || target.length === 0) return;
    try {
      await invoke("rbs_save_as", { elementId, path: target });
      registry.update(elementId, { kind: "rbs", path: target });
    } catch {
      // errors land on the system log
    }
  }, [elementId, path, registry]);

  // The `.cannet_rbs` changed on disk and the host declined to apply it,
  // because this element had unsaved overrides or was transmitting
  // (ADR 0053 §1). Both facts are the host's, so the decision and the
  // pending flag are the host's too — the panel renders `changedOnDisk`
  // and offers the two ways out of it.
  //
  // Applying runs `rbs_load`, the same load path the host would have
  // run itself, which is what preserves the element's run state.
  const applyDiskChange = useCallback(() => {
    const target = view?.path;
    if (target == null) return;
    void invoke("rbs_load", { elementId, path: target }).catch(() => {});
  }, [elementId, view]);
  const dismissDiskChange = useCallback(() => {
    void invoke("rbs_dismiss_disk_change", { elementId }).catch(() => {});
  }, [elementId]);

  // Run is the host's, and nothing else writes it: the panel sends the
  // command and re-reads the flag off the next `rbs-changed` view. That
  // is what lets the host stop an element on its own — a reload, an
  // unassign, a project open — without a second copy to disagree with.
  const setRun = useCallback(
    (value: boolean) => {
      void invoke("rbs_set_run", { elementId, run: value }).catch(() => {});
    },
    [elementId],
  );

  // ---- the filter slot (ADR 0044) ----
  // The whole tree is client-held, so the panel opts into the layer's
  // fzf instead of carrying its own: a query keeps the matching messages
  // and the bus / ECU path to each, and treats that path as expanded.
  // Row identity is interned for the life of the panel: the 500 ms
  // value poll below rebuilds `view`, but not the shape the ids name.
  const rowIds = useMemo(() => makeRbsRowIds(), []);
  const buildFilterEntries = useCallback(
    () => buildRbsFilterEntries(view, rowIds),
    [view, rowIds],
  );
  const filter = useGridviewFilter(buildFilterEntries);
  /// The filter box, so `panel.find` (Mod+F, ADR 0018) can focus and
  /// select it.
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  usePanelCommands(elementId, {
    "panel.find": () => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    },
  });

  // ---- expansion state ----
  // Buses and ECUs default to open, so the set holds what the user has
  // *closed*; a message's signal table defaults to closed, so that set
  // holds what they have opened. Both are view-local — the RBS element
  // persists the config, not how the reader last folded it.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    () => new Set(),
  );

  // ---- the gridview (ADR 0044) ----
  const isRowExpanded = useCallback(
    (id: string) =>
      id.startsWith("m:") ? expandedMessages.has(id) : !collapsed.has(id),
    [collapsed, expandedMessages],
  );
  const filterActive = filter.active;
  const matchSet = filter.matchSet;
  const ancestorsOfMatches = filter.ancestorsOfMatches;
  /// A match's ancestors read as expanded, so a hit deep in a closed bus
  /// is on screen without the user unfolding the path to it.
  const effectiveExpanded = useCallback(
    (id: string) => ancestorsOfMatches.has(id) || isRowExpanded(id),
    [ancestorsOfMatches, isRowExpanded],
  );
  /// `null` while nothing is narrowing — then the walk keeps everything
  /// without asking, and each ECU keeps its own message array.
  const keepRow = useMemo(
    () =>
      filterActive
        ? (id: string) => matchSet.has(id) || ancestorsOfMatches.has(id)
        : null,
    [filterActive, matchSet, ancestorsOfMatches],
  );
  const tree = useMemo(
    () => buildVisibleTree(view, rowIds, effectiveExpanded, keepRow),
    [view, rowIds, effectiveExpanded, keepRow],
  );
  const rowSpace = useMemo(() => makeRbsRowSpace(), []);
  const gridRows = rowSpace(tree, rowIds);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const setRowExpanded = useCallback((id: string, want: boolean) => {
    if (id.startsWith("m:")) {
      setExpandedMessages((prev) => (prev.has(id) === want ? prev : toggleInSet(prev, id)));
      return;
    }
    // Inverted: the set holds the rows the user has closed.
    setCollapsed((prev) => (prev.has(id) !== want ? prev : toggleInSet(prev, id)));
  }, []);
  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, effectiveExpanded);
    return {
      ...space,
      // The panel isn't virtualized, so the row is in the document and
      // the arithmetic is the "scroll it just into view" one — done by
      // hand rather than through `scrollIntoView`, which cannot be told
      // to leave an already-visible row alone.
      scrollToRow: (index) => {
        const id = space.rowIdAt(index);
        const container = treeRef.current;
        if (id == null || container == null) return;
        const el = document.getElementById(rowDomIdRef.current(id));
        if (el == null) return;
        const c = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < c.top) container.scrollTop += r.top - c.top;
        else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
      },
      setExpanded: setRowExpanded,
      // Buses and ECUs are structure; a message row is the thing a
      // reader picks.
      isSelectable: (row) => row.kind === "leaf",
    };
  }, [gridRows, effectiveExpanded, setRowExpanded]);
  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: `rbs-${elementId}` });
  /// `scrollToRow` is built inside a memo that must not move with the
  /// hook's per-render identity, so it reads the mapping through a ref.
  const rowDomIdRef = useRef(grid.rowDomId);
  rowDomIdRef.current = grid.rowDomId;
  /// A row's DOM id and its click handler depend only on its id, so they
  /// are built once per row instead of once per row per refresh.
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const rowProps = useMemo(() => makeRowGridPropsCache(gridRef, treeRef), []);

  // ---- modal / menu state ----
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useDismissableMenu<HTMLDivElement>(menu != null, () => setMenu(null));

  const projectBusNames = project.buses.map((b) => b.name);
  const fileBusKeys = new Set(view?.buses.map((b) => b.key) ?? []);
  // Offer adds only once the view is loaded — before that the file's
  // own buses would transiently show as addable.
  const addableBuses =
    view == null ? [] : projectBusNames.filter((n) => !fileBusKeys.has(n));
  const [busToAdd, setBusToAdd] = useState("");

  const handleAddBus = useCallback(() => {
    const name = busToAdd || addableBuses[0];
    if (!name) return;
    void invoke("rbs_set_enabled", {
      elementId,
      bus: name,
      ecu: null,
      message: null,
      enabled: true,
    }).catch(() => {});
    setBusToAdd("");
  }, [busToAdd, addableBuses, elementId]);

  return (
    <div className="rbs-panel">
      <div className="rbs-toolbar">
        <ChipButton
          icon="play"
          label="Run"
          title="Transmit enabled messages (session state, default off — never saved with the project)"
          pressed={run}
          onPress={() => setRun(!run)}
        />
        <ChipButton
          icon="save"
          label={`Save${view?.dirty ? " •" : ""}`}
          ariaLabel="Save"
          disabled={!view?.dirty}
          title={
            path == null
              ? "Pick a .cannet_rbs path and write the config"
              : "Write override edits back to the .cannet_rbs file"
          }
          onPress={() => void handleSave()}
        />
        {view?.changedOnDisk === true && (
          <ChangedOnDiskNotice
            statement="RBS file changed on disk"
            action={{
              label: "Apply anyway",
              title:
                "Re-read the .cannet_rbs from disk. Unsaved overrides are lost; a running element keeps running, with the file's definitions.",
              onClick: applyDiskChange,
            }}
            dismiss={{
              label: "Dismiss the RBS changed-on-disk notice",
              title:
                "Keep working with the config as it is in memory. Saving will overwrite the file's new contents.",
              onClick: dismissDiskChange,
            }}
          />
        )}
        <span className="chip-field rbs-filter" title="filter messages / signals">
          <Icon name="search" />
          <GridviewFilterBox
            filter={filter}
            inputType="text"
            placeholder="filter messages / signals"
            ariaLabel="filter"
            inputRef={filterInputRef}
          />
        </span>
        <span className="rbs-path" title={path ?? "not saved to a file yet"}>
          {path == null ? "(unsaved)" : path.split(/[/\\]/).pop()}
        </span>
        <ChipButton
          icon="folder"
          label="Open"
          ariaLabel="Open RBS File"
          title="Open a different .cannet_rbs…"
          onPress={() => void handleOpenFile()}
        />
        <ChipButton
          icon="signals"
          label="Signals"
          title="Every field this config transmits, with where each value came from"
          onPress={() =>
            showRbsSignalsPanel(containerApi, elementId, element ? elementLabel(element) : "")
          }
        />
      </div>

      {/* The tree is the gridview container: it holds focus and names
          the active row, and its marker keeps the global dispatcher off
          the keys the grid consumes (ADR 0044). */}
      <div className="rbs-tree" role="tree" ref={treeRef} {...grid.containerProps}>
        {tree.map((b) => (
          <BusSection
            key={b.bus.key}
            elementId={elementId}
            visible={b}
            grid={grid}
            rowProps={rowProps}
            rowIds={rowIds}
            isExpanded={effectiveExpanded}
            onSetExpanded={setRowExpanded}
            onConfigure={(target, message, preset) =>
              setEditor({ target, message, preset })
            }
            onSignalMenu={setMenu}
          />
        ))}
        {addableBuses.length > 0 && (
          <div className="rbs-add-bus">
            <Combobox
              options={addableBuses.map((n) => ({ value: n, label: n }))}
              value={busToAdd || addableBuses[0]}
              onChange={setBusToAdd}
              ariaLabel="bus to add"
            />
            <button type="button" onClick={handleAddBus}>
              Add bus to simulation
            </button>
          </div>
        )}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="rbs-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <button
            type="button"
            onClick={() => {
              setEditor({
                target: menu.target,
                message: menu.message,
                preset: { role: "counter", signal: menu.signal },
              });
              setMenu(null);
            }}
          >
            Configure as sequence counter…
          </button>
          <button
            type="button"
            onClick={() => {
              setEditor({
                target: menu.target,
                message: menu.message,
                preset: { role: "crc", signal: menu.signal },
              });
              setMenu(null);
            }}
          >
            Configure as CRC…
          </button>
        </div>
      )}

      {editor && (
        <CalcFieldEditor
          messageLabel={editor.message.name ?? editor.message.key}
          signalNames={editor.message.signals.map((s) => s.name)}
          dbcDefaults={calcDefaultsOf(editor.message)}
          current={calcOverridesOf(editor.message)}
          preset={editor.preset}
          onSave={(spec) => {
            void invoke("rbs_set_calc", {
              elementId,
              target: editor.target,
              counter: spec?.counter ?? null,
              crc: spec?.crc ?? null,
            }).catch(() => {});
            setEditor(null);
          }}
          onCancel={() => setEditor(null)}
        />
      )}
    </div>
  );
}

/// The message's *override* layer only — what the editor edits.
function calcOverridesOf(m: RbsMessageView): CalcFieldsSpec | null {
  const counter = m.counterOverridden ? m.counter : null;
  const crc = m.crcOverridden ? m.crc : null;
  if (!counter && !crc) return null;
  return { counter, crc };
}

/// The DBC-default layer (the effective designation when it isn't an
/// override).
function calcDefaultsOf(m: RbsMessageView): CalcFieldsSpec | null {
  const counter = !m.counterOverridden ? m.counter : null;
  const crc = !m.crcOverridden ? m.crc : null;
  if (!counter && !crc) return null;
  return { counter, crc };
}

interface BusSectionProps {
  elementId: string;
  visible: VisibleBus;
  grid: Gridview;
  rowProps: (id: string) => RowGridProps;
  rowIds: RbsRowIds;
  isExpanded: (id: string) => boolean;
  onSetExpanded: (id: string, expanded: boolean) => void;
  onConfigure: (
    target: Target,
    message: RbsMessageView,
    preset: { role: "counter" | "crc"; signal: string } | null,
  ) => void;
  onSignalMenu: (menu: MenuState) => void;
}

function BusSection({
  elementId,
  visible,
  grid,
  rowProps,
  rowIds,
  isExpanded,
  onSetExpanded,
  onConfigure,
  onSignalMenu,
}: BusSectionProps) {
  const bus = visible.bus;
  const inert = bus.busId == null;
  const setEnabled = (ecu: string | null, message: string | null, enabled: boolean) => {
    void invoke("rbs_set_enabled", {
      elementId,
      bus: bus.key,
      ecu,
      message,
      enabled,
    }).catch(() => {});
  };
  const bId = rowIds.bus(bus.key);

  return (
    <section className={inert ? "rbs-bus rbs-inert" : "rbs-bus"}>
      <div
        className="rbs-bus-row"
        role="treeitem"
        aria-expanded={visible.expanded}
        {...rowProps(bId)}
        data-active={grid.cursor === bId || undefined}
      >
        <DisclosureToggle
          className="rbs-caret"
          compact
          tabIndex={-1}
          expanded={visible.expanded}
          ariaLabel={`toggle ${bus.key}`}
          onToggle={(e) => {
            e.stopPropagation();
            onSetExpanded(bId, !visible.expanded);
          }}
        />
        <input
          type="checkbox"
          checked={bus.enabled}
          disabled={inert}
          onChange={(e) => setEnabled(null, null, e.target.checked)}
          aria-label={`${bus.key} enabled`}
        />
        <span className="rbs-bus-name">{bus.key}</span>
        {inert ? (
          <span className="rbs-warn" title="No project bus has this name — rows are inert">
            unresolved bus
          </span>
        ) : (
          <span
            className={bus.connected ? "rbs-dot rbs-dot-on" : "rbs-dot"}
            title={bus.connected ? "bus connected" : "bus not connected — sends gate on connect"}
          />
        )}
      </div>
      {visible.expanded &&
        visible.ecus.map(({ ecu, expanded, messages }) => {
          const eId = rowIds.ecu(bus.key, ecu.name);
          return (
            <div key={ecu.name} className="rbs-ecu">
              <div
                className="rbs-ecu-row"
                role="treeitem"
                aria-expanded={expanded}
                {...rowProps(eId)}
        data-active={grid.cursor === eId || undefined}
              >
                <DisclosureToggle
                  className="rbs-caret"
                  compact
                  tabIndex={-1}
                  expanded={expanded}
                  ariaLabel={`toggle ${ecu.name}`}
                  onToggle={(e) => {
                    e.stopPropagation();
                    onSetExpanded(eId, !expanded);
                  }}
                />
                <input
                  type="checkbox"
                  checked={ecu.enabled}
                  disabled={inert}
                  onChange={(e) => setEnabled(ecu.name, null, e.target.checked)}
                  aria-label={`${ecu.name} enabled`}
                />
                <span className="rbs-ecu-name">
                  <NameText name={ecu.name} />
                </span>
              </div>
              {expanded &&
                messages.map((m) => {
                  const mId = rowIds.message(bus.key, m.key);
                  return (
                    <MessageRow
                      key={m.key}
                      elementId={elementId}
                      busId={bus.busId}
                      target={{ bus: bus.key, ecu: ecu.name, message: m.key }}
                      message={m}
                      inert={inert}
                      rowId={mId}
                      grid={grid}
                      rowProps={rowProps}
                      expanded={isExpanded(mId)}
                      onToggleExpand={(want) => onSetExpanded(mId, want)}
                      onEnable={(enabled) => setEnabled(ecu.name, m.key, enabled)}
                      onConfigure={(preset) =>
                        onConfigure({ bus: bus.key, ecu: ecu.name, message: m.key }, m, preset)
                      }
                      onSignalMenu={onSignalMenu}
                    />
                  );
                })}
            </div>
          );
        })}
    </section>
  );
}

interface MessageRowProps {
  elementId: string;
  /// The project bus this element's RBS bus resolved to, or `null` when
  /// no project bus carries that name. It scopes the signals' enum
  /// labels to the databases assigned to that bus, the same set that
  /// decodes the bus's frames.
  busId: string | null;
  target: Target;
  message: RbsMessageView;
  inert: boolean;
  /// The gridview's id for this row — a **leaf with content**: the
  /// signal table below discloses in place and adds no rows.
  rowId: string;
  grid: Gridview;
  rowProps: (id: string) => RowGridProps;
  expanded: boolean;
  onToggleExpand: (expanded: boolean) => void;
  onEnable: (enabled: boolean) => void;
  onConfigure: (preset: { role: "counter" | "crc"; signal: string } | null) => void;
  onSignalMenu: (menu: MenuState) => void;
}

function MessageRow({
  elementId,
  busId,
  target,
  message: m,
  inert,
  rowId,
  grid,
  rowProps,
  expanded,
  onToggleExpand,
  onEnable,
  onConfigure,
  onSignalMenu,
}: MessageRowProps) {
  const unknown = m.name == null;
  const dataHex = formatBytes(m.data);
  const calcSummary = [
    m.counter ? `ctr:${m.counter.signal}` : null,
    m.crc ? `crc:${m.crc.signal}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={unknown ? "rbs-message rbs-inert" : "rbs-message"}>
      <div
        className={
          grid.selection.has(rowId) ? "rbs-message-row rbs-row-selected" : "rbs-message-row"
        }
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={grid.selection.has(rowId)}
        {...rowProps(rowId)}
        data-active={grid.cursor === rowId || undefined}
      >
        <DisclosureToggle
          className="rbs-caret"
          compact
          tabIndex={-1}
          expanded={expanded}
          ariaLabel={`toggle ${m.key}`}
          onToggle={(e) => {
            e.stopPropagation();
            onToggleExpand(!expanded);
          }}
        />
        <input
          type="checkbox"
          checked={m.enabled}
          disabled={inert || unknown}
          onChange={(e) => onEnable(e.target.checked)}
          aria-label={`${m.key} enabled`}
        />
        <span className={`rbs-status rbs-status-${m.status}`} title={m.statusDetail}>
          {STATUS_LABEL[m.status]}
        </span>
        <span className="rbs-msg-key">{m.key}</span>
        <span className="rbs-msg-name">
          {m.name ?? "(not in DBC — not loaded)"}
          {m.isFd && <span className="rbs-badge">FD</span>}
          {m.transmitterMismatch && (
            <span
              className="rbs-warn"
              title={`DBC says ${m.transmitterMismatch} transmits this message`}
            >
              ⚠
            </span>
          )}
        </span>
        <span className="rbs-period">
          <ValidatedInput
            value={m.periodMs != null ? String(m.periodMs) : ""}
            parse={parsePositiveInt}
            focusBehavior="select"
            
            onCommit={(ms) =>
              void invoke("rbs_set_period", {
                elementId,
                target,
                periodMs: ms,
              }).catch(() => {})
            }
            className={m.periodOverridden ? "rbs-period-input rbs-overridden" : "rbs-period-input"}
            placeholder="period"
            ariaLabel={`${m.key} period`}
            disabled={inert || unknown}
            title={m.periodOverridden ? "override — × to track GenMsgCycleTime" : "GenMsgCycleTime"}
          />
          ms
          {m.periodOverridden && (
            <button
              type="button"
              className="rbs-clear"
                tabIndex={-1}
              title="clear override (track GenMsgCycleTime)"
              onClick={() =>
                void invoke("rbs_set_period", {
                  elementId,
                  target,
                  periodMs: null,
                }).catch(() => {})
              }
            >
              ×
            </button>
          )}
        </span>
        <span className="rbs-calc-summary" title="calculated fields (counter / CRC)">
          {calcSummary}
        </span>
        <button
          type="button"
          className="rbs-configure"
          tabIndex={-1}
          disabled={inert || unknown}
          onClick={() => onConfigure(null)}
        >
          fields…
        </button>
        <span className="rbs-data" title="current payload buffer">
          {dataHex}
        </span>
      </div>
      {expanded && (
        <table className="rbs-signals">
          <tbody>
            {m.signals.map((s) => (
              <SignalRow
                key={s.name}
                elementId={elementId}
                busId={busId}
                target={target}
                message={m}
                signal={s}
                inert={inert}
                onMenu={(e) =>
                  onSignalMenu({
                    x: e.clientX,
                    y: e.clientY,
                    target,
                    message: m,
                    signal: s.name,
                  })
                }
              />
            ))}
            {m.signals.length === 0 && m.inFile && (
              <tr>
                <td className="rbs-no-signals">
                  message not in the DBC — raw overrides only
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface SignalRowProps {
  elementId: string;
  busId: string | null;
  target: Target;
  message: RbsMessageView;
  signal: RbsSignalView;
  inert: boolean;
  onMenu: (e: MouseEvent) => void;
}

function SignalRow({
  elementId,
  busId,
  target,
  message,
  signal: s,
  inert,
  onMenu,
}: SignalRowProps) {
  const commit = (value: string | number) => {
    void invoke("rbs_set_signal", {
      elementId,
      target,
      signal: s.name,
      value,
    }).catch(() => {});
  };

  return (
    <tr
      className={s.overridden ? "rbs-signal rbs-signal-overridden" : "rbs-signal"}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
    >
      <td className="rbs-sig-name">
        <NameText name={s.name} />
      </td>
      <td className="rbs-sig-value">
        <RbsValueCell
          signal={s}
          busId={busId}
          messageId={message.messageId}
          extended={message.extended}
          disabled={inert}
          onCommit={commit}
          onClear={() =>
            void invoke("rbs_set_signal", {
              elementId,
              target,
              signal: s.name,
              value: null,
            }).catch(() => {})
          }
        />
      </td>
      <td className="rbs-sig-unit">{s.unit}</td>
    </tr>
  );
}

