import { describe, expect, it } from "vitest";

import { splitStatus, type LogState, type RemoteStatus, type StatusInputs } from "./statusLine";
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

  it("a running BLF stream is resting with the residency line, no transient", () => {
    const state: LogState = { kind: "running", result: { blf_path: "/logs/drive.blf" } };
    const { resting, transient } = splitStatus(
      inputs({ state, count: 1000, framesPerSecond: 500, bufferSeconds: 65, scratchBytes: 42 * 1024 * 1024 }),
    );
    expect(transient).toBeNull();
    expect(resting).toContain("Streaming drive.blf");
    expect(resting).toContain("disk");
  });

  it("relabels the memory figure as `host`, not `RAM`", () => {
    const { resting } = splitStatus(
      inputs({ state: { kind: "running", result: { blf_path: "a.blf" } }, memBytes: 128 * 1024 * 1024 }),
    );
    expect(resting).toContain("host");
    expect(resting).not.toContain("RAM");
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
