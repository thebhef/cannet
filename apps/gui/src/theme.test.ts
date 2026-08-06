import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { THEMES, TOKEN_MIRROR, resolveTheme } from "./theme";

/// Where each theme's token block ends in `index.css`. A block runs from
/// the end of the previous one to its own marker comment, so a `--x`
/// declared in an ordinary rule further down the file can't be mistaken
/// for a token declaration.
const BLOCK_END: Record<string, string> = {
  dark: "/* === end theme tokens === */",
  light: "/* === end light theme tokens === */",
  normal: "/* === end normal theme tokens === */",
};

/// Custom properties one theme's block declares, by name.
function cssTokens(themeName: string): Map<string, string> {
  const marker = BLOCK_END[themeName];
  const end = css.indexOf(marker);
  expect(end, `no ${themeName} token block in index.css`).toBeGreaterThan(-1);
  // The dark block starts at the top of the file; every later block
  // starts where its predecessor's marker left off.
  const names = Object.keys(BLOCK_END);
  const prev = names[names.indexOf(themeName) - 1];
  const start = prev == null ? 0 : css.indexOf(BLOCK_END[prev]);
  const block = css.slice(start, end);
  const tokens = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

/// Roles whose value is the same under every theme, and why. They are
/// all colors that sit on a *solid* of their own — a filled badge, a
/// selected row's accent fill, a focus ring drawn over both — so the
/// surface underneath them doesn't change with the theme and neither
/// should they.
const THEME_INDEPENDENT = [
  "--text-on-accent",
  "--text-on-solid",
  "--accent-selected-bg",
  "--danger-badge",
  "--border-search-focus",
];

/// The blocks that override `:root` — every theme but dark, which is
/// what `:root` itself declares.
const OVERRIDES = Object.keys(BLOCK_END).filter((n) => n !== "dark");

describe("the stylesheet's theme blocks", () => {
  // A theme is a set of *values* for one fixed set of roles. A block
  // that omits a token silently falls back to the dark value it
  // overrides — a dark remnant no rule and no grep would show — and one
  // that invents a token names a role nothing reads.
  it.each(OVERRIDES)("%s declares the same roles as dark, in the same order", (name) => {
    const dark = [...cssTokens("dark").keys()];
    expect(dark.length).toBeGreaterThan(100);
    expect([...cssTokens(name).keys()]).toEqual(dark);
  });

  // Anything else carried over from dark is a remnant, not a decision.
  it.each(OVERRIDES)(
    "%s re-values every role except the ones that are theme-independent",
    (name) => {
      const dark = cssTokens("dark");
      for (const [token, value] of cssTokens(name)) {
        if (THEME_INDEPENDENT.includes(token)) {
          expect(value, `${token} claims to be theme-independent`).toBe(dark.get(token));
          continue;
        }
        expect(value, `${token} is unchanged from dark`).not.toBe(dark.get(token));
      }
    },
  );
});

describe("TOKEN_MIRROR", () => {
  it("names tokens index.css actually declares", () => {
    const tokens = cssTokens("dark");
    expect(tokens.size).toBeGreaterThan(100);
    for (const token of Object.values(TOKEN_MIRROR)) {
      expect(tokens.has(token), `index.css declares no ${token}`).toBe(true);
    }
  });

  // Every theme, against its own block: the mirror is a per-theme
  // promise, so a light value that drifts from `:root[data-theme=light]`
  // fails here exactly as a dark one does.
  it.each(Object.keys(THEMES))(
    "agrees with the %s stylesheet block, so the two color sources can't drift",
    (name) => {
      const tokens = cssTokens(name);
      for (const [key, token] of Object.entries(TOKEN_MIRROR)) {
        const ts = THEMES[name as keyof typeof THEMES][key as keyof typeof TOKEN_MIRROR];
        expect(ts, `theme.${name}.${key} vs ${token}`).toBe(tokens.get(token));
      }
    },
  );
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

describe("resolveTheme", () => {
  it("gives normal mode the light setting and nothing else", () => {
    expect(resolveTheme("light", true)).toBe("normal");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
