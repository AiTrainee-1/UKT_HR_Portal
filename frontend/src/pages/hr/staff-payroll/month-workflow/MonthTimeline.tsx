import { CheckCircle2, Circle, Lock, Wallet, Wand2 } from "lucide-react";
import type { PayrollMonthStatus } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { timelineSteps, type TimelineStep } from "./logic";

const ICON: Record<TimelineStep["key"], typeof Wand2> = { generated: Wand2, finalized: Lock, paid: Wallet };

/**
 * The month's timeline: generated (first generated / last computed), finalized (when, by whom) and paid (when, by whom,
 * how many days after finalizing). `compact` is the one-line strip under the Payroll tab's buttons; the full form is in
 * the Payment Pending / Paid popups.
 */
export function MonthTimeline({
  status,
  now,
  compact = false,
}: {
  status: PayrollMonthStatus | undefined;
  now?: Date;
  compact?: boolean;
}) {
  const steps = timelineSteps(status, now);
  return (
    <ol
      className={cn(
        "grid gap-2",
        compact ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1",
        compact && "rounded-2xl border border-slate-100 bg-white/70 p-2.5",
      )}
      aria-label="The month's timeline"
      data-testid={compact ? "month-timeline-strip" : "month-timeline"}
    >
      {steps.map((step) => {
        const Icon = ICON[step.key];
        return (
          <li
            key={step.key}
            className={cn(
              "flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2",
              step.done ? "bg-emerald-50/70" : "bg-slate-50",
            )}
            data-testid={`month-step-${step.key}`}
            data-done={step.done ? "true" : "false"}
          >
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-lg p-1.5",
                step.done ? "bg-emerald-100 text-emerald-700" : "bg-white text-slate-400",
              )}
            >
              <Icon size={14} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-xs font-bold text-gray-900">
                {step.title}
                {step.done ? (
                  <CheckCircle2 size={12} className="text-emerald-600" aria-label="done" />
                ) : (
                  <Circle size={11} className="text-slate-300" aria-label="not yet" />
                )}
              </span>
              {step.when && (
                <span className="block text-xs font-semibold tabular-nums text-slate-700" data-testid="month-step-when">
                  {step.when}
                </span>
              )}
              <span className="block text-[11px] leading-snug text-muted-foreground" data-testid="month-step-detail">
                {step.detail}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
