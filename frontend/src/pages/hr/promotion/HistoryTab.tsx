import { useMemo, useState } from "react";
import { Download, History, Loader2, Route, SearchX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { exportSheet, pageOf, type SortDir } from "../career/common";
import { formatDate, PERIOD_OPTIONS, type Period } from "../career/dates";
import {
  Chip,
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
  distinct,
  filterPromotions,
  filtersActive,
  KIND_LABEL,
  NO_FILTERS,
  promotionKind,
  sortPromotions,
  type HistoryFilters,
  type PromotionKind,
  type PromotionRecord,
  type SortKey,
} from "./logic";
import { MoveLine } from "./Timeline";

type Props = {
  records: PromotionRecord[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  filters: HistoryFilters;
  onFilters: (next: HistoryFilters) => void;
  onTimeline: (record: PromotionRecord) => void;
  onDeleteRequest: (record: PromotionRecord) => void;
  today: string;
  /** The server cut the list: there are more promotions than were asked for. */
  truncated: boolean;
};

const KIND_CHIP: Record<PromotionKind, string> = {
  designation: "border-emerald-200 bg-emerald-50 text-emerald-700",
  department: "border-indigo-200 bg-indigo-50 text-indigo-700",
  both: "border-violet-200 bg-violet-50 text-violet-700",
};

const PHONE_SORTS: { value: string; label: string; key: SortKey; dir: SortDir }[] = [
  { value: "date-desc", label: "Newest first", key: "date", dir: "desc" },
  { value: "date-asc", label: "Oldest first", key: "date", dir: "asc" },
  { value: "employee-asc", label: "Employee A to Z", key: "employee", dir: "asc" },
  { value: "designation-asc", label: "Designation A to Z", key: "designation", dir: "asc" },
];

export default function HistoryTab({
  records,
  loading,
  failed,
  onRetry,
  filters,
  onFilters,
  onTimeline,
  onDeleteRequest,
  today,
  truncated,
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
    () => sortPromotions(filterPromotions(records, filters, today), sort.key, sort.dir),
    [records, filters, today, sort],
  );
  const paged = pageOf(shown, page, pageSize);
  const active = filtersActive(filters);

  const options = useMemo(
    () => ({
      departments: distinct(records.flatMap((p) => [p.previousDepartment, p.newDepartment])),
      designations: distinct(records.map((p) => p.newDesignation)),
      branches: distinct(records.map((p) => p.branchName)),
      types: distinct(records.map((p) => p.employmentType)),
    }),
    [records],
  );
  const asOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));

  const doExport = async () => {
    setExporting(true);
    try {
      await exportSheet({
        filename: "promotions",
        title: "Promotions",
        headers: [
          "Code",
          "Employee",
          "Branch",
          "Type",
          "Previous designation",
          "Previous department",
          "New designation",
          "New department",
          "Effective date",
          "Recorded by",
          "Notes",
        ],
        rows: shown.map((p) => [
          p.employeeCode,
          p.employeeName,
          p.branchName,
          p.employmentType,
          p.previousDesignation,
          p.previousDepartment,
          p.newDesignation,
          p.newDepartment,
          p.effectiveDate,
          p.promotedBy,
          p.notes,
        ]),
        widths: [12, 24, 16, 12, 22, 20, 22, 20, 14, 18, 30],
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
            placeholder="Search by name, code, designation, department or notes"
            label="Search promotions"
            testId="promotion-search"
          />
          {/* Exporting only reads and downloads, so it is not one of the buttons a View Only role is locked out of. */}
          <span data-view-safe className="contents">
            <Button
              variant="outline"
              className="h-10 gap-1.5"
              onClick={doExport}
              disabled={exporting || shown.length === 0}
              data-testid="promotion-export"
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
            allLabel="Promoted to: any"
            label="Filter by the designation promoted to"
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
            value={filters.kind}
            onChange={(kind) => update({ kind: kind as HistoryFilters["kind"] })}
            options={(Object.keys(KIND_LABEL) as PromotionKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            allLabel="Any kind of change"
            label="Filter by kind of change"
            testId="filter-kind"
            className="lg:w-52"
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
            noun="promotions"
            filtered={active}
            onClear={() => {
              onFilters(NO_FILTERS);
              setPage(1);
            }}
            testId="promotion-count"
          />
          <div className="md:hidden">
            <Select
              value={`${sort.key}-${sort.dir}`}
              onValueChange={(v) => {
                const s = PHONE_SORTS.find((x) => x.value === v);
                if (s) setSort({ key: s.key, dir: s.dir });
              }}
            >
              <SelectTrigger className="h-9 w-44" aria-label="Sort promotions">
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
        {truncated && (
          <p className="text-xs text-amber-700" data-testid="promotion-truncated">
            Only the newest {records.length.toLocaleString()} promotions are loaded. Filter by period to narrow it down.
          </p>
        )}
      </div>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <ListSkeleton />
          ) : failed ? (
            <ErrorState what="the promotion history" onRetry={onRetry} testId="promotion-error" />
          ) : records.length === 0 ? (
            <EmptyState
              testId="promotion-history-empty"
              icon={History}
              title="No promotions recorded yet"
              text="Promotions you make appear here, with the position before and after, who recorded them and when."
            />
          ) : shown.length === 0 ? (
            <EmptyState
              testId="promotion-no-match"
              icon={SearchX}
              tone="bg-gray-100 text-gray-500"
              title="No promotion matches"
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
                <Table data-testid="promotion-table">
                  <TableHeader>
                    <TableRow>
                      <SortHead
                        label="Employee"
                        column="employee"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k))}
                      />
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Change
                      </TableHead>
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
                    {paged.rows.map((p) => (
                      <TableRow key={p.id} data-testid={`promotion-row-${p.id}`}>
                        <TableCell className="max-w-[16rem]">
                          <PersonCell
                            name={p.employeeName}
                            code={p.employeeCode}
                            sub={[p.branchName, p.employmentType].filter(Boolean).join(" · ") || undefined}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <MoveLine p={p} />
                            <div className="flex flex-wrap items-center gap-2">
                              <Chip className={KIND_CHIP[promotionKind(p)]}>{KIND_LABEL[promotionKind(p)]}</Chip>
                              {p.notes && (
                                <span className="max-w-[18rem] truncate text-xs text-gray-500">{p.notes}</span>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm font-semibold text-gray-700">
                          {formatDate(p.effectiveDate)}
                        </TableCell>
                        <TableCell className="text-xs text-gray-500">{p.promotedBy ?? "-"}</TableCell>
                        <TableCell className="text-right">
                          <RowActions p={p} onTimeline={onTimeline} onDelete={onDeleteRequest} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="divide-y md:hidden" data-testid="promotion-cards">
                {paged.rows.map((p) => (
                  <div key={p.id} className="space-y-2.5 p-4" data-testid={`promotion-card-${p.id}`}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <PersonCell name={p.employeeName} code={p.employeeCode} />
                      </div>
                      <span className="whitespace-nowrap text-xs font-semibold text-gray-600">
                        {formatDate(p.effectiveDate)}
                      </span>
                    </div>
                    <MoveLine p={p} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip className={KIND_CHIP[promotionKind(p)]}>{KIND_LABEL[promotionKind(p)]}</Chip>
                      {p.promotedBy && <span className="text-[11px] text-gray-400">by {p.promotedBy}</span>}
                    </div>
                    {p.notes && <p className="text-xs text-gray-500">{p.notes}</p>}
                    <div className="flex justify-end">
                      <RowActions p={p} onTimeline={onTimeline} onDelete={onDeleteRequest} />
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
  p,
  onTimeline,
  onDelete,
}: {
  p: PromotionRecord;
  onTimeline: (p: PromotionRecord) => void;
  onDelete: (p: PromotionRecord) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onTimeline(p)}
        title="Career timeline"
        aria-label={`Career timeline of ${p.employeeName}`}
        data-testid={`promotion-timeline-${p.id}`}
      >
        <Route size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDelete(p)}
        title="Delete record"
        aria-label={`Delete the promotion record of ${p.employeeName}`}
        data-testid={`promotion-delete-${p.id}`}
      >
        <Trash2 size={15} className="text-red-500" />
      </Button>
    </div>
  );
}
