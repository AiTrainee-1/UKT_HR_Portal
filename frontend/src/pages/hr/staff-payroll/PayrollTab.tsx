import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  CircleSlash,
  Download,
  FileSpreadsheet,
  FileText,
  ListChecks,
  Play,
  RefreshCw,
  SearchX,
  Settings,
  Users,
} from "lucide-react";
import { useLocation } from "wouter";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import { Button } from "@/components/ui/button";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { dateTime, fileStem, plural } from "@/components/payroll/kit/format";
import { exportTableToCsv, exportTableToExcel } from "@/components/payroll/kit/export-table";
import { addSkipped } from "@/components/payroll/kit/issue-summary";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { withTdsColumns } from "@/components/payroll/kit/statutory";
import { useMarkPaid } from "@/components/payroll/kit/use-payroll-actions";
import { openPayrollDetails } from "@/components/payroll/kit/url-state";
import { ViewSwitch, type ViewOption } from "@/components/payroll/kit/ViewSwitch";
import {
  DEFAULT_FILTERS,
  PayrollFilterBar,
  applyPayrollFilters,
  buildIssueIndex,
  buildIssueSummaries,
  filtersFromUrl,
  filtersToUrl,
  hasChanges,
} from "@/components/payroll/panels/filters";
import { IssuesPanel } from "@/components/payroll/panels/issues";
import { PayrollRecordList, type RecordLayout } from "@/components/payroll/panels/records";
import { RulesPanel } from "@/components/payroll/panels/rules";
import { SkippedPanel, type SkippedItem } from "@/components/payroll/panels/skipped";
import { MONTH_NAMES } from "@/components/payroll/BreakdownDrawer";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useListDepartments, useListPayrollRuns } from "@/lib/api-client";
import {
  usePayrollIssues,
  usePayrollRules,
  usePayrollSettings,
  usePayrollSkipCheck,
} from "@/lib/api-client/custom-hooks";
import { exportPayrollToExcel } from "@/lib/payrollExcelExport";
import { GenerateDialog } from "./GenerateDialog";
import { SessionConfigPanel } from "./SessionConfigPanel";
import {
  REGISTER_COLUMNS,
  isStaffView,
  issueFiltersFromUrl,
  issueFiltersToUrl,
  onlyStaff,
  staffPeriodLabel,
  staffScope,
  type StaffView,
} from "./logic";

type UrlSetter = (patch: Record<string, string>) => void;

/**
 * Payroll tab of the Staff Payroll page: the actions (Generate, Skipped, Export) and its four views - Records, Issues,
 * Skipped and Rules - all about the one month the page header chose. (It has no dashboard of the month: the counts are on
 * the view switch.)
 */
export function PayrollTab({
  month,
  year,
  url,
  setUrl,
  onPeriodChange,
}: {
  month: number;
  year: number;
  url: Record<string, string>;
  setUrl: UrlSetter;
  onPeriodChange: (month: number, year: number) => void;
}) {
  const [, navigate] = useLocation();
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSessionConfig, setShowSessionConfig] = useState(false);
  const { markPaid, markingId } = useMarkPaid();

  const scope = useMemo(() => staffScope({ month, year }), [month, year]);
  const periodLabel = staffPeriodLabel({ month, year });
  const view: StaffView = isStaffView(url.view) ? url.view : "records";
  const filters = useMemo(() => filtersFromUrl(url), [url]);
  const issueFilters = useMemo(() => issueFiltersFromUrl(url), [url]);

  const { showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const departments = useListDepartments();
  const settings = usePayrollSettings();
  const runsQuery = useListPayrollRuns({ month, year });
  // Staff payroll only: Production payroll has its own pages.
  const runs = useMemo(() => onlyStaff(runsQuery.data), [runsQuery.data]);
  const issuesQuery = usePayrollIssues(scope);
  const rulesQuery = usePayrollRules(scope);
  // Runs on arrival (not behind a button) so the Skipped tile and the view's count are always live; the Generate dialog
  // and the Skipped view read the same cached answer.
  const skipQuery = usePayrollSkipCheck({ month, year, runType: "monthly" });

  const issues = issuesQuery.data;
  // what the Issues view's count says: the issues plus the employees skipped at generation, as the view lists them
  const dashIssues = useMemo(
    () => addSkipped(issues?.summary, skipQuery.data?.skippedCount ?? 0),
    [issues, skipQuery.data?.skippedCount],
  );
  const issueIndex = useMemo(() => buildIssueIndex(issues?.issues ?? []), [issues]);
  const issueSummaries = useMemo(() => buildIssueSummaries(issues?.issues ?? []), [issues]);
  const rulesByEmployee = useMemo(
    () => new Map((rulesQuery.data?.employees ?? []).map((e) => [e.employeeId, e])),
    [rulesQuery.data],
  );
  const shown = useMemo(
    () => applyPayrollFilters(runs, filters, issues ? issueIndex : undefined),
    [runs, filters, issues, issueIndex],
  );
  const skipped: SkippedItem[] | undefined = useMemo(
    () =>
      skipQuery.data?.skipped.map((s) => ({
        employeeId: s.employeeId,
        employeeCode: s.employeeCode,
        name: s.name,
        reason: s.reason,
      })),
    [skipQuery.data],
  );

  const setView = (next: StaffView) => setUrl({ view: next });
  const resetFilters = () => setUrl(filtersToUrl(DEFAULT_FILTERS) as Record<string, string>);

  const company = settings.data?.companyName ?? "UK Textiles";
  const stem = fileStem("Staff_Payroll", MONTH_NAMES[month - 1], year);
  // the register gets its two TDS columns only when some employee on screen has TDS
  const registerColumns = withTdsColumns(REGISTER_COLUMNS, shown);
  const exportItems: ExportItem[] = [
    {
      key: "register-xlsx",
      label: "Payroll register (Excel)",
      hint: `${shown.length} record${shown.length === 1 ? "" : "s"} on screen, with days, earnings and deductions`,
      icon: FileSpreadsheet,
      disabled: shown.length === 0,
      run: () =>
        exportTableToExcel({
          rows: shown,
          columns: registerColumns,
          filename: `${stem}_Register`,
          sheetName: "Payroll register",
          company,
          subtitle: "Staff payroll",
          title: `Payroll register · ${periodLabel}`,
        }),
    },
    {
      key: "register-csv",
      label: "Payroll register (CSV)",
      hint: "The same rows as a plain text file",
      icon: FileText,
      disabled: shown.length === 0,
      run: () => exportTableToCsv({ rows: shown, columns: registerColumns, filename: `${stem}_Register` }),
    },
  ];

  const options: ViewOption<StaffView>[] = [
    { value: "records", label: "Records", icon: ListChecks, count: runsQuery.isLoading ? null : runs.length },
    {
      value: "issues",
      label: "Issues",
      icon: AlertTriangle,
      count: issuesQuery.isLoading || skipQuery.isLoading ? null : (dashIssues?.total ?? 0),
      tone: (dashIssues?.bySeverity.critical ?? 0) > 0 ? "danger" : "warning",
    },
    {
      value: "skipped",
      label: "Skipped",
      icon: CircleSlash,
      count: skipQuery.isLoading ? null : (skipQuery.data?.skippedCount ?? 0),
      tone: "warning",
    },
    { value: "rules", label: "Rules", icon: BookOpenCheck },
  ];

  const empty =
    runs.length === 0 ? (
      <EmptyNote
        icon={Users}
        title={`No payroll records for ${periodLabel}`}
        hint='Click "Generate Payroll" to compute payroll from attendance data.'
        testId="staff-empty-period"
        action={
          <Button className="mt-2 gap-2 bg-indigo-600 hover:bg-indigo-700" onClick={() => setShowGenerate(true)}>
            <Play size={14} /> Generate Payroll
          </Button>
        }
      />
    ) : (
      <EmptyNote
        icon={SearchX}
        title="No payroll record matches these filters"
        hint="Change or clear the filters to see the rest."
        testId="staff-empty-filters"
        action={
          <Button variant="outline" className="mt-2" onClick={resetFilters}>
            Reset filters
          </Button>
        }
      />
    );

  return (
    <div className="space-y-5" data-testid="staff-payroll-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900" data-testid="staff-record-count">
            {runsQuery.isLoading ? periodLabel : `${periodLabel} · ${plural(runs.length, "record")}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {issues?.detectedAt
              ? `Last computed ${dateTime(issues.detectedAt)}`
              : "Staff payroll for the month, worked out from attendance"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-9 gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
            onClick={() => setView("skipped")}
            data-testid="staff-skipped-open"
          >
            <AlertTriangle size={14} /> Skipped Employees
          </Button>
          <Button variant="outline" className="h-9 gap-2" onClick={() => setShowSessionConfig((s) => !s)}>
            <Settings size={14} /> Legacy Session Config
          </Button>
          <ExportMenu items={exportItems} label="Export" heading="Export what is on screen" testId="staff-export" />
          <Button
            variant="outline"
            className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            disabled={shown.length === 0}
            onClick={() => void exportPayrollToExcel(shown, "Staff", `${MONTH_NAMES[month - 1]}_${year}`)}
            data-testid="staff-export-bank"
          >
            <Download size={14} /> Export bank file
          </Button>
          <Button
            className="h-9 gap-2 bg-indigo-600 hover:bg-indigo-700"
            onClick={() => setShowGenerate(true)}
            data-testid="staff-generate-open"
          >
            <Play size={14} /> Generate Payroll
          </Button>
        </div>
      </div>

      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />
      {showSessionConfig && <SessionConfigPanel />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewSwitch options={options} value={view} onChange={setView} accent="indigo" />
        {view === "records" && hasChanges(filters) && (
          <button
            type="button"
            className="text-xs font-semibold text-indigo-700 hover:underline"
            onClick={resetFilters}
          >
            Clear filters
          </button>
        )}
      </div>

      {runsQuery.isError && view === "records" ? (
        <EmptyNote
          icon={RefreshCw}
          title="The payroll records could not be loaded"
          hint="Check the connection and try again."
          action={
            <Button variant="outline" className="mt-2" onClick={() => void runsQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : view === "records" ? (
        <div className="space-y-3">
          <PayrollFilterBar
            value={filters}
            onChange={(next) => setUrl(filtersToUrl(next) as Record<string, string>)}
            departments={departments.data}
            issueOptions={issues?.summary.byCode}
            issuesLoading={issuesQuery.isLoading}
            shown={shown.length}
            total={runs.length}
            disabled={runsQuery.isLoading}
            testIdPrefix="staff-pf"
          />
          <PayrollRecordList
            runs={shown}
            kind="staff"
            accent="indigo"
            loading={runsQuery.isLoading}
            issuesByPayroll={issueSummaries}
            issuesLoading={issuesQuery.isLoading}
            rulesByEmployee={rulesByEmployee}
            rulesLoading={rulesQuery.isLoading}
            onOpenDetails={(run) => openPayrollDetails(navigate, "staff", run.id)}
            onOpenIssues={(run) => openPayrollDetails(navigate, "staff", run.id, "issues")}
            onMarkPaid={(run) => void markPaid(run)}
            markingId={markingId}
            layout={url.layout === "table" ? "table" : "cards"}
            onLayoutChange={(layout: RecordLayout) => setUrl({ layout })}
            empty={empty}
            testId="staff-records"
          />
        </div>
      ) : view === "issues" ? (
        <IssuesPanel
          scope={scope}
          accent="indigo"
          skipped={skipped}
          value={issueFilters}
          onChange={(patch) => setUrl(issueFiltersToUrl(patch) as Record<string, string>)}
          onOpenDetails={(issue) => {
            if (issue.payrollId) openPayrollDetails(navigate, "staff", issue.payrollId, "issues");
          }}
        />
      ) : view === "skipped" ? (
        <SkippedPanel
          skipped={skipped}
          totalChecked={skipQuery.data?.totalChecked}
          loading={skipQuery.isLoading}
          error={skipQuery.error}
          onRecheck={() => void skipQuery.refetch()}
          rechecking={skipQuery.isFetching && !skipQuery.isLoading}
          periodLabel={periodLabel}
          kind="staff"
          accent="indigo"
        />
      ) : (
        <RulesPanel scope={scope} accent="indigo" />
      )}

      {showGenerate && (
        <GenerateDialog
          initialMonth={month}
          initialYear={year}
          onClose={() => setShowGenerate(false)}
          onStarted={onPeriodChange}
        />
      )}
    </div>
  );
}
