import { describe, expect, it } from "vitest";

import {
  parseChannelId,
  resolveBindingInterface,
} from "./bindingResolution";

describe("parseChannelId", () => {
  it("splits vendor, body, and paren metadata", () => {
    expect(parseChannelId("pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:255)")).toEqual({
      vendor: "pcan",
      body: "PCAN_USBBUS2",
      meta: { h: "0x52", ch: "0", uid: "255" },
    });
  });

  it("parses an id with no metadata parens", () => {
    expect(parseChannelId("virtual:bus0")).toEqual({
      vendor: "virtual",
      body: "bus0",
      meta: {},
    });
  });

  it("parses vector ids whose meta carries a serial", () => {
    expect(parseChannelId("vector:VN1640A(SN:12345, ch:0)")).toEqual({
      vendor: "vector",
      body: "VN1640A",
      meta: { SN: "12345", ch: "0" },
    });
  });

  it("returns null for an id with no vendor separator", () => {
    expect(parseChannelId("PCAN_USBBUS1")).toBeNull();
  });
});

describe("resolveBindingInterface", () => {
  // The field failure this module exists for: the project bound the
  // adapter while it enumerated as USBBUS2; after a replug it came
  // back as USBBUS1 (slot names and the `h:` handle are positional on
  // PCAN), and the exact-string match silently subscribed to nothing.
  const boundUsbbus2 = "pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:255)";
  const attachedUsbbus1 = "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:255)";

  it("reports attached when the exact id is present", () => {
    expect(
      resolveBindingInterface(boundUsbbus2, [
        "pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:255)",
      ]),
    ).toEqual({ kind: "attached" });
  });

  it("rebinds to a unique identity match on a different slot", () => {
    expect(resolveBindingInterface(boundUsbbus2, [attachedUsbbus1])).toEqual({
      kind: "rebound",
      interface: attachedUsbbus1,
    });
  });

  it("uses the controller number to disambiguate dual-channel devices", () => {
    const bound = "pcan:PCAN_USBBUS2(h:0x52, ch:1, uid:7)";
    const chan0 = "pcan:PCAN_USBBUS3(h:0x53, ch:0, uid:7)";
    const chan1 = "pcan:PCAN_USBBUS4(h:0x54, ch:1, uid:7)";
    expect(resolveBindingInterface(bound, [chan0, chan1])).toEqual({
      kind: "rebound",
      interface: chan1,
    });
  });

  it("reports missing when two attached channels share the identity", () => {
    // Two adapters both on the factory-default device id: rebinding
    // to either would be a guess.
    const twinA = "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:255)";
    const twinB = "pcan:PCAN_USBBUS3(h:0x53, ch:0, uid:255)";
    expect(resolveBindingInterface(boundUsbbus2, [twinA, twinB])).toEqual({
      kind: "missing",
    });
  });

  it("reports missing when the identity differs", () => {
    expect(
      resolveBindingInterface(boundUsbbus2, [
        "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:42)",
      ]),
    ).toEqual({ kind: "missing" });
  });

  it("never matches across vendors", () => {
    expect(
      resolveBindingInterface(boundUsbbus2, [
        "kvaser:0(SN:255, ch:0, uid:255)",
      ]),
    ).toEqual({ kind: "missing" });
  });

  it("reports missing when nothing is attached", () => {
    expect(resolveBindingInterface(boundUsbbus2, [])).toEqual({
      kind: "missing",
    });
  });

  it("rebinds vector channels by serial when the body changes", () => {
    const bound = "vector:VN1640A(SN:12345, ch:0)";
    const attached = "vector:VN1640A #2(SN:12345, ch:0)";
    expect(resolveBindingInterface(bound, [attached])).toEqual({
      kind: "rebound",
      interface: attached,
    });
  });

  it("does not rebind an unparseable or meta-less binding", () => {
    expect(
      resolveBindingInterface("pcan:PCAN_USBBUS2", [attachedUsbbus1]),
    ).toEqual({ kind: "missing" });
  });
});
