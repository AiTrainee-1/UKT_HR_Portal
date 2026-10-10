import { useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, Download, FileWarning, FolderCheck, Loader2, SearchX, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataPagination } from "@/components/ui/DataPagination";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import type { Employee } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { distinct, exportSheet, matchesWords, pageOf, type SortDir } from "../career/common";
import {
  Chip,
  EmptyState,
  ErrorState,
  FilterSelect,
  ListSkeleton,
  nextSort,
  ResultCount,
  SearchBox,
  SortHead,
  StatCard,
} from "../career/parts";
import {
  filterTracker,
  filtersActive,
  missingOptions,
  NO_DEPARTMENT,
  NO_FILTERS,
  sortTracker,
  summarizeTracker,
  type SortKey,
  type TrackerFilters,
  type TrackerRow,
} from "./logic";

type Props = {
  /** "staff" or "production". */
  kind: "staff" | "production";
  rows: TrackerRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  filters: TrackerFilters;
  onFilters: (next: TrackerFilters) => void;
  /** Every employee, to find people the tracker does not list (inactive ones). */
  everyone: Employee[];
  onOpen: (employeeId: number, docTab?: "letters" | "extra") => void;
};

const PHONE_SORTS: { value: string; label: string; key: SortKey; dir: SortDir }[] = [
  { value: "name-asc", label: "Name A to Z", key: "name", dir: "asc" },
  { value: "name-desc", label: "Name Z to A", key: "name", dir: "desc" },
  { value: "documents-asc", label: "Fewest documents first", key: "documents", dir: "asc" },
  { value: "code-asc", label: "Employee code", key: "code", dir: "asc" },
];

function Initial({ name, tone }: { name: string; tone: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-xs font-bold text-white",
        tone,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function Progress({ row }: { row: TrackerRow }) {
  return (
    <div className="min-w-[10rem] space-y-1.5" data-testid={`progress-${row.employeeCode}`}>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100" aria-hidden>
          <div
            className={cn("h-full rounded-full", row.status === "complete" ? "bg-emerald-500" : "bg-amber-400")}
            style={{ width: `${(row.present / row.required) * 100}%` }}
          />
        </div>
        <span className="whitespace-nowrap text-xs font-semibold text-gray-600">
          {row.present} of {row.required}
        </span>
      </div>
      {row.status === "complete" ? (
        <Chip className="border-emerald-200 bg-emerald-50 text-emerald-700">
          <CheckCircle2 size={11} /> Complete
        </Chip>
      ) : (
        <div className="flex flex-wrap gap-1" title={row.missing.map((m) => m.label).join(", ")}>
          {row.missing.slice(0, 2).map((m) => (
            <Chip key={m.value} className="border-amber-200 bg-amber-50 text-amber-700">
              {m.label}
            </Chip>
          ))}
          {row.missing.length > 2 && (
            <Chip className="border-gray-200 bg-gray-50 text-gray-500">+{row.missing.length - 2} more</Chip>
          )}
        </div>
      )}
    </div>
  );
}

export default function TrackerView({
  kind,
  rows,
  loading,
  failed,
  onRetry,
  filters,
  onFilters,
  everyone,
  onOpen,
}: Props) {
  const { toast } = useToast();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [exporting, setExporting] = useState(false);

  const update = (patch: Partial<TrackerFilters>) => {
    onFilters({ ...filters, ...patch });
    setPage(1);
  };
  const summary = useMemo(() => summarizeTracker(rows), [rows]);
  const shown = useMemo(() => sortTracker(filterTracker(rows, filters), sort.key, sort.dir), [rows, filters, sort]);
  const paged = pageOf(shown, page, pageSize);
  const active = filtersActive(filters);
  const departments = useMemo(() => distinct(rows.map((r) => r.departmentName)), [rows]);
  const hasNoDepartment = useMemo(() => rows.some((r) => !r.departmentName), [rows]);
  const missing = useMemo(() => missingOptions(rows), [rows]);

  // People who match the search but are not in the tracker (it lists active employees): shown beneath, so a search
  // still finds anyone, as it always did.
  const others = useMemo(() => {
    if (!filters.query.trim()) return [];
    const listed = new Set(rows.map((r) => r.id));
    return everyone
      .filter((e) => !listed.has(e.id) && (e.employmentType === "production" ? "production" : "staff") === kind)
      .filter((e) =>
        matchesWords(
          filters.query,
          e.firstName,
          e.lastName,
          `${e.firstName} ${e.lastName}`,
          e.employeeCode,
          e.departmentName,
        ),
      )
      .slice(0, 8);
  }, [everyone, rows, filters.query, kind]);

  const doExport = async () => {
    setExporting(true);
    try {
      await exportSheet({
        filename: `documents-${kind}`,
        title: `${kind === "production" ? "Production" : "Staff"} documents`,
        headers: ["Code", "Employee", "Department", "Status", "On file", "Required", "Missing documents"],
        rows: shown.map((r) => [
          r.employeeCode,
          r.name,
          r.departmentName,
          r.status === "complete" ? "Complete" : "Pending",
          r.present,
          r.required,
          r.missing.map((m) => m.label).join(", "),
        ]),
        widths: [12, 26, 20, 12, 10, 10, 60],
      });
    } catch {
      toast({ title: "Could not create the Excel file", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const statButton = (testId: string, on: boolean, ring: string, onClick: () => void, card: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      className={cn("rounded-2xl text-left transition-shadow hover:shadow-md", on && `ring-2 ${ring}`)}
    >
      {card}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          testId="stat-total"
          label={`${kind === "production" ? "Production" : "Staff"} employees`}
          value={summary.total}
          sub="active, with documents tracked"
          icon={Users}
          tone="bg-slate-100 text-slate-800"
          loading={loading}
        />
        {statButton(
          "stat-complete-button",
          filters.status === "complete",
          "ring-emerald-400",
          () => update({ status: filters.status === "complete" ? "all" : "complete" }),
          <StatCard
            testId="stat-complete"
            label="All documents on file"
            value={summary.complete}
            sub={`${summary.percent}% complete`}
            icon={FolderCheck}
            tone="bg-emerald-50 text-emerald-800"
            loading={loading}
          />,
        )}
        {statButton(
          "stat-pending-button",
          filters.status === "pending",
          "ring-amber-400",
          () => update({ status: filters.status === "pending" ? "all" : "pending" }),
          <StatCard
            testId="stat-pending"
            label="Documents pending"
            value={summary.pending}
            sub={`${summary.missingFiles} file${summary.missingFiles === 1 ? "" : "s"} missing in all`}
            icon={FileWarning}
            tone="bg-amber-50 text-amber-800"
            loading={loading}
          />,
        )}
        {statButton(
          "stat-most-missing-button",
          !!summary.mostMissing && filters.missing === summary.mostMissing.value,
          "ring-rose-300",
          () =>
            summary.mostMissing &&
            update({ missing: filters.missing === summary.mostMissing.value ? "all" : summary.mostMissing.value }),
          <StatCard
            testId="stat-most-missing"
            label="Most often missing"
            value={summary.mostMissing ? summary.mostMissing.count : "-"}
            sub={summary.mostMissing ? summary.mostMissing.label : "nothing is missing"}
            icon={FileWarning}
            tone="bg-rose-50 text-rose-800"
            loading={loading}
          />,
        )}
      </div>

      <div className="space-y-3 rounded-2xl border bg-white p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => update({ query })}
            placeholder="Search by employee code, name or department"
            label="Search employees"
            testId="documents-search"
          />
          {/* Exporting only reads and downloads, so it is not one of the buttons a View Only role is locked out of. */}
          <span data-view-safe className="contents">
            <Button
              variant="outline"
              className="h-10 gap-1.5"
              onClick={doExport}
              disabled={exporting || shown.length === 0}
              data-testid="documents-export"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Export to Excel
            </Button>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <FilterSelect
            value={filters.department}
            onChange={(department) => update({ department })}
            options={[
              ...(hasNoDepartment ? [{ value: NO_DEPARTMENT, label: "No department" }] : []),
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
            allLabel="All departments"
            label="Filter by department"
            testId="filter-department"
          />
          <FilterSelect
            value={filters.missing}
            onChange={(m) => update({ missing: m })}
            options={missing.map((m) => ({ value: m.value, label: `${m.label} (${m.count})` }))}
            allLabel="Any missing document"
            label="Filter by a missing document"
            testId="filter-missing"
            className="lg:w-60"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs
            size="sm"
            items={[
              { value: "all", label: "All", count: summary.total },
              { value: "complete", label: "Complete", count: summary.complete },
              { value: "pending", label: "Pending", count: summary.pending },
            ]}
            value={filters.status}
            onChange={(v) => update({ status: v as TrackerFilters["status"] })}
          />
          <div className="flex items-center gap-3">
            <ResultCount
              shown={shown.length}
              total={rows.length}
              noun="employees"
              filtered={active}
              onClear={() => {
                onFilters(NO_FILTERS);
                setPage(1);
              }}
              testId="documents-count"
            />
            <div className="md:hidden">
              <Select
                value={`${sort.key}-${sort.dir}`}
                onValueChange={(v) => {
                  const s = PHONE_SORTS.find((x) => x.value === v);
                  if (s) setSort({ key: s.key, dir: s.dir });
                }}
              >
                <SelectTrigger className="h-9 w-44" aria-label="Sort employees">
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
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <ListSkeleton />
          ) : failed ? (
            <ErrorState what="the document tracker" onRetry={onRetry} testId="documents-error" />
          ) : rows.length === 0 ? (
            <EmptyState
              testId="documents-empty"
              icon={Users}
              title={`No active ${kind} employees yet`}
              text={`${kind === "production" ? "Production" : "Staff"} employees appear here once they are added, with the documents they still owe.`}
            />
          ) : shown.length === 0 ? (
            <EmptyState
              testId="documents-no-match"
              icon={
                filters.status === "pending" &&
                !filters.query &&
                filters.department === "all" &&
                filters.missing === "all"
                  ? CheckCircle2
                  : SearchX
              }
              tone={
                filters.status === "pending" && !filters.query
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-gray-100 text-gray-500"
              }
              title={
                filters.status === "pending" &&
                !filters.query &&
                filters.department === "all" &&
                filters.missing === "all"
                  ? `Every ${kind} employee has all required documents`
                  : "No employee matches"
              }
              text={
                filters.status === "pending" &&
                !filters.query &&
                filters.department === "all" &&
                filters.missing === "all"
                  ? undefined
                  : "Try fewer words, or clear the filters."
              }
              action={
                active ? (
                  <Button variant="outline" onClick={() => onFilters(NO_FILTERS)}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid="documents-table">
                  <TableHeader>
                    <TableRow>
                      <SortHead label="Employee" column="name" sort={sort} onSort={(k) => setSort(nextSort(sort, k))} />
                      <SortHead
                        label="Department"
                        column="department"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k))}
                      />
                      <SortHead
                        label="Documents"
                        column="documents"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k))}
                      />
                      <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.rows.map((r) => (
                      <TableRow key={r.id} data-testid={`tracker-row-${r.employeeCode}`}>
                        <TableCell className="max-w-[16rem]">
                          <button
                            type="button"
                            className="flex min-w-0 items-center gap-3 text-left"
                            onClick={() => onOpen(r.id, r.status === "pending" ? "extra" : "letters")}
                            aria-label={`Open the documents of ${r.name}`}
                          >
                            <Initial
                              name={r.name}
                              tone={
                                r.status === "complete"
                                  ? "from-emerald-400 to-teal-500"
                                  : "from-amber-400 to-orange-500"
                              }
                            />
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-gray-900">{r.name}</span>
                              <span className="block font-mono text-xs text-gray-400">{r.employeeCode}</span>
                            </span>
                          </button>
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">
                          {r.departmentName ?? <span className="text-gray-300">-</span>}
                        </TableCell>
                        <TableCell>
                          <Progress row={r} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            onClick={() => onOpen(r.id, r.status === "pending" ? "extra" : "letters")}
                            data-testid={`open-${r.employeeCode}`}
                          >
                            Open <ChevronRight size={14} />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="divide-y md:hidden" data-testid="documents-cards">
                {paged.rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onOpen(r.id, r.status === "pending" ? "extra" : "letters")}
                    className="block w-full space-y-2.5 p-4 text-left"
                    data-testid={`tracker-card-${r.employeeCode}`}
                  >
                    <span className="flex items-center gap-3">
                      <Initial
                        name={r.name}
                        tone={r.status === "complete" ? "from-emerald-400 to-teal-500" : "from-amber-400 to-orange-500"}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-gray-900">{r.name}</span>
                        <span className="block truncate text-xs text-gray-400">
                          <span className="font-mono">{r.employeeCode}</span>
                          {r.departmentName ? ` · ${r.departmentName}` : ""}
                        </span>
                      </span>
                      <ChevronRight size={16} className="shrink-0 text-gray-300" />
                    </span>
                    <Progress row={r} />
                  </button>
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

      {others.length > 0 && (
        <Card className="rounded-2xl" data-testid="other-matches">
          <CardContent className="space-y-2 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Also found (not in the tracker above)
            </p>
            {others.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpen(e.id)}
                className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-gray-50"
                data-testid={`other-${e.employeeCode}`}
              >
                <Initial name={e.firstName} tone="from-indigo-500 to-blue-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-gray-900">
                    {e.firstName} {e.lastName}
                  </span>
                  <span className="block text-xs text-gray-400">
                    {e.employeeCode}
                    {e.departmentName ? ` · ${e.departmentName}` : ""}
                  </span>
                </span>
                <Chip className="border-gray-200 bg-gray-100 capitalize text-gray-600">{e.status}</Chip>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
