import { useEffect, useRef, type ReactNode } from "react";
import { gsap } from "gsap";

export type PillTabItem = {
  value: string;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  /** Overrides baseColor for just this pill's fill — for cases where each
   * option carries its own meaning (e.g. amber=Production, green=Staff). */
  color?: string;
};

type Timeline = gsap.core.Timeline;
type Tween = gsap.core.Tween;

/**
 * Segmented pill-tab switcher with a GSAP liquid-circle-fill animation —
 * adapted from the React Bits PillNav component's hover mechanics (the
 * radius/origin math that makes the fill look like it's rising out of the
 * pill's own curvature), but built for in-page filter/view toggles rather
 * than site navigation: no logo, no router links, no mobile hamburger menu.
 *
 * Unlike the original (where the circle-fill is a hover-only preview and
 * the "current page" gets a small dot indicator), the active item here
 * stays filled permanently — this is a segmented control, not a nav bar,
 * so the selection needs a persistent state, not just a hover echo.
 */
export function PillTabs({
  items, value, onChange, baseColor = "#111827", pillBg = "#f3f4f6",
  activeTextColor = "#ffffff", idleTextColor = "#4b5563", ease = "power3.out",
  size = "md", className = "",
}: {
  items: PillTabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Fill color of the animated circle + active label text background context. */
  baseColor?: string;
  /** Background of the pill-row track. */
  pillBg?: string;
  activeTextColor?: string;
  idleTextColor?: string;
  ease?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const circleRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const tlRefs = useRef<(Timeline | null)[]>([]);
  const activeTweenRefs = useRef<(Tween | null)[]>([]);
  const prevActiveRef = useRef<number>(-1);

  const activeIndex = items.findIndex((it) => it.value === value);
  const itemsKey = items.map((it) => `${it.value}:${it.count ?? ""}`).join("|");

  useEffect(() => {
    const layout = () => {
      circleRefs.current.forEach((circle, i) => {
        const pill = circle?.parentElement;
        if (!circle || !pill) return;
        const { width: w, height: h } = pill.getBoundingClientRect();
        if (!w || !h) return;

        const R = ((w * w) / 4 + h * h) / (2 * h);
        const D = Math.ceil(2 * R) + 2;
        const delta = Math.ceil(R - Math.sqrt(Math.max(0, R * R - (w * w) / 4))) + 1;
        const originY = D - delta;

        circle.style.width = `${D}px`;
        circle.style.height = `${D}px`;
        circle.style.bottom = `-${delta}px`;
        gsap.set(circle, { xPercent: -50, scale: 0, transformOrigin: `50% ${originY}px` });

        const label = pill.querySelector<HTMLElement>(".ptab-label");
        const hoverLabel = pill.querySelector<HTMLElement>(".ptab-label-hover");
        if (label) gsap.set(label, { y: 0 });
        if (hoverLabel) gsap.set(hoverLabel, { y: h + 12, opacity: 0 });

        tlRefs.current[i]?.kill();
        const tl = gsap.timeline({ paused: true });
        tl.to(circle, { scale: 1.2, xPercent: -50, duration: 1, ease, overwrite: "auto" }, 0);
        if (label) tl.to(label, { y: -(h + 8), duration: 1, ease, overwrite: "auto" }, 0);
        if (hoverLabel) {
          gsap.set(hoverLabel, { y: Math.ceil(h + 40), opacity: 0 });
          tl.to(hoverLabel, { y: 0, opacity: 1, duration: 1, ease, overwrite: "auto" }, 0);
        }
        tlRefs.current[i] = tl;

        if (i === activeIndex) tl.progress(1);
      });
      prevActiveRef.current = activeIndex;
    };

    layout();
    const onResize = () => layout();
    window.addEventListener("resize", onResize);
    const fontsReady = document.fonts?.ready?.then(layout).catch(() => {});
    return () => {
      window.removeEventListener("resize", onResize);
      void fontsReady;
    };
    // Rebuild timelines whenever the item set (labels/counts) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, ease]);

  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev === activeIndex) return;

    if (prev >= 0 && tlRefs.current[prev]) {
      activeTweenRefs.current[prev]?.kill();
      activeTweenRefs.current[prev] = tlRefs.current[prev]!.tweenTo(0, { duration: 0.25, ease, overwrite: "auto" });
    }
    if (activeIndex >= 0 && tlRefs.current[activeIndex]) {
      const tl = tlRefs.current[activeIndex]!;
      activeTweenRefs.current[activeIndex]?.kill();
      activeTweenRefs.current[activeIndex] = tl.tweenTo(tl.duration(), { duration: 0.35, ease, overwrite: "auto" });
    }
    prevActiveRef.current = activeIndex;
  }, [activeIndex, ease]);

  const handleEnter = (i: number) => {
    if (i === activeIndex) return;
    const tl = tlRefs.current[i];
    if (!tl) return;
    activeTweenRefs.current[i]?.kill();
    activeTweenRefs.current[i] = tl.tweenTo(tl.duration(), { duration: 0.3, ease, overwrite: "auto" });
  };

  const handleLeave = (i: number) => {
    if (i === activeIndex) return;
    const tl = tlRefs.current[i];
    if (!tl) return;
    activeTweenRefs.current[i]?.kill();
    activeTweenRefs.current[i] = tl.tweenTo(0, { duration: 0.2, ease, overwrite: "auto" });
  };

  const pad = size === "sm" ? "px-3 h-8 text-xs" : "px-4 h-[34px] text-xs";

  return (
    <div
      role="tablist"
      className={`inline-flex items-stretch gap-[3px] p-[3px] rounded-full w-fit ${className}`}
      style={{ background: pillBg }}
    >
      {items.map((item, i) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={i === activeIndex}
          onClick={() => onChange(item.value)}
          onMouseEnter={() => handleEnter(i)}
          onMouseLeave={() => handleLeave(i)}
          className={`relative inline-flex items-center justify-center rounded-full font-bold whitespace-nowrap cursor-pointer overflow-hidden outline-none ${pad}`}
          style={{ color: idleTextColor }}
        >
          <span
            className="ptab-hover-circle absolute left-1/2 bottom-0 rounded-full pointer-events-none"
            style={{ background: item.color ?? baseColor, zIndex: 1, willChange: "transform" }}
            aria-hidden="true"
            ref={(el) => { circleRefs.current[i] = el; }}
          />
          <span className="relative inline-block leading-none" style={{ zIndex: 2 }}>
            <span className="ptab-label relative inline-flex items-center gap-1.5 leading-none" style={{ zIndex: 2, willChange: "transform" }}>
              {item.icon}
              {item.label}
              {item.count !== undefined && <span className="opacity-70 font-semibold">({item.count})</span>}
            </span>
            <span
              className="ptab-label-hover absolute left-0 top-0 inline-flex items-center gap-1.5 leading-none"
              style={{ zIndex: 3, color: activeTextColor, willChange: "transform, opacity" }}
              aria-hidden="true"
            >
              {item.icon}
              {item.label}
              {item.count !== undefined && <span className="opacity-80 font-semibold">({item.count})</span>}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
