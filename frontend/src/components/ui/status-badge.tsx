import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TONE, type Tone } from "@/lib/statusTones";

/** Small rounded status pill. Pass a `tone` directly, or build the class from
 *  a status string with attendanceStatusClass()/requestStatusClass() in
 *  lib/statusTones when the colour depends on data. */
export function StatusBadge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
