import { useMemo } from "react";
import { FileSpreadsheet, FileText, History, Users } from "lucide-react";
import { exportTableToCsv } from "@/components/payroll/kit/export-table";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { EmptyNote, KpiTile, SectionCard, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { FALLBACK_COMPANY, FilterSelect, LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { useListDepartments } from "@/lib/api-client";
import {
  getListBranchesQueryKey,
  useCompensationReport,
  useListBranches,
  usePayrollSettings,
} from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { countOf, rangeLabel, todayIst, type CompensationUrl } from "../logic";
import { PeriodBar, isPeriod } from "../period";
import { StatusChip } from "../ui";
import {
  CSV_COLUMNS,
  REPORT_TYPES,
  TYPE_META,
  flatRows,
  isReportType,
  overviewText,
  reportFileStem,
} from "./history-logic";
import { ReportSectionCard } from "./ReportSectionCard";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

/**
 * History & Reports: who benefited from each type of compensation, for Today, a Week or a Month, with filters, and one
 * Excel file (a Summary sheet and a sheet per type) or a CSV of what is on screen. Staff only; always readable, whatever the
 * switches say.
 */
export default function HistoryTab({
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
  const today = useMemo(() => todayIst(), []);
  const period = isPeriod(url.period) ? url.period : "today";
  const date = url.date || today;
  const type = isReportType(url.type) ? url.type : undefined;
  const departmentId = Number(url.dept) > 0 ? Number(url.dept) : undefined;
  const branchId = !isBranchScoped && Number(url.branch) > 0 ? Number(url.branch) : undefined;

  const query = useCompensationReport({ period, date, type, departmentId, branchId });
  const report = query.data;
  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const { data: settings } = usePayrollSettings();

  const departmentName = departments?.find((d) => d.id === departmentId)?.name ?? null;
  const branchName = branches?.find((b) => b.id === branchId)?.name ?? null;
  const filtersOn = (type ? 1 : 0) + (departmentId ? 1 : 0) + (branchId ? 1 : 0);

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
          department: departmentName,
          branch: branchName,
        });
      },
    },
    {
      key: "csv",
      label: "CSV",
      hint: "Every row on screen in one plain table",
      icon: FileText,
      disabled: !report || report.totals.rows === 0,
      run: () => {
        if (!report) return;
        exportTableToCsv({ rows: flatRows(report), columns: CSV_COLUMNS, filename: reportFileStem(report) });
      },
    },
  ];

  const jump = (t: string) =>
    document.getElementById(`report-${t}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-4" data-testid="history-tab">
      <PeriodBar
        period={period}
        date={date}
        today={today}
        onPeriod={(next) => setUrl({ period: next })}
        onDate={(next) => setUrl({ date: next === today ? "" : next })}
        testId="history-period"
      >
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <FilterSelect
            value={type ?? ""}
            onChange={(v) => setUrl({ type: v === "" ? "all" : v })}
            options={REPORT_TYPES.map((t) => ({ value: t, label: TYPE_META[t].label }))}
            allLabel="All types"
            label="Filter by type"
            testId="history-type"
            className="h-9 w-full sm:w-64"
          />
          <FilterSelect
            value={url.dept}
            onChange={(v) => setUrl({ dept: v })}
            options={(departments ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
            allLabel="All departments"
            label="Filter by department"
            testId="history-dept"
            className="h-9 w-full sm:w-48"
          />
          {!isBranchScoped && (
            <FilterSelect
              value={url.branch}
              onChange={(v) => setUrl({ branch: v })}
              options={(branches ?? []).map((b) => ({ value: String(b.id), label: b.name }))}
              allLabel="All branches"
              label="Filter by branch"
              testId="history-branch"
              className="h-9 w-full sm:w-44"
            />
          )}
          <ExportMenu
            items={exportItems}
            testId="history-export"
            heading="Export what the filters show"
            disabled={!report || report.totals.rows === 0}
          />
        </div>
      </PeriodBar>

      {query.isLoading ? (
        <div className="space-y-4" data-testid="history-loading">
          <SkeletonKpis count={3} className="md:grid-cols-3 xl:grid-cols-3" />
          <SkeletonRows rows={4} />
        </div>
      ) : query.isError && !report ? (
        <LoadError
          what="the report"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="history-error"
        />
      ) : report ? (
        <>
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            data-testid="history-kpis"
            {...{ [VIEW_SAFE_ATTR]: "" }}
          >
            <KpiTile
              testId="history-kpi-period"
              label="Period"
              value={rangeLabel(report.from, report.to)}
              sub={
                report.period === "today" ? "One day" : report.period === "week" ? "Monday to Sunday" : "Calendar month"
              }
              icon={History}
              tone="bg-slate-100 text-slate-800"
            />
            <KpiTile
              testId="history-kpi-employees"
              label="Employees who benefited"
              value={report.totals.employees}
              sub={filtersOn > 0 ? "with the filters on" : "across every type"}
              icon={Users}
              tone="bg-indigo-50 text-indigo-800"
            />
            <KpiTile
              testId="history-kpi-records"
              label="Records"
              value={report.totals.rows}
              sub={countOf(report.sections.length, "type") + " shown"}
              icon={FileText}
              tone="bg-emerald-50 text-emerald-800"
            />
          </div>

          {/* who benefited from which type, at a glance */}
          <SectionCard
            testId="history-overview"
            icon={Users}
            title="Who benefited from each type"
            description="Choose a type to jump to its beneficiaries."
          >
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" {...{ [VIEW_SAFE_ATTR]: "" }}>
              {report.sections.map((s) => (
                <button
                  key={s.type}
                  type="button"
                  onClick={() => jump(s.type)}
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
          </SectionCard>

          {report.sections.length === 0 ? (
            <EmptyNote icon={History} title="No type selected" testId="history-no-sections" />
          ) : (
            report.sections.map((section) => (
              <ReportSectionCard key={section.type} section={section} masterOn={!featuresOff} />
            ))
          )}

          <p className="px-1 text-[11px] text-muted-foreground">
            Staff only: production employees are never part of Compensation. Each record is filed under the date it
            belongs to (the day off granted, the work day, the birthday). Overtime announced before the new rules is not
            in this report: it stays listed under Earlier records on the OT Detection tab.
          </p>
        </>
      ) : null}
    </div>
  );
}
