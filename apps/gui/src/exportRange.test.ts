// The export dialog's range arithmetic: what a typed bound means, how a
// bound reads back, which preset produces which selection, and what
// crosses the wire to `save_capture`.
//
// All of it is pure and lives here rather than in the dialog, because a
// bound is one of three things — a wall clock, an offset from the
// capture's start, or the bound's own default — and the rules for
// telling them apart are worth pinning independently of any DOM.

import { describe, expect, it } from "vitest";

import {
  WHOLE_CAPTURE,
  applyRangePreset,
  boundText,
  eventAtBound,
  exportRangeNs,
  formatRangeBound,
  parseRangeBound,
  rangeSpanSeconds,
  type RangeEvent,
} from "./exportRange";

/// 2026-09-05T09:15:02 local, the prototype's capture start.
const START = new Date(2026, 8, 5, 9, 15, 2).getTime() / 1000;
const DURATION = 3600;

const anchored = {
  anchored: true,
  sessionStartSeconds: START,
  durationSeconds: DURATION,
};
const unanchored = {
  anchored: false,
  sessionStartSeconds: 0,
  durationSeconds: DURATION,
};
/// The same start, on a capture that runs for four days — where a bound
/// past the first midnight is a real thing to want.
const multiDay = {
  anchored: true,
  sessionStartSeconds: START,
  durationSeconds: 4 * 86_400,
};

/// 12:30 on the fourth calendar day of that capture, as an offset from
/// its start. Written as the instant it is rather than as arithmetic, so
/// the expectation survives a DST transition inside the span.
const DAY3_AT_1230 = new Date(2026, 8, 8, 12, 30, 0).getTime() / 1000 - START;

const EVENTS: RangeEvent[] = [
  { id: "e1", label: "fault injected", seconds: 1028 },
  { id: "e2", label: "recovery start", seconds: 1613 },
];

describe("parseRangeBound", () => {
  it("reads an empty field as the bound's default", () => {
    expect(parseRangeBound("", anchored)).toBeNull();
    expect(parseRangeBound("   ", anchored)).toBeNull();
  });

  it("reads a bare number as seconds from the capture's start", () => {
    expect(parseRangeBound("90", anchored)).toBe(90);
    expect(parseRangeBound("12.5", anchored)).toBe(12.5);
  });

  it("reads HH:MM and HH:MM:SS as wall clock on the capture's timeline", () => {
    // 09:15:02 start, so 09:20 is 298 s in and 09:20:30 is 328 s in.
    expect(parseRangeBound("09:20", anchored)).toBe(298);
    expect(parseRangeBound("9:20:30", anchored)).toBe(328);
  });

  it("rolls a wall clock earlier than the start onto the next day", () => {
    // A capture that starts at 09:15 and runs past midnight: 00:30 is
    // the following morning, not fifteen hours before the capture began.
    // 86400 − 09:15:02 + 00:30:00
    expect(parseRangeBound("00:30", anchored)).toBe(86_400 - 33_302 + 1_800);
  });

  it("reads a day-prefixed wall clock on a capture that spans days", () => {
    // A four-day capture cannot be addressed past its first midnight in
    // bare HH:MM:SS — every clock resolves inside the first 24 hours.
    // The day index counts calendar days from the capture's start date.
    expect(parseRangeBound("3d 12:30", multiDay)).toBe(DAY3_AT_1230);
    expect(parseRangeBound("3d 12:30:00", multiDay)).toBe(DAY3_AT_1230);
    expect(parseRangeBound("3d12:30", multiDay)).toBe(DAY3_AT_1230);
    expect(parseRangeBound("0d 09:20", multiDay)).toBe(298);
  });

  it("keeps seconds-from-start working at day scale", () => {
    expect(parseRangeBound("345600", multiDay)).toBe(345_600);
  });

  it("refuses a day prefix whose clock is out of range", () => {
    expect(parseRangeBound("3d 24:00", multiDay)).toBeUndefined();
    expect(parseRangeBound("3d", multiDay)).toBeUndefined();
  });

  it("refuses a day-prefixed clock that lands before the capture began", () => {
    // Day 0 at 08:00 on a capture that started at 09:15:02: an explicit
    // day says which day, so there is no next-day roll to rescue it.
    expect(parseRangeBound("0d 08:00", multiDay)).toBeUndefined();
  });

  it("refuses a wall clock on an unanchored capture", () => {
    // No wall clock to measure against (ADR 0024), so the field takes
    // seconds-from-start only — ruled 2026-09-06.
    expect(parseRangeBound("09:20", unanchored)).toBeUndefined();
    expect(parseRangeBound("90", unanchored)).toBe(90);
  });

  it("refuses anything that is neither", () => {
    expect(parseRangeBound("soon", anchored)).toBeUndefined();
    expect(parseRangeBound("09:20:30:1", anchored)).toBeUndefined();
    expect(parseRangeBound("-5", anchored)).toBeUndefined();
  });
});

describe("formatRangeBound", () => {
  it("renders wall clock when the capture has an anchor", () => {
    expect(formatRangeBound(298, anchored)).toBe("09:20:00");
  });

  it("renders seconds from the start when it has none", () => {
    expect(formatRangeBound(298, unanchored)).toBe("298 s");
  });

  it("names the day of a bound past the capture's first midnight", () => {
    // Without the prefix this reads "12:30:00" — the same string as the
    // first day's 12:30, and typing it back moves the bound three days.
    expect(formatRangeBound(DAY3_AT_1230, multiDay)).toBe("3d 12:30:00");
  });

  it("leaves a bound on the capture's own day unprefixed", () => {
    expect(formatRangeBound(298, multiDay)).toBe("09:20:00");
  });

  it("round-trips a day-scale bound through the field", () => {
    expect(parseRangeBound(formatRangeBound(DAY3_AT_1230, multiDay), multiDay)).toBe(
      DAY3_AT_1230,
    );
  });
});

describe("boundText", () => {
  it("shows the bound's default when nothing is chosen", () => {
    expect(boundText(null, "start", EVENTS, anchored)).toBe("start");
  });

  it("shows the event a bound sits on, rather than its time", () => {
    expect(boundText(1028, "start", EVENTS, anchored)).toBe(
      "fault injected (09:32:10)",
    );
  });

  it("shows a plain time for a bound that is on no event", () => {
    expect(boundText(500, "start", EVENTS, anchored)).toBe("09:23:22");
  });
});

describe("eventAtBound", () => {
  it("matches an event within a second of the bound", () => {
    expect(eventAtBound(1028.4, EVENTS)?.id).toBe("e1");
    expect(eventAtBound(1030, EVENTS)).toBeNull();
    expect(eventAtBound(null, EVENTS)).toBeNull();
  });
});

describe("applyRangePreset", () => {
  it("clears both bounds for the whole capture", () => {
    expect(applyRangePreset("all", DURATION, null)).toEqual(WHOLE_CAPTURE);
  });

  it("leaves the end at the live edge for a trailing window", () => {
    // "Last 5 min" must keep following the live edge, so its end stays
    // the default rather than freezing at the moment it was picked.
    expect(applyRangePreset("5m", DURATION, null)).toEqual({
      from: DURATION - 300,
      to: null,
    });
  });

  it("floors a trailing window longer than the capture at the start", () => {
    expect(applyRangePreset("30m", 600, null)).toEqual({ from: null, to: null });
  });

  it("takes the plot's own window when there is one", () => {
    expect(applyRangePreset("plot", DURATION, { from: 100, to: 250 })).toEqual({
      from: 100,
      to: 250,
    });
  });

  it("declines the plot preset with no plot window to take", () => {
    expect(applyRangePreset("plot", DURATION, null)).toBeNull();
  });
});

describe("exportRangeNs", () => {
  it("sends nothing at all for the whole capture", () => {
    // Both bounds unset means the host applies no filter, rather than
    // one that happens to match the full span.
    expect(exportRangeNs(WHOLE_CAPTURE, START)).toBeNull();
  });

  it("resolves a bound to absolute nanoseconds on the session timeline", () => {
    expect(exportRangeNs({ from: 10, to: null }, START)).toEqual({
      startNs: Math.round((START + 10) * 1e9),
      endNs: null,
    });
    expect(exportRangeNs({ from: null, to: 20 }, START)).toEqual({
      startNs: null,
      endNs: Math.round((START + 20) * 1e9),
    });
  });
});

describe("rangeSpanSeconds", () => {
  it("spans the whole capture when neither bound is set", () => {
    expect(rangeSpanSeconds(WHOLE_CAPTURE, DURATION)).toBe(DURATION);
  });

  it("spans bound to bound, never negative", () => {
    expect(rangeSpanSeconds({ from: 100, to: 250 }, DURATION)).toBe(150);
    expect(rangeSpanSeconds({ from: 250, to: 100 }, DURATION)).toBe(0);
  });
});
