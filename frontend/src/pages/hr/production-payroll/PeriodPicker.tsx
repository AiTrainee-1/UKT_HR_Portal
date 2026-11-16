import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import {
  PAY_CYCLE_INFO,
  useProductionPeriodsAround,
  type CyclePeriod,
  type CyclePeriodRow,
  type PayCycle,
  type ProductionPeriodWorkflow,
  type ProductionPeriods,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { samePeriod } from "./logic";
import {
  addMonths,
  calendarLimits,
  clampView,
  gridWindow,
  latestGeneratedRow,
  mergeRows,
  monthOf,
  nextDueRow,
  periodInView,
  periodKey,
  probeDates,
  rowHolding,
  rowsSignature,
  viewFor,
  weekStartOf,
  type Month,
} from "./period-calendar";
import { PeriodCalendar } from "./PeriodCalendar";
import { PeriodSummary, type QuickPick } from "./PeriodSummary";
import { todayIso } from "./period-workflow";

/** The card is this wide (px) or wider: two months side by side, else one. */
export const TWO_MONTHS_FROM = 928;

/** The element's width, measured before the first paint and kept up to date; null where there is no layout (jsdom). */
function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      setWidth(w > 0 ? Math.round(w) : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The pay period every tab of a cycle page (but the Payslip one) is about (owner 2026-11-16): a calendar where every pay
 * period of the cycle is a block in the colour of where it stands (Paid green, Payroll Done amber, Generated indigo,
 * ended but not generated rose, not ended yet sky). The selected period's bar (From / To, its payslips, quick picks) is
 * always shown; the calendar opens below it from the bar's button and starts hidden on every visit (owner 2026-11-16:
 * "always hide the calendar"). Picking any day picks the whole pay period that holds it: a payroll is always one whole period. The periods
 * and their states are the server's: the list the page already has, plus the periods of the months on screen, asked
 * for by a date inside each ("?around="). Read-only controls: the lock for a View Only role never touches them.
 */
export function PeriodPicker({
  cycle,
  periods,
  period,
  onChange,
  onPickDate,
  loading,
  workflow,
}: {
  cycle: PayCycle;
  periods: ProductionPeriods | undefined;
  period: CyclePeriod | null;
  onChange: (period: CyclePeriod) => void;
  /** Called with a date (YYYY-MM-DD) whose period is not known here yet: the page asks for it and opens it. */
  onPickDate: (date: string) => void;
  loading: boolean;
  /** The selected period's workflow (Payroll Done / Paid dates), when the page has it. */
  workflow?: ProductionPeriodWorkflow;
}) {
  const today = todayIso();
  const days = periods?.days ?? PAY_CYCLE_INFO[cycle].days;
  // hidden on every visit (owner 2026-11-16: "always hide the calendar"); the bar alone picks a period
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const width = useWidth(card);
  const months = width === null || width >= TWO_MONTHS_FROM ? 2 : 1;
  const limits = calendarLimits(today, months, period);
  const fieldLimits = { min: limits.min, max: limits.max };

  // every period seen so far (the page's list can be replaced by another one while it loads: the calendar keeps its days)
  const baseRows = periods?.periods;
  const [seen, setSeen] = useState<{ cycle: PayCycle; rows: CyclePeriodRow[]; sig: string }>({
    cycle,
    rows: [],
    sig: "",
  });
  const known = useMemo(
    () => mergeRows(seen.cycle === cycle ? seen.rows : [], baseRows),
    [seen.cycle, seen.rows, cycle, baseRows],
  );
  const weekStart = weekStartOf(known) ?? 1;

  // the months on screen: the selected period's middle in the right-most one, until the user pages away
  const [left, setLeft] = useState<Month>(() =>
    period ? viewFor(period, months) : addMonths(monthOf(today), -(months - 1)),
  );
  const selKey = period ? periodKey(period) : null;
  const [anchor, setAnchor] = useState({ selKey, months });
  if (anchor.selKey !== selKey || anchor.months !== months) {
    setAnchor({ selKey, months });
    const next = period && !periodInView(period, left, months) ? viewFor(period, months) : left;
    const clamped = clampView(next, limits);
    if (clamped.year !== left.year || clamped.month !== left.month) setLeft(clamped);
  }

  // the periods of the months on screen that no list has given yet
  const grid = gridWindow(left, months, weekStart);
  const probes = useMemo(
    () =>
      open && known.length > 0
        ? probeDates(known, { from: grid.from, to: grid.to }, days, {
            min: fieldLimits.min,
            max: fieldLimits.max,
          })
        : [],
    [open, known, grid.from, grid.to, days, fieldLimits.min, fieldLimits.max],
  );
  const around = useProductionPeriodsAround(cycle, probes);
  // the page's own list last: it is the freshest word on the periods it holds (which one is next due, above all)
  const rows = useMemo(() => mergeRows(known, around.rows, baseRows), [known, around.rows, baseRows]);
  useEffect(() => {
    const sig = rowsSignature(rows);
    setSeen((prev) => (prev.cycle === cycle && prev.sig === sig ? prev : { cycle, rows, sig }));
  }, [rows, cycle]);

  const row = period ? rows.find((r) => samePeriod(r, period)) : undefined;
  const quick: Record<QuickPick, CyclePeriodRow | undefined> = {
    next: nextDueRow(baseRows ?? []) ?? nextDueRow(rows),
    latest: latestGeneratedRow(rows),
    today: rowHolding(rows, today),
  };

  /** Any day (a click, Enter, a typed From date): the period that holds it, or the page asks the server for it. */
  const pickDay = useCallback(
    (day: string) => {
      const holding = rowHolding(rows, day);
      if (holding) onChange({ periodStart: holding.periodStart, periodEnd: holding.periodEnd });
      else onPickDate(day);
    },
    [rows, onChange, onPickDate],
  );

  const onQuick = (which: QuickPick) => {
    const target = quick[which];
    if (target) {
      onChange({ periodStart: target.periodStart, periodEnd: target.periodEnd });
      // also when it already is the selected one: the months come back to it
      if (!periodInView(target, left, months)) setLeft(clampView(viewFor(target, months), limits));
    } else if (which === "today") onPickDate(today);
  };

  const toggle = () => setOpen((was) => !was);

  const nothingYet = known.length === 0 && around.rows.length === 0;

  return (
    <div
      ref={card}
      className="clay-card @container rounded-2xl border border-slate-100 px-4 py-3"
      data-testid="pcp-period-bar"
      data-months={months}
      {...{ [VIEW_SAFE_ATTR]: "" }}
    >
      <PeriodSummary
        period={period}
        row={row}
        roster={periods?.roster ?? 0}
        today={today}
        workflow={workflow}
        limits={fieldLimits}
        quick={quick}
        onFromDate={pickDay}
        onQuick={onQuick}
        loading={loading}
        cycleLabel={PAY_CYCLE_INFO[cycle].label}
        action={
          // on a phone only the icon shows (the words stay for screen readers), so it sits beside the quick picks
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={open ? "pcp-period-calendar" : undefined}
            title={open ? "Hide calendar" : "Show calendar"}
            className={cn(
              "inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
              open
                ? "border-slate-300 bg-slate-100 text-slate-900"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
            )}
            data-testid="pcp-cal-toggle"
          >
            <CalendarDays size={15} aria-hidden />
            <span className="sr-only @md:not-sr-only">{open ? "Hide calendar" : "Show calendar"}</span>
            <ChevronDown
              size={14}
              aria-hidden
              className={cn("transition-transform duration-200", open && "rotate-180")}
            />
          </button>
        }
      />

      {open && (
        <div id="pcp-period-calendar" className="mt-3 min-w-0 border-t border-slate-100 pt-3">
          <PeriodCalendar
            rows={rows}
            weekStart={weekStart}
            left={left}
            months={months}
            onView={setLeft}
            limits={limits}
            selected={period}
            today={today}
            onPickDay={pickDay}
            loading={nothingYet && loading}
            fetching={around.fetching}
            failed={around.failed}
          />
        </div>
      )}
    </div>
  );
}
