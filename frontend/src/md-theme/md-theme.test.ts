import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MD_CHART, MD_PALETTE, MD_THEME_ATTRIBUTE } from "@/lib/md/theme";

const dir = import.meta.dirname;
const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** [selector list, body] of every rule (the inner rules of @media blocks included). */
function rules(css: string): { selectors: string[]; body: string }[] {
  return [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .trim()
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim())
      .filter(Boolean),
    body: m[2],
  }));
}

describe("the MD skin stays inside the MD portal", () => {
  // Files whose rules CHANGE how existing things look: each selector must be under html[data-md-theme]
  // (.md-app-bg is the class MdLayout puts on its own root, which only MD code uses).
  for (const file of ["base.css", "tailwind-remap.css", "hr-copies.css"]) {
    it(`${file}: every selector is scoped to html[data-md-theme]`, () => {
      const unscoped = rules(read(file))
        .flatMap((r) => r.selectors)
        .filter((s) => !s.startsWith("html[data-md-theme]") && s !== ".md-app-bg");
      expect(unscoped).toEqual([]);
    });
  }

  it("glass.css: the only rules that reach existing components are scoped; the rest are md-* classes", () => {
    const selectors = rules(read("glass.css")).flatMap((r) => r.selectors);
    // keyframe steps (from / to / 40%) are not selectors of anything on the page
    const stray = selectors.filter(
      (s) => !s.startsWith("html[data-md-theme]") && !/^\.md-/.test(s) && !/^(from|to|\d+%)$/.test(s),
    );
    expect(stray).toEqual([]);
  });

  it("the area files only add md-* classes or scoped rules, and no hex colour", () => {
    for (const area of ["shell", "assistant", "dashboard", "money", "people", "analytics"]) {
      const css = read(`areas/${area}.css`);
      const stray = rules(css)
        .flatMap((r) => r.selectors)
        .filter((s) => !s.startsWith("html[data-md-theme]") && !/^\.md-/.test(s));
      expect(stray, area).toEqual([]);
      expect(strip(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], `${area}: hex colours`).toEqual([]);
    }
  });

  it("tokens.css only declares variables and utilities (no rule that paints anything)", () => {
    const css = strip(read("tokens.css"));
    // :root { --md-...: ...; } and @theme inline { --color-md-...: ...; }: nothing but custom properties
    for (const { body } of rules(css)) {
      for (const line of body
        .split(";")
        .map((l) => l.trim())
        .filter(Boolean)) {
        expect(line.startsWith("--"), line).toBe(true);
      }
    }
  });

  it("the attribute is the one lib/md/theme.ts sets", () => {
    expect(MD_THEME_ATTRIBUTE).toBe("data-md-theme");
    expect(read("base.css")).toContain(`html[${MD_THEME_ATTRIBUTE}]`);
  });
});

describe("the palette", () => {
  const tokens = read("tokens.css").toLowerCase();

  it("holds the five colours the product owner chose, in step with lib/md/theme.ts", () => {
    for (const [name, hex] of Object.entries(MD_PALETTE)) {
      expect(tokens, name).toContain(`--md-${name}: ${hex.toLowerCase()};`);
    }
  });

  it("has every ramp complete (50 to 950)", () => {
    for (const ramp of [
      "wine",
      "ink",
      "n",
      "info",
      "sky",
      "rose",
      "sage",
      "success",
      "warning",
      "danger",
      "clay",
      "mauve",
    ]) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(tokens, `${ramp}-${shade}`).toMatch(new RegExp(`--md-${ramp}-${shade}: #[0-9a-f]{6};`));
      }
    }
  });

  it("is what the chart colours are made from", () => {
    expect(MD_CHART.series[0]).toBe(MD_PALETTE.wine);
    expect(MD_CHART.series[1]).toBe(MD_PALETTE.indigo);
    for (const colour of MD_CHART.series) expect(colour).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("remaps every Tailwind colour family shade for shade", () => {
    const remap = read("tailwind-remap.css");
    for (const family of [
      "slate",
      "gray",
      "zinc",
      "neutral",
      "stone",
      "blue",
      "indigo",
      "sky",
      "cyan",
      "teal",
      "emerald",
      "green",
      "lime",
      "red",
      "rose",
      "pink",
      "fuchsia",
      "purple",
      "violet",
      "amber",
      "yellow",
      "orange",
    ]) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(remap, `${family}-${shade}`).toContain(`--color-${family}-${shade}: var(--md-`);
      }
    }
  });
});

describe("the MD portal's type", () => {
  const typography = read("typography.css");
  const publicFonts = path.resolve(dir, "../../public/fonts");

  it("only the scoped rules change how existing things look; nothing else is declared but the font face and its variable", () => {
    const selectors = rules(typography).flatMap((r) => r.selectors);
    const stray = selectors.filter((s) => !s.startsWith("html[data-md-theme]") && s !== ":root" && s !== "@font-face");
    expect(stray).toEqual([]);
  });

  it("sets the page title in Whole Chomp on every MD page, and the dashboard's headings too, and nothing else", () => {
    expect(typography).toMatch(/:is\(\[data-md-title\], \[data-testid="md-page-title"\]\)/);
    expect(typography.replace(/\s+/g, " ")).toMatch(/\[data-testid="md-dashboard-page"\] :is\(h1, h2, h3, h4, h5, h6/);
    // the rule for "every heading" is not there any more: headings elsewhere keep the current font
    expect(typography).not.toMatch(/html\[data-md-theme\] :is\(h1/);
    expect(typography).toContain("font-synthesis: none");
    expect(typography).toMatch(/--md-font-heading: "Whole Chomp", "Hanken Grotesk"/);
  });

  it("uses the font's letters only, so digits and punctuation fall back to Hanken (the free cut draws nothing for them)", () => {
    expect(typography).toContain("unicode-range: U+0041-005A, U+0061-007A;");
    expect(typography).toContain("font-weight: 100 900;");
  });

  it("does not use Times New Roman anywhere (withdrawn by the owner)", () => {
    expect(typography).not.toMatch(/font-family:[^;]*Times/);
    expect(typography).not.toContain(".md-figure");
    expect(typography).not.toContain(".md-formal");
  });

  it("loads the font file that is in public/fonts, next to its licence text", () => {
    const src = typography.match(/url\("\/fonts\/([^"]+)"\)/)?.[1];
    expect(src).toBe("WholeChomp-Regular.otf");
    expect(fs.existsSync(path.join(publicFonts, src!))).toBe(true);
    expect(fs.existsSync(path.join(publicFonts, "1001fonts-whole-chomp-eula.txt"))).toBe(true);
  });
});
