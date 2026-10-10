import { useMemo, useState } from "react";
import {
  CalendarDays,
  CalendarHeart,
  ChevronLeft,
  ChevronRight,
  Gift,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { useDeleteHoliday, useListHolidays } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { useSaveHoliday, type HolidayInput } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { exportSheet } from "./export";
import {
  MONTHS,
  MONTHS_SHORT,
  NO_HOLIDAY_FILTERS,
  WEEKDAYS_SHORT,
  dateOnly,
  daysBetween,
  fallsOnSunday,
  filterHolidays,
  groupHolidaysByMonth,
  holidayFiltersActive,
  holidaysByDay,
  longDate,
  monthGrid,
  nextHoliday,
  relativeDays,
  summarizeHolidays,
  weekdayIndex,
  type HolidayFilters,
  type HolidayRow,
} from "./logic";
import HolidayDialog from "./HolidayDialog";
import {
  Chip,
  EmptyState,
  ErrorState,
  ExportButton,
  FilterPanel,
  FilterSelect,
  ListSkeleton,
  ResultLine,
  SearchBox,
  StatCard,
} from "./parts";

const TYPE_TONE: Record<string, string> = {
  national: TONE.info,
  regional: TONE.accent,
  company: TONE.success,
};

export default function HolidaysTab({ today }: { today: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [filters, setFilters] = useState<HolidayFilters>(NO_HOLIDAY_FILTERS);
  const set = (patch: Partial<HolidayFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const [view, setView] = useState("list");
  const [dialog, setDialog] = useState<{ holiday: HolidayRow | null } | null>(null);
  const [toDelete, setToDelete] = useState<HolidayRow | null>(null);

  const query = useListHolidays({ year });
  const rows = useMemo(() => (query.data ?? []) as HolidayRow[], [query.data]);
  const saveMutation = useSaveHoliday();
  const deleteMutation = useDeleteHoliday();

  const shown = useMemo(() => filterHolidays(rows, filters), [rows, filters]);
  const groups = useMemo(() => groupHolidaysByMonth(shown), [shown]);
  const summary = useMemo(() => summarizeHolidays(rows), [rows]);
  const next = useMemo(() => nextHoliday(rows, today), [rows, today]);
  const branchChoices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const h of rows) if (h.branchId != null && h.branchName) seen.set(String(h.branchId), h.branchName);
    return [
      { value: "none", label: "Every branch" },
      ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [rows]);
  const active = holidayFiltersActive(filters);
  const clear = () => setFilters(NO_HOLIDAY_FILTERS);

  const save = async (input: HolidayInput) => {
    const editing = dialog?.holiday ?? null;
    try {
      await saveMutation.mutateAsync({ id: editing?.id, data: input });
    } catch (err) {
      toast({
        title: editing ? "Failed to save holiday" : "Failed to add holiday",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: editing ? "Holiday saved" : "Holiday added" });
    setDialog(null);
    // a holiday moved or added in another year is not in this list: follow it there
    const savedYear = Number(input.date.slice(0, 4));
    if (savedYear && savedYear !== year) setYear(savedYear);
  };

  const remove = async (h: HolidayRow) => {
    try {
      await deleteMutation.mutateAsync(h.id);
    } catch {
      toast({ title: "Failed to delete holiday", variant: "destructive" });
      return;
    }
    toast({ title: "Holiday deleted" });
    queryClient.invalidateQueries({ queryKey: ["/api/holidays"] });
  };

  return (
    <div className="space-y-4 pt-4" data-testid="tab-holidays">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={`Holidays in ${year}`}
          value={summary.total}
          sub={`${summary.national} national · ${summary.regional} regional · ${summary.company} company`}
          icon={Gift}
          tone="bg-purple-50 text-purple-800"
          testId="hol-stat-total"
        />
        <StatCard
          label="Next holiday"
          value={next ? relativeDays(next.inDays) : "None left"}
          sub={
            next
              ? `${next.holiday.name}, ${longDate(next.holiday.date)}`
              : year < Number(today.slice(0, 4))
                ? "A past year"
                : "No more this year"
          }
          icon={CalendarHeart}
          tone="bg-blue-50 text-blue-800"
          testId="hol-stat-next"
        />
        <StatCard
          label="Fall on a Sunday"
          value={summary.onSunday}
          sub="no extra day off"
          icon={CalendarDays}
          tone="bg-rose-50 text-rose-800"
          testId="hol-stat-sunday"
        />
        <StatCard
          label="Repeat every year"
          value={rows.filter((h) => h.isRecurring).length}
          icon={Gift}
          tone="bg-emerald-50 text-emerald-800"
          testId="hol-stat-recurring"
        />
      </div>

      <FilterPanel>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5" data-testid="hol-year">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setYear(year - 1)}
              aria-label="Previous year"
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="min-w-[4rem] text-center text-sm font-bold text-gray-900" data-testid="hol-year-label">
              {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setYear(year + 1)}
              aria-label="Next year"
            >
              <ChevronRight size={16} />
            </Button>
          </div>
          <PillTabs
            size="sm"
            items={[
              { value: "list", label: "List" },
              { value: "calendar", label: "Year view" },
            ]}
            value={view}
            onChange={setView}
          />
          <div className="ml-auto flex items-center gap-2">
            <ExportButton
              disabled={shown.length === 0}
              testId="hol-export"
              onClick={() =>
                exportSheet(
                  `Holidays ${year}`,
                  ["Date", "Day", "Holiday", "Type", "Applies to", "Repeats yearly", "Description"],
                  shown.map((h) => [
                    dateOnly(h.date) ?? "",
                    WEEKDAYS_SHORT[weekdayIndex(dateOnly(h.date) ?? "1970-01-05")],
                    h.name,
                    h.holidayType,
                    h.branchName ?? "Every branch",
                    h.isRecurring ? "Yes" : "No",
                    h.description ?? "",
                  ]),
                )
              }
            />
            <Button onClick={() => setDialog({ holiday: null })} className="h-10 gap-1.5" data-testid="hol-add">
              <Plus size={15} /> Add Holiday
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => set({ query })}
            placeholder="Search holidays by name, description or branch"
            label="Search holidays"
            testId="hol-search"
          />
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <FilterSelect
              value={filters.type}
              onChange={(type) => set({ type })}
              label="Filter by holiday type"
              allLabel="All types"
              options={[
                { value: "national", label: "National" },
                { value: "regional", label: "Regional" },
                { value: "company", label: "Company" },
              ]}
              testId="hol-filter-type"
            />
            <FilterSelect
              value={filters.month}
              onChange={(month) => set({ month })}
              label="Filter by month"
              allLabel="All months"
              options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
              testId="hol-filter-month"
            />
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => set({ branch })}
              label="Filter by branch"
              allLabel="All branches"
              options={branchChoices}
              testId="hol-filter-branch"
            />
          </div>
        </div>
        <ResultLine
          shown={shown.length}
          total={rows.length}
          noun="holidays"
          active={active}
          onClear={clear}
          testId="hol-count"
        />
      </FilterPanel>

      {query.isLoading ? (
        <Card className="rounded-2xl">
          <ListSkeleton testId="hol-loading" />
        </Card>
      ) : query.isError ? (
        <Card className="rounded-2xl">
          <ErrorState what="holidays" onRetry={() => query.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card className="rounded-2xl">
          <EmptyState
            icon={Gift}
            title={`No holidays for ${year}`}
            text="Add the festivals and company holidays for the year. Attendance and payroll treat them as paid days off."
            testId="hol-empty"
            action={
              <Button onClick={() => setDialog({ holiday: null })} className="gap-1.5">
                <Plus size={15} /> Add the first holiday
              </Button>
            }
          />
        </Card>
      ) : shown.length === 0 ? (
        <Card className="rounded-2xl">
          <EmptyState
            icon={Search}
            title="No holiday matches"
            text="Try fewer words, or clear the filters."
            tone="bg-gray-100 text-gray-500"
            testId="hol-no-match"
            action={
              <Button variant="outline" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        </Card>
      ) : view === "calendar" ? (
        <YearView year={year} rows={shown} today={today} />
      ) : (
        <div className="space-y-5" data-testid="hol-list">
          {groups.map((g) => (
            <section key={g.month} aria-label={MONTHS[g.month - 1]} className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                {MONTHS[g.month - 1]} <span className="font-semibold text-gray-400">({g.rows.length})</span>
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {g.rows.map((h) => {
                  const d = dateOnly(h.date) ?? "";
                  const past = d < today;
                  return (
                    <Card
                      key={h.id}
                      data-testid={`holiday-${h.id}`}
                      className={cn("rounded-2xl border transition-shadow hover:shadow-md", past && "opacity-70")}
                    >
                      <CardContent className="flex items-start gap-3 p-4">
                        <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-purple-50 text-purple-800">
                          <span className="text-lg font-black leading-none">{d.slice(8, 10)}</span>
                          <span className="mt-0.5 text-[10px] font-bold uppercase">
                            {WEEKDAYS_SHORT[weekdayIndex(d)]}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-gray-900">{h.name}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Chip className={cn("capitalize", TYPE_TONE[h.holidayType] ?? TONE.neutral)}>
                              {h.holidayType}
                            </Chip>
                            {h.isRecurring && (
                              <Chip className="border-blue-200 bg-blue-50 text-blue-600">Recurring</Chip>
                            )}
                            <Chip className="border-gray-200 bg-white text-gray-600">
                              {h.branchName ?? "Every branch"}
                            </Chip>
                            {fallsOnSunday(h) && <Chip className={TONE.caution}>Sunday</Chip>}
                          </div>
                          <p className="mt-1 text-xs text-gray-500">
                            {longDate(h.date)}
                            {!past && <span className="text-gray-400"> · {relativeDays(daysBetween(today, d))}</span>}
                          </p>
                          {h.description && <p className="mt-0.5 text-xs text-gray-400">{h.description}</p>}
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-gray-500"
                            onClick={() => setDialog({ holiday: h })}
                            aria-label={`Edit ${h.name}`}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-400 hover:text-red-600"
                            onClick={() => setToDelete(h)}
                            disabled={deleteMutation.isPending}
                            aria-label={`Delete ${h.name}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <HolidayDialog
        open={dialog !== null}
        holiday={dialog?.holiday ?? null}
        saving={saveMutation.isPending}
        onClose={() => setDialog(null)}
        onSave={save}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this holiday?"
        description={
          toDelete
            ? `${toDelete.name} (${longDate(toDelete.date)}) will stop counting as a paid day off. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void remove(toDelete);
          setToDelete(null);
        }}
        testId="confirm-delete-holiday"
      />
    </div>
  );
}

/** Twelve small months with the holidays marked, for seeing the year's shape (and long weekends) at a glance. */
function YearView({ year, rows, today }: { year: number; rows: HolidayRow[]; today: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="hol-year-view">
      {MONTHS.map((name, i) => {
        const month = i + 1;
        const byDay = holidaysByDay(rows, year, month);
        return (
          <Card key={name} className="rounded-2xl">
            <CardContent className="p-3">
              <p className="mb-2 text-sm font-bold text-gray-900">
                {name}{" "}
                <span className="text-xs font-semibold text-gray-400">{byDay.size ? `(${byDay.size})` : ""}</span>
              </p>
              <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-semibold text-gray-400">
                {WEEKDAYS_SHORT.map((d) => (
                  <span key={d}>{d.slice(0, 2)}</span>
                ))}
                {monthGrid(year, month)
                  .flat()
                  .map((cell) => {
                    const list = byDay.get(cell.iso);
                    if (!cell.inMonth) return <span key={cell.iso} />;
                    const cls = cn(
                      "rounded py-1 text-[11px]",
                      cell.weekday === 6 && "text-rose-500",
                      list && "bg-purple-600 font-bold text-white hover:bg-purple-700",
                      cell.iso === today && !list && "ring-1 ring-blue-500",
                    );
                    return (
                      <span
                        key={cell.iso}
                        className={cls}
                        title={list?.map((h) => h.name).join(", ")}
                        data-holiday={list ? "true" : undefined}
                      >
                        {cell.day}
                      </span>
                    );
                  })}
              </div>
              {byDay.size > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-gray-600">
                  {[...byDay].map(([iso, list]) => (
                    <li key={iso}>
                      <span className="font-semibold">
                        {Number(iso.slice(8, 10))} {MONTHS_SHORT[month - 1]}
                      </span>{" "}
                      {list.map((h) => h.name).join(", ")}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
