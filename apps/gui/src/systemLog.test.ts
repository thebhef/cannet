import { describe, expect, it } from "vitest";

import type { SystemMessage } from "./types";
import {
  applySystemLogFilter,
  distinctSources,
  formatLogLine,
  mergeSystemMessage,
  reconcileSnapshot,
  unreadWarnOrError,
} from "./systemLog";

const msg = (
  seq: number,
  source: string,
  level: SystemMessage["level"],
  message = `msg ${seq}`,
  tsMs = 1_700_000_000_000 + seq,
): SystemMessage => ({ seq, source, level, message, ts_ms: tsMs });

describe("applySystemLogFilter", () => {
  const all: SystemMessage[] = [
    msg(0, "dbc", "info", "loaded a.dbc"),
    msg(1, "project", "warn", "schema warning"),
    msg(2, "connection", "error", "connect failed"),
    msg(3, "dbc", "error", "parse error"),
  ];

  it("drops messages below the minimum level", () => {
    expect(applySystemLogFilter(all, undefined, "warn").map((m) => m.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(applySystemLogFilter(all, undefined, "error").map((m) => m.seq)).toEqual([
      2, 3,
    ]);
  });

  it("filters by source when one is set", () => {
    expect(
      applySystemLogFilter(all, "dbc", "info").map((m) => m.seq),
    ).toEqual([0, 3]);
  });

  it("an empty source string is treated as 'all sources'", () => {
    expect(applySystemLogFilter(all, "", "info")).toHaveLength(4);
  });

  it("combines source and level filters", () => {
    expect(
      applySystemLogFilter(all, "dbc", "error").map((m) => m.seq),
    ).toEqual([3]);
  });
});

describe("distinctSources", () => {
  it("returns sorted distinct sources", () => {
    const list = [
      msg(0, "project", "info"),
      msg(1, "dbc", "info"),
      msg(2, "dbc", "warn"),
      msg(3, "connection", "info"),
    ];
    expect(distinctSources(list)).toEqual(["connection", "dbc", "project"]);
  });
});

describe("mergeSystemMessage", () => {
  it("appends a new message", () => {
    const list = [msg(0, "dbc", "info")];
    const merged = mergeSystemMessage(list, msg(1, "dbc", "warn"));
    expect(merged.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("is a no-op when seq is already present (event/snapshot race)", () => {
    const list = [msg(0, "dbc", "info"), msg(1, "dbc", "warn")];
    const merged = mergeSystemMessage(list, msg(1, "dbc", "warn"));
    expect(merged.map((m) => m.seq)).toEqual([0, 1]);
  });
});

describe("reconcileSnapshot", () => {
  it("replaces the list with the snapshot when nothing is more recent", () => {
    const current = [msg(0, "dbc", "info")];
    const snapshot = [msg(0, "dbc", "info"), msg(1, "dbc", "warn")];
    expect(reconcileSnapshot(current, snapshot).map((m) => m.seq)).toEqual([0, 1]);
  });

  it("preserves any tail entries whose seq is past the snapshot's last", () => {
    // A `system-log-appended` event arrived (seq 2) between the panel
    // requesting the snapshot and the snapshot being delivered.
    const current = [msg(2, "connection", "error")];
    const snapshot = [msg(0, "dbc", "info"), msg(1, "dbc", "warn")];
    expect(reconcileSnapshot(current, snapshot).map((m) => m.seq)).toEqual([
      0, 1, 2,
    ]);
  });

  it("returns a copy of `current` when the snapshot is empty", () => {
    const current = [msg(0, "dbc", "info")];
    const result = reconcileSnapshot(current, []);
    expect(result).not.toBe(current);
    expect(result).toEqual(current);
  });
});

describe("formatLogLine", () => {
  it("renders timestamp, level, source, and message", () => {
    const line = formatLogLine(msg(0, "dbc", "warn", "boom", Date.UTC(2026, 4, 15, 12, 34, 56, 789)));
    // Locale-independent: the level + source + message check; the
    // exact "HH:MM:SS.SSS" string depends on the runner's timezone.
    expect(line).toMatch(/\[WARN\] dbc: boom$/);
  });
});

describe("unreadWarnOrError", () => {
  const list = [
    msg(0, "dbc", "info"),
    msg(1, "dbc", "warn"),
    msg(2, "connection", "error"),
    msg(3, "project", "info"),
  ];

  it("counts warn and error entries past the high-water seq", () => {
    expect(unreadWarnOrError(list, -1)).toBe(2); // seq 1 + seq 2
    expect(unreadWarnOrError(list, 1)).toBe(1); // only seq 2
    expect(unreadWarnOrError(list, 2)).toBe(0); // nothing past seq 2 is warn/error
  });

  it("is zero on an empty buffer", () => {
    expect(unreadWarnOrError([], -1)).toBe(0);
  });
});
