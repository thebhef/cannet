import { describe, expect, it } from "vitest";

import {
  DEFAULT_BINDINGS,
  COMMANDS,
  addBinding,
  commandsAvailableIn,
  findBindingConflicts,
  resolveBindings,
  reviewBindings,
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

  it("binds goto.timeInTrace on Mod+T and goto.event on Mod+E", () => {
    const byId = new Map(DEFAULT_BINDINGS.map((b) => [b.commandId, b.chord]));
    expect(byId.get("goto.timeInTrace")).toBe("Mod+T");
    expect(byId.get("goto.event")).toBe("Mod+E");
  });

  it("leaves both goto commands ungated; plot.setVisibleRange requires a focused plot", () => {
    // The two gotos target the session timeline, which no project has to
    // be open for — an imported trace is the case, and every other
    // capture-scoped command (`trace.import`, `capture.save`,
    // `capture.clear`) is ungated for the same reason. `hasProjectOpen`
    // means a project *file* is open — the context shape ADR 0018
    // declares, which no command currently gates on.
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    for (const hasProjectOpen of [true, false]) {
      expect(available(ctx({ hasProjectOpen }))).toContain("goto.timeInTrace");
      expect(available(ctx({ hasProjectOpen }))).toContain("goto.event");
    }
    expect(available(ctx({ hasProjectOpen: false }))).toContain("project.open");
    // New project is reachable with no project file open: the session
    // is still working in a project (ADR 0042 §1), and that is exactly
    // when starting a fresh one is wanted.
    expect(available(ctx({ hasProjectOpen: false }))).toContain("project.new");
    expect(available(ctx({ focusedPanelKind: "plot" }))).toContain("plot.setVisibleRange");
    expect(available(ctx({ focusedPanelKind: "trace" }))).not.toContain("plot.setVisibleRange");
  });

  it("names the Database panel by its panel-level name, findable by the old one", () => {
    // ADR 0052: the panel is format-plural and named "Database"
    // everywhere a user sees it; the old name stays a palette keyword so
    // muscle memory still lands on it (and learns the new label).
    const spec = COMMANDS.find((c) => c.id === "panel.show.dbc");
    expect(spec?.label).toBe("Show Database panel");
    expect(spec?.keywords).toContain("DBC panel");
  });

  it("plot hotkeys are context-gated to a focused plot panel", () => {
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    expect(available(ctx({ focusedPanelKind: "plot" }))).toContain("plot.fitXAxis");
    expect(available(ctx({ focusedPanelKind: "trace" }))).not.toContain("plot.fitXAxis");
    expect(available(ctx())).not.toContain("plot.followLive.enable");
  });

  it("rename is offered only for panels that carry a model-owned name", () => {
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    for (const kind of ["trace", "plot", "signals", "transmit", "rbs", "colormap"] as const) {
      expect(available(ctx({ focusedPanelKind: kind }))).toContain("panel.rename");
    }
    // Singletons have fixed titles — there's nothing to rename.
    expect(available(ctx({ focusedPanelKind: "project" }))).not.toContain("panel.rename");
    expect(available(ctx({ focusedPanelKind: "settings" }))).not.toContain("panel.rename");
    expect(available(ctx())).not.toContain("panel.rename");
  });

  it("exit-full-screen (Escape) is gated to a maximized view", () => {
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    expect(available(ctx({ hasMaximizedView: true }))).toContain("view.exitFullscreen");
    expect(available(ctx())).not.toContain("view.exitFullscreen");
    // The toggle itself is always available.
    expect(available(ctx())).toContain("view.fullscreen");
  });

  it("binds panel.find on Mod+F, not suppressed while typing", () => {
    const binding = DEFAULT_BINDINGS.find((b) => b.commandId === "panel.find");
    expect(binding?.chord).toBe("Mod+F");
    expect(binding?.skipEditable).toBeFalsy();
  });

  it("panel.find is offered only for findable panels (plot, rbs, dbc)", () => {
    const available = (c: CommandContext) =>
      commandsAvailableIn(COMMANDS, c).map((s) => s.id);
    for (const kind of ["plot", "rbs", "dbc"] as const) {
      expect(available(ctx({ focusedPanelKind: kind }))).toContain("panel.find");
    }
    // Not listed elsewhere — inert rather than erroring in a panel with
    // no find/filter box (DBC/Settings' cost-vs-defer split: Settings
    // has no filter affordance at all).
    for (const kind of ["trace", "signals", "transmit", "colormap", "settings", "project"] as const) {
      expect(available(ctx({ focusedPanelKind: kind }))).not.toContain("panel.find");
    }
    expect(available(ctx())).not.toContain("panel.find");
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

  it("uses the user's list when present, and keeps the defaults it never spoke to", () => {
    // The customisation is stored as a whole-list snapshot, so a map
    // saved before a default existed cannot mention it. Without folding
    // those back in, every binding shipped after a user's first edit is
    // dead for that user — which is how `Mod+F` came to be unbound on a
    // real installation while the palette still listed the command.
    const user: BindingSpec[] = [{ chord: "Mod+k", commandId: "palette.show" }];
    const out = resolveBindings(user);
    expect(out).toContainEqual({ chord: "Mod+k", commandId: "palette.show" });
    expect(out.some((b) => b.chord === "Mod+Shift+P")).toBe(false); // rebound
    expect(out).toContainEqual({ chord: "Mod+F", commandId: "panel.find" });
  });

  it("lets a user chord win over the default that would collide with it", () => {
    const user: BindingSpec[] = [{ chord: "Mod+F", commandId: "goto.view" }];
    const out = resolveBindings(user);
    expect(out).toContainEqual({ chord: "Mod+F", commandId: "goto.view" });
    expect(out.some((b) => b.commandId === "panel.find")).toBe(false);
  });

  it("honors a removal, which is what a disabled entry records", () => {
    // Absence cannot mean "removed" once absence also means "added
    // after this snapshot", so the editor writes a tombstone. It never
    // dispatches, and it keeps its default from coming back.
    const user: BindingSpec[] = [{ chord: "Mod+F", commandId: "panel.find", disabled: true }];
    const out = resolveBindings(user);
    expect(out.some((b) => b.commandId === "panel.find")).toBe(false);
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

// A binding dropped on load used to vanish without a trace: the command it
// named simply stopped having a shortcut and nothing said why. `reviewBindings`
// is the reporting half of the same pass `sanitizeBindings` runs, so a
// hand-edited `settings.json` can be told what the app refused.
describe("reviewBindings", () => {
  it("reports nothing when every binding is usable", () => {
    const good: BindingSpec[] = [
      { chord: "Mod+k", commandId: "palette.show" },
      { chord: "Mod+j", commandId: "goto.view" },
    ];
    const review = reviewBindings(good, COMMANDS);
    expect(review.accepted).toEqual(good);
    expect(review.rejected).toEqual([]);
  });

  it("names the binding and the reason for an unknown command id", () => {
    const bad = { chord: "Mod+j", commandId: "does.not.exist" };
    const review = reviewBindings([{ chord: "Mod+k", commandId: "palette.show" }, bad], COMMANDS);
    expect(review.accepted).toEqual([{ chord: "Mod+k", commandId: "palette.show" }]);
    expect(review.rejected).toHaveLength(1);
    expect(review.rejected[0].binding).toEqual(bad);
    expect(review.rejected[0].reason).toContain("does.not.exist");
    expect(review.rejected[0].reason).toMatch(/unknown command/i);
  });

  it("names the binding and the reason for an unparseable chord", () => {
    const bad = { chord: "Bogus+", commandId: "palette.show" };
    const review = reviewBindings([bad], COMMANDS);
    expect(review.accepted).toEqual([]);
    expect(review.rejected).toHaveLength(1);
    expect(review.rejected[0].binding).toEqual(bad);
    expect(review.rejected[0].reason).toMatch(/chord/i);
  });

  it("names the earlier binding a collision lost to", () => {
    const review = reviewBindings(
      [
        { chord: "Mod+k", commandId: "palette.show" },
        { chord: "Mod+k", commandId: "goto.view" },
      ],
      COMMANDS,
    );
    expect(review.accepted).toEqual([{ chord: "Mod+k", commandId: "palette.show" }]);
    expect(review.rejected).toHaveLength(1);
    expect(review.rejected[0].reason).toContain("palette.show");
  });

  it("is the same pass sanitizeBindings runs", () => {
    const mixed: BindingSpec[] = [
      { chord: "Mod+k", commandId: "palette.show" },
      { chord: "Mod+j", commandId: "does.not.exist" },
      { chord: "Bogus+", commandId: "goto.view" },
      { chord: "Mod+k", commandId: "goto.view" },
    ];
    expect(reviewBindings(mixed, COMMANDS).accepted).toEqual(sanitizeBindings(mixed, COMMANDS));
    expect(reviewBindings(mixed, COMMANDS).rejected).toHaveLength(3);
  });
});
