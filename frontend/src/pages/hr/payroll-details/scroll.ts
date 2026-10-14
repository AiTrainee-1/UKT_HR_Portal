import { useCallback, useEffect, useRef, useState } from "react";
import { pickActiveSection, sectionDomId } from "./logic";

// Scrolling on the details page. The page sits inside the HR shell, whose <main> is the element that scrolls (not the
// window), so nothing here assumes which one it is: the scroll container is found from the page itself.

/** The nearest ancestor that scrolls, or the window when none does. */
export function findScrollParent(el: HTMLElement | null): HTMLElement | Window {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return window;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Brings a section to the top of the page (under the sticky bar, thanks to the section's scroll margin). */
export function scrollToSection(id: string, smooth = true): boolean {
  const el = document.getElementById(sectionDomId(id));
  if (!el) return false;
  el.scrollIntoView?.({ behavior: smooth && !reducedMotion() ? "smooth" : "auto", block: "start" });
  return true;
}

/** Back to the top of the page (the header of the payroll that was just opened). */
export function scrollPageToTop(from: HTMLElement | null): void {
  const scroller = findScrollParent(from);
  if (scroller === window) document.documentElement.scrollTop = 0;
  else (scroller as HTMLElement).scrollTop = 0;
}

/** How far under the top of the scroll area the "reading line" is: a section whose top has passed it is the one in view. */
const READING_LINE = 96;

/**
 * Which section is in view, for the sticky nav. Listens to the scroll container and, on every frame of scrolling,
 * asks `pickActiveSection`. `jump` scrolls to a section and holds the highlight on it until the smooth scroll ends
 * (otherwise it would flicker through every section on the way). Without layout (jsdom) nothing is measured and the
 * first section stays active.
 */
export function useSectionSpy(ids: readonly string[]) {
  const [active, setActive] = useState<string>(ids[0]);
  const lockUntil = useRef(0);
  const idsKey = ids.join("|");

  useEffect(() => {
    const list = idsKey.split("|");
    const first = document.getElementById(sectionDomId(list[0]));
    if (!first) return;
    const scroller = findScrollParent(first);
    let frame = 0;

    const measure = () => {
      frame = 0;
      if (performance.now() < lockUntil.current) return;
      const found = list.flatMap((id) => {
        const el = document.getElementById(sectionDomId(id));
        return el ? [{ id, rect: el.getBoundingClientRect() }] : [];
      });
      if (found.length === 0 || found.every((s) => s.rect.height === 0 && s.rect.top === 0)) return;
      const scrollEl = scroller instanceof Window ? document.documentElement : scroller;
      const containerTop = scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
      const atBottom =
        scrollEl.scrollHeight > scrollEl.clientHeight + 8 &&
        scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
      const next = pickActiveSection(
        found.map((s) => ({ id: s.id, top: s.rect.top })),
        containerTop + READING_LINE,
        atBottom,
      );
      if (next) setActive(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [idsKey]);

  const jump = useCallback((id: string, smooth = true) => {
    setActive(id);
    lockUntil.current = performance.now() + (smooth ? 900 : 100);
    scrollToSection(id, smooth);
  }, []);

  return { active, jump };
}
