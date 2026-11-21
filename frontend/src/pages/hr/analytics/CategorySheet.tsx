import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Search, SearchX } from "lucide-react";
import { Chip, EmptyNote, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { errorText, useAnalyticsCategory } from "./api";
import { dayMonth, matchesQuery, num1, patternNote, plural, thresholdText, PAGE_SIZE } from "./logic";
import { LevelChip, LimitBar, PersonAvatar, RecordItem, WeekdayBars, categoryIcon } from "./parts";
import type { CategoryEmployee, CategoryMeta } from "./types";

type SheetSort = "count" | "name" | "lastDate";

const RECORDS_AT_ONCE = 8;

function Figure({ label, value, tone = "text-slate-900" }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-2.5 text-center">
      <p className={cn("text-lg font-black tabular-nums leading-tight", tone)}>{value}</p>
      <p className="text-[10px] font-medium text-slate-500">{label}</p>
    </div>
  );
}

function PersonRow({
  e,
  category,
  onOpenEmployee,
}: {
  e: CategoryEmployee;
  category: CategoryMeta;
  onOpenEmployee: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const records = useMemo(() => [...e.records].sort((a, b) => b.date.localeCompare(a.date)), [e.records]);
  const shown = all ? records : records.slice(0, RECORDS_AT_ONCE);
  const note = patternNote(e.pattern);
  return (
    <li className="rounded-xl border border-slate-100 bg-white" data-testid={`category-person-${e.id}`}>
      <div className="flex items-start gap-3 p-3">
        <PersonAvatar name={e.name} photoUrl={e.photoUrl} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={() => onOpenEmployee(e.id)}
              className="truncate text-left text-sm font-semibold text-slate-900 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              aria-label={`Open ${e.name}, ${e.code}`}
            >
              {e.name}
            </button>
            <LevelChip level={e.level} />
          </div>
          <p className="truncate text-[11px] text-slate-500">
            <span className="font-mono">{e.code}</span>
            {[e.designation, e.department].filter(Boolean).map((t) => ` · ${t}`)}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <LimitBar count={e.count} category={category} className="flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-slate-600">
              <b className="text-slate-900">{e.count}</b>
              {category.informational ? "" : ` / ${num1(category.threshold)}`} {category.unit}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Last {dayMonth(e.lastDate)}
            {e.pattern.longestStreak > 1 ? ` · ${e.pattern.longestStreak} days in a row at most` : ""}
            {note ? (
              <>
                {" · "}
                <span className="font-semibold text-indigo-700">{note}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="hidden w-28 shrink-0 sm:block">
          <WeekdayBars pattern={e.pattern} compact />
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 border-t border-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
        data-testid={`category-person-${e.id}-records`}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {open ? "Hide" : "Show"} {plural(records.length, "record")}
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <ul className="space-y-1.5">
            {shown.map((r, i) => (
              <RecordItem key={`${r.date}-${i}`} record={r} />
            ))}
          </ul>
          {records.length > shown.length && (
            <Button variant="ghost" size="sm" className="w-full text-indigo-700" onClick={() => setAll(true)}>
              Show all {records.length}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** One category: who is in it (most first), their count against the limit, weekday pattern and every record. */
export function CategorySheet({
  categoryKey,
  meta,
  params,
  onClose,
  onOpenEmployee,
}: {
  categoryKey: string | null;
  /** The category as the summary has it: shown at once while the list loads. */
  meta: CategoryMeta | undefined;
  params: Record<string, string>;
  onClose: () => void;
  onOpenEmployee: (id: number) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useAnalyticsCategory(categoryKey, params);
  const [find, setFind] = useState("");
  const [overOnly, setOverOnly] = useState(false);
  const [sort, setSort] = useState<SheetSort>("count");
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => {
    setFind("");
    setOverOnly(false);
    setSort("count");
    setLimit(PAGE_SIZE);
  }, [categoryKey]);

  const c = data?.category ?? meta;
  const people = useMemo(() => {
    const list = (data?.employees ?? []).filter((e) => matchesQuery(e, find) && (!overOnly || e.flagged));
    const by = {
      count: (a: CategoryEmployee, b: CategoryEmployee) => b.count - a.count || a.name.localeCompare(b.name),
      name: (a: CategoryEmployee, b: CategoryEmployee) => a.name.localeCompare(b.name),
      lastDate: (a: CategoryEmployee, b: CategoryEmployee) =>
        (b.lastDate ?? "").localeCompare(a.lastDate ?? "") || b.count - a.count,
    }[sort];
    return [...list].sort(by);
  }, [data, find, overOnly, sort]);
  const Icon = categoryIcon(categoryKey ?? "");

  return (
    <Sheet open={categoryKey !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="w-full overflow-y-auto bg-slate-50 p-0 sm:max-w-2xl [&>[data-slot=sheet-close]]:z-20"
        data-testid="category-sheet"
      >
        <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-5 pb-4 pt-5 backdrop-blur">
          <SheetHeader className="space-y-1 pr-8 text-left">
            <div className="flex items-center gap-2.5">
              <span className="rounded-xl bg-indigo-50 p-2 text-indigo-700">
                <Icon size={16} />
              </span>
              <SheetTitle className="text-base">{c?.label ?? "Category"}</SheetTitle>
            </div>
            <SheetDescription className="text-xs">
              {c ? `${thresholdText(c)}. ${c.description}` : "Loading the category"}
            </SheetDescription>
          </SheetHeader>
          {c && (
            <div className="mt-3 grid grid-cols-4 gap-2" data-testid="category-sheet-figures">
              <Figure label="Over the limit" value={c.informational ? "-" : c.flagged} tone="text-amber-700" />
              <Figure label="High" value={c.informational ? "-" : c.high} tone="text-red-700" />
              <Figure label="With records" value={c.affected} />
              <Figure label={`${c.unit} in all`} value={num1(c.total)} />
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <Input
                value={find}
                onChange={(e) => {
                  setFind(e.target.value);
                  setLimit(PAGE_SIZE);
                }}
                placeholder="Find in this list"
                aria-label="Find an employee in this category"
                className="h-9 bg-white pl-8"
                data-testid="category-find"
              />
            </div>
            <div className="flex gap-2">
              {!c?.informational && (
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("h-9", overOnly && "border-amber-300 bg-amber-50 text-amber-900")}
                  aria-pressed={overOnly}
                  onClick={() => setOverOnly((v) => !v)}
                  data-testid="category-over-only"
                >
                  <AlertTriangle size={13} /> Over the limit only
                </Button>
              )}
              <select
                aria-label="Sort the list"
                className="h-9 rounded-md border border-input bg-white px-2 text-sm"
                value={sort}
                onChange={(e) => setSort(e.target.value as SheetSort)}
              >
                <option value="count">Most first</option>
                <option value="lastDate">Latest first</option>
                <option value="name">Name</option>
              </select>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500" aria-live="polite" data-testid="category-count">
            {isLoading ? "Loading" : `${plural(people.length, "employee")}${find || overOnly ? " match" : ""}`}
          </p>
        </div>

        <div className="space-y-2 p-4 sm:p-5">
          {isError ? (
            <EmptyNote
              icon={AlertTriangle}
              title="This category could not be loaded"
              hint={errorText(error)}
              action={
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  Retry
                </Button>
              }
            />
          ) : isLoading ? (
            <SkeletonRows rows={5} />
          ) : people.length === 0 ? (
            <EmptyNote
              icon={SearchX}
              title={data?.employees.length ? "Nobody matches" : "Nobody has a record in this category"}
              hint={data?.employees.length ? "Try other words, or show everyone." : undefined}
            />
          ) : (
            <>
              <ul className="space-y-2">
                {people.slice(0, limit).map((e) => (
                  <PersonRow key={e.id} e={e} category={c!} onOpenEmployee={onOpenEmployee} />
                ))}
              </ul>
              {people.length > limit && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setLimit((n) => n + PAGE_SIZE)}
                  data-testid="category-more"
                >
                  Show {Math.min(PAGE_SIZE, people.length - limit)} more of {people.length - limit}
                </Button>
              )}
              {c?.informational && (
                <p className="pt-1 text-center text-[11px] text-slate-500">
                  <Chip tone="accent">For reference</Chip> This list never raises anyone&apos;s level.
                </p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
