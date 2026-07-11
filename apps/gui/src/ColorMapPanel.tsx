import { useCallback, useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import { Combobox } from "./Combobox";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { rulesFromValueTable } from "./colorMap";
import { isEnumValueTable, type ColorRule, type ProjectElement, type SignalDescriptorRecord, type ValueTableEntryRecord } from "./types";

type ColorMapElement = Extract<ProjectElement, { kind: "colormap" }>;

const DEFAULT_RULE_COLOR = "#3b82f6";

/// A stable key for a catalog signal — the colormap targets one of these.
function descKey(d: {
  bus_id: string | null;
  message_id: number;
  extended: boolean;
  signal_name: string;
}): string {
  return `${d.bus_id ?? ""}|${d.message_id}|${d.extended ? "x" : "s"}|${d.signal_name}`;
}

function elementTargetKey(el: ColorMapElement): string {
  return descKey({
    bus_id: el.busId ?? null,
    message_id: el.messageId,
    extended: el.extended,
    signal_name: el.signalName,
  });
}

/**
 * Config panel for a `colormap` element (ADR 0029): pick a target signal
 * from the attached DBCs, then give each of its values a colour. For an
 * enum signal — the common case — the editor lists one sparse row per
 * `VAL_` value: its name and a colour swatch. A numeric signal falls
 * back to inclusive `[min, max]` ranges. Any view rendering the signal
 * tints its value cell to match.
 */
export function ColorMapPanel(props: IDockviewPanelProps) {
  const registry = useElementRegistry();
  const { ensure, update } = registry;
  const { buses } = useProjectContext();

  const params = props.params as { elementId?: unknown } | undefined;
  const [elementId] = useState(() =>
    typeof params?.elementId === "string" ? params.elementId : crypto.randomUUID(),
  );
  useEffect(() => {
    ensure(elementId, "colormap");
  }, [ensure, elementId]);

  const entry = registry.get(elementId)?.element;
  const element = entry && entry.kind === "colormap" ? entry : null;

  const busName = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of buses) m.set(b.id, b.name);
    return m;
  }, [buses]);

  // The signal catalog (every signal the attached DBCs define, expanded
  // per bus). The host owns the DBC→signal mapping.
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);
  useEffect(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals", {
      projectBuses: buses.map((b) => b.id),
    })
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, [buses]);

  // The target signal's value table (enum names), re-fetched when the
  // target changes. Not an enum (`isEnumValueTable`: fewer than two
  // members, single-member SNA sentinels included) ⇒ a numeric signal
  // (range editor).
  const signalName = element?.signalName ?? "";
  const messageId = element?.messageId ?? 0;
  const extended = element?.extended ?? false;
  const [valueTable, setValueTable] = useState<ValueTableEntryRecord[]>([]);
  useEffect(() => {
    if (!signalName) {
      setValueTable([]);
      return;
    }
    let cancelled = false;
    void invoke<ValueTableEntryRecord[]>("list_value_tables", { messageId, extended, signalName })
      .then((rows) => {
        if (!cancelled) setValueTable(rows);
      })
      .catch(() => {
        if (!cancelled) setValueTable([]);
      });
    return () => {
      cancelled = true;
    };
  }, [signalName, messageId, extended]);

  const setRules = useCallback(
    (rules: ColorRule[]) => update(elementId, { rules }),
    [update, elementId],
  );

  // Pick a target signal. Seeds a colour per enum value so the map is
  // useful at once and every value of the signal is covered.
  const onPickSignal = useCallback(
    async (key: string) => {
      const d = catalog.find((c) => descKey(c) === key);
      if (!d) return;
      update(elementId, {
        busId: d.bus_id,
        messageId: d.message_id,
        extended: d.extended,
        signalName: d.signal_name,
      });
      try {
        const rows = await invoke<ValueTableEntryRecord[]>("list_value_tables", {
          messageId: d.message_id,
          extended: d.extended,
          signalName: d.signal_name,
        });
        update(elementId, { rules: isEnumValueTable(rows) ? rulesFromValueTable(rows) : [] });
      } catch {
        update(elementId, { rules: [] });
      }
    },
    [catalog, update, elementId],
  );

  // Bus → message ancestry renders as combobox group headers; the
  // closed state keeps the full context ("Chassis · GearBox.Gear").
  const catalogOptions = catalog.map((d) => {
    const bus = d.bus_id ? busName.get(d.bus_id) ?? d.bus_id : "any bus";
    return {
      value: descKey(d),
      label: d.signal_name,
      path: [bus, d.message_name],
      selectedLabel: `${bus} · ${d.message_name}.${d.signal_name}`,
    };
  });

  if (!element) return <div className="colormap-panel">loading…</div>;

  const rules = element.rules;
  // Enum row → its colour (the degenerate `[raw, raw]` rule's colour).
  const colorForRaw = (raw: number): string | undefined =>
    rules.find((r) => r.min === raw && r.max === raw)?.color;
  const setColorForRaw = (raw: number, color: string) => {
    const i = rules.findIndex((r) => r.min === raw && r.max === raw);
    setRules(
      i >= 0
        ? rules.map((r, j) => (j === i ? { ...r, color } : r))
        : [...rules, { min: raw, max: raw, color }],
    );
  };
  const patchRule = (i: number, patch: Partial<ColorRule>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="colormap-panel">
      <label className="colormap-field">
        <span>Signal</span>
        <Combobox
          options={catalogOptions}
          value={element.signalName ? elementTargetKey(element) : ""}
          onChange={(v) => void onPickSignal(v)}
          placeholder={catalog.length === 0 ? "no DBC signals" : "pick a signal…"}
        />
      </label>

      {!element.signalName ? (
        <div className="colormap-empty">Pick a signal to colour its values.</div>
      ) : isEnumValueTable(valueTable) ? (
        // Enum signal: one sparse row per value — its name + a colour.
        <ul className="colormap-rules">
          {valueTable.map((v) => (
            <li key={v.raw} className="colormap-rule">
              <input
                type="color"
                value={colorForRaw(v.raw) ?? DEFAULT_RULE_COLOR}
                aria-label={`${v.label} colour`}
                onChange={(e) => setColorForRaw(v.raw, e.target.value)}
              />
              <span className="colormap-enum-label">{v.label}</span>
              <span className="colormap-enum-raw">{v.raw}</span>
            </li>
          ))}
        </ul>
      ) : (
        // Numeric signal: inclusive [min, max] ranges.
        <>
          {rules.length === 0 ? (
            <div className="colormap-empty">No ranges yet — add one to colour a value band.</div>
          ) : (
            <ul className="colormap-rules">
              {rules.map((r, i) => (
                <li key={i} className="colormap-rule">
                  <input
                    type="color"
                    value={r.color}
                    aria-label={`range ${i + 1} colour`}
                    onChange={(e) => patchRule(i, { color: e.target.value })}
                  />
                  <input
                    type="number"
                    className="colormap-num"
                    value={r.min}
                    aria-label={`range ${i + 1} min`}
                    onChange={(e) => patchRule(i, { min: Number(e.target.value) })}
                  />
                  <span className="colormap-dash">–</span>
                  <input
                    type="number"
                    className="colormap-num"
                    value={r.max}
                    aria-label={`range ${i + 1} max`}
                    onChange={(e) => patchRule(i, { max: Number(e.target.value) })}
                  />
                  <button
                    type="button"
                    className="colormap-remove"
                    aria-label={`remove range ${i + 1}`}
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="colormap-add"
            onClick={() => setRules([...rules, { min: 0, max: 0, color: DEFAULT_RULE_COLOR }])}
          >
            + range
          </button>
        </>
      )}
    </div>
  );
}
