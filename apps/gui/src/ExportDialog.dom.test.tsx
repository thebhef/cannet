// @vitest-environment jsdom
//
// The export dialog: the name template and its live preview, the range
// picker's three ways of setting a bound (typed, event, preset), the
// informational wall-time labels for the capture's ends, and what the
// dialog hands back when Export… is pressed.
//
// The preview is the host's — the dialog asks `preview_export_template`
// and renders the answer, never resolving a token in JS — so the invoke
// mock here is what stands in for that command.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let previewReply: {
  resolved: string | null;
  error: string | null;
  startResolvedAsNow: boolean;
} = { resolved: "ev-zonal-20260905T091502-0600", error: null, startResolvedAsNow: false };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
    if (cmd === "preview_export_template") return previewReply;
    return null;
  }),
}));

import { ExportDialog } from "./ExportDialog";
import { clearPlotWindow, publishPlotWindow } from "./plotWindow";
import type { ExportRangeSelection } from "./exportRange";

/// 2026-09-05T09:15:02 local; the capture runs an hour.
const START = new Date(2026, 8, 5, 9, 15, 2).getTime() / 1000;
const DURATION = 3600;

const EVENTS = [
  { id: "e1", label: "fault injected", seconds: 1028 },
  { id: "e2", label: "recovery start", seconds: 1613 },
];

let exported: { nameTemplate: string; range: ExportRangeSelection } | null = null;
let cancelled = false;

function mount(over: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  return render(
    <ExportDialog
      project="EV Zonal Demo"
      nameTemplate="{project}-{start}"
      format="blf"
      extent={{
        sessionStartSeconds: START,
        firstSeconds: START,
        liveEdgeSeconds: START + DURATION,
        frameCount: 1_000,
      }}
      events={EVENTS}
      onCancel={() => {
        cancelled = true;
      }}
      onExport={(choice) => {
        exported = choice;
      }}
      {...over}
    />,
  );
}

/// The dialog's first preview lands asynchronously; wait it out so a
/// case never asserts against the pre-preview blank.
async function mounted(over: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  mount(over);
  await waitFor(() => {
    if (invokeCalls.every((c) => c.cmd !== "preview_export_template")) {
      throw new Error("no preview requested yet");
    }
  });
}

beforeEach(() => {
  invokeCalls.length = 0;
  exported = null;
  cancelled = false;
  clearPlotWindow();
  previewReply = {
    resolved: "ev-zonal-20260905T091502-0600",
    error: null,
    startResolvedAsNow: false,
  };
});

afterEach(cleanup);

describe("the name template", () => {
  it("starts from the template it was given", async () => {
    await mounted();
    expect(screen.getByLabelText("Export name template")).toHaveValue("{project}-{start}");
  });

  it("resolves the preview through the host, with the format's extension", async () => {
    await mounted();
    await waitFor(() => {
      expect(screen.getByTestId("export-preview")).toHaveTextContent(
        "ev-zonal-20260905T091502-0600.blf",
      );
    });
    const preview = invokeCalls.find((c) => c.cmd === "preview_export_template");
    expect(preview?.args).toMatchObject({
      template: "{project}-{start}",
      project: "EV Zonal Demo",
      startSeconds: START,
      isFolder: false,
    });
  });

  it("shows the host's message for a template it rejects, and refuses to export", async () => {
    previewReply = {
      resolved: null,
      error: '"{when}" is not a token this template understands',
      startResolvedAsNow: false,
    };
    await mounted();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("is not a token");
    });
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
  });

  it("says so when {start} had no wall clock to resolve against", async () => {
    previewReply = {
      resolved: "ev-zonal-20260905T091502-0600",
      error: null,
      startResolvedAsNow: true,
    };
    await mounted();
    await waitFor(() => {
      expect(screen.getByTestId("export-note")).toHaveTextContent("no wall-clock anchor");
    });
  });
});

describe("the capture's ends", () => {
  it("labels both ends with their wall-clock date and time", async () => {
    await mounted();
    // Informational only — the bounds themselves stay empty.
    expect(screen.getByTestId("export-extent-start").textContent).toMatch(/2026/);
    expect(screen.getByTestId("export-extent-end").textContent).toMatch(/2026/);
  });

  it("labels them relatively when the capture has no anchor", async () => {
    await mounted({
      extent: {
        sessionStartSeconds: 0,
        firstSeconds: 0,
        liveEdgeSeconds: DURATION,
        frameCount: 10,
      },
    });
    expect(screen.getByTestId("export-extent-start")).toHaveTextContent("trace start");
    expect(screen.getByTestId("export-extent-end")).toHaveTextContent("3600 s");
  });
});

describe("the range picker", () => {
  it("exports the whole capture when neither bound is touched", async () => {
    await mounted();
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: null, to: null });
  });

  it("takes a wall clock typed into a bound", async () => {
    await mounted();
    const from = screen.getByLabelText("Export range start");
    fireEvent.change(from, { target: { value: "09:20" } });
    fireEvent.keyDown(from, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: 298, to: null });
  });

  it("takes seconds from the capture's start typed into a bound", async () => {
    await mounted();
    const to = screen.getByLabelText("Export range end");
    fireEvent.change(to, { target: { value: "90.5" } });
    fireEvent.keyDown(to, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: null, to: 90.5 });
  });

  it("takes a day-prefixed wall clock on a capture that spans days", async () => {
    // A four-day capture: a bound past the first midnight is only
    // reachable in the clock form once the day is part of it.
    const FOUR_DAYS = 4 * 86_400;
    await mounted({
      extent: {
        sessionStartSeconds: START,
        firstSeconds: START,
        liveEdgeSeconds: START + FOUR_DAYS,
        frameCount: 1_000,
      },
    });
    const from = screen.getByLabelText("Export range start");
    fireEvent.change(from, { target: { value: "3d 12:30" } });
    fireEvent.keyDown(from, { key: "Enter" });
    const expected = new Date(2026, 8, 8, 12, 30, 0).getTime() / 1000 - START;
    await waitFor(() => {
      expect(from).toHaveValue("3d 12:30:00");
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: expected, to: null });
  });

  it("refuses a wall clock on an unanchored capture", async () => {
    await mounted({
      extent: {
        sessionStartSeconds: 0,
        firstSeconds: 0,
        liveEdgeSeconds: DURATION,
        frameCount: 10,
      },
    });
    const from = screen.getByLabelText("Export range start");
    fireEvent.change(from, { target: { value: "09:20" } });
    fireEvent.keyDown(from, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("export-range-error")).toHaveTextContent("seconds");
    });
    expect(exported).toBeNull();
  });

  it("offers the capture's events as bounds, and shows a bound on one as the event", async () => {
    await mounted();
    fireEvent.click(screen.getByRole("button", { name: "Export range end options" }));
    fireEvent.click(screen.getByText(/fault injected/));
    await waitFor(() => {
      expect(screen.getByLabelText("Export range end")).toHaveValue(
        "fault injected (09:32:10)",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: null, to: 1028 });
  });

  it("renders one tick per event, and a click sets the nearer bound", async () => {
    await mounted();
    const ticks = screen.getAllByTestId("export-range-tick");
    expect(ticks).toHaveLength(2);
    // 1613 s into a 3600 s capture is left of the midpoint, so it is the
    // start bound that moves.
    fireEvent.click(ticks[1]);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: 1613, to: null });
  });

  it("applies a trailing preset, leaving the end at the live edge", async () => {
    await mounted();
    fireEvent.change(screen.getByLabelText("Export range presets"), {
      target: { value: "5m" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: DURATION - 300, to: null });
  });

  it("takes the plot's window when a plot has published one", async () => {
    publishPlotWindow(600, 900);
    await mounted();
    fireEvent.change(screen.getByLabelText("Export range presets"), {
      target: { value: "plot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: 600, to: 900 });
  });

  it("moves a bound from the keyboard", async () => {
    // The handles are focusable, so they answer the arrow keys — a
    // focusable control that does nothing on a key press is a defect.
    await mounted();
    const handle = screen.getByRole("slider", { name: "Export range start marker" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range.from).toBeCloseTo(DURATION / 100, 5);
    expect(exported?.range.to).toBeNull();
  });

  it("returns a bound to its default with Home / End", async () => {
    await mounted();
    const handle = screen.getByRole("slider", { name: "Export range start marker" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.range).toEqual({ from: null, to: null });
  });
});

describe("focus and dismissal", () => {
  it("dismisses on Escape without exporting", async () => {
    await mounted();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(cancelled).toBe(true);
    expect(exported).toBeNull();
  });

  it("hands back the template it was edited to, so it can be remembered", async () => {
    await mounted();
    fireEvent.change(screen.getByLabelText("Export name template"), {
      target: { value: "{project}-{now}" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(exported?.nameTemplate).toBe("{project}-{now}");
  });
});
