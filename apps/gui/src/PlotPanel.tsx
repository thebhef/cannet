import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { SignalDescriptorRecord, SignalSeries } from "./types";
import { useTraceData } from "./traceData";
import { useProjectContext } from "./projectContext";
import { mergeSeries, signalKey } from "./plotData";

/**
 * A signal-plotting panel inside the dockview layout, in the spirit of
 * vSignalyzer / CANape — a software oscilloscope for decoded CAN
 * signals. See `plans/phased-implementation.md` Phase 4 and
 * `plans/plot-panel-reference.html` for the target design.
 *
 * Structure (this is step one of that design): a plot panel owns a
 * **stack of plot areas**, starting with one; "add plot area" appends
 * another. Each plot area is a uPlot canvas plus a **side signal
 * panel** listing the area's signals — colour swatch, name, present
 * value — and the controls to remove a signal or move it to another
 * area. Picking a signal from the toolbar drops it into the *focused*
 * area (click an area's body to focus it).
 *
 * Data path: the host's `sample_signal` command walks the trace store
 * for each signal and returns a `(t, v)` series; {@link mergeSeries}
 * stitches an area's series onto one time axis for uPlot. uPlot itself
 * provides drag-zoom on the time axis; "follow live" re-fits the
 * x-range to the capture's edge on every `trace-grew` tick (via
 * {@link useTraceData}'s `count`). Axis times are relative to the
 * capture's first frame (`baseTimestampSeconds`).
 *
 * The plot-area list, the signal→area assignment, and "follow live"
 * are mirrored into the dockview panel's `params` so they round-trip
 * through the project file / the localStorage layout.
 *
 * Not yet (later Phase-4 steps): cursors + measurement strip (off by
 * default, toolbar-toggled), synced x-zoom across areas, event markers,
 * per-trace y controls.
 */

const TRACE_COLORS = [
  "#c6f24e",
  "#4ecbff",
  "#ffaa3d",
  "#b48cff",
  "#ff7e5a",
  "#ffd93d",
  "#5ddb7c",
  "#e15dcf",
];

interface SignalRef {
  messageId: number;
  extended: boolean;
  signalName: string;
  messageName: string;
  unit: string;
}

interface PlotAreaConfig {
  id: string;
  signals: SignalRef[];
}

interface PlotPanelParams {
  areas?: unknown;
  followLive?: unknown;
}

function signalRefKey(s: SignalRef): string {
  return signalKey(s.messageId, s.extended, s.signalName);
}

function isSignalRef(v: unknown): v is SignalRef {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.messageId === "number" &&
    typeof o.extended === "boolean" &&
    typeof o.signalName === "string" &&
    typeof o.messageName === "string" &&
    typeof o.unit === "string"
  );
}

function areasFromParams(raw: unknown): PlotAreaConfig[] {
  if (Array.isArray(raw)) {
    const out: PlotAreaConfig[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const o = a as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : crypto.randomUUID();
      const signals = Array.isArray(o.signals) ? o.signals.filter(isSignalRef) : [];
      out.push({ id, signals });
    }
    if (out.length > 0) return out;
  }
  return [{ id: crypto.randomUUID(), signals: [] }];
}

export function PlotPanel(props: IDockviewPanelProps) {
  const { count, baseTimestampSeconds } = useTraceData();
  const { dbcPath } = useProjectContext();

  const params = props.params as PlotPanelParams | undefined;

  const [areas, setAreas] = useState<PlotAreaConfig[]>(() => areasFromParams(params?.areas));
  const [followLive, setFollowLive] = useState(() =>
    typeof params?.followLive === "boolean" ? params.followLive : true,
  );
  const [focusedAreaId, setFocusedAreaId] = useState<string>(() => areas[0]?.id ?? "");
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);

  // Keep a valid focused area even after the focused one is removed.
  useEffect(() => {
    if (!areas.some((a) => a.id === focusedAreaId)) {
      setFocusedAreaId(areas[0]?.id ?? "");
    }
  }, [areas, focusedAreaId]);

  // Mirror persistable state into dockview params (→ project file / layout).
  const { api } = props;
  useEffect(() => {
    api.updateParameters({ areas, followLive });
  }, [api, areas, followLive]);

  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals").then(setCatalog);
  }, []);
  // Re-fetch when the panel mounts and whenever the attached DBC changes.
  useEffect(refreshCatalog, [refreshCatalog, dbcPath]);

  const base = baseTimestampSeconds ?? 0;

  const addArea = useCallback(() => {
    setAreas((prev) => {
      const next = { id: crypto.randomUUID(), signals: [] };
      setFocusedAreaId(next.id);
      return [...prev, next];
    });
  }, []);

  const removeArea = useCallback((id: string) => {
    setAreas((prev) => (prev.length <= 1 ? prev : prev.filter((a) => a.id !== id)));
  }, []);

  const addSignalToFocused = useCallback(
    (desc: SignalDescriptorRecord) => {
      setAreas((prev) => {
        const targetId = prev.some((a) => a.id === focusedAreaId) ? focusedAreaId : prev[0]?.id;
        const ref: SignalRef = {
          messageId: desc.message_id,
          extended: desc.extended,
          signalName: desc.signal_name,
          messageName: desc.message_name,
          unit: desc.unit,
        };
        const key = signalRefKey(ref);
        // If it's already plotted somewhere, do nothing.
        if (prev.some((a) => a.signals.some((s) => signalRefKey(s) === key))) return prev;
        return prev.map((a) => (a.id === targetId ? { ...a, signals: [...a.signals, ref] } : a));
      });
    },
    [focusedAreaId],
  );

  const removeSignal = useCallback((areaId: string, key: string) => {
    setAreas((prev) =>
      prev.map((a) =>
        a.id === areaId ? { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) } : a,
      ),
    );
  }, []);

  const moveSignal = useCallback((fromAreaId: string, toAreaId: string, key: string) => {
    if (fromAreaId === toAreaId) return;
    setAreas((prev) => {
      const moved = prev
        .find((a) => a.id === fromAreaId)
        ?.signals.find((s) => signalRefKey(s) === key);
      if (!moved) return prev;
      return prev.map((a) => {
        if (a.id === fromAreaId) {
          return { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) };
        }
        if (a.id === toAreaId) {
          return a.signals.some((s) => signalRefKey(s) === key)
            ? a
            : { ...a, signals: [...a.signals, moved] };
        }
        return a;
      });
    });
  }, []);

  const catalogOptions = useMemo(
    () =>
      catalog.map((s) => ({
        key: signalKey(s.message_id, s.extended, s.signal_name),
        label: `${s.message_name}.${s.signal_name}${s.unit ? ` [${s.unit}]` : ""}`,
        desc: s,
      })),
    [catalog],
  );

  const areaLabels = useMemo(
    () => new Map(areas.map((a, i) => [a.id, `Area ${i + 1}`])),
    [areas],
  );

  return (
    <div className="plot-panel">
      <div className="plot-panel-toolbar">
        <select
          value=""
          onChange={(e) => {
            const opt = catalogOptions.find((o) => o.key === e.target.value);
            if (opt) addSignalToFocused(opt.desc);
            e.currentTarget.selectedIndex = 0;
          }}
          aria-label="add signal to focused plot area"
        >
          <option value="">
            {catalog.length === 0 ? "no DBC attached" : "add signal…"}
          </option>
          {catalogOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button onClick={refreshCatalog} title="reload signal list from the attached DBC">
          ↻
        </button>
        <button onClick={addArea}>add plot area</button>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={followLive}
            onChange={(e) => setFollowLive(e.target.checked)}
          />
          follow live
        </label>
      </div>
      <div className="plot-panel-areas">
        {areas.map((area) => (
          <PlotArea
            key={area.id}
            area={area}
            label={areaLabels.get(area.id) ?? "Area"}
            otherAreas={areas
              .filter((a) => a.id !== area.id)
              .map((a) => ({ id: a.id, label: areaLabels.get(a.id) ?? "Area" }))}
            focused={area.id === focusedAreaId}
            removable={areas.length > 1}
            base={base}
            count={count}
            followLive={followLive}
            onFocus={() => setFocusedAreaId(area.id)}
            onRemoveArea={() => removeArea(area.id)}
            onRemoveSignal={(key) => removeSignal(area.id, key)}
            onMoveSignal={(key, toId) => moveSignal(area.id, toId, key)}
          />
        ))}
      </div>
    </div>
  );
}

interface PlotAreaProps {
  area: PlotAreaConfig;
  label: string;
  otherAreas: Array<{ id: string; label: string }>;
  focused: boolean;
  removable: boolean;
  base: number;
  count: number;
  followLive: boolean;
  onFocus: () => void;
  onRemoveArea: () => void;
  onRemoveSignal: (key: string) => void;
  onMoveSignal: (key: string, toAreaId: string) => void;
}

function PlotArea({
  area,
  label,
  otherAreas,
  focused,
  removable,
  base,
  count,
  followLive,
  onFocus,
  onRemoveArea,
  onRemoveSignal,
  onMoveSignal,
}: PlotAreaProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const programmaticRef = useRef(false);
  // Latest value per signal (last sample), keyed by signalRefKey.
  const [presentValues, setPresentValues] = useState<Map<string, number | null>>(new Map());

  const signals = area.signals;
  const signalSetKey = signals.map(signalRefKey).join("|");

  const colorFor = useCallback((i: number) => TRACE_COLORS[i % TRACE_COLORS.length], []);

  const resample = useCallback(async () => {
    const u = uplotRef.current;
    if (!u) return;
    if (signals.length === 0) {
      programmaticRef.current = true;
      u.setData([[]]);
      programmaticRef.current = false;
      setPresentValues(new Map());
      return;
    }
    const results = await Promise.all(
      signals.map((s) =>
        invoke<SignalSeries>("sample_signal", {
          messageId: s.messageId,
          extended: s.extended,
          signalName: s.signalName,
          startSeconds: 0,
          endSeconds: Number.MAX_SAFE_INTEGER,
        }),
      ),
    );
    if (uplotRef.current !== u) return; // area re-created mid-flight
    const merged = mergeSeries(
      results.map((r) => ({ t: r.t.map((x) => x - base), v: r.v })),
    ) as uPlot.AlignedData;
    programmaticRef.current = true;
    u.setData(merged, followLive);
    programmaticRef.current = false;
    const pv = new Map<string, number | null>();
    signals.forEach((s, i) => {
      const v = results[i].v;
      pv.set(signalRefKey(s), v.length > 0 ? v[v.length - 1] : null);
    });
    setPresentValues(pv);
  }, [signals, base, followLive]);

  const resampleRef = useRef(resample);
  useEffect(() => {
    resampleRef.current = resample;
  });

  // (Re)create the uPlot instance whenever the signal *set* changes.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: Math.max(120, el.clientHeight - 2),
      scales: { x: { time: false } },
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      axes: [{ label: "time (s)" }, {}],
      series: [
        {},
        ...signals.map((s, i) => ({
          label: `${s.messageName}.${s.signalName}`,
          stroke: colorFor(i),
          width: 1,
          points: { show: false },
        })),
      ],
    };
    const u = new uPlot(opts, [[]], el);
    uplotRef.current = u;
    void resampleRef.current();

    const ro = new ResizeObserver(() => {
      u.setSize({
        width: el.clientWidth || 600,
        height: Math.max(120, el.clientHeight - 2),
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      if (uplotRef.current === u) uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalSetKey]);

  // Re-sample on capture growth, when "follow live" toggles, and when
  // the time origin shifts (new source).
  useEffect(() => {
    void resampleRef.current();
  }, [count, followLive, base]);

  return (
    <div
      className={`plot-area${focused ? " focused" : ""}`}
      onMouseDown={onFocus}
    >
      <div className="plot-area-canvas" ref={canvasRef} />
      <div className="plot-area-signals">
        <div className="plot-area-signals-head">
          <span className="plot-area-label">{label}</span>
          {removable && (
            <button
              className="plot-area-remove"
              title="remove this plot area"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveArea();
              }}
            >
              ×
            </button>
          )}
        </div>
        {signals.length === 0 ? (
          <div className="plot-area-empty">
            {focused ? "pick a signal above" : "click here, then pick a signal"}
          </div>
        ) : (
          signals.map((s, i) => {
            const key = signalRefKey(s);
            const v = presentValues.get(key);
            return (
              <div className="plot-signal-row" key={key}>
                <span className="plot-signal-swatch" style={{ background: colorFor(i) }} />
                <span className="plot-signal-name" title={`${s.messageName}.${s.signalName}`}>
                  {s.messageName}.{s.signalName}
                </span>
                <span className="plot-signal-value">
                  {v == null || v === undefined ? "—" : v.toPrecision(6)}
                  {s.unit ? ` ${s.unit}` : ""}
                </span>
                {otherAreas.length > 0 && (
                  <select
                    className="plot-signal-move"
                    value=""
                    title="move this signal to another plot area"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      if (e.target.value) onMoveSignal(key, e.target.value);
                      e.currentTarget.selectedIndex = 0;
                    }}
                  >
                    <option value="">→</option>
                    {otherAreas.map((a) => (
                      <option key={a.id} value={a.id}>
                        → {a.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="plot-signal-remove"
                  title="remove this signal"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSignal(key);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
