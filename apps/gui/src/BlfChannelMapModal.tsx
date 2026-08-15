import { useMemo, useRef, useState } from "react";

import { Combobox } from "./Combobox";
import type { BlfScanResult, Bus, SkippedDecodedGroup } from "./types";
import { formatElapsed } from "./format";
import { useGridview } from "./useGridview";
import { arrayRowSpace, type GridviewAdapter } from "./gridviewRows";

/// One row's worth of state in the modal: which logical bus the user
/// picked for a given BLF channel. `""` means "skip this channel".
export type ChannelChoice = string;

/// The selected import time range, resolved to absolute nanoseconds —
/// the shape `open_log`'s `start_ns`/`end_ns` args want. `null` on
/// either side means "unbounded on that side" (the default, unedited
/// state): the host applies no `WindowedSource` filter at all rather
/// than one that happens to match the full span.
export interface ImportRange {
  startNs: number | null;
  endNs: number | null;
}

const UNBOUNDED_RANGE: ImportRange = { startNs: null, endNs: null };

/// Elapsed seconds from `originNs`, for the markers list and the range
/// inputs — both read relative to the capture's first frame.
function elapsedSeconds(timestampNs: number, originNs: number): number {
  return (timestampNs - originNs) / 1e9;
}

/// BLF (or MDF — see `format`) channel → bus mapping step. Shown after
/// the user picks a capture file and before frames start flowing. The
/// user maps each distinct channel observed in the file to a project
/// bus (or to "skip"), reads the capture's metadata and markers (one
/// header-only scan feeds all three — ADR 0046), and may narrow the
/// import to a time range.
///
/// Kept deliberately small and self-contained; the parent owns the bus
/// list and resolves the resulting `Map<channel, bus_id | null>` (plus
/// the chosen range) into the wire shape `open_log` / `import_mdf`
/// consumes. `scan`'s shape and the mapping/persistence logic are
/// identical for both formats (`BlfScanResult` and `MdfScanResult`
/// share the same channel-census fields); `format`,
/// `skippedDecodedGroups` and `signalGroupCount` are the only
/// MDF-specific additions, each optional so the BLF path is unaffected.
export function BlfChannelMapModal(props: {
  blfPath: string;
  scan: BlfScanResult;
  buses: readonly Bus[];
  initial?: Record<number, ChannelChoice>;
  onConfirm: (choices: Record<number, ChannelChoice>, range: ImportRange) => void;
  onCancel: () => void;
  /// Display label only — everything else about the flow is
  /// format-agnostic. Defaults to "BLF".
  format?: "BLF" | "MDF";
  /// MDF only: per-message DBC-decoded groups import is skipping
  /// because the file's own frames plus the project DBC already imply
  /// them. Omitted/empty renders nothing.
  skippedDecodedGroups?: SkippedDecodedGroup[];
  /// MDF only: message-independent signal groups found. Not imported
  /// yet (a later phase) — shown so the count isn't silently dropped.
  signalGroupCount?: number;
}) {
  const {
    blfPath,
    scan,
    buses,
    initial,
    onConfirm,
    onCancel,
    format = "BLF",
    skippedDecodedGroups,
    signalGroupCount,
  } = props;
  const { channels, markers } = scan;
  const [choices, setChoices] = useState<Record<number, ChannelChoice>>(() => {
    // Default seed: channel N → project bus at position N. The host
    // writes captures by re-channeling frames in the project's bus
    // order (see CLAUDE.md § File formats), so this matches "open a
    // capture we wrote ourselves" without any manual remap. Channels
    // past the bus list default to "skip" ("") — the user can pick a
    // bus per channel from the dropdown.
    const seeded: Record<number, ChannelChoice> = {};
    for (const ch of channels) {
      seeded[ch] = initial?.[ch] ?? (buses[ch]?.id ?? "");
    }
    return seeded;
  });

  const set = (ch: number, value: ChannelChoice) =>
    setChoices((prev) => ({ ...prev, [ch]: value }));

  const hasSpan = scan.first_timestamp_ns != null && scan.last_timestamp_ns != null;
  const originNs = scan.first_timestamp_ns ?? scan.start_unix_nanos;
  const durationSeconds = hasSpan
    ? elapsedSeconds(scan.last_timestamp_ns as number, originNs)
    : 0;

  // --- import time range ---
  // Kept as display-relative seconds (0..durationSeconds) so the
  // inputs read naturally against the capture's own timeline; resolved
  // to absolute ns only where `open_log` needs it (`range`, below).
  // Unedited (still spanning the whole file) resolves to `{ null, null
  // }` rather than the numeric bounds, so an unfiltered import stays
  // unfiltered instead of routing through `WindowedSource` for nothing.
  const [rangeStartSec, setRangeStartSec] = useState(0);
  const [rangeEndSec, setRangeEndSec] = useState(durationSeconds);
  const setRangeStart = (v: number) => {
    if (!Number.isFinite(v)) return;
    setRangeStartSec(Math.min(Math.max(v, 0), rangeEndSec));
  };
  const setRangeEnd = (v: number) => {
    if (!Number.isFinite(v)) return;
    setRangeEndSec(Math.max(Math.min(v, durationSeconds), rangeStartSec));
  };
  const range: ImportRange = useMemo(() => {
    if (!hasSpan) return UNBOUNDED_RANGE;
    return {
      startNs: rangeStartSec > 0 ? Math.round(originNs + rangeStartSec * 1e9) : null,
      endNs: rangeEndSec < durationSeconds ? Math.round(originNs + rangeEndSec * 1e9) : null,
    };
  }, [hasSpan, originNs, rangeStartSec, rangeEndSec, durationSeconds]);

  // --- markers gridview (ADR 0044): a collapsible flat list, closed by
  // default — markers are supplementary and rare, so the dialog stays
  // uncluttered until asked. Collapsed content is unmounted, matching
  // the panel `CollapsibleSection`s elsewhere in the app.
  const [markersOpen, setMarkersOpen] = useState(false);
  const markerRows = useMemo(
    () => markers.map((m) => ({ id: m.id, kind: "leaf" as const, expandable: false, depth: 0 })),
    [markers],
  );
  const markersListRef = useRef<HTMLDivElement | null>(null);
  const markersAdapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(markerRows, () => false);
    return {
      ...space,
      // The tiles are in the document (no virtualization), so this is
      // the "scroll it just into view" arithmetic, matching
      // TransmitPanel's non-virtualized adapter.
      scrollToRow: (index) => {
        const id = space.rowIdAt(index);
        const container = markersListRef.current;
        if (id == null || container == null) return;
        const el = document.getElementById(rowDomIdRef.current(id));
        if (el == null) return;
        const c = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < c.top) container.scrollTop += r.top - c.top;
        else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
      },
      setExpanded: () => {},
      isSelectable: () => true,
    };
  }, [markerRows]);
  const markersGrid = useGridview({
    adapter: markersAdapter,
    pageRows: 8,
    idPrefix: "blf-map-markers",
  });
  /// Read through a ref by the memoised adapter, so neither the grid's
  /// per-render identity nor its cursor rebuilds the adapter (mirrors
  /// TransmitPanel's `rowDomIdRef`).
  const rowDomIdRef = useRef(markersGrid.rowDomId);
  rowDomIdRef.current = markersGrid.rowDomId;

  return (
    <div className="modal-overlay" role="dialog" aria-labelledby="blf-map-title">
      <div className="modal">
        <h3 id="blf-map-title">Map {format} channels to logical buses</h3>
        <p className="modal-subtitle" title={blfPath}>
          {basename(blfPath)} — {channels.length} channel
          {channels.length === 1 ? "" : "s"}
        </p>
        <p className="blf-map-meta">
          {scan.frame_count.toLocaleString()} frame{scan.frame_count === 1 ? "" : "s"}
          {hasSpan ? ` · ${formatElapsed(durationSeconds, 3)}` : ""}
          {" · started "}
          {new Date(scan.start_unix_nanos / 1e6).toLocaleString()}
        </p>
        {buses.length === 0 && (
          <p className="modal-empty">
            No logical buses are defined yet. Add at least one bus in
            the project panel, or skip every channel below.
          </p>
        )}
        <div className="blf-map-rows">
          {channels.map((ch) => (
            <div className="blf-map-row" key={ch}>
              <span className="blf-map-channel">Channel {ch}</span>
              <Combobox
                options={[
                  { value: "", label: "(skip)" },
                  ...buses.map((b) => ({ value: b.id, label: b.name })),
                ]}
                value={choices[ch] ?? ""}
                onChange={(v) => set(ch, v)}
                ariaLabel={`channel ${ch} bus`}
              />
            </div>
          ))}
        </div>
        {hasSpan && (
          <div className="blf-map-range">
            <label className="blf-map-range-field">
              Start (s)
              <input
                type="number"
                min={0}
                max={rangeEndSec}
                step="any"
                value={rangeStartSec}
                onChange={(e) => setRangeStart(Number(e.target.value))}
                aria-label="import start seconds"
              />
            </label>
            <label className="blf-map-range-field">
              End (s)
              <input
                type="number"
                min={rangeStartSec}
                max={durationSeconds}
                step="any"
                value={rangeEndSec}
                onChange={(e) => setRangeEnd(Number(e.target.value))}
                aria-label="import end seconds"
              />
            </label>
          </div>
        )}
        {markers.length > 0 && (
          <div className="blf-map-markers-section">
            <button
              type="button"
              className="blf-map-markers-toggle"
              aria-expanded={markersOpen}
              onClick={() => setMarkersOpen((v) => !v)}
            >
              <span className="blf-map-markers-caret" aria-hidden="true">
                {markersOpen ? "▾" : "▸"}
              </span>
              Markers ({markers.length})
            </button>
            {markersOpen && (
              <div
                className="blf-map-markers-list"
                ref={markersListRef}
                {...markersGrid.containerProps}
              >
                {markers.map((m) => (
                  <div
                    key={m.id}
                    id={markersGrid.rowDomId(m.id)}
                    className={
                      "blf-map-marker-row" +
                      (markersGrid.cursor === m.id ? " active" : "") +
                      (markersGrid.selection.has(m.id) ? " selected" : "")
                    }
                    onClick={(e) =>
                      markersGrid.onRowClick(m.id, {
                        mod: e.metaKey || e.ctrlKey,
                        shift: e.shiftKey,
                      })
                    }
                  >
                    <span className="blf-map-marker-time">
                      {formatElapsed(elapsedSeconds(m.timestampNs, originNs), 3)}
                    </span>
                    <span className="blf-map-marker-label">{m.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {skippedDecodedGroups != null && skippedDecodedGroups.length > 0 && (
          <div className="blf-map-skipped-section">
            <p className="blf-map-meta">
              {skippedDecodedGroups.length} per-message decoded group
              {skippedDecodedGroups.length === 1 ? "" : "s"} already covered by the frames
              above plus the project DBC — not imported:
            </p>
            <ul className="blf-map-skipped-list">
              {skippedDecodedGroups.map((g) => (
                <li key={g.source_path}>
                  {g.name ?? g.source_path} ({g.signal_count} signal
                  {g.signal_count === 1 ? "" : "s"})
                </li>
              ))}
            </ul>
          </div>
        )}
        {signalGroupCount != null && signalGroupCount > 0 && (
          <p className="blf-map-meta">
            {signalGroupCount} message-independent signal group{signalGroupCount === 1 ? "" : "s"}{" "}
            found; not imported yet.
          </p>
        )}
        <div className="modal-buttons">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(choices, range)}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
