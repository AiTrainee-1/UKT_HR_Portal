import { memo, useEffect, useState, type ComponentType } from "react";
import { CalendarCheck, CalendarHeart, Hourglass, Navigation, UserCheck, UserX } from "lucide-react";
import type { TypedAttendanceSummary } from "@/lib/api-client/custom-hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BOARD_META, BOARD_ORDER, type BoardCounts, type BoardState, type StatusFilter } from "./logic";
import { prefersReducedMotion, useCountUp } from "./useCountUp";

type IconType = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" }>;

const ICONS: Record<BoardState, IconType> = {
  present: UserCheck,
  on_duty: Navigation,
  on_leave: CalendarCheck,
  cl: CalendarHeart,
  leave_applied: Hourglass,
  absent: UserX,
};

const LONG_DATE = new Intl.DateTimeFormat("en-IN", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return LONG_DATE.format(new Date(Date.UTC(y, (m || 1) - 1, d || 1)));
}

const pct = (n: number, of: number) => (of > 0 ? Math.round((n * 100) / of) : 0);

/**
 * The top of the page: the day's roll call. One figure (how many are at work), the whole roster as one strip cut by status,
 * and the six status cards under it, which are the strip's legend and the list's filters. Present and On Duty are the two
 * ways of being at work; On Leave, CL, Leave (waiting for approval) and Absent the four ways of being away.
 */
export const RollCall = memo(function RollCall({
  counts,
  loading,
  filter,
  onFilter,
  date,
  isToday,
  holidayName,
  isSunday,
  view,
  summary,
}: {
  counts: BoardCounts;
  loading: boolean;
  filter: StatusFilter;
  onFilter: (next: StatusFilter) => void;
  date: string;
  isToday: boolean;
  holidayName?: string | null;
  isSunday: boolean;
  view: "staff" | "production";
  summary?: TypedAttendanceSummary;
}) {
  const atWork = counts.present + counts.on_duty;
  const shownAtWork = useCountUp(loading ? 0 : atWork);
  // the strip grows from nothing once, when the first numbers arrive (straight away for someone who asked for less motion)
  const [grown, setGrown] = useState(() => prefersReducedMotion());
  useEffect(() => {
    if (loading || grown) return;
    if (typeof requestAnimationFrame === "undefined") {
      setGrown(true);
      return;
    }
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, [loading, grown]);

  const roll = view === "staff" ? "staff" : "production";
  const stripLabel = BOARD_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${BOARD_META[s].label} ${counts[s]}`)
    .join(", ");

  return (
    <section
      className="clay-card min-w-0 rounded-2xl border border-slate-100 bg-white p-3.5 sm:p-5"
      aria-labelledby="rollcall-title"
      data-testid="attendance-rollcall"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h3 id="rollcall-title" className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-600">
            <span>{longDate(date)}</span>
            {isToday && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 ring-1 ring-emerald-200">
                Today
              </span>
            )}
            {holidayName && (
              <span
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200"
                data-testid="rollcall-holiday"
              >
                Holiday: {holidayName}
              </span>
            )}
            {!holidayName && isSunday && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
                Sunday
              </span>
            )}
          </h3>
          {loading ? (
            <Skeleton className="mt-2 h-12 w-56" />
          ) : (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-slate-900" data-testid="rollcall-at-work">
              <span className="text-5xl font-black leading-none tracking-tight tabular-nums">{shownAtWork}</span>
              <span className="text-base font-semibold text-slate-500">of {counts.total} at work</span>
            </p>
          )}
          <p className="mt-2 text-[13px] text-slate-600">
            {loading
              ? "Reading the day's punches"
              : counts.total === 0
                ? `No active ${roll} employees`
                : `${pct(atWork, counts.total)}% of the ${roll} roll: ${counts.present} present${
                    counts.on_duty ? `, ${counts.on_duty} on duty` : ""
                  }${counts.manual ? ` (${counts.manual} marked by hand)` : ""}`}
          </p>
        </div>

        {summary?.yesterday && (
          <dl
            className="grid grid-cols-4 gap-x-4 gap-y-0.5 rounded-xl bg-slate-50 px-3 py-2 text-center ring-1 ring-slate-100"
            aria-label={`Yesterday, ${summary.yesterday.date}`}
            data-testid="rollcall-yesterday"
          >
            <p className="col-span-4 text-left text-[11px] font-semibold text-slate-500">Yesterday</p>
            {(
              [
                ["Present", summary.yesterday.present],
                ["Absent", summary.yesterday.absent],
                ["Late", summary.yesterday.late],
                ["On leave", summary.yesterday.onLeave],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dd className="text-base font-bold tabular-nums text-slate-800">{value}</dd>
                <dt className="text-[11px] text-slate-500">{label}</dt>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* the roster as one strip */}
      <div
        className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
        role="img"
        aria-label={loading ? "Loading" : stripLabel || "Nobody on the roll"}
        data-testid="rollcall-strip"
      >
        {!loading &&
          BOARD_ORDER.map((s) =>
            counts[s] > 0 ? (
              <span
                key={s}
                title={`${BOARD_META[s].label}: ${counts[s]} (${pct(counts[s], counts.total)}%)`}
                className={cn(
                  "h-full border-r-2 border-white transition-[width,opacity] duration-700 ease-out last:border-r-0 motion-reduce:transition-none",
                  BOARD_META[s].fill,
                  filter !== "all" && filter !== s && "opacity-30",
                )}
                style={{ width: grown ? `${(counts[s] * 100) / Math.max(1, counts.total)}%` : "0%" }}
                data-state={s}
              />
            ) : null,
          )}
      </div>

      {/* the cards: the strip's legend and the list's filters */}
      <div
        className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-y-4 xl:grid-cols-6"
        role="group"
        aria-label="Filter the list by status"
      >
        {BOARD_ORDER.map((s, i) => (
          <StatusCard
            key={s}
            state={s}
            count={counts[s]}
            total={counts.total}
            loading={loading}
            active={filter === s}
            onClick={() => onFilter(filter === s ? "all" : s)}
            order={i}
            extra={
              s === "present"
                ? [
                    counts.manual ? `${counts.manual} by hand` : "",
                    counts.late ? `${counts.late} late` : "",
                    counts.halfDay ? `${counts.halfDay} half day` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")
                : s === "on_duty" && counts.heldPunches
                  ? `${counts.heldPunches} with punches waiting for HR`
                  : ""
            }
          />
        ))}
      </div>
    </section>
  );
});

function StatusCard({
  state,
  count,
  total,
  loading,
  active,
  onClick,
  order,
  extra,
}: {
  state: BoardState;
  count: number;
  total: number;
  loading: boolean;
  active: boolean;
  onClick: () => void;
  order: number;
  extra?: string;
}) {
  const meta = BOARD_META[state];
  const Icon = ICONS[state];
  const shown = useCountUp(loading ? 0 : count);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={`status-card-${state}`}
      title={meta.hint}
      className={cn(
        "group relative flex min-w-0 flex-col items-stretch overflow-hidden rounded-2xl border bg-white px-3.5 pb-3 pt-3 text-left transition-[transform,box-shadow,background-color] duration-200",
        "hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both motion-safe:duration-500",
        active ? cn("border-transparent ring-2", meta.ring, meta.wash) : "border-slate-200",
        meta.focus,
      )}
      style={{ animationDelay: `${order * 60}ms` }}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
        <span
          className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", meta.wash, meta.ink)}
        >
          <Icon size={13} aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate">{meta.label}</span>
        {!loading && total > 0 && (
          <span className="ml-auto pl-1 text-[11px] font-medium tabular-nums text-slate-500">{pct(count, total)}%</span>
        )}
      </span>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-12" />
      ) : (
        <span
          className="mt-2 text-[28px] font-black leading-none tabular-nums text-slate-900"
          data-testid={`status-card-${state}-count`}
        >
          {shown}
        </span>
      )}
      {/* the card's share of the roster, in the strip's colour */}
      <span className="mt-2.5 block h-1 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <span
          className={cn("block h-full rounded-full", meta.fill)}
          style={{ width: `${loading ? 0 : (count * 100) / Math.max(1, total)}%` }}
          data-meter={state}
        />
      </span>
      <span className="mt-2 line-clamp-2 text-[11px] leading-snug text-slate-500">{extra || meta.hint}</span>
    </button>
  );
}
