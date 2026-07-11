import { describe, expect, it } from "vitest";

import { windowTitle } from "./windowTitle";

describe("windowTitle", () => {
  it("is the bare app name with no project open", () => {
    expect(windowTitle(null)).toBe("cannet");
  });

  it("uses the project file's basename without its extension", () => {
    expect(windowTitle("/x/Bench Rig.cannet_prj")).toBe("Bench Rig — cannet");
  });

  it("handles Windows backslash paths", () => {
    expect(windowTitle("C:\\Users\\u\\proj\\ev-demo.cannet_prj")).toBe(
      "ev-demo — cannet",
    );
  });

  it("strips the legacy .json extension too", () => {
    expect(windowTitle("/home/u/demo.json")).toBe("demo — cannet");
  });

  it("keeps a dot inside the name, stripping only the last extension", () => {
    expect(windowTitle("/x/rig.v2.cannet_prj")).toBe("rig.v2 — cannet");
  });

  it("leaves an extension-less basename as-is", () => {
    expect(windowTitle("/x/myproject")).toBe("myproject — cannet");
  });
});
