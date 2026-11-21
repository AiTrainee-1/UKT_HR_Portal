import { LayoutGrid } from "lucide-react";
import { Chip, SectionCard } from "@/components/payroll/kit/parts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { cardState, num1, plural, thresholdText, topEmployees, weeklyValues, type CardState } from "./logic";
import { PersonAvatar, Sparkline, categoryIcon } from "./parts";
import type { CategoryMeta, EmployeeHit, WeeklyPoint } from "./types";

const LOOK: Record<CardState, { card: string; icon: string; spark: string; number: string }> = {
  high: {
    card: "border-red-200 bg-gradient-to-br from-red-50/80 via-white to-white",
    icon: "bg-red-100 text-red-700",
    spark: "#dc2626",
    number: "text-red-700",
  },
  attention: {
    card: "border-amber-200 bg-gradient-to-br from-amber-50/80 via-white to-white",
    icon: "bg-amber-100 text-amber-700",
    spark: "#d97706",
    number: "text-amber-700",
  },
  calm: {
    card: "border-slate-100 bg-white",
    icon: "bg-slate-100 text-slate-600",
    spark: "#94a3b8",
    number: "text-slate-800",
  },
  info: {
    card: "border-dashed border-slate-200 bg-slate-50/50",
    icon: "bg-indigo-50 text-indigo-600",
    spark: "#6366f1",
    number: "text-slate-800",
  },
};

function StateChip({ c, state }: { c: CategoryMeta; state: CardState }) {
  if (state === "info") return <Chip tone="accent">For reference</Chip>;
  if (state === "high")
    return (
      <Chip tone="danger">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
        {c.high} high
      </Chip>
    );
  if (state === "attention")
    return (
      <Chip tone="warning">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        Over the limit
      </Chip>
    );
  return <Chip tone="success">All under the limit</Chip>;
}

/** One category: how many are over the limit (the big number), how many have records, the limit, the trend and the top
 *  three. The whole card is a button that opens the category's people and records. */
export function CategoryCard({
  category: c,
  employees,
  weekly,
  onOpen,
}: {
  category: CategoryMeta;
  employees: EmployeeHit[];
  weekly: WeeklyPoint[];
  onOpen: (key: string) => void;
}) {
  const state = cardState(c);
  const look = LOOK[state];
  const Icon = categoryIcon(c.key);
  const top = topEmployees(employees, c.key, 3);
  const values = weeklyValues(weekly, c.key);
  const headline = c.informational ? c.affected : c.flagged;
  return (
    <button
      type="button"
      onClick={() => onOpen(c.key)}
      className={cn(
        "clay-card group flex h-full flex-col gap-3 rounded-2xl border p-4 text-left transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        look.card,
      )}
      aria-label={`${c.label}: ${c.informational ? `${plural(c.affected, "employee")} with records` : `${plural(c.flagged, "employee")} over the limit, ${c.high} high`}, ${c.affected} with records, ${c.total} ${c.unit}. Open the list`}
      data-testid={`category-card-${c.key}`}
      data-state={state}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn("shrink-0 rounded-xl p-2", look.icon)}>
            <Icon size={16} />
          </span>
          <h4 className="min-w-0 text-sm font-bold leading-tight text-slate-900">{c.label}</h4>
        </div>
        <StateChip c={c} state={state} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p
            className={cn("text-3xl font-black leading-none tabular-nums", look.number)}
            data-testid={`category-card-${c.key}-value`}
          >
            {headline}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {c.informational ? "employees with records" : `over the limit · ${c.affected} with records`}
          </p>
        </div>
        <Sparkline values={values} color={look.spark} label={`Per week: ${values.join(", ")}`} />
      </div>

      <p className="text-[11px] leading-snug text-slate-500">
        <span className="font-semibold text-slate-700">{thresholdText(c)}</span>
        <span className="text-slate-400"> · </span>
        {num1(c.total)} {c.unit} in all
      </p>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
        {top.length ? (
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex -space-x-2">
              {top.map((e) => (
                <PersonAvatar key={e.id} name={e.name} photoUrl={e.photoUrl} size={26} className="ring-2 ring-white" />
              ))}
            </div>
            <p className="min-w-0 truncate text-[11px] text-slate-600">
              <span className="font-semibold text-slate-800">{top[0].name}</span>{" "}
              <span className="tabular-nums">({top[0].counts[c.key]})</span>
              {top.length > 1 && <span className="text-slate-400"> and others</span>}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">Nobody has a record</p>
        )}
        <span className="shrink-0 text-[11px] font-semibold text-indigo-700 opacity-70 group-hover:opacity-100">
          See all
        </span>
      </div>
    </button>
  );
}

export function CategoryGrid({
  categories,
  employees,
  weekly,
  loading,
  onOpen,
}: {
  categories: CategoryMeta[];
  employees: EmployeeHit[];
  weekly: WeeklyPoint[];
  loading: boolean;
  onOpen: (key: string) => void;
}) {
  // the ones over a limit first (high, then attention), calm ones after, reference-only last
  const order: Record<CardState, number> = { high: 0, attention: 1, calm: 2, info: 3 };
  const sorted = [...categories].sort(
    (a, b) => order[cardState(a)] - order[cardState(b)] || b.flagged - a.flagged || b.affected - a.affected,
  );
  return (
    <SectionCard
      title="Categories"
      description="Each check with how many employees are over its limit. Open a card for the people and every record."
      icon={LayoutGrid}
      testId="analytics-categories"
    >
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((c) => (
            <CategoryCard key={c.key} category={c} employees={employees} weekly={weekly} onOpen={onOpen} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
