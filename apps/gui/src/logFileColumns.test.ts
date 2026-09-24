/// The logger file gridview's column model: mostly the shared
/// `traceColumns.ts` arithmetic parameterized over `LOG_FILE_COLUMN_DEFS`
/// (unit-tested there), plus this module's own migration from the
/// previous built-in default order (name/size/start/end/duration/
/// messages/modified/action) to the current one
/// (name/size/duration/action/start/end/messages/modified) — owner
/// feedback, 2026-09-23.

import { describe, expect, it } from "vitest";

import {
  LOG_FILE_COLUMN_DEFS,
  defaultLogFileColumns,
  logFileColumnsFromParams,
  type LogFileColumnKey,
} from "./logFileColumns";

const keysOf = (cols: readonly { key: LogFileColumnKey }[]) => cols.map((c) => c.key);

describe("the default column order", () => {
  it("is name, size, duration, action, start, end, messages, modified", () => {
    expect(keysOf(LOG_FILE_COLUMN_DEFS)).toEqual([
      "name",
      "size",
      "duration",
      "action",
      "start",
      "end",
      "messages",
      "modified",
    ]);
  });
});

describe("migrating a persisted layout", () => {
  it("re-lays out a layout matching the previous default order, keeping any resized widths", () => {
    const previousDefault = [
      { key: "name", width: 180, visible: true },
      { key: "size", width: 70, visible: true },
      { key: "start", width: 150, visible: true },
      { key: "end", width: 150, visible: true },
      // The user resized this one, without ever reordering — that
      // customization survives the move to the new order.
      { key: "duration", width: 120, visible: true },
      { key: "messages", width: 80, visible: true },
      { key: "modified", width: 115, visible: true },
      { key: "action", width: 32, visible: true },
    ];
    const result = logFileColumnsFromParams(previousDefault);
    expect(keysOf(result)).toEqual(keysOf(LOG_FILE_COLUMN_DEFS));
    expect(result.find((c) => c.key === "duration")?.width).toBe(120);
  });

  it("leaves a layout the user actually reordered alone", () => {
    const reordered = [
      { key: "action", width: 32, visible: true },
      { key: "name", width: 180, visible: true },
      { key: "size", width: 70, visible: true },
      { key: "duration", width: 75, visible: true },
      { key: "start", width: 150, visible: true },
      { key: "end", width: 150, visible: true },
      { key: "messages", width: 80, visible: true },
      { key: "modified", width: 115, visible: true },
    ];
    const result = logFileColumnsFromParams(reordered);
    expect(keysOf(result)).toEqual([
      "action",
      "name",
      "size",
      "duration",
      "start",
      "end",
      "messages",
      "modified",
    ]);
  });

  it("inserts a column the persisted layout predates at its new default place", () => {
    // A layout saved before this module carried an `action` column at
    // all — reordered by the user, so it is not the previous default —
    // gets `action` filled in after its new canonical predecessor,
    // `duration`.
    const missingAction = [
      { key: "modified", width: 115, visible: true },
      { key: "name", width: 180, visible: true },
      { key: "size", width: 70, visible: true },
      { key: "duration", width: 75, visible: true },
      { key: "start", width: 150, visible: true },
      { key: "end", width: 150, visible: true },
      { key: "messages", width: 80, visible: true },
    ];
    const result = logFileColumnsFromParams(missingAction);
    expect(keysOf(result)).toEqual([
      "modified",
      "name",
      "size",
      "duration",
      "action",
      "start",
      "end",
      "messages",
    ]);
  });

  it("a fresh panel (no saved layout) opens at the built-in default", () => {
    expect(logFileColumnsFromParams(undefined)).toEqual(defaultLogFileColumns());
    expect(logFileColumnsFromParams(null)).toEqual(defaultLogFileColumns());
  });
});
