import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/components/md/kit/reduced-motion";
import { cn } from "@/lib/utils";

// The Dashboard's small motions without a motion library (2026-11-21): a figure counting up (requestAnimationFrame), a
// section rising in and a meter filling (CSS: md-rise / md-grow-x in md-theme/glass.css). All of them hold still with
// "reduce motion" on.

/**
 * A figure that counts up to its value when it first appears (and glides to a new value when the minute's refresh
 * changes it). With "reduce motion" on, or the first time a value is 0, it simply shows the value.
 */
export function CountUp({
  value,
  format = (n) => Math.round(n).toLocaleString("en-IN"),
  duration = 900,
  testId,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  testId?: string;
}) {
  const reduce = usePrefersReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(reduce ? value : 0);

  useEffect(() => {
    if (reduce || typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      setShown(value);
      from.current = value;
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(start + (value - start) * eased);
      if (t < 1) frame = window.requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      from.current = value;
    };
  }, [value, duration, reduce]);

  return (
    <span className="tabular-nums" data-testid={testId} data-value={value}>
      {format(shown)}
    </span>
  );
}

/** A section that rises in once, the first time it is drawn (staggered by `index`); still with "reduce motion" on. */
export function Reveal({
  children,
  index = 0,
  className,
  testId,
  labelledBy,
}: {
  children: ReactNode;
  index?: number;
  className?: string;
  testId?: string;
  labelledBy?: string;
}) {
  const style: CSSProperties | undefined = index ? { animationDelay: `${80 * index}ms` } : undefined;
  return (
    <section className={cn("md-rise", className)} style={style} data-testid={testId} aria-labelledby={labelledBy}>
      {children}
    </section>
  );
}

/** A thin bar that fills to `value` percent (0-100), with its meaning in an aria label. */
export function Meter({ value, color, label }: { value: number | null; color: string; label: string }) {
  const width = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-md-ink/[0.08]"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? 0}
    >
      <div
        className="md-grow-x h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
        style={{ width: `${width}%`, backgroundColor: color }}
      />
    </div>
  );
}
