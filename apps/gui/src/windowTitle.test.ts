import { describe, expect, it } from "vitest";

import { captureLabel, windowTitle } from "./windowTitle";
import type { LogState, RemoteStatus } from "./statusLine";

const noCapture = { capture: null, dirty: false, version: "v0.9.3" };
const idle: LogState = { kind: "idle" };
const noSessions = new Map<string, RemoteStatus>();

describe("windowTitle", () => {
  it("is the app name and version with no project open", () => {
    expect(windowTitle({ projectPath: null, ...noCapture })).toBe("cannet 0.9.3");
  });

  it("leads with the project name and ends with the app + version", () => {
    expect(windowTitle({ projectPath: "/x/ev-zonal.cannet_prj", ...noCapture })).toBe(
      "ev-zonal — cannet 0.9.3",
    );
  });

  it("puts the capture source between the project and the app", () => {
    expect(
      windowTitle({
        projectPath: "/x/ev-zonal.cannet_prj",
        capture: "drive-cycle.blf",
        dirty: false,
        version: "v0.9.3",
      }),
    ).toBe("ev-zonal — drive-cycle.blf — cannet 0.9.3");
  });

  it("prefixes a bullet when there are unsaved changes", () => {
    expect(
      windowTitle({
        projectPath: "/x/ev-zonal.cannet_prj",
        capture: "drive-cycle.blf",
        dirty: true,
        version: "v0.9.3",
      }),
    ).toBe("• ev-zonal — drive-cycle.blf — cannet 0.9.3");
  });

  it("shows a live connection in the capture-source slot", () => {
    expect(
      windowTitle({
        projectPath: "/x/ev-zonal.cannet_prj",
        capture: "PCAN-USB",
        dirty: false,
        version: "v0.9.3",
      }),
    ).toBe("ev-zonal — PCAN-USB — cannet 0.9.3");
  });

  it("keeps the version verbatim past the leading v (untagged builds)", () => {
    expect(windowTitle({ projectPath: null, ...noCapture, version: "v0.9.3-3-gabc1234" })).toBe(
      "cannet 0.9.3-3-gabc1234",
    );
  });

  it("drops the version segment entirely until the host reports one", () => {
    expect(windowTitle({ projectPath: null, ...noCapture, version: "" })).toBe("cannet");
  });

  it("uses the project file's basename without its extension", () => {
    expect(windowTitle({ projectPath: "/x/Bench Rig.cannet_prj", ...noCapture })).toBe(
      "Bench Rig — cannet 0.9.3",
    );
  });

  it("handles Windows backslash paths", () => {
    expect(
      windowTitle({ projectPath: "C:\\Users\\u\\proj\\ev-demo.cannet_prj", ...noCapture }),
    ).toBe("ev-demo — cannet 0.9.3");
  });

  it("strips the legacy .json extension too", () => {
    expect(windowTitle({ projectPath: "/home/u/demo.json", ...noCapture })).toBe(
      "demo — cannet 0.9.3",
    );
  });

  it("keeps a dot inside the name, stripping only the last extension", () => {
    expect(windowTitle({ projectPath: "/x/rig.v2.cannet_prj", ...noCapture })).toBe(
      "rig.v2 — cannet 0.9.3",
    );
  });

  it("leaves an extension-less basename as-is", () => {
    expect(windowTitle({ projectPath: "/x/myproject", ...noCapture })).toBe(
      "myproject — cannet 0.9.3",
    );
  });
});

describe("captureLabel", () => {
  const session = (
    interfaces: { id: string; display_name: string }[],
    subscribed: string[],
  ): RemoteStatus => ({
    kind: "running",
    result: {
      address: "127.0.0.1:1",
      interfaces: interfaces.map((i) => ({ ...i, fd_capable: false })),
      subscriptions: subscribed.map((id, n) => ({ interface_id: id, channel: n })),
    },
  });

  it("is null with nothing loaded and nothing connected", () => {
    expect(captureLabel(idle, noSessions)).toBeNull();
  });

  it("is the BLF's basename while a log is streaming", () => {
    const state: LogState = { kind: "running", result: { blf_path: "/logs/drive-cycle.blf" } };
    expect(captureLabel(state, noSessions)).toBe("drive-cycle.blf");
  });

  it("keeps naming the BLF after the replay finishes", () => {
    const state: LogState = {
      kind: "done",
      result: { blf_path: "C:\\logs\\drive-cycle.blf" },
      total: 12,
    };
    expect(captureLabel(state, noSessions)).toBe("drive-cycle.blf");
  });

  it("is null when the last load errored", () => {
    expect(captureLabel({ kind: "error", message: "boom" }, noSessions)).toBeNull();
  });

  it("names the one subscribed interface of a live session", () => {
    const sessions = new Map([
      ["127.0.0.1:1", session([{ id: "pcan0", display_name: "PCAN-USB" }], ["pcan0"])],
    ]);
    expect(captureLabel(idle, sessions)).toBe("PCAN-USB");
  });

  it("counts subscribed interfaces when a session carries more than one", () => {
    const sessions = new Map([
      [
        "127.0.0.1:1",
        session(
          [
            { id: "pcan0", display_name: "PCAN-USB" },
            { id: "pcan1", display_name: "PCAN-USB 2" },
          ],
          ["pcan0", "pcan1"],
        ),
      ],
    ]);
    expect(captureLabel(idle, sessions)).toBe("2 interfaces");
  });

  it("falls back to the interface id when the session doesn't describe it", () => {
    const sessions = new Map([["127.0.0.1:1", session([], ["can0"])]]);
    expect(captureLabel(idle, sessions)).toBe("can0");
  });

  it("ignores sessions that are still connecting", () => {
    const sessions = new Map<string, RemoteStatus>([["127.0.0.1:1", { kind: "connecting" }]]);
    expect(captureLabel(idle, sessions)).toBeNull();
  });

  it("prefers a live session over a previously replayed BLF", () => {
    const state: LogState = { kind: "done", result: { blf_path: "/logs/old.blf" }, total: 1 };
    const sessions = new Map([
      ["127.0.0.1:1", session([{ id: "pcan0", display_name: "PCAN-USB" }], ["pcan0"])],
    ]);
    expect(captureLabel(state, sessions)).toBe("PCAN-USB");
  });
});
