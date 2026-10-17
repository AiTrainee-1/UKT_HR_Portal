import { FileSpreadsheet, FileText, History, Users } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { exportTableToCsv } from "@/components/payroll/kit/export-table";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { EmptyNote, KpiTile, SectionCard, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { FALLBACK_COMPANY, FilterSelect, LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { useCompensationReport, usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { countOf, rangeLabel, type CompensationUrl } from "../logic";
import { PeriodBar } from "../period";
import { historyNestedOfType, historyPath, historySubOfType } from "../routes";
import { StatusChip } from "../ui";
import { CSV_COLUMNS, REPORT_TYPES, TYPE_META, flatRows, overviewText, reportFileStem } from "./history-logic";
import { useReportFilters } from "./useReportFilters";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

/**
 * Reports: the cross-type summary for Today, a Week or a Month. Who benefited from each type at a glance (a card opens that
 * type's History subtab with the same period and filters), the totals, and one Excel file (a Summary sheet and a sheet per
 * type) or a CSV of every section. The records themselves are on the History page. Staff only; always readable.
 */
export default function ReportsTab({
  featuresOff,
  isBranchScoped,
  url,
  setUrl,
}: {
  featuresOff: boolean;
  isBranchScoped: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
}) {
  const f = useReportFilters(url, isBranchScoped, true);
  const [, navigate] = useLocation();
  const search = useSearch();
  const query = useCompensationReport({
    period: f.period,
    date: f.date,
    type: f.type,
    departmentId: f.departmentId,
    branchId: f.branchId,
  });
  const report = query.data;
  const { data: settings } = usePayrollSettings();

  const exportItems: ExportItem[] = [
    {
      key: "excel",
      label: "Excel (.xlsx)",
      hint: "One workbook: a Summary sheet and a sheet for every type, with all its columns",
      icon: FileSpreadsheet,
      disabled: !report || report.totals.rows === 0,
      run: async () => {
        if (!report) return;
        const { exportReportWorkbook } = await import("./workbook");
        await exportReportWorkbook(report, settings?.companyName || FALLBACK_COMPANY, {
          department: f.departmentName,
          branch: f.branchName,
        });
      },
    },
    {
      key: "csv",
      label: "CSV",
      hint: "Every record of every type shown, in one plain table",
      icon: FileText,
      disabled: !report || report.totals.rows === 0,
      run: () => {
        if (!report) return;
        exportTableToCsv({ rows: flatRows(report), columns: CSV_COLUMNS, filename: reportFileStem(report) });
      },
    },
  ];

  /** The History subtab of a type, with the period, the date and the filters of this page (the type filter is the subtab). */
  const openHistory = (type: string) => {
    const params = new URLSearchParams(search);
    params.delete("type");
    const qs = params.toString();
    navigate(historyPath(historySubOfType(type), historyNestedOfType(type)) + (qs ? `?${qs}` : ""));
  };

  return (
    <div className="space-y-4" data-testid="reports-tab">
      <PeriodBar
        period={f.period}
        date={f.date}
        today={f.today}
        onPeriod={(next) => setUrl({ period: next })}
        onDate={(next) => setUrl({ date: next === f.today ? "" : next })}
        testId="reports-period"
      >
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <FilterSelect
            value={f.type ?? ""}
            onChange={(v) => setUrl({ type: v === "" ? "all" : v })}
            options={REPORT_TYPES.map((t) => ({ value: t, label: TYPE_META[t].label }))}
            allLabel="All types"
            label="Filter by type"
            testId="reports-type"
            className="h-9 w-full sm:w-64"
          />
          <FilterSelect
            value={url.dept}
            onChange={(v) => setUrl({ dept: v })}
            options={(f.departments ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
            allLabel="All departments"
            label="Filter by department"
            testId="reports-dept"
            className="h-9 w-full sm:w-48"
          />
          {!isBranchScoped && (
            <FilterSelect
              value={url.branch}
              onChange={(v) => setUrl({ branch: v })}
              options={(f.branches ?? []).map((b) => ({ value: String(b.id), label: b.name }))}
              allLabel="All branches"
              label="Filter by branch"
              testId="reports-branch"
              className="h-9 w-full sm:w-44"
            />
          )}
          <ExportMenu
            items={exportItems}
            testId="reports-export"
            heading="Export what the filters show"
            disabled={!report || report.totals.rows === 0}
          />
        </div>
      </PeriodBar>

      {query.isLoading ? (
        <div className="space-y-4" data-testid="reports-loading">
          <SkeletonKpis count={3} className="md:grid-cols-3 xl:grid-cols-3" />
          <SkeletonRows rows={4} />
        </div>
      ) : query.isError && !report ? (
        <LoadError
          what="the report"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="reports-error"
        />
      ) : report ? (
        <>
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            data-testid="reports-kpis"
            {...{ [VIEW_SAFE_ATTR]: "" }}
          >
            <KpiTile
              testId="reports-kpi-period"
              label="Period"
              value={rangeLabel(report.from, report.to)}
              sub={
                report.period === "today" ? "One day" : report.period === "week" ? "Monday to Sunday" : "Calendar month"
              }
              icon={History}
              tone="bg-slate-100 text-slate-800"
            />
            <KpiTile
              testId="reports-kpi-employees"
              label="Employees who benefited"
              value={report.totals.employees}
              sub={f.filtersOn > 0 ? "with the filters on" : "across every type"}
              icon={Users}
              tone="bg-indigo-50 text-indigo-800"
            />
            <KpiTile
              testId="reports-kpi-records"
              label="Records"
              value={report.totals.rows}
              sub={countOf(report.sections.length, "type") + " shown"}
              icon={FileText}
              tone="bg-emerald-50 text-emerald-800"
            />
          </div>

          {/* who benefited from which type, at a glance; a card opens that type's History subtab */}
          <SectionCard
            testId="reports-overview"
            icon={Users}
            title="Who benefited from each type"
            description="Choose a type to open its records in History, for this period and these filters."
          >
            {report.sections.length === 0 ? (
              <EmptyNote icon={History} title="No type selected" testId="reports-no-sections" />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" {...{ [VIEW_SAFE_ATTR]: "" }}>
                {report.sections.map((s) => (
                  <button
                    key={s.type}
                    type="button"
                    onClick={() => openHistory(s.type)}
                    className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`overview-${s.type}`}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-gray-900">{TYPE_META[s.type].label}</span>
                      <span className="block text-xs text-muted-foreground">{overviewText(s)}</span>
                    </span>
                    {!s.enabled && !featuresOff && <StatusChip tone="warning">Off in Settings</StatusChip>}
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          <p className="px-1 text-[11px] text-muted-foreground">
            Staff only: production employees are never part of Compensation. Each record is filed under the date it
            belongs to (the day off granted, the work day, the birthday). Overtime announced before the new rules is not
            in this report: it stays listed under Earlier records on the OT Detection page.
          </p>
        </>
      ) : null}
    </div>
  );
}
