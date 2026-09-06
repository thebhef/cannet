import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOGGER_FILE,
  DEFAULT_LOGGER_FOLDER,
  DEFAULT_LOGGER_MAX_MB,
  loggerConfigs,
  loggerPreviewName,
  normalizeLoggerFields,
} from "./logger";
import type { ProjectElement } from "./types";

function logger(over: Partial<Extract<ProjectElement, { kind: "logger" }>> = {}) {
  return {
    kind: "logger" as const,
    id: "l1",
    name: "Bench log",
    enabled: false,
    folder: DEFAULT_LOGGER_FOLDER,
    file: DEFAULT_LOGGER_FILE,
    format: "blf" as const,
    maxFileSizeMb: DEFAULT_LOGGER_MAX_MB,
    ...over,
  };
}

describe("normalizeLoggerFields", () => {
  it("fills a value with nothing in it with the documented defaults", () => {
    expect(normalizeLoggerFields({})).toEqual({
      enabled: false,
      folder: "logs/{logger}",
      file: "{start}",
      format: "blf",
      maxFileSizeMb: 500,
    });
  });

  it("keeps what a saved logger carried", () => {
    expect(
      normalizeLoggerFields({
        enabled: true,
        folder: "D:\\captures",
        file: "{start}\\{now}",
        maxFileSizeMb: 64,
      }),
    ).toEqual({
      enabled: true,
      folder: "D:\\captures",
      file: "{start}\\{now}",
      format: "blf",
      maxFileSizeMb: 64,
    });
  });

  it("only an explicit true enables — a malformed flag never arms logging", () => {
    expect(normalizeLoggerFields({ enabled: "yes" }).enabled).toBe(false);
    expect(normalizeLoggerFields({ enabled: 1 }).enabled).toBe(false);
    expect(normalizeLoggerFields({ enabled: true }).enabled).toBe(true);
  });

  it("floors the size cap at one megabyte and to a whole number", () => {
    expect(normalizeLoggerFields({ maxFileSizeMb: 0 }).maxFileSizeMb).toBe(1);
    expect(normalizeLoggerFields({ maxFileSizeMb: -5 }).maxFileSizeMb).toBe(1);
    expect(normalizeLoggerFields({ maxFileSizeMb: 12.7 }).maxFileSizeMb).toBe(12);
    expect(normalizeLoggerFields({ maxFileSizeMb: Number.NaN }).maxFileSizeMb).toBe(500);
    expect(normalizeLoggerFields({ maxFileSizeMb: "500" }).maxFileSizeMb).toBe(500);
  });

  it("is BLF whatever the file said — live logging has one format", () => {
    expect(normalizeLoggerFields({ format: "mdf" }).format).toBe("blf");
  });
});

describe("loggerPreviewName", () => {
  it("appends the format's extension", () => {
    expect(loggerPreviewName("20260906T101500-0600")).toBe("20260906T101500-0600.blf");
  });

  it("leaves the host's separators alone — they are already this OS's", () => {
    expect(loggerPreviewName("20260906T101500/20260906T104500")).toBe(
      "20260906T101500/20260906T104500.blf",
    );
    expect(loggerPreviewName("20260906T101500\\20260906T104500")).toBe(
      "20260906T101500\\20260906T104500.blf",
    );
  });
});

describe("loggerConfigs", () => {
  it("carries every logger, in element order, and nothing else", () => {
    const elements: ProjectElement[] = [
      { kind: "trace", id: "t", sources: ["*"] },
      logger({ id: "a", name: "A", enabled: true }),
      logger({ id: "b", name: "B", maxFileSizeMb: 10 }),
    ];
    expect(loggerConfigs(elements)).toEqual([
      {
        id: "a",
        name: "A",
        enabled: true,
        folder: "logs/{logger}",
        file: "{start}",
        maxFileSizeMb: 500,
      },
      {
        id: "b",
        name: "B",
        enabled: false,
        folder: "logs/{logger}",
        file: "{start}",
        maxFileSizeMb: 10,
      },
    ]);
  });

  it("gives an unnamed logger an empty name rather than undefined", () => {
    const [cfg] = loggerConfigs([logger({ name: undefined })]);
    expect(cfg.name).toBe("");
  });

  it("is empty for a project with no logger", () => {
    expect(loggerConfigs([{ kind: "trace", id: "t", sources: ["*"] }])).toEqual([]);
  });
});
