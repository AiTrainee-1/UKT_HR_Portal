import { useState, type ComponentType } from "react";
import {
  AlarmClock,
  ArrowDown,
  ArrowUp,
  CalendarOff,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock3,
  ClipboardPen,
  Fingerprint,
  Hourglass,
  MapPin,
  MapPinOff,
  Moon,
  PencilLine,
  ThumbsDown,
  Timer,
  UserX,
  Activity,
} from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LEVEL_META,
  RECORD_STATUS_TONE,
  againstLimit,
  dateTimeText,
  num1,
  recordDays,
  shortLabel,
  sparkPath,
  statusLabel,
  weekdayBars,
} from "./logic";
import type { AnalyticsRecord, CategoryMeta, Level, Pattern } from "./types";

type IconType = ComponentType<{ size?: number; className?: string }>;

// The small pieces of the Analytics page, in the portal's payroll-kit look (clay cards, slate and indigo, one chip).

const CATEGORY_ICON: Record<string, IconType> = {
  leave: CalendarOff,
  late: Clock3,
  missing_punch: Fingerprint,
  on_duty: MapPin,
  on_duty_no_punch: MapPinOff,
  absent_on_leave: UserX,
  attendance_edits: PencilLine,
  hod_rejected: ThumbsDown,
  hod_waiting: Hourglass,
  hod_corrections: ClipboardPen,
  permissions: Timer,
  night_work: Moon,
  continuous_leave: CalendarRange,
  late_details: AlarmClock,
};

export const categoryIcon = (key: string): IconType => CATEGORY_ICON[key] ?? Activity;

/** High / Attention / Watch / OK: a word and a dot, never the colour alone. */
export function LevelChip({ level, className }: { level: Level; className?: string }) {
  const meta = LEVEL_META[level] ?? LEVEL_META.ok;
  return (
    <Chip tone={meta.tone} className={className} title={meta.hint}>
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden="true" />
      {meta.label}
    </Chip>
  );
}

/** A category on an employee: its icon, short name and count; amber when over the limit, slate otherwise. */
export function CategoryChip({
  categoryKey,
  label,
  count,
  flagged,
  informational,
  onClick,
}: {
  categoryKey: string;
  label: string;
  count: number;
  flagged: boolean;
  informational?: boolean;
  onClick?: () => void;
}) {
  const Icon = categoryIcon(categoryKey);
  const body = (
    <>
      <Icon size={11} />
      {shortLabel(label)}
      <b className="tabular-nums">{count}</b>
      {flagged && <span className="sr-only">(over the limit)</span>}
    </>
  );
  const tone = informational ? "neutral" : flagged ? "warning" : "neutral";
  if (!onClick) return <Chip tone={tone}>{body}</Chip>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      title={`${label}: ${count}${flagged ? " (over the limit)" : ""}`}
    >
      <Chip tone={tone} className="cursor-pointer hover:brightness-95">
        {body}
      </Chip>
    </button>
  );
}

/** The employee's photo when the server has one, else the coloured initials of the payroll kit. */
export function PersonAvatar({
  name,
  photoUrl,
  size = 36,
  className,
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (photoUrl && !broken) {
    return (
      <img
        src={photoUrl}
        alt=""
        aria-hidden="true"
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-xl object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return <Avatar name={name} size={size} className={className} />;
}

/** A tiny trend line from the weekly counts (no axes: the card's own number is the figure). */
export function Sparkline({
  values,
  color,
  label,
  width = 96,
  height = 28,
}: {
  values: number[];
  color: string;
  label: string;
  width?: number;
  height?: number;
}) {
  const d = sparkPath(values, width, height);
  if (!d) return null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="shrink-0 overflow-visible"
    >
      <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mon-Sun bars of a pattern; the busiest day is darker and named for the screen reader. */
export function WeekdayBars({ pattern, compact }: { pattern: Pick<Pattern, "byWeekday">; compact?: boolean }) {
  const bars = weekdayBars(pattern);
  const total = bars.reduce((n, b) => n + b.count, 0);
  return (
    <div
      className="flex items-end gap-1"
      role="img"
      aria-label={`By weekday: ${bars.map((b) => `${b.day} ${b.count}`).join(", ")}`}
      data-testid="weekday-bars"
    >
      {bars.map((b) => (
        <div key={b.day} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
          <span className="h-3 text-[9px] font-semibold leading-3 tabular-nums text-slate-500">{b.count || ""}</span>
          {/* a track of a fixed height: a bar's percentage needs a definite height to be a share of */}
          <div className={cn("flex w-full items-end", compact ? "h-6" : "h-10")}>
            <div
              className={cn(
                "w-full rounded-t-[3px]",
                total === 0 ? "bg-slate-100" : b.peak ? "bg-indigo-500" : "bg-indigo-200",
              )}
              style={{ height: `${Math.max(b.count ? 12 : 6, b.pct)}%` }}
            />
          </div>
          <span className={cn("text-[9px]", b.peak ? "font-bold text-slate-800" : "text-slate-400")}>{b.day[0]}</span>
        </div>
      ))}
    </div>
  );
}

/** Count against the limit: the bar is full at twice the limit, a tick marks the limit itself. */
export function LimitBar({
  count,
  category,
  className,
}: {
  count: number;
  category: Pick<CategoryMeta, "threshold" | "informational" | "unit">;
  className?: string;
}) {
  const g = againstLimit(count, category.threshold, category.informational);
  const color = category.informational
    ? "bg-slate-400"
    : g.double
      ? "bg-red-500"
      : g.over
        ? "bg-amber-500"
        : count > 0
          ? "bg-blue-500"
          : "bg-slate-200";
  return (
    <div className={cn("relative h-2 rounded-full bg-slate-100", className)}>
      <div className={cn("h-full rounded-full", color)} style={{ width: `${g.pct}%` }} />
      {!category.informational && (
        <span
          className="absolute -top-0.5 h-3 w-0.5 rounded bg-slate-500/70"
          style={{ left: "50%" }}
          title={`Limit for this period: ${num1(category.threshold)} ${category.unit}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** One record: the date(s), what happened, the detail, the employee's reason, the status and who acted. */
export function RecordItem({
  record,
  category,
  className,
}: {
  record: AnalyticsRecord;
  category?: { key: string; label: string } | null;
  className?: string;
}) {
  const Icon = category ? categoryIcon(category.key) : null;
  const tone = (record.status && RECORD_STATUS_TONE[record.status]) || "neutral";
  return (
    <li className={cn("flex gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2.5", className)}>
      <div className="w-14 shrink-0 text-xs font-bold tabular-nums leading-tight text-slate-700">
        {recordDays(record)}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {category && Icon && (
            <Chip tone="accent" icon={Icon}>
              {shortLabel(category.label)}
            </Chip>
          )}
          <p className="min-w-0 break-words text-[13px] font-semibold text-slate-900">{record.title}</p>
          {record.status && <Chip tone={tone}>{statusLabel(record.status)}</Chip>}
        </div>
        {record.detail && <p className="break-words text-xs text-slate-600">{record.detail}</p>}
        {record.reason && <p className="break-words text-xs italic text-slate-700">&ldquo;{record.reason}&rdquo;</p>}
        {(record.by || record.at) && (
          <p className="text-[11px] text-slate-400">
            {[record.by && `by ${record.by}`, dateTimeText(record.at)].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
    </li>
  );
}

/** A sortable column heading: a button, the arrow says which way, aria-sort tells the screen reader. */
export function SortHeader<K extends string>({
  label,
  column,
  sort,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  column: K;
  sort: { key: K; dir: "asc" | "desc" };
  onSort: (key: K) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const active = sort.key === column;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "whitespace-nowrap px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
          active && "text-indigo-700",
        )}
        data-testid={`sort-${column}`}
      >
        {label}
        <Icon size={12} className={active ? "" : "opacity-40"} />
      </button>
    </th>
  );
}

/** Previous / next with "26-50 of 134". */
export function Pager({
  page,
  pages,
  first,
  last,
  total,
  onPage,
  testId = "pager",
}: {
  page: number;
  pages: number;
  first: number;
  last: number;
  total: number;
  onPage: (page: number) => void;
  testId?: string;
}) {
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-3 pt-3" aria-label="Pages" data-testid={testId}>
      <p className="text-xs tabular-nums text-slate-500">
        {first}-{last} of {total}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
          data-testid={`${testId}-prev`}
        >
          <ChevronLeft size={14} /> <span className="max-sm:sr-only">Previous</span>
        </Button>
        <span className="px-1 text-xs tabular-nums text-slate-600">
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
          data-testid={`${testId}-next`}
        >
          <span className="max-sm:sr-only">Next</span> <ChevronRight size={14} />
        </Button>
      </div>
    </nav>
  );
}
