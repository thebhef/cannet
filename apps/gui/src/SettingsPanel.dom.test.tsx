// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
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
  it("renders the disk-spill cache group and no About section", async () => {
    render(<SettingsPanel {...({} as IDockviewPanelProps)} />);
    expect(await screen.findByText("Disk-spill Cache")).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });
});
