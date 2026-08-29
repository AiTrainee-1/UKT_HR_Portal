import { cn } from "@/lib/utils";

/**
 * Shield-and-rupee loader -a shield outline that traces, a coin that pulses
 * inside it, and a scan line that sweeps down.
 *
 * Used on the money pages (Payroll, Production Payroll, Settlement, Reports),
 * where the security read matches what is being fetched.
 *
 * One change from the supplied snippet, forced: no styled-components. It
 * isn't a dependency of this project (styling is Tailwind + index.css), so
 * the rules live there. The SVG, its geometry, dasharrays, timings and
 * keyframes are unchanged.
 *
 * The one deliberate tweak: `size` defaults to 128 rather than the snippet's
 * 100, since the loader reads small in a full-width payroll table.
 */
export function ShieldLoader({
  size = 128,
  className,
}: {
  /** Rendered width and height in px; the viewBox is square. */
  size?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("flex w-full items-center justify-center py-10", className)}
    >
      <svg
        className="ukt-shield-svg"
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          className="ukt-shield-track"
          d="M32 4L52 12V28C52 42 44 52 32 59C20 52 12 42 12 28V12L32 4Z"
        />
        <path
          className="ukt-shield"
          pathLength={100}
          d="M32 4L52 12V28C52 42 44 52 32 59C20 52 12 42 12 28V12L32 4Z"
        />
        {/* Coin + rupee, in place of the original lock: these are the money
            pages, and a padlock reads as "secured" rather than as payroll. */}
        <circle className="ukt-coin" cx={32} cy={31} r={11} />
        <text
          className="ukt-rupee"
          x={32}
          y={31}
          textAnchor="middle"
          dominantBaseline="central"
        >
          ₹
        </text>
        <line className="ukt-scan" x1={16} y1={16} x2={48} y2={16} />
      </svg>
    </div>
  );
}

export default ShieldLoader;
