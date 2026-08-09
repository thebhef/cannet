import { describe, expect, it } from "vitest";

import {
  chordFromEvent,
  chordSuppressedInGridview,
  dispatchStroke,
  formatChord,
  isGridviewKey,
  parseChord,
  strokeMatchesStep,
  type KeyStroke,
} from "./keybindings";

const plain = (key: string): KeyStroke => ({
  key,
  ctrl: false,
  meta: false,
  shift: false,
  alt: false,
});

describe("parseChord", () => {
  it("parses a bare key", () => {
    expect(parseChord("f")).toEqual([
      { key: "f", mod: false, ctrl: false, shift: false, alt: false },
    ]);
  });

  it("parses modifiers, normalising the key to lowercase", () => {
    expect(parseChord("Mod+Shift+P")).toEqual([
      { key: "p", mod: true, ctrl: false, shift: true, alt: false },
    ]);
  });

  it("parses a literal Ctrl distinct from Mod", () => {
    expect(parseChord("Ctrl+Tab")).toEqual([
      { key: "tab", mod: false, ctrl: true, shift: false, alt: false },
    ]);
  });

  it("parses a two-step sequence", () => {
    expect(parseChord("g r")).toEqual([
      { key: "g", mod: false, ctrl: false, shift: false, alt: false },
      { key: "r", mod: false, ctrl: false, shift: false, alt: false },
    ]);
  });

  it("rejects unknown modifier tokens and empty chords", () => {
    expect(() => parseChord("Meta+P")).toThrow(/Meta/);
    expect(() => parseChord("")).toThrow();
  });
});

describe("strokeMatchesStep", () => {
  const modP = parseChord("Mod+P")[0];

  it("Mod is Cmd on mac and Ctrl elsewhere", () => {
    const cmdP: KeyStroke = { key: "p", ctrl: false, meta: true, shift: false, alt: false };
    const ctrlP: KeyStroke = { key: "p", ctrl: true, meta: false, shift: false, alt: false };
    expect(strokeMatchesStep(cmdP, modP, true)).toBe(true);
    expect(strokeMatchesStep(cmdP, modP, false)).toBe(false);
    expect(strokeMatchesStep(ctrlP, modP, false)).toBe(true);
    expect(strokeMatchesStep(ctrlP, modP, true)).toBe(false);
  });

  it("requires the modifier set to match exactly", () => {
    const f = parseChord("f")[0];
    expect(strokeMatchesStep(plain("f"), f, false)).toBe(true);
    expect(
      strokeMatchesStep({ ...plain("f"), ctrl: true }, f, false),
    ).toBe(false);
    expect(
      strokeMatchesStep({ ...plain("f"), shift: true }, f, false),
    ).toBe(false);
  });

  it("matches the key case-insensitively (Shift+P reports 'P')", () => {
    const modShiftP = parseChord("Mod+Shift+P")[0];
    const stroke: KeyStroke = { key: "P", ctrl: true, meta: false, shift: true, alt: false };
    expect(strokeMatchesStep(stroke, modShiftP, false)).toBe(true);
  });

  it("Ctrl is the literal Control key on every platform", () => {
    const ctrlTab = parseChord("Ctrl+Tab")[0];
    const ctrlStroke: KeyStroke = {
      key: "Tab",
      ctrl: true,
      meta: false,
      shift: false,
      alt: false,
    };
    const cmdStroke: KeyStroke = {
      key: "Tab",
      ctrl: false,
      meta: true,
      shift: false,
      alt: false,
    };
    expect(strokeMatchesStep(ctrlStroke, ctrlTab, true)).toBe(true);
    expect(strokeMatchesStep(ctrlStroke, ctrlTab, false)).toBe(true);
    expect(strokeMatchesStep(cmdStroke, ctrlTab, true)).toBe(false);
    expect(strokeMatchesStep(cmdStroke, ctrlTab, false)).toBe(false);
  });

  it("a Mod binding still rejects the mac Control key", () => {
    const modP = parseChord("Mod+P")[0];
    const ctrlP: KeyStroke = { key: "p", ctrl: true, meta: false, shift: false, alt: false };
    expect(strokeMatchesStep(ctrlP, modP, true)).toBe(false);
  });
});

describe("formatChord", () => {
  it("renders platform-appropriate modifier names", () => {
    const chord = parseChord("Mod+Shift+P");
    expect(formatChord(chord, true)).toBe("⇧⌘P");
    expect(formatChord(chord, false)).toBe("Ctrl+Shift+P");
  });

  it("renders sequences with a space", () => {
    expect(formatChord(parseChord("g r"), false)).toBe("g r");
  });

  it("renders literal Ctrl and named keys", () => {
    const chord = parseChord("Ctrl+Tab");
    expect(formatChord(chord, false)).toBe("Ctrl+Tab");
    expect(formatChord(chord, true)).toBe("⌃Tab");
  });

  it("renders arrow keys as symbols", () => {
    expect(formatChord(parseChord("Alt+ArrowLeft"), false)).toBe("Alt+←");
    expect(formatChord(parseChord("Alt+ArrowRight"), true)).toBe("⌥→");
  });
});

describe("dispatchStroke", () => {
  const bindings = [
    { chord: parseChord("f"), commandId: "plot.fitXAxis" },
    { chord: parseChord("Mod+Shift+P"), commandId: "palette.show" },
    { chord: parseChord("g r"), commandId: "test.sequence" },
  ];

  it("fires a single-key binding", () => {
    const r = dispatchStroke([], plain("f"), bindings, { isMac: false, inEditable: false });
    expect(r.commandId).toBe("plot.fitXAxis");
    expect(r.pending).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("fires a modifier chord", () => {
    const stroke: KeyStroke = { key: "P", ctrl: true, meta: false, shift: true, alt: false };
    const r = dispatchStroke([], stroke, bindings, { isMac: false, inEditable: false });
    expect(r.commandId).toBe("palette.show");
  });

  it("buffers a sequence prefix, then fires on the second step", () => {
    const first = dispatchStroke([], plain("g"), bindings, { isMac: false, inEditable: false });
    expect(first.commandId).toBeNull();
    expect(first.pending).toHaveLength(1);
    expect(first.handled).toBe(true);
    const second = dispatchStroke(first.pending, plain("r"), bindings, {
      isMac: false,
      inEditable: false,
    });
    expect(second.commandId).toBe("test.sequence");
    expect(second.pending).toEqual([]);
  });

  it("resets a pending sequence on a non-matching key", () => {
    const first = dispatchStroke([], plain("g"), bindings, { isMac: false, inEditable: false });
    const second = dispatchStroke(first.pending, plain("x"), bindings, {
      isMac: false,
      inEditable: false,
    });
    expect(second.commandId).toBeNull();
    expect(second.pending).toEqual([]);
  });

  it("suppresses plain-key bindings while typing in an editable target", () => {
    const r = dispatchStroke([], plain("f"), bindings, { isMac: false, inEditable: true });
    expect(r.commandId).toBeNull();
    expect(r.handled).toBe(false);
  });

  it("still fires modifier chords from an editable target", () => {
    const stroke: KeyStroke = { key: "P", ctrl: true, meta: false, shift: true, alt: false };
    const r = dispatchStroke([], stroke, bindings, { isMac: false, inEditable: true });
    expect(r.commandId).toBe("palette.show");
  });

  it("suppresses skipEditable bindings in an editable target, not elsewhere", () => {
    const undoBindings = [
      { chord: parseChord("Mod+z"), commandId: "view.undo", skipEditable: true },
    ];
    const stroke: KeyStroke = { key: "z", ctrl: true, meta: false, shift: false, alt: false };
    const inEditable = dispatchStroke([], stroke, undoBindings, {
      isMac: false,
      inEditable: true,
    });
    expect(inEditable.commandId).toBeNull();
    expect(inEditable.handled).toBe(false);
    const outside = dispatchStroke([], stroke, undoBindings, {
      isMac: false,
      inEditable: false,
    });
    expect(outside.commandId).toBe("view.undo");
  });

  it("ignores an unbound key entirely", () => {
    const r = dispatchStroke([], plain("z"), bindings, { isMac: false, inEditable: false });
    expect(r.commandId).toBeNull();
    expect(r.handled).toBe(false);
  });
});

describe("gridview key suppression", () => {
  const mod = (key: string): KeyStroke => ({ ...plain(key), ctrl: true });
  const fitBinding = [{ chord: parseChord("f"), commandId: "plot.fitXAxis" }];

  it("claims the unmodified navigation keys and Ctrl/Cmd+A", () => {
    for (const key of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      " ",
      "Tab",
    ]) {
      expect(isGridviewKey(plain(key))).toBe(true);
    }
    expect(isGridviewKey(mod("a"))).toBe(true);
    expect(isGridviewKey({ ...plain("a"), meta: true })).toBe(true);
    // The shifted strokes the grid takes: Shift+Tab (Tab's mirror, into
    // the cursor row's last control) and Shift+Up/Down (extend the
    // selection to the row the cursor moves onto).
    expect(isGridviewKey({ ...plain("Tab"), shift: true })).toBe(true);
    expect(isGridviewKey({ ...plain("ArrowUp"), shift: true })).toBe(true);
    expect(isGridviewKey({ ...plain("ArrowDown"), shift: true })).toBe(true);
  });

  it("leaves every other chord alone", () => {
    expect(isGridviewKey(plain("f"))).toBe(false);
    expect(isGridviewKey(plain("Enter"))).toBe(false);
    // A modified navigation key is a global chord, not a grid move —
    // the layer binds no Alt+← / Ctrl+↑ of its own.
    expect(isGridviewKey({ ...plain("ArrowLeft"), alt: true })).toBe(false);
    expect(isGridviewKey(mod("ArrowDown"))).toBe(false);
    // Sideways is not a range direction — Shift+Left/Right stay global.
    expect(isGridviewKey({ ...plain("ArrowLeft"), shift: true })).toBe(false);
    expect(isGridviewKey({ ...mod("a"), shift: true })).toBe(false);
  });

  it("holds a claimed key back from the dispatcher while focus is in a grid", () => {
    const navBindings = [
      { chord: parseChord("ArrowDown"), commandId: "test.down" },
      { chord: parseChord("Mod+a"), commandId: "test.all" },
    ];
    for (const stroke of [plain("ArrowDown"), mod("a")]) {
      const inside = dispatchStroke([], stroke, navBindings, {
        isMac: false,
        inEditable: false,
        inGridview: true,
      });
      expect(inside.commandId).toBeNull();
      expect(inside.handled).toBe(false);
      const outside = dispatchStroke([], stroke, navBindings, {
        isMac: false,
        inEditable: false,
      });
      expect(outside.handled).toBe(true);
    }
  });

  it("passes every other chord through from inside a grid", () => {
    const r = dispatchStroke([], plain("f"), fitBinding, {
      isMac: false,
      inEditable: false,
      inGridview: true,
    });
    expect(r.commandId).toBe("plot.fitXAxis");
  });
});

describe("chordSuppressedInGridview", () => {
  // The marker the shortcuts view shows against a binding must be true
  // exactly when the dispatcher refuses that binding inside a grid. The
  // two are proved against each other rather than restated, so the
  // display can't drift away from the suppression it explains.
  const cases: { chord: string; stroke: KeyStroke; suppressed: boolean }[] = [
    { chord: "ArrowDown", stroke: plain("ArrowDown"), suppressed: true },
    { chord: "Home", stroke: plain("Home"), suppressed: true },
    { chord: "PageUp", stroke: plain("PageUp"), suppressed: true },
    { chord: "Tab", stroke: plain("Tab"), suppressed: true },
    { chord: "Shift+Tab", stroke: { ...plain("Tab"), shift: true }, suppressed: true },
    { chord: "Mod+A", stroke: { ...plain("a"), ctrl: true }, suppressed: true },
    { chord: "f", stroke: plain("f"), suppressed: false },
    { chord: "Escape", stroke: plain("Escape"), suppressed: false },
    { chord: "Alt+ArrowLeft", stroke: { ...plain("ArrowLeft"), alt: true }, suppressed: false },
    { chord: "Shift+ArrowDown", stroke: { ...plain("ArrowDown"), shift: true }, suppressed: true },
    { chord: "Shift+ArrowLeft", stroke: { ...plain("ArrowLeft"), shift: true }, suppressed: false },
    { chord: "Ctrl+Tab", stroke: { ...plain("Tab"), ctrl: true }, suppressed: false },
    {
      chord: "Mod+Shift+P",
      stroke: { ...plain("p"), ctrl: true, shift: true },
      suppressed: false,
    },
  ];

  it("agrees with what the dispatcher does inside a grid", () => {
    for (const c of cases) {
      const chord = parseChord(c.chord);
      expect(chordSuppressedInGridview(chord), c.chord).toBe(c.suppressed);
      const inside = dispatchStroke([], c.stroke, [{ chord, commandId: "x" }], {
        isMac: false,
        inEditable: false,
        inGridview: true,
      });
      expect(inside.commandId == null, c.chord).toBe(c.suppressed);
      // …and every one of them does fire outside a grid, so the cases
      // above are testing suppression and not a typo in the stroke.
      const outside = dispatchStroke([], c.stroke, [{ chord, commandId: "x" }], {
        isMac: false,
        inEditable: false,
      });
      expect(outside.commandId, c.chord).toBe("x");
    }
  });

  it("marks a sequence when any step is one the grid takes", () => {
    expect(chordSuppressedInGridview(parseChord("g r"))).toBe(false);
    expect(chordSuppressedInGridview(parseChord("g Home"))).toBe(true);
  });
});

describe("chordFromEvent", () => {
  const stroke = (over: Partial<KeyStroke> & { key: string }): KeyStroke => ({
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
    ...over,
  });

  it("returns null for a bare modifier press", () => {
    expect(chordFromEvent(stroke({ key: "Shift", shift: true }), false)).toBeNull();
    expect(chordFromEvent(stroke({ key: "Control", ctrl: true }), false)).toBeNull();
  });

  it("maps Ctrl to Mod off mac and round-trips through parseChord", () => {
    const chord = chordFromEvent(stroke({ key: "p", ctrl: true, shift: true }), false);
    expect(chord).toBe("Mod+Shift+P");
    expect(parseChord(chord!)).toEqual(parseChord("Mod+Shift+P"));
  });

  it("distinguishes Cmd (Mod) from Control on mac", () => {
    expect(chordFromEvent(stroke({ key: "k", meta: true }), true)).toBe("Mod+K");
    expect(chordFromEvent(stroke({ key: "Tab", ctrl: true }), true)).toBe("Ctrl+Tab");
  });

  it("keeps named keys and adds Alt", () => {
    expect(chordFromEvent(stroke({ key: "ArrowLeft", alt: true }), false)).toBe("Alt+ArrowLeft");
  });
});
