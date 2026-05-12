import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { SignalDescriptorRecord, SignalSeries } from "./types";
import { useTraceData } from "./traceData";
import { mergeSeries, signalKey } from "./plotData";

/**
 * A signal-plotting panel inside the dockview layout, in the spirit of
 * vSignalyzer / CANape: pick decoded `(message, signal)` pairs and watch
 * them over time on a shared axis.
 *
 * Data path: the host's `sample_signal` command walks the trace store
 * for each picked signal and returns a `(t, v)` series; {@link mergeSeries}
 * stitches them onto one time axis for uPlot. uPlot itself provides the
 * pan / zoom and the readout cursor; "follow live" re-fits the x-range to
 * the capture's edge on every `trace-grew` tick (via {@link useTraceData}'s
 * `count`), and a user pan / zoom switches it off — the plot analogue of
 * the trace view's auto-scroll.
 *
 * Axis times are shown relative to the capture's first frame
 * (`baseTimestampSeconds`), matching the trace view's time column.
 */
const TRACE_COLORS = [
  "#4ea1ff",
  "#ff9f4e",
  "#5ddb7c",
  "#e15dcf",
  "#e0d24e",
  "#4ee0d2",
  "#d24e5d",
  "#a78bff",
];

export function PlotPanel(_props: IDockviewPanelProps) {
  const { count, baseTimestampSeconds } = useTraceData();

  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);
  const [selected, setSelected] = useState<SignalDescriptorRecord[]>([]);
  const [followLive, setFollowLive] = useState(true);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  // True while *we* are mutating uPlot's data/scales, so the setScale
  // hook can tell our refits apart from a user pan / zoom.
  const programmaticRef = useRef(false);

  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals").then(setCatalog);
  }, []);
  useEffect(refreshCatalog, [refreshCatalog]);

  const selectedKey = selected
    .map((s) => signalKey(s.message_id, s.extended, s.signal_name))
    .join("|");

  const base = baseTimestampSeconds ?? 0;

  const resample = useCallback(async () => {
    const u = uplotRef.current;
    if (!u) return;
    if (selected.length === 0) {
      programmaticRef.current = true;
      u.setData([[]]);
      programmaticRef.current = false;
      return;
    }
    const results = await Promise.all(
      selected.map((s) =>
        invoke<SignalSeries>("sample_signal", {
          messageId: s.message_id,
          extended: s.extended,
          signalName: s.signal_name,
          startSeconds: 0,
          endSeconds: Number.MAX_SAFE_INTEGER,
        }),
      ),
    );
    if (uplotRef.current !== u) return; // panel re-created mid-flight
    const merged = mergeSeries(
      results.map((r) => ({ t: r.t.map((x) => x - base), v: r.v })),
    ) as uPlot.AlignedData;
    programmaticRef.current = true;
    u.setData(merged, followLive);
    programmaticRef.current = false;
  }, [selected, followLive, base]);

  // Keep the latest resample reachable from effects that shouldn't
  // re-run (and re-create the chart) every time it changes identity.
  const resampleRef = useRef(resample);
  useEffect(() => {
    resampleRef.current = resample;
  });

  // (Re)create the uPlot instance whenever the *set* of series changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: Math.max(120, el.clientHeight - 4),
      scales: { x: { time: false } },
      legend: { live: true },
      cursor: { drag: { x: true, y: false } },
      axes: [{ label: "time (s)" }, {}],
      series: [
        {},
        ...selected.map((s, i) => ({
          label: `${s.message_name}.${s.signal_name}${s.unit ? ` [${s.unit}]` : ""}`,
          stroke: TRACE_COLORS[i % TRACE_COLORS.length],
          value: (_u: uPlot, v: number | null) => (v == null ? "—" : v.toPrecision(6)),
        })),
      ],
      hooks: {
        setScale: [
          (_u: uPlot, key: string) => {
            if (key === "x" && !programmaticRef.current) setFollowLive(false);
          },
        ],
      },
    };
    const u = new uPlot(opts, [[]], el);
    uplotRef.current = u;
    void resampleRef.current();

    const ro = new ResizeObserver(() => {
      u.setSize({
        width: el.clientWidth || 600,
        height: Math.max(120, el.clientHeight - 4),
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      if (uplotRef.current === u) uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Re-sample on capture growth and when "follow live" is (re)enabled.
  useEffect(() => {
    void resampleRef.current();
  }, [count, followLive, base]);

  const catalogOptions = useMemo(
    () =>
      catalog.map((s) => ({
        key: signalKey(s.message_id, s.extended, s.signal_name),
        label: `${s.message_name}.${s.signal_name}${s.unit ? ` [${s.unit}]` : ""}`,
        desc: s,
      })),
    [catalog],
  );

  const addSignal = useCallback(
    (key: string) => {
      const found = catalogOptions.find((o) => o.key === key);
      if (!found) return;
      setSelected((prev) =>
        prev.some(
          (s) => signalKey(s.message_id, s.extended, s.signal_name) === key,
        )
          ? prev
          : [...prev, found.desc],
      );
    },
    [catalogOptions],
  );

  const removeSignal = useCallback((key: string) => {
    setSelected((prev) =>
      prev.filter(
        (s) => signalKey(s.message_id, s.extended, s.signal_name) !== key,
      ),
    );
  }, []);

  return (
    <div className="plot-panel">
      <div className="plot-panel-toolbar">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) addSignal(e.target.value);
            e.currentTarget.selectedIndex = 0;
          }}
          aria-label="add signal to plot"
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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={followLive}
            onChange={(e) => setFollowLive(e.target.checked)}
          />
          follow live
        </label>
        <span className="plot-panel-chips">
          {selected.map((s, i) => {
            const key = signalKey(s.message_id, s.extended, s.signal_name);
            return (
              <span
                key={key}
                className="plot-chip"
                style={{ borderColor: TRACE_COLORS[i % TRACE_COLORS.length] }}
              >
                {s.message_name}.{s.signal_name}
                <button onClick={() => removeSignal(key)} aria-label={`remove ${s.signal_name}`}>
                  ×
                </button>
              </span>
            );
          })}
        </span>
      </div>
      <div className="plot-panel-canvas" ref={containerRef} />
    </div>
  );
}
