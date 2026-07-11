// @vitest-environment jsdom
//
// Verifies the BLF channel-map modal's default seeding: channel N
// defaults to project bus at position N (matching the bus order the
// host writes captures with — see CLAUDE.md § File formats). Channels
// past the bus list default to "skip".

import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { BlfChannelMapModal } from "./BlfChannelMapModal";
import type { Bus } from "./types";

afterEach(cleanup);

const noop = () => {};

const buses: Bus[] = [
  { id: "p", name: "Powertrain" },
  { id: "c", name: "Chassis" },
];

describe("BlfChannelMapModal", () => {
  it("seeds each channel to the project bus at the matching index", () => {
    render(
      <BlfChannelMapModal
        blfPath="/tmp/cap.blf"
        channels={[0, 1]}
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
        channels={[0, 1, 2]}
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
        channels={[0, 1]}
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
});
