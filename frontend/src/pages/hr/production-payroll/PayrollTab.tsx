import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  CircleSlash,
  Download,
  FileSpreadsheet,
  FileText,
  Info,
  ListChecks,
  Play,
  RefreshCw,
  SearchX,
  Users,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import { Button } from "@/components/ui/button";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { dateTime, plural } from "@/components/payroll/kit/format";
import { addSkipped } from "@/components/payroll/kit/issue-summary";
import { EmptyNote, PayrollLoader, SectionCard } from "@/components/payroll/kit/parts";
import { useMarkPaid } from "@/components/payroll/kit/use-payroll-actions";
import { openPayrollDetails } from "@/components/payroll/kit/url-state";
import { ViewSwitch, type ViewOption } from "@/components/payroll/kit/ViewSwitch";
import { PayrollDashboard } from "@/components/payroll/panels/dashboard";
import {
  ALL,
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
import {
  DepartmentTabs,
  PayrollRecordList,
  departmentGroups,
  pickDepartment,
  runsOfDepartment,
  type RecordLayout,
} from "@/components/payroll/panels/records";
import { RulesPanel } from "@/components/payroll/panels/rules";
import { SkippedPanel } from "@/components/payroll/panels/skipped";
import { canApprove, isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useListDepartments } from "@/lib/api-client";
import {
  PAY_CYCLE_INFO,
  useListProductionPayroll,
  usePayrollIssues,
  usePayrollRules,
  useProductionPeriodStatus,
  type CyclePeriod,
  type PayCycle,
} from "@/lib/api-client/custom-hooks";
import { moduleForPath } from "@/lib/permission-modules";
import { exportPayrollToExcel } from "@/lib/payrollExcelExport";
import { downloadReportFile } from "@/lib/report-download";
import { Gate, pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import { NotEndedNote, PeriodError } from "./CycleNotices";
import { GenerateDialog } from "./GenerateDialog";
import {
  PRODUCTION_VIEWS,
  formatPeriod,
  isProductionView,
  issueFiltersFromUrl,
  issueFiltersToUrl,
  productionScope,
  skippedFromRoster,
  type ProductionView,
  type UrlSetter,
} from "./logic";
import { PRODUCTION_STATEMENT_REPORT_ID, productionStatementQuery } from "./payroll-tab-logic";

// Each view's own permission key (Account Management -> Roles & Permissions); a key with no setting follows the Payroll tab.
const VIEW_KEY: Record<ProductionView, string> = {
  records: "production_payroll.payroll.records",
  issues: "production_payroll.payroll.issues",
  skipped: "production_payroll.payroll.skipped",
  rules: "production_payroll.payroll.rules",
};

/**
 * Payroll tab of a cycle page: the actions (Generate, Skipped Employees, Export), the dashboard of the period and its four
 * views - Records, Issues, Skipped and Rules - all about the one pay period the page chose and the employees on this cycle.
 * Like Staff Payroll's (2026-11-06): the records are a table by default, listed one department at a time, and Export is
 * the printed Production Salary Statement (Excel / PDF) of the Report Center.
 */
export function PayrollTab({
  cycle,
  period,
  url,
  setUrl,
  onPeriodChange,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  url: Record<string, string>;
  setUrl: UrlSetter;
  /** Called as a run starts, so the page keeps showing this period while it is generated. */
  onPeriodChange: (period: CyclePeriod) => void;
}) {
  const [location, navigate] = useLocation();
  const { user } = useAuth();
  const level = useLevel();
  const [showGenerate, setShowGenerate] = useState(false);
  const { markPaid, markingId } = useMarkPaid();
  const info = PAY_CYCLE_INFO[cycle];
  // Only the views this role may see (Records / Issues / Skipped / Rules); a hidden one is never shown nor loaded.
  const canSee = (v: ProductionView) => level(VIEW_KEY[v]) !== "hidden";
  const visibleViews = visibleItems(PRODUCTION_VIEWS, (v) => VIEW_KEY[v], level);
  const mayGenerate = level("production_payroll.generate") !== "hidden";
  // Mark as Cleared is an approval of its own (payroll_mark_cleared)
  const mayMarkCleared = canApprove(user, "payroll_mark_cleared");

  const scope = useMemo(() => productionScope(cycle, period), [cycle, period]);
  const periodLabel = formatPeriod(period);
  const view: ProductionView = pickVisible(isProductionView(url.view) ? url.view : "records", visibleViews);
  // A view this role may only VIEW while the page and the Payroll tab are editable (those have their own locks).
  const viewLocked =
    visibleViews.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level("production_payroll.payroll") !== "view" &&
    level(VIEW_KEY[view]) === "view";
  useViewOnlyLock(viewLocked, view);
  // The department is picked with the tabs above the records, never by the filter: an old address naming one is ignored.
  const filters = useMemo(() => ({ ...filtersFromUrl(url), dept: ALL }), [url]);
  const issueFilters = useMemo(() => issueFiltersFromUrl(url), [url]);

  const { showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const departments = useListDepartments();
  // The roster answers "who is on this cycle, and who cannot be paid": it is also where the Skipped view comes from.
  const status = useProductionPeriodStatus(cycle, period);
  const runsQuery = useListProductionPayroll({
    cycle,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    limit: 500,
  });
  // A production row already is a payroll row (`ProductionPayrollItem` extends `PayrollRunItem`): the panels take it as it is.
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const issuesQuery = usePayrollIssues(canSee("issues") ? scope : null);
  const rulesQuery = usePayrollRules(canSee("rules") ? scope : null);

  const issues = issuesQuery.data;
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
  // The records list one department at a time; the filters, the exports and the counts still cover every department.
  const groups = useMemo(() => departmentGroups(shown), [shown]);
  const activeDept = pickDepartment(groups, url.pdept);
  const deptRuns = useMemo(() => runsOfDepartment(shown, activeDept), [shown, activeDept]);
  const roster = status.data?.employees.length;
  const skipped = useMemo(() => (status.data ? skippedFromRoster(status.data.employees) : undefined), [status.data]);
  const skippedCount = skipped?.length ?? 0;
  // what the dashboard tile and the view's count say: the issues plus the employees who cannot be paid, as the view lists them
  const dashIssues = useMemo(() => addSkipped(issues?.summary, skippedCount), [issues, skippedCount]);

  const setView = (next: ProductionView) => {
    if (canSee(next)) setUrl({ view: next });
  };
  const resetFilters = () => setUrl(filtersToUrl(DEFAULT_FILTERS) as Record<string, string>);

  // Both files are the Report Center's Production Salary Statement (Reports > HR Reports), so the two can never differ: the
  // printed format of Staff's Salary Payroll Statement, unit by unit, with the production columns.
  const statementItem = (format: "xlsx" | "pdf"): ExportItem => ({
    key: `statement-${format}`,
    label: `Production Salary Statement (${format === "pdf" ? "PDF" : "Excel"})`,
    hint: `The printed statement for ${info.label} ${periodLabel}, unit by unit: every department with sub totals, a total per unit and a grand total`,
    icon: format === "pdf" ? FileText : FileSpreadsheet,
    disabled: runs.length === 0,
    run: async () => {
      await downloadReportFile({
        reportId: PRODUCTION_STATEMENT_REPORT_ID,
        title: `Production Salary Statement ${info.label} ${periodLabel}`,
        format,
        query: productionStatementQuery(cycle, period, filters.status),
      });
    },
  });
  const exportItems: ExportItem[] = [statementItem("xlsx"), statementItem("pdf")];

  const options: ViewOption<ProductionView>[] = visibleItems<ViewOption<ProductionView>>(
    [
      { value: "records", label: "Records", icon: ListChecks, count: runsQuery.isLoading ? null : runs.length },
      {
        value: "issues",
        label: "Issues",
        icon: AlertTriangle,
        count: issuesQuery.isLoading || status.isLoading ? null : (dashIssues?.total ?? 0),
        tone: (dashIssues?.bySeverity.critical ?? 0) > 0 ? "danger" : "warning",
      },
      {
        value: "skipped",
        label: "Skipped",
        icon: CircleSlash,
        count: status.isLoading ? null : skippedCount,
        tone: "warning",
      },
      { value: "rules", label: "Rules", icon: BookOpenCheck },
    ],
    (o) => VIEW_KEY[o.value],
    level,
  );

  // Why the list is empty, and what to do about it: the filters, nobody on the cycle, or nothing generated yet.
  const empty =
    runs.length > 0 ? (
      <EmptyNote
        icon={SearchX}
        title="No payroll record matches these filters"
        hint="Change or clear the filters to see the rest."
        testId="pcp-empty-filters"
        action={
          <Button variant="outline" className="mt-2" onClick={resetFilters}>
            Reset filters
          </Button>
        }
      />
    ) : status.isLoading ? (
      <PayrollLoader label="Checking who is on this cycle" />
    ) : roster === 0 ? (
      <EmptyNote
        icon={Users}
        title={`No employees are assigned to the ${info.label} cycle yet`}
        hint="Payroll is generated only for the production employees assigned to this cycle."
        testId="pcp-empty-roster"
        action={
          <Button asChild className="mt-2 gap-2 bg-amber-600 hover:bg-amber-700">
            <Link href="/hr/employees/productionEmployee">Open Production Employees</Link>
          </Button>
        }
      />
    ) : (
      <EmptyNote
        icon={Users}
        title="No payroll generated for this period yet"
        hint={`${periodLabel}: click "Generate Payroll" to compute it from attendance.`}
        testId="pcp-empty-period"
        action={
          <Gate k="production_payroll.generate">
            <Button
              className="mt-2 gap-2 bg-amber-600 hover:bg-amber-700"
              onClick={() => setShowGenerate(true)}
              disabled={!status.data}
            >
              <Play size={14} /> Generate Payroll
            </Button>
          </Gate>
        }
      />
    );

  if (status.isError) {
    return (
      <div className="space-y-5" data-testid="pcp-payroll-tab">
        <PeriodError error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="pcp-payroll-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900" data-testid="pcp-record-count">
            {runsQuery.isLoading ? periodLabel : `${periodLabel} · ${plural(runs.length, "record")}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {issues?.detectedAt
              ? `Last computed ${dateTime(issues.detectedAt)}`
              : `${info.label} production payroll for the period, worked out from attendance`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Gate k="production_payroll.payroll.skipped">
            <Button
              variant="outline"
              className="h-9 gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
              onClick={() => setView("skipped")}
              data-testid="pcp-skipped-open"
            >
              <AlertTriangle size={14} /> Skipped Employees
            </Button>
          </Gate>
          <ExportMenu
            items={exportItems}
            label="Export"
            heading={`Export ${info.label} ${periodLabel} payroll`}
            testId="pcp-export"
          />
          <Button
            variant="outline"
            className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            disabled={shown.length === 0}
            onClick={() =>
              void exportPayrollToExcel(shown, "Production", `${info.label}_${period.periodStart}_${period.periodEnd}`)
            }
            data-testid="pcp-export-bank"
          >
            <Download size={14} /> Export bank file
          </Button>
          <Gate k="production_payroll.generate">
            <Button
              className="h-9 gap-2 bg-amber-600 hover:bg-amber-700"
              onClick={() => setShowGenerate(true)}
              disabled={!status.data}
              data-testid="pcp-generate-open"
            >
              <Play size={14} /> Generate Payroll
            </Button>
          </Gate>
        </div>
      </div>

      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />
      {status.data && !status.data.periodEnded && <NotEndedNote period={period} />}

      <PayrollDashboard
        kind="production"
        accent="amber"
        periodLabel={periodLabel}
        runs={runs}
        loading={runsQuery.isLoading}
        expected={
          status.data ? { count: status.data.employees.length, label: `on the ${info.label} cycle` } : undefined
        }
        issues={canSee("issues") ? dashIssues : undefined}
        issuesLoading={issuesQuery.isLoading}
        skipped={
          status.data && canSee("skipped") ? { count: skippedCount, total: status.data.employees.length } : undefined
        }
        skippedLoading={status.isLoading}
        onOpenIssues={
          canSee("issues") ? (code) => setUrl({ view: "issues", ...(code ? { icode: code } : {}) }) : undefined
        }
        onOpenSkipped={canSee("skipped") ? () => setView("skipped") : undefined}
        onFilterStatus={
          canSee("records") ? (statusFilter) => setUrl({ view: "records", status: statusFilter }) : undefined
        }
        testIdPrefix="pcp-dash"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {options.length > 0 && <ViewSwitch options={options} value={view} onChange={setView} accent="amber" />}
        {view === "records" && hasChanges(filters) && (
          <button type="button" className="text-xs font-semibold text-amber-700 hover:underline" onClick={resetFilters}>
            Clear filters
          </button>
        )}
      </div>

      <ViewOnlyTabNote show={viewLocked} />

      {visibleViews.length === 0 ? (
        <p
          className="rounded-2xl bg-white p-6 text-center text-sm text-muted-foreground shadow-sm"
          data-testid="pcp-views-nothing-open"
        >
          Nothing on this page is open to your role.
        </p>
      ) : runsQuery.isError && view === "records" ? (
        <EmptyNote
          icon={RefreshCw}
          title="The payroll records could not be loaded"
          hint="Check the connection and try again."
          testId="pcp-records-error"
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
            testIdPrefix="pcp-pf"
            hideDepartment
          />
          <DepartmentTabs
            groups={groups}
            active={activeDept}
            accent="amber"
            onChange={(id) => setUrl({ pdept: id })}
            testIdPrefix="pcp-dept"
          />
          <PayrollRecordList
            runs={deptRuns}
            kind="production"
            accent="amber"
            loading={runsQuery.isLoading}
            issuesByPayroll={issueSummaries}
            issuesLoading={issuesQuery.isLoading}
            rulesByEmployee={rulesByEmployee}
            rulesLoading={rulesQuery.isLoading}
            onOpenDetails={(run) => openPayrollDetails(navigate, "production", run.id)}
            onOpenIssues={(run) => openPayrollDetails(navigate, "production", run.id, "issues")}
            onMarkPaid={mayMarkCleared ? (run) => void markPaid(run) : undefined}
            markingId={markingId}
            layout={url.layout === "cards" ? "cards" : "table"}
            onLayoutChange={(layout: RecordLayout) => setUrl({ layout })}
            empty={empty}
            testId="pcp-records"
          />
        </div>
      ) : view === "issues" ? (
        <IssuesPanel
          scope={scope}
          accent="amber"
          skipped={skipped}
          value={issueFilters}
          onChange={(patch) => setUrl(issueFiltersToUrl(patch) as Record<string, string>)}
          onOpenDetails={(issue) => {
            if (issue.payrollId) openPayrollDetails(navigate, "production", issue.payrollId, "issues");
          }}
        />
      ) : view === "skipped" ? (
        <SkippedPanel
          skipped={skipped}
          totalChecked={status.data?.employees.length}
          loading={status.isLoading}
          error={status.error}
          onRecheck={() => void status.refetch()}
          rechecking={status.isFetching && !status.isLoading}
          periodLabel={periodLabel}
          kind="production"
          accent="amber"
        />
      ) : (
        <RulesPanel scope={scope} accent="amber" />
      )}

      <SectionCard
        title="How production payroll works"
        icon={Info}
        testId="pcp-how-it-works"
        bodyClassName="space-y-1.5 text-xs text-gray-600"
      >
        <p>
          <strong>{info.label}:</strong> {info.calculation.toLowerCase()}, a {info.days}-day period. Pay = total shifts
          earned × salary per shift, computed from the punch-time coverage of the shift segments set in Manage Shifts
          (Production).
        </p>
        <p>
          <strong>Who is paid here</strong> is decided on{" "}
          <Link href="/hr/employees/productionEmployee" className="font-semibold text-amber-700 underline">
            Production Employees
          </Link>
          ; the period of this cycle is in{" "}
          <Link href="/hr/settings?tab=production_payroll" className="font-semibold text-amber-700 underline">
            Settings → Production Payroll
          </Link>{" "}
          and its late rules are in{" "}
          <Link
            href="/hr/settings?tab=late_detection&view=production"
            className="font-semibold text-amber-700 underline"
          >
            Settings → Late Detection → Production
          </Link>
          .
        </p>
        <p>
          <strong>Generating again</strong> never overwrites payroll that exists: employees who already have a payslip
          for the period are left as they are (use Employees → Generate again for one pending payslip). Advances are
          auto-deducted from the monthly repayment schedule configured in the Advances module.
        </p>
      </SectionCard>

      {showGenerate && mayGenerate && status.data && (
        <GenerateDialog
          cycle={cycle}
          period={period}
          status={status.data}
          onClose={() => setShowGenerate(false)}
          onStarted={onPeriodChange}
        />
      )}
    </div>
  );
}
