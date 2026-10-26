import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, hslTripleToHex, isThemeId, THEMES } from "@/lib/themes";
import { contrastRatio } from "@/pages/hr/settings/identity/colours";
import { PALETTES } from "@/pages/hr/settings/themes/palettes";
import {
  colourDeclarations,
  importantDeclarations,
  parseBlocks,
  readThemeFile,
  SCOPE,
  splitSelectors,
  stripComments,
  styleRules,
  themeFiles,
} from "./scan";

// Guards the Clean Professional theme (src/themes/clean/). The theme is an alternative to the glass-and-clay look and is
// applied only when the owner picks it in Settings -> Themes, so these tests hold the rules that keep it from leaking:
//   * every selector starts with the clean scope (html[data-theme="clean"]:not([data-md-theme])), so no other theme and
//     never the MD portal can match it; @keyframes steps are the one thing exempt, since they select nothing;
//   * a colour value is written in tokens.css only, everything else reads a variable;
//   * !important is rare, documented and capped;
//   * every Tailwind colour family is remapped, the palette is readable (WCAG AA), and the catalogue lists the theme.

const FILES = themeFiles();
const CSS_FILES = FILES.filter((f) => f !== "index.css");

describe("what the theme is made of", () => {
  it("has the files the docs name", () => {
    for (const file of [
      "index.css",
      "tokens.css",
      "tailwind-remap.css",
      "base.css",
      "primitives.css",
      "forms.css",
      "tables.css",
      "overlays.css",
      "badges.css",
      "layout.css",
    ]) {
      expect(FILES, file).toContain(file);
    }
  });

  it("imports every file of the folder, once, from index.css (an area file included)", () => {
    const imports = parseBlocks(readThemeFile("index.css"))
      .map((b) => b.prelude.match(/^@import\s+"([^"]+)"/)?.[1])
      .filter((x): x is string => !!x)
      .map((x) => x.replace(/^\.\//, ""));
    for (const file of CSS_FILES) expect(imports, `${file} is imported`).toContain(file);
    expect(new Set(imports).size, "no file is imported twice").toBe(imports.length);
    for (const imported of imports) expect(FILES, `${imported} exists`).toContain(imported);
  });

  it("is imported once from src/index.css, after the MD portal's skin, and only there", () => {
    const root = fs.readFileSync(path.join(import.meta.dirname, "../../index.css"), "utf8");
    const imports = [...root.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => i.includes("themes/clean"))).toEqual(["./themes/clean/index.css"]);
    expect(imports.indexOf("./themes/clean/index.css")).toBeGreaterThan(imports.indexOf("./md-theme/index.css"));
    // nothing else in the app imports it
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "clean" && dir.endsWith("themes") ? [] : walk(full);
        return /\.(tsx?|css)$/.test(e.name) ? [full] : [];
      });
    const users = walk(path.join(import.meta.dirname, "../.."))
      .filter((f) => !/\.test\./.test(f))
      .filter((f) => /(?:\bfrom\s+|\bimport\s+|@import\s+)["'][^"']*themes\/clean/.test(fs.readFileSync(f, "utf8")));
    expect(users.map((f) => path.basename(f))).toEqual(["index.css"]);
  });
});

describe("the theme stays inside its scope", () => {
  for (const file of CSS_FILES) {
    it(`${file}: every selector starts with ${SCOPE}`, () => {
      const stray = styleRules(readThemeFile(file))
        .flatMap((r) => splitSelectors(r.prelude))
        .filter((s) => !s.startsWith(SCOPE));
      expect(stray).toEqual([]);
    });
  }

  it('a rule\'s scope is the whole prefix, not a look-alike (html[data-theme="clean"] without the MD exclusion is refused)', () => {
    const sloppy = styleRules('html[data-theme="clean"] .x { color: red }').flatMap((r) => splitSelectors(r.prelude));
    expect(sloppy.filter((s) => !s.startsWith(SCOPE))).toEqual(['html[data-theme="clean"] .x']);
  });

  it("holds only style rules, keyframes, media queries and imports (nothing that applies without the scope)", () => {
    for (const file of FILES) {
      for (const block of parseBlocks(readThemeFile(file))) {
        if (!block.prelude.startsWith("@")) continue;
        expect(block.prelude, `${file}: ${block.prelude}`).toMatch(
          /^@(import|keyframes|media|supports|font-face|layer)\b/,
        );
        // an at-rule that styles things by itself (@font-face, @property, @layer with rules) is not allowed to leak
        expect(block.prelude, file).not.toMatch(/^@(property|font-face|page|namespace|charset)\b/);
      }
    }
  });

  it("never reads or writes an MD token, and only names the MD attribute to exclude it", () => {
    for (const file of FILES) {
      const css = stripComments(readThemeFile(file));
      expect(css, `${file}: --md- variables`).not.toMatch(/--md-/);
      const mentions = css.match(/data-md-theme/g) ?? [];
      const exclusions = css.match(/:not\(\[data-md-theme\]\)/g) ?? [];
      expect(mentions.length, `${file}: data-md-theme only inside :not(...)`).toBe(exclusions.length);
    }
  });

  it("does not use the portal-wide selectors a stray rule would leak through (:root, html alone, body alone)", () => {
    for (const file of CSS_FILES) {
      const selectors = styleRules(readThemeFile(file)).flatMap((r) => splitSelectors(r.prelude));
      expect(selectors.filter((s) => /^(:root|html|body|\*)\b/.test(s) && !s.startsWith(SCOPE))).toEqual([]);
    }
  });
});

describe("colours live in tokens.css", () => {
  for (const file of CSS_FILES.filter((f) => f !== "tokens.css")) {
    it(`${file}: no hex, rgb(), hsl() or named colour in a declaration`, () => {
      // the selector is not a declaration: [fill="#006496"] and [class~="text-[#006496]"] name the old colours on purpose
      const offenders = colourDeclarations(readThemeFile(file));
      expect(offenders).toEqual([]);
    });
  }

  it("tokens.css holds the palette (hex ramps and the app's HSL tokens)", () => {
    const tokens = stripComments(readThemeFile("tokens.css"));
    expect(tokens).toMatch(/--clean-n-500:\s*#[0-9a-f]{6};/i);
    expect(tokens).toMatch(/--primary:\s*[\d.]+ [\d.]+% [\d.]+%;/);
  });

  it("tokens.css only declares variables: no rule that paints anything", () => {
    for (const rule of styleRules(readThemeFile("tokens.css"))) {
      for (const decl of rule.body
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)) {
        expect(decl.startsWith("--") || decl.startsWith("color-scheme"), decl).toBe(true);
      }
    }
  });
});

describe("!important is rare and says why", () => {
  // It is needed in exactly two situations: to beat an INLINE style (HrLayout, the sidebar and PillTabs colour themselves
  // inline) and to beat a legacy !important in index.css (.clay-tabs-*, .clay-input). Each such declaration carries a
  // comment saying which. The budget may only go down; an area sweep that needs more adds its own file and its own line.
  const BUDGET: Record<string, number> = {
    "layout.css": 33,
    "primitives.css": 16,
    "tailwind-remap.css": 12,
  };
  const AREA_BUDGET = 40; // per file in areas/

  for (const file of CSS_FILES) {
    it(`${file}: every !important is explained, and there are no more than the budget`, () => {
      // a declaration ends in "!important;" (the comments that talk about the keyword do not)
      const lines = importantDeclarations(readThemeFile(file));
      const unexplained = lines.filter((l) => !/\/\*\s*(inline style|legacy !important)/.test(l));
      expect(unexplained).toEqual([]);
      const budget = file.startsWith("areas/") ? AREA_BUDGET : (BUDGET[file] ?? 0);
      expect(lines.length, `${file} uses ${lines.length} !important`).toBeLessThanOrEqual(budget);
    });
  }
});

describe("the colour remap", () => {
  const remap = readThemeFile("tailwind-remap.css");

  it("remaps every Tailwind colour family, shade for shade, to a ramp of the theme", () => {
    const families = [
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
    ];
    for (const family of families) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(remap, `${family}-${shade}`).toMatch(
          new RegExp(`--color-${family}-${shade}: var\\(--clean-[nbswd]-${shade}\\);`),
        );
      }
    }
  });

  it("gives green to good, amber to watch and red to bad, and nothing else", () => {
    const family = (name: string) =>
      remap.match(new RegExp(`--color-${name}-500: var\\(--clean-([nbswd])-500\\)`))?.[1];
    for (const name of ["green", "emerald", "lime"]) expect(family(name), name).toBe("s");
    for (const name of ["amber", "yellow", "orange"]) expect(family(name), name).toBe("w");
    for (const name of ["red", "rose", "pink"]) expect(family(name), name).toBe("d");
    for (const name of ["blue", "sky", "cyan", "teal", "indigo", "violet", "purple", "fuchsia"]) {
      expect(family(name), name).toBe("b");
    }
    for (const name of ["slate", "gray", "zinc", "neutral", "stone"]) expect(family(name), name).toBe("n");
  });

  it("switches off the decorative utilities: shadows, backdrop blur, gradients, lifts and pulsing halos", () => {
    const css = stripComments(remap).replace(/\s+/g, " ");
    expect(css).toContain("--tw-shadow-color: transparent");
    expect(css).toMatch(/backdrop-blur"\][^{]*\{[^}]*backdrop-filter: none/);
    expect(css).toMatch(/bg-gradient-to-[^{]*\{[^}]*background-image: none/);
    expect(css).toMatch(/hover:-translate-y[^{]*\{[^}]*translate: none/);
    expect(css).toMatch(/animate-ping[^{]*\{[^}]*display: none/);
  });
});

describe("the palette is readable (WCAG AA)", () => {
  const tokens = stripComments(readThemeFile("tokens.css"));
  const triple = (name: string) => tokens.match(new RegExp(`${name}:\\s*([\\d.]+ [\\d.]+% [\\d.]+%);`))![1];
  const hex = (name: string) => hslTripleToHex(triple(name));
  const ramp = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`))![1];
  const WHITE = "#ffffff";

  it("body text, muted text and the text on the main button", () => {
    expect(contrastRatio(hex("--foreground"), hex("--background"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hex("--foreground"), hex("--card"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hex("--muted-foreground"), hex("--background"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex("--muted-foreground"), hex("--card"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex("--primary-foreground"), hex("--primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex("--destructive-foreground"), hex("--destructive"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex("--accent-foreground"), hex("--accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex("--sidebar-foreground"), hex("--sidebar"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex("--primary"), hex("--background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the border of a field is a visible boundary (3:1 on a card)", () => {
    expect(contrastRatio(hex("--input"), hex("--card"))).toBeGreaterThanOrEqual(3);
  });

  it("the greys the pages use for secondary text stay readable, including the 'gray-400' ones", () => {
    expect(contrastRatio(ramp("--clean-n-400"), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ramp("--clean-n-500"), hex("--background"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ramp("--clean-n-600"), ramp("--clean-n-100"))).toBeGreaterThanOrEqual(4.5);
  });

  it("each status colour is readable as text on its own soft background (the chip pairs the code writes)", () => {
    for (const r of ["s", "w", "d"]) {
      expect(
        contrastRatio(ramp(`--clean-${r}-700`), ramp(`--clean-${r}-50`)),
        `${r}-700 on ${r}-50`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(ramp(`--clean-${r}-800`), ramp(`--clean-${r}-100`)),
        `${r}-800 on ${r}-100`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(WHITE, ramp("--clean-d-600"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WHITE, ramp("--clean-s-600"))).toBeGreaterThanOrEqual(4.5);
  });

  it("is the palette the Customize panel and the Themes card show (palettes.ts reads the same tokens)", () => {
    for (const [token, value] of Object.entries(PALETTES.clean)) expect(triple(token), token).toBe(value);
  });
});

describe("the catalogue", () => {
  it("lists Clean Professional next to the existing themes, which are unchanged", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "default",
      "dark",
      "premium",
      "mono",
      "mono-dark",
      "professional",
      "clean",
    ]);
    const clean = THEMES.find((t) => t.id === "clean")!;
    expect(clean.label).toBe("Clean Professional");
    expect(clean.description.length).toBeGreaterThan(20);
    expect(clean.dark).toBe(false);
    expect(clean.swatches).toHaveLength(4);
    // not to be confused with the muted-slate colour theme that already existed
    expect(THEMES.find((t) => t.id === "professional")!.label).toBe("Professional Theme");
  });

  it("accepts the id, refuses look-alikes, and the default is still the default", () => {
    expect(isThemeId("clean")).toBe(true);
    expect(isThemeId("Clean")).toBe(false);
    expect(isThemeId("clean ")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(DEFAULT_THEME).toBe("default");
  });
});

describe("the guards themselves catch what they are for", () => {
  it("the scope guard refuses a rule that is not under the clean scope (and keyframe steps are exempt)", () => {
    const css = `${SCOPE} .a { color: red } .leak { color: blue } @media (max-width: 1px) { .leak2 { color: blue } } @keyframes k { from { opacity: 0 } 50% { opacity: 1 } }`;
    const selectors = styleRules(css).flatMap((r) => splitSelectors(r.prelude));
    expect(selectors.filter((s) => !s.startsWith(SCOPE))).toEqual([".leak", ".leak2"]);
  });

  it("the colour guard catches a hex, rgb()/hsl() with numbers and a named colour, and lets a token read through", () => {
    const bad = `${SCOPE} .a { color: #fff; background: rgba(0, 0, 0, 0.5); border-color: hsl(210 20% 40%); outline-color: red; box-shadow: 0 1px 2px black }`;
    expect(colourDeclarations(bad)).toHaveLength(5);
    const fine = `${SCOPE} .a { color: hsl(var(--primary)); background: var(--clean-n-100); border: 1px solid transparent; box-shadow: 0 1px color-mix(in srgb, hsl(var(--foreground)) 10%, transparent) }`;
    expect(colourDeclarations(fine)).toEqual([]);
    // a selector that names an old colour is not a declaration
    expect(colourDeclarations(`${SCOPE} [fill="#006496"] { fill: var(--clean-b-600) }`)).toEqual([]);
  });

  it("the !important guard counts declarations, not the comments that talk about the keyword", () => {
    const css = `/* !important appears only ... */
${SCOPE} .a { color: var(--x) !important; /* inline style */ }
`;
    expect(importantDeclarations(css)).toHaveLength(1);
  });
});
