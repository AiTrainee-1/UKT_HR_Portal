import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CalendarCheck2, CalendarOff, Check, CheckCircle2, Loader2, ScanSearch, UserX } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  calendarWeeks,
  chipDate,
  pickedText,
  type CalendarDay,
  type CalendarStatus,
  type DetectedDay,
  type PickLine,
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
];

/** The detection at work: a month of cells with a beam sweeping across, and its three steps ticking off. */
export function Scanner({ monthLabel, who }: { monthLabel: string; who: string }) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  useEffect(() => {
    const every = Math.max(150, DETECT_TIMING.minMs / 3);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, 2)), every);
    return () => clearInterval(t);
  }, []);
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
        {STEPS(monthLabel).map((text, i) => {
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
        Enter the days above. The days {who} was marked <strong className="text-rose-700">Absent</strong> or{" "}
        <strong className="text-violet-700">On Leave</strong> in {monthLabel} are then found for you to pick from.
      </p>
    </div>
  );
}

const TONES = {
  rose: { tile: "border-rose-100 bg-rose-50/70", icon: "bg-rose-500 text-white", value: "text-rose-800" },
  violet: { tile: "border-violet-100 bg-violet-50/70", icon: "bg-violet-500 text-white", value: "text-violet-800" },
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

/** A detected date to tick: rose for Absent, violet for On Leave, sky blue with a tick once picked for Casual Leave. */
function DayChip({
  day,
  on,
  blocked,
  limit,
  employeeId,
  onToggle,
}: {
  day: DetectedDay;
  on: boolean;
  blocked: boolean;
  limit: number | null;
  employeeId: number;
  onToggle: (date: string) => void;
}) {
  const leave = day.status === "on_leave";
  return (
    <motion.button
      type="button"
      layout
      whileTap={blocked ? undefined : { scale: 0.94 }}
      aria-pressed={on}
      disabled={blocked}
      onClick={() => onToggle(day.date)}
      title={blocked ? `${limit} picked: untick one to pick another` : day.label}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
        on
          ? "border-sky-600 bg-sky-600 text-white shadow-sm shadow-sky-900/20"
          : leave
            ? "border-violet-200 bg-white text-violet-800 hover:border-violet-300 hover:bg-violet-50"
            : "border-rose-200 bg-white text-rose-800 hover:border-rose-300 hover:bg-rose-50",
        blocked && "cursor-not-allowed opacity-40",
      )}
      data-testid={`cf-date-${employeeId}-${day.date}`}
    >
      {on && <Check size={11} strokeWidth={3} aria-hidden />}
      {chipDate(day.date, day.weekday)}
      {leave && day.label.includes("·") && " "}
      {leave && day.label.includes("·") && (
        <span className={cn("font-medium", on ? "text-sky-100" : "text-violet-500")}>
          · {day.label.split("·")[1].trim()}
        </span>
      )}
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
  tone: "rose" | "violet";
  title: string;
  days: DetectedDay[];
  line: PickLine;
  onToggle: (date: string) => void;
}) {
  if (days.length === 0) return null;
  const full = line.limit !== null && line.picked.length >= line.limit;
  return (
    <section className="space-y-1.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
        <span className={cn("h-2 w-2 rounded-full", tone === "rose" ? "bg-rose-500" : "bg-violet-500")} aria-hidden />
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {days.map((d) => {
          const on = line.picked.includes(d.date);
          return (
            <DayChip
              key={d.date}
              day={d}
              on={on}
              blocked={!on && full}
              limit={line.limit}
              employeeId={line.row.employeeId}
              onToggle={onToggle}
            />
          );
        })}
      </div>
    </section>
  );
}

const CELL: Record<CalendarStatus, string> = {
  absent: "border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-400 hover:bg-rose-100",
  on_leave: "border-violet-200 bg-violet-50 text-violet-800 hover:border-violet-400 hover:bg-violet-100",
  present: "border-transparent bg-white text-gray-500",
  half_shift: "border-transparent bg-white text-gray-500",
  holiday: "border-transparent bg-slate-100 text-slate-400",
  cl: "border-sky-100 bg-sky-50 text-sky-700",
  none: "border-transparent bg-transparent text-slate-300",
  future: "border-transparent bg-transparent text-slate-300",
};

const MARK: Partial<Record<CalendarStatus, { text: string; tone: string }>> = {
  absent: { text: "Absent", tone: "text-rose-600" },
  on_leave: { text: "Leave", tone: "text-violet-600" },
  present: { text: "•", tone: "text-emerald-500" },
  half_shift: { text: "½", tone: "text-amber-500" },
  holiday: { text: "Off", tone: "text-slate-400" },
  cl: { text: "CL", tone: "text-sky-600" },
};

/** The month at a glance (Monday first): absent and on-leave days can be ticked, every other day shows what it was. */
function MonthCalendar({
  days,
  line,
  onToggle,
}: {
  days: CalendarDay[];
  line: PickLine;
  onToggle: (date: string) => void;
}) {
  const full = line.limit !== null && line.picked.length >= line.limit;
  const id = line.row.employeeId;
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
            {week.map((day, i) => {
              if (!day) return <span key={`blank-${w}-${i}`} />;
              const n = Number(day.date.slice(8, 10));
              const mark = MARK[day.status];
              if (!day.selectable) {
                return (
                  <span
                    key={day.date}
                    title={day.label}
                    className={cn(
                      "flex aspect-[5/4] flex-col items-center justify-center rounded-lg border text-xs font-semibold tabular-nums",
                      CELL[day.status],
                    )}
                  >
                    {n}
                    {mark && <span className={cn("text-[9px] font-bold leading-none", mark.tone)}>{mark.text}</span>}
                  </span>
                );
              }
              const on = line.picked.includes(day.date);
              const blocked = !on && full;
              return (
                <motion.button
                  key={day.date}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${chipDate(day.date, day.weekday)}, ${day.label}${on ? ", picked for Casual Leave" : ""}`}
                  disabled={blocked}
                  onClick={() => onToggle(day.date)}
                  whileTap={blocked ? undefined : { scale: 0.92 }}
                  animate={{ scale: on ? 1.04 : 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 22 }}
                  title={blocked ? `${line.limit} picked: untick one to pick another` : day.label}
                  className={cn(
                    "relative flex aspect-[5/4] flex-col items-center justify-center rounded-lg border-2 text-xs font-bold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                    on ? "border-sky-600 bg-sky-600 text-white shadow-md shadow-sky-900/20" : CELL[day.status],
                    blocked && "cursor-not-allowed opacity-40",
                  )}
                  data-testid={`cf-cal-${id}-${day.date}`}
                >
                  {on && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-sky-600 shadow"
                    >
                      <Check size={10} strokeWidth={3.5} aria-hidden />
                    </motion.span>
                  )}
                  {n}
                  <span className={cn("text-[9px] font-bold leading-none", on ? "text-sky-100" : mark?.tone)}>
                    {on ? "CL" : mark?.text}
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
          ["bg-sky-600", "Picked for CL"],
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
 * What the detection found for one employee: the counts, the absent dates and the on-leave dates (each a date to tick), the
 * instruction, and the month as a calendar. Nothing found: says so, and that another month can be tried.
 */
export function DetectResult({
  who,
  monthLabel,
  line,
  absent,
  onLeave,
  calendar,
  onToggle,
}: {
  who: string;
  monthLabel: string;
  line: PickLine;
  absent: DetectedDay[];
  onLeave: DetectedDay[];
  calendar: CalendarDay[];
  onToggle: (date: string) => void;
}) {
  const id = line.row.employeeId;
  if (absent.length + onLeave.length === 0) {
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
          <p className="text-sm font-bold text-emerald-900">No absent or leave days in {monthLabel}</p>
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
      <div className="grid grid-cols-3 gap-2">
        <Tile tone="rose" icon={UserX} value={String(absent.length)} label="Absent" testId={`cf-count-absent-${id}`} />
        <Tile
          tone="violet"
          icon={CalendarOff}
          value={String(onLeave.length)}
          label="On Leave"
          testId={`cf-count-leave-${id}`}
        />
        <Tile
          tone="sky"
          icon={CheckCircle2}
          value={`${line.picked.length}/${limit}`}
          label="Picked for CL"
          progress={limit ? line.picked.length / limit : 0}
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

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#006496]/5 px-3 py-2">
        <p className="text-xs font-semibold text-[#00476b]">
          Please select the dates you want to convert into Casual Leave (up to {limit}).
        </p>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
            line.picked.length >= limit && limit > 0 ? "bg-sky-600 text-white" : "bg-white text-[#006496]",
          )}
          data-testid={`cf-picked-${id}`}
        >
          {pickedText(line.picked.length, line.limit)}
        </span>
      </div>

      <MonthCalendar days={calendar} line={line} onToggle={onToggle} />
    </motion.div>
  );
}
