import { describe, expect, it } from "vitest";

import { projectDir, resolveProjectPath } from "./projectPaths";

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
