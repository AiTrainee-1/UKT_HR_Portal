import { useMemo, useState } from "react";
import { CalendarDays, CalendarRange, Flame, Gift, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useListCasualLeaves, useListHolidays } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { exportSheet } from "./export";
import {
  ALL,
  MONTHS,
  NO_PERSON_FILTERS,
  WEEKDAYS_SHORT,
  awayPeople,
  branchOptions,
  departmentOptions,
  entriesByDay,
  entryFromCasual,
  entryFromLeave,
  heatLevel,
  holidaysByDay,
  longDate,
  matchesPerson,
  monthGrid,
  personFiltersActive,
  shortDate,
  summarizeCalendar,
  type CalendarEntry,
  type LeaveRow,
  type PersonFilters,
} from "./logic";
import {
  Chip,
  EmptyState,
  ErrorState,
  ExportButton,
  FilterPanel,
  FilterSelect,
  ListSkeleton,
  MonthPicker,
  PersonCell,
  SearchBox,
  StatCard,
  StatusChip,
} from "./parts";

type Props = {
  leaves: LeaveRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  today: string;
};

type CalendarFilters = PersonFilters & {
  /** "all" (approved and pending), "approved" or "pending". */
  status: string;
  /** "all", "leave" (full days), "half" or "casual". */
  kind: string;
};

const NO_FILTERS: CalendarFilters = { ...NO_PERSON_FILTERS, status: ALL, kind: ALL };

const HEAT = [
  "bg-white hover:bg-gray-50",
  "bg-sky-50 hover:bg-sky-100",
  "bg-sky-100 hover:bg-sky-200",
  "bg-sky-200 hover:bg-sky-300",
  "bg-sky-300 hover:bg-sky-400",
];

export default function CalendarTab({ leaves, loading, failed, onRetry, today }: Props) {
  const now = new Date();
  const [{ year, month }, setMonth] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [filters, setFilters] = useState<CalendarFilters>(NO_FILTERS);
  const set = (patch: Partial<CalendarFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const [picked, setPicked] = useState<string | null>(today);

  const casual = useListCasualLeaves({ month, year });
  const holidays = useListHolidays({ year });

  // everything that could put someone on this calendar, before the filters
  const all = useMemo(() => {
    const out: CalendarEntry[] = [];
    for (const l of leaves) {
      const e = entryFromLeave(l);
      if (e) out.push(e);
    }
    for (const c of casual.data ?? []) {
      const e = entryFromCasual(c);
      if (e) out.push(e);
    }
    return out;
  }, [leaves, casual.data]);

  const entries = useMemo(
    () =>
      all.filter(
        (e) =>
          (filters.status === ALL || e.status === filters.status) &&
          (filters.kind === ALL || e.kind === filters.kind) &&
          matchesPerson(e, filters),
      ),
    [all, filters],
  );
  const byDay = useMemo(() => entriesByDay(entries, year, month), [entries, year, month]);
  const summary = useMemo(() => summarizeCalendar(byDay), [byDay]);
  const people = useMemo(() => awayPeople(byDay), [byDay]);
  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const holidaysOn = useMemo(() => holidaysByDay(holidays.data ?? [], year, month), [holidays.data, year, month]);
  const branches = useMemo(() => branchOptions(all), [all]);
  const departments = useMemo(() => departmentOptions(all), [all]);
  const active = personFiltersActive(filters) || filters.status !== ALL || filters.kind !== ALL;
  const busiest = Math.max(0, ...[...byDay.values()].map((l) => l.length));
  const isThisMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const awayToday = byDay.get(today)?.length ?? 0;
  const dayEntries = picked ? (byDay.get(picked) ?? []) : [];
  const pickedHoliday = picked ? (holidaysOn.get(picked) ?? []) : [];
  const isLoading = loading || casual.isLoading;
  const failedLoad = failed || casual.isError;

  const clear = () => setFilters(NO_FILTERS);

  return (
    <div className="space-y-4 pt-4" data-testid="tab-calendar">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="People on leave"
          value={summary.people}
          sub={`in ${MONTHS[month - 1]} ${year}`}
          icon={Users}
          tone="bg-blue-50 text-blue-800"
          testId="cal-stat-people"
        />
        <StatCard
          label="Leave days"
          value={summary.personDays}
          sub="person-days, pending included"
          icon={CalendarRange}
          tone="bg-indigo-50 text-indigo-800"
          testId="cal-stat-days"
        />
        <StatCard
          label="Busiest day"
          value={summary.busiest ? summary.busiest.count : 0}
          sub={summary.busiest ? shortDate(summary.busiest.iso, year) : "No leave this month"}
          icon={Flame}
          tone="bg-orange-50 text-orange-800"
          testId="cal-stat-busiest"
        />
        <StatCard
          label={isThisMonth ? "Away today" : "Holidays"}
          value={isThisMonth ? awayToday : holidaysOn.size}
          sub={isThisMonth ? "on leave right now" : `in ${MONTHS[month - 1]}`}
          icon={isThisMonth ? CalendarDays : Gift}
          tone="bg-emerald-50 text-emerald-800"
          testId="cal-stat-extra"
        />
      </div>

      <FilterPanel>
        <div className="flex flex-wrap items-center gap-3">
          <MonthPicker year={year} month={month} onChange={setMonth} testId="cal-month" />
          <div className="ml-auto">
            <ExportButton
              disabled={people.length === 0}
              testId="cal-export"
              onClick={() =>
                exportSheet(
                  `Leave calendar ${MONTHS[month - 1]} ${year}`,
                  ["Employee code", "Employee", "Days away", "Dates", "Type"],
                  people.map((p) => [
                    p.code ?? "",
                    p.name,
                    p.days,
                    p.entries
                      .map((e) =>
                        e.start === e.end ? shortDate(e.start) : `${shortDate(e.start)} to ${shortDate(e.end)}`,
                      )
                      .join("; "),
                    [...new Set(p.entries.map((e) => e.label))].join("; "),
                  ]),
                )
              }
            />
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => set({ query })}
            placeholder="Search by name, employee code, department or branch"
            label="Search the leave calendar"
            testId="cal-search"
          />
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => set({ branch })}
              label="Filter by branch"
              allLabel="All branches"
              options={branches}
              testId="cal-filter-branch"
            />
            <FilterSelect
              value={filters.department}
              onChange={(department) => set({ department })}
              label="Filter by department"
              allLabel="All departments"
              options={departments}
              testId="cal-filter-department"
            />
            <FilterSelect
              value={filters.employeeType}
              onChange={(employeeType) => set({ employeeType })}
              label="Filter by employee type"
              allLabel="Staff and production"
              options={[
                { value: "staff", label: "Staff" },
                { value: "production", label: "Production" },
              ]}
              testId="cal-filter-employee-type"
            />
            <FilterSelect
              value={filters.kind}
              onChange={(kind) => set({ kind })}
              label="Filter by kind of leave"
              allLabel="All kinds"
              options={[
                { value: "leave", label: "Full day" },
                { value: "half", label: "Half day" },
                { value: "casual", label: "Casual leave (CL)" },
              ]}
              testId="cal-filter-kind"
            />
            <FilterSelect
              value={filters.status}
              onChange={(status) => set({ status })}
              label="Filter by status"
              allLabel="Approved and pending"
              options={[
                { value: "approved", label: "Approved only" },
                { value: "pending", label: "Pending only" },
              ]}
              testId="cal-filter-status"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Legend />
          <p className="text-xs text-gray-500" data-testid="cal-count">
            <b>{people.length}</b> {people.length === 1 ? "person" : "people"} away in {MONTHS[month - 1]}
            {active && (
              <button
                type="button"
                onClick={clear}
                className="ml-2 font-semibold text-blue-600 hover:underline"
                data-testid="cal-count-clear"
              >
                Clear filters
              </button>
            )}
          </p>
        </div>
      </FilterPanel>

      {isLoading ? (
        <Card className="rounded-2xl">
          <ListSkeleton rows={6} testId="cal-loading" />
        </Card>
      ) : failedLoad ? (
        <Card className="rounded-2xl">
          <ErrorState what="the leave calendar" onRetry={onRetry} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card className="overflow-hidden rounded-2xl">
            <CardContent className="p-0">
              <div className="grid grid-cols-7 border-b bg-gray-50 text-center text-[11px] font-bold uppercase tracking-wider text-gray-500">
                {WEEKDAYS_SHORT.map((d) => (
                  <div key={d} className={cn("py-2", d === "Sun" && "text-rose-500")}>
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7" data-testid="cal-grid">
                {grid.flat().map((cell) => {
                  const list = byDay.get(cell.iso) ?? [];
                  const holiday = holidaysOn.get(cell.iso);
                  const sunday = cell.weekday === 6;
                  const level = cell.inMonth ? heatLevel(list.length, busiest) : 0;
                  const isToday = cell.iso === today;
                  const isPicked = cell.iso === picked;
                  const label = `${longDate(cell.iso)}: ${list.length} on leave${holiday ? `, holiday` : ""}`;
                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      disabled={!cell.inMonth}
                      onClick={() => setPicked(cell.iso)}
                      aria-label={label}
                      aria-pressed={isPicked}
                      data-testid={`cal-day-${cell.iso}`}
                      data-count={list.length}
                      className={cn(
                        "relative flex min-h-[3.75rem] flex-col items-start justify-between border-b border-r p-1.5 text-left transition-colors sm:min-h-[5rem] sm:p-2",
                        cell.inMonth ? HEAT[level] : "bg-gray-50/60 text-gray-300",
                        sunday && cell.inMonth && level === 0 && "bg-rose-50/40",
                        isPicked && "z-10 ring-2 ring-inset ring-blue-500",
                      )}
                    >
                      <span
                        className={cn(
                          "text-xs font-bold",
                          isToday && "rounded-full bg-blue-600 px-1.5 py-0.5 text-white",
                          sunday && !isToday && cell.inMonth && "text-rose-500",
                        )}
                      >
                        {cell.day}
                      </span>
                      <span className="flex w-full items-end justify-between gap-1">
                        {holiday && cell.inMonth ? (
                          <Gift size={12} className="shrink-0 text-purple-500" aria-hidden />
                        ) : (
                          <span />
                        )}
                        {list.length > 0 && (
                          <span className="rounded-full bg-white/80 px-1.5 text-xs font-black text-sky-900 shadow-sm">
                            {list.length}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="rounded-2xl" data-testid="cal-day-panel">
              <CardContent className="space-y-3 p-4">
                <div>
                  <p className="text-sm font-bold text-gray-900">{picked ? longDate(picked) : "Pick a day"}</p>
                  <p className="text-xs text-gray-500">
                    {picked
                      ? dayEntries.length
                        ? `${dayEntries.length} ${dayEntries.length === 1 ? "person is" : "people are"} on leave`
                        : "Nobody is on leave"
                      : "Select a day on the calendar to see who is away."}
                  </p>
                </div>
                {pickedHoliday.map((h) => (
                  <Chip key={h.id} className="border-purple-200 bg-purple-50 text-purple-700">
                    <Gift size={11} /> {h.name}
                  </Chip>
                ))}
                <div className="space-y-2.5">
                  {dayEntries.map((e) => (
                    <div key={e.key} className="flex items-center justify-between gap-2" data-testid="cal-day-person">
                      <PersonCell
                        id={e.employeeId}
                        name={e.employeeName}
                        code={e.employeeCode}
                        sub={e.department}
                        size="sm"
                      />
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[11px] font-medium text-gray-600">{e.label}</span>
                        <StatusChip status={e.status} className="text-[10px]" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl" data-testid="cal-people">
              <CardContent className="space-y-3 p-4">
                <p className="text-sm font-bold text-gray-900">Away in {MONTHS[month - 1]}</p>
                {people.length === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title={active ? "Nobody matches" : "No leave this month"}
                    text={
                      active
                        ? "No leave in this month fits the filters."
                        : `Nobody has approved or pending leave in ${MONTHS[month - 1]} ${year}.`
                    }
                    tone="bg-gray-100 text-gray-500"
                    testId="cal-empty"
                  />
                ) : (
                  <ul className="divide-y">
                    {people.slice(0, 40).map((p) => (
                      <li key={p.employeeId} className="flex items-center justify-between gap-2 py-2">
                        <PersonCell id={p.employeeId} name={p.name} code={p.code} size="sm" />
                        <span className="shrink-0 text-xs font-semibold text-gray-600">
                          {p.days} day{p.days === 1 ? "" : "s"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500" aria-hidden>
      <span>Fewer</span>
      {HEAT.slice(1).map((c, i) => (
        <span key={i} className={cn("h-3.5 w-5 rounded border", c.split(" ")[0])} />
      ))}
      <span>More people away</span>
      <span className="ml-2 inline-flex items-center gap-1">
        <Gift size={11} className="text-purple-500" /> Holiday
      </span>
    </div>
  );
}
