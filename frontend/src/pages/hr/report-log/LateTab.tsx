import { useMemo } from "react";
import { AlarmClock, Building2, Clock, Info, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAttendanceReportDaily } from "@/lib/api-client/custom-hooks";
import { Chip, EmptyState, ErrorState, ListSkeleton, StatCard } from "../leave/parts";
import DailyFiltersBar, { departmentParam, type DailyFilters } from "./DailyFilters";
import ExportBar, { useSheetExport } from "./ExportBar";
import ReportSheet from "./ReportSheet";
import { formatClock12, formatDMY, lateBlocks, lateRows, latestArrival, totalRows } from "./logic";
import { lateSpec } from "./sheets";
import { useCompany } from "./useCompany";

/**
 * Daily Late Report: the staff who arrived late on one date (today at first), listed per unit (HO / U-1 / U-2) with the time
 * they first punched, as the paper "STAFF LATE REPORT", with Excel / PDF / Image of that same list.
 *
 * "Late" is the attendance engine's own late flag for the day (a Late-zone arrival), the one Staff Attendance shows, so the
 * two agree. The backend only sends staff: production workers are on the shift-table rules and are not part of this report.
 */
export default function LateTab({
  filters,
  onFilters,
}: {
  filters: DailyFilters;
  onFilters: (next: DailyFilters) => void;
}) {
  const company = useCompany();
  const query = useAttendanceReportDaily({
    date: filters.date,
    department: departmentParam(filters.department),
    search: filters.search || undefined,
  });

  const rows = useMemo(() => lateRows(query.data?.rows ?? []), [query.data]);
  const blocks = useMemo(() => lateBlocks(query.data?.rows ?? []), [query.data]);
  const spec = useMemo(() => lateSpec(filters.date, rows), [filters.date, rows]);
  const exporter = useSheetExport(spec, company.excel);
  const latest = useMemo(() => latestArrival(rows), [rows]);

  const hasData = !!query.data;
  const total = totalRows(blocks);
  const niceDate = formatDMY(filters.date);

  return (
    <div className="space-y-4" data-testid="late-tab">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="late-figures">
        <StatCard
          label={`Late on ${niceDate}`}
          value={hasData ? total : "-"}
          sub="Staff marked late by the attendance engine"
          icon={AlarmClock}
          tone="bg-amber-50 text-amber-800"
          testId="figure-late"
        />
        <StatCard
          label="Staff checked"
          value={hasData ? (query.data?.count ?? 0) : "-"}
          sub="Active staff on the roll"
          icon={Users}
          tone="bg-blue-50 text-blue-800"
          testId="figure-checked"
        />
        <StatCard
          label="Latest arrival"
          value={latest ? formatClock12(latest.firstPunch) : "None"}
          sub={latest ? latest.employeeName : "Nobody was late"}
          icon={Clock}
          tone="bg-rose-50 text-rose-800"
          testId="figure-latest"
        />
        <StatCard
          label="By unit"
          value={blocks.length}
          sub={
            blocks.length > 0
              ? blocks.map((b) => `${b.label} ${b.rows.length}`).join(" · ")
              : "No unit has a late arrival"
          }
          icon={Building2}
          tone="bg-teal-50 text-teal-800"
          testId="figure-units"
        />
      </div>

      <DailyFiltersBar
        filters={filters}
        onChange={onFilters}
        testId="late-filters"
        actions={
          <ExportBar
            busy={exporter.busy}
            onExport={exporter.run}
            disabled={total === 0}
            disabledHint={`Nobody was late on ${niceDate}`}
          />
        }
      />

      <p className="flex items-start gap-1.5 px-1 text-xs text-gray-500" data-testid="late-note">
        <Info size={14} className="mt-0.5 shrink-0 text-gray-400" />
        <span>
          Staff only: production workers are not part of this report. Late is the attendance engine&apos;s own flag for
          the day (the same one Staff Attendance shows) and Late Hours is the time of the first punch.
        </span>
      </p>

      <Card className="overflow-hidden rounded-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b bg-gray-50/70 px-4 py-2.5">
          <p className="text-sm font-bold text-gray-900">Preview</p>
          <span className="text-xs text-gray-500">this is the list the downloads contain</span>
          {hasData && total > 0 && (
            <div className="ml-auto flex flex-wrap gap-1.5" data-testid="late-unit-counts">
              {blocks.map((b) => (
                <Chip key={b.key} className="border-amber-200 bg-amber-50 text-amber-800">
                  {b.label} · {b.rows.length}
                </Chip>
              ))}
              <Chip className="border-gray-300 bg-white text-gray-800">Total · {total}</Chip>
            </div>
          )}
        </div>
        <CardContent className="p-0">
          {query.isError && !hasData ? (
            <ErrorState what="the late report" onRetry={() => void query.refetch()} />
          ) : !hasData ? (
            <ListSkeleton testId="late-loading" />
          ) : total === 0 ? (
            <EmptyState
              icon={AlarmClock}
              tone="bg-green-50 text-green-600"
              title={`Nobody was late on ${niceDate}`}
              text="Every staff member who punched in was on time, or no one matches the search and department."
              testId="late-empty"
            />
          ) : (
            <div className="overflow-x-auto bg-gray-50/40 p-3 sm:p-4" data-testid="late-preview">
              <div className="mx-auto w-full max-w-[760px] overflow-x-auto rounded-lg border bg-white p-3 shadow-sm">
                <ReportSheet spec={spec} fluid testId="late-sheet" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* The off-screen copy the PDF and the picture are taken from (the Excel file is built from the same spec). */}
      <div style={{ position: "fixed", left: -99999, top: 0, zIndex: -1 }} aria-hidden="true">
        <ReportSheet ref={exporter.sheetRef} spec={spec} company={company.sheet} />
      </div>
    </div>
  );
}
