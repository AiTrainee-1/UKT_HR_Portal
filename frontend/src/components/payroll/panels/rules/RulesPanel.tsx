import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  ListChecks,
  SearchX,
  Settings2,
  Users,
} from "lucide-react";
import { exportTableToCsv, exportTableToExcel } from "@/components/payroll/kit/export-table";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { fileStem, plural } from "@/components/payroll/kit/format";
import { Avatar, Chip, EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  usePayrollRules,
  usePayrollSettings,
  type EmployeeRules,
  type PayrollKind,
  type PayrollListFilters,
  type PayrollScope,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { NO_DEPARTMENT, departmentsOf, errorDetail, paginateRows } from "../issues/lists";
import {
  FALLBACK_COMPANY,
  FilterSelect,
  LoadError,
  ResetButton,
  SearchField,
  type FilterOption,
  type PanelAccent,
} from "../issues/panel-kit";
import { RuleGroupCard } from "./RuleRows";
import {
  NO_RULE_FILTERS,
  countRuleProblems,
  countRules,
  filterEmployeeRules,
  flagLabel,
  flagTone,
  chipKindLabel,
  ruleFiltersActive,
  rulesExportColumns,
  type RuleFilterState,
} from "./rules-logic";

export type RulesPanelProps = {
  /** The month (staff) or the pay period of one cycle (production) whose rules are shown. */
  scope: PayrollScope;
  /** Narrowing the server applies (a department, an employee, a branch). */
  filters?: PayrollListFilters;
  /** Staff Payroll is indigo, Production Payroll amber. */
  accent: PanelAccent;
};

export const RULES_PAGE_SIZE = 25;

const NO_EMPLOYEES: EmployeeRules[] = [];

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4" data-testid="rules-panel" {...{ [VIEW_SAFE_ATTR]: "" }}>
      {children}
    </div>
  );
}

function RulesSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading rules" data-testid="rules-loading">
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
      <Skeleton className="h-12 w-full rounded-2xl" />
      <SkeletonRows rows={5} />
    </div>
  );
}

/** The flags of one employee as warning chips, or a green "All set". */
function Flags({ flags, kind }: { flags: string[]; kind: PayrollKind }) {
  if (flags.length === 0) {
    return (
      <Chip tone="success" icon={CheckCircle2}>
        All set
      </Chip>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="rules-flags">
      {flags.map((flag) => (
        <Chip key={flag} tone={flagTone(flag)} icon={AlertTriangle}>
          {flagLabel(flag, kind)}
        </Chip>
      ))}
    </div>
  );
}

export function RulesPanel({ scope, filters, accent }: RulesPanelProps) {
  const query = usePayrollRules(scope, filters);
  const { data: settings } = usePayrollSettings();
  const data = query.data;
  const switchId = useId();

  const kind = scope.kind;
  const employees = data?.employees ?? NO_EMPLOYEES;
  const [rf, setRf] = useState<RuleFilterState>(NO_RULE_FILTERS);
  const shown = useMemo(() => filterEmployeeRules(employees, rf, kind), [employees, rf, kind]);
  const departments = useMemo(() => departmentsOf(employees), [employees]);
  const problems = useMemo(() => countRuleProblems(employees), [employees]);
  const columns = useMemo(() => rulesExportColumns(employees, kind), [employees, kind]);

  // The page number belongs to the view it was chosen in.
  const viewKey = `${JSON.stringify(scope)}|${JSON.stringify(filters ?? null)}|${rf.q}|${rf.dept}|${rf.problemsOnly}`;
  const [pageState, setPageState] = useState({ key: viewKey, page: 1 });
  const page = paginateRows(shown, pageState.key === viewKey ? pageState.page : 1, RULES_PAGE_SIZE);

  // Which employees' rows are opened to show all their rules.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (query.isLoading || (!data && !query.isError)) {
    return (
      <Shell>
        <RulesSkeleton />
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <LoadError
          what="the rules"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="rules-error"
        />
      </Shell>
    );
  }

  const active = ruleFiltersActive(rf);
  const patch = (change: Partial<RuleFilterState>) => setRf((prev) => ({ ...prev, ...change }));
  const reset = () => setRf(NO_RULE_FILTERS);
  const scopeLabel = data.scope?.label ?? "";
  const departmentOptions: FilterOption[] = [
    ...departments.names.map((name) => ({ value: name, label: name })),
    ...(departments.hasNone ? [{ value: NO_DEPARTMENT, label: "No department" }] : []),
  ];

  // ── Export: the employees shown by the filters (every page) ──
  const company = settings?.companyName || FALLBACK_COMPANY;
  const exportName = fileStem(...(kind === "production" ? ["Production"] : []), "Payroll", "Rules", scopeLabel);
  const exportSubtitle = [
    kind === "production" ? "Production Payroll" : "Staff Payroll",
    scopeLabel,
    active > 0 ? "Filtered" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const countText = `${plural(shown.length, "employee")}${active > 0 ? ", filtered" : ""}`;
  const exportItems: ExportItem[] = [
    {
      key: "excel",
      label: "Excel (.xlsx)",
      hint: `${countText}, a column for each kind of rule`,
      icon: FileSpreadsheet,
      disabled: shown.length === 0,
      run: () =>
        exportTableToExcel<EmployeeRules>({
          rows: shown,
          columns,
          filename: exportName,
          sheetName: "Employee rules",
          company,
          subtitle: exportSubtitle,
          title: "Rules assigned to each employee",
        }),
    },
    {
      key: "csv",
      label: "CSV",
      hint: `${countText}, plain text`,
      icon: FileText,
      disabled: shown.length === 0,
      run: () => exportTableToCsv<EmployeeRules>({ rows: shown, columns, filename: exportName }),
    },
  ];

  return (
    <Shell>
      {/* (a) the rules configured on the Settings page */}
      <SectionCard
        id="rules-settings"
        testId="rules-settings"
        icon={Settings2}
        title="Rules configured on the Settings page"
        description={
          scopeLabel
            ? `What payroll for ${scopeLabel} is calculated with. Each rule links to the Settings page where it is changed.`
            : "What payroll is calculated with. Each rule links to the Settings page where it is changed."
        }
      >
        {data.settings.length === 0 ? (
          <EmptyNote
            icon={ListChecks}
            title="No rules to show"
            hint="Rules appear here once payroll settings are available for this period."
            testId="rules-settings-empty"
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2" data-testid="rules-settings-groups">
            {data.settings.map((group, i) => (
              <RuleGroupCard key={`${group.group}-${i}`} group={group} accent={accent} testId={`rules-group-${i}`} />
            ))}
          </div>
        )}
      </SectionCard>

      {/* (b) the rules assigned to each employee */}
      <SectionCard
        id="rules-employees"
        testId="rules-employees"
        icon={Users}
        title="Rules assigned to each employee"
        description="The shift, late rules, pay cycle and other rules that apply to each person. A warning marks an assignment that needs fixing before payroll."
        actions={
          <ExportMenu
            items={exportItems}
            testId="rules-export"
            heading="Export the employees shown (every page)"
            className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
          />
        }
        bodyClassName="space-y-3"
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center" role="search" aria-label="Filter employees">
          <SearchField
            value={rf.q}
            onChange={(q) => patch({ q })}
            placeholder="Search by name, code, department, shift or flag"
            label="Search employees"
            testId="rules-search"
            className="lg:flex-1"
          />
          <FilterSelect
            value={rf.dept}
            onChange={(dept) => patch({ dept })}
            options={departmentOptions}
            allLabel="All departments"
            label="Filter by department"
            testId="rules-dept"
            className="lg:w-52"
          />
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <Switch
              id={switchId}
              checked={rf.problemsOnly}
              onCheckedChange={(on) => patch({ problemsOnly: on })}
              aria-label="Only employees with rule problems"
              data-testid="rules-problems-switch"
            />
            <label htmlFor={switchId} className="cursor-pointer text-xs font-semibold text-gray-700">
              Only employees with rule problems <span className="text-muted-foreground">({problems})</span>
            </label>
          </div>
          {active > 0 && <ResetButton count={active} onClick={reset} testId="rules-reset" />}
        </div>

        <p className="px-1 text-xs text-muted-foreground" aria-live="polite" data-testid="rules-showing">
          {[
            page.total > 0
              ? `Showing ${page.from === page.to ? page.from : `${page.from}–${page.to}`} of ${plural(page.total, "employee")}`
              : employees.length > 0
                ? "No employees match"
                : null,
            active > 0 && employees.length !== page.total ? `${employees.length} in this period` : null,
            problems > 0 ? `${problems} with a rule problem` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {employees.length === 0 ? (
          <EmptyNote
            icon={Users}
            title="No employees to show"
            hint="Rules are listed for the employees who have payroll for this period. Generate payroll, and they will appear here."
            testId="rules-empty"
          />
        ) : shown.length === 0 ? (
          <EmptyNote
            icon={SearchX}
            title="Nothing matches these filters"
            hint="Try a different search, or reset the filters to see every employee."
            testId="rules-no-match"
            action={
              <Button type="button" variant="outline" onClick={reset}>
                Reset filters
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white">
            <table className="w-full min-w-[820px] text-sm" data-testid="rules-table">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2.5">Employee</th>
                  <th className="px-3 py-2.5">Department</th>
                  <th className="px-3 py-2.5">Rules</th>
                  <th className="px-3 py-2.5">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {page.rows.map((e) => {
                  const opened = open.has(e.employeeId);
                  const key = e.employeeCode || String(e.employeeId);
                  const panelId = `${switchId}-${e.employeeId}`;
                  return (
                    <Fragment key={e.employeeId}>
                      <tr
                        className={cn("align-top hover:bg-gray-50/60", opened && "bg-slate-50/60")}
                        data-testid={`rules-row-${key}`}
                        data-problem={e.flags.length > 0 ? "true" : undefined}
                      >
                        <td className="px-3 py-3">
                          <button
                            type="button"
                            aria-expanded={opened}
                            aria-controls={panelId}
                            aria-label={`${opened ? "Hide" : "Show"} all rules of ${e.employeeName}`}
                            onClick={() => toggle(e.employeeId)}
                            className="flex min-w-0 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            data-testid={`rules-expand-${key}`}
                          >
                            <ChevronRight
                              size={16}
                              className={cn("shrink-0 text-gray-400 transition-transform", opened && "rotate-90")}
                              aria-hidden="true"
                            />
                            <Avatar name={e.employeeName} size={32} />
                            <span className="min-w-0">
                              <span className="block font-semibold text-gray-900">{e.employeeName}</span>
                              <span className="block font-mono text-xs text-muted-foreground">
                                {e.employeeCode || "—"}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className="px-3 py-3 text-gray-700">
                          <span className="block">{e.department ?? "—"}</span>
                          {e.designation && (
                            <span className="block text-xs text-muted-foreground">{e.designation}</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {e.chips.length === 0 ? (
                            <span className="text-gray-400">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5" data-testid="rules-chips">
                              {e.chips.map((chip, i) => (
                                <Chip key={`${chip.key}-${i}`} tone={chip.tone} title={chipKindLabel(chip.key)}>
                                  {chip.label}
                                </Chip>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <Flags flags={e.flags} kind={kind} />
                        </td>
                      </tr>
                      {opened && (
                        <tr className="bg-slate-50/40" data-testid={`rules-detail-${key}`}>
                          <td colSpan={4} className="px-3 py-3">
                            <div id={panelId}>
                              {countRules(e.groups) === 0 ? (
                                <p className="px-1 text-xs text-muted-foreground">
                                  No individual rules are recorded for this employee.
                                </p>
                              ) : (
                                <div className="grid gap-3 lg:grid-cols-2">
                                  {e.groups.map((group, i) => (
                                    <RuleGroupCard
                                      key={`${group.group}-${i}`}
                                      group={group}
                                      employeeId={e.employeeId}
                                      accent={accent}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <DataPagination
          page={page.page}
          totalPages={page.totalPages}
          totalItems={page.total}
          pageSize={RULES_PAGE_SIZE}
          onPageChange={(next) => setPageState({ key: viewKey, page: next })}
        />
      </SectionCard>
    </Shell>
  );
}
