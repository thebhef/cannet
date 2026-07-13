import { describe, expect, it } from "vitest";

import {
  BINDINGS,
  COMMANDS,
  commandsAvailableIn,
  findBindingConflicts,
  type CommandContext,
  type CommandSpec,
} from "./commands";

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  focusedPanelKind: null,
  hasProjectOpen: false,
  hasMaximizedView: false,
  ...over,
});

describe("the shipped command set", () => {
  it("has a spec for every bound command id", () => {
    const ids = new Set(COMMANDS.map((c) => c.id));
    for (const b of BINDINGS) {
      expect(ids.has(b.commandId), `binding for unknown command ${b.commandId}`).toBe(true);
    }
  });

  it("has unique command ids", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is conflict-free (the boot assertion)", () => {
    expect(findBindingConflicts(COMMANDS, BINDINGS)).toEqual([]);
  });

  it("binds the palettes and the plot hotkeys as specced", () => {
    const byId = new Map(BINDINGS.map((b) => [b.commandId, b.chord]));
    expect(byId.get("palette.show")).toBe("Mod+Shift+P");
    expect(byId.get("goto.view")).toBe("Mod+P");
    expect(byId.get("plot.fitXAxis")).toBe("f");
    expect(byId.get("plot.followLive.enable")).toBe("l");
  });

  it("plot hotkeys are context-gated to a focused plot panel", () => {
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    expect(available(ctx({ focusedPanelKind: "plot" }))).toContain("plot.fitXAxis");
    expect(available(ctx({ focusedPanelKind: "trace" }))).not.toContain("plot.fitXAxis");
    expect(available(ctx())).not.toContain("plot.followLive.enable");
  });

  it("exit-full-screen (Escape) is gated to a maximized view", () => {
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    expect(available(ctx({ hasMaximizedView: true }))).toContain("view.exitFullscreen");
    expect(available(ctx())).not.toContain("view.exitFullscreen");
    // The toggle itself is always available.
    expect(available(ctx())).toContain("view.fullscreen");
  });
});

describe("findBindingConflicts", () => {
  const cmd = (id: string, context?: CommandSpec["context"]): CommandSpec => ({
    id,
    label: id,
    context,
  });

  it("flags the same key bound twice in overlapping contexts", () => {
    const conflicts = findBindingConflicts(
      [cmd("a"), cmd("b")],
      [
        { chord: "f", commandId: "a" },
        { chord: "f", commandId: "b" },
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/f/);
  });

  it("allows the same key when the contexts are disjoint", () => {
    const conflicts = findBindingConflicts(
      [
        cmd("a", (c) => c.focusedPanelKind === "plot"),
        cmd("b", (c) => c.focusedPanelKind === "trace"),
      ],
      [
        { chord: "f", commandId: "a" },
        { chord: "f", commandId: "b" },
      ],
    );
    expect(conflicts).toEqual([]);
  });

  it("a missing context overlaps everything", () => {
    const conflicts = findBindingConflicts(
      [cmd("a"), cmd("b", (c) => c.focusedPanelKind === "plot")],
      [
        { chord: "f", commandId: "a" },
        { chord: "f", commandId: "b" },
      ],
    );
    expect(conflicts).toHaveLength(1);
  });

  it("flags a binding that is a prefix of another in an overlapping context", () => {
    const conflicts = findBindingConflicts(
      [cmd("a"), cmd("b")],
      [
        { chord: "g", commandId: "a" },
        { chord: "g r", commandId: "b" },
      ],
    );
    expect(conflicts).toHaveLength(1);
  });
});
