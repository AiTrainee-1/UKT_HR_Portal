import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, BadgeCheck, CalendarClock, History, LocateFixed, Lock, Target } from "lucide-react";
import { dateShort, dateTime } from "@/components/payroll/kit/format";
import { Input } from "@/components/ui/input";
import type { CyclePeriod, CyclePeriodRow, ProductionPeriodWorkflow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { formatPeriod, samePeriod } from "./logic";
import {
  KIND_META,
  fieldDate,
  isIsoDay,
  payslipSummary,
  periodKind,
  periodSpan,
  periodTiming,
} from "./period-calendar";
import { periodStateOf } from "./period-workflow";

/** How long a date typed into From waits before it is used (a date is typed a part at a time). */
export const FROM_DELAY = { ms: 500 };

export type QuickPick = "next" | "latest" | "today";

/**
 * The pay period bar (owner 2026-11-16: "proper alignments"): the period on the left, every control in one column on
 * the right whose edges line up, the same with the calendar shown or hidden:
 *
 *   [icon] BiWeekly pay period                                  From [22-10-2026]  ->  To 04-11-2026
 *          22 Oct - 4 Nov 2026  NEXT DUE  Generated              [Next due | Latest | Today] [Show calendar]
 *          Thu 22 Oct -> Wed 4 Nov · 14 days
 *          Ended 4 Nov 2026 · 112 payslips · 112 on the cycle now
 *
 * On a narrower card the controls go below the period (dates and buttons side by side while they fit); on a phone they
 * are full width, the quick picks sharing a row with the calendar button. Any date typed into From opens the whole
 * period that holds it (To follows): a payroll is always one whole period. `action` is the calendar button.
 */
export function PeriodSummary({
  period,
  row,
  roster,
  today,
  workflow,
  limits,
  quick,
  onFromDate,
  onQuick,
  loading,
  cycleLabel,
  action,
}: {
  period: CyclePeriod | null;
  row: CyclePeriodRow | undefined;
  roster: number;
  today: string;
  workflow: ProductionPeriodWorkflow | undefined;
  limits: { min: string; max: string };
  quick: Record<QuickPick, CyclePeriodRow | undefined>;
  onFromDate: (date: string) => void;
  onQuick: (which: QuickPick) => void;
  loading: boolean;
  /** "BiWeekly" */
  cycleLabel: string;
  /** the calendar button */
  action?: ReactNode;
}) {
  const reduce = !!useReducedMotion();
  const [draft, setDraft] = useState<string | null>(null);
  const draftProblem =
    draft !== null && isIsoDay(draft) && (draft < limits.min || draft > limits.max)
      ? `Pick a date from ${dateShort(limits.min)} to ${dateShort(limits.max)}.`
      : null;

  // a date typed into From opens the period that holds it once the typing pauses; From then shows that period's start
  // (the latest handler is used, so periods arriving meanwhile never restart the wait)
  const pick = useRef(onFromDate);
  useEffect(() => {
    pick.current = onFromDate;
  });
  useEffect(() => {
    if (draft === null || !isIsoDay(draft) || draft < limits.min || draft > limits.max) return;
    const timer = setTimeout(() => {
      pick.current(draft);
      setDraft(null);
    }, FROM_DELAY.ms);
    return () => clearTimeout(timer);
  }, [draft, limits.min, limits.max]);

  const kind = row ? periodKind(row) : null;
  const meta = kind ? KIND_META[kind] : null;
  const ownWorkflow = workflow && period && samePeriod(workflow, period) ? workflow : undefined;
  const slips = row ? payslipSummary(row, roster) : null;
  const pop = reduce ? false : { opacity: 0, y: -4 };

  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-3 @4xl:grid-cols-[minmax(0,1fr)_auto] @4xl:items-center @4xl:gap-x-8"
      data-testid="pcp-period-summary"
    >
      {/* ── the period ── */}
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-xl bg-amber-50 p-2 text-amber-600" aria-hidden>
          <CalendarClock size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-gray-500">{cycleLabel} pay period</p>
          {/* a new period slides in (keyed: the old one simply goes) */}
          <motion.div
            key={period ? `${period.periodStart}|${period.periodEnd}` : "none"}
            initial={pop}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-black leading-tight text-gray-900"
                data-testid="pcp-period"
              >
                {period ? formatPeriod(period) : loading ? "Loading the pay periods…" : "No pay period chosen"}{" "}
                {row?.isNext && (
                  <span
                    className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
                    data-testid="pcp-period-next"
                  >
                    Next due
                  </span>
                )}
              </p>
              {row && kind && meta && (
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold",
                    meta.badge,
                  )}
                  title={meta.hint}
                  data-testid="pcp-period-state"
                  data-state={periodStateOf(row.state ?? (row.generated > 0 ? "generated" : "not_generated"))}
                  data-kind={kind}
                >
                  {meta.label}
                </span>
              )}
            </div>
            {period && <p className="mt-1 text-xs text-gray-500">{periodSpan(period)}</p>}
            {row && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500">
                <span className="basis-full @md:basis-auto" data-testid="pcp-period-timing">
                  {periodTiming(row, today)}
                </span>
                {slips && (
                  <>
                    <Dot />
                    <span
                      className="basis-full font-semibold text-gray-700 @md:basis-auto"
                      data-testid="pcp-period-count"
                    >
                      {slips.line}
                    </span>
                  </>
                )}
              </p>
            )}
          </motion.div>
          {(slips?.note || ownWorkflow?.finalizedAt || ownWorkflow?.state === "paid") && (
            <div className="mt-1 space-y-0.5 text-[11px] leading-snug">
              {slips?.note && (
                <p className="text-gray-500" data-testid="pcp-period-count-note">
                  {slips.note}
                </p>
              )}
              {ownWorkflow?.finalizedAt && (
                <p className="flex items-center gap-1.5 text-amber-800" data-testid="pcp-period-done">
                  <Lock size={11} aria-hidden /> Payroll Done {dateTime(ownWorkflow.finalizedAt)}
                  {ownWorkflow.state === "finalized" ? " · payment pending" : ""}
                </p>
              )}
              {ownWorkflow?.state === "paid" && (ownWorkflow.paidOn || ownWorkflow.paidAt) && (
                <p className="flex items-center gap-1.5 text-emerald-800" data-testid="pcp-period-paid">
                  <BadgeCheck size={12} aria-hidden /> Paid on {dateShort(ownWorkflow.paidOn ?? ownWorkflow.paidAt)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── the controls: From → To, then the quick picks and the calendar button; beside the period they form one
          column whose two rows share both edges ── */}
      <div className="flex min-w-0 flex-col gap-2 @2xl:flex-row @2xl:flex-wrap @2xl:items-start @4xl:flex-col @4xl:items-stretch">
        <div className="min-w-0">
          <div
            className="flex h-10 w-full items-center justify-between gap-1 rounded-xl border border-slate-200 bg-white pl-3 pr-2 shadow-sm focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-100 @2xl:w-auto @2xl:justify-start @4xl:w-full @4xl:justify-between"
            title="Any date picks the whole pay period that holds it; To follows: a payroll is always one whole pay period"
          >
            <label className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-gray-500">
              From
              <Input
                type="date"
                className="h-8 w-[8.6rem] min-w-0 border-0 bg-transparent px-1 text-sm font-semibold text-gray-900 shadow-none focus-visible:ring-0"
                aria-label="From: open the pay period that holds this date"
                data-testid="pcp-period-date"
                disabled={loading && !period}
                min={limits.min}
                max={limits.max}
                value={draft ?? period?.periodStart ?? ""}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (draft !== null && (!isIsoDay(draft) || draftProblem)) setDraft(null);
                }}
              />
            </label>
            <ArrowRight size={14} className="shrink-0 text-slate-400" aria-hidden />
            <div
              className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-gray-500"
              title="The period's last day: a payroll is always one whole pay period"
            >
              <span aria-hidden>To</span>
              <span
                className="px-1 text-sm font-semibold tabular-nums text-gray-900"
                aria-label={`To: ${period ? dateShort(period.periodEnd) : "none"} (the period's last day, set by the cycle)`}
                data-testid="pcp-period-to"
                role="note"
              >
                <motion.span
                  key={period?.periodEnd ?? "none"}
                  className="inline-block"
                  initial={reduce ? false : { opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {period ? fieldDate(period.periodEnd) : "—"}
                </motion.span>
              </span>
            </div>
          </div>
          {draftProblem && (
            <p className="mt-1 text-[11px] font-semibold text-red-700" data-testid="pcp-period-date-problem">
              {draftProblem}
            </p>
          )}
        </div>

        {/* quick picks + the calendar button */}
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="grid h-10 min-w-0 flex-1 grid-cols-3 items-center gap-0.5 rounded-xl bg-slate-100 p-1 @2xl:inline-flex @2xl:flex-none"
            role="group"
            aria-label="Quick picks"
          >
            <QuickButton
              icon={Target}
              label="Next due"
              target={quick.next}
              period={period}
              onClick={() => onQuick("next")}
              testId="pcp-quick-next"
            />
            <QuickButton
              icon={History}
              label="Latest generated"
              short="Latest"
              target={quick.latest}
              period={period}
              onClick={() => onQuick("latest")}
              testId="pcp-quick-latest"
            />
            <QuickButton
              icon={LocateFixed}
              label="This period (today)"
              short="Today"
              target={quick.today}
              period={period}
              onClick={() => onQuick("today")}
              testId="pcp-quick-today"
              always
            />
          </div>
          {action}
        </div>
      </div>
    </div>
  );
}

/** A separator between items on one line; gone on a phone, where each item has its own line. */
function Dot() {
  return (
    <span className="hidden text-slate-300 @md:inline" aria-hidden>
      ·
    </span>
  );
}

function QuickButton({
  icon: Icon,
  label,
  short,
  target,
  period,
  onClick,
  testId,
  always = false,
}: {
  icon: typeof Target;
  /** the full name (its tooltip and spoken name) */
  label: string;
  /** what the button shows, when shorter than the name */
  short?: string;
  target: CyclePeriodRow | undefined;
  period: CyclePeriod | null;
  onClick: () => void;
  testId: string;
  /** Usable even before its period is known (it is then asked for). */
  always?: boolean;
}) {
  const on = !!target && samePeriod(target, period);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!target && !always}
      aria-pressed={on}
      aria-label={label}
      title={target ? `${label}: ${formatPeriod(target)}` : label}
      className={cn(
        "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40",
        on
          ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
          : "text-slate-500 hover:bg-white hover:text-slate-900",
      )}
      data-testid={testId}
    >
      <Icon size={13} className={cn("hidden shrink-0 @md:block", on && "text-sky-600")} aria-hidden />
      <span className="truncate">{short ?? label}</span>
    </button>
  );
}
