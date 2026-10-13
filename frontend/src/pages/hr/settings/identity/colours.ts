// Colour helpers shared by the Company Documents, ID Card and Themes tabs.

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/**
 * A colour every reader of these settings understands: # and six hex digits. The short #RGB form is refused on
 * purpose: the PDF builders (reportlab HexColor) read "#abc" as 0x000abc, a dark blue, and the e-mailed ID card picture
 * falls back to green for it, while the browser shows the intended colour, so it would print differently from the screen.
 */
export const isHexColour = (value: string): boolean => HEX6.test(value.trim());

/** What the browser's colour picker should show: `#aabbcc` (a short `#abc` is expanded), or `fallback` for anything else. */
export function toPickerHex(value: string, fallback = "#000000"): string {
  const v = value.trim();
  if (HEX6.test(v)) return v.toLowerCase();
  if (HEX3.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return fallback;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a colour (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const n = parseInt(toPickerHex(hex).slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two colours: 1 (identical) to 21 (black on white). 4.5 is the usual bar for text. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ratio as the page shows it ("4.6 : 1"). */
export const contrastText = (ratio: number): string => `${ratio.toFixed(1)} : 1`;

/** Contrast normal-size text needs to be comfortably readable (WCAG AA). */
export const READABLE_RATIO = 4.5;

/** Six-digit hex with a two-digit alpha appended ("#0e4b3a" + 0.08 -> "#0e4b3a14"), for tints in the drawings. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${toPickerHex(hex)}${a}`;
}
