// The aggregate the connection chip shows: the host already tracks
// more than the old single-boolean button could say, and *degraded* —
// some buses connected, some errored — is the state it could not
// express at all.

import { describe, expect, it } from "vitest";

import { summarizeConnection, type ConnectionUnit } from "./connectionStates";
import type { BusConnStates } from "./types";

const THREE: ConnectionUnit[] = [
  { id: "b1", name: "Powertrain" },
  { id: "b2", name: "Body" },
  { id: "b3", name: "Chassis" },
];

function summarize(states: BusConnStates, remoteActive = false, bound = THREE) {
  return summarizeConnection(bound, states, remoteActive);
}

describe("summarizeConnection", () => {
  it("has nothing to offer when the project binds no interface at all", () => {
    const s = summarizeConnection([], {}, false);
    expect(s).toMatchObject({ state: "idle", label: "Not connected", count: null, action: null });
    expect(s.detail).toMatch(/interface/i);
  });

  it("counts bound buses that no session has touched as not connected", () => {
    expect(summarize({})).toMatchObject({
      state: "idle",
      label: "Not connected",
      count: "0 / 3",
      action: "connect",
      actionLabel: "Connect",
    });
  });

  it("every bound bus connected reads Connected", () => {
    const states: BusConnStates = {
      b1: { kind: "connected", applied: null },
      b2: { kind: "connected", applied: null },
      b3: { kind: "connected", applied: null },
    };
    expect(summarize(states)).toMatchObject({
      state: "connected",
      label: "Connected",
      count: "3 / 3",
      action: "disconnect",
      actionLabel: "Disconnect",
    });
  });

  it("one adapter unplugged among three is degraded, not connected", () => {
    // The state today's boolean button cannot express, and the ordinary
    // consequence of one adapter among three being unplugged.
    const states: BusConnStates = {
      b1: { kind: "connected", applied: null },
      b2: { kind: "error", reason: "no such interface" },
      b3: { kind: "connected", applied: null },
    };
    expect(summarize(states)).toMatchObject({
      state: "degraded",
      label: "Connected",
      count: "2 / 3",
      action: "disconnect",
    });
  });

  it("an attempt in flight outranks what has already landed", () => {
    const states: BusConnStates = {
      b1: { kind: "connected", applied: null },
      b2: { kind: "connecting" },
    };
    expect(summarize(states)).toMatchObject({
      state: "connecting",
      label: "Connecting…",
      count: "1 / 3",
      // A connect that never lands must still be escapable.
      action: "disconnect",
    });
  });

  it("every attempt failed reads Failed, and pressing retries", () => {
    const states: BusConnStates = {
      b1: { kind: "error", reason: "refused" },
      b2: { kind: "error", reason: "refused" },
      b3: { kind: "error", reason: "refused" },
    };
    expect(summarize(states)).toMatchObject({
      state: "failed",
      label: "Failed",
      count: "0 / 3",
      action: "connect",
      actionLabel: "Retry",
    });
  });

  it("a session the host reports with no bus having spoken yet is connecting", () => {
    // The host raises per-bus state as each subscribe lands; between
    // the session coming up and the first bus reporting there is
    // nothing per-bus to read, and "not connected" would be wrong.
    expect(summarize({}, true)).toMatchObject({
      state: "connecting",
      label: "Connecting…",
      count: "0 / 3",
      action: "disconnect",
    });
  });

  it("names every bus and what the host applied to it in the tooltip", () => {
    const states: BusConnStates = {
      b1: {
        kind: "connected",
        applied: { speedBps: 500_000, fdEnabled: true, fdDataSpeedBps: 2_000_000 },
      },
      b2: { kind: "error", reason: "no such interface" },
    };
    const { detail } = summarize(states);
    // The shared bus-config formatter, not a second copy of it.
    expect(detail).toContain("Powertrain: connected — 500k · FD data 2M");
    expect(detail).toContain("Body: no such interface");
    expect(detail).toContain("Chassis: not connected");
  });
});
