// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "app_version":
        return "v0.1.0-3-gabc1234";
      case "third_party_licenses":
        return "python-can — LGPL-3.0-only\nFAKE LICENSE TEXT BODY";
      default:
        return null;
    }
  }),
}));

import type { IDockviewPanelProps } from "dockview";

import { AboutPanel } from "./AboutPanel";

afterEach(cleanup);

describe("AboutPanel", () => {
  it("shows the build version", async () => {
    render(<AboutPanel {...({} as IDockviewPanelProps)} />);
    expect(await screen.findByText("v0.1.0-3-gabc1234")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
  });

  it("renders the third-party licenses text", async () => {
    render(<AboutPanel {...({} as IDockviewPanelProps)} />);
    expect(
      await screen.findByText(/FAKE LICENSE TEXT BODY/),
    ).toBeInTheDocument();
    expect(screen.getByText("Third-party licenses")).toBeInTheDocument();
  });
});
