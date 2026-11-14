import { describe, expect, it } from "vitest";

import {
  busConfigOf,
  remoteSessionsOf,
  type SessionStatus,
} from "./sessionStatus";

function status(): SessionStatus {
  return {
    held: true,
    path: null,
    document: null,
    dirty: false,
    trace: {} as SessionStatus["trace"],
    sessions: [
      {
        result: { address: "a:1", interfaces: [], subscriptions: [] },
        bindings: [
          {
            interface: "i1",
            busId: "b1",
            speedBps: 500000,
            fd: true,
            fdDataSpeedBps: 2000000,
          },
          {
            interface: "i2",
            busId: "b2",
            speedBps: null,
            fd: null,
            fdDataSpeedBps: null,
          },
        ],
      },
    ],
    dbcs: [],
    pyramids_rebuilding: false,
    importing: null,
  };
}

describe("a rejoined session's connection facts", () => {
  it("are each connect's answer, keyed by address", () => {
    const m = remoteSessionsOf(status());
    expect([...m.keys()]).toEqual(["a:1"]);
    expect(m.get("a:1")?.kind).toBe("running");
  });

  it("carry the hardware configuration each bus was connected with", () => {
    const c = busConfigOf(status());
    expect(c.get("b1")).toEqual({
      speed_bps: 500000,
      fd: true,
      fd_data_speed_bps: 2000000,
    });
    expect(c.get("b2")).toEqual({
      speed_bps: null,
      fd: null,
      fd_data_speed_bps: null,
    });
  });
});
