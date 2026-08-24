import { describe, expect, it } from "vitest";

import {
  loadProgressReadout,
  splitStatus,
  statusMetrics,
  statusMetricsTooltip,
  type LogState,
  type RemoteStatus,
  type StatusInputs,
  type StatusMetricsInputs,
} from "./statusLine";
import type { RemoteSessionResult } from "./types";

// Baseline inputs: no session, nothing scanning. Override per case.
function inputs(over: Partial<StatusInputs>): StatusInputs {
  return {
    state: { kind: "idle" },
    remoteSessions: new Map(),
    count: 0,
    scanningBlfPath: null,
    scanningMdfPath: null,
    ...over,
  };
}

// Baseline metric inputs: an empty buffer with no figures at all.
function metricInputs(over: Partial<StatusMetricsInputs>): StatusMetricsInputs {
  return {
    count: 0,
    firstIndex: 0,
    framesPerSecond: 0,
    busLoadPercent: null,
    bufferSeconds: 0,
    scratchBytes: null,
    memBytes: null,
    ...over,
  };
}

const remoteRunning: RemoteStatus = {
  kind: "running",
  result: { address: "1.2.3.4:5", interfaces: [{}], subscriptions: [] } as unknown as RemoteSessionResult,
};

describe("splitStatus", () => {
  it("idle is resting, no transient", () => {
    const { resting, transient } = splitStatus(inputs({}));
    expect(transient).toBeNull();
    expect(resting).toMatch(/Open a BLF log/);
  });

  it("a BLF scan is resting activity, and outranks whatever the session was showing", () => {
    // The census walks the whole file before the mapping dialog can be
    // built, which is seconds on a large log. It is ongoing activity, so
    // it reads like the load line rather than flashing as a notice — and
    // it shows over a session that is already loaded, because that
    // session's residency line is not what the user is waiting on.
    const state: LogState = { kind: "running", result: { blf_path: "/logs/drive.blf" } };
    const { resting, transient } = splitStatus(
      inputs({ state, count: 1000, scanningBlfPath: "/logs/next.blf" }),
    );
    expect(transient).toBeNull();
    expect(resting).toMatch(/Loading next\.blf/);
  });

  it("no scan in flight leaves the line alone", () => {
    const { resting } = splitStatus(inputs({ scanningBlfPath: null }));
    expect(resting).toMatch(/Open a BLF log/);
  });

  it("an MDF scan is resting activity, the same as a BLF scan", () => {
    const state: LogState = { kind: "running", result: { blf_path: "/logs/drive.blf" } };
    const { resting, transient } = splitStatus(
      inputs({ state, count: 1000, scanningMdfPath: "/logs/next.mf4" }),
    );
    expect(transient).toBeNull();
    expect(resting).toMatch(/Loading next\.mf4/);
  });

  it("a running BLF stream names the capture and leaves the numbers to the metrics", () => {
    const state: LogState = { kind: "running", result: { blf_path: "/logs/drive.blf" } };
    const { resting, transient } = splitStatus(inputs({ state, count: 1000 }));
    expect(transient).toBeNull();
    expect(resting).toBe("Streaming drive.blf");
    // The numbers are discrete aligned metrics now; a sentence in
    // front of them is exactly what stopped them aligning.
    expect(resting).not.toMatch(/frames|RAM|cache|elapsed/);
  });

  it("says nothing at all about the DBCs — that is the Database panel's fact", () => {
    const state: LogState = { kind: "running", result: { blf_path: "a.blf" } };
    const { resting } = splitStatus(inputs({ state, count: 5 }));
    expect(resting).not.toMatch(/DBC/);
  });

  it("an error is a transient at error level; the bar rests at the idle prompt", () => {
    const { resting, transient } = splitStatus(inputs({ state: { kind: "error", message: "boom" } }));
    expect(transient).toEqual({ text: "Error: boom", level: "error" });
    expect(resting).toMatch(/Open a BLF log/);
  });

  it("done is an info transient; the bar rests at a static residency readout", () => {
    const state: LogState = { kind: "done", result: { blf_path: "/logs/drive.blf" }, total: 12345 };
    const { resting, transient } = splitStatus(inputs({ state, count: 12345 }));
    expect(transient?.level).toBe("info");
    expect(transient?.text).toContain("Done: 12,345 frames from drive.blf");
    // A loaded buffer needs no words: the metrics carry it.
    expect(resting).toBe("");
  });

  it("a running remote session blanks the line — the chip and the log carry it now", () => {
    // No "Streaming from N server(s)" text and no error-summary
    // transient: the connect/disconnect chip is the resting readout for
    // a session (`connectionStates.ts`'s `summarizeConnection`) and a
    // connect failure's reason lands in the system log
    // (`session.rs`'s `sys_error!("connection", …)`), so this line has
    // nothing left to add while one is running.
    const remoteSessions = new Map<string, RemoteStatus>([
      ["1.2.3.4:5", remoteRunning],
      ["9.9.9.9:9", { kind: "error", message: "refused" }],
    ]);
    const { resting, transient } = splitStatus(inputs({ remoteSessions, count: 50 }));
    expect(resting).toBe("");
    expect(transient).toBeNull();
  });

  it("only-connecting or only-errored remote sessions rest at the idle prompt, no transient", () => {
    const connecting = new Map<string, RemoteStatus>([["h:1", { kind: "connecting" }]]);
    expect(splitStatus(inputs({ remoteSessions: connecting }))).toEqual({
      resting: "Open a BLF log or connect to a server to begin.",
      transient: null,
    });

    const errored = new Map<string, RemoteStatus>([["h:1", { kind: "error", message: "refused" }]]);
    expect(splitStatus(inputs({ remoteSessions: errored }))).toEqual({
      resting: "Open a BLF log or connect to a server to begin.",
      transient: null,
    });
  });
});

describe("statusMetrics", () => {
  it("orders the metrics as ruled, left to right", () => {
    const metrics = statusMetrics(
      metricInputs({
        count: 1_234_567,
        framesPerSecond: 18_400,
        busLoadPercent: 34,
        bufferSeconds: 2467,
        memBytes: 4.2 * 1024 ** 3,
        scratchBytes: 12.1 * 1024 ** 3,
      }),
    );
    expect(metrics.map((m) => m.id)).toEqual([
      "fps",
      "busLoad",
      "frames",
      "elapsed",
      "ram",
      "cache",
    ]);
    expect(metrics.map((m) => m.label)).toEqual([
      "f/s",
      "bus load",
      "frames",
      "elapsed",
      "RAM",
      "cache",
    ]);
    expect(metrics.map((m) => m.value)).toEqual([
      "18.4k",
      "34 %",
      (1_234_567).toLocaleString(),
      "41:07",
      "4.2 GB",
      "12.1 GB",
    ]);
  });

  it("marks bus load as the live-only metric", () => {
    // Frames, elapsed, RAM and cache describe the buffer and are
    // equally true of a loaded file; a capture has no wire.
    const metrics = statusMetrics(metricInputs({ busLoadPercent: 12 }));
    expect(metrics.find((m) => m.id === "busLoad")?.live).toBe(true);
    expect(metrics.filter((m) => m.live).map((m) => m.id)).toEqual(["busLoad"]);
  });

  it("omits bus load entirely when nothing is on a wire", () => {
    const metrics = statusMetrics(metricInputs({ count: 10, framesPerSecond: 5 }));
    expect(metrics.map((m) => m.id)).toEqual(["fps", "frames"]);
  });

  it("shows a figure only when there is one", () => {
    expect(statusMetrics(metricInputs({})).map((m) => m.id)).toEqual(["frames"]);
    expect(
      statusMetrics(metricInputs({ scratchBytes: 0, memBytes: 0 })).map((m) => m.id),
    ).toEqual(["frames"]);
  });

  it("keeps the retained-of-total shape once eviction has truncated history", () => {
    const metrics = statusMetrics(metricInputs({ count: 1000, firstIndex: 400 }));
    expect(metrics.find((m) => m.id === "frames")?.value).toBe("600 of 1,000");
  });

  it("writes the whole readout as one tooltip, dropped metrics included", () => {
    const metrics = statusMetrics(
      metricInputs({ count: 12, framesPerSecond: 500, bufferSeconds: 65, memBytes: 1024 }),
    );
    expect(statusMetricsTooltip(metrics)).toBe(
      ["500 f/s", "12 frames", "1:05 elapsed", "1.0 KB RAM"].join("\n"),
    );
  });
});

describe("loadProgressReadout", () => {
  it("reads a census as a percentage of the file", () => {
    expect(loadProgressReadout({ phase: "census", bytes_read: 380, total_bytes: 1000 })).toEqual({
      fraction: 0.38,
      text: "38 %",
    });
  });

  it("reads an import as frames against the count the census found", () => {
    const readout = loadProgressReadout({
      phase: "import",
      frames: 2_981_210,
      total_frames: 4_662_118,
    });
    expect(readout?.fraction).toBeCloseTo(2_981_210 / 4_662_118, 10);
    expect(readout?.text).toBe(
      `${(2_981_210).toLocaleString()} / ${(4_662_118).toLocaleString()} frames`,
    );
  });

  it("has nothing to report before the first checkpoint lands", () => {
    // The caller shows the indeterminate chip for this: a bar pinned at
    // zero would claim a measurement nobody has made.
    expect(loadProgressReadout(null)).toBeNull();
  });

  it("has nothing to report for a phase with no denominator", () => {
    expect(loadProgressReadout({ phase: "census", bytes_read: 0, total_bytes: 0 })).toBeNull();
    expect(loadProgressReadout({ phase: "import", frames: 0, total_frames: 0 })).toBeNull();
  });

  it("keeps the bar inside itself when an import moves fewer frames than the census counted", () => {
    // A windowed import, or one with channels skipped, pumps a subset —
    // and a subset of a count taken over the whole file can still be
    // reported past it if the wrong things are compared. Clamp rather
    // than draw outside the bar.
    const readout = loadProgressReadout({ phase: "import", frames: 900, total_frames: 500 });
    expect(readout?.fraction).toBe(1);
  });
});
