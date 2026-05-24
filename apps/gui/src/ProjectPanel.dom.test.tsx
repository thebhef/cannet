// @vitest-environment jsdom
//
// Surfaces only the "Use local sidecar" / "add a network server"
// branching the connection panel now exposes — the rest of the panel
// is covered by the project / element registry tests. The sidecar's
// bound address arrives via the `sidecarAddress` prop on
// `NewBindingForm`; this confirms the affordance is disabled when
// the sidecar isn't ready and enabled (with the right title text)
// once it is.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

import { NewBindingForm, uniqueRemoteServers } from "./ProjectPanel";
import type { Bus, InterfaceBinding } from "./types";

const BUSES: Bus[] = [{ id: "b1", name: "Bus 1" }];

afterEach(cleanup);

describe("uniqueRemoteServers", () => {
  it("returns first-seen distinct server addresses", () => {
    const bindings: InterfaceBinding[] = [
      { server: "10.0.0.1:50051", interface: "can0", bus_id: "b1" },
      { server: "10.0.0.2:50051", interface: "can0", bus_id: "b2" },
      { server: "10.0.0.1:50051", interface: "can1", bus_id: "b3" },
    ];
    expect(uniqueRemoteServers(bindings, null)).toEqual([
      "10.0.0.1:50051",
      "10.0.0.2:50051",
    ]);
  });

  it("hides the sidecar's address (it has its own dedicated row)", () => {
    const bindings: InterfaceBinding[] = [
      { server: "127.0.0.1:43891", interface: "vector:ch0", bus_id: "b1" },
      { server: "10.0.0.1:50051", interface: "can0", bus_id: "b2" },
    ];
    expect(uniqueRemoteServers(bindings, "127.0.0.1:43891")).toEqual([
      "10.0.0.1:50051",
    ]);
  });
});

describe("NewBindingForm — Use local sidecar branch", () => {
  it("disables 'Use local sidecar' while the sidecar is not ready", () => {
    render(
      <NewBindingForm
        buses={BUSES}
        bindings={[]}
        onAdd={() => {}}
        sidecarAddress={null}
      />,
    );
    const btn = screen.getByRole("button", { name: "Use local sidecar" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Local sidecar is not ready yet");
  });

  it("prefills the server field with the sidecar address on click", () => {
    render(
      <NewBindingForm
        buses={BUSES}
        bindings={[]}
        onAdd={() => {}}
        sidecarAddress="127.0.0.1:43891"
      />,
    );
    const serverInput = screen.getByLabelText("server address") as HTMLInputElement;
    // Default is the canned `cannet-server` address — confirms our
    // "click → overwrite" semantic is doing real work.
    expect(serverInput.value).toBe("127.0.0.1:50051");
    fireEvent.click(screen.getByRole("button", { name: "Use local sidecar" }));
    expect(serverInput.value).toBe("127.0.0.1:43891");
  });

  it("marks 'Use local sidecar' pressed (and disables it) once the form is already pointed at the sidecar", () => {
    render(
      <NewBindingForm
        buses={BUSES}
        bindings={[]}
        onAdd={() => {}}
        sidecarAddress="127.0.0.1:43891"
      />,
    );
    const btn = screen.getByRole("button", { name: "Use local sidecar" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toBeDisabled();
  });
});
