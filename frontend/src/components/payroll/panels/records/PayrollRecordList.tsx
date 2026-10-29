import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LayoutGrid, Table2 } from "lucide-react";
import { DataPagination } from "@/components/ui/DataPagination";
import type { EmployeeRules, PayrollKind, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { SkeletonRows } from "@/components/payroll/kit/parts";
import { cn } from "@/lib/utils";
import type { PayrollIssueSummary } from "../filters/filter-logic";
import { PayrollRecordCard } from "./PayrollRecordCard";
import { PayrollRecordTable } from "./PayrollRecordTable";
import { issuesOf, listSignature, pageSlice } from "./records-logic";

/** What the list needs of an employee's rules: the chips, and the designation when the rules data has it. `EmployeeRules` fits. */
export type RecordRules = Pick<EmployeeRules, "chips"> & Partial<Pick<EmployeeRules, "designation">>;

export type RecordLayout = "cards" | "table";

export type PayrollRecordListProps = {
  /** The rows to list, already filtered and sorted by the page (`applyPayrollFilters`). */
  runs: PayrollRunItem[];
  kind: PayrollKind;
  accent: "indigo" | "amber";
  /** The first load of the rows: skeleton rows show instead of the list. */
  loading?: boolean;
  /**
   * Each payroll's issues by payroll id (`buildIssueSummaries(issues)`). Once the issues are loaded a payroll the map
   * does not list has none ("No issues"). Leave it out, or set `issuesLoading`, until they are.
   */
  issuesByPayroll?: ReadonlyMap<number, PayrollIssueSummary>;
  /** The first load of the issues: a placeholder shows where each payroll's badges will be. */
  issuesLoading?: boolean;
  /** Each employee's rules by EMPLOYEE id (`new Map(rules.employees.map((e) => [e.employeeId, e]))`). */
  rulesByEmployee?: ReadonlyMap<number, RecordRules>;
  rulesLoading?: boolean;
  /** Rows per page to start with; the pager lets the reader change it. */
  pageSize?: number;
  onOpenDetails: (run: PayrollRunItem) => void;
  /** Opens the details page at its issues section. */
  onOpenIssues?: (run: PayrollRunItem) => void;
  onMarkPaid: (run: PayrollRunItem) => void;
  /** The row whose "Mark as Cleared" is running. */
  markingId?: number | null;
  /** Shown instead of the list when there are no rows (the page knows whether a filter or no payroll is the reason). */
  empty: ReactNode;
  /** Cards or Table. Leave out to let the list keep it (it starts on Cards); give it to keep it in the address. */
  layout?: RecordLayout;
  onLayoutChange?: (layout: RecordLayout) => void;
  testId?: string;
};

const ACCENT_ACTIVE = { indigo: "bg-indigo-600 text-white", amber: "bg-amber-600 text-white" } as const;

function LayoutToggle({
  layout,
  accent,
  onChange,
}: {
  layout: RecordLayout;
  accent: "indigo" | "amber";
  onChange: (layout: RecordLayout) => void;
}) {
  const options = [
    { value: "cards" as const, label: "Cards", icon: LayoutGrid },
    { value: "table" as const, label: "Table", icon: Table2 },
  ];
  return (
    <div role="group" aria-label="Layout of the payroll list" className="inline-flex rounded-xl border bg-white p-0.5">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={layout === value}
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs font-semibold transition-colors",
            layout === value ? ACCENT_ACTIVE[accent] : "text-gray-600 hover:bg-gray-50",
          )}
          data-testid={`payroll-record-layout-${value}`}
        >
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The payroll rows as a paged list of cards (or a compact table), with the shared loaders: skeleton rows while the first
 * load runs, a placeholder where the issue badges and rule chips are still coming, and `empty` when there is nothing to
 * list. Goes back to page 1 when the rows listed change (a new filter or sort), not when one row's status does.
 */
export function PayrollRecordList({
  runs,
  kind,
  accent,
  loading = false,
  issuesByPayroll,
  issuesLoading = false,
  rulesByEmployee,
  rulesLoading = false,
  pageSize = 20,
  onOpenDetails,
  onOpenIssues,
  onMarkPaid,
  markingId = null,
  empty,
  layout: layoutProp,
  onLayoutChange,
  testId = "payroll-record-list",
}: PayrollRecordListProps) {
  const [layoutState, setLayoutState] = useState<RecordLayout>("cards");
  const layout = layoutProp ?? layoutState;
  const setLayout = (next: RecordLayout) => {
    if (layoutProp === undefined) setLayoutState(next);
    onLayoutChange?.(next);
  };

  const [size, setSize] = useState(pageSize);
  useEffect(() => setSize(pageSize), [pageSize]);
  const [page, setPage] = useState(1);
  const signature = useMemo(() => listSignature(runs), [runs]);
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    // Another set of rows (a filter, a sort): start again from the first page.
    setSeen(signature);
    setPage(1);
  }
  const view = useMemo(() => pageSlice(runs, page, size), [runs, page, size]);

  if (loading) {
    return (
      <div data-testid={testId} aria-busy="true">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (runs.length === 0) return <div data-testid={testId}>{empty}</div>;

  const sizes = [...new Set([10, 20, 50, 100, size])].sort((a, b) => a - b);

  return (
    <div className="min-w-0 space-y-3" data-testid={testId} data-layout={layout}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500" data-testid="payroll-record-showing">
          Showing {view.from}-{view.to} of {view.total}
        </p>
        <LayoutToggle layout={layout} accent={accent} onChange={setLayout} />
      </div>

      {layout === "table" ? (
        <PayrollRecordTable
          rows={view.items}
          allRows={runs}
          accent={accent}
          issuesByPayroll={issuesByPayroll}
          issuesLoading={issuesLoading}
          onOpenDetails={onOpenDetails}
          onOpenIssues={onOpenIssues}
          onMarkPaid={onMarkPaid}
          markingId={markingId}
        />
      ) : (
        <div className="space-y-3" data-testid="payroll-record-cards">
          {view.items.map((run) => {
            const rules = rulesByEmployee?.get(run.employeeId);
            return (
              <PayrollRecordCard
                key={run.id}
                run={run}
                kind={kind}
                accent={accent}
                issueSummary={issuesOf(issuesByPayroll, run.id, issuesLoading)}
                issuesLoading={issuesLoading}
                chips={rules?.chips}
                chipsLoading={rulesLoading}
                designation={rules?.designation}
                onOpenDetails={onOpenDetails}
                onOpenIssues={onOpenIssues}
                onMarkPaid={onMarkPaid}
                marking={markingId === run.id}
              />
            );
          })}
        </div>
      )}

      <DataPagination
        page={view.page}
        totalPages={view.totalPages}
        totalItems={view.total}
        pageSize={size}
        pageSizes={sizes}
        onPageChange={setPage}
        onPageSizeChange={view.total > 10 ? setSize : undefined}
        className="px-1"
      />
    </div>
  );
}
