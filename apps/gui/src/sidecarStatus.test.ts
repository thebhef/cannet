// Pure formatting helper for the "Local sidecar" connection row.
// Renders the same wording the panel's row picks up — the row is
// covered by the dom test in ProjectPanel; this is for the cheap
// per-state coverage.

import { describe, expect, it } from "vitest";

import { describeSidecarStatus } from "./sidecarStatus";

describe("describeSidecarStatus", () => {
  it("names the bound address in the ready state", () => {
    expect(
      describeSidecarStatus({ phase: "ready", address: "127.0.0.1:43891" }),
    ).toBe("listening on 127.0.0.1:43891");
  });

  it("falls back when ready arrived without an address (shouldn't happen, but is non-fatal)", () => {
    expect(describeSidecarStatus({ phase: "ready", address: null })).toBe(
      "listening (address unknown)",
    );
  });

  it("shows the starting hint while we wait for the listening banner", () => {
    expect(describeSidecarStatus({ phase: "starting", address: null })).toBe(
      "starting…",
    );
  });

  it("shows offline when the sidecar is not running", () => {
    expect(describeSidecarStatus({ phase: "offline", address: null })).toBe(
      "offline",
    );
  });
});
