import { expect, type Page } from "@playwright/test";

// The "invisible text and icons" audit of the Clean Professional theme, shared by e2e/theme-clean-contrast.spec.ts (every page,
// the current browser) and e2e/theme-clean-oldbrowser.spec.ts (the same pages with the page's CSS as an old browser sees it).
// It walks every visible piece of text and every icon, works out the colour it is drawn in and the colour it is drawn on (the
// ancestors' fills laid over one another, with their alpha), and reports text under 4.5:1 (3:1 for large text) and icons under
// 3:1. A background that is a gradient or a picture cannot be worked out and is skipped, as are disabled controls (exempt),
// charts (their colours are data) and the off-screen export sheets.

const MIN_TEXT = 4.5;
const MIN_LARGE_TEXT = 3;
const MIN_ICON = 3;

export type Offender = { kind: "text" | "icon"; where: string; sample: string; fg: string; bg: string; ratio: number };
export type Result = { checked: number; offenders: Offender[] };

/** Runs inside the page: no imports, nothing from the test file. */
export async function auditPage(page: Page): Promise<Result> {
  return page.evaluate(
    ({ minText, minLarge, minIcon }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      type Rgba = [number, number, number, number];
      const cache = new Map<string, Rgba | null>();
      const parse = (css: string): Rgba | null => {
        const hit = cache.get(css);
        if (hit !== undefined) return hit;
        let out: Rgba | null = null;
        if (css && !/url\(|gradient/.test(css)) {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#010203";
          ctx.fillStyle = css;
          if (ctx.fillStyle !== "#010203" || /1, 2, 3|#010203/.test(css)) {
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            out = [d[0], d[1], d[2], d[3] / 255];
          }
        }
        cache.set(css, out);
        return out;
      };
      const over = (top: Rgba, under: [number, number, number]): [number, number, number] => [
        top[0] * top[3] + under[0] * (1 - top[3]),
        top[1] * top[3] + under[1] * (1 - top[3]),
        top[2] * top[3] + under[2] * (1 - top[3]),
      ];
      const lum = (c: [number, number, number]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: [number, number, number], b: [number, number, number]) => {
        const x = lum(a);
        const y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const hex = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;

      /** What an element is drawn on: its ancestors' fills laid over one another. null = a gradient or picture: unknown. */
      const backdropCache = new WeakMap<Element, [number, number, number] | null>();
      const backdrop = (el: Element): [number, number, number] | null => {
        if (backdropCache.has(el)) return backdropCache.get(el)!;
        const cs = getComputedStyle(el);
        let out: [number, number, number] | null;
        if (cs.backgroundImage !== "none") out = null;
        else {
          const c = parse(cs.backgroundColor);
          if (c && c[3] >= 0.999) out = [c[0], c[1], c[2]];
          else {
            const under: [number, number, number] | null = el.parentElement
              ? backdrop(el.parentElement)
              : [255, 255, 255];
            out = under === null ? null : c && c[3] > 0 ? over(c, under) : under;
          }
        }
        backdropCache.set(el, out);
        return out;
      };
      const opacityCache = new WeakMap<Element, number>();
      const opacityOf = (el: Element): number => {
        const hit = opacityCache.get(el);
        if (hit !== undefined) return hit;
        const o = Number(getComputedStyle(el).opacity) * (el.parentElement ? opacityOf(el.parentElement) : 1);
        opacityCache.set(el, o);
        return o;
      };
      const where = (el: Element) => {
        const bits: string[] = [];
        for (let n: Element | null = el, i = 0; n && i < 4 && n !== document.body; n = n.parentElement, i++) {
          const id = n.getAttribute("data-testid") ?? n.getAttribute("data-slot") ?? n.getAttribute("role");
          const cls =
            typeof n.className === "string" ? n.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
          bits.push(`${n.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? `.${cls}` : ""}`);
        }
        return bits.join(" < ");
      };
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > window.innerWidth + 2000)
          return false;
        if (r.left < -1000 || r.top < -1000) return false;
        return (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      };
      const skipped = (el: Element) =>
        !!el.closest(
          ':disabled, [aria-disabled="true"], [data-disabled], .recharts-wrapper, [aria-hidden="true"][style*="-99999px"], option, script, style, noscript, [data-radix-focus-guard]',
        );

      const offenders: Offender[] = [];
      const seen = new Set<string>();
      let checked = 0;
      const report = (o: Offender) => {
        const key = `${o.kind}|${o.where}|${o.fg}|${o.bg}`;
        if (!seen.has(key)) {
          seen.add(key);
          offenders.push(o);
        }
      };

      // text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const done = new Set<Element>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!el || done.has(el) || !/[\p{L}\p{N}]/u.test(node.textContent ?? "") || skipped(el) || !shown(el)) continue;
        done.add(el);
        // text that is animating (a typed cursor, letters sliding in) is half transparent for a moment: not a resting state
        if (el.getAnimations().some((a) => a.playState === "running")) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.webkitTextFillColor || cs.color);
        const bg = backdrop(el);
        if (!fg || !bg || fg[3] === 0) continue;
        const fgc = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg);
        const r = ratio(fgc, bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        checked++;
        if (r < (large ? minLarge : minText)) {
          report({
            kind: "text",
            where: where(el),
            sample: (node.textContent ?? "").trim().slice(0, 40),
            fg: hex(fgc),
            bg: hex(bg),
            ratio: Math.round(r * 100) / 100,
          });
        }
      }

      // icons: the outermost svg of an icon (a lucide icon, a small inline drawing), not a chart
      for (const svg of Array.from(document.querySelectorAll("svg"))) {
        if (svg.parentElement?.closest("svg") || skipped(svg) || !shown(svg)) continue;
        const rect = svg.getBoundingClientRect();
        if (rect.width < 8 || rect.width > 48) continue;
        const cs = getComputedStyle(svg);
        let paint = cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0 ? cs.stroke : cs.fill;
        if (paint === "none") continue;
        // a drawing with its own coloured parts (the UKT mark, a logo) is not an icon in one colour
        if (
          svg.querySelector(
            "[fill]:not([fill='none']):not([fill='currentColor']), [stroke]:not([stroke='none']):not([stroke='currentColor'])",
          )
        ) {
          const mixed = new Set(
            Array.from(svg.querySelectorAll("*")).map((n) => getComputedStyle(n).fill + getComputedStyle(n).stroke),
          );
          if (mixed.size > 2) continue;
        }
        paint = paint.trim();
        const fg = parse(paint);
        const bg = backdrop(svg);
        if (!fg || !bg || fg[3] === 0) continue;
        const fgc = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(svg)], bg);
        const r = ratio(fgc, bg);
        checked++;
        if (r < minIcon) {
          report({
            kind: "icon",
            where: where(svg),
            sample:
              svg
                .getAttribute("class")
                ?.split(/\s+/)
                .find((c) => c.startsWith("lucide-")) ?? "svg",
            fg: hex(fgc),
            bg: hex(bg),
            ratio: Math.round(r * 100) / 100,
          });
        }
      }
      return { checked, offenders };
    },
    { minText: MIN_TEXT, minLarge: MIN_LARGE_TEXT, minIcon: MIN_ICON },
  );
}

/** The page has drawn: the shell (or a status screen / a form) is there and no loader or skeleton is still showing. */
export async function ready(page: Page) {
  await expect(page.locator('[data-ui-shell="main"], .ss-root, form')).not.toHaveCount(0, { timeout: 45_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          ".ukt-circle, .ukt-kpi-run, [data-slot=skeleton], .clay-skeleton, .spinnerContainer, .ss-grid",
        ),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400);
}
