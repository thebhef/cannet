import { describe, expect, it } from "vitest";

import {
  dispatchStroke,
  formatChord,
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
