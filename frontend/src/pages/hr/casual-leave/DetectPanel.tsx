import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CalendarCheck2,
  CalendarOff,
  Check,
  CheckCircle2,
  CircleDashed,
  Loader2,
  ScanSearch,
  UserX,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PORTION_DAYS,
  PORTION_TEXT,
  calendarWeeks,
  chipDate,
  daysNumber,
  daysWord,
  isFull,
  pickedText,
  portionFits,
  portionsOf,
  type CalendarDay,
  type CalendarStatus,
  type DetectedDay,
  type PickLine,
  type Portion,
} from "./carry-forward";

/** The shortest the detection shows, so a fast answer does not flash past (tests set it to 0). */
export const DETECT_TIMING = { minMs: 1200 };

export type Phase = "idle" | "detecting" | "done" | "error";

/**
 * Where the detection of `key` (the employees and the month) stands: "detecting" from the moment it starts until the
 * answer is in AND the shortest showing time has passed, then "done".
 */
export function useDetectPhase(
  active: boolean,
  key: string,
  query: { isFetching: boolean; isError: boolean; data: unknown },
): Phase {
  const [started, setStarted] = useState<{ key: string; at: number } | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  useEffect(() => {
    if (active && started?.key !== key) {
      setStarted({ key, at: Date.now() });
      setDoneKey(null);
    }
  }, [active, key, started?.key]);
  const ready = !!started && started.key === key && !query.isFetching && !!query.data;
  useEffect(() => {
    if (!active || !ready || !started) return;
    const wait = Math.max(0, DETECT_TIMING.minMs - (Date.now() - started.at));
    const t = setTimeout(() => setDoneKey(key), wait);
    return () => clearTimeout(t);
  }, [active, ready, started, key]);
  if (!active) return "idle";
  if (query.isError && !query.isFetching) return "error";
  return doneKey === key ? "done" : "detecting";
}

const STEPS = (monthLabel: string) => [
  `Reading every day of ${monthLabel}`,
  "Finding the days marked Absent",
  "Finding the days marked On Leave",
  "Finding the days marked Half Day",
];

/** The detection at work: a month of cells with a beam sweeping across, and its steps ticking off. */
export function Scanner({ monthLabel, who }: { monthLabel: string; who: string }) {
  const reduce = useReducedMotion();
  const steps = STEPS(monthLabel);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const every = Math.max(120, DETECT_TIMING.minMs / steps.length);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, steps.length - 1)), every);
    return () => clearInterval(t);
  }, [steps.length]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative overflow-hidden rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50 via-white to-indigo-50/60 p-4"
      data-testid="cf-detecting"
    >
      <div className="flex items-center gap-3">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#006496] text-white shadow-md shadow-sky-900/20">
          <span className="absolute inset-0 rounded-full bg-[#006496]/40 motion-safe:animate-ping" aria-hidden />
          <ScanSearch size={18} className="relative" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900">Detecting attendance…</p>
          <p className="truncate text-xs text-gray-500">
            {who} · {monthLabel}
          </p>
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-7 gap-1.5" aria-hidden>
        {Array.from({ length: 35 }, (_, i) => (
          <motion.span
            key={i}
            className="h-5 rounded-md bg-slate-200/70"
            initial={{ opacity: 0.35 }}
            animate={reduce ? { opacity: 0.6 } : { opacity: [0.3, 0.95, 0.3] }}
            transition={
              reduce ? { duration: 0 } : { duration: 1.4, repeat: Infinity, delay: (i % 7) * 0.07 + (i / 7) * 0.04 }
            }
          />
        ))}
        {!reduce && (
          <motion.span
            className="pointer-events-none absolute inset-y-[-4px] w-1/4 rounded-full bg-gradient-to-r from-transparent via-sky-300/55 to-transparent blur-[2px]"
            initial={{ left: "-25%" }}
            animate={{ left: "100%" }}
            transition={{ duration: 1.25, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </div>

      <ol className="mt-4 space-y-1.5">
        {steps.map((text, i) => {
          const done = i < step;
          const now = i === step;
          return (
            <li key={text} className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-300",
                  done
                    ? "bg-emerald-500 text-white"
                    : now
                      ? "bg-sky-100 text-[#006496]"
                      : "bg-slate-100 text-slate-300",
                )}
              >
                {done ? (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 500 }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </motion.span>
                ) : now ? (
                  <Loader2 size={12} className="motion-safe:animate-spin" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className={cn(done ? "text-gray-700" : now ? "font-semibold text-gray-900" : "text-gray-400")}>
                {text}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Before the number is in: what will happen once it is. */
export function IdleHint({ who, monthLabel }: { who: string; monthLabel: string }) {
  return (
    <div
      className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-4"
      data-testid="cf-idle"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-slate-400 shadow-sm">
        <ScanSearch size={18} aria-hidden />
      </span>
      <p className="text-xs leading-relaxed text-gray-600">
        Enter the days above. The days {who} was marked <strong className="text-rose-700">Absent</strong>,{" "}
        <strong className="text-violet-700">On Leave</strong> or <strong className="text-amber-700">Half Day</strong> in{" "}
        {monthLabel} are then found for you to pick from.
      </p>
    </div>
  );
}

const TONES = {
  rose: { tile: "border-rose-100 bg-rose-50/70", icon: "bg-rose-500 text-white", value: "text-rose-800" },
  violet: { tile: "border-violet-100 bg-violet-50/70", icon: "bg-violet-500 text-white", value: "text-violet-800" },
  amber: { tile: "border-amber-100 bg-amber-50/70", icon: "bg-amber-500 text-white", value: "text-amber-800" },
  sky: { tile: "border-sky-100 bg-sky-50/80", icon: "bg-sky-600 text-white", value: "text-sky-900" },
} as const;

function Tile({
  tone,
  icon: Icon,
  value,
  label,
  progress,
  testId,
}: {
  tone: keyof typeof TONES;
  icon: typeof UserX;
  value: string;
  label: string;
  progress?: number;
  testId?: string;
}) {
  const t = TONES[tone];
  return (
    <div className={cn("rounded-xl border p-2.5", t.tile)} data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", t.icon)}>
          <Icon size={13} aria-hidden />
        </span>
        <span className={cn("text-lg font-black tabular-nums leading-none", t.value)}>{value}</span>
      </div>
      <p className="mt-1 text-[11px] font-semibold text-gray-600">{label}</p>
      {progress !== undefined && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sky-100">
          <motion.div
            className="h-full rounded-full bg-sky-600"
            initial={false}
            animate={{ width: `${Math.round(progress * 100)}%` }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
          />
        </div>
      )}
    </div>
  );
}

const CHIP_TONE: Record<DetectedDay["status"], string> = {
  absent: "border-rose-200 bg-white text-rose-800 hover:border-rose-300 hover:bg-rose-50",
  on_leave: "border-violet-200 bg-white text-violet-800 hover:border-violet-300 hover:bg-violet-50",
  half_shift: "border-amber-200 bg-white text-amber-800 hover:border-amber-300 hover:bg-amber-50",
};

/** The part after the "·" of a label: "Sick Leave", "worked the morning (09:00-12:30)". */
const detail = (day: DetectedDay) => (day.label.includes("·") ? day.label.split("·")[1].trim() : "");

/** A detected date to tick: rose Absent, violet On Leave, amber Half Day; sky blue with a tick once picked. */
function DayChip({
  day,
  picked,
  blocked,
  employeeId,
  onToggle,
}: {
  day: DetectedDay;
  picked: Portion | null;
  blocked: boolean;
  employeeId: number;
  onToggle: (day: DetectedDay) => void;
}) {
  const on = picked !== null;
  const more = detail(day);
  return (
    <motion.button
      type="button"
      layout
      whileTap={blocked ? undefined : { scale: 0.94 }}
      aria-pressed={on}
      disabled={blocked}
      onClick={() => onToggle(day)}
      title={blocked ? "The days entered are all picked: untick one, or enter more days" : day.label}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
        on ? "border-sky-600 bg-sky-600 text-white shadow-sm shadow-sky-900/20" : CHIP_TONE[day.status],
        blocked && "cursor-not-allowed opacity-40",
      )}
      data-testid={`cf-date-${employeeId}-${day.date}`}
    >
      {on && <Check size={11} strokeWidth={3} aria-hidden />}
      {chipDate(day.date, day.weekday)}
      {more && " "}
      {more && <span className={cn("font-medium", on ? "text-sky-100" : "opacity-70")}>· {more}</span>}
    </motion.button>
  );
}

function DayGroup({
  testId,
  tone,
  title,
  days,
  line,
  onToggle,
}: {
  testId: string;
  tone: "rose" | "violet" | "amber";
  title: string;
  days: DetectedDay[];
  line: PickLine;
  onToggle: (day: DetectedDay) => void;
}) {
  if (days.length === 0) return null;
  const full = isFull(line.picked, line.limit);
  const dot = { rose: "bg-rose-500", violet: "bg-violet-500", amber: "bg-amber-500" }[tone];
  return (
    <section className="space-y-1.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
        <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {days.map((d) => {
          const picked = line.picked.find((p) => p.date === d.date)?.portion ?? null;
          return (
            <DayChip
              key={d.date}
              day={d}
              picked={picked}
              blocked={picked === null && full}
              employeeId={line.row.employeeId}
              onToggle={onToggle}
            />
          );
        })}
      </div>
    </section>
  );
}

const STATUS_WORD: Record<DetectedDay["status"], { text: string; tone: string }> = {
  absent: { text: "Absent", tone: "bg-rose-100 text-rose-700" },
  on_leave: { text: "On Leave", tone: "bg-violet-100 text-violet-700" },
  half_shift: { text: "Half Day", tone: "bg-amber-100 text-amber-800" },
};

/**
 * The picked dates, each with its leave type: Full day, First half or Second half (with the clock time of each half on that
 * day's shift). Only what the day allows is offered; a choice that would go past the number is greyed out.
 */
function PickedList({
  line,
  onPortion,
  onToggle,
}: {
  line: PickLine;
  onPortion: (date: string, portion: Portion) => void;
  onToggle: (day: DetectedDay) => void;
}) {
  const id = line.row.employeeId;
  const byDate = new Map(line.available.map((d) => [d.date, d]));
  const rows = [...line.picked].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <section
      className="space-y-2 rounded-2xl border border-sky-100 bg-gradient-to-b from-sky-50/80 to-white p-3"
      data-testid={`cf-types-${id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-bold text-[#00476b]">Leave type for each date</p>
        <p className="text-[11px] text-gray-500">A half day counts 0.5</p>
      </div>
      <AnimatePresence initial={false}>
        {rows.length === 0 ? (
          <motion.p
            key="none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2 py-1 text-xs text-gray-500"
          >
            <CircleDashed size={14} aria-hidden /> Tick dates above or in the calendar; each one appears here with its
            leave type.
          </motion.p>
        ) : (
          rows.map((p) => {
            const day = byDate.get(p.date);
            if (!day) return null;
            const allowed = portionsOf(day);
            const word = STATUS_WORD[day.status];
            return (
              <motion.div
                key={p.date}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-white bg-white px-2.5 py-2 shadow-sm"
                data-testid={`cf-type-${id}-${p.date}`}
              >
                <div className="min-w-[7.5rem] flex-1">
                  <p className="text-sm font-bold tabular-nums text-gray-900">{chipDate(day.date, day.weekday)}</p>
                  <p className="flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
                    <span className={cn("rounded px-1 py-px text-[10px] font-bold", word.tone)}>{word.text}</span>
                    {detail(day) && <span className="truncate">{detail(day)}</span>}
                  </p>
                </div>
                <div
                  role="radiogroup"
                  aria-label={`Leave type for ${chipDate(day.date, day.weekday)}`}
                  className="inline-flex rounded-lg bg-slate-100 p-0.5"
                >
                  {(["full", "first_half", "second_half"] as Portion[])
                    .filter((portion) => allowed.includes(portion))
                    .map((portion) => {
                      const on = p.portion === portion;
                      const fits = on || portionFits(line.picked, p.date, portion, line.limit);
                      const clock =
                        portion === "first_half"
                          ? day.halves?.first
                          : portion === "second_half"
                            ? day.halves?.second
                            : null;
                      return (
                        <button
                          key={portion}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          disabled={!fits}
                          onClick={() => onPortion(p.date, portion)}
                          title={
                            !fits
                              ? "Goes past the days entered: enter more days, or untick another date"
                              : `${PORTION_TEXT[portion]} (${daysNumber(PORTION_DAYS[portion])} day)${clock ? `, ${clock}` : ""}`
                          }
                          className={cn(
                            "relative flex flex-col items-center rounded-md px-2.5 py-1 text-[11px] font-bold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                            on ? "text-white" : "text-gray-600 hover:text-gray-900",
                            !fits && "cursor-not-allowed opacity-40",
                          )}
                          data-testid={`cf-portion-${id}-${p.date}-${portion}`}
                        >
                          {on && (
                            <motion.span
                              layoutId={`cf-portion-pill-${id}-${p.date}`}
                              className="absolute inset-0 rounded-md bg-sky-600 shadow-sm"
                              transition={{ type: "spring", stiffness: 500, damping: 34 }}
                            />
                          )}
                          <span className="relative">{PORTION_TEXT[portion]}</span>
                          {clock && (
                            <span
                              className={cn("relative text-[9px] font-semibold", on ? "text-sky-100" : "text-gray-400")}
                            >
                              {clock}
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
                <button
                  type="button"
                  onClick={() => onToggle(day)}
                  className="rounded-lg p-1 text-gray-300 hover:bg-rose-50 hover:text-rose-600"
                  aria-label={`Untick ${chipDate(day.date, day.weekday)}`}
                  data-testid={`cf-untick-${id}-${p.date}`}
                >
                  <X size={14} />
                </button>
                {allowed.length === 1 && (
                  <p className="basis-full text-[10px] text-gray-400">
                    {day.manual
                      ? "Set by hand on the attendance pages: a full day only."
                      : "Only a full day can be given on this day."}
                  </p>
                )}
                {day.status === "half_shift" && allowed.length === 2 && day.suggested && (
                  <p className="basis-full text-[10px] text-amber-700">
                    The {day.worked === "morning" ? "morning" : "evening"} was worked: the{" "}
                    {PORTION_TEXT[day.suggested].toLowerCase()} covers the rest of the day.
                  </p>
                )}
              </motion.div>
            );
          })
        )}
      </AnimatePresence>
    </section>
  );
}

const CELL: Record<CalendarStatus, string> = {
  absent: "border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-400 hover:bg-rose-100",
  on_leave: "border-violet-200 bg-violet-50 text-violet-800 hover:border-violet-400 hover:bg-violet-100",
  half_shift: "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400 hover:bg-amber-100",
  present: "border-transparent bg-white text-gray-500",
  holiday: "border-transparent bg-slate-100 text-slate-400",
  cl: "border-sky-100 bg-sky-50 text-sky-700",
  none: "border-transparent bg-transparent text-slate-300",
  future: "border-transparent bg-transparent text-slate-300",
};

const MARK: Partial<Record<CalendarStatus, { text: string; tone: string }>> = {
  absent: { text: "Absent", tone: "text-rose-600" },
  on_leave: { text: "Leave", tone: "text-violet-600" },
  half_shift: { text: "Half", tone: "text-amber-600" },
  present: { text: "•", tone: "text-emerald-500" },
  holiday: { text: "Off", tone: "text-slate-400" },
  cl: { text: "CL", tone: "text-sky-600" },
};

/** A picked cell: solid for a full day, the picked half filled (left = first half, right = second) for a half. */
const PICKED_FILL: Record<Portion, string> = {
  full: "border-sky-600 bg-sky-600 text-white shadow-md shadow-sky-900/20",
  first_half:
    "border-sky-600 bg-[linear-gradient(90deg,#0284c7_50%,#e0f2fe_50%)] text-sky-950 shadow-md shadow-sky-900/20",
  second_half:
    "border-sky-600 bg-[linear-gradient(90deg,#e0f2fe_50%,#0284c7_50%)] text-sky-950 shadow-md shadow-sky-900/20",
};
const PICKED_MARK: Record<Portion, string> = { full: "CL", first_half: "½ CL", second_half: "CL ½" };

/** The month at a glance (Monday first): absent, on-leave and half days can be ticked; every other day shows what it was. */
function MonthCalendar({
  days,
  line,
  onToggle,
}: {
  days: CalendarDay[];
  line: PickLine;
  onToggle: (day: DetectedDay) => void;
}) {
  const full = isFull(line.picked, line.limit);
  const id = line.row.employeeId;
  const byDate = new Map(line.available.map((d) => [d.date, d]));
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-2.5 shadow-sm" data-testid={`cf-calendar-${id}`}>
      <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-bold uppercase tracking-wider text-[#006496]/60">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="space-y-1">
        {calendarWeeks(days).map((week, w) => (
          <div key={w} className="grid grid-cols-7 gap-1">
            {week.map((cell, i) => {
              if (!cell) return <span key={`blank-${w}-${i}`} />;
              const n = Number(cell.date.slice(8, 10));
              const mark = MARK[cell.status];
              const day = byDate.get(cell.date);
              if (!cell.selectable || !day) {
                return (
                  <span
                    key={cell.date}
                    title={cell.label}
                    className={cn(
                      "flex aspect-[5/4] flex-col items-center justify-center rounded-lg border text-xs font-semibold tabular-nums",
                      CELL[cell.status],
                    )}
                  >
                    {n}
                    {mark && <span className={cn("text-[9px] font-bold leading-none", mark.tone)}>{mark.text}</span>}
                  </span>
                );
              }
              const picked = line.picked.find((p) => p.date === cell.date)?.portion ?? null;
              const blocked = picked === null && full;
              return (
                <motion.button
                  key={cell.date}
                  type="button"
                  aria-pressed={picked !== null}
                  aria-label={`${chipDate(cell.date, cell.weekday)}, ${cell.label}${picked ? `, ${PORTION_TEXT[picked]} of Casual Leave` : ""}`}
                  disabled={blocked}
                  onClick={() => onToggle(day)}
                  whileTap={blocked ? undefined : { scale: 0.92 }}
                  animate={{ scale: picked ? 1.04 : 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 22 }}
                  title={blocked ? "The days entered are all picked: untick one, or enter more days" : cell.label}
                  className={cn(
                    "relative flex aspect-[5/4] flex-col items-center justify-center rounded-lg border-2 text-xs font-bold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                    picked ? PICKED_FILL[picked] : CELL[cell.status],
                    blocked && "cursor-not-allowed opacity-40",
                  )}
                  data-testid={`cf-cal-${id}-${cell.date}`}
                  data-portion={picked ?? undefined}
                >
                  {picked && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-sky-600 shadow"
                    >
                      <Check size={10} strokeWidth={3.5} aria-hidden />
                    </motion.span>
                  )}
                  <span className={cn(picked && picked !== "full" && "rounded bg-white/80 px-1")}>{n}</span>
                  <span
                    className={cn(
                      "text-[9px] font-bold leading-none",
                      picked === "full"
                        ? "text-sky-100"
                        : picked
                          ? "rounded bg-white/80 px-1 text-sky-800"
                          : mark?.tone,
                    )}
                  >
                    {picked ? PICKED_MARK[picked] : mark?.text}
                  </span>
                </motion.button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-gray-50 pt-2 text-[10px] text-gray-500">
        {[
          ["bg-rose-400", "Absent"],
          ["bg-violet-400", "On Leave"],
          ["bg-amber-400", "Half Day"],
          ["bg-sky-600", "Picked for CL (half filled = half day)"],
          ["bg-sky-200", "Already CL"],
          ["bg-emerald-400", "Present"],
          ["bg-slate-300", "Off / holiday"],
        ].map(([dot, text]) => (
          <span key={text} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * What the detection found for one employee: the counts, the absent, on-leave and half-day dates (each a date to tick), the
 * instruction, the leave type of each picked date, and the month as a calendar. Nothing found: says so, and that another
 * month can be tried.
 */
export function DetectResult({
  who,
  monthLabel,
  line,
  absent,
  onLeave,
  halfDay,
  calendar,
  onToggle,
  onPortion,
}: {
  who: string;
  monthLabel: string;
  line: PickLine;
  absent: DetectedDay[];
  onLeave: DetectedDay[];
  halfDay: DetectedDay[];
  calendar: CalendarDay[];
  onToggle: (day: DetectedDay) => void;
  onPortion: (date: string, portion: Portion) => void;
}) {
  const id = line.row.employeeId;
  if (absent.length + onLeave.length + halfDay.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4"
        data-testid={`cf-none-${id}`}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <CalendarCheck2 size={18} aria-hidden />
        </span>
        <div>
          <p className="text-sm font-bold text-emerald-900">No absent, leave or half days in {monthLabel}</p>
          <p className="text-xs text-emerald-800/80">
            {who} has nothing to turn into Casual Leave this month (days already on Casual Leave are not listed). Try
            another month with the arrows.
          </p>
        </div>
      </motion.div>
    );
  }
  const limit = line.limit ?? 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="space-y-3"
      data-testid={`cf-result-${id}`}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile tone="rose" icon={UserX} value={String(absent.length)} label="Absent" testId={`cf-count-absent-${id}`} />
        <Tile
          tone="violet"
          icon={CalendarOff}
          value={String(onLeave.length)}
          label="On Leave"
          testId={`cf-count-leave-${id}`}
        />
        <Tile
          tone="amber"
          icon={CircleDashed}
          value={String(halfDay.length)}
          label="Half Day"
          testId={`cf-count-half-${id}`}
        />
        <Tile
          tone="sky"
          icon={CheckCircle2}
          value={`${daysNumber(line.days)}/${daysNumber(limit)}`}
          label="Days picked for CL"
          progress={limit ? line.days / limit : 0}
          testId={`cf-count-picked-${id}`}
        />
      </div>

      <DayGroup
        testId={`cf-absent-${id}`}
        tone="rose"
        title={`These are the dates on which ${who} was marked Absent`}
        days={absent}
        line={line}
        onToggle={onToggle}
      />
      <DayGroup
        testId={`cf-onleave-${id}`}
        tone="violet"
        title={`These are the dates on which ${who} was marked On Leave`}
        days={onLeave}
        line={line}
        onToggle={onToggle}
      />
      <DayGroup
        testId={`cf-halfday-${id}`}
        tone="amber"
        title={`These are the dates on which ${who} was marked Half Day`}
        days={halfDay}
        line={line}
        onToggle={onToggle}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#006496]/5 px-3 py-2">
        <p className="text-xs font-semibold text-[#00476b]">
          Please select the dates you want to convert into Casual Leave (up to {daysWord(limit)}), then choose Full day
          or Half day for each.
        </p>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
            isFull(line.picked, line.limit) ? "bg-sky-600 text-white" : "bg-white text-[#006496]",
          )}
          data-testid={`cf-picked-${id}`}
        >
          {pickedText(line.days, line.limit)}
        </span>
      </div>

      <PickedList line={line} onPortion={onPortion} onToggle={onToggle} />

      <MonthCalendar days={calendar} line={line} onToggle={onToggle} />
    </motion.div>
  );
}
