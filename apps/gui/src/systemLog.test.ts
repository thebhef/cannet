import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemMessage } from "./types";

// The mirror's cap is the `system_log_ring_capacity` setting — the same
// number that bounds the host ring — so these tests need a host to
// hydrate it from.
let stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...stored } : null)),
}));

const {
  EMPTY_SYSTEM_LOG_MIRROR,
  applySystemLogFilter,
  clearSystemLogMirror,
  distinctSources,
  formatLogLine,
  markSystemLogRead,
  mergeSystemMessage,
  reconcileSnapshot,
  unreadWarnOrError,
} = await import("./systemLog");
type SystemLogMirror = import("./systemLog").SystemLogMirror;
const { defaultSettings, hydrateSettings } = await import("./hostSettings");

const SYSTEM_LOG_MIRROR_CAPACITY = defaultSettings().system_log_ring_capacity;

beforeEach(async () => {
  stored = {};
  await hydrateSettings();
});

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

  it("debug sits below info — hidden at the default filter, shown at `debug`", () => {
    const withDebug = [msg(4, "health", "debug", "1 Hz sample"), ...all];
    expect(applySystemLogFilter(withDebug, undefined, "info").map((m) => m.seq)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(applySystemLogFilter(withDebug, undefined, "debug")).toHaveLength(5);
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

/// A mirror holding `msgs`, nothing read yet.
const mirrorOf = (...msgs: SystemMessage[]): SystemLogMirror =>
  msgs.reduce(mergeSystemMessage, EMPTY_SYSTEM_LOG_MIRROR);

describe("mergeSystemMessage", () => {
  it("appends a new message", () => {
    const merged = mergeSystemMessage(mirrorOf(msg(0, "dbc", "info")), msg(1, "dbc", "warn"));
    expect(merged.messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("is a no-op when seq is already present (event/snapshot race)", () => {
    // The host emits `seq` monotonically, so the check is against the
    // tail alone — no scan of the mirror per appended message.
    const mirror = mirrorOf(msg(0, "dbc", "info"), msg(1, "dbc", "warn"));
    const merged = mergeSystemMessage(mirror, msg(1, "dbc", "warn"));
    expect(merged).toBe(mirror);
  });

  it("caps the mirror, dropping the oldest entries", () => {
    // The frontend mirror must not grow with session time (CLAUDE.md's
    // paging rule); the host ring it mirrors is bounded the same way.
    let mirror = EMPTY_SYSTEM_LOG_MIRROR;
    for (let seq = 0; seq < SYSTEM_LOG_MIRROR_CAPACITY + 50; seq++) {
      mirror = mergeSystemMessage(mirror, msg(seq, "dbc", "info"));
    }
    expect(mirror.messages.length).toBe(SYSTEM_LOG_MIRROR_CAPACITY);
    expect(mirror.messages[0].seq).toBe(50);
    expect(mirror.messages[mirror.messages.length - 1].seq).toBe(
      SYSTEM_LOG_MIRROR_CAPACITY + 49,
    );
  });

  it("caps at the configured ring depth, not a hard-coded one", async () => {
    // Raising `system_log_ring_capacity` makes more of a long session
    // reachable in the panel, which only works if the mirror follows
    // the same number the host ring uses.
    stored = { system_log_ring_capacity: 4 };
    await hydrateSettings();
    let mirror = EMPTY_SYSTEM_LOG_MIRROR;
    for (let seq = 0; seq < 10; seq++) {
      mirror = mergeSystemMessage(mirror, msg(seq, "dbc", "info"));
    }
    expect(mirror.messages.map((m) => m.seq)).toEqual([6, 7, 8, 9]);
  });

  it("tracks the unread warn/error tally as it appends", () => {
    let mirror = mergeSystemMessage(EMPTY_SYSTEM_LOG_MIRROR, msg(0, "dbc", "info"));
    expect(mirror.unread).toBe(0);
    mirror = mergeSystemMessage(mirror, msg(1, "dbc", "warn"));
    mirror = mergeSystemMessage(mirror, msg(2, "connection", "error"));
    mirror = mergeSystemMessage(mirror, msg(3, "dbc", "debug"));
    expect(mirror.unread).toBe(2);
  });
});

describe("markSystemLogRead / clearSystemLogMirror", () => {
  it("clears the badge until a *new* warn or error arrives", () => {
    const mirror = markSystemLogRead(
      mirrorOf(msg(0, "dbc", "warn"), msg(1, "connection", "error")),
    );
    expect(mirror.unread).toBe(0);
    expect(mergeSystemMessage(mirror, msg(2, "dbc", "info")).unread).toBe(0);
    expect(mergeSystemMessage(mirror, msg(2, "dbc", "error")).unread).toBe(1);
  });

  it("empties the mirror without un-reading what was already read", () => {
    // The host keeps counting `seq` across a clear, so the read mark has
    // to survive it — otherwise the next info message re-arms the badge.
    const cleared = clearSystemLogMirror(
      markSystemLogRead(mirrorOf(msg(0, "dbc", "warn"))),
    );
    expect(cleared.messages).toEqual([]);
    expect(cleared.unread).toBe(0);
    expect(mergeSystemMessage(cleared, msg(1, "dbc", "info")).unread).toBe(0);
  });
});

describe("reconcileSnapshot", () => {
  it("replaces the list with the snapshot when nothing is more recent", () => {
    const current = mirrorOf(msg(0, "dbc", "info"));
    const snapshot = [msg(0, "dbc", "info"), msg(1, "dbc", "warn")];
    expect(reconcileSnapshot(current, snapshot).messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("preserves any tail entries whose seq is past the snapshot's last", () => {
    // A `system-log-appended` event arrived (seq 2) between the panel
    // requesting the snapshot and the snapshot being delivered.
    const current = mirrorOf(msg(2, "connection", "error"));
    const snapshot = [msg(0, "dbc", "info"), msg(1, "dbc", "warn")];
    expect(reconcileSnapshot(current, snapshot).messages.map((m) => m.seq)).toEqual([
      0, 1, 2,
    ]);
  });

  it("keeps `current` when the snapshot is empty", () => {
    const current = mirrorOf(msg(0, "dbc", "info"));
    expect(reconcileSnapshot(current, []).messages).toEqual(current.messages);
  });

  it("recounts unread against the read mark", () => {
    // The bulk recount lives here — once, on the boot snapshot — so the
    // append path never has to rescan.
    const read = markSystemLogRead(mirrorOf(msg(0, "dbc", "warn")));
    const snapshot = [msg(0, "dbc", "warn"), msg(1, "dbc", "error"), msg(2, "dbc", "info")];
    expect(reconcileSnapshot(read, snapshot).unread).toBe(1); // seq 1 only
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
