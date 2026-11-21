import { useEffect, useMemo, useState } from "react";
import { ChevronRight, SearchX, UserRoundSearch, Users } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SORT,
  FIRST_DIR,
  LEVEL_FILTERS,
  dayMonth,
  flagChips,
  inLevel,
  levelCounts,
  matchesQuery,
  num1,
  pageOf,
  sortEmployees,
  type LevelFilter,
  type Sort,
  type SortKey,
} from "./logic";
import { CategoryChip, LevelChip, Pager, PersonAvatar, SortHeader } from "./parts";
import type { CategoryMeta, EmployeeHit } from "./types";

const SORT_CHOICES: { key: SortKey; label: string }[] = [
  { key: "score", label: "Score" },
  { key: "level", label: "Level" },
  { key: "flags", label: "Categories over the limit" },
  { key: "lastDate", label: "Last record" },
  { key: "name", label: "Name" },
  { key: "department", label: "Department" },
];

/** The people with records, most serious first: a table on a wide screen, cards on a phone, 25 per page. The page's
 *  search narrows it at once (the server narrows it again a moment later); the level chips choose who is listed. */
export function AttentionList({
  employees,
  categories,
  query,
  levelFilter,
  onLevel,
  loading,
  onOpenEmployee,
  onOpenCategory,
}: {
  employees: EmployeeHit[];
  categories: CategoryMeta[];
  query: string;
  levelFilter: LevelFilter;
  onLevel: (level: LevelFilter) => void;
  loading: boolean;
  onOpenEmployee: (id: number) => void;
  onOpenCategory: (key: string) => void;
}) {
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const searched = useMemo(() => employees.filter((e) => matchesQuery(e, query)), [employees, query]);
  const counts = useMemo(() => levelCounts(searched), [searched]);
  const shown = useMemo(
    () =>
      sortEmployees(
        searched.filter((e) => inLevel(e, levelFilter)),
        sort,
      ),
    [searched, levelFilter, sort],
  );
  const view = pageOf(shown, page);
  useEffect(() => setPage(1), [levelFilter, query, sort, employees]);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIR[key] }));
  const label = LEVEL_FILTERS.find((l) => l.value === levelFilter)?.label ?? "";

  return (
    <SectionCard
      id="attention-list"
      title="Employees needing attention"
      description="Everyone with records in the period, worst first. Score = each category's count over its limit, added up."
      icon={Users}
      testId="attention-list"
    >
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Show employees by level">
          {LEVEL_FILTERS.map((l) => {
            const on = l.value === levelFilter;
            return (
              <button
                key={l.value}
                type="button"
                aria-pressed={on}
                onClick={() => onLevel(l.value)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
                  on
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
                data-testid={`level-filter-${l.value}`}
              >
                {l.label}
                <span className={cn("rounded-full px-1.5 tabular-nums", on ? "bg-white/20" : "bg-slate-100")}>
                  {counts[l.value]}
                </span>
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500 md:hidden">
          Sort by
          <select
            className="h-8 flex-1 rounded-md border border-input bg-white px-2 text-sm"
            value={sort.key}
            onChange={(e) => {
              const key = e.target.value as SortKey;
              setSort({ key, dir: FIRST_DIR[key] });
            }}
            aria-label="Sort employees"
          >
            {SORT_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="sr-only" aria-live="polite" data-testid="attention-count">
        {loading ? "Loading employees" : `${shown.length} ${label.toLowerCase()} listed`}
      </p>

      {loading ? (
        <SkeletonRows rows={6} />
      ) : employees.length === 0 ? (
        <EmptyNote
          icon={UserRoundSearch}
          title="Nobody has a record in this period"
          hint="Try a longer period, or clear the department, employee and search filters."
        />
      ) : shown.length === 0 ? (
        <EmptyNote
          icon={SearchX}
          title={searched.length === 0 ? "Nobody matches the search" : `Nobody in "${label}"`}
          hint={
            searched.length > 0 && counts.all > 0
              ? `${counts.all} employees have records under other levels.`
              : undefined
          }
          action={
            searched.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => onLevel("all")}>
                Show everyone with records
              </Button>
            ) : undefined
          }
          testId="attention-empty"
        />
      ) : (
        <>
          {/* wide screens: a table that scrolls inside its own box if it must */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-100 md:block">
            <table className="w-full min-w-[760px] text-sm" data-testid="attention-table">
              <caption className="sr-only">Employees with records, {label}</caption>
              <thead className="bg-slate-50/80">
                <tr>
                  <SortHeader label="Employee" column="name" sort={sort} onSort={onSort} />
                  <SortHeader label="Department" column="department" sort={sort} onSort={onSort} />
                  <SortHeader label="Level" column="level" sort={sort} onSort={onSort} />
                  <SortHeader label="Categories" column="flags" sort={sort} onSort={onSort} />
                  <SortHeader label="Score" column="score" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Last" column="lastDate" sort={sort} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {view.rows.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer bg-white transition-colors hover:bg-indigo-50/40"
                    onClick={() => onOpenEmployee(e.id)}
                    data-testid={`attention-row-${e.id}`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <PersonAvatar name={e.name} photoUrl={e.photoUrl} size={34} />
                        <div className="min-w-0">
                          <button
                            type="button"
                            className="block max-w-[14rem] truncate text-left font-semibold text-slate-900 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenEmployee(e.id);
                            }}
                            aria-label={`Open ${e.name}, ${e.code}`}
                          >
                            {e.name}
                          </button>
                          <p className="truncate text-[11px] text-slate-500">
                            <span className="font-mono">{e.code}</span>
                            {e.designation ? ` · ${e.designation}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[10rem] truncate px-3 py-2.5 text-xs text-slate-600">{e.department ?? "-"}</td>
                    <td className="px-3 py-2.5">
                      <LevelChip level={e.level} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Chips e={e} categories={categories} onOpenCategory={onOpenCategory} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-800">{num1(e.score)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs tabular-nums text-slate-500">
                      {dayMonth(e.lastDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* phones: one card per person */}
          <ul className="space-y-2 md:hidden" data-testid="attention-cards">
            {view.rows.map((e) => (
              <li key={e.id} className="rounded-xl border border-slate-100 bg-white p-3">
                <button
                  type="button"
                  onClick={() => onOpenEmployee(e.id)}
                  className="flex w-full items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                  aria-label={`Open ${e.name}, ${e.code}`}
                >
                  <PersonAvatar name={e.name} photoUrl={e.photoUrl} size={38} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-900">{e.name}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      <span className="font-mono">{e.code}</span>
                      {e.department ? ` · ${e.department}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <LevelChip level={e.level} />
                    <span className="text-[11px] tabular-nums text-slate-500">score {num1(e.score)}</span>
                  </div>
                  <ChevronRight size={15} className="shrink-0 text-slate-300" />
                </button>
                <div className="mt-2 border-t border-slate-50 pt-2">
                  <Chips e={e} categories={categories} onOpenCategory={onOpenCategory} />
                </div>
              </li>
            ))}
          </ul>

          <Pager {...view} onPage={setPage} testId="attention-pager" />
        </>
      )}
    </SectionCard>
  );
}

function Chips({
  e,
  categories,
  onOpenCategory,
}: {
  e: EmployeeHit;
  categories: CategoryMeta[];
  onOpenCategory: (key: string) => void;
}) {
  const chips = flagChips(e, categories);
  const shown = chips.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
      {shown.map((c) => (
        <CategoryChip
          key={c.key}
          categoryKey={c.key}
          label={c.label}
          count={c.count}
          flagged={c.flagged}
          informational={c.informational}
          onClick={() => onOpenCategory(c.key)}
        />
      ))}
      {chips.length > shown.length && (
        <span className="text-[11px] font-semibold text-slate-400">+{chips.length - shown.length}</span>
      )}
    </div>
  );
}
