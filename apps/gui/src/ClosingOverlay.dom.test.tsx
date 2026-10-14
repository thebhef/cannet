// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ClosingOverlay, closingStepText } from "./ClosingOverlay";

describe("closingStepText", () => {
  it("names every step, with a figure where the step has one", () => {
    expect(closingStepText({ step: "disconnecting" })).toBe("disconnecting…");
    expect(closingStepText({ step: "finishing_loggers" })).toBe("finishing loggers…");
    expect(closingStepText({ step: "clearing_capture" })).toBe("clearing the capture cache…");
    expect(closingStepText({ step: "writing_capture", bytes: null })).toBe(
      "writing the capture cache…",
    );
    expect(closingStepText({ step: "writing_capture", bytes: 512 * 1024 ** 2 })).toBe(
      "writing the capture cache (512 MB)…",
    );
    // No count until the host knows how many signals there are.
    expect(closingStepText({ step: "writing_signals", done: 0, total: 0 })).toBe(
      "writing the signal cache…",
    );
    expect(closingStepText({ step: "writing_signals", done: 3, total: 7 })).toBe(
      "writing the signal cache (3 of 7 signals)…",
    );
  });
});

describe("ClosingOverlay", () => {
  afterEach(cleanup);

  it("reads as a status, not a dialog, and offers nothing to press", () => {
    render(<ClosingOverlay progress={{ step: "finishing_loggers" }} />);
    const overlay = screen.getByRole("status");
    expect(overlay).toHaveTextContent("Closing — finishing loggers…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps keys from reaching the command keybindings while it is up", () => {
    const binding = vi.fn();
    document.addEventListener("keydown", binding, true);
    const { unmount } = render(<ClosingOverlay progress={{ step: "disconnecting" }} />);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true }));
    expect(binding).not.toHaveBeenCalled();
    unmount();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true }));
    expect(binding).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", binding, true);
  });
});
