import { useMemo, useState } from "react";
import { CalendarClock, Info, PartyPopper, SearchX, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataPagination } from "@/components/ui/DataPagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, pageOf } from "../career/common";
import { formatDate, monthsLabel, tenureLabel } from "../career/dates";
import {
  Chip,
  EmptyState,
  ErrorState,
  FilterSelect,
  ListSkeleton,
  PersonCell,
  ResultCount,
  SearchBox,
} from "../career/parts";
import {
  distinct,
  DUE_THRESHOLDS,
  dueFiltersActive,
  dueForIncrement,
  filterDue,
  fullName,
  NO_DUE_FILTERS,
  type DueFilters,
  type DueRow,
  type IncrementEmployee,
  type IncrementRecord,
} from "./logic";

type Props = {
  employees: IncrementEmployee[];
  increments: IncrementRecord[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  filters: DueFilters;
  onFilters: (next: DueFilters) => void;
  threshold: number;
  onThreshold: (months: number) => void;
  today: string;
  onApply: (employeeId: number) => void;
};

export default function DueTab({
  employees,
  increments,
  loading,
  failed,
  onRetry,
  filters,
  onFilters,
  threshold,
  onThreshold,
  today,
  onApply,
}: Props) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const due = useMemo(
    () => dueForIncrement(employees, increments, threshold, today),
    [employees, increments, threshold, today],
  );
  const shown = useMemo(() => filterDue(due.rows, filters), [due.rows, filters]);
  const paged = pageOf(shown, page, pageSize);
  const active = dueFiltersActive(filters);
  const update = (patch: Partial<DueFilters>) => {
    onFilters({ ...filters, ...patch });
    setPage(1);
  };
  const asOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));
  const options = useMemo(
    () => ({
      departments: distinct(due.rows.map((r) => r.employee.departmentName)),
      branches: distinct(due.rows.map((r) => r.employee.branchName)),
      types: distinct(due.rows.map((r) => r.employee.employmentType)),
    }),
    [due.rows],
  );

  return (
    <div className="space-y-3 pt-3">
      <div
        className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900"
        data-testid="due-note"
      >
        <Info size={14} className="mt-0.5 shrink-0" />
        <p>
          Active employees with a salary whose last increment, or their joining date if they have never had one, is{" "}
          <b>{monthsLabel(threshold)}</b> or more ago, longest wait first. It is only a prompt to review: no salary
          changes until you open someone and apply an increment.
        </p>
      </div>

      <div className="space-y-3 rounded-2xl border bg-white p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => update({ query })}
            placeholder="Search by name, code, designation or department"
            label="Search employees due for an increment"
            testId="due-search"
          />
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-xs font-medium text-gray-500">Waiting at least</span>
            <Select
              value={String(threshold)}
              onValueChange={(v) => {
                onThreshold(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger
                className="h-10 w-32"
                aria-label="Minimum months since last increment"
                data-testid="due-threshold"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DUE_THRESHOLDS.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {monthsLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex">
          <FilterSelect
            value={filters.department}
            onChange={(department) => update({ department })}
            options={asOptions(options.departments)}
            allLabel="All departments"
            label="Filter by department"
            testId="due-filter-department"
          />
          {options.branches.length > 1 && (
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => update({ branch })}
              options={asOptions(options.branches)}
              allLabel="All branches"
              label="Filter by branch"
              testId="due-filter-branch"
            />
          )}
          <FilterSelect
            value={filters.type}
            onChange={(type) => update({ type })}
            options={options.types.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            allLabel="Staff and production"
            label="Filter by employee type"
            testId="due-filter-type"
          />
          <FilterSelect
            value={filters.basis}
            onChange={(basis) => update({ basis: basis as DueFilters["basis"] })}
            options={[
              { value: "increment", label: "Had an increment" },
              { value: "joining", label: "Never had one" },
            ]}
            allLabel="Had one or not"
            label="Filter by whether they ever had an increment"
            testId="due-filter-basis"
          />
        </div>
        <ResultCount
          shown={shown.length}
          total={due.rows.length}
          noun="employees due"
          filtered={active}
          onClear={() => {
            onFilters(NO_DUE_FILTERS);
            setPage(1);
          }}
          testId="due-count"
        />
        {!loading && (due.unknown > 0 || due.noSalary > 0) && (
          <p className="text-xs text-gray-500" data-testid="due-skipped">
            Left out: {due.noSalary > 0 && `${due.noSalary} with no salary on record`}
            {due.noSalary > 0 && due.unknown > 0 && ", "}
            {due.unknown > 0 && `${due.unknown} with no joining date and no increment on record`}.
          </p>
        )}
      </div>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <ListSkeleton />
          ) : failed ? (
            <ErrorState what="the increment history" onRetry={onRetry} testId="due-error" />
          ) : due.rows.length === 0 ? (
            <EmptyState
              testId="due-empty"
              icon={PartyPopper}
              tone="bg-green-50 text-green-600"
              title="Nobody is due for an increment"
              text={`Every active employee had an increment, or joined, within the last ${monthsLabel(threshold)}. Try a shorter wait.`}
            />
          ) : shown.length === 0 ? (
            <EmptyState
              testId="due-no-match"
              icon={SearchX}
              tone="bg-gray-100 text-gray-500"
              title="No one matches"
              text="Try fewer words, or clear the filters."
              action={
                <Button variant="outline" onClick={() => onFilters(NO_DUE_FILTERS)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid="due-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Employee
                      </TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Salary
                      </TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Waiting since
                      </TableHead>
                      <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.rows.map((r) => (
                      <TableRow key={r.employee.id} data-testid={`due-row-${r.employee.employeeCode}`}>
                        <TableCell className="max-w-[16rem]">
                          <PersonCell
                            name={fullName(r.employee)}
                            code={r.employee.employeeCode}
                            photoUrl={r.employee.photoUrl}
                            sub={
                              [r.employee.designationTitle, r.employee.departmentName].filter(Boolean).join(" · ") ||
                              undefined
                            }
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm font-semibold text-gray-800">
                          {formatMoney(r.employee.salaryAmount ?? 0)}
                          <span className="block text-xs font-normal text-gray-400">
                            {r.employee.salaryType === "weekly" ? "per week" : "per month"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Since row={r} />
                        </TableCell>
                        <TableCell className="text-right">
                          <ApplyButton row={r} onApply={onApply} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="divide-y md:hidden" data-testid="due-cards">
                {paged.rows.map((r) => (
                  <div
                    key={r.employee.id}
                    className="space-y-2.5 p-4"
                    data-testid={`due-card-${r.employee.employeeCode}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <PersonCell
                          name={fullName(r.employee)}
                          code={r.employee.employeeCode}
                          photoUrl={r.employee.photoUrl}
                          sub={
                            [r.employee.designationTitle, r.employee.departmentName].filter(Boolean).join(" · ") ||
                            undefined
                          }
                        />
                      </div>
                      <span className="whitespace-nowrap text-sm font-semibold text-gray-800">
                        {formatMoney(r.employee.salaryAmount ?? 0)}
                      </span>
                    </div>
                    <Since row={r} />
                    <ApplyButton row={r} onApply={onApply} full />
                  </div>
                ))}
              </div>
              <div className="border-t px-4">
                <DataPagination
                  page={paged.page}
                  totalPages={paged.totalPages}
                  onPageChange={setPage}
                  pageSize={pageSize}
                  onPageSizeChange={(n) => {
                    setPageSize(n);
                    setPage(1);
                  }}
                  totalItems={shown.length}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Since({ row }: { row: DueRow }) {
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800">
        <CalendarClock size={14} className="text-amber-500" />
        {tenureLabel(row.months)}
        <Chip
          className={
            row.basis === "increment"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }
        >
          {row.basis === "increment" ? "Last increment" : "Never had one"}
        </Chip>
      </p>
      <p className="text-xs text-gray-500">
        {row.basis === "increment" ? `Increment of +${row.lastPercent}% on` : "Joined"} {formatDate(row.since)}
      </p>
    </div>
  );
}

function ApplyButton({ row, onApply, full }: { row: DueRow; onApply: (id: number) => void; full?: boolean }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className={`gap-1.5 border-green-200 text-green-700 hover:bg-green-50 ${full ? "w-full" : ""}`}
      onClick={() => onApply(row.employee.id)}
      aria-label={`Review ${fullName(row.employee)} for an increment`}
      data-testid={`due-apply-${row.employee.employeeCode}`}
    >
      <TrendingUp size={14} /> Review
    </Button>
  );
}
