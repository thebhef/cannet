import { describe, expect, it } from "vitest";

import { messageEcuKey, messageEcuLookup, signalRowLabel } from "./plotSignalLabel";
import type { SignalDescriptorRecord } from "./types";

const desc = (o: Partial<SignalDescriptorRecord>): SignalDescriptorRecord => ({
  bus_id: null,
  message_id: 256,
  extended: false,
  message_name: "EngineData",
  transmitter: "EngineEcu",
  signal_name: "EngineSpeed",
  unit: "rpm",
  ...o,
});

describe("signalRowLabel", () => {
  it("names the message by its full DBC ancestry", () => {
    // The same bus · ecu · message the DBC panel's tree shows, so a
    // signal row and the tree it came from read the same.
    expect(signalRowLabel("Powertrain", "EngineEcu", "EngineData")).toBe(
      "Powertrain · EngineEcu · EngineData",
    );
  });

  it("drops a segment it has nothing to put in", () => {
    // Unlike the ADR 0038 pattern subject (`signalPath`), where an
    // absent segment still renders so positions stay fixed, this is a
    // label — an empty segment would just read as a stray separator.
    expect(signalRowLabel(null, "EngineEcu", "EngineData")).toBe("EngineEcu · EngineData");
    expect(signalRowLabel("Powertrain", null, "EngineData")).toBe("Powertrain · EngineData");
    expect(signalRowLabel(null, null, "EngineData")).toBe("EngineData");
    // A DBC's `Vector__XXX` placeholder reaches us as an empty string
    // in some paths; treat it the same as absent.
    expect(signalRowLabel("Powertrain", "", "EngineData")).toBe("Powertrain · EngineData");
  });
});

describe("messageEcuLookup", () => {
  it("resolves a signal's transmitting ECU from the catalog", () => {
    const m = messageEcuLookup([desc({}), desc({ signal_name: "EngineTemp" })]);
    expect(m.get(messageEcuKey(null, 256, false))).toBe("EngineEcu");
  });

  it("keeps the same message on two buses apart", () => {
    // `list_signals` expands an unscoped DBC per project bus, and two
    // buses can carry the same id from different ECUs.
    const m = messageEcuLookup([
      desc({ bus_id: "b1", transmitter: "EngineEcu" }),
      desc({ bus_id: "b2", transmitter: "GatewayEcu" }),
    ]);
    expect(m.get(messageEcuKey("b1", 256, false))).toBe("EngineEcu");
    expect(m.get(messageEcuKey("b2", 256, false))).toBe("GatewayEcu");
  });

  it("distinguishes an extended id from a standard one", () => {
    const m = messageEcuLookup([
      desc({ transmitter: "EngineEcu" }),
      desc({ extended: true, transmitter: "GatewayEcu" }),
    ]);
    expect(m.get(messageEcuKey(null, 256, false))).toBe("EngineEcu");
    expect(m.get(messageEcuKey(null, 256, true))).toBe("GatewayEcu");
  });

  it("has no entry for a message whose DBC names no sender", () => {
    // `Vector__XXX` arrives as null; the row then shows bus · message.
    const m = messageEcuLookup([desc({ transmitter: null })]);
    expect(m.has(messageEcuKey(null, 256, false))).toBe(false);
  });
});
