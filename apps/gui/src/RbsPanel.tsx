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
  useState,
} from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Fzf } from "fzf";

import type {
  CalcFieldsSpec,
  RbsBusView,
  RbsMessageView,
  RbsSignalView,
  RbsView,
  ValueTableEntryRecord,
} from "./types";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { CalcFieldEditor } from "./CalcFieldEditor";
import { ValidatedInput, parsePositiveInt } from "./ValidatedInput";

/// Address of one message row, as the `rbs_*` commands take it.
interface Target {
  bus: string;
  ecu: string;
  message: string;
}

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
  const { api } = props;
  const params = props.params as { elementId?: unknown } | undefined;
  const registry = useElementRegistry();
  const project = useProjectContext();
  const [elementId] = useState(() =>
    typeof params?.elementId === "string" ? params.elementId : crypto.randomUUID(),
  );
  useEffect(() => {
    registry.ensure(elementId, "rbs");
  }, [registry, elementId]);
  useEffect(() => {
    api.updateParameters({ elementId });
  }, [api, elementId]);

  const element = registry.get(elementId)?.element;
  const path = element?.kind === "rbs" ? element.path : null;
  const run = element?.kind === "rbs" ? element.run : false;

  // The assembled tree. `null` only until the host's `rbs_init` /
  // `rbs_load` (driven by App's lifecycle effect) lands.
  const [view, setView] = useState<RbsView | null>(null);
  const refresh = useCallback(() => {
    void invoke<RbsView | null>("rbs_view", { elementId })
      .then(setView)
      .catch(() => setView(null));
  }, [elementId]);

  useEffect(() => {
    let active = true;
    // Paint fast from whatever the host already has…
    refresh();
    const un = listen<string>("rbs-changed", (event) => {
      if (event.payload === elementId || event.payload === "*") refresh();
    });
    // …and fetch again once the listener is attached: `listen` is
    // async, and on app launch the host's `rbs_load` (driven by the
    // project opening) can emit `rbs-changed` in the gap before
    // registration — without this second fetch that emit is lost and
    // the panel would sit empty until the next mutation.
    void un.then(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
      void un.then((f) => f());
    };
  }, [refresh, elementId]);

  // Live calculated fields: while the simulation runs, the fire path
  // rewrites payload buffers (counter / CRC) without an `rbs-changed`
  // per send. Poll at a display cadence so value cells track.
  const anyRunning =
    view?.run === true &&
    view.buses.some((b) => b.ecus.some((e) => e.messages.some((m) => m.running)));
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(refresh, 500);
    return () => window.clearInterval(timer);
  }, [anyRunning, refresh]);

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

  const setRun = useCallback(
    (value: boolean) => {
      registry.update(elementId, { kind: "rbs", run: value });
    },
    [registry, elementId],
  );

  const toggleKillSwitch = useCallback(() => {
    void invoke("rbs_set_kill_switch", { on: !(view?.killSwitch ?? false) }).catch(
      () => {},
    );
  }, [view]);

  // ---- filter (fzf, same matcher as the DBC panel) ----
  const [query, setQuery] = useState("");
  const visibleMessageKeys = useMemo<Set<string> | null>(() => {
    if (!view || query.trim() === "") return null;
    interface Entry {
      id: string; // `${busKey}/${msgKey}`
      haystack: string;
    }
    const entries: Entry[] = [];
    for (const bus of view.buses) {
      for (const ecu of bus.ecus) {
        for (const m of ecu.messages) {
          entries.push({
            id: `${bus.key}/${m.key}`,
            haystack: [m.name ?? "", m.key, ecu.name, ...m.signals.map((s) => s.name)].join(
              " ",
            ),
          });
        }
      }
    }
    const fzf = new Fzf<readonly Entry[]>(entries, {
      selector: (e) => e.haystack,
      casing: "case-insensitive",
    });
    return new Set(fzf.find(query.trim()).map((r) => r.item.id));
  }, [view, query]);

  // ---- expansion state ----
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  // ---- modal / menu state ----
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

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
        <label className="rbs-run-toggle" title="Transmit enabled messages (persisted in the project, default off)">
          <input
            type="checkbox"
            checked={run}
            onChange={(e) => setRun(e.target.checked)}
            aria-label="run simulation"
          />
          Run
        </label>
        <button
          type="button"
          className={view?.killSwitch ? "rbs-kill rbs-kill-on" : "rbs-kill"}
          onClick={toggleKillSwitch}
          title="Global RBS kill-switch: stops every RBS transmission in the session (never persisted)"
        >
          {view?.killSwitch ? "Kill-switch ON" : "Kill-switch"}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!view?.dirty}
          title={
            path == null
              ? "Pick a .cannet_rbs path and write the config"
              : "Write override edits back to the .cannet_rbs file"
          }
        >
          Save{view?.dirty ? " •" : ""}
        </button>
        <input
          className="rbs-filter"
          type="text"
          placeholder="filter messages / signals"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="filter"
        />
        <span className="rbs-path" title={path ?? "not saved to a file yet"}>
          {path == null ? "(unsaved)" : path.split(/[/\\]/).pop()}
        </span>
        <button type="button" onClick={() => void handleOpenFile()}>
          Open…
        </button>
      </div>

      <div className="rbs-tree" role="tree">
        {view?.buses.map((bus) => (
          <BusSection
            key={bus.key}
            elementId={elementId}
            bus={bus}
            collapsed={collapsed.has(`b:${bus.key}`)}
            onToggleCollapse={() => setCollapsed((s) => toggleSet(s, `b:${bus.key}`))}
            collapsedSet={collapsed}
            setCollapsed={setCollapsed}
            expandedMessages={expandedMessages}
            setExpandedMessages={setExpandedMessages}
            visible={visibleMessageKeys}
            onConfigure={(target, message, preset) =>
              setEditor({ target, message, preset })
            }
            onSignalMenu={setMenu}
          />
        ))}
        {addableBuses.length > 0 && (
          <div className="rbs-add-bus">
            <select
              value={busToAdd || addableBuses[0]}
              onChange={(e) => setBusToAdd(e.target.value)}
              aria-label="bus to add"
            >
              {addableBuses.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button type="button" onClick={handleAddBus}>
              Add bus to simulation
            </button>
          </div>
        )}
      </div>

      {menu && (
        <div
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
  bus: RbsBusView;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsedSet: Set<string>;
  setCollapsed: (f: (s: Set<string>) => Set<string>) => void;
  expandedMessages: Set<string>;
  setExpandedMessages: (f: (s: Set<string>) => Set<string>) => void;
  visible: Set<string> | null;
  onConfigure: (
    target: Target,
    message: RbsMessageView,
    preset: { role: "counter" | "crc"; signal: string } | null,
  ) => void;
  onSignalMenu: (menu: MenuState) => void;
}

function BusSection({
  elementId,
  bus,
  collapsed,
  onToggleCollapse,
  collapsedSet,
  setCollapsed,
  expandedMessages,
  setExpandedMessages,
  visible,
  onConfigure,
  onSignalMenu,
}: BusSectionProps) {
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
  const ecus = bus.ecus
    .map((ecu) => ({
      ecu,
      messages: ecu.messages.filter(
        (m) => visible == null || visible.has(`${bus.key}/${m.key}`),
      ),
    }))
    .filter((e) => e.messages.length > 0 || visible == null);

  return (
    <section className={inert ? "rbs-bus rbs-inert" : "rbs-bus"}>
      <div className="rbs-bus-row" role="treeitem" aria-expanded={!collapsed}>
        <button
          type="button"
          className="rbs-caret"
          tabIndex={-1}
          onClick={onToggleCollapse}
          aria-label={`toggle ${bus.key}`}
        >
          {collapsed ? "▸" : "▾"}
        </button>
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
      {!collapsed &&
        ecus.map(({ ecu, messages }) => (
          <div key={ecu.name} className="rbs-ecu">
            <div className="rbs-ecu-row" role="treeitem">
              <button
                type="button"
                className="rbs-caret"
          tabIndex={-1}
                onClick={() => setCollapsed((s) => toggleSet2(s, `e:${bus.key}/${ecu.name}`))}
                aria-label={`toggle ${ecu.name}`}
              >
                {collapsedSet.has(`e:${bus.key}/${ecu.name}`) ? "▸" : "▾"}
              </button>
              <input
                type="checkbox"
                checked={ecu.enabled}
                disabled={inert}
                onChange={(e) => setEnabled(ecu.name, null, e.target.checked)}
                aria-label={`${ecu.name} enabled`}
              />
              <span className="rbs-ecu-name">{ecu.name}</span>
            </div>
            {!collapsedSet.has(`e:${bus.key}/${ecu.name}`) &&
              messages.map((m) => (
                <MessageRow
                  key={m.key}
                  elementId={elementId}
                  target={{ bus: bus.key, ecu: ecu.name, message: m.key }}
                  message={m}
                  inert={inert}
                  expanded={expandedMessages.has(`${bus.key}/${m.key}`)}
                  onToggleExpand={() =>
                    setExpandedMessages((s) => toggleSet2(s, `${bus.key}/${m.key}`))
                  }
                  onEnable={(enabled) => setEnabled(ecu.name, m.key, enabled)}
                  onConfigure={(preset) =>
                    onConfigure({ bus: bus.key, ecu: ecu.name, message: m.key }, m, preset)
                  }
                  onSignalMenu={onSignalMenu}
                />
              ))}
          </div>
        ))}
    </section>
  );
}

function toggleSet2(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

interface MessageRowProps {
  elementId: string;
  target: Target;
  message: RbsMessageView;
  inert: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onEnable: (enabled: boolean) => void;
  onConfigure: (preset: { role: "counter" | "crc"; signal: string } | null) => void;
  onSignalMenu: (menu: MenuState) => void;
}

function MessageRow({
  elementId,
  target,
  message: m,
  inert,
  expanded,
  onToggleExpand,
  onEnable,
  onConfigure,
  onSignalMenu,
}: MessageRowProps) {
  const unknown = m.name == null;
  const dataHex = m.data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  const calcSummary = [
    m.counter ? `ctr:${m.counter.signal}` : null,
    m.crc ? `crc:${m.crc.signal}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={unknown ? "rbs-message rbs-inert" : "rbs-message"}>
      <div className="rbs-message-row" role="treeitem" aria-expanded={expanded}>
        <button
          type="button"
          className="rbs-caret"
          tabIndex={-1}
          onClick={onToggleExpand}
          aria-label={`toggle ${m.key}`}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <input
          type="checkbox"
          checked={m.enabled}
          disabled={inert || unknown}
          onChange={(e) => onEnable(e.target.checked)}
          aria-label={`${m.key} enabled`}
        />
        {m.running && <span className="rbs-dot rbs-dot-on" title="scheduled" />}
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
  target: Target;
  message: RbsMessageView;
  signal: RbsSignalView;
  inert: boolean;
  onMenu: (e: MouseEvent) => void;
}

function SignalRow({ elementId, target, message, signal: s, inert, onMenu }: SignalRowProps) {
  // Enum signals get a datalist of labels (committed as the label
  // string — the host resolves it through the VAL_ table).
  const [labels, setLabels] = useState<ValueTableEntryRecord[]>([]);
  useEffect(() => {
    if (!s.hasValueTable) return;
    let cancelled = false;
    void invoke<ValueTableEntryRecord[]>("list_value_tables", {
      messageId: message.messageId,
      extended: message.extended,
      signalName: s.name,
    })
      .then((rows) => {
        if (!cancelled) setLabels(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [s.hasValueTable, s.name, message.messageId, message.extended]);

  const display = s.label ?? (s.value != null ? formatValue(s.value) : "—");
  const datalistId = `rbs-enum-${message.key}-${s.name}`;
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
      <td className="rbs-sig-name">{s.name}</td>
      <td className="rbs-sig-value">
        {s.calcRole ? (
          <span
            className="rbs-calc-cell"
            title={`${s.calcRole} destination — recomputed on every send`}
          >
            {display} <em>({s.calcRole})</em>
          </span>
        ) : (
          <>
            <ValidatedInput
              value={display === "—" ? "" : display}
              focusBehavior={s.hasValueTable ? "clear" : "select"}
              parse={(text) => {
                if (text === "") return null;
                const labelMatch = labels.find((l) => l.label === text);
                if (labelMatch) return labelMatch.label;
                const n = Number(text);
                if (Number.isFinite(n)) return n;
                // 0x raw values pass through as strings.
                if (/^0x[0-9a-fA-F]+$/.test(text)) return text;
                return null;
              }}
              onCommit={commit}
              className="rbs-signal-input"
              ariaLabel={`${s.name} value`}
              list={s.hasValueTable ? datalistId : undefined}
              disabled={inert}
            />
            {s.hasValueTable && (
              <datalist id={datalistId}>
                {labels.map((l) => (
                  <option key={l.raw} value={l.label}>
                    {l.raw}
                  </option>
                ))}
              </datalist>
            )}
            {s.overridden && (
              <button
                type="button"
                className="rbs-clear"
                tabIndex={-1}
                title={`clear override (track DBC default)${s.overrideText ? ` — currently ${s.overrideText}` : ""}`}
                onClick={() =>
                  void invoke("rbs_set_signal", {
                    elementId,
                    target,
                    signal: s.name,
                    value: null,
                  }).catch(() => {})
                }
              >
                ×
              </button>
            )}
          </>
        )}
      </td>
      <td className="rbs-sig-unit">{s.unit}</td>
    </tr>
  );
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const s = v.toPrecision(6);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
