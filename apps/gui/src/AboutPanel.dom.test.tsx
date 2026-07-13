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
        return [
          {
            component: "python-can sidecar",
            dependencies: [
              {
                name: "uptime",
                version: "3.0.1",
                spdx: "BSD-2-Clause",
                origin: "python",
                licenseText: "FAKE LICENSE TEXT BODY",
              },
            ],
          },
        ];
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

  it("renders the component and its dependency license text", async () => {
    render(<AboutPanel {...({} as IDockviewPanelProps)} />);
    // Component summary carries the name + dependency count.
    expect(
      await screen.findByText(/python-can sidecar \(1\)/),
    ).toBeInTheDocument();
    expect(screen.getByText("Third-party licenses")).toBeInTheDocument();
    // The dep summary and its verbatim text are in the DOM regardless of
    // whether the <details> are open.
    expect(screen.getByText(/uptime 3\.0\.1/)).toBeInTheDocument();
    expect(screen.getByText(/FAKE LICENSE TEXT BODY/)).toBeInTheDocument();
  });
});
