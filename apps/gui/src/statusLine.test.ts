import { describe, expect, it } from "vitest";

import {
  loadProgressReadout,
  splitStatus,
  type LogState,
  type RemoteStatus,
  type StatusInputs,
} from "./statusLine";
import type { RemoteSessionResult } from "./types";

// Baseline inputs: no session, no DBC, no residency figures. Override
// per case.
function inputs(over: Partial<StatusInputs>): StatusInputs {
  return {
    state: { kind: "idle" },
    remoteSessions: new Map(),
    dbcPaths: [],
    count: 0,
    firstIndex: 0,
    framesPerSecond: 0,
    bufferSeconds: 0,
    scratchBytes: null,
    memBytes: null,
    scanningBlfPath: null,
    scanningMdfPath: null,
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

  it("a running BLF stream is resting with the residency line, no transient", () => {
    const state: LogState = { kind: "running", result: { blf_path: "/logs/drive.blf" } };
    const { resting, transient } = splitStatus(
      inputs({ state, count: 1000, framesPerSecond: 500, bufferSeconds: 65, scratchBytes: 42 * 1024 * 1024 }),
    );
    expect(transient).toBeNull();
    expect(resting).toContain("Streaming drive.blf");
    expect(resting).toContain("cache");
  });

  it("names the two residency figures `RAM` and `cache`", () => {
    const { resting } = splitStatus(
      inputs({
        state: { kind: "running", result: { blf_path: "a.blf" } },
        memBytes: 128 * 1024 * 1024,
        scratchBytes: 42 * 1024 * 1024,
      }),
    );
    expect(resting).toContain("128 MB RAM");
    expect(resting).toContain("42.0 MB cache");
  });

  it("an error is a transient at error level; the bar rests at the idle prompt", () => {
    const { resting, transient } = splitStatus(inputs({ state: { kind: "error", message: "boom" } }));
    expect(transient).toEqual({ text: "Error: boom", level: "error" });
    expect(resting).toMatch(/Open a BLF log/);
  });

  it("done is an info transient; the bar rests at a static residency readout", () => {
    const state: LogState = { kind: "done", result: { blf_path: "/logs/drive.blf" }, total: 12345 };
    const { resting, transient } = splitStatus(inputs({ state, count: 12345, bufferSeconds: 10 }));
    expect(transient?.level).toBe("info");
    expect(transient?.text).toContain("Done: 12,345 frames from drive.blf");
    expect(resting).not.toContain("Done:");
    expect(resting).toContain("frames");
  });

  it("a live remote stream rests on residency; a connect error flashes as an error transient", () => {
    const remoteSessions = new Map<string, RemoteStatus>([
      ["1.2.3.4:5", remoteRunning],
      ["9.9.9.9:9", { kind: "error", message: "refused" }],
    ]);
    const { resting, transient } = splitStatus(inputs({ remoteSessions, count: 50 }));
    expect(resting).toContain("Streaming from 1 server");
    expect(transient?.level).toBe("error");
    expect(transient?.text).toContain("9.9.9.9:9: refused");
  });

  it("only-connecting remote sessions rest at the idle prompt with an info transient", () => {
    const remoteSessions = new Map<string, RemoteStatus>([["h:1", { kind: "connecting" }]]);
    const { resting, transient } = splitStatus(inputs({ remoteSessions }));
    expect(resting).toMatch(/Open a BLF log/);
    expect(transient).toEqual({ text: "1 connecting.", level: "info" });
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
