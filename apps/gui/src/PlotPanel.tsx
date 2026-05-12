import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { SignalDescriptorRecord, SignalSeries } from "./types";
import { useTraceData } from "./traceData";
import { useProjectContext } from "./projectContext";
import { mergeSeries, signalKey } from "./plotData";
import {
  DEFAULT_MEASUREMENTS,
  MEASUREMENT_QUANTITIES,
  type MeasurementKey,
  type Series,
  isMeasurementKey,
  statsOver,
  valueAt,
} from "./plotCursors";

/**
 * The Phase-4 signal-plotting panel — a software oscilloscope for
 * decoded CAN signals, in the spirit of vSignalyzer / CANape. See
 * `plans/phased-implementation.md` Phase 4 and
 * `plans/plot-panel-reference.html` for the target design.
 *
 * A plot panel owns a **stack of plot areas** (starts with one; "add
 * plot area" appends more), all sharing one x (time) axis. Each plot
 * area is a uPlot canvas plus a **side signal panel** listing the area's
 * signals (colour swatch, name, present value / value-at-cursor) and the
 * controls to remove a signal, move it to another area, or set the
 * area's y-range. Picking a `(message, signal)` pair from the toolbar
 * drops it into the *focused* area (click an area's body to focus it).
 *
 * Time axis & data:
 * - the host's `sample_signal` command walks the trace store, decodes
 *   the signal, min/max-decimates it to ~the plot's pixel width, and
 *   returns the `(t, v)` series; {@link mergeSeries} stitches an area's
 *   series onto one timeline for uPlot;
 * - **drag-select** / **⌘/ctrl + wheel** on any area zooms x on every
 *   area (and leaves follow-live); **shift + wheel** y-zooms the hovered
 *   area; **⌘/ctrl + shift + wheel** does both; **reset zoom** refits;
 * - **follow live** re-fits x to the capture's edge each `trace-grew`
 *   tick — narrowed to the **window width** if one is set;
 * - axis times are relative to the capture's first frame.
 *
 * Cursors & measurements are **off by default**, turned on from the
 * panel toolbar (the reference prototype ships them on; cannet doesn't):
 * - cursor mode "X" → left-click places cursor A, right-click cursor B,
 *   drawn through every area; mode "Y" → places this area's H1 / H2;
 *   mode "+ note" → left-click drops an event note at that time;
 * - the **measurement strip** (toggle) shows a configurable set of
 *   quantities — A, B, Δt, 1/Δt, and per-trace value@A / value@B / Δ /
 *   min / max / mean over [A, B];
 * - **event markers** (the capture-start "T0" plus user notes) draw as
 *   vertical lines across the areas.
 *
 * All of the above except the transient cursor *positions* are mirrored
 * into the dockview panel's `params`, so they round-trip through the
 * project file / layout. (Cursor positions are kept too but cleared when
 * the capture resets, since they wouldn't mean anything against a
 * different capture.)
 *
 * Not built yet (tracked in `plans/backlog.md`): per-trace y offset /
 * gain and log scale; enum / state signals (needs DBC value-tables);
 * triggers; CSV / image export.
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
const CURSOR_A_COLOR = "#ffd93d";
const CURSOR_B_COLOR = "#ff5577";
const EVENT_COLOR = "#4ecbff";
const ZOOM_STEP = 1.15;
/** Lower bound for `sample_signal`'s decimation pixel hint, so a
 * not-yet-laid-out canvas still asks for a sane number of points. */
const MIN_DECIMATION_POINTS = 200;

type CursorMode = "off" | "x" | "y" | "note";

interface SignalRef {
  messageId: number;
  extended: boolean;
  signalName: string;
  messageName: string;
  unit: string;
}

type YMode = "auto" | { min: number; max: number };

interface PlotAreaConfig {
  id: string;
  signals: SignalRef[];
  yMode: YMode;
}

interface NoteEvent {
  id: string;
  /** Time in display-relative seconds. */
  t: number;
  label: string;
}

interface XCursors {
  a: number | null;
  b: number | null;
}

interface PlotPanelParams {
  areas?: unknown;
  followLive?: unknown;
  cursorMode?: unknown;
  measEnabled?: unknown;
  measKeys?: unknown;
  windowSeconds?: unknown;
  cursorX?: unknown;
  cursorYByArea?: unknown;
  notes?: unknown;
}

interface XSync {
  suppress: boolean;
  range: { min: number; max: number } | null;
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

function yModeFromRaw(raw: unknown): YMode {
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    if (typeof o.min === "number" && typeof o.max === "number" && o.min < o.max) {
      return { min: o.min, max: o.max };
    }
  }
  return "auto";
}

function areasFromParams(raw: unknown): PlotAreaConfig[] {
  if (Array.isArray(raw)) {
    const out: PlotAreaConfig[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const o = a as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : crypto.randomUUID();
      const signals = Array.isArray(o.signals) ? o.signals.filter(isSignalRef) : [];
      out.push({ id, signals, yMode: yModeFromRaw(o.yMode) });
    }
    if (out.length > 0) return out;
  }
  return [{ id: crypto.randomUUID(), signals: [], yMode: "auto" }];
}

function cursorModeFromRaw(raw: unknown): CursorMode {
  return raw === "x" || raw === "y" || raw === "note" ? raw : "off";
}

function measKeysFromRaw(raw: unknown): MeasurementKey[] {
  if (Array.isArray(raw)) {
    const ks = raw.filter(isMeasurementKey);
    if (ks.length > 0) return ks;
  }
  return [...DEFAULT_MEASUREMENTS];
}

function notesFromRaw(raw: unknown): NoteEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: NoteEvent[] = [];
  for (const n of raw) {
    if (typeof n !== "object" || n === null) continue;
    const o = n as Record<string, unknown>;
    if (typeof o.t === "number" && typeof o.label === "string") {
      out.push({ id: typeof o.id === "string" ? o.id : crypto.randomUUID(), t: o.t, label: o.label });
    }
  }
  return out;
}

function fmtTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (Math.abs(s) >= 1) return `${s.toFixed(4)} s`;
  if (Math.abs(s) >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`;
  if (Math.abs(s) >= 1e-6) return `${(s * 1e6).toFixed(2)} µs`;
  return `${(s * 1e9).toFixed(0)} ns`;
}
function fmtFreq(hz: number | null | undefined): string {
  if (hz == null || !Number.isFinite(hz)) return "—";
  if (Math.abs(hz) >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (Math.abs(hz) >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(2)} Hz`;
}
function fmtVal(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toPrecision(6);
}

export function PlotPanel(props: IDockviewPanelProps) {
  const { count, baseTimestampSeconds } = useTraceData();
  const { dbcPath } = useProjectContext();

  const params = props.params as PlotPanelParams | undefined;

  const [areas, setAreas] = useState<PlotAreaConfig[]>(() => areasFromParams(params?.areas));
  const [followLive, setFollowLive] = useState(() =>
    typeof params?.followLive === "boolean" ? params.followLive : true,
  );
  const [windowSeconds, setWindowSeconds] = useState<number | null>(() =>
    typeof params?.windowSeconds === "number" && params.windowSeconds > 0
      ? params.windowSeconds
      : null,
  );
  const [cursorMode, setCursorMode] = useState<CursorMode>(() => cursorModeFromRaw(params?.cursorMode));
  const [measEnabled, setMeasEnabled] = useState(() =>
    typeof params?.measEnabled === "boolean" ? params.measEnabled : false,
  );
  const [measKeys, setMeasKeys] = useState<MeasurementKey[]>(() => measKeysFromRaw(params?.measKeys));
  const [focusedAreaId, setFocusedAreaId] = useState<string>(() => areas[0]?.id ?? "");
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);

  // Cursors. X is global; Y is per area. Kept in display-relative seconds.
  const [cursorX, setCursorX] = useState<XCursors>(() => {
    const o = params?.cursorX as { a?: unknown; b?: unknown } | undefined;
    return {
      a: typeof o?.a === "number" ? o.a : null,
      b: typeof o?.b === "number" ? o.b : null,
    };
  });
  const [cursorYByArea, setCursorYByArea] = useState<Record<string, { h1: number | null; h2: number | null }>>(
    () => {
      const o = params?.cursorYByArea;
      const out: Record<string, { h1: number | null; h2: number | null }> = {};
      if (typeof o === "object" && o !== null) {
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (typeof v === "object" && v !== null) {
            const vv = v as Record<string, unknown>;
            out[k] = {
              h1: typeof vv.h1 === "number" ? vv.h1 : null,
              h2: typeof vv.h2 === "number" ? vv.h2 : null,
            };
          }
        }
      }
      return out;
    },
  );
  const [notes, setNotes] = useState<NoteEvent[]>(() => notesFromRaw(params?.notes));

  // Per-area last-sampled series (for the measurement strip) and perf.
  const [seriesByArea, setSeriesByArea] = useState<Map<string, Map<string, Series>>>(new Map());
  const [perfMs, setPerfMs] = useState(0);
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;

  // x-axis sync plumbing + the live registry of each area's uPlot.
  const xSyncRef = useRef<XSync>({ suppress: false, range: null });
  const instancesRef = useRef<Map<string, uPlot>>(new Map());

  const registerInstance = useCallback((id: string, u: uPlot | null) => {
    if (u) instancesRef.current.set(id, u);
    else instancesRef.current.delete(id);
  }, []);

  const applyXToOthers = useCallback((min: number, max: number, exceptId: string) => {
    const sync = xSyncRef.current;
    const wasSuppressed = sync.suppress;
    sync.suppress = true;
    for (const [id, u] of instancesRef.current) {
      if (id === exceptId) continue;
      const xs = u.scales.x;
      if (xs.min === min && xs.max === max) continue;
      u.setScale("x", { min, max });
    }
    sync.suppress = wasSuppressed;
  }, []);

  const onUserXChange = useCallback(
    (min: number, max: number, fromId: string) => {
      xSyncRef.current.range = { min, max };
      applyXToOthers(min, max, fromId);
      setFollowLive(false);
    },
    [applyXToOthers],
  );

  const resetZoom = useCallback(() => {
    const sync = xSyncRef.current;
    sync.range = null;
    sync.suppress = true;
    for (const u of instancesRef.current.values()) u.setData(u.data, true);
    sync.suppress = false;
  }, []);

  // Keep a valid focused area even after the focused one is removed.
  useEffect(() => {
    if (!areas.some((a) => a.id === focusedAreaId)) setFocusedAreaId(areas[0]?.id ?? "");
  }, [areas, focusedAreaId]);

  // Mirror persistable state into dockview params (→ project file / layout).
  const { api } = props;
  useEffect(() => {
    api.updateParameters({
      areas,
      followLive,
      windowSeconds,
      cursorMode,
      measEnabled,
      measKeys,
      cursorX,
      cursorYByArea,
      notes,
    });
  }, [api, areas, followLive, windowSeconds, cursorMode, measEnabled, measKeys, cursorX, cursorYByArea, notes]);

  // Clear cursors / notes when the capture resets (count goes >0 → 0):
  // they wouldn't mean anything against a fresh / different capture.
  const prevCountRef = useRef(count);
  useEffect(() => {
    if (prevCountRef.current > 0 && count === 0) {
      setCursorX({ a: null, b: null });
      setCursorYByArea({});
      setNotes([]);
    }
    prevCountRef.current = count;
  }, [count]);

  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals").then(setCatalog);
  }, []);
  useEffect(refreshCatalog, [refreshCatalog, dbcPath]);

  const base = baseTimestampSeconds ?? 0;

  const addArea = useCallback(() => {
    setAreas((prev) => {
      const next: PlotAreaConfig = { id: crypto.randomUUID(), signals: [], yMode: "auto" };
      setFocusedAreaId(next.id);
      return [...prev, next];
    });
  }, []);

  const removeArea = useCallback((id: string) => {
    setAreas((prev) => (prev.length <= 1 ? prev : prev.filter((a) => a.id !== id)));
    setCursorYByArea((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    setSeriesByArea((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const setAreaYMode = useCallback((id: string, yMode: YMode) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, yMode } : a)));
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
      const moved = prev.find((a) => a.id === fromAreaId)?.signals.find((s) => signalRefKey(s) === key);
      if (!moved) return prev;
      return prev.map((a) => {
        if (a.id === fromAreaId) return { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) };
        if (a.id === toAreaId) {
          return a.signals.some((s) => signalRefKey(s) === key) ? a : { ...a, signals: [...a.signals, moved] };
        }
        return a;
      });
    });
  }, []);

  // Cursor placement callbacks (called from inside a PlotArea).
  const placeCursorX = useCallback((which: "a" | "b", t: number) => {
    setCursorX((prev) => ({ ...prev, [which]: t }));
  }, []);
  const placeCursorY = useCallback((areaId: string, which: "h1" | "h2", v: number) => {
    setCursorYByArea((prev) => ({
      ...prev,
      [areaId]: { h1: prev[areaId]?.h1 ?? null, h2: prev[areaId]?.h2 ?? null, [which]: v },
    }));
  }, []);
  const addNote = useCallback((t: number) => {
    setNotes((prev) => [...prev, { id: crypto.randomUUID(), t, label: `note ${prev.length + 1}` }]);
  }, []);
  const removeNote = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const reportSeries = useCallback((areaId: string, series: Map<string, Series>) => {
    setSeriesByArea((prev) => {
      const next = new Map(prev);
      next.set(areaId, series);
      return next;
    });
  }, []);
  const reportPerf = useCallback((_areaId: string, ms: number) => {
    setPerfMs((prev) => Math.max(prev * 0.6, ms)); // light decay so it tracks the worst recent
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
  const areaLabels = useMemo(() => new Map(areas.map((a, i) => [a.id, `Area ${i + 1}`])), [areas]);

  // Flatten all plotted signals (across areas), preserving area order
  // then in-area order, with a colour matching what its area draws.
  const plottedSignals = useMemo(() => {
    const out: Array<{ key: string; ref: SignalRef; color: string; areaId: string }> = [];
    for (const a of areas) {
      a.signals.forEach((s, i) => {
        out.push({ key: signalRefKey(s), ref: s, color: TRACE_COLORS[i % TRACE_COLORS.length], areaId: a.id });
      });
    }
    return out;
  }, [areas]);

  const seriesFor = useCallback(
    (areaId: string, key: string): Series | undefined => seriesByArea.get(areaId)?.get(key),
    [seriesByArea],
  );

  // Events drawn across the areas: an implicit capture-start "T0" plus
  // the user notes. Memoised so PlotArea's overlay ref changes minimally.
  const events = useMemo(
    () => [{ id: "__t0", t: 0, label: "T0" }, ...notes],
    [notes],
  );

  const dt =
    cursorX.a != null && cursorX.b != null ? cursorX.b - cursorX.a : null;

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
          <option value="">{catalog.length === 0 ? "no DBC attached" : "add signal…"}</option>
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
        <button onClick={resetZoom}>reset zoom</button>
        <span className="plot-toolbar-sep" />
        <label className="checkbox">
          <input type="checkbox" checked={followLive} onChange={(e) => setFollowLive(e.target.checked)} />
          follow live
        </label>
        <label className="plot-window-ctl">
          window
          <input
            type="number"
            min="0"
            step="0.1"
            value={windowSeconds ?? ""}
            placeholder="full"
            title="visible time window when following live (seconds); blank = full capture"
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setWindowSeconds(Number.isFinite(v) && v > 0 ? v : null);
            }}
          />
          s
        </label>
        <button onClick={() => setFollowLive(true)} title="jump to the live edge and follow">
          snap to now
        </button>
        <span className="plot-toolbar-sep" />
        <label className="plot-cursor-ctl">
          cursors
          <select value={cursorMode} onChange={(e) => setCursorMode(e.target.value as CursorMode)}>
            <option value="off">off</option>
            <option value="x">X (A / B)</option>
            <option value="y">Y (H1 / H2)</option>
            <option value="note">+ note</option>
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={measEnabled} onChange={(e) => setMeasEnabled(e.target.checked)} />
          measurements
        </label>
        {measEnabled && (
          <MeasurementMenu measKeys={measKeys} onChange={setMeasKeys} />
        )}
        <span className="plot-perf" title="worst recent plot-area resample time · device pixel ratio">
          {perfMs > 0 ? `${perfMs.toFixed(1)} ms` : "—"} · dpr {dpr.toFixed(2)}
        </span>
      </div>

      <div className="plot-panel-areas">
        {areas.map((area, idx) => (
          <PlotArea
            key={area.id}
            area={area}
            label={areaLabels.get(area.id) ?? "Area"}
            isFirst={idx === 0}
            isLast={idx === areas.length - 1}
            otherAreas={areas
              .filter((a) => a.id !== area.id)
              .map((a) => ({ id: a.id, label: areaLabels.get(a.id) ?? "Area" }))}
            focused={area.id === focusedAreaId}
            removable={areas.length > 1}
            base={base}
            count={count}
            followLive={followLive}
            windowSeconds={windowSeconds}
            cursorMode={cursorMode}
            cursorXa={cursorX.a}
            cursorXb={cursorX.b}
            cursorYh1={cursorYByArea[area.id]?.h1 ?? null}
            cursorYh2={cursorYByArea[area.id]?.h2 ?? null}
            events={events}
            xSyncRef={xSyncRef}
            registerInstance={registerInstance}
            onUserXChange={onUserXChange}
            onPlaceCursorX={placeCursorX}
            onPlaceCursorY={(which, v) => placeCursorY(area.id, which, v)}
            onAddNote={addNote}
            onReportSeries={reportSeries}
            onReportPerf={reportPerf}
            onSetYMode={(m) => setAreaYMode(area.id, m)}
            onFocus={() => setFocusedAreaId(area.id)}
            onRemoveArea={() => removeArea(area.id)}
            onRemoveSignal={(key) => removeSignal(area.id, key)}
            onMoveSignal={(key, toId) => moveSignal(area.id, toId, key)}
            cursorValueFor={(key) =>
              cursorX.a != null ? valueAt(seriesFor(area.id, key) ?? { t: [], v: [] }, cursorX.a) : null
            }
          />
        ))}
      </div>

      {measEnabled && (
        <div className="plot-meas-strip">
          {measKeys.includes("a") && <MeasCell k="A (t)" v={fmtTime(cursorX.a)} cls="gold" />}
          {measKeys.includes("b") && <MeasCell k="B (t)" v={fmtTime(cursorX.b)} cls="pink" />}
          {measKeys.includes("dt") && <MeasCell k="Δt" v={fmtTime(dt)} />}
          {measKeys.includes("freq") && <MeasCell k="1/Δt" v={dt ? fmtFreq(1 / dt) : "—"} />}
          {plottedSignals.map(({ key, ref, color, areaId }) => {
            const s = seriesFor(areaId, key) ?? { t: [], v: [] };
            const va = cursorX.a != null ? valueAt(s, cursorX.a) : null;
            const vb = cursorX.b != null ? valueAt(s, cursorX.b) : null;
            const span = cursorX.a != null && cursorX.b != null ? statsOver(s, cursorX.a, cursorX.b) : null;
            const name = `${ref.messageName}.${ref.signalName}`;
            return (
              <span key={key} style={{ display: "contents" }}>
                {measKeys.includes("valA") && (
                  <MeasCell k={`${name} @A`} v={fmtVal(va)} swatch={color} />
                )}
                {measKeys.includes("valB") && (
                  <MeasCell k={`${name} @B`} v={fmtVal(vb)} swatch={color} />
                )}
                {measKeys.includes("delta") && (
                  <MeasCell k={`${name} Δ`} v={va != null && vb != null ? fmtVal(vb - va) : "—"} swatch={color} />
                )}
                {measKeys.includes("min") && <MeasCell k={`${name} min`} v={fmtVal(span?.min ?? null)} swatch={color} />}
                {measKeys.includes("max") && <MeasCell k={`${name} max`} v={fmtVal(span?.max ?? null)} swatch={color} />}
                {measKeys.includes("mean") && <MeasCell k={`${name} mean`} v={fmtVal(span?.mean ?? null)} swatch={color} />}
              </span>
            );
          })}
        </div>
      )}

      {notes.length > 0 && (
        <div className="plot-events-log">
          {notes
            .slice()
            .sort((a, b) => a.t - b.t)
            .map((n) => (
              <div className="plot-event-row" key={n.id}>
                <span className="plot-event-t">{fmtTime(n.t)}</span>
                <span className="plot-event-label">{n.label}</span>
                <button onClick={() => removeNote(n.id)} title="remove note">
                  ×
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function MeasCell({ k, v, cls, swatch }: { k: string; v: string; cls?: string; swatch?: string }) {
  return (
    <div className="plot-meas-cell">
      <div className="plot-meas-k">
        {swatch && <span className="plot-signal-swatch" style={{ background: swatch }} />}
        {k}
      </div>
      <div className={`plot-meas-v${cls ? ` ${cls}` : ""}`}>{v}</div>
    </div>
  );
}

function MeasurementMenu({
  measKeys,
  onChange,
}: {
  measKeys: MeasurementKey[];
  onChange: (k: MeasurementKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const toggle = (k: MeasurementKey) =>
    onChange(measKeys.includes(k) ? measKeys.filter((x) => x !== k) : [...measKeys, k]);
  return (
    <div className="plot-meas-menu" ref={wrapRef}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        measurements ▾
      </button>
      {open && (
        <div className="plot-meas-menu-pop" role="menu">
          {MEASUREMENT_QUANTITIES.map((q) => (
            <label key={q.key} className="checkbox">
              <input type="checkbox" checked={measKeys.includes(q.key)} onChange={() => toggle(q.key)} />
              {q.label}
              {q.perTrace ? " (per trace)" : ""}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface PlotAreaProps {
  area: PlotAreaConfig;
  label: string;
  isFirst: boolean;
  isLast: boolean;
  otherAreas: Array<{ id: string; label: string }>;
  focused: boolean;
  removable: boolean;
  base: number;
  count: number;
  followLive: boolean;
  windowSeconds: number | null;
  cursorMode: CursorMode;
  cursorXa: number | null;
  cursorXb: number | null;
  cursorYh1: number | null;
  cursorYh2: number | null;
  events: Array<{ id: string; t: number; label: string }>;
  xSyncRef: React.MutableRefObject<XSync>;
  registerInstance: (id: string, u: uPlot | null) => void;
  onUserXChange: (min: number, max: number, fromId: string) => void;
  onPlaceCursorX: (which: "a" | "b", t: number) => void;
  onPlaceCursorY: (which: "h1" | "h2", v: number) => void;
  onAddNote: (t: number) => void;
  onReportSeries: (areaId: string, series: Map<string, Series>) => void;
  onReportPerf: (areaId: string, ms: number) => void;
  onSetYMode: (m: YMode) => void;
  onFocus: () => void;
  onRemoveArea: () => void;
  onRemoveSignal: (key: string) => void;
  onMoveSignal: (key: string, toAreaId: string) => void;
  cursorValueFor: (key: string) => number | null;
}

function PlotArea(p: PlotAreaProps) {
  const {
    area,
    label,
    isFirst,
    isLast,
    otherAreas,
    focused,
    removable,
    base,
    count,
    followLive,
    windowSeconds,
    cursorMode,
    cursorXa,
    cursorXb,
    cursorYh1,
    cursorYh2,
    events,
    xSyncRef,
    registerInstance,
    onUserXChange,
    onPlaceCursorX,
    onPlaceCursorY,
    onAddNote,
    onReportSeries,
    onReportPerf,
    onSetYMode,
    onFocus,
    onRemoveArea,
    onRemoveSignal,
    onMoveSignal,
    cursorValueFor,
  } = p;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const [presentValues, setPresentValues] = useState<Map<string, number | null>>(new Map());
  const [yEditOpen, setYEditOpen] = useState(false);

  const areaId = area.id;
  const signals = area.signals;
  const signalSetKey = signals.map(signalRefKey).join("|");
  const yMode = area.yMode;
  const colorFor = useCallback((i: number) => TRACE_COLORS[i % TRACE_COLORS.length], []);

  const withSuppressed = useCallback(
    (fn: () => void) => {
      const sync = xSyncRef.current;
      const prev = sync.suppress;
      sync.suppress = true;
      try {
        fn();
      } finally {
        sync.suppress = prev;
      }
    },
    [xSyncRef],
  );

  // Latest values the uPlot hooks need (they capture once at create time).
  const liveRef = useRef({
    followLive,
    windowSeconds,
    yMode,
    cursorMode,
    cursorXa,
    cursorXb,
    cursorYh1,
    cursorYh2,
    events,
    onUserXChange,
    onPlaceCursorX,
    onPlaceCursorY,
    onAddNote,
  });
  useEffect(() => {
    liveRef.current = {
      followLive,
      windowSeconds,
      yMode,
      cursorMode,
      cursorXa,
      cursorXb,
      cursorYh1,
      cursorYh2,
      events,
      onUserXChange,
      onPlaceCursorX,
      onPlaceCursorY,
      onAddNote,
    };
  });

  const decimationHint = useCallback(
    () => Math.max(MIN_DECIMATION_POINTS, Math.round(canvasRef.current?.clientWidth ?? 0)),
    [],
  );

  const resample = useCallback(async () => {
    const u = uplotRef.current;
    if (!u) return;
    const t0 = performance.now();
    if (signals.length === 0) {
      withSuppressed(() => u.setData([[]]));
      setPresentValues(new Map());
      onReportSeries(areaId, new Map());
      return;
    }
    const maxPoints = decimationHint();
    const results = await Promise.all(
      signals.map((s) =>
        invoke<SignalSeries>("sample_signal", {
          messageId: s.messageId,
          extended: s.extended,
          signalName: s.signalName,
          startSeconds: 0,
          endSeconds: Number.MAX_SAFE_INTEGER,
          maxPoints,
        }),
      ),
    );
    if (uplotRef.current !== u) return; // area re-created mid-flight
    const seriesRel: Series[] = results.map((r) => ({ t: r.t.map((x) => x - base), v: r.v }));
    const merged = mergeSeries(seriesRel) as uPlot.AlignedData;
    const live = liveRef.current;

    withSuppressed(() => {
      if (live.followLive) {
        u.setData(merged, true);
        const captureEnd = results.find((r) => r.capture_end_seconds != null)?.capture_end_seconds;
        if (captureEnd != null) {
          const max = captureEnd - base;
          const min = live.windowSeconds != null ? Math.max(0, max - live.windowSeconds) : 0;
          u.setScale("x", { min, max });
        }
      } else {
        const range = xSyncRef.current.range;
        if (range) {
          u.setData(merged, false);
          u.setScale("x", { min: range.min, max: range.max });
        } else {
          u.setData(merged, true);
        }
      }
      if (live.yMode !== "auto") u.setScale("y", { min: live.yMode.min, max: live.yMode.max });
    });

    const pv = new Map<string, number | null>();
    const seriesMap = new Map<string, Series>();
    signals.forEach((s, i) => {
      const key = signalRefKey(s);
      const ser = seriesRel[i];
      pv.set(key, ser.v.length > 0 ? ser.v[ser.v.length - 1] : null);
      seriesMap.set(key, ser);
    });
    setPresentValues(pv);
    onReportSeries(areaId, seriesMap);
    onReportPerf(areaId, performance.now() - t0);
  }, [signals, base, areaId, withSuppressed, xSyncRef, decimationHint, onReportSeries, onReportPerf]);

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
      hooks: {
        setScale: [
          (u: uPlot, key: string) => {
            if (key !== "x") return;
            if (xSyncRef.current.suppress) return;
            const { min, max } = u.scales.x;
            if (min == null || max == null) return;
            liveRef.current.onUserXChange(min, max, areaId);
          },
        ],
        draw: [
          (u: uPlot) => {
            const live = liveRef.current;
            const ctx = u.ctx;
            const ratio = u.ctx.canvas.width / u.width || 1;
            const { left, top, width, height } = u.bbox;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            ctx.font = `600 ${9.5 * ratio}px ui-monospace, monospace`;
            ctx.lineWidth = 1 * ratio;

            const vline = (xVal: number, color: string, dash: number[], label: string | null, atTop: boolean) => {
              const xp = u.valToPos(xVal, "x", true);
              if (xp < left - 4 || xp > left + width + 4) return;
              ctx.strokeStyle = color;
              ctx.setLineDash(dash.map((d) => d * ratio));
              ctx.beginPath();
              ctx.moveTo(xp, top);
              ctx.lineTo(xp, top + height);
              ctx.stroke();
              ctx.setLineDash([]);
              if (label != null) {
                const tw = ctx.measureText(label).width;
                const padX = 4 * ratio;
                const h = 13 * ratio;
                const ty = atTop ? top + 2 * ratio : top + height - h - 2 * ratio;
                ctx.fillStyle = "#0a0d0f";
                ctx.fillRect(xp - tw / 2 - padX, ty, tw + padX * 2, h);
                ctx.strokeStyle = color;
                ctx.strokeRect(xp - tw / 2 - padX, ty, tw + padX * 2, h);
                ctx.fillStyle = color;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(label, xp, ty + h / 2);
              }
            };
            // Event markers — label only on the first area.
            for (const ev of live.events) {
              vline(ev.t, EVENT_COLOR, ev.id === "__t0" ? [] : [2, 3], isFirst ? ev.label : null, true);
            }
            // X cursors — label only on the last area.
            if (live.cursorXa != null) vline(live.cursorXa, CURSOR_A_COLOR, [4, 3], isLast ? "A" : null, false);
            if (live.cursorXb != null) vline(live.cursorXb, CURSOR_B_COLOR, [4, 3], isLast ? "B" : null, false);
            // Y cursors — this area only, labelled at the left.
            const hline = (yVal: number, color: string, label: string) => {
              const yp = u.valToPos(yVal, "y", true);
              if (yp < top - 4 || yp > top + height + 4) return;
              ctx.strokeStyle = color;
              ctx.setLineDash([4 * ratio, 3 * ratio]);
              ctx.beginPath();
              ctx.moveTo(left, yp);
              ctx.lineTo(left + width, yp);
              ctx.stroke();
              ctx.setLineDash([]);
              const tw = ctx.measureText(label).width;
              const padX = 4 * ratio;
              const h = 13 * ratio;
              const lx = left + 3 * ratio;
              ctx.fillStyle = "#0a0d0f";
              ctx.fillRect(lx, yp - h / 2, tw + padX * 2, h);
              ctx.strokeStyle = color;
              ctx.strokeRect(lx, yp - h / 2, tw + padX * 2, h);
              ctx.fillStyle = color;
              ctx.textAlign = "left";
              ctx.textBaseline = "middle";
              ctx.fillText(label, lx + padX, yp);
            };
            if (live.cursorYh1 != null) hline(live.cursorYh1, CURSOR_A_COLOR, "H1");
            if (live.cursorYh2 != null) hline(live.cursorYh2, CURSOR_B_COLOR, "H2");
            ctx.restore();
          },
        ],
        ready: [
          (u: uPlot) => {
            const over = u.over;
            over.addEventListener(
              "wheel",
              (e: WheelEvent) => {
                const cmd = e.ctrlKey || e.metaKey;
                const shift = e.shiftKey;
                if (!cmd && !shift) return;
                e.preventDefault();
                const rect = over.getBoundingClientRect();
                const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
                if (cmd) {
                  const xc = u.posToVal(e.clientX - rect.left, "x");
                  const xs = u.scales.x;
                  if (xs.min == null || xs.max == null) return;
                  const min = xc - (xc - xs.min) * factor;
                  const max = xc + (xs.max - xc) * factor;
                  withSuppressed(() => u.setScale("x", { min, max }));
                  liveRef.current.onUserXChange(min, max, areaId);
                }
                if (shift) {
                  const yc = u.posToVal(e.clientY - rect.top, "y");
                  const ys = u.scales.y;
                  if (ys.min == null || ys.max == null) return;
                  u.setScale("y", {
                    min: yc - (yc - ys.min) * factor,
                    max: yc + (ys.max - yc) * factor,
                  });
                }
              },
              { passive: false },
            );
            const valAt = (e: MouseEvent) => {
              const rect = over.getBoundingClientRect();
              return {
                x: u.posToVal(e.clientX - rect.left, "x"),
                y: u.posToVal(e.clientY - rect.top, "y"),
              };
            };
            over.addEventListener("click", (e: MouseEvent) => {
              const live = liveRef.current;
              if (live.cursorMode === "off") return;
              const { x, y } = valAt(e);
              if (live.cursorMode === "x") live.onPlaceCursorX("a", x);
              else if (live.cursorMode === "y") live.onPlaceCursorY("h1", y);
              else if (live.cursorMode === "note") live.onAddNote(x);
            });
            over.addEventListener("contextmenu", (e: MouseEvent) => {
              const live = liveRef.current;
              if (live.cursorMode === "off") return;
              e.preventDefault();
              const { x, y } = valAt(e);
              if (live.cursorMode === "x") live.onPlaceCursorX("b", x);
              else if (live.cursorMode === "y") live.onPlaceCursorY("h2", y);
            });
          },
        ],
      },
    };
    const u = new uPlot(opts, [[]], el);
    uplotRef.current = u;
    registerInstance(areaId, u);
    void resampleRef.current();

    const ro = new ResizeObserver(() => {
      withSuppressed(() =>
        u.setSize({ width: el.clientWidth || 600, height: Math.max(120, el.clientHeight - 2) }),
      );
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      registerInstance(areaId, null);
      u.destroy();
      if (uplotRef.current === u) uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalSetKey, areaId]);

  // Re-sample on capture growth and when the controls that change what's
  // drawn shift (follow-live, window width, time origin, y-range mode).
  useEffect(() => {
    void resampleRef.current();
  }, [count, followLive, windowSeconds, base, yMode]);

  // Redraw the overlay when cursors / events change (no resample needed).
  useEffect(() => {
    uplotRef.current?.redraw(false, false);
  }, [cursorXa, cursorXb, cursorYh1, cursorYh2, events, isFirst, isLast]);

  const yLabel = yMode === "auto" ? "y: auto" : `y: ${yMode.min}…${yMode.max}`;

  return (
    <div className={`plot-area${focused ? " focused" : ""}`} onMouseDown={onFocus}>
      <div className="plot-area-canvas" ref={canvasRef} />
      <div className="plot-area-signals">
        <div className="plot-area-signals-head">
          <span className="plot-area-label">{label}</span>
          <button
            className="plot-area-y"
            title="set this area's y-axis range"
            onClick={(e) => {
              e.stopPropagation();
              setYEditOpen((v) => !v);
            }}
          >
            {yLabel}
          </button>
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
        {yEditOpen && (
          <YRangeEditor
            yMode={yMode}
            onApply={(m) => {
              onSetYMode(m);
              setYEditOpen(false);
            }}
            onCancel={() => setYEditOpen(false)}
          />
        )}
        {signals.length === 0 ? (
          <div className="plot-area-empty">{focused ? "pick a signal above" : "click here, then pick a signal"}</div>
        ) : (
          signals.map((s, i) => {
            const key = signalRefKey(s);
            const cv = cursorValueFor(key);
            const v = cv != null ? cv : presentValues.get(key);
            return (
              <div className="plot-signal-row" key={key}>
                <span className="plot-signal-swatch" style={{ background: colorFor(i) }} />
                <span className="plot-signal-name" title={`${s.messageName}.${s.signalName}`}>
                  {s.messageName}.{s.signalName}
                </span>
                <span className="plot-signal-value" title={cv != null ? "value at cursor A" : "latest value"}>
                  {v == null || v === undefined ? "—" : (v as number).toPrecision(6)}
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

function YRangeEditor({
  yMode,
  onApply,
  onCancel,
}: {
  yMode: YMode;
  onApply: (m: YMode) => void;
  onCancel: () => void;
}) {
  const [min, setMin] = useState(yMode === "auto" ? "" : String(yMode.min));
  const [max, setMax] = useState(yMode === "auto" ? "" : String(yMode.max));
  return (
    <div className="plot-y-editor" onMouseDown={(e) => e.stopPropagation()}>
      <input type="number" step="any" value={min} placeholder="min" onChange={(e) => setMin(e.target.value)} />
      <input type="number" step="any" value={max} placeholder="max" onChange={(e) => setMax(e.target.value)} />
      <button
        onClick={() => {
          const lo = parseFloat(min);
          const hi = parseFloat(max);
          if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) onApply({ min: lo, max: hi });
        }}
      >
        set
      </button>
      <button onClick={() => onApply("auto")}>auto</button>
      <button onClick={onCancel}>×</button>
    </div>
  );
}
