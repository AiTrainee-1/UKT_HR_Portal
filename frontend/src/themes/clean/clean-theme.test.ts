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
  // the area files, each at the count it has now (an area sweep that needs more adds its line and says why; it only goes down)
  const AREA_BUDGET: Record<string, number> = {
    "areas/attendance.css": 2,
    "areas/controls-auth.css": 26,
    "areas/payroll.css": 0,
    "areas/settings-reports.css": 25,
    "areas/shell-dashboard.css": 23,
  };

  for (const file of CSS_FILES) {
    it(`${file}: every !important is explained, and there are no more than the budget`, () => {
      // a declaration ends in "!important;" (the comments that talk about the keyword do not)
      const lines = importantDeclarations(readThemeFile(file));
      const unexplained = lines.filter((l) => !/\/\*\s*(inline style|legacy !important)/.test(l));
      expect(unexplained).toEqual([]);
      const budget = file.startsWith("areas/") ? (AREA_BUDGET[file] ?? 0) : (BUDGET[file] ?? 0);
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

describe("the shared rules the area files used to repeat", () => {
  const selectorsOf = (file: string) => styleRules(readThemeFile(file)).flatMap((r) => splitSelectors(r.prelude));

  it("a Radix radio is styled by its data-state; a radio button built by hand (role=radio, aria-checked) keeps its own classes", () => {
    for (const file of CSS_FILES) {
      if (file === "tokens.css") continue;
      for (const selector of selectorsOf(file).filter((x) => x.includes('[role="radio"]'))) {
        // a hand-built option card is matched only where its test id or state is named, never by the bare role
        const bare = !/\[data-state|\[aria-checked|\[data-testid|\.settings-|:focus-visible/.test(selector);
        expect(bare, `${file}: ${selector}`).toBe(false);
      }
    }
  });

  it("the solid button variants are written for an enabled button, so a disabled one falls to the grey disabled rule", () => {
    const variants = selectorsOf("primitives.css").filter((x) =>
      /\[data-variant="(default|destructive|outline)"\]\[class~="(bg-gradient-to-br|bg-red-50|border-slate-200)"\]/.test(
        x,
      ),
    );
    expect(variants.length).toBeGreaterThanOrEqual(6);
    for (const selector of variants) expect(selector, selector).toContain(":not(:disabled)");
    expect(selectorsOf("primitives.css").some((x) => x.endsWith('[data-slot="button"]:disabled'))).toBe(true);
  });

  it("a tab never shrinks inside the scrolling strip (flex: none is in the foundation, not repeated in an area)", () => {
    const rule = styleRules(readThemeFile("primitives.css")).find((r) => r.prelude.endsWith('[data-slot="pill-tab"]'));
    expect(rule?.body).toMatch(/flex:\s*none/);
  });

  it("a table of eight columns or more has its own, tighter padding (and a code does not wrap at its hyphen)", () => {
    const tables = stripComments(readThemeFile("tables.css"));
    expect(tables).toMatch(/table:has\(> thead th:nth-child\(8\)\)/);
    expect(tables).toMatch(/\[class~="font-mono"\][^{]*\{[^}]*white-space: nowrap/);
    // a cell's own pl-4 / pr-4 is respected, and the component's "[&:has([role=checkbox])]:pr-0" is not mistaken for one
    expect(tables).toContain('[class^="pl-"]');
    expect(tables).not.toContain('[class*="pr-"]');
  });

  it("the chosen chip is decided once, in primitives.css: no area file repeats the pressed / dark-chip rules", () => {
    expect(stripComments(readThemeFile("primitives.css"))).toContain('button[aria-pressed="true"]:not([data-slot]');
    for (const file of CSS_FILES.filter((f) => f.startsWith("areas/"))) {
      const css = stripComments(readThemeFile(file));
      expect(css, `${file}: a dark chip rule`).not.toMatch(/button[^{]*\[class~="bg-(slate|gray|zinc)-(800|900)"\]/);
      expect(css, `${file}: a segmented capsule rule`).not.toMatch(/div\[role="group"\][^{]*bg-gray-100/);
    }
  });

  it("the open menu row recolours its spans, but not a count bubble (white text on the red disc)", () => {
    const layout = selectorsOf("layout.css").filter(
      (x) => x.includes(".clay-nav-active") && x.includes(":is(span, svg)"),
    );
    expect(layout.length).toBeGreaterThan(0);
    for (const selector of layout.filter((x) => !x.includes(":has(")))
      expect(selector).toContain('[style*="linear-gradient"]');
  });
});

describe("plain colours only: nothing the oldest browser cannot draw", () => {
  // Chrome / Edge 110 and older (Windows 7 and 8.1 stop at Chrome 109) do not know color-mix(), oklch(), oklab(), lab(),
  // lch() or relative colours, and a browser that does not support CSS nesting (Chrome 111 to 119 on the Vite dev server) drops
  // what Tailwind nests inside a rule. Tailwind writes every colour mix as "the solid colour first, the mix in a nested
  // @supports", so the owner's old monitor drew each tint as the solid brand blue and the text on it vanished. The theme
  // therefore uses hsl() / rgb() / hex only: a tint is the primary at an opacity, hsl(var(--primary) / 12%).
  const FUNCTIONS = /\b(?:color-mix|oklch|oklab|lab|lch|color|light-dark)\(|\b(?:hsl|hsla|rgb|rgba|hwb)\(\s*from\b/;

  for (const file of FILES.filter((f) => f.endsWith(".css"))) {
    it(`${file}: no colour function that is newer than 2022, no relative colour`, () => {
      const css = stripComments(readThemeFile(file));
      const found = css
        .split(/[;{}]/)
        .map((d) => d.trim())
        .filter((d) => FUNCTIONS.test(d));
      expect(found).toEqual([]);
    });

    it(`${file}: no CSS nesting (a rule inside a rule, a & selector, an @supports inside a rule)`, () => {
      const css = stripComments(readThemeFile(file));
      const stack: ("style" | "at")[] = [];
      let statement = "";
      const nested: string[] = [];
      for (const ch of css) {
        if (ch === "{") {
          const kind = statement.trim().startsWith("@") ? "at" : "style";
          if (stack[stack.length - 1] === "style") nested.push(statement.trim().slice(0, 60));
          stack.push(kind);
          statement = "";
        } else if (ch === "}") {
          stack.pop();
          statement = "";
        } else if (ch === ";") statement = "";
        else statement += ch;
      }
      expect(nested).toEqual([]);
      const selectors = styleRules(readThemeFile(file)).flatMap((r) => splitSelectors(r.prelude));
      expect(selectors.filter((s) => /(^|[\s,(>+~])&/.test(s))).toEqual([]);
    });
  }

  it("the guards catch a colour mix, a relative colour and a nested rule", () => {
    expect(FUNCTIONS.test("background: color-mix(in srgb, red 10%, white)")).toBe(true);
    expect(FUNCTIONS.test("color: oklch(0.5 0.1 200)")).toBe(true);
    expect(FUNCTIONS.test("color: hsl(from var(--x) h s l)")).toBe(true);
    expect(FUNCTIONS.test("background: hsl(var(--primary) / 12%)")).toBe(false);
    expect(FUNCTIONS.test("background: rgb(var(--clean-white) / 60%)")).toBe(false);
  });

  it("the tints are the primary at an opacity and the dark steps are fixed colours", () => {
    const tokens = stripComments(readThemeFile("tokens.css"));
    for (const [step, pct] of [
      ["50", 9],
      ["100", 16],
      ["200", 28],
      ["300", 40],
      ["400", 62],
      ["500", 82],
    ] as const) {
      expect(tokens, `--clean-b-${step}`).toContain(`--clean-b-${step}: hsl(var(--primary) / ${pct}%);`);
    }
    expect(tokens).toContain("--clean-primary-soft: hsl(var(--primary) / 12%);");
    expect(tokens).toContain("--clean-primary-soft-hover: hsl(var(--primary) / 20%);");
    expect(tokens).toContain("--clean-hover: hsl(var(--primary) / 9%);");
    for (const [name, value] of [
      ["--clean-b-700", "#194a9a"],
      ["--clean-b-800", "#12376f"],
      ["--clean-b-900", "#103064"],
      ["--clean-b-950", "#0c2248"],
      ["--clean-primary-hover", "#194a9a"],
      ["--clean-primary-active", "#154084"],
      ["--clean-danger-hover", "#9b1e15"],
      ["--clean-page", "#eaeef3"],
    ] as const) {
      expect(tokens, name).toContain(`${name}: ${value};`);
    }
  });
});

describe("Tailwind's opacity utilities are written out as plain colours", () => {
  // bg-primary/10 and friends compile to the solid colour with the mix in a nested @supports; an old browser keeps the solid
  // one. tailwind-remap.css writes each utility the code uses as hsl(var(--token) / N%) inside :where() (no specificity of its
  // own, so every other rule of the theme still wins). A utility that the code starts to use and the file does not know fails
  // here: add it to the list in tailwind-remap.css.
  const remap = stripComments(readThemeFile("tailwind-remap.css"));
  const SRC = path.join(import.meta.dirname, "../..");
  const SKIP_DIRS = new Set(["md-theme", "md", "node_modules", "themes"]);
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(full);
      return /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
  const TOKENS =
    "primary|accent|muted|destructive|sidebar-accent|sidebar-primary|sidebar-foreground|sidebar|background|card|foreground|secondary|popover|border|input|ring|muted-foreground|accent-foreground|primary-foreground|white|black";
  const CLASS = new RegExp(
    `(?<![\\w-])((?:[\\w\\[\\]=.&>*():/-]+:)?(?:bg|text|border|ring)-(?:${TOKENS})/\\d+)(?![\\w.])`,
    "g",
  );

  // a class that is not drawn as a solid fallback that matters, or is dealt with by another rule of the theme
  const HANDLED = [
    /^dark:/, // the theme is light
    /^focus:bg-muted\/100$/, // 100% is the solid colour itself
    /^text-white\//, // text-white/20 ... 80 is solid white (the readability section of tailwind-remap.css)
    /^hover:text-white\//,
    /^(bg|text|border)-accent\/(5|10|30)$/, // the accent as a brand colour (the accent section of tailwind-remap.css)
    /^hover:(bg|border)-accent\/(5|50)$/,
    /^group-data-/, // a calendar day's focus ring, inside a group
  ];

  it("lists every opacity utility on a token that the application's pages use", () => {
    const used = new Set<string>();
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(CLASS)) used.add(m[1]);
    }
    expect(used.size, "the scan found the utilities").toBeGreaterThan(40);
    const missing = [...used].filter((c) => !HANDLED.some((h) => h.test(c))).filter((c) => !remap.includes(`"${c}"`));
    expect(missing).toEqual([]);
  });

  it("every one of those rules is wrapped in :where() and written with hsl()/rgb() at an opacity", () => {
    const rules = styleRules(readThemeFile("tailwind-remap.css")).filter(
      (r) => /\/\d+"\]/.test(r.prelude) && /:where\(/.test(r.prelude),
    );
    expect(rules.length).toBeGreaterThan(40);
    for (const rule of rules) {
      expect(rule.body, rule.prelude.slice(0, 80)).toMatch(/(?:hsl|rgb)\(var\(--[a-z-]+\) \/ \d+%\)/);
    }
  });
});

describe("no inline-colour rule matches a background colour by accident", () => {
  // style="background-color: rgb(220, 38, 38); color: white" contains the text "color: rgb(220, 38, 38)" inside
  // "background-color: rgb(220, 38, 38)", so [style*="color: rgb(220, 38, 38)"] would recolour the TEXT of a red box. The
  // property has to be matched from the start of the style attribute (^=) or after a space (*=" color: ...").
  for (const file of CSS_FILES) {
    it(`${file}: no [style*="color...] selector that can match background-color, border-color or outline-color`, () => {
      const css = stripComments(readThemeFile(file));
      const bad = css.match(/\[style\*=["']color[^\]]*\]/g) ?? [];
      expect(bad).toEqual([]);
    });
  }

  it("the guard catches the loose form and lets the anchored one through", () => {
    const loose = /\[style\*=["']color[^\]]*\]/;
    expect(loose.test('[style*="color: rgb(220, 38, 38)"]')).toBe(true);
    expect(loose.test('[style*="color"]')).toBe(true);
    expect(loose.test('[style^="color: rgb(220, 38, 38)"]')).toBe(false);
    expect(loose.test('[style*=" color: rgb(220, 38, 38)"]')).toBe(false);
    expect(loose.test('[style*="border-color: rgba(0, 100, 150"]')).toBe(false);
  });
});

describe("the palette is readable (WCAG AA)", () => {
  const tokens = stripComments(readThemeFile("tokens.css"));
  const triple = (name: string) => tokens.match(new RegExp(`${name}:\\s*([\\d.]+ [\\d.]+% [\\d.]+%);`))![1];
  const hex = (name: string) => hslTripleToHex(triple(name));
  // the page's own --border and --muted-foreground are set a second time below <html> (the stronger line, the darker text):
  // the last declaration in the file is the one the application uses, the first is the one the Themes card mirrors
  const lastTriple = (name: string) =>
    [...tokens.matchAll(new RegExp(`${name}:\\s*([\\d.]+ [\\d.]+% [\\d.]+%);`, "g"))].at(-1)![1];
  const usedHex = (name: string) => hslTripleToHex(lastTriple(name));
  const ramp = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`))![1];
  const WHITE = "#ffffff";
  // the page itself is a fixed colour a step darker than the white cards (--clean-page in tokens.css)
  const PAGE = tokens.match(/--clean-page:\s*(#[0-9a-fA-F]{6});/)![1];

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
    // text-gray-400 (the app's meta text) is read on the page colour, on a card and on a header row
    for (const surface of [PAGE, WHITE, ramp("--clean-n-100")]) {
      expect(contrastRatio(ramp("--clean-n-400"), surface), `n-400 on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ramp("--clean-n-500"), surface), `n-500 on ${surface}`).toBeGreaterThanOrEqual(5.5);
      expect(contrastRatio(ramp("--clean-n-600"), surface), `n-600 on ${surface}`).toBeGreaterThanOrEqual(6.5);
    }
    // secondary text (muted-foreground) is never lighter than the 600 step
    expect(contrastRatio(usedHex("--muted-foreground"), PAGE)).toBeGreaterThanOrEqual(6.5);
    expect(contrastRatio(usedHex("--muted-foreground"), ramp("--clean-n-100"))).toBeGreaterThanOrEqual(6.5);
  });

  it("holds up on a weak display: edges and fills are well clear of the surface they sit on", () => {
    // a card against the page, the line round a card and under a row, a field's edge, a secondary button's edge
    expect(contrastRatio(hex("--card"), PAGE)).toBeGreaterThanOrEqual(1.12);
    expect(contrastRatio(usedHex("--border"), hex("--card"))).toBeGreaterThanOrEqual(1.5);
    expect(contrastRatio(usedHex("--border"), PAGE)).toBeGreaterThanOrEqual(1.3);
    expect(contrastRatio(hex("--input"), WHITE)).toBeGreaterThanOrEqual(3.5);
    expect(contrastRatio(hex("--input"), PAGE)).toBeGreaterThanOrEqual(3.3);
    expect(contrastRatio(ramp("--clean-line-mid"), WHITE)).toBeGreaterThanOrEqual(2.2);
    // the hover / selected tint is a visible step from white, and its ink is far over AA
    expect(contrastRatio(hex("--sidebar-accent"), WHITE)).toBeGreaterThanOrEqual(1.15);
    expect(contrastRatio(hex("--accent-foreground"), hex("--sidebar-accent"))).toBeGreaterThanOrEqual(7);
    // the soft brand fills (the primary at 12 and 20% over white, over the page and over the other fill: a chosen chip, a row, a
    // band) with the dark brand ink the theme puts on them (--clean-b-800, a fixed colour)
    const primary = hex("--primary");
    const over = (pct: number, base: string) =>
      "#" +
      [1, 3, 5]
        .map((i) =>
          Math.round(parseInt(primary.slice(i, i + 2), 16) * pct + parseInt(base.slice(i, i + 2), 16) * (1 - pct)),
        )
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
    const ink = ramp("--clean-b-800");
    for (const surface of [WHITE, PAGE, over(0.12, WHITE)]) {
      for (const pct of [0.12, 0.2]) {
        expect(
          contrastRatio(ink, over(pct, surface)),
          `b-800 on ${pct * 100}% of the primary over ${surface}`,
        ).toBeGreaterThanOrEqual(7);
      }
    }
    // the dark brand text steps on the light tints they are written on (a badge: b-700 on b-50 / b-100)
    expect(contrastRatio(ramp("--clean-b-700"), over(0.09, WHITE))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(ramp("--clean-b-700"), over(0.16, PAGE))).toBeGreaterThanOrEqual(5.5);
    // an icon is never lighter than the 500 step (5.5:1 on the page)
    expect(contrastRatio(ramp("--clean-n-500"), PAGE)).toBeGreaterThanOrEqual(5.5);
  });

  it("the status and brand colours are readable as text on white, on the page and on their own tints (the text-*-500 darkening)", () => {
    // tailwind-remap.css gives text-red-500 / green-500 / amber-500 / blue-500 (and the 400s) the 600 of the ramp
    for (const r of ["s", "w", "d"]) {
      for (const bg of [WHITE, PAGE, ramp(`--clean-${r}-50`), ramp(`--clean-${r}-100`)]) {
        expect(contrastRatio(ramp(`--clean-${r}-600`), bg), `${r}-600 on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(hex("--primary"), PAGE)).toBeGreaterThanOrEqual(5.5);
    expect(contrastRatio(hex("--primary"), WHITE)).toBeGreaterThanOrEqual(6);
    // an icon in the 500 of a status ramp (a dot, a bar) still needs 3:1 on white
    for (const r of ["s", "w", "d"]) {
      expect(contrastRatio(ramp(`--clean-${r}-500`), WHITE), `${r}-500 on white`).toBeGreaterThanOrEqual(3);
    }
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
    const fine = `${SCOPE} .a { color: hsl(var(--primary)); background: var(--clean-n-100); border: 1px solid transparent; box-shadow: 0 1px hsl(var(--foreground) / 10%) }`;
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
