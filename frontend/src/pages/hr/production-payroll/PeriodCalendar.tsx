import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { BadgeCheck, ChevronLeft, ChevronRight, CircleCheck, Clock3, Lock, TriangleAlert } from "lucide-react";
import type { CyclePeriod, CyclePeriodRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  KIND_META,
  PERIOD_KINDS,
  addDays,
  addMonths,
  compareMonths,
  dayLabel,
  daysBetween,
  firstOfMonth,
  holds,
  kindCounts,
  lastOfMonth,
  monthOf,
  monthRows,
  monthTitle,
  periodKey,
  periodKind,
  rowHolding,
  sweepDelay,
  weekdayHeads,
  type Month,
  type PeriodKind,
} from "./period-calendar";
import { formatPeriod } from "./logic";

const KIND_ICON: Record<PeriodKind, typeof Lock> = {
  paid: BadgeCheck,
  done: Lock,
  generated: CircleCheck,
  due: TriangleAlert,
  upcoming: Clock3,
};

/** The ring a period's days get while it is hovered or selected, in its own colour. */
const KIND_RING: Record<PeriodKind, string> = {
  paid: "ring-emerald-400",
  done: "ring-amber-400",
  generated: "ring-indigo-400",
  due: "ring-rose-400",
  upcoming: "ring-sky-400",
};

type Block = { key: string; row: CyclePeriodRow | undefined; weeks: string[][] };

/** The rows of a month grouped by the pay period that holds each row (a period fills whole rows: weeks start on its weekday). */
function blocksOf(month: Month, weekStart: number, rows: readonly CyclePeriodRow[]): Block[] {
  const blocks: Block[] = [];
  for (const week of monthRows(month, weekStart)) {
    const row = rowHolding(rows, week[0]);
    const key = row ? periodKey(row) : `unknown-${week[0]}`;
    const last = blocks[blocks.length - 1];
    if (last && row && last.key === key) last.weeks.push(week);
    else blocks.push({ key, row, weeks: [week] });
  }
  return blocks;
}

const ARROWS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export type PeriodCalendarProps = {
  /** Every pay period known so far (the server's lists, merged). */
  rows: readonly CyclePeriodRow[];
  /** 0 = Sunday ... 6 = Saturday: the cycle's start weekday, the first column. */
  weekStart: number;
  /** The left-most month on screen, and how many months are side by side (1 or 2). */
  left: Month;
  months: number;
  onView: (left: Month) => void;
  limits: { minLeft: Month; maxLeft: Month };
  selected: CyclePeriod | null;
  today: string;
  /** A day was picked (click, Enter or Space): the page selects the period that holds it. */
  onPickDay: (day: string) => void;
  /** Nothing is known yet (the first list is on its way). */
  loading: boolean;
  /** A period of the months on screen is being asked for. */
  fetching: boolean;
  failed: boolean;
};

/**
 * The months on screen, Monday-or-whatever-the-cycle-starts-on first, each pay period a tinted block in the colour of
 * where it stands; the selected one filled in solid with a sweep across its days. Hovering (or focusing) a day lifts the
 * whole period that holds it, so it is clear what a click picks. Arrow keys move between days, Page Up / Page Down
 * between months, Enter or Space picks.
 */
export function PeriodCalendar(props: PeriodCalendarProps) {
  const { rows, weekStart, left, months, onView, limits, selected, today, onPickDay, loading, fetching, failed } =
    props;
  const reduce = !!useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  // the day under the pointer (or focus): the period holding it is lifted, also once that period arrives from the server
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const wantFocus = useRef(false);
  // which way the months last moved, for the slide
  const [direction, setDirection] = useState(0);
  const shown = Array.from({ length: months }, (_, i) => addMonths(left, i));
  const firstShown = firstOfMonth(shown[0]);
  const lastShown = lastOfMonth(shown[shown.length - 1]);
  const visible = (day: string) => firstShown <= day && day <= lastShown;

  // the one day that Tab lands on: the last one focused, else the selected period's first day on screen, else the 1st
  const selectedOnScreen =
    selected && selected.periodEnd >= firstShown && selected.periodStart <= lastShown
      ? selected.periodStart < firstShown
        ? firstShown
        : selected.periodStart
      : null;
  const tabbable = focusDate && visible(focusDate) ? focusDate : (selectedOnScreen ?? firstShown);

  const focusDay = (day: string) =>
    root.current?.querySelector<HTMLButtonElement>(`button[data-date="${day}"][data-in-month="true"]`)?.focus();

  useEffect(() => {
    if (!wantFocus.current || !focusDate) return;
    wantFocus.current = false;
    focusDay(focusDate);
  }, [focusDate, left]);

  // A day keeps the focus when its row moves into another block (a period arrived from the server and joined rows that
  // were loading): the focused button was replaced, so the same day is focused again. Leaving the calendar (Tab away, a
  // click elsewhere) is a blur, which ends this.
  const hasFocus = useRef(false);
  useLayoutEffect(() => {
    if (!hasFocus.current || !focusDate || root.current?.contains(document.activeElement)) return;
    focusDay(focusDate);
  });

  const page = (delta: number) => {
    const next = addMonths(left, delta);
    if (compareMonths(next, limits.minLeft) < 0 || compareMonths(next, limits.maxLeft) > 0) return;
    setDirection(delta);
    onView(next);
  };

  const moveFocus = (day: string) => {
    const m = monthOf(day);
    let nextLeft = left;
    if (compareMonths(m, left) < 0) nextLeft = m;
    else if (compareMonths(m, addMonths(left, months - 1)) > 0) nextLeft = addMonths(m, -(months - 1));
    if (compareMonths(nextLeft, limits.minLeft) < 0 || compareMonths(nextLeft, limits.maxLeft) > 0) return;
    if (compareMonths(nextLeft, left) !== 0) {
      setDirection(compareMonths(nextLeft, left));
      onView(nextLeft);
    }
    wantFocus.current = true;
    setFocusDate(day);
    setHoverDay(day);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, day: string) => {
    if (e.key in ARROWS) {
      e.preventDefault();
      moveFocus(addDays(day, ARROWS[e.key]));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const m = addMonths(monthOf(day), e.key === "PageUp" ? -1 : 1);
      const last = lastOfMonth(m);
      const same = `${firstOfMonth(m).slice(0, 8)}${day.slice(8, 10)}`;
      moveFocus(same > last ? last : same);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const offset = (new Date(`${day}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7;
      moveFocus(addDays(day, e.key === "Home" ? -offset : 6 - offset));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPickDay(day);
    }
  };

  const counts = kindCounts(rows, { from: firstShown, to: lastShown });
  const selKey = selected ? periodKey(selected) : null;
  // the sweep plays when a period becomes the selected one, not again when the months are paged later
  const [sweptKey, setSweptKey] = useState<string | null>(null);
  const [sweptAt, setSweptAt] = useState(0);
  if (sweptKey !== selKey) {
    setSweptKey(selKey);
    setSweptAt(Date.now());
  }
  const sweeping = !reduce && Date.now() - sweptAt < 1500;
  const selRow = selected ? rows.find((r) => periodKey(r) === selKey) : undefined;
  const selKind = selRow ? periodKind(selRow) : null;
  const selLength = selected ? daysBetween(selected.periodStart, selected.periodEnd) + 1 : 0;
  const previewRow = hoverDay ? rowHolding(rows, hoverDay) : undefined;
  const hover = previewRow ? periodKey(previewRow) : null;
  const heads = weekdayHeads(weekStart);
  const canPrev = compareMonths(addMonths(left, -1), limits.minLeft) >= 0;
  const canNext = compareMonths(addMonths(left, 1), limits.maxLeft) <= 0;

  return (
    <div
      ref={root}
      className="min-w-0"
      data-testid="pcp-calendar"
      data-months={months}
      onFocus={(e) => {
        const day = (e.target as HTMLElement).dataset?.date;
        if (!day) return;
        hasFocus.current = true;
        if (day !== focusDate) setFocusDate(day);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        hasFocus.current = false;
        setHoverDay(null);
      }}
    >
      <div className="relative" onMouseLeave={() => setHoverDay(null)}>
        <motion.div
          key={`${left.year}-${left.month}`}
          initial={reduce || direction === 0 ? false : { opacity: 0, x: direction * 18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className={cn("grid gap-x-5 gap-y-4", months === 2 ? "grid-cols-2" : "grid-cols-1")}
        >
          {shown.map((month, i) => {
            const title = monthTitle(month);
            return (
              <section key={title} className="min-w-0" aria-label={title}>
                <div className="mb-1.5 flex h-9 items-center justify-between gap-2">
                  {i === 0 ? (
                    <NavButton side="prev" disabled={!canPrev} onClick={() => page(-1)} />
                  ) : (
                    <span className="w-9" />
                  )}
                  <h3
                    className="min-w-0 flex-1 truncate text-center text-sm font-bold text-gray-900"
                    data-testid={`pcp-cal-month-${i}`}
                    aria-live={i === 0 ? "polite" : undefined}
                  >
                    {title}
                  </h3>
                  {i === shown.length - 1 ? (
                    <NavButton side="next" disabled={!canNext} onClick={() => page(1)} />
                  ) : (
                    <span className="w-9" />
                  )}
                </div>
                <div role="grid" aria-label={`Pay periods, ${title}`} className="space-y-1.5">
                  <div role="row" className="grid grid-cols-7 gap-[3px] px-[4px]">
                    {heads.map((d) => (
                      <span
                        key={d}
                        role="columnheader"
                        className="text-center text-[10px] font-bold uppercase tracking-wider text-slate-400"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                  {blocksOf(month, weekStart, rows).map((block) => (
                    <PeriodBlock
                      // keyed by its first row: a block keeps its buttons when its period arrives from the server
                      key={block.weeks[0][0]}
                      block={block}
                      month={month}
                      selected={selected}
                      selKey={selKey}
                      selKind={selKind}
                      selLength={selLength}
                      hovered={hover === block.key}
                      today={today}
                      tabbable={tabbable}
                      reduce={reduce}
                      sweeping={sweeping}
                      waiting={(loading || fetching) && !block.row}
                      failed={failed}
                      rows={rows}
                      onPick={(day) => {
                        setFocusDate(day);
                        onPickDay(day);
                      }}
                      onHover={setHoverDay}
                      onKey={onKey}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </motion.div>
        {(loading || fetching) && !reduce && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-10 w-1/4 rounded-full bg-gradient-to-r from-transparent via-sky-300/35 to-transparent blur-[2px]"
            initial={{ left: "-25%" }}
            animate={{ left: "100%" }}
            transition={{ duration: 1.25, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </div>

      <p className="mt-2 min-h-[1.25rem] text-[11px] text-gray-500" data-testid="pcp-cal-preview">
        {loading ? (
          <span role="status">Loading the pay periods…</span>
        ) : previewRow ? (
          <>
            <span className="font-semibold text-gray-800">{formatPeriod(previewRow)}</span>
            {" · "}
            {KIND_META[periodKind(previewRow)].label}
            {previewRow.isNext ? " · next due" : ""}
            {selKey === hover ? " · selected" : " · click to open"}
          </>
        ) : failed ? (
          "Some pay periods could not be loaded: click a day to open the period that holds it."
        ) : (
          "Click any day: the whole pay period that holds it is selected."
        )}
      </p>

      <ul
        className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-slate-100 pt-2 text-[11px] text-gray-600"
        aria-label="What the colours mean"
        data-testid="pcp-cal-legend"
      >
        {PERIOD_KINDS.map((kind) => {
          const meta = KIND_META[kind];
          const Icon = KIND_ICON[kind];
          return (
            <li
              key={kind}
              className="inline-flex items-center gap-1.5"
              title={meta.hint}
              data-testid={`pcp-cal-legend-${kind}`}
            >
              <span className={cn("flex h-4 w-5 items-center justify-center rounded border", meta.swatch)} aria-hidden>
                <Icon size={9} strokeWidth={2.75} className={meta.text} />
              </span>
              {meta.legend}
              <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-bold tabular-nums text-slate-600">
                {counts[kind]}
              </span>
            </li>
          );
        })}
        <li className="inline-flex items-center gap-1.5" data-testid="pcp-cal-legend-today">
          <span className="h-4 w-5 rounded border-2 border-slate-800" aria-hidden />
          Today
        </li>
        <li className="inline-flex items-center gap-1.5" data-testid="pcp-cal-legend-next">
          <NextTag />
          Next due
        </li>
      </ul>
    </div>
  );
}

function NavButton({ side, disabled, onClick }: { side: "prev" | "next"; disabled: boolean; onClick: () => void }) {
  const Icon = side === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "prev" ? "Previous month" : "Next month"}
      title={side === "prev" ? "Previous month" : "Next month"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
      data-testid={`pcp-cal-${side}`}
    >
      <Icon size={16} />
    </button>
  );
}

const NextTag = () => (
  <span className="rounded-full bg-slate-900 px-1.5 py-px text-[9px] font-black uppercase leading-tight tracking-wide text-white">
    Next
  </span>
);

function PeriodBlock({
  block,
  month,
  selected,
  selKey,
  selKind,
  selLength,
  hovered,
  today,
  tabbable,
  reduce,
  sweeping,
  waiting,
  failed,
  rows,
  onPick,
  onHover,
  onKey,
}: {
  block: Block;
  month: Month;
  selected: CyclePeriod | null;
  selKey: string | null;
  selKind: PeriodKind | null;
  selLength: number;
  hovered: boolean;
  today: string;
  tabbable: string;
  reduce: boolean;
  /** The selection just changed: its days fill in one after another. */
  sweeping: boolean;
  waiting: boolean;
  failed: boolean;
  rows: readonly CyclePeriodRow[];
  onPick: (day: string) => void;
  onHover: (day: string | null) => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>, day: string) => void;
}) {
  const { row } = block;
  const kind = row ? periodKind(row) : null;
  const meta = kind ? KIND_META[kind] : null;
  const Icon = kind ? KIND_ICON[kind] : null;
  const isSelected = !!row && selKey === block.key;
  const first = firstOfMonth(month);
  const last = lastOfMonth(month);
  return (
    <div
      role="rowgroup"
      className={cn(
        "relative rounded-xl border p-[3px] transition-[box-shadow,transform] duration-200",
        meta ? meta.block : waiting ? "border-slate-100 bg-slate-50" : "border-slate-100 bg-white",
        kind && (hovered || isSelected) && cn("ring-2", KIND_RING[kind]),
        kind && hovered && !isSelected && "-translate-y-px shadow-md",
        isSelected && "shadow-md ring-offset-1",
      )}
      data-testid={row ? `pcp-cal-period-${month.year}-${month.month}-${row.periodStart}` : undefined}
      data-kind={kind ?? (waiting ? "loading" : "unknown")}
      data-selected={isSelected ? "true" : undefined}
    >
      {Icon && meta && (
        <span
          className={cn(
            "absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full text-white ring-2 ring-white",
            meta.solid,
          )}
          title={meta.label}
          aria-hidden
        >
          <Icon size={9} strokeWidth={3} />
        </span>
      )}
      {row?.isNext && (
        <span className="absolute -left-1 -top-2 z-10" aria-hidden>
          <NextTag />
        </span>
      )}
      {block.weeks.map((week) => (
        <div key={week[0]} role="row" className="grid grid-cols-7 gap-[3px]">
          {week.map((day, col) => {
            const inMonth = first <= day && day <= last;
            const dayRow = row && holds(row, day) ? row : rowHolding(rows, day);
            const inSel = !!selected && holds(selected, day);
            const isToday = day === today;
            const dayKind = dayRow ? periodKind(dayRow) : null;
            const fill = selKind ? KIND_META[selKind].solid : "bg-slate-700";
            const delay = inSel ? sweepDelay(daysBetween(selected!.periodStart, day), selLength, reduce) : 0;
            return (
              <div key={day} role="gridcell" aria-selected={inSel}>
                <button
                  type="button"
                  tabIndex={inMonth && day === tabbable ? 0 : -1}
                  onClick={() => onPick(day)}
                  onKeyDown={(e) => onKey(e, day)}
                  onMouseEnter={() => onHover(day)}
                  onFocus={() => onHover(day)}
                  aria-label={dayLabel(day, dayRow, today, inSel)}
                  aria-current={isToday ? "date" : undefined}
                  title={dayRow ? `${formatPeriod(dayRow)} · ${KIND_META[dayKind!].label}` : undefined}
                  className={cn(
                    "relative flex h-9 w-full min-w-0 items-center justify-center rounded-lg text-[13px] font-semibold tabular-nums transition-colors duration-150 focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1",
                    inSel
                      ? "text-white"
                      : (dayKind && dayKind !== kind ? KIND_META[dayKind].text : meta?.text) || "text-slate-500",
                    !inSel && "hover:bg-white/70",
                    dayKind && dayKind !== kind && !inSel && KIND_META[dayKind].block,
                    !inMonth && "opacity-40",
                    isToday && "font-black",
                  )}
                  data-testid={inMonth ? `pcp-cal-day-${day}` : undefined}
                  data-date={day}
                  data-in-month={inMonth ? "true" : "false"}
                  data-kind={dayKind ?? "unknown"}
                  data-selected={inSel ? "true" : undefined}
                  data-today={isToday ? "true" : undefined}
                >
                  {inSel && (
                    <motion.span
                      aria-hidden
                      className={cn("absolute inset-0 rounded-lg shadow-sm", fill)}
                      initial={sweeping ? { opacity: 0, scale: 0.35 } : false}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={sweeping ? { delay, type: "spring", stiffness: 420, damping: 26 } : { duration: 0 }}
                      data-sweep={sweeping ? String(delay) : "none"}
                    />
                  )}
                  {waiting && !dayRow && !inSel && (
                    <motion.span
                      aria-hidden
                      className="absolute inset-0 rounded-lg bg-slate-200/70"
                      initial={{ opacity: 0.35 }}
                      animate={reduce ? { opacity: 0.6 } : { opacity: [0.3, 0.9, 0.3] }}
                      transition={reduce ? { duration: 0 } : { duration: 1.4, repeat: Infinity, delay: col * 0.07 }}
                    />
                  )}
                  {isToday && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-[3px] rounded-md border-2",
                        inSel ? "border-white" : "border-slate-800",
                      )}
                    />
                  )}
                  <span className="relative">{Number(day.slice(8, 10))}</span>
                  {!dayRow && failed && !waiting && <span className="sr-only">not loaded</span>}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
