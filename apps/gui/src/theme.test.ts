import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { THEMES, TOKEN_MIRROR } from "./theme";

/// Custom properties declared in the theme block at the top of
/// `index.css`, by name. The block ends at its marker comment, so a
/// `--x` further down the file (a theme override, later) can't be
/// mistaken for the base declaration.
function cssTokens(): Map<string, string> {
  const end = css.indexOf("/* === end theme tokens === */");
  expect(end, "no theme token block in index.css").toBeGreaterThan(-1);
  const block = css.slice(0, end);
  const tokens = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

describe("TOKEN_MIRROR", () => {
  it("names tokens index.css actually declares", () => {
    const tokens = cssTokens();
    expect(tokens.size).toBeGreaterThan(100);
    for (const token of Object.values(TOKEN_MIRROR)) {
      expect(tokens.has(token), `index.css declares no ${token}`).toBe(true);
    }
  });

  // The dark values live in `:root` — the block `cssTokens` reads. A
  // second theme declares its own selector, and gets its own pass here.
  it("agrees with the stylesheet, so the two color sources can't drift", () => {
    const tokens = cssTokens();
    for (const [key, token] of Object.entries(TOKEN_MIRROR)) {
      const ts = THEMES.dark[key as keyof typeof TOKEN_MIRROR];
      expect(ts, `theme.dark.${key} vs ${token}`).toBe(tokens.get(token));
    }
  });
});

describe("themes", () => {
  it("carry slot-matched wheels of the same shape", () => {
    const themes = Object.values(THEMES);
    for (const t of themes) {
      expect(t.signalWheel.length, `${t.name} signal wheel`).toBe(16);
      expect(t.busWheel.length, `${t.name} bus wheel`).toBe(8);
      for (const c of [...t.signalWheel, ...t.busWheel]) {
        expect(c, `${t.name} wheel entry`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(new Set(t.signalWheel).size).toBe(t.signalWheel.length);
      expect(new Set(t.busWheel).size).toBe(t.busWheel.length);
    }
  });

  it("key every theme object by its own name", () => {
    for (const [name, t] of Object.entries(THEMES)) expect(t.name).toBe(name);
  });
});
