// The export dialog: what the capture is called and which slice of it
// goes out, in front of the OS save picker.
//
// It decides two things and nothing else. The **name** is a template
// with a live preview — resolved by the host (`preview_export_template`)
// rather than here, because the tokens and their strftime formats are
// the model's, not the view's. The **range** is a pair of bounds on the
// shared timescale (ADR 0024), both defaulting to unset: the whole
// capture, up to wherever the live edge is when the write finishes.
//
// The **format is not chosen here**. It is picked the typical way, in
// the file picker's filter list, seeded with the last one used; this
// dialog only needs to know it so the preview can show the extension the
// file will carry.
//
// Everything the timeline draws — the capture's extent, its events —
// arrives as props from host-owned model state. The dialog holds no
// capture data and derives no model fact.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ComboboxOption } from "./Combobox";
import {
  RANGE_PRESETS,
  WHOLE_CAPTURE,
  applyRangePreset,
  boundText,
  formatRangeBound,
  formatRangeSpan,
  parseRangeBound,
  rangeSpanSeconds,
  type ExportRangeSelection,
  type RangeBound,
  type RangeContext,
  type RangeEvent,
  type RangePreset,
} from "./exportRange";
import { formatLocalTimestamp, hasWallClockAnchor } from "./format";
import { plotWindow } from "./plotWindow";
import { saveCaptureExtension, type SaveFormat } from "./saveFormat";
import { TemplateTokenHelp } from "./templateTokenHelp";

/// The capture's timeline as the host reports it (`capture_extent`),
/// converted to the seconds the rest of the app works in.
export interface CaptureExtentView {
  /// The session origin (ADR 0024), Unix-epoch seconds. `null` when no
  /// session has started — a different fact from an origin of zero.
  sessionStartSeconds: number | null;
  /// The oldest retained frame's timestamp, or `null` for an empty
  /// capture.
  firstSeconds: number | null;
  /// The capture's live edge, or `null` for an empty capture.
  liveEdgeSeconds: number | null;
  frameCount: number;
}

export interface ExportChoice {
  /// The template as the user left it — remembered as machine state for
  /// the next export.
  nameTemplate: string;
  /// That template resolved, with no extension: what seeds the picker's
  /// file-name field.
  resolvedName: string;
  range: ExportRangeSelection;
}

export interface ExportDialogProps {
  /// The project's display name, for `{project}`.
  project: string;
  /// The template the last export left behind.
  nameTemplate: string;
  /// The format the last export used — the extension the preview shows,
  /// and the filter the picker will open on.
  format: SaveFormat;
  extent: CaptureExtentView;
  /// The capture's timeline events, offered as bounds.
  events: readonly RangeEvent[];
  onCancel: () => void;
  onExport: (choice: ExportChoice) => void;
}

/// What one arrow-key press moves a handle: a hundredth of the capture,
/// which is one step of the same 0..100 range the handle reports through
/// `aria-valuenow`.
const KEY_STEP_FRACTION = 0.01;

/// How close to an end a dragged handle has to get before it snaps back
/// to that bound's default. Without it the outermost pixel is the only
/// way to say "the start" / "the live edge", which is not a target.
const DEFAULT_SNAP_FRACTION = 0.005;

export function ExportDialog({
  project,
  nameTemplate,
  format,
  extent,
  events,
  onCancel,
  onExport,
}: ExportDialogProps) {
  const [template, setTemplate] = useState(nameTemplate);
  const [preview, setPreview] = useState<{
    resolved: string | null;
    error: string | null;
    startResolvedAsNow: boolean;
  } | null>(null);
  const [range, setRange] = useState<ExportRangeSelection>(WHOLE_CAPTURE);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const origin = extent.sessionStartSeconds;
  const anchored = hasWallClockAnchor(origin);
  // Elapsed seconds from the origin to the live edge — the span the
  // timeline draws and the trailing presets measure back from. A capture
  // with no origin or no frames spans nothing yet.
  const duration = useMemo(() => {
    if (origin === null || extent.liveEdgeSeconds === null) return 0;
    const span = extent.liveEdgeSeconds - origin;
    return span > 0 ? span : 0;
  }, [origin, extent.liveEdgeSeconds]);

  const ctx: RangeContext = useMemo(
    () => ({
      anchored,
      sessionStartSeconds: origin ?? 0,
      durationSeconds: duration,
    }),
    [anchored, origin, duration],
  );

  // The preview is the host's answer, re-asked whenever the template or
  // the capture's start changes. Stale replies are dropped: the user
  // types faster than the round trip.
  useEffect(() => {
    let live = true;
    void invoke<{
      resolved: string | null;
      error: string | null;
      startResolvedAsNow: boolean;
    }>("preview_export_template", {
      template,
      project,
      logger: null,
      startSeconds: origin,
      isFolder: false,
    })
      .then((reply) => {
        if (live) setPreview(reply);
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [template, project, origin]);

  const extension = saveCaptureExtension(format);
  const resolved = preview?.resolved ?? null;
  const canExport = resolved !== null && resolved.trim() !== "";

  const setBound = (which: "from" | "to", value: RangeBound) => {
    setRangeError(null);
    setRange((prev) => ({ ...prev, [which]: value }));
  };

  /// A bound's combobox options: the bound's own default first, then the
  /// capture's events beneath it.
  const boundOptions = (fallback: string): ComboboxOption[] => [
    { value: "", label: fallback },
    ...events.map((e) => ({
      value: `event:${e.id}`,
      label: `${e.label} — ${formatRangeBound(e.seconds, ctx)}`,
    })),
  ];

  const commitBound = (which: "from" | "to", picked: string) => {
    if (picked === "") {
      setBound(which, null);
      return;
    }
    const event = events.find((e) => `event:${e.id}` === picked);
    if (event) {
      setBound(which, event.seconds);
      return;
    }
    const parsed = parseRangeBound(picked, ctx);
    if (parsed === undefined) {
      setRangeError(
        anchored
          ? `"${picked}" is neither a time ([Nd ]HH:MM[:SS]) nor seconds from the capture's start`
          : `"${picked}" is not seconds from the capture's start — this capture has no wall clock to name times against`,
      );
      return;
    }
    setBound(which, parsed);
  };

  const onPreset = (value: string) => {
    if (value === "") return;
    const next = applyRangePreset(value as RangePreset, duration, plotWindow());
    if (next === null) {
      setRangeError("No plot is showing a window to export.");
      return;
    }
    setRangeError(null);
    setRange(next);
  };

  // --- the timeline ---
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fraction = (bound: RangeBound, whenUnset: number) => {
    if (bound === null || duration <= 0) return whenUnset;
    const f = bound / duration;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  };
  const fromFraction = fraction(range.from, 0);
  const toFraction = fraction(range.to, 1);

  /// Move a handle to `f` (0..1 of the capture), snapping the outer
  /// extreme back to the bound's default and never letting the two
  /// bounds cross.
  const dragTo = (which: "from" | "to", f: number) => {
    const clamped = f < 0 ? 0 : f > 1 ? 1 : f;
    if (which === "from") {
      if (clamped <= DEFAULT_SNAP_FRACTION) return setBound("from", null);
      const ceiling = range.to ?? duration;
      const at = clamped * duration;
      return setBound("from", at < ceiling ? at : ceiling);
    }
    if (clamped >= 1 - DEFAULT_SNAP_FRACTION) return setBound("to", null);
    const floor = range.from ?? 0;
    const at = clamped * duration;
    return setBound("to", at > floor ? at : floor);
  };

  const onHandlePointerDown = (which: "from" | "to") => (e: React.PointerEvent) => {
    const track = trackRef.current;
    if (track === null) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (rect.width <= 0) return;
      dragTo(which, (ev.clientX - rect.left) / rect.width);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const onHandleKeyDown = (which: "from" | "to") => (e: React.KeyboardEvent) => {
    const here = which === "from" ? fromFraction : toFraction;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      dragTo(which, here + (e.key === "ArrowRight" ? KEY_STEP_FRACTION : -KEY_STEP_FRACTION));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      // Both keys return the bound to its own default, which is the
      // outer edge on the side the handle lives.
      setBound(which, null);
    }
  };

  // --- focus and dismissal (the shape every modal in the app speaks) ---
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const focusables = (): HTMLElement[] => {
    const root = overlayRef.current;
    if (root === null) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled"));
  };
  useEffect(() => {
    (confirmRef.current ?? focusables()[0])?.focus();
    // Once, on mount: the dialog claims focus when it appears.
  }, []);
  const onOverlayKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Consumed here: a global Escape binding must not also act.
      e.stopPropagation();
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const order = focusables();
    if (order.length === 0) return;
    const first = order[0];
    const last = order[order.length - 1];
    if (!e.shiftKey && e.target === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && e.target === first) {
      e.preventDefault();
      last.focus();
    }
  };

  const span = rangeSpanSeconds(range, duration);
  // The syntax that used to be a visible paragraph — now the fields'
  // own tooltip (the dialog carried too much text).
  const boundHint = anchored
    ? "HH:MM[:SS] (wall clock, prefixed 3d for the capture's fourth day) or seconds from the capture's start; empty = the capture's own end"
    : "Seconds from the capture's start; empty = the capture's own end";
  const startLabel = anchored
    ? `start ${formatLocalTimestamp(origin ?? 0, origin) ?? ""}`
    : "trace start (t = 0)";
  const endLabel = anchored
    ? `last message ${formatLocalTimestamp(extent.liveEdgeSeconds ?? 0, origin) ?? ""}`
    : `last message t = ${Math.round(duration)} s`;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      ref={overlayRef}
      onKeyDown={onOverlayKeyDown}
    >
      <div className="modal export-dialog">
        <h3 id="export-dialog-title">Export capture</h3>
        <div className="export-row">
          <label htmlFor="export-template">Name</label>
          <input
            id="export-template"
            type="text"
            aria-label="Export name template"
            spellCheck={false}
            autoComplete="off"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <TemplateTokenHelp logger={false} />
        </div>
        <div className="export-row">
          <span className="export-label">Preview</span>
          {/* A label, not a text box: the resolved name is the host's
              answer and is not edited here — the template is. */}
          <span className="export-preview" data-testid="export-preview">
            {resolved ?? "—"}
            {resolved !== null && <span className="export-preview-ext">{extension}</span>}
          </span>
        </div>
        <div className="export-row">
          <span className="export-label">Range</span>
          <div className="export-range">
            <div className="export-track" ref={trackRef}>
              <div
                className="export-track-fill"
                style={{
                  left: `${fromFraction * 100}%`,
                  width: `${Math.max(0, toFraction - fromFraction) * 100}%`,
                }}
              />
              {events.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="export-track-tick"
                  data-testid="export-range-tick"
                  tabIndex={-1}
                  aria-hidden="true"
                  title={`${e.label} — ${formatRangeBound(e.seconds, ctx)}`}
                  style={{ left: `${fraction(e.seconds, 0) * 100}%` }}
                  onClick={() => {
                    // The nearer bound moves, so one click on a tick
                    // does the obvious thing from either side.
                    const middle = ((range.from ?? 0) + (range.to ?? duration)) / 2;
                    setBound(e.seconds <= middle ? "from" : "to", e.seconds);
                  }}
                />
              ))}
              {(["from", "to"] as const).map((which) => (
                <div
                  key={which}
                  role="slider"
                  tabIndex={0}
                  className="export-track-handle"
                  aria-label={
                    which === "from" ? "Export range start marker" : "Export range end marker"
                  }
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((which === "from" ? fromFraction : toFraction) * 100)}
                  aria-valuetext={boundText(
                    which === "from" ? range.from : range.to,
                    which === "from" ? "start" : "last message captured",
                    events,
                    ctx,
                  )}
                  style={{ left: `${(which === "from" ? fromFraction : toFraction) * 100}%` }}
                  onPointerDown={onHandlePointerDown(which)}
                  onKeyDown={onHandleKeyDown(which)}
                />
              ))}
            </div>
            <div className="export-extent">
              <span data-testid="export-extent-start">{startLabel}</span>
              <span data-testid="export-extent-end">{endLabel}</span>
            </div>
            <div className="export-bounds">
              <BoundField
                label="Export range start"
                fallback="start"
                hint={boundHint}
                text={boundText(range.from, "", events, ctx)}
                options={boundOptions("start")}
                onCommit={(v) => commitBound("from", v)}
              />
              <span className="export-bounds-to" aria-hidden="true">
                →
              </span>
              <BoundField
                label="Export range end"
                fallback="last message captured"
                hint={boundHint}
                text={boundText(range.to, "", events, ctx)}
                options={boundOptions("last message captured")}
                onCommit={(v) => commitBound("to", v)}
              />
              <span className="export-hint export-span">{formatRangeSpan(span)}</span>
            </div>
            <div className="export-presets">
              <select
                aria-label="Export range presets"
                value=""
                onChange={(e) => onPreset(e.target.value)}
              >
                <option value="">Presets…</option>
                {RANGE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {rangeError !== null && (
          <p className="export-error" data-testid="export-range-error">
            {rangeError}
          </p>
        )}
        {preview?.startResolvedAsNow === true && (
          <p className="export-note" data-testid="export-note">
            This capture has no wall-clock anchor, so <code>{"{start}"}</code> resolved as the
            export time.
          </p>
        )}
        {preview?.error != null && (
          <p className="export-error" role="alert">
            {preview.error}
          </p>
        )}
        <div className="modal-buttons">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            disabled={!canExport}
            onClick={() =>
              onExport({ nameTemplate: template, resolvedName: resolved ?? "", range })
            }
          >
            Export…
          </button>
        </div>
      </div>
    </div>
  );
}

/// One range bound: a text field you type a time into, with a dropdown
/// listing the bound's own default and the capture's events beneath it.
///
/// **Not the shared `Combobox`.** That control is a filtered *select*:
/// its text box is a fuzzy filter over the options, and Enter takes the
/// best-matching option in preference to what was typed. Here the typed
/// text is the primary input — a time — and the options are the
/// shortcuts, so typing `09:20` and pressing Enter has to mean 09:20 and
/// not the event whose label happens to fuzzy-match it. Same anatomy
/// (editable field + option list), opposite precedence.
function BoundField({
  label,
  fallback,
  hint,
  text,
  options,
  onCommit,
}: {
  label: string;
  fallback: string;
  /// The accepted syntax, as the field's tooltip.
  hint?: string;
  /// The bound as it reads now, or `""` when it is at its default (the
  /// field then shows `fallback` as placeholder text).
  text: string;
  options: readonly ComboboxOption[];
  onCommit: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // The field shows the bound until the user starts typing into it;
  // after that it shows what they are typing, until they commit.
  const shown = draft ?? text;
  const commit = (value: string) => {
    setDraft(null);
    setOpen(false);
    onCommit(value);
  };
  return (
    <div className="export-bound">
      <input
        type="text"
        aria-label={label}
        title={hint}
        spellCheck={false}
        autoComplete="off"
        placeholder={fallback}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== null && commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(shown);
          } else if (e.key === "Escape" && (open || draft !== null)) {
            // The field's own edit is what Escape abandons; only once
            // there is nothing to abandon does it reach the dialog.
            e.stopPropagation();
            e.preventDefault();
            setDraft(null);
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="export-bound-open"
        tabIndex={-1}
        aria-label={`${label} options`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="export-bound-list" role="listbox" aria-label={`${label} options`}>
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={false}>
              <button type="button" onClick={() => commit(o.value)}>
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
