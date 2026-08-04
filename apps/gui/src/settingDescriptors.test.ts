import { describe, expect, it } from "vitest";

import {
  countsByGroup,
  formatSettingValue,
  groupIdsOf,
  isDefaultValue,
  settingGroups,
  settingsMatcher,
  visibleSettings,
  type SettingDescriptor,
  type SettingsSchema,
} from "./settingDescriptors";

/// A stand-in schema in the shape the host serves — deliberately not the
/// real one, so these tests describe the framework rather than today's
/// four settings.
const schema: SettingsSchema = {
  surfaces: [
    { id: "general", label: "General" },
    { id: "plot", label: "Plot" },
    { id: "storage", label: "Storage" },
  ],
  settings: [
    {
      key: "show_developer_settings",
      label: "Show developer settings",
      help: "Reveal machine-load knobs in this panel.",
      surfaces: ["general"],
      kind: "behaviour",
      control: { type: "bool" },
      scope: "user",
      default: false,
    },
    {
      key: "default_y_axis_mode",
      label: "Default y-axis mode",
      help: "Y-axis mode a newly-added plot area starts in.",
      surfaces: ["plot"],
      kind: "default",
      control: { type: "enum", options: ["Shared", "Individual"] },
      scope: "user-overridable",
      default: "Shared",
    },
    {
      key: "scratch_cap_bytes",
      label: "Cache size cap",
      help: "Drop the oldest history once the on-disk cache exceeds this.",
      surfaces: ["storage"],
      kind: "behaviour",
      control: { type: "int", unit: "MB", scale: 1048576, min: 104857600, unset: "unbounded" },
      scope: "user-overridable",
      default: null,
    },
    {
      key: "fetch_cadence_hz",
      label: "Plot fetch cadence",
      help: "How often an open plot asks the host for a resampled window.",
      surfaces: ["plot"],
      kind: "developer",
      control: { type: "int", unit: "Hz", scale: 1, min: null, unset: null },
      scope: "user-overridable",
      default: 15,
    },
  ],
};

const match = settingsMatcher(schema);
const keys = (list: readonly SettingDescriptor[]) => list.map((d) => d.key);

describe("settings search", () => {
  it("returns the schema's own order for an empty query", () => {
    expect(keys(match(""))).toEqual(keys(schema.settings));
  });

  it("finds a setting by its label", () => {
    expect(keys(match("cache size"))).toContain("scratch_cap_bytes");
  });

  it("finds a setting by its settings.json key", () => {
    expect(keys(match("scratch_cap"))).toContain("scratch_cap_bytes");
  });

  // The point of searching help text: a user who cannot name the setting
  // describes what it does instead.
  it("finds a setting by its help text", () => {
    expect(keys(match("resampled window"))).toContain("fetch_cadence_hz");
  });

  it("finds a setting by its surface tag", () => {
    expect(keys(match("storage"))).toContain("scratch_cap_bytes");
  });

  it("finds a setting by its kind tag", () => {
    expect(keys(match("developer"))).toContain("fetch_cadence_hz");
  });

  it("ranks the best match first", () => {
    expect(keys(match("y-axis"))[0]).toBe("default_y_axis_mode");
  });
});

describe("developer settings", () => {
  it("are hidden until the user opts in", () => {
    expect(keys(visibleSettings(match(""), false, null))).not.toContain("fetch_cadence_hz");
    expect(keys(visibleSettings(match(""), true, null))).toContain("fetch_cadence_hz");
  });

  // A search that would otherwise hit one must come back empty rather
  // than announcing that something is hidden.
  it("stay hidden from a query that would match them", () => {
    expect(visibleSettings(match("cadence"), false, null)).toHaveLength(0);
    expect(keys(visibleSettings(match("cadence"), true, null))).toContain("fetch_cadence_hz");
  });

  // Flipping the toggle must add one group, not grow all of them.
  it("collect into their own group instead of their surface", () => {
    const developer = schema.settings.find((d) => d.key === "fetch_cadence_hz")!;
    expect(groupIdsOf(developer)).toEqual(["developer"]);
    expect(keys(visibleSettings(match(""), true, "plot"))).toEqual(["default_y_axis_mode"]);
    expect(keys(visibleSettings(match(""), true, "developer"))).toEqual(["fetch_cadence_hz"]);
  });

  it("add a tree group only once revealed", () => {
    expect(settingGroups(schema, false).map((g) => g.id)).toEqual([
      "general",
      "plot",
      "storage",
    ]);
    expect(settingGroups(schema, true).map((g) => g.id)).toEqual([
      "general",
      "plot",
      "storage",
      "developer",
    ]);
  });

  it("are not counted in a group while hidden", () => {
    expect(countsByGroup(visibleSettings(match(""), false, null)).get("plot")).toBe(1);
    expect(countsByGroup(visibleSettings(match(""), false, null)).has("developer")).toBe(
      false,
    );
    expect(countsByGroup(visibleSettings(match(""), true, null)).get("developer")).toBe(1);
  });
});

describe("value helpers", () => {
  it("recognises a value that is its own default", () => {
    const cap = schema.settings[2];
    expect(isDefaultValue(cap, null)).toBe(true);
    expect(isDefaultValue(cap, 4096)).toBe(false);
  });

  it("renders a scaled integer in its displayed unit", () => {
    expect(formatSettingValue(schema.settings[2], 4 * 1024 * 1024 * 1024)).toBe("4096 MB");
  });

  it("renders an absent optional value as its unset label", () => {
    expect(formatSettingValue(schema.settings[2], null)).toBe("unbounded");
  });

  it("renders a boolean as its state", () => {
    expect(formatSettingValue(schema.settings[0], true)).toBe("enabled");
    expect(formatSettingValue(schema.settings[0], false)).toBe("disabled");
  });
});
