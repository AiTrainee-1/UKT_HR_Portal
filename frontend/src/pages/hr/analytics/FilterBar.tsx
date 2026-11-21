import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { categoryForEmploymentType } from "@/lib/departments";
import { cn } from "@/lib/utils";
import {
  MONTHS_LONG,
  QUICK_PRESETS,
  addDays,
  dayMonth,
  departmentChoices,
  fromIso,
  isIso,
  mondayOf,
  presetLabel,
  rangeLabel,
  resolvePeriod,
  type Filters,
  type ResolvedPeriod,
} from "./logic";
import type { DepartmentOption } from "./types";

type LiteEmployee = {
  id: number;
  employeeCode?: string;
  firstName?: string;
  lastName?: string | null;
  employmentType?: string | null;
};

const fieldClass =
  "h-9 rounded-md border border-input bg-white px-2.5 text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300";

/** The period button and its panel: four quick picks, a month, a week (Mon-Sun) or any range. */
export function PeriodPicker({
  period,
  today,
  onChange,
}: {
  period: ResolvedPeriod;
  today: string;
  onChange: (next: ResolvedPeriod) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = fromIso(today)!;
  const picked = fromIso(period.from)!;
  const [month, setMonth] = useState(picked.getMonth() + 1);
  const [year, setYear] = useState(picked.getFullYear());
  const [weekDay, setWeekDay] = useState(period.preset === "week" ? period.from : mondayOf(today));
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const years = Array.from({ length: 4 }, (_, i) => t.getFullYear() - i);

  // the panel opens on the period that is shown
  useEffect(() => {
    if (!open) return;
    const d = fromIso(period.from)!;
    setMonth(d.getMonth() + 1);
    setYear(d.getFullYear());
    setWeekDay(period.preset === "week" ? period.from : mondayOf(today));
    setFrom(period.from);
    setTo(period.to);
  }, [open, period, today]);

  const pick = (next: ResolvedPeriod, close = true) => {
    onChange(next);
    if (close) setOpen(false);
  };
  const pickMonth = (y: number, m: number) => {
    setYear(y);
    setMonth(m);
    pick(resolvePeriod("month", `${y}-${String(m).padStart(2, "0")}-01`, "", today), false);
  };
  const week = resolvePeriod("week", weekDay, "", today);
  const pickWeek = (day: string) => {
    if (!isIso(day)) return;
    setWeekDay(day);
    pick(resolvePeriod("week", day, "", today), false);
  };
  const customOk = isIso(from) && isIso(to) && from <= to && from <= today;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-10 w-full min-w-0 justify-between gap-2 bg-white font-normal xl:w-auto"
          aria-label={`Period: ${presetLabel(period)}, ${rangeLabel(period.from, period.to)}. Change`}
          data-testid="period-button"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CalendarDays size={15} className="shrink-0 text-indigo-600" />
            <span className="truncate font-semibold text-slate-800">{presetLabel(period)}</span>
            <span className="hidden truncate text-xs text-slate-500 2xl:inline">
              {rangeLabel(period.from, period.to)}
            </span>
          </span>
          <ChevronDown size={14} className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] space-y-4 p-4"
        data-testid="period-panel"
      >
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Quick picks</p>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_PRESETS.map((q) => {
              const r = resolvePeriod(q.value, "", "", today);
              const on = period.preset === q.value;
              return (
                <button
                  key={q.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => pick(r)}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
                    on
                      ? "border-indigo-200 bg-indigo-50 text-indigo-900"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                  data-testid={`period-${q.value}`}
                >
                  <span className="block text-sm font-semibold">{q.label}</span>
                  <span className="block text-[11px] text-slate-500">{rangeLabel(r.from, r.to)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Pick a month</legend>
          <div className="flex gap-2">
            <select
              aria-label="Month"
              className={cn(fieldClass, "flex-1")}
              value={month}
              onChange={(e) => pickMonth(year, Number(e.target.value))}
              data-testid="period-month"
            >
              {MONTHS_LONG.map((name, i) => (
                <option key={name} value={i + 1} disabled={year === t.getFullYear() && i + 1 > t.getMonth() + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Year"
              className={cn(fieldClass, "w-24")}
              value={year}
              onChange={(e) => {
                const y = Number(e.target.value);
                pickMonth(y, y === t.getFullYear() ? Math.min(month, t.getMonth() + 1) : month);
              }}
              data-testid="period-year"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Pick a week (Mon-Sun)
          </legend>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              aria-label="Week before"
              onClick={() => pickWeek(addDays(week.from, -7))}
              data-testid="period-week-prev"
            >
              <ChevronLeft size={15} />
            </Button>
            <input
              type="date"
              aria-label="Any day of the week"
              className={cn(fieldClass, "min-w-0 flex-1")}
              value={weekDay}
              max={today}
              onChange={(e) => pickWeek(e.target.value)}
              data-testid="period-week"
            />
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              aria-label="Week after"
              disabled={addDays(week.from, 7) > today}
              onClick={() => pickWeek(addDays(week.from, 7))}
              data-testid="period-week-next"
            >
              <ChevronRight size={15} />
            </Button>
          </div>
          <p className="text-[11px] text-slate-500">
            Mon {dayMonth(week.from)} - Sun {dayMonth(addDays(week.from, 6))}
          </p>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Custom range</legend>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              aria-label="From"
              className={fieldClass}
              value={from}
              max={to || today}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="period-from"
            />
            <input
              type="date"
              aria-label="To"
              className={fieldClass}
              value={to}
              min={from || undefined}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              data-testid="period-to"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={!customOk}
            onClick={() => pick(resolvePeriod("custom", from, to, today))}
            data-testid="period-apply"
          >
            Show {customOk ? rangeLabel(from, to < today ? to : today) : "this range"}
          </Button>
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

/** The search box's text: the page (and its list) follow every key at once, the address and the server 300 ms after
 *  the last one. A change of the address from elsewhere (Clear, a link) puts its words back in the box. */
export function useDebouncedSearch(committed: string, commit: (text: string) => void, delay = 300) {
  const [text, setText] = useState(committed);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    setText((t) => (t.trim() === committed.trim() ? t : committed));
  }, [committed]);
  useEffect(() => {
    if (text.trim() === committed.trim()) return;
    const timer = window.setTimeout(() => commitRef.current(text), delay);
    return () => window.clearTimeout(timer);
  }, [text, committed, delay]);
  const clear = useCallback(() => {
    setText("");
    commitRef.current("");
  }, []);
  return { text, setText, clear };
}

/** Search, period, department and employee: one row on a desktop, stacked on a phone. Every change goes to the address. */
export function FilterBar({
  filters,
  today,
  departments,
  employees,
  onChange,
  onClear,
  narrowed,
  search,
}: {
  filters: Filters;
  today: string;
  departments: DepartmentOption[];
  employees: LiteEmployee[] | undefined;
  onChange: (patch: Partial<Filters>) => void;
  onClear: () => void;
  narrowed: boolean;
  /** The box's own text (useDebouncedSearch): it answers at once, the address follows. */
  search: { text: string; setText: (text: string) => void; clear: () => void };
}) {
  const choices = useMemo(
    () => departmentChoices(departments, filters.tab, filters.dept),
    [departments, filters.tab, filters.dept],
  );
  const people = useMemo(() => {
    const all = employees ?? [];
    return all.filter((e) => categoryForEmploymentType(e.employmentType) === filters.tab || e.id === filters.emp);
  }, [employees, filters.tab, filters.emp]);

  return (
    <div className="flex flex-col gap-2 xl:flex-row xl:items-center" role="search" aria-label="Analytics filters">
      <div className="relative min-w-0 flex-1">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          placeholder="Search name, code, designation or department"
          aria-label="Search employees"
          className="h-10 bg-white pl-9 pr-9"
          data-testid="analytics-search"
        />
        {search.text && (
          <button
            type="button"
            onClick={search.clear}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 xl:flex xl:items-center">
        <PeriodPicker period={filters.period} today={today} onChange={(period) => onChange({ period })} />
        <Select
          value={filters.dept ? String(filters.dept) : "all"}
          onValueChange={(v) => onChange({ dept: v === "all" ? null : Number(v) })}
        >
          <SelectTrigger
            className={cn("h-10 bg-white xl:w-48", filters.dept && "border-indigo-300 text-indigo-900")}
            aria-label="Department"
            data-testid="filter-department"
          >
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {choices.map((d, i) => (
              <SelectItem key={d.id} value={String(d.id)}>
                {d.label}
                {choices.some((o, j) => j !== i && o.label === d.label) ? ` · #${d.id}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="min-w-0 xl:w-56 [&_button]:h-10 [&_button]:bg-white">
          <EmployeeSearchSelect
            employees={people}
            value={filters.emp ? String(filters.emp) : "all"}
            onChange={(v) => onChange({ emp: v === "all" ? null : Number(v) })}
            allowAll
            allPlaceholder="All employees"
            placeholder="Pick an employee"
            dataTestId="filter-employee"
          />
        </div>
        {narrowed && (
          <Button
            variant="ghost"
            className="h-10 gap-1.5 justify-self-start text-slate-600"
            onClick={onClear}
            data-testid="clear-filters"
          >
            <X size={14} /> Clear
          </Button>
        )}
      </div>
    </div>
  );
}
