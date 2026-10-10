import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUpDown, RotateCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableHead } from "@/components/ui/table";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import { cn } from "@/lib/utils";
import type { SortDir } from "./common";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One figure above the lists, tinted like the stat cards on the other HR pages. */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  testId,
  loading,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: IconType;
  tone: string;
  testId?: string;
  loading?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl p-4", tone)} data-testid={testId}>
      <div className="mt-0.5 rounded-xl bg-white/60 p-2">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium opacity-70">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-16 bg-white/60" />
        ) : (
          <p
            className="truncate text-2xl font-black leading-tight"
            data-testid={testId ? `${testId}-value` : undefined}
          >
            {value}
          </p>
        )}
        {sub && !loading && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
      </div>
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

/** Photo (or the default icon), name and code on one line, with an optional second line under the name. */
export function PersonCell({
  name,
  code,
  photoUrl,
  sub,
  size = 36,
}: {
  name: string;
  code?: string | null;
  photoUrl?: string | null;
  sub?: ReactNode;
  size?: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <EmployeeAvatar photoUrl={photoUrl} name={name} size={size} />
      <div className="min-w-0">
        <p className="truncate font-semibold text-gray-900">
          {name}
          {code && <span className="ml-1.5 font-mono text-xs font-normal text-gray-400">{code}</span>}
        </p>
        {sub && <p className="truncate text-xs text-gray-500">{sub}</p>}
      </div>
    </div>
  );
}

export function SortHead<K extends string>({
  label,
  column,
  sort,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  column: K;
  sort: { key: K; dir: SortDir };
  onSort: (key: K) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const active = sort.key === column;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn(
        "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60",
        align === "right" && "text-right",
        className,
      )}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-[#006496]",
          active && "text-[#006496]",
        )}
        data-testid={`sort-${column}`}
      >
        {label}
        <Icon size={12} className={active ? "" : "opacity-40"} />
      </button>
    </TableHead>
  );
}

/** What a column header click does: the same column flips direction, a new one starts ascending. */
export function nextSort<K extends string>(current: { key: K; dir: SortDir }, key: K, firstDir: SortDir = "asc") {
  return current.key === key
    ? { key, dir: (current.dir === "asc" ? "desc" : "asc") as SortDir }
    : { key, dir: firstDir };
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  testId?: string;
}) {
  return (
    <div className="relative flex-1">
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

export type Option = { value: string; label: string };

/** A dropdown filter whose first choice ("all") means no filter. */
export function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  label,
  testId,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  allLabel: string;
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-10 lg:w-44", className)} aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "Showing 12 of 80", with a way out of the filters when any are on. */
export function ResultCount({
  shown,
  total,
  noun,
  filtered,
  onClear,
  testId,
}: {
  shown: number;
  total: number;
  noun: string;
  filtered: boolean;
  onClear: () => void;
  testId?: string;
}) {
  return (
    <p className="text-xs text-gray-500" data-testid={testId}>
      Showing <b>{shown}</b> of {total} {noun}
      {filtered && (
        <button
          type="button"
          onClick={onClear}
          className="ml-2 font-semibold text-blue-600 hover:underline"
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          Clear filters
        </button>
      )}
    </p>
  );
}

/** A real empty state: an icon, what is going on and (optionally) what to do about it. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  tone = "bg-blue-50 text-blue-600",
  testId,
}: {
  icon: IconType;
  title: string;
  text?: string;
  action?: ReactNode;
  tone?: string;
  testId?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid={testId}>
      <div className={cn("rounded-2xl p-4", tone)}>
        <Icon size={26} />
      </div>
      <div>
        <p className="font-bold text-gray-900">{title}</p>
        {text && <p className="mx-auto mt-0.5 max-w-sm text-sm text-muted-foreground">{text}</p>}
      </div>
      {action}
    </div>
  );
}

/** The honest version of "nothing here": the request failed, and Retry asks again. */
export function ErrorState({ what, onRetry, testId }: { what: string; onRetry: () => void; testId?: string }) {
  return (
    <EmptyState
      testId={testId}
      icon={AlertTriangle}
      tone="bg-red-50 text-red-600"
      title={`Could not load ${what}`}
      text="Check your connection and try again. Nothing has been changed."
      action={
        <Button variant="outline" onClick={onRetry} className="gap-1.5">
          <RotateCw size={14} /> Retry
        </Button>
      }
    />
  );
}

/** Placeholder rows while a list loads. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}
