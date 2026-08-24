/**
 * Portal themes.
 *
 * Each theme is a set of CSS custom properties applied by setting
 * `data-theme="<id>"` on <html>; the actual values live in index.css next to
 * the base :root palette, so all colours stay in one place. This file owns
 * the catalogue (ids, labels, preview swatches) and the list of tokens the
 * Customize panel is allowed to edit.
 *
 * Values are HSL triples without the hsl() wrapper ("201 100% 29%") because
 * that's the shape the stylesheet expects -it wraps them itself so it can do
 * alpha maths on them (see `hsl(var(--primary) / 0.5)` usage).
 */

export type ThemeId =
  | "default"
  | "dark"
  | "premium"
  | "mono"
  | "mono-dark"
  | "professional";

export type ThemeDef = {
  id: ThemeId;
  label: string;
  description: string;
  /** Small preview swatches shown on the theme card, in display order. */
  swatches: string[];
  /** True when the theme is a dark surface -used to pick preview text colour. */
  dark: boolean;
};

export const THEMES: ThemeDef[] = [
  {
    id: "default",
    label: "Default Theme",
    description: "The standard UKTextiles look — light blue-grey surfaces with UKT Blue accents.",
    swatches: ["#f0f5fa", "#ffffff", "#006496", "#0d2a38"],
    dark: false,
  },
  {
    id: "dark",
    label: "Dark Theme",
    description: "Low-light navy surfaces, easier on the eyes for long evening shifts.",
    swatches: ["#0f172a", "#1e293b", "#38bdf8", "#f8fafc"],
    dark: true,
  },
  {
    id: "premium",
    label: "Premium Theme",
    description: "Deep charcoal with warm gold accents — a richer, more formal presentation.",
    swatches: ["#14120e", "#211d16", "#c9a227", "#f5f0e6"],
    dark: true,
  },
  {
    id: "mono",
    label: "Black & White Theme",
    description: "Pure monochrome on white. Maximum contrast, no colour at all.",
    swatches: ["#ffffff", "#f4f4f5", "#18181b", "#000000"],
    dark: false,
  },
  {
    id: "mono-dark",
    label: "Black & White Background",
    description: "The monochrome palette inverted onto a black background.",
    swatches: ["#000000", "#141414", "#e5e5e5", "#ffffff"],
    dark: true,
  },
  {
    id: "professional",
    label: "Professional Theme",
    description: "Restrained corporate slate — muted, neutral, and quiet for reporting work.",
    swatches: ["#f8fafc", "#ffffff", "#334155", "#0f172a"],
    dark: false,
  },
];

export const DEFAULT_THEME: ThemeId = "default";

export function isThemeId(v: string): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/**
 * The subset of tokens the Customize panel exposes. Deliberately small: these
 * are the handful that visibly change the whole portal, rather than every
 * variable in the stylesheet (which would be unusable as a colour picker and
 * easy to make illegible with).
 */
export const CUSTOMIZABLE_TOKENS: { token: string; label: string; hint: string }[] = [
  { token: "--primary", label: "Primary", hint: "Buttons, links and active states" },
  { token: "--background", label: "Background", hint: "The page behind every card" },
  { token: "--card", label: "Card surface", hint: "Panels, tables and dialogs" },
  { token: "--foreground", label: "Text", hint: "Default body text colour" },
  { token: "--sidebar", label: "Sidebar", hint: "Left navigation background" },
  { token: "--accent", label: "Accent", hint: "Highlights and selected rows" },
];

// ── HSL triple <-> hex, for the colour inputs ────────────────────────────
// <input type="color"> only speaks hex, but the stylesheet stores HSL
// triples, so the Customize panel converts in both directions.

export function hslTripleToHex(triple: string): string {
  const m = triple.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return "#000000";
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;

  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const to255 = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

export function hexToHslTriple(hex: string): string {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return "0 0% 0%";
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  const round = (v: number) => Math.round(v * 10) / 10;
  return `${round(h * 360)} ${round(s * 100)}% ${round(l * 100)}%`;
}
