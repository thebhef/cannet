// @vitest-environment jsdom
//
// Verifies the BLF channel-map modal's default seeding (channel N
// defaults to project bus at position N — see CLAUDE.md § File
// formats), the capture metadata line, the collapsible markers
// gridview, and the selectable import time range (ADR 0046).

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BlfChannelMapModal } from "./BlfChannelMapModal";
import type { BlfScanResult, Bus } from "./types";
import type { Note } from "./notes";

afterEach(cleanup);

const noop = () => {};

const buses: Bus[] = [
  { id: "p", name: "Powertrain" },
  { id: "c", name: "Chassis" },
];

function scanFixture(overrides: Partial<BlfScanResult> = {}): BlfScanResult {
  return {
    channels: [0, 1],
    frame_count: 2,
    first_timestamp_ns: 1_000_000_000,
    last_timestamp_ns: 1_005_000_000,
    start_unix_nanos: 1_700_000_000_000_000_000,
    markers: [],
    ...overrides,
  };
}

describe("BlfChannelMapModal", () => {
  it("seeds each channel to the project bus at the matching index", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture()}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const ch0 = screen.getByLabelText("channel 0 bus") as HTMLButtonElement;
    const ch1 = screen.getByLabelText("channel 1 bus") as HTMLButtonElement;
    expect(ch0.value).toBe("p");
    expect(ch1.value).toBe("c");
  });

  it("defaults to 'skip' for channels past the bus list", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({ channels: [0, 1, 2] })}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const ch2 = screen.getByLabelText("channel 2 bus") as HTMLButtonElement;
    expect(ch2.value).toBe("");
  });

  it("explicit `initial` overrides the per-index default", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture()}
        buses={buses}
        initial={{ 0: "c", 1: "" }}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const ch0 = screen.getByLabelText("channel 0 bus") as HTMLButtonElement;
    const ch1 = screen.getByLabelText("channel 1 bus") as HTMLButtonElement;
    expect(ch0.value).toBe("c");
    expect(ch1.value).toBe("");
  });

  it("shows the capture's frame count and duration from the scan", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({
          frame_count: 12_345,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000 + 65_000_000_000, // 65 s span
        })}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByText(/12,345/)).toBeInTheDocument();
    expect(screen.getByText(/1:05\.000/)).toBeInTheDocument();
  });

  it("shows the capture's wall-clock start", () => {
    // Noon UTC keeps the local rendering in the same calendar year across
    // any timezone the test runs in.
    const startUnixNanos = Date.UTC(2024, 5, 15, 12, 0, 0) * 1_000_000;
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({ start_unix_nanos: startUnixNanos })}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByText(/2024/)).toBeInTheDocument();
  });

  it("hides the markers section when the scan found none", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({ markers: [] })}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.queryByText(/Markers/)).not.toBeInTheDocument();
  });

  it("markers gridview starts collapsed and expands on toggle", () => {
    const marker: Note = {
      id: "m1",
      timestampNs: 1_000_000_000 + 2_000_000_000, // 2 s after capture start
      label: "Event A",
    };
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({ markers: [marker] })}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.queryByText("Event A")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Markers \(1\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Event A")).toBeInTheDocument();
    expect(screen.getByText(/2\.000/)).toBeInTheDocument();
  });

  it("defaults the time range to the full span and reports no filter on confirm", () => {
    const onConfirm = vi.fn();
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000 + 65_000_000_000,
        })}
        buses={buses}
        onConfirm={onConfirm}
        onCancel={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, range] = onConfirm.mock.calls[0];
    expect(range).toEqual({ startNs: null, endNs: null });
  });

  it("narrowing the range reports the absolute start/end nanoseconds on confirm", () => {
    const onConfirm = vi.fn();
    const first = 1_000_000_000;
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture({
          first_timestamp_ns: first,
          last_timestamp_ns: first + 65_000_000_000,
        })}
        buses={buses}
        onConfirm={onConfirm}
        onCancel={noop}
      />,
    );
    fireEvent.change(screen.getByLabelText("import start seconds"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("import end seconds"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, range] = onConfirm.mock.calls[0];
    expect(range).toEqual({
      startNs: first + 10_000_000_000,
      endNs: first + 60_000_000_000,
    });
  });

  it("defaults the title to BLF, and switches to MDF when asked", () => {
    const { rerender } = render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        scan={scanFixture()}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByText("Map BLF channels to logical buses")).toBeInTheDocument();

    rerender(
      <BlfChannelMapModal
        blfPath="/tmp/cap.mf4"
        scan={scanFixture()}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
        format="MDF"
      />,
    );
    expect(screen.getByText("Map MDF channels to logical buses")).toBeInTheDocument();
  });

  it("lists skipped per-message decoded groups when given any, and hides the section otherwise", () => {
    const { rerender } = render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.mf4"
        scan={scanFixture()}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
        format="MDF"
      />,
    );
    expect(screen.queryByText(/already covered/)).not.toBeInTheDocument();

    rerender(
      <BlfChannelMapModal
        blfPath="/tmp/cap.mf4"
        scan={scanFixture()}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
        format="MDF"
        skippedDecodedGroups={[
          { source_path: "CAN1.CAN_DataFrame.ID=0x100 EXT=False", name: "Engine", signal_count: 2 },
          { source_path: "CAN1.CAN_DataFrame.ID=0x1a5 EXT=False", name: null, signal_count: 1 },
        ]}
      />,
    );
    expect(screen.getByText(/2 per-message decoded groups/)).toBeInTheDocument();
    expect(screen.getByText(/Engine \(2 signals\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/CAN1\.CAN_DataFrame\.ID=0x1a5 EXT=False \(1 signal\)/),
    ).toBeInTheDocument();
  });

  it("shows a not-imported-yet notice for message-independent signal groups", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.mf4"
        scan={scanFixture()}
        buses={buses}
        onConfirm={noop}
        onCancel={noop}
        format="MDF"
        signalGroupCount={3}
      />,
    );
    expect(
      screen.getByText(/3 message-independent signal groups found; not imported yet\./),
    ).toBeInTheDocument();
  });
});
