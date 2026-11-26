import { cn } from "@/lib/utils";
import { countedAfterLabel } from "@/lib/day-progress";

// The "In progress" chip of a day whose shift is still running (see src/lib/day-progress.ts): a neutral chip with a pulsing
// dot, shown instead of the Present / Half Day verdict. Its tooltip (and the text a screen reader hears) says when the day
// is counted: "Counted after the shift ends at 18:11".

const CHIP_SIZE = { sm: "px-1.5 py-0.5 text-[10px]", md: "px-2 py-0.5 text-[11px]" } as const;

export function InProgressChip({
  provisionalUntil,
  size = "md",
  className,
  testId = "in-progress-chip",
}: {
  provisionalUntil?: string | null;
  size?: "sm" | "md";
  className?: string;
  testId?: string;
}) {
  const title = countedAfterLabel(provisionalUntil);
  return (
    <span
      title={title}
      data-testid={testId}
      data-in-progress="true"
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-300 bg-slate-50 font-semibold text-slate-700",
        CHIP_SIZE[size],
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75 motion-safe:animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
      </span>
      In progress
      <span className="sr-only">. {title}</span>
    </span>
  );
}
