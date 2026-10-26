import { useMemo, useRef, useState } from "react";
import { AlarmClock, Building2, Clock, Info, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments } from "@/lib/api-client";
import { useAttendanceReportDaily } from "@/lib/api-client/custom-hooks";
import { exportElementToFile } from "@/lib/exportUtils";
import { ALL } from "../leave/logic";
import { Chip, EmptyState, ErrorState, ListSkeleton, ResultLine, StatCard } from "../leave/parts";
import DailyFiltersBar, { departmentParam, type DailyFilters } from "./DailyFilters";
import ExportBar, { type ExportFormat } from "./ExportBar";
import LateImageSheet from "./LateImageSheet";
import LateTable, { LATE_BY_HELP, SeverityLegend } from "./LateTable";
import {
  DEFAULT_SORT,
  clock,
  filterNote,
  formatMinutes,
  lateFileStem,
  lateEntries,
  nextSort,
  sortEntries,
  summarize,
  type LateSort,
} from "./late";
import { downloadLateExcel, type LateReportInput } from "./late-excel";
import { exportChoice, exportScopeText, pickedRows, toggleAllInView, toggleId } from "./selection";
import { formatDMY, groupByUnit, latestArrival, lateRows } from "./logic";
import { useCompany } from "./useCompany";

/**
 * Daily Late Report: the staff who arrived late on one date (today at first), in a table with the shift they were judged
 * against (start time and grace), when they actually punched in, and how late that was after the grace (Total Minutes Late)
 * with the plain minutes after the shift start under it. Longest delay first; any column sorts. Excel, PDF and Image of the
 * same list, in the order shown: the rows ticked in the first column when any is ticked, else every row listed.
 *
 * "Late" is the attendance engine's own late flag for the day (a Late-zone arrival), the one Staff Attendance shows, and the
 * minutes come from the engine's own deadline for that day, so the report always agrees with why the day was marked Late.
 * The backend only sends staff: production workers are not part of this report.
 */
export default function LateTab({
  filters,
  onFilters,
}: {
  filters: DailyFilters;
  onFilters: (next: DailyFilters) => void;
}) {
  const { toast } = useToast();
  const company = useCompany();
  const { data: departments } = useListDepartments();
  const [sort, setSort] = useState<LateSort>(DEFAULT_SORT);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  // the ticked rows, by employee id: a sort or a narrower search never loses a tick, a new date starts with none
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const imageRef = useRef<HTMLDivElement>(null);

  const query = useAttendanceReportDaily({
    date: filters.date,
    department: departmentParam(filters.department),
    search: filters.search || undefined,
  });

  // how many were late on the date whatever the department and search say, for "Showing 3 of 8 late employees" (the same
  // request as the list itself while nothing narrows it, so it costs nothing then)
  const narrowed = filters.department !== ALL || filters.search.trim() !== "";
  const wholeDay = useAttendanceReportDaily({ date: filters.date }, narrowed);
  const lateOnTheDay = narrowed ? (wholeDay.data ? lateRows(wholeDay.data.rows).length : null) : null;

  const entries = useMemo(() => sortEntries(lateEntries(query.data?.rows ?? []), sort), [query.data, sort]);
  const summary = useMemo(() => summarize(entries), [entries]);
  const latest = useMemo(() => latestArrival(lateRows(query.data?.rows ?? [])), [query.data]);
  // the units that have a late arrival, the head office first (the same order as the paper lists used)
  const units = useMemo(
    () => groupByUnit(lateRows(query.data?.rows ?? [])).map((b) => [b.label, b.rows.length] as const),
    [query.data],
  );

  const hasData = !!query.data;
  const total = entries.length;
  const niceDate = formatDMY(filters.date);
  const departmentName = departments?.find((d) => String(d.id) === filters.department)?.name ?? null;

  // what a download holds: the ticked rows when any is ticked, else every row listed (in the order shown); its title block,
  // summary line and totals are worked out from those rows
  const choice = useMemo(() => exportChoice(entries, selected), [entries, selected]);
  const pickedCount = useMemo(() => pickedRows(entries, selected).length, [entries, selected]);
  const scopeText = exportScopeText(choice);
  const selectionNote = choice.mode === "selected" ? `Selected: ${choice.rows.length} of ${total}` : "";

  const reportInput: LateReportInput = {
    date: filters.date,
    entries: choice.rows,
    company: company.excel.company,
    branchLabel: company.excel.branchLabel,
    logoDataUrl: company.excel.logoDataUrl,
    filter: [filterNote(departmentName, filters.search), selectionNote].filter(Boolean).join("; "),
    now: new Date(),
  };

  const changeFilters = (next: DailyFilters) => {
    if (next.date !== filters.date) setSelected(new Set());
    onFilters(next);
  };

  const download = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      if (format === "excel") {
        await downloadLateExcel(reportInput);
      } else if (format === "pdf") {
        // the PDF drawing (and jsPDF with it) loads only when someone asks for it
        const { downloadLatePdf } = await import("./late-pdf");
        await downloadLatePdf(reportInput);
      } else {
        // the picture is taken from the off-screen sheet below, as tall as the list is long
        if (!imageRef.current) throw new Error("The report is not on screen");
        await exportElementToFile(imageRef.current, lateFileStem(filters.date), "png");
      }
    } catch {
      toast({
        title: `Failed to export ${format === "excel" ? "Excel" : format === "pdf" ? "PDF" : "image"}`,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

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
          value={latest ? clock(latest.firstPunch) : "None"}
          sub={latest ? latest.employeeName : "Nobody was late"}
          icon={Clock}
          tone="bg-rose-50 text-rose-800"
          testId="figure-latest"
        />
        <StatCard
          label="By unit"
          value={units.length}
          sub={units.length > 0 ? units.map(([label, n]) => `${label} ${n}`).join(" · ") : "No unit has a late arrival"}
          icon={Building2}
          tone="bg-teal-50 text-teal-800"
          testId="figure-units"
        />
      </div>

      <DailyFiltersBar filters={filters} onChange={changeFilters} testId="late-filters">
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <Chip
            className={
              pickedCount > 0
                ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                : "border-gray-200 bg-gray-50 text-gray-500"
            }
          >
            <span data-testid="late-selected-count">{pickedCount}</span> selected
          </Chip>
          {pickedCount > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs font-semibold text-blue-600 hover:underline"
              data-testid="late-clear-selection"
            >
              Clear selection
            </button>
          )}
          <span className="text-xs text-gray-500" data-testid="export-scope">
            {total > 0 ? scopeText : "Nothing to export"}
          </span>
          <ExportBar
            busy={busy}
            onExport={(f) => void download(f)}
            disabled={total === 0}
            disabledHint={`Nobody was late on ${niceDate}`}
            scope={scopeText}
          />
        </div>
      </DailyFiltersBar>

      {hasData && (
        <ResultLine
          shown={total}
          total={lateOnTheDay ?? total}
          noun="late employees"
          active={narrowed}
          onClear={() => onFilters({ ...filters, department: ALL, search: "" })}
          testId="late-result-line"
        />
      )}

      <Card className="overflow-hidden rounded-2xl">
        <div className="space-y-2 border-b bg-gray-50/70 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div>
              <p className="text-sm font-bold text-gray-900">Late arrivals on {niceDate}</p>
              {hasData && total > 0 && (
                <p className="text-xs text-gray-500" data-testid="late-summary">
                  {total} late
                  {summary.average != null && <> &middot; average {formatMinutes(summary.average)}</>}
                  {summary.longest != null && (
                    <>
                      {" "}
                      &middot; longest {formatMinutes(summary.longest)}
                      {summary.longestName ? ` (${summary.longestName})` : ""}
                    </>
                  )}
                </p>
              )}
            </div>
            <SeverityLegend />
          </div>
          <p className="flex items-start gap-1.5 text-xs text-gray-500" data-testid="late-note">
            <Info size={14} className="mt-0.5 shrink-0 text-gray-400" />
            <span>
              {LATE_BY_HELP} Staff only: production workers are not part of this report, and Late is the attendance
              engine&apos;s own flag (the same one Staff Attendance shows).
            </span>
          </p>
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
            <LateTable
              entries={entries}
              sort={sort}
              onSort={(column) => setSort((cur) => nextSort(cur, column))}
              selected={selected}
              onToggle={(id) => setSelected((cur) => toggleId(cur, id))}
              onToggleAll={() => setSelected((cur) => toggleAllInView(cur, entries))}
            />
          )}
        </CardContent>
      </Card>

      {/* The off-screen copy the picture is taken from (display:none would give html2canvas nothing to draw). */}
      <div style={{ position: "fixed", left: -99999, top: 0, zIndex: -1 }} aria-hidden="true">
        <LateImageSheet ref={imageRef} input={reportInput} />
      </div>
    </div>
  );
}
