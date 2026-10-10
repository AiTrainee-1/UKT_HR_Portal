import { useMemo, useState } from "react";
import { ArrowRight, Download, History, Loader2, Route, SearchX, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { exportSheet, formatMoney, pageOf, type SortDir } from "../career/common";
import { formatDate, PERIOD_OPTIONS, type Period } from "../career/dates";
import {
  EmptyState,
  ErrorState,
  FilterSelect,
  ListSkeleton,
  nextSort,
  PersonCell,
  ResultCount,
  SearchBox,
  SortHead,
} from "../career/parts";
import {
  amountOf,
  BAND_OPTIONS,
  distinct,
  filterIncrements,
  filtersActive,
  NO_FILTERS,
  sortIncrements,
  type Band,
  type HistoryFilters,
  type IncrementRecord,
  type SortKey,
} from "./logic";

type Props = {
  records: IncrementRecord[];
  total: number;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  filters: HistoryFilters;
  onFilters: (next: HistoryFilters) => void;
  onTimeline: (record: IncrementRecord) => void;
  onApply: (employeeId: number) => void;
  today: string;
};

const PHONE_SORTS: { value: string; label: string; key: SortKey; dir: SortDir }[] = [
  { value: "date-desc", label: "Newest first", key: "date", dir: "desc" },
  { value: "date-asc", label: "Oldest first", key: "date", dir: "asc" },
  { value: "employee-asc", label: "Employee A to Z", key: "employee", dir: "asc" },
  { value: "percent-desc", label: "Highest percentage", key: "percent", dir: "desc" },
  { value: "amount-desc", label: "Largest increase", key: "amount", dir: "desc" },
];

export default function HistoryTab({
  records,
  total,
  loading,
  failed,
  onRetry,
  filters,
  onFilters,
  onTimeline,
  onApply,
  today,
}: Props) {
  const { toast } = useToast();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [exporting, setExporting] = useState(false);

  const update = (patch: Partial<HistoryFilters>) => {
    onFilters({ ...filters, ...patch });
    setPage(1);
  };
  const shown = useMemo(
    () => sortIncrements(filterIncrements(records, filters, today), sort.key, sort.dir),
    [records, filters, today, sort],
  );
  const paged = pageOf(shown, page, pageSize);
  const active = filtersActive(filters);
  const options = useMemo(
    () => ({
      departments: distinct(records.map((r) => r.department)),
      designations: distinct(records.map((r) => r.designation)),
      branches: distinct(records.map((r) => r.branchName)),
      types: distinct(records.map((r) => r.employmentType)),
    }),
    [records],
  );
  const asOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));

  const doExport = async () => {
    setExporting(true);
    try {
      await exportSheet({
        filename: "salary-increments",
        title: "Salary increments",
        headers: [
          "Code",
          "Employee",
          "Department",
          "Designation",
          "Branch",
          "Type",
          "Previous salary",
          "New salary",
          "Increase",
          "Percent",
          "Effective date",
          "Recorded by",
          "Notes",
        ],
        rows: shown.map((r) => [
          r.employeeCode,
          r.employeeName,
          r.department,
          r.designation,
          r.branchName,
          r.employmentType,
          r.previousSalary,
          r.newSalary,
          amountOf(r),
          r.percent,
          r.effectiveDate,
          r.addedBy,
          r.notes,
        ]),
        widths: [12, 24, 18, 20, 16, 12, 16, 16, 14, 10, 14, 18, 30],
      });
    } catch {
      toast({ title: "Could not create the Excel file", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3 pt-3">
      <div className="space-y-3 rounded-2xl border bg-white p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => update({ query })}
            placeholder="Search by name, code, department, designation or notes"
            label="Search increments"
            testId="increment-search"
          />
          {/* Exporting only reads and downloads, so it is not one of the buttons a View Only role is locked out of. */}
          <span data-view-safe className="contents">
            <Button
              variant="outline"
              className="h-10 gap-1.5"
              onClick={doExport}
              disabled={exporting || shown.length === 0}
              data-testid="increment-export"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Export to Excel
            </Button>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap">
          <FilterSelect
            value={filters.department}
            onChange={(department) => update({ department })}
            options={asOptions(options.departments)}
            allLabel="All departments"
            label="Filter by department"
            testId="filter-department"
          />
          <FilterSelect
            value={filters.designation}
            onChange={(designation) => update({ designation })}
            options={asOptions(options.designations)}
            allLabel="All designations"
            label="Filter by designation"
            testId="filter-designation"
          />
          {options.branches.length > 1 && (
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => update({ branch })}
              options={asOptions(options.branches)}
              allLabel="All branches"
              label="Filter by branch"
              testId="filter-branch"
            />
          )}
          <FilterSelect
            value={filters.type}
            onChange={(type) => update({ type })}
            options={options.types.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            allLabel="Staff and production"
            label="Filter by employee type"
            testId="filter-type"
          />
          <FilterSelect
            value={filters.band}
            onChange={(band) => update({ band: band as Band })}
            options={BAND_OPTIONS}
            allLabel="Any percentage"
            label="Filter by increment percentage"
            testId="filter-band"
          />
          <Select value={filters.period} onValueChange={(v) => update({ period: v as Period })}>
            <SelectTrigger className="h-10 lg:w-44" aria-label="Filter by period" data-testid="filter-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filters.period === "custom" && (
            <div className="col-span-2 flex items-center gap-2 sm:col-span-3 lg:col-span-1">
              <Input
                type="date"
                className="h-10"
                aria-label="From date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(e) => update({ from: e.target.value })}
                data-testid="filter-from"
              />
              <span className="text-xs text-gray-400">to</span>
              <Input
                type="date"
                className="h-10"
                aria-label="To date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(e) => update({ to: e.target.value })}
                data-testid="filter-to"
              />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ResultCount
            shown={shown.length}
            total={records.length}
            noun="increments"
            filtered={active}
            onClear={() => {
              onFilters(NO_FILTERS);
              setPage(1);
            }}
            testId="increment-count"
          />
          <div className="md:hidden">
            <Select
              value={`${sort.key}-${sort.dir}`}
              onValueChange={(v) => {
                const s = PHONE_SORTS.find((x) => x.value === v);
                if (s) setSort({ key: s.key, dir: s.dir });
              }}
            >
              <SelectTrigger className="h-9 w-48" aria-label="Sort increments">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PHONE_SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {total > records.length && (
          <p className="text-xs text-amber-700" data-testid="increment-truncated">
            Only the newest {records.length.toLocaleString()} of {total.toLocaleString()} increments are loaded. Filter
            by period to narrow it down.
          </p>
        )}
      </div>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <ListSkeleton />
          ) : failed ? (
            <ErrorState what="the increment history" onRetry={onRetry} testId="increment-error" />
          ) : records.length === 0 ? (
            <EmptyState
              testId="increment-history-empty"
              icon={History}
              tone="bg-green-50 text-green-600"
              title="No increments recorded yet"
              text="Increments you apply appear here, with the salary before and after, the percentage and who recorded them."
            />
          ) : shown.length === 0 ? (
            <EmptyState
              testId="increment-no-match"
              icon={SearchX}
              tone="bg-gray-100 text-gray-500"
              title="No increment matches"
              text="Try fewer words, or clear the filters."
              action={
                <Button variant="outline" onClick={() => onFilters(NO_FILTERS)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid="increment-table">
                  <TableHeader>
                    <TableRow>
                      <SortHead
                        label="Employee"
                        column="employee"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k))}
                      />
                      <SortHead
                        label="Salary"
                        column="salary"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k, "desc"))}
                      />
                      <SortHead
                        label="Increase"
                        column="percent"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k, "desc"))}
                      />
                      <SortHead
                        label="Effective"
                        column="date"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k, "desc"))}
                      />
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Recorded by
                      </TableHead>
                      <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.rows.map((r) => (
                      <TableRow key={r.id} data-testid={`increment-row-${r.id}`}>
                        <TableCell className="max-w-[16rem]">
                          <PersonCell
                            name={r.employeeName}
                            code={r.employeeCode}
                            sub={[r.designation, r.department].filter(Boolean).join(" · ") || undefined}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <span className="text-gray-500">{formatMoney(r.previousSalary)}</span>
                          <ArrowRight size={12} className="mx-1.5 inline text-green-500" aria-label="became" />
                          <span className="font-semibold text-gray-900">{formatMoney(r.newSalary)}</span>
                          {r.notes && (
                            <span className="block max-w-[16rem] truncate text-xs text-gray-400">{r.notes}</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="font-black text-green-600">+{r.percent}%</span>
                          <span className="ml-2 text-xs font-semibold text-green-700/70">
                            +{formatMoney(amountOf(r))}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm font-semibold text-gray-700">
                          {formatDate(r.effectiveDate)}
                        </TableCell>
                        <TableCell className="text-xs text-gray-500">{r.addedBy ?? "-"}</TableCell>
                        <TableCell className="text-right">
                          <RowActions r={r} onTimeline={onTimeline} onApply={onApply} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="divide-y md:hidden" data-testid="increment-cards">
                {paged.rows.map((r) => (
                  <div key={r.id} className="space-y-2.5 p-4" data-testid={`increment-card-${r.id}`}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <PersonCell
                          name={r.employeeName}
                          code={r.employeeCode}
                          sub={[r.designation, r.department].filter(Boolean).join(" · ") || undefined}
                        />
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-black text-green-600">+{r.percent}%</p>
                        <p className="text-[11px] text-gray-500">{formatDate(r.effectiveDate)}</p>
                      </div>
                    </div>
                    <p className="text-sm">
                      <span className="text-gray-500">{formatMoney(r.previousSalary)}</span>
                      <ArrowRight size={12} className="mx-1.5 inline text-green-500" aria-label="became" />
                      <span className="font-semibold text-gray-900">{formatMoney(r.newSalary)}</span>
                      <span className="ml-2 text-xs font-semibold text-green-700/70">+{formatMoney(amountOf(r))}</span>
                    </p>
                    {r.notes && <p className="text-xs text-gray-500">{r.notes}</p>}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{r.addedBy ? `by ${r.addedBy}` : ""}</span>
                      <RowActions r={r} onTimeline={onTimeline} onApply={onApply} />
                    </div>
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

function RowActions({
  r,
  onTimeline,
  onApply,
}: {
  r: IncrementRecord;
  onTimeline: (r: IncrementRecord) => void;
  onApply: (employeeId: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onTimeline(r)}
        title="Salary history"
        aria-label={`Salary history of ${r.employeeName}`}
        data-testid={`increment-timeline-${r.id}`}
      >
        <Route size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onApply(r.employeeId)}
        title="Give another increment"
        aria-label={`Give ${r.employeeName} another increment`}
        data-testid={`increment-again-${r.id}`}
      >
        <TrendingUp size={15} className="text-green-600" />
      </Button>
    </div>
  );
}
