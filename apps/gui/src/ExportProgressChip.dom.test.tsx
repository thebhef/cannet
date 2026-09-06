// @vitest-environment jsdom
//
// The status-bar chip for a background export: what it says while the
// write runs, the way out of it, and the brief "done" state that
// replaces it. The numbers are the host's — the chip only draws them.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ExportProgressChip } from "./ExportProgressChip";

afterEach(cleanup);

describe("ExportProgressChip", () => {
  it("names the file and how far the write has got", () => {
    render(
      <ExportProgressChip
        status={{ phase: "running", name: "run.blf", written: 250, total: 1000 }}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByTestId("export-chip")).toHaveTextContent("Exporting run.blf — 25%");
  });

  it("reports an export whose size it does not know yet without a percentage", () => {
    // A denominator of zero is a real state (an empty capture, or the
    // first report before the writer's counting pass finished); a bar
    // pinned at zero would claim a measurement nobody has made.
    render(
      <ExportProgressChip
        status={{ phase: "running", name: "run.blf", written: 0, total: 0 }}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("export-chip")).toHaveTextContent("Exporting run.blf");
  });

  it("offers a cancel while it runs", () => {
    const onCancel = vi.fn();
    render(
      <ExportProgressChip
        status={{ phase: "running", name: "run.blf", written: 1, total: 4 }}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("settles into a done state with nothing left to cancel", () => {
    render(
      <ExportProgressChip status={{ phase: "done", name: "run.blf" }} onCancel={() => {}} />,
    );
    expect(screen.getByTestId("export-chip")).toHaveTextContent("Exported run.blf");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
