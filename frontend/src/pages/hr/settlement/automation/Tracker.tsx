import { Link } from "wouter";
import type { SettlementTrackerKey, SettlementTrackerStep } from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";

const STATE_WORD: Record<SettlementTrackerStep["state"], string> = {
  done: "Done",
  current: "Current step",
  pending: "Pending",
  skipped: "Skipped",
};

/** A rework loop stage (HR Rework (MD Changes) / (Auditor Changes)): the server marks it `loop`; an older server sends
 *  only the key. */
const isLoop = (step: SettlementTrackerStep) => step.loop ?? step.key.endsWith("_changes");

const times = (n: number) => (n === 1 ? "1 rework cycle" : `${n} rework cycles`);

/** Where the batch stands, in words: "Step 4 of 8 · HR Final Settlement", "Rework after step 3 of 8 · HR Rework (MD
 *  Changes)", "Step 3 of 8 · MD Review & Approval · round 2", "All 8 steps done · 1 rework cycle". The two rework loops
 *  are not steps every batch takes, so they are not counted as steps. */
export function trackerWhere(steps: SettlementTrackerStep[]): string {
  const main = steps.filter((s) => !isLoop(s));
  const cycles = steps.filter(isLoop).reduce((n, s) => n + (s.cycles ?? 0), 0);
  const current = steps.find((s) => s.state === "current");
  if (current && isLoop(current)) {
    const before = steps.slice(0, steps.indexOf(current)).filter((s) => !isLoop(s)).length;
    return `Rework after step ${before} of ${main.length} · ${current.label}${
      current.cycles && current.cycles > 1 ? ` · round ${current.cycles}` : ""
    }`;
  }
  if (current) {
    return `Step ${main.indexOf(current) + 1} of ${main.length} · ${current.label}${
      current.round && current.round > 1 ? ` · round ${current.round}` : ""
    }`;
  }
  const done = steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "skipped");
  return done ? `All ${main.length} steps done${cycles > 0 ? ` · ${times(cycles)}` : ""}` : "Not started";
}

/**
 * The tracker at a glance (the Overview's panels, owner 2026-11-27): the workflow's eight steps as one row of segments,
 * done green, the current one indigo, a skipped one pale, the rest grey; the two rework loops (2026-11-27) as short
 * segments beside the review they hang under, amber while HR reworks or once gone round, dashed when no rework was
 * needed. "Step 4 of 8 · HR Final Settlement" under it. Every stage is named for a screen reader and on hover; the full
 * branching tracker is on the type's page.
 */
export function CompactTracker({
  steps,
  label,
  testId,
  linkOf,
}: {
  steps: SettlementTrackerStep[];
  label: string;
  testId?: string;
  /** Clickable stages (owner 2026-11-27): each segment opens the type's page with that stage's requests listed. */
  linkOf?: (key: SettlementTrackerKey) => string;
}) {
  return (
    <div data-testid={testId}>
      <ol className="flex items-center gap-1" aria-label={label}>
        {steps.map((step) => {
          const loop = isLoop(step);
          const worked = loop && (step.state === "current" || (step.cycles ?? 0) > 0);
          return (
            <li
              key={step.key}
              title={`${step.label}: ${STATE_WORD[step.state]}${
                loop && (step.cycles ?? 0) > 0 ? ` (${times(step.cycles ?? 0)})` : ""
              }${step.state === "skipped" && step.detail ? ` (${step.detail})` : ""}`}
              className={cn(
                "rounded-full",
                loop ? "h-1.5 w-3 shrink-0" : "h-2 flex-1",
                !loop && step.state === "done" && "bg-emerald-500",
                !loop && step.state === "current" && "bg-indigo-600 ring-2 ring-indigo-100",
                worked && "bg-amber-500",
                worked && step.state === "current" && "ring-2 ring-amber-100",
                step.state === "pending" && "bg-slate-200",
                step.state === "skipped" && "border border-dashed border-slate-300 bg-slate-50",
                loop && step.state === "done" && !worked && "bg-slate-200",
              )}
              aria-current={step.state === "current" ? "step" : undefined}
              data-state={step.state}
              data-loop={loop ? "true" : undefined}
            >
              {linkOf ? (
                <Link
                  href={linkOf(step.key)}
                  className="-my-1.5 block h-5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                  data-testid={testId ? `${testId}-${step.key}` : undefined}
                >
                  <span className="sr-only">
                    {STATE_WORD[step.state]}: {step.label}. Show its requests
                  </span>
                </Link>
              ) : (
                <span className="sr-only">
                  {STATE_WORD[step.state]}: {step.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p
        className="mt-1.5 text-[11px] font-semibold text-slate-600"
        data-testid={testId ? `${testId}-where` : undefined}
      >
        {trackerWhere(steps)}
      </p>
    </div>
  );
}
