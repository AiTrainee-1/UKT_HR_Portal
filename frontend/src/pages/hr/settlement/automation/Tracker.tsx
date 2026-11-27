import type { ReactNode } from "react";
import { Link } from "wouter";
import { Check, Minus } from "lucide-react";
import type { SettlementTrackerKey, SettlementTrackerStep } from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../shared";

const STATE_WORD: Record<SettlementTrackerStep["state"], string> = {
  done: "Done",
  current: "Current step",
  pending: "Pending",
  skipped: "Skipped",
};

/** When and by whom a done stage was done: "26 Nov 2026, 10:15 am · Priya (HR)". */
const stampOf = (step: SettlementTrackerStep): string =>
  [step.at ? formatDateTime(step.at) : "", step.by ?? ""].filter(Boolean).join(" · ");

function Dot({ step, index }: { step: SettlementTrackerStep; index: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
        step.state === "done" && "bg-emerald-500 text-white",
        step.state === "current" && "bg-indigo-600 text-white ring-4 ring-indigo-100",
        step.state === "pending" && "border-2 border-slate-200 bg-white text-slate-400",
        step.state === "skipped" && "border-2 border-dashed border-slate-300 bg-slate-50 text-slate-400",
      )}
    >
      {step.state === "done" ? (
        <Check size={15} strokeWidth={3} />
      ) : step.state === "skipped" ? (
        <Minus size={14} strokeWidth={3} />
      ) : (
        index + 1
      )}
    </span>
  );
}

/**
 * The workflow's nine stages (owner 2026-11-26; HR Review of Auditor Changes added 2026-11-27): the done ones ticked with
 * when and by whom and what happened ("Approved by the auditor", "Sent by HR"), the current one highlighted with what has
 * to happen to move on, the pending ones grey, a skipped one (no auditor changes) dashed and greyed with why. Across the
 * page on a wide screen, down it on a phone. The state is in words too (for screen readers), never in the colour alone.
 */
export default function Tracker({
  steps,
  received,
  label = "Loan & Advance workflow",
  onSelect,
  selected = null,
}: {
  steps: SettlementTrackerStep[];
  /** The requests in the batch: the first stage's figure. */
  received: number;
  /** What the list is called for a screen reader ("Salary Advance workflow"). */
  label?: string;
  /** Clickable stages (owner 2026-11-27): a click lists that stage's requests under the tracker. */
  onSelect?: (key: SettlementTrackerKey) => void;
  /** The stage listed under the tracker now. */
  selected?: SettlementTrackerKey | null;
}) {
  const current = steps.find((s) => s.state === "current");
  const detail = (step: SettlementTrackerStep) =>
    step.key === "received" && step.state === "done"
      ? `${received} ${received === 1 ? "request" : "requests"}`
      : step.state === "done"
        ? stampOf(step)
        : "";
  // what happened at a stage (a done one: "Approved by the auditor"; a skipped one: "No auditor changes")
  const what = (step: SettlementTrackerStep) =>
    step.state === "done" || step.state === "skipped" ? step.detail : null;
  const ink = (state: SettlementTrackerStep["state"]) =>
    cn(
      state === "done" && "text-slate-800",
      state === "current" && "text-indigo-700",
      (state === "pending" || state === "skipped") && "text-slate-400",
    );
  // a clickable stage is a button around its dot and words (the line between the stages stays outside it)
  const press = (step: SettlementTrackerStep, testId: string, className: string, body: ReactNode) =>
    onSelect ? (
      <button
        type="button"
        onClick={() => onSelect(step.key)}
        aria-pressed={selected === step.key}
        title={`Show the requests of ${step.label}`}
        className={cn(
          className,
          "rounded-xl transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
          selected === step.key && "bg-indigo-50/80 ring-1 ring-indigo-200",
        )}
        data-view-safe
        data-testid={testId}
      >
        {body}
      </button>
    ) : (
      <div className={className}>{body}</div>
    );

  return (
    <div data-testid="settlement-tracker">
      {/* wide screens: across */}
      <ol className="hidden lg:grid lg:grid-cols-9 lg:gap-1" aria-label={label}>
        {steps.map((step, i) => (
          <li
            key={step.key}
            className="relative flex flex-col items-center px-1 text-center"
            aria-current={step.state === "current" ? "step" : undefined}
            data-testid={`tracker-step-${step.key}`}
            data-state={step.state}
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  "absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2",
                  step.state === "pending" ? "bg-slate-200" : "bg-emerald-400",
                )}
              />
            )}
            {press(
              step,
              `tracker-open-${step.key}`,
              "relative z-10 flex w-full flex-col items-center px-0.5 pb-1",
              <>
                <Dot step={step} index={i} />
                <p className={cn("mt-2 text-[12px] font-semibold leading-tight", ink(step.state))}>
                  <span className="sr-only">{STATE_WORD[step.state]}: </span>
                  {step.label}
                </p>
                {what(step) && (
                  <p
                    className={cn(
                      "mt-0.5 text-[10.5px] font-semibold leading-snug",
                      step.state === "skipped" ? "italic text-slate-400" : "text-emerald-700",
                    )}
                    data-testid={`tracker-detail-${step.key}`}
                  >
                    {what(step)}
                  </p>
                )}
                {detail(step) && <p className="mt-0.5 text-[10.5px] leading-snug text-slate-500">{detail(step)}</p>}
                {step.state === "current" && (
                  <span className="mt-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700">
                    Now
                  </span>
                )}
              </>,
            )}
          </li>
        ))}
      </ol>

      {/* phones and tablets: down */}
      <ol className="space-y-0 lg:hidden" aria-label={label}>
        {steps.map((step, i) => (
          <li
            key={step.key}
            className="relative flex gap-3 pb-4 last:pb-0"
            aria-current={step.state === "current" ? "step" : undefined}
            data-testid={`tracker-row-${step.key}`}
            data-state={step.state}
          >
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-4 top-8 h-[calc(100%-2rem)] w-0.5 -translate-x-1/2",
                  steps[i + 1].state === "pending" ? "bg-slate-200" : "bg-emerald-400",
                )}
              />
            )}
            {press(
              step,
              `tracker-row-open-${step.key}`,
              "flex min-w-0 flex-1 gap-3 text-left",
              <>
                <Dot step={step} index={i} />
                <div className="min-w-0 pt-1">
                  <p className={cn("text-[13px] font-semibold leading-snug", ink(step.state))}>
                    <span className="sr-only">{STATE_WORD[step.state]}: </span>
                    {step.label}
                  </p>
                  {what(step) && (
                    <p
                      className={cn(
                        "text-[11px] font-semibold",
                        step.state === "skipped" ? "italic text-slate-400" : "text-emerald-700",
                      )}
                    >
                      {what(step)}
                    </p>
                  )}
                  {detail(step) && <p className="text-[11px] text-slate-500">{detail(step)}</p>}
                  {step.state === "current" && step.action && (
                    <p className="mt-1 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-[12px] font-medium text-indigo-800">
                      {step.action}
                    </p>
                  )}
                </div>
              </>,
            )}
          </li>
        ))}
      </ol>

      {current?.action && (
        <p
          className="mt-4 hidden items-start gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-[13px] text-indigo-900 lg:flex"
          data-testid="tracker-next-action"
        >
          <span className="font-bold">Next: </span>
          <span>{current.action}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The tracker at a glance (the Overview's panels, owner 2026-11-27): the nine stages as one row of segments, done green,
 * the current one indigo, a skipped one (no auditor changes) pale, the rest grey, with "Step 4 of 9 · HR Final
 * Settlement" under it. Every stage is named for a screen reader and on hover; the full tracker is on the type's page.
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
  const at = steps.findIndex((s) => s.state === "current");
  const done = steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "skipped");
  const where =
    at >= 0
      ? `Step ${at + 1} of ${steps.length} · ${steps[at].label}`
      : done
        ? `All ${steps.length} steps done`
        : "Not started";
  return (
    <div data-testid={testId}>
      <ol className="flex gap-1" aria-label={label}>
        {steps.map((step) => (
          <li
            key={step.key}
            title={`${step.label}: ${STATE_WORD[step.state]}${step.state === "skipped" && step.detail ? ` (${step.detail})` : ""}`}
            className={cn(
              "h-2 flex-1 rounded-full",
              step.state === "done" && "bg-emerald-500",
              step.state === "current" && "bg-indigo-600 ring-2 ring-indigo-100",
              step.state === "pending" && "bg-slate-200",
              step.state === "skipped" && "border border-dashed border-slate-300 bg-slate-50",
            )}
            aria-current={step.state === "current" ? "step" : undefined}
            data-state={step.state}
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
        ))}
      </ol>
      <p
        className="mt-1.5 text-[11px] font-semibold text-slate-600"
        data-testid={testId ? `${testId}-where` : undefined}
      >
        {where}
      </p>
    </div>
  );
}
