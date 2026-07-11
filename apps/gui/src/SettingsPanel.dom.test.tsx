// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "app_version":
        return "v0.1.0-3-gabc1234";
      case "get_settings":
        return { scratch_cap_bytes: null, clear_scratch_on_exit: false };
      default:
        return null;
    }
  }),
}));

import type { IDockviewPanelProps } from "dockview";

import { SettingsPanel } from "./SettingsPanel";

afterEach(cleanup);

describe("SettingsPanel", () => {
  it("shows the build version in the About section", async () => {
    render(<SettingsPanel {...({} as IDockviewPanelProps)} />);
    expect(await screen.findByText("v0.1.0-3-gabc1234")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
  });
});
