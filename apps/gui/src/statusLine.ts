// The header status line: a pure split of app state into a *resting*
// readout (the disk-spill residency line — frames · fps · elapsed ·
// host · disk, ADR 0002 DS-8) and an optional *transient* notice
// (errors, completions, remote connect/error summaries). The view
// shows the transient for a few seconds, mirrors it to the system log,
// then reverts to the resting line — so a notice is never lost but the
// bar settles back to the residency readout. Kept here as pure logic so
// the classification is unit-testable without rendering.

import type { OpenLogResult, RemoteSessionResult, SystemLogLevel } from "./types";
import { formatFrameCount } from "./format";

/// BLF open/replay lifecycle, mirrored from the host `open_log` /
/// replay pump. `result.blf_path` is the source file.
export type LogState =
  | { kind: "idle" }
  | { kind: "loading"; result: OpenLogResult }
  | { kind: "running"; result: OpenLogResult }
  | { kind: "done"; result: OpenLogResult; total: number }
  | { kind: "error"; message: string };

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
  dbcPaths: readonly string[];
  count: number;
  firstIndex: number;
  framesPerSecond: number;
  bufferSeconds: number;
  scratchBytes: number | null;
  memBytes: number | null;
}

/// Classify the current app state into a resting line + optional
/// transient notice. Ongoing activity (idle prompt, BLF load, live
/// stream) is *resting*; discrete outcomes (error, done, remote
/// connect/error summaries) are *transient* — the label is
/// residency-only at rest, everything else flashes and reverts.
export function splitStatus(inp: StatusInputs): StatusSplit {
  const { state, remoteSessions, dbcPaths, count, firstIndex } = inp;
  const frames = formatFrameCount(count, firstIndex);
  const dbc =
    dbcPaths.length === 0
      ? "no DBC attached"
      : dbcPaths.length === 1
        ? `DBC: ${shortenPath(dbcPaths[0])}`
        : `${dbcPaths.length} DBCs`;
  const fps = inp.framesPerSecond > 0 ? ` · ${formatRate(inp.framesPerSecond)}` : "";
  const buf = inp.bufferSeconds > 0 ? ` · ${formatDuration(inp.bufferSeconds)} elapsed` : "";
  // Disk-spill residency split (ADR 0002 DS-8): whole-host RSS vs on-disk
  // cache. `host` is the whole process's resident memory (not a
  // store-only figure — mmap'd cache pages page in and out under the
  // kernel, so store residency is bounded by design and not separately
  // metered); `disk` is the `current/` scratch footprint. Each shows
  // only when present.
  const mem = inp.memBytes != null && inp.memBytes > 0 ? ` · ${formatBytes(inp.memBytes)} host` : "";
  const cache =
    inp.scratchBytes != null && inp.scratchBytes > 0 ? ` · ${formatBytes(inp.scratchBytes)} disk` : "";
  const residency = `${frames}${fps}${buf}${mem}${cache}`;
  const idlePrompt = `Open a BLF log or connect to a server to begin. ${dbc}.`;

  // Remote sessions take priority over the BLF idle/done line — the user
  // is actively streaming. Running sessions form the resting residency
  // line; connecting/errored sessions are the transient notice.
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
        ? `Streaming from ${running.length} server${running.length === 1 ? "" : "s"} (${totalInterfaces} interface${totalInterfaces === 1 ? "" : "s"}, ${residency}). ${dbc}.`
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
      return { resting: `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`, transient: null };
    case "running":
      return {
        resting: `Streaming ${shortenPath(state.result.blf_path)} (${residency}). ${dbc}.`,
        transient: null,
      };
    case "done":
      // The completion notice flashes; the bar reverts to a static
      // residency readout of the loaded buffer (or the idle prompt if
      // nothing landed).
      return {
        resting: count > 0 ? `${residency}. ${dbc}.` : idlePrompt,
        transient: {
          text: `Done: ${formatNumber(state.total)} frames from ${shortenPath(state.result.blf_path)}.`,
          level: "info",
        },
      };
    case "error":
      return { resting: idlePrompt, transient: { text: `Error: ${state.message}`, level: "error" } };
  }
}

function formatRate(fps: number): string {
  if (fps >= 10_000) return `${(fps / 1000).toFixed(1)}k fps`;
  if (fps >= 100) return `${Math.round(fps)} fps`;
  return `${fps.toFixed(1)} fps`;
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

/// Byte count as a compact binary-unit size for the status line: `512 KB`,
/// `3.4 MB`, `1.2 GB`. Sub-kilobyte sizes show as `B`; larger units keep one
/// decimal once past 9.9 so the readout stays short.
function formatBytes(bytes: number): string {
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
