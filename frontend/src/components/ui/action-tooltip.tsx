import { useState, type ReactNode } from "react";

const ACTION_TOOLTIP_COLORS = {
  blue: "#2563eb",
  emerald: "#059669",
  amber: "#d97706",
  red: "#dc2626",
} as const;

/**
 * Hover label that pops up above its child, scaling in from the bottom —
 * matches the reference "social icon" tooltip animation, restyled to this
 * app's action-button palette. Driven by real React hover state (not
 * Tailwind's group-hover variant) so the animation doesn't depend on CSS
 * cascade/layer ordering in whatever Tailwind version is configured.
 */
export function ActionTooltip({
  label, color, children,
}: {
  label: string;
  color: keyof typeof ACTION_TOOLTIP_COLORS;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
      <span
        className="pointer-events-none absolute bottom-full left-1/2 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-bold text-white shadow-lg"
        style={{
          marginBottom: 8,
          backgroundColor: ACTION_TOOLTIP_COLORS[color],
          transform: `translateX(-50%) scale(${hovered ? 1 : 0})`,
          opacity: hovered ? 1 : 0,
          transformOrigin: "bottom center",
          transition: "transform 0.2s ease, opacity 0.2s ease",
        }}
      >
        {label}
      </span>
    </span>
  );
}
