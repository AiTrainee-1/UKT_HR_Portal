import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, History, RefreshCw, Search } from "lucide-react";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { dateTime } from "@/components/payroll/kit/format";
import { EmptyNote, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  usePayrollExcessHistory,
  type ExcessAction,
  type ExcessEmployeeOption,
  type ExcessHistoryItem,
  type ExcessKind,
  type PayrollScope,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import {
  ACTION_LABEL,
  KIND_LABEL,
  allPeriodsLabel,
  amountMove,
  hasHistoryFilters,
  historyFilters,
  historyItemPeriod,
  netMove,
  optionMatches,
  sortOptions,
  totalPages,
  type HistoryUi,
} from "./logic";
import { ActionChip, KindChip, SourceChip, errorText } from "./parts";

const VIEW_SAFE = { [VIEW_SAFE_ATTR]: "" };
const ALL = "all";
const PAGE_SIZES = [25, 50, 100];

/**
 * History & audit of the Excess tab: every add, change and remove (who, when, the amount before and after, the remark and
 * the payroll's NET before and after), for the page's month (period) or every month (every period of the cycle), with
 * filters and pages.
 */
export function HistoryView({
  scope,
  periodLabel,
  departments,
  employees,
  ui,
  onUi,
}: {
  /** The staff month or production period of the page. */
  scope: PayrollScope;
  periodLabel: string;
  /** The departments of the page's category (id + name) for the filter. */
  departments: { id: number; name: string }[];
  employees: ExcessEmployeeOption[];
  ui: HistoryUi;
  onUi: (patch: Partial<HistoryUi>) => void;
}) {
  const [pageSize, setPageSize] = useState(50);
  const filters = useMemo(() => historyFilters(ui, scope, pageSize), [ui, scope, pageSize]);
  const query = usePayrollExcessHistory(scope.kind, filters);
  const accent = ACCENT_UI[accentOf(scope.kind)];
  const allLabel = allPeriodsLabel(scope);
  const data = query.data;
  const items = data?.items ?? [];
  const pages = totalPages(data?.total ?? 0, data?.pageSize ?? pageSize);
  const filtered = hasHistoryFilters(ui);

  return (
    <div className="space-y-3" data-testid="excess-history">
      <div
        className="min-w-0 space-y-2 rounded-2xl border bg-white p-3"
        role="search"
        aria-label="Filter the history"
        data-testid="excess-history-filters"
        {...VIEW_SAFE}
      >
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
          <Select value={ui.allPeriods ? ALL : "this"} onValueChange={(v) => onUi({ allPeriods: v === ALL })}>
            <SelectTrigger
              className="h-10 min-w-0 md:w-52"
              aria-label={scope.kind === "staff" ? "Month" : "Pay period"}
              data-testid="excess-history-month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="this">{periodLabel}</SelectItem>
              <SelectItem value={ALL}>{allLabel}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={ui.dept || ALL} onValueChange={(v) => onUi({ dept: v === ALL ? "" : v })}>
            <SelectTrigger className="h-10 min-w-0 md:w-48" aria-label="Department" data-testid="excess-history-dept">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
              {ui.dept && !departments.some((d) => String(d.id) === ui.dept) && (
                <SelectItem value={ui.dept}>Department #{ui.dept}</SelectItem>
              )}
            </SelectContent>
          </Select>
          <EmployeeFilter
            value={ui.emp}
            onChange={(emp) => onUi({ emp })}
            employees={employees}
            optionOn={accent.optionOn}
            className="col-span-2 min-w-0 md:w-56"
          />
          <Select value={ui.kind || ALL} onValueChange={(v) => onUi({ kind: v === ALL ? "" : (v as ExcessKind) })}>
            <SelectTrigger className="h-10 min-w-0 md:w-40" aria-label="Type" data-testid="excess-history-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every type</SelectItem>
              <SelectItem value="excess">{KIND_LABEL.excess}</SelectItem>
              <SelectItem value="detection">{KIND_LABEL.detection}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={ui.action || ALL}
            onValueChange={(v) => onUi({ action: v === ALL ? "" : (v as ExcessAction) })}
          >
            <SelectTrigger className="h-10 min-w-0 md:w-40" aria-label="Action" data-testid="excess-history-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every action</SelectItem>
              {(["added", "changed", "removed"] as ExcessAction[]).map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTION_LABEL[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span data-testid="excess-history-count">
            {query.isLoading
              ? "Loading the history…"
              : `${data?.total ?? 0} ${data?.total === 1 ? "change" : "changes"}${ui.allPeriods ? ` (${allLabel.toLowerCase()})` : ` in ${periodLabel}`}`}
          </span>
          {filtered && (
            <button
              type="button"
              className={cn("font-semibold hover:underline", accent.link)}
              onClick={() => onUi({ allPeriods: false, dept: "", emp: "", kind: "", action: "" })}
              data-testid="excess-history-clear"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <SkeletonRows rows={5} />
      ) : query.isError ? (
        <EmptyNote
          icon={RefreshCw}
          title="The history could not be loaded"
          hint={errorText(query.error) ?? "Check the connection and try again."}
          testId="excess-history-error"
          action={
            <Button variant="outline" className="mt-2" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyNote
          icon={History}
          title={
            filtered ? "No change matches these filters" : `Nothing was added, changed or removed in ${periodLabel}`
          }
          hint={
            filtered
              ? "Change or clear the filters to see the rest."
              : "Every excess or detection added, changed or removed shows up here, with who did it and why."
          }
          testId="excess-history-empty"
        />
      ) : (
        <div className={cn("space-y-2", query.isFetching && "opacity-70 transition-opacity")}>
          <HistoryTable items={items} showPeriod={ui.allPeriods} />
          <ul className="space-y-2 md:hidden" data-testid="excess-history-cards">
            {items.map((item) => (
              <HistoryCard key={item.id} item={item} showPeriod={ui.allPeriods} />
            ))}
          </ul>
          <div {...VIEW_SAFE}>
            <DataPagination
              page={ui.page}
              totalPages={pages}
              onPageChange={(page) => onUi({ page })}
              pageSize={pageSize}
              onPageSizeChange={(size) => {
                // a bigger page can leave the page number past the end: start again from the first one
                setPageSize(size);
                if (ui.page !== 1) onUi({ page: 1 });
              }}
              pageSizes={PAGE_SIZES}
              totalItems={data?.total ?? 0}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** md and up: one table, scrolling sideways inside its own box when the screen is narrower than it. */
function HistoryTable({ items, showPeriod }: { items: ExcessHistoryItem[]; showPeriod: boolean }) {
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-slate-100 bg-white md:block">
      <table className="w-full min-w-[60rem] text-sm" data-testid="excess-history-table">
        <thead>
          <tr className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <th className="px-3 py-2">Date &amp; time</th>
            <th className="px-3 py-2">Employee</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">Amount</th>
            <th className="px-3 py-2">Remark</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Payroll NET</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
            <tr key={item.id} className="align-top" data-testid={`excess-history-row-${item.id}`}>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-700">
                {dateTime(item.at)}
                {showPeriod && (
                  <span className="block text-[11px] text-muted-foreground">for {historyItemPeriod(item)}</span>
                )}
              </td>
              <td className="px-3 py-2">
                <p className="font-semibold text-gray-900">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{item.code}</span>
                  {item.department ? ` · ${item.department}` : ""}
                </p>
              </td>
              <td className="px-3 py-2">
                <KindChip kind={item.kind} />
              </td>
              <td className="px-3 py-2">
                <span className="flex flex-wrap gap-1">
                  <ActionChip action={item.action} />
                  <SourceChip source={item.source} />
                </span>
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-semibold tabular-nums text-gray-900">
                {amountMove(item)}
              </td>
              <td className="max-w-[18rem] whitespace-pre-line break-words px-3 py-2 text-xs text-gray-700">
                {item.remark}
              </td>
              <td className="px-3 py-2 text-xs text-gray-700">{item.by ?? "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-gray-700">
                {netMove(item) ?? <span className="text-gray-400">No payroll</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Below md: a card per change. */
function HistoryCard({ item, showPeriod }: { item: ExcessHistoryItem; showPeriod: boolean }) {
  const net = netMove(item);
  return (
    <li
      className="space-y-1.5 rounded-2xl border border-slate-100 bg-white p-3 text-sm"
      data-testid={`excess-history-card-${item.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-900">{item.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{item.code}</span>
            {item.department ? ` · ${item.department}` : ""}
          </p>
        </div>
        <span className="shrink-0 font-semibold tabular-nums text-gray-900">{amountMove(item)}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        <KindChip kind={item.kind} />
        <ActionChip action={item.action} />
        <SourceChip source={item.source} />
      </div>
      <p className="whitespace-pre-line break-words text-xs text-gray-700">{item.remark}</p>
      <p className="text-[11px] text-muted-foreground">
        {item.by ?? "—"} · {dateTime(item.at)}
        {showPeriod && ` · for ${historyItemPeriod(item)}`}
      </p>
      <p className="text-[11px] text-muted-foreground">
        Payroll NET: <span className="tabular-nums text-gray-700">{net ?? "no payroll touched"}</span>
      </p>
    </li>
  );
}

/** One employee or all: a search over the employees of the page's category. */
function EmployeeFilter({
  value,
  onChange,
  employees,
  optionOn,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  employees: ExcessEmployeeOption[];
  /** The tint of the employee picked (the page's accent). */
  optionOn: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const sorted = useMemo(() => sortOptions(employees.map((e) => ({ ...e, eligible: true }))), [employees]);
  const shown = useMemo(() => sorted.filter((o) => optionMatches(o, q)).slice(0, 80), [sorted, q]);
  const current = employees.find((e) => String(e.id) === value);
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Employee"
          className={cn("h-10 w-full justify-between px-3 font-normal", className)}
          data-testid="excess-history-employee"
          {...VIEW_SAFE}
        >
          <span className={cn("min-w-0 truncate", current || value ? "text-gray-900" : "text-muted-foreground")}>
            {current ? `${current.name} (${current.code})` : value ? `Employee #${value}` : "All employees"}
          </span>
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-0" {...VIEW_SAFE}>
        <div className="relative border-b p-2">
          <Search
            size={13}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or code"
            aria-label="Search employees"
            className="h-8 pl-8 text-sm"
            data-testid="excess-history-employee-search"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
            onClick={() => pick("")}
          >
            <span className="flex h-4 w-4 items-center justify-center">{!value && <Check size={12} />}</span>
            All employees
          </button>
          {shown.map((o) => (
            <button
              key={o.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50",
                String(o.id) === value && optionOn,
              )}
              onClick={() => pick(String(o.id))}
              data-testid={`excess-history-employee-${o.id}`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {String(o.id) === value && <Check size={12} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {o.name} <span className="font-mono text-xs text-muted-foreground">{o.code}</span>
                </span>
                {o.department && (
                  <span className="block truncate text-[11px] text-muted-foreground">{o.department}</span>
                )}
              </span>
            </button>
          ))}
          {shown.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">No employee found.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
