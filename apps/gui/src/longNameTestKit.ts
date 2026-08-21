/// Shared fixtures and the one assertion for the long-name rendering
/// tests scattered across the panel suites.
///
/// The names are the ones `examples/ev-zonal` carries, so a test here
/// and a by-eye look at the example project are looking at the same
/// strings.

import { expect } from "vitest";

/// 45 characters, 13 past the classic DBC identifier limit.
export const LONG_SIGNAL_NAME = "HighVoltageBatteryPackCoolantInletTemperature";
/// The tail `LONG_SIGNAL_NAME` must keep whatever the column's width.
export const LONG_SIGNAL_TAIL = "Temperature";
/// 44 characters.
export const LONG_MESSAGE_NAME = "CentralComputeThermalDerateAdvisoryBroadcast";
export const LONG_MESSAGE_TAIL = "Broadcast";
/// A `VAL_` label — no DBC rule bounds these at all.
export const LONG_ENUM_LABEL = "TractionInverterStatorWindingOverTemperature";

/// Assert that `root` renders `name` the way a long name has to render:
/// split so the shrinkable half is the head, the distinguishing tail
/// kept whole, and the full text reachable as a tooltip.
export function expectMiddleEllipsis(root: Element | null, name: string, tail: string): void {
  expect(root, "no element to look in").not.toBeNull();
  const box = root!.classList?.contains("name-text")
    ? root!
    : root!.querySelector(".name-text");
  expect(box, `no .name-text for ${name}`).not.toBeNull();
  expect(box!.getAttribute("title")).toContain(name);
  expect(box!.querySelector(".name-text-head")!.textContent).toBe(name.slice(0, -tail.length));
  expect(box!.querySelector(".name-text-tail")!.textContent).toBe(tail);
  expect(box!.textContent).toBe(name);
}
