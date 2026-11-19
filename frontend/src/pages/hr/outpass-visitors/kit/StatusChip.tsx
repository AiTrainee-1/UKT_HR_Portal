import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The five tones of Gate Pass, Visitors and Tea Break:
 * teal = done and fine (back, checked out, allowed, on time); amber = going on now (out, on break, inside);
 * rose = needs attention (overdue, not returned, overtime, denied); indigo = waiting (pending); slate = neutral / off.
 */
export type KitTone = "teal" | "amber" | "rose" | "indigo" | "slate";

const CHIP: Record<KitTone, { box: string; dot: string }> = {
  teal: { box: "border-teal-200 bg-teal-50 text-teal-800", dot: "bg-teal-500" },
  amber: { box: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  rose: { box: "border-rose-200 bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  indigo: { box: "border-indigo-200 bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  slate: { box: "border-slate-200 bg-slate-50 text-slate-600", dot: "bg-slate-400" },
};

/**
 * The tone of every status word the three modules use (API values). A value not listed here is slate. A page with a
 * status of its own passes `tone` to StatusChip instead of adding to this.
 */
export const GATE_STATUS_TONE: Readonly<Record<string, KitTone>> = {
  // fine / done
  back: "teal",
  checked_out: "teal",
  allowed: "teal",
  on_time: "teal",
  active: "teal",
  // going on now
  out: "amber",
  on_break: "amber",
  in_progress: "amber",
  inside: "amber",
  // needs attention
  overdue: "rose",
  not_returned: "rose",
  overtime: "rose",
  denied: "rose",
  not_checked_out: "rose",
  // waiting
  pending: "indigo",
  // neutral / switched off
  inactive: "slate",
};

export const toneOf = (status: string | null | undefined): KitTone => GATE_STATUS_TONE[status ?? ""] ?? "slate";

/** A status as a dot and a word, never colour alone: `<StatusChip tone="rose">Overdue</StatusChip>`. */
export function StatusChip({
  tone = "slate",
  children,
  title,
  testId,
  className,
}: {
  tone?: KitTone;
  children: ReactNode;
  /** A longer explanation on hover ("Still out 25 min after the expected return"). */
  title?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        CHIP[tone].box,
        className,
      )}
      title={title}
      data-tone={tone}
      data-testid={testId}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", CHIP[tone].dot)} aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  );
}
