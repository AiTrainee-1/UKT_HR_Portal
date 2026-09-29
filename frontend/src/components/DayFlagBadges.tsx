import { cn } from "@/lib/utils";
import { LATE_FLAG_CLASS, type LateFlag } from "@/lib/late-detection";

/**
 * The Late / Early Out / Half Day / Allowed-or-Excess permission / Middle One-Hour badges for one attendance day (see
 * lateDetectionFlags in lib/late-detection.ts). Renders bare badges with no wrapper so each page keeps its own
 * flex-wrap row; every badge carries its longer explanation as a native tooltip.
 */
export function DayFlagBadges({ flags, size = "md" }: { flags: LateFlag[]; size?: "sm" | "md" }) {
  return (
    <>
      {flags.map((f) => (
        <span
          key={f.key}
          title={f.title}
          data-testid={`day-flag-${f.kind}`}
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap rounded-md border font-bold",
            size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
            LATE_FLAG_CLASS[f.kind],
          )}
        >
          {f.label}
          {f.detail && <span className="font-medium opacity-80">· {f.detail}</span>}
        </span>
      ))}
    </>
  );
}
