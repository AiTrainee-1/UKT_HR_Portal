import { useLayoutEffect, useState } from "react";

/** The content width of an element in pixels (0 where there is no layout, as in a test DOM). */
function contentWidth(el: HTMLElement): number {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const padding = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
  const width = el.clientWidth - padding;
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * Keeps track of an element's width: `const [ref, width] = useElementWidth()`, then `<div ref={ref}>`. The width is 0
 * until the element is measured, and stays 0 where nothing is laid out (jsdom), so callers treat 0 as "wide enough".
 */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(contentWidth(el));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (typeof w === "number") setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}
