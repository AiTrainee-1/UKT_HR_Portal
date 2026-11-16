import type { ReactNode } from "react";
import { ArrowRight, CalendarCheck2, CalendarClock, CalendarDays, CircleAlert, Scale } from "lucide-react";
import type { PayCycle } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  addDays,
  CYCLE_INFO,
  dayOfPeriodText,
  FACTOR_WORDS,
  formatDayLong,
  formatPeriodLong,
  LENGTH_WORDS,
  nextCyclePeriod,
  normalizeWeekStart,
  parseIsoDay,
  periodStrip,
  resolveCyclePeriod,
  snapToWeekStart,
  weekRunsArrow,
  WEEK_START_NAME,
  type CycleRule,
  type Day,
  type Period,
  type StripItem,
} from "./cycles";

/** One fact of a cycle: a small label, the value large, a line under it. */
export function Tile({
  label,
  value,
  sub,
  tone = "plain",
  icon,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "plain" | "bad" | "accent";
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        tone === "bad" && "border-red-200 bg-red-50",
        tone === "accent" && "border-[#cfe2ee] bg-[#eff6fb]",
        tone === "plain" && "border-slate-200 bg-white",
      )}
      data-testid={testId}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </p>
      <div
        className={cn(
          "mt-1 text-[15px] font-semibold leading-snug tabular-nums",
          tone === "bad" ? "text-red-800" : "text-slate-900",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs leading-snug text-slate-500">{sub}</div>}
    </div>
  );
}

const TAG_WORDS: Record<StripItem["tags"][number], string> = {
  generated: "Generated",
  next: "Next to generate",
  today: "Today",
  overlap: "Overlaps a paid period",
};

/** The periods of a cycle side by side: the latest generated, the next to generate and the ones after it. */
export function PeriodStrip({ items, testId }: { items: StripItem[]; testId?: string }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid={testId}>
      {items.map((item) => {
        const next = item.tags.includes("next");
        const generated = item.tags.includes("generated");
        const overlap = item.tags.includes("overlap");
        return (
          <li
            key={`${item.period.start.year}-${item.period.start.month}-${item.period.start.day}`}
            className={cn(
              "min-w-0 rounded-lg border px-2.5 py-2 text-[12px] leading-snug",
              overlap
                ? "border-red-200 bg-red-50 text-red-900"
                : next
                  ? "border-[#006496] bg-[#eff6fb] text-slate-900 ring-1 ring-[#006496]"
                  : generated
                    ? "border-slate-200 bg-slate-50 text-slate-500"
                    : "border-slate-200 bg-white text-slate-700",
            )}
            data-tags={item.tags.join(" ")}
          >
            <p className="font-semibold tabular-nums">{formatPeriodLong(item.period)}</p>
            <p className="mt-0.5 flex flex-wrap gap-1">
              {item.tags.map((t) => (
                <span
                  key={t}
                  className={cn(
                    "rounded-full px-1.5 py-px text-[10px] font-bold",
                    t === "next" && "bg-[#006496] text-white",
                    t === "generated" && "bg-slate-200 text-slate-600",
                    t === "today" && "bg-amber-100 text-amber-800",
                    t === "overlap" && "bg-red-100 text-red-800",
                  )}
                >
                  {TAG_WORDS[t]}
                </span>
              ))}
              {item.tags.length === 0 && <span className="text-[10px] text-slate-400">Later</span>}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One pay cycle at a glance, from the values on screen: which weekday its weeks run from and to, how long a period is, the
 * first period start, the PF / ESI monthly estimate factor, the period holding today, the next period to generate and a
 * strip of the periods after it. `lastGenerated` is the latest period generated on the cycle (null: none yet; undefined:
 * it could not be read, so the next period is worked out as for a first run).
 */
export function CycleAtAGlance({
  cycle,
  rule,
  lastGenerated,
  today,
  branchLogin = false,
  checking = false,
  open = null,
}: {
  cycle: PayCycle;
  rule: CycleRule;
  lastGenerated: Period | null | undefined;
  today: Day;
  branchLogin?: boolean;
  /** The latest generated period is still being read. */
  checking?: boolean;
  /** The latest generated period when it is still open (Payroll Done not pressed): it stays the next one. */
  open?: Period | null;
}) {
  const info = CYCLE_INFO[cycle];
  const weekStart = normalizeWeekStart(rule.weekStart);
  const typed = parseIsoDay(rule.anchorDate);
  const anchor = typed ? snapToWeekStart(typed, weekStart) : null;
  const current = resolveCyclePeriod(today, cycle, rule);
  const next = nextCyclePeriod(cycle, rule, lastGenerated?.end ?? null, today, open);
  const strip = periodStrip(cycle, rule, lastGenerated ?? null, today, 3, open);

  return (
    <div className="space-y-3 pt-3" data-testid={`${cycle}-cycle-card`}>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Week runs"
          icon={<CalendarDays size={12} />}
          value={weekRunsArrow(weekStart)}
          sub={`Every ${info.label} period starts on a ${WEEK_START_NAME[weekStart]}.`}
          testId={`${cycle}-week-runs`}
        />
        <Tile
          label="Period length"
          icon={<CalendarClock size={12} />}
          value={LENGTH_WORDS[cycle].days}
          sub={LENGTH_WORDS[cycle].weeks}
          testId={`${cycle}-length`}
        />
        <Tile
          label="First period started on"
          icon={<CalendarCheck2 size={12} />}
          tone={info.needsDate && !anchor ? "bad" : "plain"}
          value={anchor ? formatDayLong(anchor) : info.needsDate ? "Not set" : "Not needed"}
          sub={
            anchor
              ? typed && (typed.day !== anchor.day || typed.month !== anchor.month)
                ? `${formatDayLong(typed)} as typed, moved back to the start weekday.`
                : "Every period is counted from this date."
              : info.needsDate
                ? `${info.label} payroll cannot be generated until it is set.`
                : "Weekly periods follow the start weekday alone."
          }
          testId={`${cycle}-first-start`}
        />
        <Tile
          label="PF / ESI monthly estimate"
          icon={<Scale size={12} />}
          value={`× ${info.monthlyFactor}`}
          sub={FACTOR_WORDS[cycle]}
          testId={`${cycle}-factor`}
        />
      </div>

      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        <Tile
          label="Current period"
          tone="plain"
          value={"period" in current ? formatPeriodLong(current.period) : "Not known yet"}
          sub={
            "period" in current
              ? `${dayOfPeriodText(current.period, today)} It can be generated from ${formatDayLong(addDays(current.period.end, 1))}, the day after its last day.`
              : "Set the first period start below."
          }
          testId={`${cycle}-current`}
        />
        <Tile
          label="Next to generate"
          tone={"error" in next ? "bad" : next.overlap ? "bad" : "accent"}
          value={"error" in next ? "Not known yet" : formatPeriodLong(next.period)}
          sub={
            "error" in next ? (
              next.error
            ) : (
              <>
                {next.stillOpen
                  ? `It is generated and still open: it stays the next ${info.label} period until Payroll Done is pressed on it.`
                  : next.ended
                    ? "It has ended: it can be generated now."
                    : `It can be generated from ${formatDayLong(next.generateFrom)}, the day after its last day.`}{" "}
                {next.stillOpen
                  ? null
                  : lastGenerated === undefined
                    ? checking
                      ? "Checking the latest generated period..."
                      : "The latest generated period could not be read, so this is counted as a first run."
                    : lastGenerated
                      ? `It follows the latest ${info.label} period generated${branchLogin ? " for your branch" : ""}.`
                      : `No ${info.label} period has been generated yet${branchLogin ? " for your branch" : ""}.`}
                {next.overlap && (
                  <span className="mt-1 flex items-start gap-1 font-semibold text-red-800">
                    <CircleAlert size={12} className="mt-0.5 shrink-0" />
                    Its first days are already in a generated period: see the warning under the date.
                  </span>
                )}
              </>
            )
          }
          testId={`${cycle}-next`}
        />
      </div>

      {!("error" in strip) && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Periods <ArrowRight size={11} />
          </p>
          <PeriodStrip items={strip} testId={`${cycle}-strip`} />
        </div>
      )}
    </div>
  );
}
