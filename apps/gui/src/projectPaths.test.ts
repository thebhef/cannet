import { describe, expect, it } from "vitest";

import {
  projectDir,
  relativizeProjectPath,
  resolveProjectPath,
} from "./projectPaths";

describe("projectDir", () => {
  it("strips the basename from a POSIX path", () => {
    expect(projectDir("/home/u/proj/ev-demo.cannet_prj")).toBe("/home/u/proj");
  });

  it("strips the basename from a Windows path", () => {
    expect(projectDir("C:\\Users\\u\\proj\\ev-demo.cannet_prj")).toBe(
      "C:\\Users\\u\\proj",
    );
  });

  it("returns empty when there is no separator", () => {
    expect(projectDir("ev-demo.cannet_prj")).toBe("");
  });
});

describe("resolveProjectPath", () => {
  it("joins a relative path onto a POSIX directory", () => {
    expect(resolveProjectPath("/home/u/proj", "dbc/vcu.dbc")).toBe(
      "/home/u/proj/dbc/vcu.dbc",
    );
  });

  it("joins a relative path onto a Windows directory with its separator", () => {
    expect(resolveProjectPath("C:\\Users\\u\\proj", "dbc/vcu.dbc")).toBe(
      "C:\\Users\\u\\proj\\dbc/vcu.dbc",
    );
  });

  it("passes an absolute POSIX path through unchanged", () => {
    expect(resolveProjectPath("/home/u/proj", "/etc/shared/bus.dbc")).toBe(
      "/etc/shared/bus.dbc",
    );
  });

  it("passes an absolute Windows path through unchanged", () => {
    expect(resolveProjectPath("C:\\proj", "D:\\shared\\bus.dbc")).toBe(
      "D:\\shared\\bus.dbc",
    );
  });

  it("passes the empty path through unchanged", () => {
    expect(resolveProjectPath("/home/u/proj", "")).toBe("");
  });

  it("returns the path as-is when there is no project directory", () => {
    expect(resolveProjectPath("", "dbc/vcu.dbc")).toBe("dbc/vcu.dbc");
  });
});

describe("relativizeProjectPath", () => {
  it("stores a file inside the project directory relative to it", () => {
    expect(
      relativizeProjectPath("/home/u/proj", "/home/u/proj/dbc/vcu.dbc"),
    ).toBe("dbc/vcu.dbc");
  });

  it("stores a Windows file inside the project directory with forward slashes", () => {
    // Forward slashes are what the checked-in examples use and what
    // `resolveProjectPath` joins back onto a directory of either style.
    expect(
      relativizeProjectPath(
        "C:\\Users\\u\\proj",
        "C:\\Users\\u\\proj\\dbc\\vcu.dbc",
      ),
    ).toBe("dbc/vcu.dbc");
  });

  it("matches a Windows path case-insensitively", () => {
    expect(
      relativizeProjectPath("C:\\Users\\u\\proj", "c:\\users\\u\\proj\\a.dbc"),
    ).toBe("a.dbc");
  });

  it("leaves a file outside the project directory absolute", () => {
    // There is nothing to anchor it to — a relative reference that
    // climbed out would break the moment the directory moved.
    expect(relativizeProjectPath("/home/u/proj", "/etc/shared/bus.dbc")).toBe(
      "/etc/shared/bus.dbc",
    );
    expect(relativizeProjectPath("C:\\proj", "D:\\shared\\bus.dbc")).toBe(
      "D:\\shared\\bus.dbc",
    );
  });

  it("is not fooled by a sibling directory sharing the prefix", () => {
    expect(
      relativizeProjectPath("/home/u/proj", "/home/u/proj-old/bus.dbc"),
    ).toBe("/home/u/proj-old/bus.dbc");
  });

  it("leaves an already-relative path, the empty path, and no directory alone", () => {
    expect(relativizeProjectPath("/home/u/proj", "dbc/vcu.dbc")).toBe(
      "dbc/vcu.dbc",
    );
    expect(relativizeProjectPath("/home/u/proj", "")).toBe("");
    expect(relativizeProjectPath("", "/home/u/proj/a.dbc")).toBe(
      "/home/u/proj/a.dbc",
    );
  });

  it("round-trips through resolveProjectPath", () => {
    // The property that makes a project directory movable: what a save
    // stores, an open resolves back to the same file.
    for (const [dir, abs] of [
      ["/home/u/proj", "/home/u/proj/dbc/vcu.dbc"],
      ["/home/u/proj", "/elsewhere/vcu.dbc"],
    ]) {
      expect(resolveProjectPath(dir, relativizeProjectPath(dir, abs))).toBe(
        abs,
      );
    }
  });
});
