import { CUSTOMIZABLE_TOKENS, hslTripleToHex, type ThemeId } from "@/lib/themes";
import { contrastRatio, READABLE_RATIO } from "../identity/colours";

// The colours each theme really uses, copied from src/index.css (themes.test.ts reads that file and fails if they
// drift apart), so the theme cards, the drawings and the readability checks show the true palette.

export type PaletteToken =
  | "--background"
  | "--foreground"
  | "--card"
  | "--card-foreground"
  | "--primary"
  | "--primary-foreground"
  | "--accent"
  | "--accent-foreground"
  | "--sidebar"
  | "--sidebar-foreground"
  | "--muted-foreground"
  | "--border";

export const PALETTES: Record<ThemeId, Record<PaletteToken, string>> = {
  default: {
    "--background": "210 50% 97%",
    "--foreground": "201 60% 12%",
    "--card": "0 0% 100%",
    "--card-foreground": "201 60% 15%",
    "--primary": "201 100% 29%",
    "--primary-foreground": "0 0% 100%",
    "--accent": "201 100% 29%",
    "--accent-foreground": "0 0% 100%",
    "--sidebar": "210 50% 98%",
    "--sidebar-foreground": "201 100% 18%",
    "--muted-foreground": "215.4 16.3% 46.9%",
    "--border": "210 30% 88%",
  },
  dark: {
    "--background": "222 47% 11%",
    "--foreground": "210 40% 98%",
    "--card": "222 47% 11%",
    "--card-foreground": "210 40% 98%",
    "--primary": "210 40% 98%",
    "--primary-foreground": "222 47% 11%",
    "--accent": "25 95% 53%",
    "--accent-foreground": "222 47% 11%",
    "--sidebar": "222 47% 11%",
    "--sidebar-foreground": "210 40% 98%",
    "--muted-foreground": "215 20.2% 65.1%",
    "--border": "217 33% 17%",
  },
  premium: {
    "--background": "40 22% 6%",
    "--foreground": "40 30% 92%",
    "--card": "40 16% 11%",
    "--card-foreground": "40 30% 92%",
    "--primary": "45 70% 47%",
    "--primary-foreground": "40 25% 8%",
    "--accent": "45 70% 47%",
    "--accent-foreground": "40 25% 8%",
    "--sidebar": "40 20% 8%",
    "--sidebar-foreground": "40 28% 88%",
    "--muted-foreground": "40 15% 62%",
    "--border": "40 12% 18%",
  },
  mono: {
    "--background": "0 0% 100%",
    "--foreground": "0 0% 9%",
    "--card": "0 0% 100%",
    "--card-foreground": "0 0% 9%",
    "--primary": "0 0% 9%",
    "--primary-foreground": "0 0% 100%",
    "--accent": "0 0% 20%",
    "--accent-foreground": "0 0% 100%",
    "--sidebar": "0 0% 97%",
    "--sidebar-foreground": "0 0% 12%",
    "--muted-foreground": "0 0% 42%",
    "--border": "0 0% 87%",
  },
  "mono-dark": {
    "--background": "0 0% 0%",
    "--foreground": "0 0% 100%",
    "--card": "0 0% 8%",
    "--card-foreground": "0 0% 100%",
    "--primary": "0 0% 100%",
    "--primary-foreground": "0 0% 0%",
    "--accent": "0 0% 85%",
    "--accent-foreground": "0 0% 0%",
    "--sidebar": "0 0% 4%",
    "--sidebar-foreground": "0 0% 95%",
    "--muted-foreground": "0 0% 65%",
    "--border": "0 0% 22%",
  },
  professional: {
    "--background": "210 40% 98%",
    "--foreground": "222 47% 11%",
    "--card": "0 0% 100%",
    "--card-foreground": "222 47% 11%",
    "--primary": "215 25% 27%",
    "--primary-foreground": "0 0% 100%",
    "--accent": "215 20% 35%",
    "--accent-foreground": "0 0% 100%",
    "--sidebar": "0 0% 100%",
    "--sidebar-foreground": "215 25% 27%",
    "--muted-foreground": "215 16% 47%",
    "--border": "214 32% 91%",
  },
};

/** The six colours the Customize dialog edits (lib/themes.ts CUSTOMIZABLE_TOKENS); text.ts says what each colours. */
export const EDITABLE = CUSTOMIZABLE_TOKENS.map((t) => t.token);

/** Text that sits on an editable colour, and the token that colours that text (not editable in the dialog). */
export const TEXT_ON: Partial<Record<string, { token: PaletteToken; what: string }>> = {
  "--primary": { token: "--primary-foreground", what: "Text on it" },
  "--card": { token: "--card-foreground", what: "Card text" },
  "--sidebar": { token: "--sidebar-foreground", what: "Menu text" },
  "--accent": { token: "--accent-foreground", what: "Text on highlighted items" },
};

/** The two text colours the page switches to when a theme's own text would be unreadable on a custom colour. */
export const LIGHT_TEXT = "0 0% 100%";
export const DARK_TEXT = "222 47% 11%";

export const hex = (triple: string): string => hslTripleToHex(triple);
export const ratioOf = (a: string, b: string): number => contrastRatio(hex(a), hex(b));

export type TextCheck = {
  /** The theme's own text colour for this surface, on the custom colour. */
  themeRatio: number;
  /** The text colour that will be saved with it, or null when the theme's own text stays readable. */
  replacement: string | null;
  /** Contrast of the text that will actually show. */
  ratio: number;
};

/** Is the theme's own text still readable on a custom colour? If not, the more readable of white and near-black. */
export function textCheck(theme: ThemeId, token: string, value: string): TextCheck | null {
  const on = TEXT_ON[token];
  if (!on) return null;
  const own = PALETTES[theme][on.token];
  const themeRatio = ratioOf(value, own);
  if (themeRatio >= READABLE_RATIO) return { themeRatio, replacement: null, ratio: themeRatio };
  const light = ratioOf(value, LIGHT_TEXT);
  const dark = ratioOf(value, DARK_TEXT);
  return light >= dark
    ? { themeRatio, replacement: LIGHT_TEXT, ratio: light }
    : { themeRatio, replacement: DARK_TEXT, ratio: dark };
}

/** The editable colours of a saved set, without the text colours that were added to keep them readable. */
export function editableOf(custom: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(custom).filter(([t]) => EDITABLE.includes(t)));
}

/**
 * What to save for a theme: the edited colours that differ from the theme's own, plus, for each of them whose surface
 * would get unreadable text, the readable text colour. Comparing with the stylesheet's values (not the screen, which is
 * showing the very colours being edited) is what makes a first-time colour actually get saved.
 */
export function colourSet(theme: ThemeId, draft: Record<string, string>): Record<string, string> {
  const palette = PALETTES[theme] as Record<string, string>;
  const out: Record<string, string> = {};
  for (const token of EDITABLE) {
    const value = draft[token];
    if (!value || value === palette[token]) continue;
    out[token] = value;
    const check = textCheck(theme, token, value);
    const on = TEXT_ON[token];
    if (check?.replacement && on) out[on.token] = check.replacement;
  }
  return out;
}
