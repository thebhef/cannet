import { describe, expect, it } from "vitest";

import {
  DEFAULT_BINDINGS,
  COMMANDS,
  addBinding,
  commandsAvailableIn,
  findBindingConflicts,
  resolveBindings,
  sanitizeBindings,
  type BindingSpec,
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
    for (const b of DEFAULT_BINDINGS) {
      expect(ids.has(b.commandId), `binding for unknown command ${b.commandId}`).toBe(true);
    }
  });

  it("has unique command ids", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is conflict-free (the boot assertion)", () => {
    expect(findBindingConflicts(COMMANDS, DEFAULT_BINDINGS)).toEqual([]);
  });

  it("binds the palettes and the plot hotkeys as specced", () => {
    const byId = new Map(DEFAULT_BINDINGS.map((b) => [b.commandId, b.chord]));
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

  it("enumerates the events context (the previously-missing kind)", () => {
    // Two events-only commands on the same chord must be seen to collide;
    // regression guard for `enumerateContexts` omitting "events".
    const conflicts = findBindingConflicts(
      [
        cmd("a", (c) => c.focusedPanelKind === "events"),
        cmd("b", (c) => c.focusedPanelKind === "events"),
      ],
      [
        { chord: "e", commandId: "a" },
        { chord: "e", commandId: "b" },
      ],
    );
    expect(conflicts).toHaveLength(1);
  });
});

describe("resolveBindings / sanitizeBindings", () => {
  it("returns the defaults verbatim for a null customisation", () => {
    expect(resolveBindings(null)).toBe(DEFAULT_BINDINGS);
  });

  it("uses the user's list when present", () => {
    const user: BindingSpec[] = [{ chord: "Mod+k", commandId: "palette.show" }];
    expect(resolveBindings(user)).toEqual(user);
  });

  it("drops bindings for unknown commands", () => {
    const clean = sanitizeBindings(
      [
        { chord: "Mod+k", commandId: "palette.show" },
        { chord: "Mod+j", commandId: "does.not.exist" },
      ],
      COMMANDS,
    );
    expect(clean).toEqual([{ chord: "Mod+k", commandId: "palette.show" }]);
  });

  it("drops bindings with unparseable chords", () => {
    const clean = sanitizeBindings(
      [
        { chord: "Bogus+", commandId: "palette.show" },
        { chord: "Mod+k", commandId: "goto.view" },
      ],
      COMMANDS,
    );
    expect(clean).toEqual([{ chord: "Mod+k", commandId: "goto.view" }]);
  });

  it("drops a later binding that conflicts with an accepted one, keeping the first", () => {
    const clean = sanitizeBindings(
      [
        { chord: "Mod+k", commandId: "palette.show" },
        { chord: "Mod+k", commandId: "goto.view" },
      ],
      COMMANDS,
    );
    expect(clean).toEqual([{ chord: "Mod+k", commandId: "palette.show" }]);
  });

  it("addBinding accepts a non-conflicting chord", () => {
    const r = addBinding(
      [{ chord: "Mod+k", commandId: "palette.show" }],
      { chord: "Mod+j", commandId: "goto.view" },
      COMMANDS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bindings).toHaveLength(2);
  });

  it("addBinding rejects a chord that collides in an overlapping context", () => {
    const r = addBinding(
      [{ chord: "Mod+k", commandId: "palette.show" }],
      { chord: "Mod+k", commandId: "goto.view" },
      COMMANDS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict).toMatch(/Mod\+k/);
  });

  it("addBinding accepts a reused chord in a disjoint context", () => {
    const commands: CommandSpec[] = [
      { id: "a", label: "", context: (c) => c.focusedPanelKind === "plot" },
      { id: "b", label: "", context: (c) => c.focusedPanelKind === "trace" },
    ];
    const r = addBinding([{ chord: "f", commandId: "a" }], { chord: "f", commandId: "b" }, commands);
    expect(r.ok).toBe(true);
  });

  it("keeps a reused chord when the contexts are disjoint", () => {
    // The editor relies on this: `f` may mean different things with a plot
    // vs a trace focused. `plot.fitXAxis` is plot-gated, so a trace-gated
    // reuse of `f` must survive sanitisation.
    const clean = sanitizeBindings(
      [
        { chord: "f", commandId: "plot.fitXAxis" },
        { chord: "f", commandId: "view.exitFullscreen" },
      ],
      COMMANDS,
    );
    // view.exitFullscreen is gated on hasMaximizedView, plot.fitXAxis on a
    // focused plot — those overlap (a maximized plot), so this pair *does*
    // conflict and the second is dropped. Use two genuinely disjoint gates:
    const disjoint = sanitizeBindings(
      [
        { chord: "f", commandId: "plot.fitXAxis" },
        { chord: "f", commandId: "panel.rename" },
      ],
      [
        { id: "plot.fitXAxis", label: "", context: (c) => c.focusedPanelKind === "plot" },
        { id: "panel.rename", label: "", context: (c) => c.focusedPanelKind === "project" },
      ],
    );
    expect(clean).toHaveLength(1);
    expect(disjoint).toHaveLength(2);
  });
});
