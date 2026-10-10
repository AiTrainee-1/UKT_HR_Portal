import { useState, type ComponentType, type ReactNode } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { WaitingChip } from "@/components/ApprovalTrail";
import { explainsWaiting, type ApprovalProgress } from "@/lib/approval-workflow";
import { REQUEST_STATUS_TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { ALL, MONTHS, shiftMonth, type Option } from "./logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One figure above the lists, tinted like the stat cards on the other HR pages. Clickable when it jumps to a view. */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  testId,
  onClick,
  active,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: IconType;
  tone: string;
  testId?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <div className="mt-0.5 rounded-xl bg-white/60 p-2">
        <Icon size={16} />
      </div>
      <div className="min-w-0 text-left">
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black leading-tight" data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </p>
        {sub && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
      </div>
    </>
  );
  const cls = cn("flex items-start gap-3 rounded-2xl p-4 shadow-sm ring-1 ring-black/[0.03]", tone);
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(cls, "w-full transition-shadow hover:shadow-md", active && "ring-2 ring-current/40")}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

/** A small label pill. Not a Badge: those lift on hover, and these are not clickable. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}

const AVATAR_TONES = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
  "bg-teal-100 text-teal-700",
];

export const initialsOf = (name: string | null | undefined) =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

/** Initials on a colour that is the same for the same employee every time. */
export function PersonAvatar({
  name,
  id,
  size = "md",
}: {
  name?: string | null;
  id: number;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        size === "lg" ? "h-11 w-11 text-sm" : size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs",
        AVATAR_TONES[Math.abs(id) % AVATAR_TONES.length],
      )}
    >
      {initialsOf(name)}
    </div>
  );
}

/** The employee: avatar, name, then code · department. */
export function PersonCell({
  id,
  name,
  code,
  sub,
  size = "md",
}: {
  id: number;
  name?: string | null;
  code?: string | null;
  sub?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PersonAvatar id={id} name={name} size={size} />
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-gray-900">{name ?? code ?? `#${id}`}</p>
        <p className="truncate text-xs text-gray-500">
          {code && <span className="font-mono">{code}</span>}
          {code && sub ? " · " : ""}
          {sub}
        </p>
      </div>
    </div>
  );
}

/** The status of a request: who it is waiting for while the pipeline has more than HR to ask, else Pending / Approved /
 *  Rejected in the portal's status colours. */
export function StatusChip({
  status,
  approval,
  label,
  className,
}: {
  status: string;
  approval?: ApprovalProgress | null;
  label?: string;
  className?: string;
}) {
  if (status === "pending" && explainsWaiting(approval)) {
    return <WaitingChip approval={approval} className={cn("text-xs", className)} />;
  }
  return (
    <StatusBadge tone={REQUEST_STATUS_TONE[status] ?? "neutral"} className={cn("text-xs capitalize", className)}>
      {label ?? status}
    </StatusBadge>
  );
}

// ─── Filters ───

/** The box the search and filters sit in. */
export function FilterPanel({ children }: { children: ReactNode }) {
  return <div className="space-y-3 rounded-2xl border bg-white p-3">{children}</div>;
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  testId?: string;
}) {
  return (
    <div className="relative min-w-[14rem] flex-1">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-10 pl-9 pr-9"
        data-testid={testId}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function FilterSelect({
  value,
  onChange,
  label,
  allLabel,
  options,
  testId,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name ("Filter by branch"). */
  label: string;
  allLabel: string;
  options: Option[];
  testId?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-10 lg:w-44", className)} aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DateField({
  value,
  onChange,
  label,
  testId,
  min,
  max,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  testId?: string;
  min?: string;
  max?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
      {label}
      <Input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-[9.5rem]"
        data-testid={testId}
      />
    </label>
  );
}

/** "Showing 4 of 20 requests  Clear filters". */
export function ResultLine({
  shown,
  total,
  noun,
  active,
  onClear,
  testId,
}: {
  shown: number;
  total: number;
  noun: string;
  active: boolean;
  onClear: () => void;
  testId: string;
}) {
  return (
    <p className="text-xs text-gray-500" data-testid={testId}>
      Showing <b>{shown}</b> of {total} {noun}
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="ml-2 font-semibold text-blue-600 hover:underline"
          data-testid={`${testId}-clear`}
        >
          Clear filters
        </button>
      )}
    </p>
  );
}

/** Reads a list through its first `step` rows and a button for the next ones, so a long list stays quick. */
export function useVisibleCount(step = 60) {
  const [count, setCount] = useState(step);
  return { count, more: () => setCount((c) => c + step), reset: () => setCount(step) };
}

export function MoreRows({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="flex justify-center py-3">
      <Button variant="outline" size="sm" onClick={onMore} data-testid="show-more">
        Show more ({total - shown} left)
      </Button>
    </div>
  );
}

// ─── States ───

export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  testId,
  tone = "bg-blue-50 text-blue-600",
}: {
  icon: IconType;
  title: string;
  text: string;
  action?: ReactNode;
  testId?: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid={testId}>
      <div className={cn("rounded-2xl p-4", tone)}>
        <Icon size={26} />
      </div>
      <div>
        <p className="font-bold text-gray-900">{title}</p>
        <p className="mx-auto mt-0.5 max-w-sm text-sm text-muted-foreground">{text}</p>
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ what, onRetry, testId }: { what: string; onRetry: () => void; testId?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid={testId ?? "load-error"}>
      <div className="rounded-2xl bg-red-50 p-4 text-red-600">
        <AlertTriangle size={26} />
      </div>
      <div>
        <p className="font-bold text-gray-900">Could not load {what}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">Check your connection, then try again.</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function ListSkeleton({ rows = 4, testId = "list-loading" }: { rows?: number; testId?: string }) {
  return (
    <div className="space-y-3 p-4" data-testid={testId} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

// ─── Month picker ───

/** Previous / next arrows around a month and a year; "This month" jumps back. Years run from five ago to next year. */
export function MonthPicker({
  year,
  month,
  onChange,
  testId = "month-picker",
}: {
  year: number;
  month: number;
  onChange: (next: { year: number; month: number }) => void;
  testId?: string;
}) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const isNow = year === thisYear && month === now.getMonth() + 1;
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 5 + i);
  if (!years.includes(year)) years.push(year);
  years.sort((a, b) => a - b);
  const go = (delta: number) => onChange(shiftMonth(year, month, delta));
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => go(-1)} aria-label="Previous month">
        <ChevronLeft size={16} />
      </Button>
      <Select value={String(month)} onValueChange={(v) => onChange({ year, month: Number(v) })}>
        <SelectTrigger className="h-9 w-32" aria-label="Month" data-testid={`${testId}-month`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((m, i) => (
            <SelectItem key={m} value={String(i + 1)}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(year)} onValueChange={(v) => onChange({ year: Number(v), month })}>
        <SelectTrigger className="h-9 w-24" aria-label="Year" data-testid={`${testId}-year`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => go(1)} aria-label="Next month">
        <ChevronRight size={16} />
      </Button>
      {!isNow && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 text-blue-600"
          onClick={() => onChange({ year: thisYear, month: now.getMonth() + 1 })}
          data-testid={`${testId}-today`}
        >
          This month
        </Button>
      )}
    </div>
  );
}

/** Downloads what is on screen. Reading a list out is not a change, so the View Only lock leaves it alone (its word list
 *  treats "export" as a mutating verb). */
export function ExportButton({
  onClick,
  disabled,
  testId = "export",
}: {
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Button
      variant="outline"
      className="h-10 gap-1.5"
      onClick={onClick}
      disabled={disabled}
      data-view-safe
      data-testid={testId}
    >
      <Download size={15} /> Export
    </Button>
  );
}
