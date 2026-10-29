import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { FileSpreadsheet, FileText, Printer, RefreshCw, Rows3, Search, SearchX, X } from "lucide-react";
import {
  useSalaryStatement,
  type PayrollListFilters,
  type PayrollScope,
  type StatementRow,
} from "@/lib/api-client/custom-hooks";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { plural } from "@/components/payroll/kit/format";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { ACCENT } from "./accent";
import { SalaryStatementView, type StatementView } from "./SalaryStatementView";
import {
  ALL,
  departmentOptions,
  filterStatement,
  isFiltering,
  statementFileStem,
  statementRowCount,
  type StatementAccent,
  type StatementFilters,
} from "./statement-model";

/** What the toolbar holds. The panel keeps it itself; a page that wants it in the address passes `uiState`. */
export type StatementUiState = {
  search: string;
  /** A department's group key, or "all". */
  department: string;
  /** "all" | "paid" | "pending". */
  status: string;
  view: StatementView;
};

export const DEFAULT_STATEMENT_UI: StatementUiState = { search: "", department: ALL, status: ALL, view: "scroll" };

export type SalaryStatementPanelProps = {
  /** One month of staff payroll, or one period of one production pay cycle. */
  scope: PayrollScope;
  /** Optional narrowing the server applies (department / employee / branch). */
  filters?: PayrollListFilters;
  /** Indigo on Staff Payroll, amber on Production Payroll. */
  accent: StatementAccent;
  /** A click on an employee's name: open that payroll's details page. */
  onOpenDetails?: (row: StatementRow) => void;
  /** An extra "Actions" column with whatever the page wants on each row. */
  renderRowActions?: (row: StatementRow) => ReactNode;
  /** More controls at the end of the toolbar (the page's own buttons). */
  extraToolbar?: ReactNode;
  /** More filters beside the search, department and status (a branch select): read-only controls, so a View Only role can use them. */
  extraFilters?: ReactNode;
  /** The company logo as a data URL, for the Excel and PDF files. Optional. */
  logoDataUrl?: string | null;
  /** Keep the toolbar's state somewhere else (the address): the panel then reads it from here and reports changes. */
  uiState?: StatementUiState;
  onUiStateChange?: (patch: Partial<StatementUiState>) => void;
};

const STATUS_OPTIONS = [
  { value: ALL, label: "All statuses" },
  { value: "paid", label: "Cleared" },
  { value: "pending", label: "Pending" },
];

/**
 * The Salary tab of a payroll page: the Salary Statement (in the printed statement's format) with its toolbar - search,
 * department, status, Scroll / Pages, refresh and Export (Excel, PDF, Print). Loads its own data; the exports and the
 * on-screen statement both use the rows that are filtered in, with the totals recomputed for them.
 */
export function SalaryStatementPanel({
  scope,
  filters,
  accent,
  onOpenDetails,
  renderRowActions,
  extraToolbar,
  extraFilters,
  logoDataUrl,
  uiState,
  onUiStateChange,
}: SalaryStatementPanelProps) {
  const { toast } = useToast();
  const query = useSalaryStatement(scope, filters);
  const statement = query.data;

  const [own, setOwn] = useState<StatementUiState>(DEFAULT_STATEMENT_UI);
  const ui = uiState ?? own;
  const update = (patch: Partial<StatementUiState>) => {
    if (!uiState) setOwn((s) => ({ ...s, ...patch }));
    onUiStateChange?.(patch);
  };

  const departments = useMemo(() => (statement ? departmentOptions(statement) : []), [statement]);
  // a department that is not in this statement (the period changed under the filter) filters nothing
  const department = departments.some((d) => d.key === ui.department) ? ui.department : ALL;
  const narrow = useMemo<StatementFilters>(
    () => ({ search: ui.search, department, status: ui.status }),
    [ui.search, department, ui.status],
  );
  // the table follows the filters a beat behind the keys: typing stays smooth on a statement of a thousand rows
  const applied = useDeferredValue(narrow);
  const filtering = isFiltering(applied);
  const shown = useMemo(() => (statement ? filterStatement(statement, applied) : undefined), [statement, applied]);
  const total = statement ? statementRowCount(statement) : 0;
  const count = shown ? statementRowCount(shown) : 0;
  const a = ACCENT[accent];

  const clear = () => update({ search: "", department: ALL, status: ALL });

  const items: ExportItem[] = [
    {
      key: "xlsx",
      label: "Excel statement",
      hint: "Styled workbook, one sheet",
      icon: FileSpreadsheet,
      run: async () => {
        if (!shown) return;
        const { downloadStatementXlsx } = await import("./export-statement-xlsx");
        await downloadStatementXlsx(shown, { logoDataUrl });
        toast({ title: "Excel statement downloaded", description: `${statementFileStem(shown)}.xlsx` });
      },
    },
    {
      key: "pdf",
      label: "PDF statement",
      hint: "A4 landscape pages with page numbers",
      icon: FileText,
      run: async () => {
        if (!shown) return;
        const { downloadStatementPdf } = await import("./export-statement-pdf");
        await downloadStatementPdf(shown, { logoDataUrl });
        toast({ title: "PDF statement downloaded", description: `${statementFileStem(shown)}.pdf` });
      },
    },
    {
      key: "print",
      label: "Print",
      hint: "Opens the print dialog",
      icon: Printer,
      run: async () => {
        if (!shown) return;
        const { printStatement } = await import("./print-statement");
        printStatement(shown);
      },
    },
  ];

  const noMatch = !!statement && total > 0 && count === 0;

  return (
    <section className="min-w-0 space-y-3" aria-label="Salary statement" data-testid="statement-panel">
      <div className="clay-card rounded-2xl border border-slate-100 p-3" data-testid="statement-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          {/* read-only controls: a View Only role can use all of them */}
          <div className="flex min-w-0 flex-wrap items-center gap-2" {...{ [VIEW_SAFE_ATTR]: "" }}>
            <div className="relative min-w-[11rem] flex-1 sm:w-60 sm:flex-none">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={ui.search}
                onChange={(e) => update({ search: e.target.value })}
                placeholder="Search name or ID no"
                aria-label="Search the statement by name or ID number"
                className="h-9 pl-8 pr-8 text-sm"
                disabled={!statement}
                data-testid="statement-search"
              />
              {ui.search && (
                <button
                  type="button"
                  onClick={() => update({ search: "" })}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  data-testid="statement-search-clear"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <Select value={department} onValueChange={(v) => update({ department: v })} disabled={!statement}>
              <SelectTrigger
                className="h-9 w-[11.5rem] text-sm"
                aria-label="Department"
                data-testid="statement-department"
              >
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.key} value={d.key}>
                    {d.label} ({d.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={ui.status} onValueChange={(v) => update({ status: v })} disabled={!statement}>
              <SelectTrigger
                className="h-9 w-[9.5rem] text-sm"
                aria-label="Payment status"
                data-testid="statement-status"
              >
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {extraFilters}
            <PillTabs
              size="sm"
              baseColor={a.pill}
              value={ui.view}
              onChange={(v) => update({ view: v as StatementView })}
              items={[
                { value: "scroll", label: "Scroll", icon: <Rows3 size={13} /> },
                { value: "pages", label: "Pages", icon: <FileText size={13} /> },
              ]}
            />
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="statement-count">
              {!shown
                ? query.isError
                  ? "Not loaded"
                  : "Loading..."
                : filtering
                  ? `Showing ${count} of ${plural(total, "employee")}`
                  : `${plural(total, "employee")} in ${plural(shown.counts.departments, "department")}`}
            </p>
            <div className="flex items-center gap-2" {...{ [VIEW_SAFE_ATTR]: "" }}>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                aria-label="Refresh the statement"
                title="Refresh"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                data-testid="statement-refresh"
              >
                <RefreshCw size={14} className={cn(query.isFetching && "animate-spin")} />
              </Button>
              <ExportMenu
                testId="statement-export"
                items={items}
                disabled={!shown || count === 0}
                heading={
                  shown
                    ? filtering
                      ? `Exports the ${count} of ${plural(total, "employee")} on screen`
                      : `Exports all ${plural(total, "employee")}`
                    : undefined
                }
              />
            </div>
            {extraToolbar}
          </div>
        </div>
      </div>

      {noMatch ? (
        <EmptyNote
          icon={SearchX}
          title="No employee matches these filters"
          hint="Try another name or ID no, or clear the filters to see everyone."
          action={
            <Button variant="outline" size="sm" onClick={clear} data-testid="statement-clear-filters">
              Clear filters
            </Button>
          }
          testId="statement-no-match"
        />
      ) : (
        <SalaryStatementView
          statement={shown}
          loading={query.isFetching}
          error={query.error}
          onRetry={() => void query.refetch()}
          accent={accent}
          onOpenDetails={onOpenDetails}
          renderRowActions={renderRowActions}
          view={ui.view}
        />
      )}
    </section>
  );
}
