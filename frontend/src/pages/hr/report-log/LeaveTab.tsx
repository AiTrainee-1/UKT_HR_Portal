import { useMemo, useState } from "react";
import { CheckCircle2, HelpCircle, UserX, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAttendanceReportDaily, useSetDayInformed, type ReportLogDailyRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip, EmptyState, ErrorState, ListSkeleton, ResultLine, StatCard } from "../leave/parts";
import DailyFiltersBar, { departmentParam, type DailyFilters } from "./DailyFilters";
import ExportBar, { useSheetExport } from "./ExportBar";
import ReportSheet from "./ReportSheet";
import { absentRows, dash, filterByInformed, formatDMY, informedValue, type InformedFilter } from "./logic";
import { leaveSpec } from "./sheets";
import { useCompany } from "./useCompany";

const INFORMED_FILTER_LABELS: Record<InformedFilter, string> = {
  all: "Informed: All",
  informed: "Informed only",
  not_informed: "Not informed only",
  unset: "Unset only",
};

const INFORMED_TONE: Record<"informed" | "not_informed" | "unset", string> = {
  informed: "border-green-200 bg-green-100 text-green-800",
  not_informed: "border-amber-200 bg-amber-100 text-amber-800",
  unset: "border-gray-200 bg-gray-50 text-gray-600",
};

/**
 * Daily Leave Report (it was called Daily Report): the staff who were absent on one date, the Informed / Not informed call for
 * each, and Excel / PDF / Image of the list as the paper "STAFF LEAVE LIST" (unit blocks HO / U-1 / U-2, a Remarks column).
 *
 * Absent-only, deliberately: HR makes it around 10-11 AM, by which point anyone Late has already punched in (present) and
 * anyone on approved leave is already on file; what is left, and needs a human call, is who simply did not show up.
 */
export default function LeaveTab({
  filters,
  onFilters,
}: {
  filters: DailyFilters;
  onFilters: (next: DailyFilters) => void;
}) {
  const { toast } = useToast();
  const company = useCompany();
  const [informedFilter, setInformedFilter] = useState<InformedFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const query = useAttendanceReportDaily({
    date: filters.date,
    department: departmentParam(filters.department),
    search: filters.search || undefined,
  });
  const setInformed = useSetDayInformed();

  const absent = useMemo(() => absentRows(query.data?.rows ?? []), [query.data]);
  const shown = useMemo(() => filterByInformed(absent, informedFilter), [absent, informedFilter]);
  const counts = useMemo(
    () => ({
      informed: absent.filter((r) => r.isInformed === true).length,
      notInformed: absent.filter((r) => r.isInformed === false).length,
      unset: absent.filter((r) => r.isInformed == null).length,
    }),
    [absent],
  );

  // what gets downloaded: the rows ticked AND still on the list (a row hidden by a filter is not exported)
  const picked = useMemo(() => shown.filter((r) => selected.has(r.employeeId)), [shown, selected]);
  const allShownPicked = shown.length > 0 && picked.length === shown.length;

  const spec = useMemo(() => leaveSpec(filters.date, picked), [filters.date, picked]);
  const exporter = useSheetExport(spec, company.excel);

  const changeFilters = (next: DailyFilters) => {
    if (next.date !== filters.date) setSelected(new Set());
    onFilters(next);
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of shown) {
        if (allShownPicked) next.delete(r.employeeId);
        else next.add(r.employeeId);
      }
      return next;
    });

  const decide = async (row: ReportLogDailyRow, value: "informed" | "not_informed" | "unset") => {
    try {
      await setInformed.mutateAsync({
        employeeId: row.employeeId,
        date: filters.date,
        isInformed: value === "informed" ? true : value === "not_informed" ? false : null,
      });
    } catch {
      toast({ title: "Failed to update Informed status", variant: "destructive" });
    }
  };

  const focus = (next: InformedFilter) => setInformedFilter((cur) => (cur === next ? "all" : next));
  const hasData = !!query.data;
  const niceDate = formatDMY(filters.date);

  return (
    <div className="space-y-4" data-testid="leave-tab">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="leave-figures">
        <StatCard
          label={`Absent on ${niceDate}`}
          value={hasData ? absent.length : "-"}
          sub="Staff with no punch and no leave"
          icon={UserX}
          tone="bg-rose-50 text-rose-800"
          onClick={() => setInformedFilter("all")}
          active={informedFilter === "all"}
          testId="figure-absent"
        />
        <StatCard
          label="Informed"
          value={hasData ? counts.informed : "-"}
          sub="Told HR beforehand"
          icon={CheckCircle2}
          tone="bg-green-50 text-green-800"
          onClick={() => focus("informed")}
          active={informedFilter === "informed"}
          testId="figure-informed"
        />
        <StatCard
          label="Not informed"
          value={hasData ? counts.notInformed : "-"}
          sub="Absent without telling anyone"
          icon={XCircle}
          tone="bg-amber-50 text-amber-800"
          onClick={() => focus("not_informed")}
          active={informedFilter === "not_informed"}
          testId="figure-not-informed"
        />
        <StatCard
          label="Not marked yet"
          value={hasData ? counts.unset : "-"}
          sub="HR has not made the call"
          icon={HelpCircle}
          tone="bg-slate-50 text-slate-700"
          onClick={() => focus("unset")}
          active={informedFilter === "unset"}
          testId="figure-unset"
        />
      </div>

      <DailyFiltersBar filters={filters} onChange={changeFilters} testId="leave-filters">
        <Select value={informedFilter} onValueChange={(v) => setInformedFilter(v as InformedFilter)}>
          <SelectTrigger
            className="h-10 w-full sm:w-48"
            aria-label="Filter by Informed status"
            data-testid="informed-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(INFORMED_FILTER_LABELS) as InformedFilter[]).map((k) => (
              <SelectItem key={k} value={k}>
                {INFORMED_FILTER_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span className="text-xs text-gray-500" data-testid="selected-count">
            <b>{picked.length}</b> selected
          </span>
          <ExportBar
            busy={exporter.busy}
            onExport={exporter.run}
            disabled={picked.length === 0}
            disabledHint="Tick the employees to put on the list first"
          />
        </div>
      </DailyFiltersBar>

      {hasData && (
        <ResultLine
          shown={shown.length}
          total={absent.length}
          noun="absent employees"
          active={informedFilter !== "all"}
          onClear={() => setInformedFilter("all")}
          testId="leave-result-line"
        />
      )}

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {query.isError && !hasData ? (
            <ErrorState what="the daily report" onRetry={() => void query.refetch()} />
          ) : !hasData ? (
            <ListSkeleton testId="leave-loading" />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={UserX}
              tone="bg-green-50 text-green-600"
              title={absent.length > 0 ? "No one matches this filter" : `No one was absent on ${niceDate}`}
              text={
                absent.length > 0
                  ? "Change the Informed filter to see the other absent employees."
                  : "Everyone on the roll punched in, is on leave or the day is a holiday."
              }
              testId="leave-empty"
            />
          ) : (
            <Table data-testid="leave-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-4">
                    <Checkbox
                      checked={allShownPicked}
                      onCheckedChange={toggleAll}
                      aria-label="Select all employees shown"
                      data-testid="select-all"
                    />
                  </TableHead>
                  <TableHead>Ticket No</TableHead>
                  <TableHead>Employee Name</TableHead>
                  <TableHead className="hidden md:table-cell">Department</TableHead>
                  <TableHead className="hidden lg:table-cell">Designation</TableHead>
                  <TableHead className="hidden sm:table-cell">Unit</TableHead>
                  <TableHead className="pr-4">Informed Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => {
                  const value = informedValue(row);
                  return (
                    <TableRow key={row.employeeId} data-testid={`leave-row-${row.employeeId}`}>
                      <TableCell className="pl-4">
                        <Checkbox
                          checked={selected.has(row.employeeId)}
                          onCheckedChange={() => toggle(row.employeeId)}
                          aria-label={`Select ${row.employeeName}`}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-gray-600">
                        {row.employeeCode}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm font-semibold text-gray-900">
                        {row.employeeName}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-sm text-gray-600 md:table-cell">
                        {dash(row.department)}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-sm text-gray-600 lg:table-cell">
                        {dash(row.designation)}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {row.unitLabel ? (
                          <Chip className="border-teal-200 bg-teal-50 font-mono text-teal-700">{row.unitLabel}</Chip>
                        ) : (
                          <span className="text-xs text-gray-400">{"—"}</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4">
                        <Select
                          value={value}
                          onValueChange={(v) => void decide(row, v as typeof value)}
                          disabled={setInformed.isPending}
                        >
                          <SelectTrigger
                            className={cn("h-8 w-28 text-xs font-semibold sm:w-36", INFORMED_TONE[value])}
                            aria-label={`Informed status of ${row.employeeName}`}
                            data-testid={`informed-${row.employeeId}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="unset">Unset</SelectItem>
                            <SelectItem value="informed">Informed</SelectItem>
                            <SelectItem value="not_informed">Not informed</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* The off-screen copy the PDF and the picture are taken from (display:none would give html2canvas nothing to draw);
          the Excel file is built from the same spec. It is the list as it will be exported: only the rows ticked. */}
      <div style={{ position: "fixed", left: -99999, top: 0, zIndex: -1 }} aria-hidden="true">
        <ReportSheet ref={exporter.sheetRef} spec={spec} company={company.sheet} />
      </div>
    </div>
  );
}
