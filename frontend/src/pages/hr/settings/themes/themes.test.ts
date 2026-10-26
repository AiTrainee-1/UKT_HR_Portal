import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES } from "@/lib/themes";
import {
  DARK_TEXT,
  LIGHT_TEXT,
  PALETTES,
  colourSet,
  editableOf,
  ratioOf,
  textCheck,
  type PaletteToken,
} from "./palettes";

const read = (file: string) =>
  fs.readFileSync(path.join(import.meta.dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("../../../../index.css");
// Clean Professional keeps its tokens in its own folder, under its scope selector (see SELECTOR below)
const cleanTokens = read("../../../../themes/clean/tokens.css");

/** The custom properties declared in the rule whose selector list is exactly `selector`. */
function block(selector: string, source = css): Record<string, string> {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector) && m[2].includes("--primary:")) {
      return Object.fromEntries([...m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
    }
  }
  throw new Error(`no rule for ${selector}`);
}

const SELECTOR: Record<string, string> = {
  default: ":root",
  dark: '[data-theme="dark"]',
  premium: '[data-theme="premium"]',
  mono: '[data-theme="mono"]',
  "mono-dark": '[data-theme="mono-dark"]',
  professional: '[data-theme="professional"]',
  clean: 'html[data-theme="clean"]:not([data-md-theme])',
};

describe("theme palettes", () => {
  it("has every theme the Themes tab offers", () => {
    expect(Object.keys(PALETTES).sort()).toEqual(THEMES.map((t) => t.id).sort());
  });

  for (const theme of THEMES) {
    it(`${theme.id}: matches src/index.css`, () => {
      const declared = block(SELECTOR[theme.id], theme.id === "clean" ? cleanTokens : css);
      for (const [token, value] of Object.entries(PALETTES[theme.id]) as [PaletteToken, string][]) {
        expect(declared[token], `${theme.id} ${token}`).toBe(value);
      }
    });
  }
});

describe("readable text on custom colours", () => {
  it("keeps the theme's own text colour while it is readable", () => {
    // Default theme: white text on UKT Blue is fine.
    expect(textCheck("default", "--primary", "201 100% 29%")).toMatchObject({ replacement: null });
  });

  it("switches to dark text on a light custom primary, and to white on a dark custom sidebar", () => {
    const light = textCheck("default", "--primary", "50 100% 80%");
    expect(light?.replacement).toBe(DARK_TEXT);
    expect(light!.ratio).toBeGreaterThanOrEqual(4.5);
    // Default theme's menu text is deep blue: a navy sidebar needs white text.
    const navy = textCheck("default", "--sidebar", "200 62% 13%");
    expect(navy?.replacement).toBe(LIGHT_TEXT);
    expect(ratioOf("200 62% 13%", LIGHT_TEXT)).toBeGreaterThan(4.5);
  });

  it("saves only colours that differ from the theme, with the text colours they need", () => {
    expect(colourSet("default", { "--primary": "201 100% 29%", "--background": "210 50% 97%" })).toEqual({});
    expect(colourSet("default", { "--sidebar": "200 62% 13%", "--foreground": "0 0% 7%" })).toEqual({
      "--sidebar": "200 62% 13%",
      "--sidebar-foreground": LIGHT_TEXT,
      "--foreground": "0 0% 7%",
    });
    // Text on Background has no automatic partner: both are editable.
    expect(colourSet("default", { "--background": "0 0% 10%" })).toEqual({ "--background": "0 0% 10%" });
  });

  it("separates the edited colours from the text colours added for them", () => {
    expect(editableOf({ "--sidebar": "1 1% 1%", "--sidebar-foreground": LIGHT_TEXT })).toEqual({
      "--sidebar": "1 1% 1%",
    });
  });
});
