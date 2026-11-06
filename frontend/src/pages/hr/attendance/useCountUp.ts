import { useEffect, useRef, useState } from "react";

/** True when the person asked the system for less motion (or the browser cannot tell: then motion is allowed). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * A figure that counts up to `value` (from 0 the first time, from the figure it showed before when the value changes)
 * over `duration` ms with an ease-out. Someone who asked for less motion, and a test environment without
 * requestAnimationFrame, get the value straight away.
 */
export function useCountUp(value: number, duration = 700): number {
  const [shown, setShown] = useState(() =>
    prefersReducedMotion() || typeof requestAnimationFrame === "undefined" ? value : 0,
  );
  const from = useRef(shown);

  useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    if (start === value) return;
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = 1 - (1 - t) ** 3;
      const next = Math.round(start + (value - start) * eased);
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return shown;
}
