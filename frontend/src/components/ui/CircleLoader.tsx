import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { UktLogoMark } from "@/components/ui/UktLogoMark";

/**
 * Neumorphic circle loader -six discs that scale and spin on a stagger,
 * with a caption underneath that cycles through what is being fetched.
 *
 * Two changes from the supplied snippet, both required here:
 *
 *  1. No styled-components. It isn't a dependency of this project (styling
 *     is Tailwind + index.css), so the rules live in index.css instead. The
 *     animation itself -sizes, delays, gradients, shadows, keyframes -is
 *     unchanged.
 *  2. The caption rotates instead of reading a fixed "Loading...". The
 *     original's `fadeBlink` already pulses it, so the text swap rides that
 *     same rhythm rather than adding a second animation on top.
 *
 * Used on the Employees page only.
 */

/** Default rotation for the Employees table. */
const DEFAULT_TEXTS = [
  "UK Textiles",
  "Employee Details",
  "Loading",
  "Staff",
  "Production",
];

export function CircleLoader({
  texts = DEFAULT_TEXTS,
  intervalMs = 1500,
  logo = false,
  logoClassName = "h-24",
  className,
}: {
  /** Captions to cycle through. A single entry stays static. */
  texts?: string[];
  /** Matched to the caption's own 1.5s pulse so the swap lands on a beat. */
  intervalMs?: number;
  /** Show the UK Textiles mark above the circles. Used on the full-screen
   *  boot state, where the loader is the only thing on the page and the
   *  brand is what tells you which app is starting. */
  logo?: boolean;
  /** Height of the mark. Tailwind height class -h-24 is the boot-screen
   *  default; the mark keeps its aspect ratio, so only height is set. */
  logoClassName?: string;
  className?: string;
}) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (texts.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % texts.length), intervalMs);
    return () => clearInterval(t);
  }, [texts.length, intervalMs]);

  const body = (
    <div className="ukt-circle-wrap">
      <div className="ukt-circle-row">
        {Array.from({ length: 6 }).map((_, n) => (
          <div key={n} className="ukt-circle" />
        ))}
      </div>
      {/* key forces the pulse to restart on each swap, so a new word fades
          in rather than appearing mid-fade at whatever opacity the loop
          happened to be at. */}
      <div key={i} className="ukt-circle-text">
        {texts[i]}
      </div>
    </div>
  );

  if (!logo) {
    return (
      <div role="status" aria-label="Loading" className={className}>
        {body}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("flex flex-col items-center justify-center", className)}
    >
      <UktLogoMark className={cn("w-auto opacity-90", logoClassName)} />
      {body}
    </div>
  );
}

export default CircleLoader;
