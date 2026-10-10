import { useLayoutEffect } from "react";

// The Managing Director portal's skin (src/md-theme/*.css). It is switched on by an attribute on <html> while an MD page is
// mounted, not by a class on the page's own root, because dialogs, menus, toasts and tooltips render in a portal under
// <body>: only a rule on <html> reaches them. Every rule that changes how something looks is scoped to
// html[data-md-theme] (md-theme.test.ts checks that), so the HR portal, the login pages and the employee app are not
// affected, and the attribute is removed again when the MD leaves the portal.

export const MD_THEME_ATTRIBUTE = "data-md-theme";

/** The five colours the product owner chose. They are also CSS custom properties (md-theme/tokens.css); md-theme.test.ts
 *  keeps the two in step. Use these constants only where CSS cannot reach (a chart's stroke, a canvas). */
export const MD_PALETTE = {
  wine: "#7F011F",
  sand: "#F5EBD0",
  indigo: "#282B4A",
  alabaster: "#F3EFE7",
  vanilla: "#EEEBDA",
} as const;

/** Chart colours: series in the order a chart should use them (wine first, then indigo), the rest tuned to sit with them.
 *  The same hues as --chart-1..5 and the md-* ramps. */
export const MD_CHART = {
  series: ["#7F011F", "#282B4A", "#B85670", "#D49E32", "#568565", "#5559AB", "#985880", "#B8512B"],
  /** One colour per meaning, for charts that colour by meaning rather than by series. */
  good: "#337049",
  watch: "#B98220",
  bad: "#B72D33",
  neutral: "#8C8FAD",
  /** Gridlines, axes, and the text on a chart. */
  grid: "rgba(40, 43, 74, 0.10)",
  axis: "#4F5379",
  label: "#282B4A",
  /** A filled area under a line: the line's colour at this opacity. */
  areaOpacity: 0.14,
} as const;

let mounted = 0;

/** Turns the MD skin on while the calling layout is mounted. MdLayout calls it. Pages remount their layout on every
 *  navigation, so the attribute is only removed once no layout has come back by the next microtask (no flash). */
export function useMdTheme(): void {
  useLayoutEffect(() => {
    mounted += 1;
    document.documentElement.setAttribute(MD_THEME_ATTRIBUTE, "");
    return () => {
      mounted -= 1;
      queueMicrotask(() => {
        if (mounted === 0) document.documentElement.removeAttribute(MD_THEME_ATTRIBUTE);
      });
    };
  }, []);
}
