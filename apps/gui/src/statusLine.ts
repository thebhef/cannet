// What the header status bar reads, as pure logic: a split of app
// state into a *resting* notice (what is happening) and an optional
// *transient* one (errors, completions, remote connect/error
// summaries), plus the discrete metrics that stand beside them —
// frames, rate, elapsed, RAM, cache (ADR 0002 DS-8). The view shows
// the transient for a few seconds, mirrors it to the system log, then
// reverts to the resting line, so a notice is never lost. Kept here as
// pure logic so the classification is unit-testable without rendering.

import type {
  ImportMdfResult,
  LoadProgress,
  OpenLogResult,
  RemoteSessionResult,
  SystemLogLevel,
} from "./types";
import { formatFrameCount } from "./format";

/// Whatever a capture-source command (`open_log`, `import_mdf`) handed
/// back once its worker started. Both shapes carry exactly one field —
/// the source path, under a format-specific key — so `capturePath`
/// below is the one place that needs to know both key names.
export type CaptureResult = OpenLogResult | ImportMdfResult;

/// BLF/MDF open/replay lifecycle, mirrored from the host `open_log` /
/// `import_mdf` / replay pump. `result` carries the source path.
export type LogState =
  | { kind: "idle" }
  | { kind: "loading"; result: CaptureResult }
  | { kind: "running"; result: CaptureResult }
  | { kind: "done"; result: CaptureResult; total: number }
  | { kind: "error"; message: string };

/// The source path out of a `CaptureResult`, whichever format it came
/// from.
export function capturePath(result: CaptureResult): string {
  return "blf_path" in result ? result.blf_path : result.mdf_path;
}

/// One remote streaming session's status, keyed by `host:port`.
export type RemoteStatus =
  | { kind: "connecting" }
  | { kind: "running"; result: RemoteSessionResult }
  | { kind: "error"; message: string };

/// A non-residency notice to flash in the status bar and mirror to the
/// system log. `level` picks the log severity and (via CSS) the bar tint.
export interface TransientStatus {
  text: string;
  level: SystemLogLevel;
}

/// The status line split into its resting readout and any transient
/// notice layered on top.
export interface StatusSplit {
  /// The residency line (or an activity/idle line) to show at rest —
  /// live-updating, never frozen.
  resting: string;
  /// A notice to flash then revert away from, or `null` when at rest.
  transient: TransientStatus | null;
}

export interface StatusInputs {
  state: LogState;
  remoteSessions: ReadonlyMap<string, RemoteStatus>;
  /// Frames in the buffer — only to tell a finished load that landed
  /// something from one that landed nothing.
  count: number;
  /// The BLF whose channel census is being walked right now, or `null`.
  /// The walk covers the whole file before the mapping dialog has
  /// anything to show, so on a large log the pick-a-file gesture is
  /// followed by seconds of nothing — this is what says why.
  scanningBlfPath: string | null;
  /// Same notice, for an MDF census in flight (`scan_mdf_channels`).
  scanningMdfPath: string | null;
}

/// Classify the current app state into a resting notice + an optional
/// transient one. Ongoing activity (idle prompt, BLF load, live
/// stream) is *resting*; discrete outcomes (error, done, remote
/// connect/error summaries) are *transient* — the resting line says
/// only what is happening, and everything else flashes and reverts.
///
/// The resting line carries **no numbers**: frames, rate, elapsed and
/// the two residency figures are discrete aligned metrics
/// ({@link statusMetrics}), and prose in front of them is exactly what
/// stopped them aligning. It carries no DBC count either — that is a
/// fact about configuration rather than about what is happening, and
/// the Database panel owns it. An empty string means there is nothing
/// to say and the metrics are the whole readout.
export function splitStatus(inp: StatusInputs): StatusSplit {
  const { state, remoteSessions, count } = inp;
  const idlePrompt = "Open a BLF log or connect to a server to begin.";

  // A census in flight outranks everything below: it is the only thing
  // the user is waiting on, and the session it may be about to replace
  // is not. Ongoing activity, so it rests rather than flashing.
  if (inp.scanningBlfPath != null) {
    return { resting: `Loading ${shortenPath(inp.scanningBlfPath)} …`, transient: null };
  }
  if (inp.scanningMdfPath != null) {
    return { resting: `Loading ${shortenPath(inp.scanningMdfPath)} …`, transient: null };
  }

  // Remote sessions take priority over the BLF idle/done line — the user
  // is actively streaming. Running sessions name the stream;
  // connecting/errored sessions are the transient notice.
  if (remoteSessions.size > 0) {
    const entries = Array.from(remoteSessions.entries());
    const running = entries.filter(([, s]) => s.kind === "running");
    const connecting = entries.filter(([, s]) => s.kind === "connecting").length;
    const errored = entries.filter(([, s]) => s.kind === "error");
    const totalInterfaces = running.reduce(
      (acc, [, s]) => (s.kind === "running" ? acc + s.result.interfaces.length : acc),
      0,
    );
    const resting =
      running.length > 0
        ? `Streaming from ${running.length} server${running.length === 1 ? "" : "s"} (${totalInterfaces} interface${totalInterfaces === 1 ? "" : "s"})`
        : idlePrompt;
    const parts: string[] = [];
    if (connecting > 0) parts.push(`${connecting} connecting`);
    if (errored.length > 0) {
      const first = errored[0];
      parts.push(
        first[1].kind === "error"
          ? `${errored.length} error${errored.length === 1 ? "" : "s"} (${first[0]}: ${first[1].message})`
          : `${errored.length} error${errored.length === 1 ? "" : "s"}`,
      );
    }
    const transient: TransientStatus | null =
      parts.length > 0 ? { text: `${parts.join(" · ")}.`, level: errored.length > 0 ? "error" : "info" } : null;
    return { resting, transient };
  }

  switch (state.kind) {
    case "idle":
      return { resting: idlePrompt, transient: null };
    case "loading":
      // Ongoing activity — resting, not a flashed notice.
      return {
        resting: `Opening ${shortenPath(capturePath(state.result))} …`,
        transient: null,
      };
    case "running":
      return { resting: `Streaming ${shortenPath(capturePath(state.result))}`, transient: null };
    case "done":
      // The completion notice flashes; the bar reverts to the metrics
      // alone, which are the whole readout of a loaded buffer.
      return {
        resting: count > 0 ? "" : idlePrompt,
        transient: {
          text: `Done: ${formatNumber(state.total)} frames from ${shortenPath(capturePath(state.result))}.`,
          level: "info",
        },
      };
    case "error":
      return { resting: idlePrompt, transient: { text: `Error: ${state.message}`, level: "error" } };
  }
}

/// One metric in the status bar: a figure and the word beside it.
export interface StatusMetric {
  /// Stable identity — also the drop order's key.
  id: "fps" | "busLoad" | "frames" | "elapsed" | "ram" | "cache";
  /// The figure as written.
  value: string;
  /// The word beside it. The label is what carries the whole-readout
  /// tooltip, so a narrow window costs a hover rather than the number.
  label: string;
  /// A metric only a live session can report. Frames, elapsed, RAM and
  /// cache describe the buffer and are equally true of a loaded file;
  /// bus load is meaningless for a file, because a capture has no wire.
  live?: boolean;
}

export interface StatusMetricsInputs {
  count: number;
  firstIndex: number;
  framesPerSecond: number;
  /// Percentage of the wire in use, or `null` when nothing is on a wire
  /// — a loaded file, or a host that does not report it.
  busLoadPercent: number | null;
  bufferSeconds: number;
  scratchBytes: number | null;
  memBytes: number | null;
}

const FRAMES_SUFFIX = " frames";

/// The bar's metrics, in the ruled left-to-right order: `f/s`,
/// `bus load`, `frames`, `elapsed`, `RAM`, `cache`. Each appears only
/// when there is a figure to show.
///
/// Every number here is the host's — the rate, the elapsed span and the
/// two residency figures all arrive on `trace-grew`, and the frame
/// count is the store's. Nothing is derived from what the frontend can
/// see arriving.
export function statusMetrics(inp: StatusMetricsInputs): StatusMetric[] {
  const metrics: StatusMetric[] = [];
  if (inp.framesPerSecond > 0) {
    metrics.push({ id: "fps", value: formatRate(inp.framesPerSecond), label: "f/s" });
  }
  if (inp.busLoadPercent != null) {
    metrics.push({
      id: "busLoad",
      value: `${Math.round(inp.busLoadPercent)} %`,
      label: "bus load",
      live: true,
    });
  }
  // The retained-of-total shape once eviction has truncated the oldest
  // history, so the count keeps the store's own rule rather than a
  // second one.
  const frames = formatFrameCount(inp.count, inp.firstIndex);
  metrics.push({
    id: "frames",
    value: frames.endsWith(FRAMES_SUFFIX) ? frames.slice(0, -FRAMES_SUFFIX.length) : frames,
    label: "frames",
  });
  if (inp.bufferSeconds > 0) {
    metrics.push({ id: "elapsed", value: formatDuration(inp.bufferSeconds), label: "elapsed" });
  }
  // Disk-spill residency split (ADR 0002 DS-8): resident memory vs the
  // on-disk cache. `RAM` is the whole application's resident memory —
  // the Rust host plus its WebView children, the figure a task manager
  // shows — and not a store-only number: mmap'd cache pages come and go
  // under the kernel, so store residency is bounded by design and not
  // separately metered. `cache` is the `cache/` scratch footprint on
  // disk. Each shows only when present.
  if (inp.memBytes != null && inp.memBytes > 0) {
    metrics.push({ id: "ram", value: formatBytes(inp.memBytes), label: "RAM" });
  }
  if (inp.scratchBytes != null && inp.scratchBytes > 0) {
    metrics.push({ id: "cache", value: formatBytes(inp.scratchBytes), label: "cache" });
  }
  return metrics;
}

/// The whole readout as one tooltip, every metric on its own line —
/// the ones a narrow bar has dropped included. It sits on the metric
/// labels, which is where a reader looking for a missing number looks,
/// and it replaces the single blob title the prose status line used to
/// carry on the whole element.
export function statusMetricsTooltip(metrics: readonly StatusMetric[]): string {
  return metrics.map((m) => `${m.value} ${m.label}`).join("\n");
}

/// The rate on its own, without its unit — the metric's own label
/// carries that.
function formatRate(fps: number): string {
  if (fps >= 10_000) return `${(fps / 1000).toFixed(1)}k`;
  if (fps >= 100) return `${Math.round(fps)}`;
  return fps.toFixed(1);
}

/// Buffered-span readout as a `d:hh:mm:ss` clock, trimmed to the largest
/// non-zero segment (mm:ss minimum): `0:05`, `2:05`, `1:02:05`,
/// `3:01:02:05`. Lower segments are zero-padded once a higher one shows.
function formatDuration(seconds: number): string {
  const t = Math.floor(seconds);
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n: number) => n.toString().padStart(2, "0");
  if (d > 0) return `${d}:${p(h)}:${p(m)}:${p(s)}`;
  if (h > 0) return `${h}:${p(m)}:${p(s)}`;
  return `${m}:${p(s)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/// Byte count as a compact binary-unit size: `512 KB`, `3.4 MB`,
/// `1.2 GB`. Sub-kilobyte sizes show as `B`; larger units keep one
/// decimal once past 9.9 so the readout stays short. Shared with the
/// project cache list, which reports the same kind of figure for every
/// project rather than growing a second format for it.
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function shortenPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/// One phase's progress, in whatever the phase counts. The two load
/// phases come off the `load-progress` event; the cache rebuild is
/// polled, so it is not part of that union but draws in the same chip.
export type ProgressReport =
  | LoadProgress
  | { phase: "cache_rebuild"; decoded: number; total: number };

/// The determinate readout beside a load's progress bar: how full the
/// bar is, and the number next to it.
///
/// `null` when there is nothing honest to show — no report has arrived
/// yet, or the phase's denominator is zero (an empty file, a capture
/// with no bus records). The caller shows the indeterminate chip then:
/// a bar pinned at 0 % would claim a measurement that has not been made.
///
/// The phases read differently because they count different things.
/// The census counts bytes and the rebuild counts frames across every
/// pyramid at once, neither of which means anything to the reader as a
/// figure, so both show only the percentage. The import counts frames,
/// which are the thing being imported, so it shows them.
export function loadProgressReadout(
  progress: ProgressReport | null,
): { fraction: number; text: string } | null {
  if (progress === null) return null;
  if (progress.phase === "census") {
    if (progress.total_bytes <= 0) return null;
    const fraction = clampFraction(progress.bytes_read / progress.total_bytes);
    return { fraction, text: `${Math.round(fraction * 100)} %` };
  }
  // The rebuild counts frames too, but across every pyramid at once —
  // a figure whose magnitude means nothing to anyone — so it shows the
  // percentage the way the census does.
  if (progress.phase === "cache_rebuild") {
    if (progress.total <= 0) return null;
    const fraction = clampFraction(progress.decoded / progress.total);
    return { fraction, text: `${Math.round(fraction * 100)} %` };
  }
  if (progress.total_frames <= 0) return null;
  const fraction = clampFraction(progress.frames / progress.total_frames);
  return {
    fraction,
    text: `${progress.frames.toLocaleString()} / ${progress.total_frames.toLocaleString()} frames`,
  };
}

/// A load reports what it walked, and what it walked is not always what
/// lands: an import windowed to a time range, or with channels skipped,
/// pumps fewer frames than the census counted. Clamping keeps the bar
/// inside itself rather than letting a rounding or a filter push it past
/// the end.
function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
