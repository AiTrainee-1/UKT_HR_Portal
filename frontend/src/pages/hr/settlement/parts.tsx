import type { ComponentType, ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { TONE, type Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { initials } from "./shared";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One figure above the list, tinted like the stat cards on the other HR pages. */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: IconType;
  tone: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl p-4", tone)} data-testid={testId}>
      <div className="mt-0.5 rounded-xl bg-white/60 p-2">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black leading-tight" data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </p>
        {sub && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
      </div>
    </div>
  );
}

/** A small label pill in one of the portal's status tones. */
export function Chip({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
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

/** The same person always gets the same colour. */
const toneOf = (key: string) =>
  AVATAR_TONES[[...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) % AVATAR_TONES.length];

export function InitialsAvatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        size === "lg" ? "h-11 w-11 text-sm" : "h-9 w-9 text-xs",
        toneOf(name),
      )}
    >
      {initials(name)}
    </div>
  );
}

/** A table heading that sorts the list; the arrow shows which way. */
export function SortHead<K extends string>({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: K;
  sort: { key: K; dir: "asc" | "desc" };
  onSort: (key: K) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn("text-[11px] font-bold uppercase tracking-wider text-[#006496]/60", className)}
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

/** A thin bar for how much has been recovered. */
export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Recovered"
      className={cn("h-1.5 overflow-hidden rounded-full bg-gray-100", className)}
    >
      <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The two kinds of "nothing to show": nothing yet, or nothing that matches the filters. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  testId,
  children,
  tone = "bg-blue-50 text-blue-600",
}: {
  icon: IconType;
  title: string;
  text: string;
  testId?: string;
  children?: ReactNode;
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
      {children}
    </div>
  );
}
