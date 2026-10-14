import { useCallback, useMemo, useState } from "react";
import { Play, Search, SearchX, Users, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import { EmptyNote, SkeletonRows } from "@/components/payroll/kit/parts";
import { openPayrollDetails } from "@/components/payroll/kit/url-state";
import { buildIssueSummaries } from "@/components/payroll/panels/filters";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import {
  PAY_CYCLE_INFO,
  usePayrollIssues,
  usePayrollRules,
  useProductionPeriodStatus,
  type CyclePeriod,
  type PayCycle,
  type PeriodEmployee,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { NotEndedNote, PeriodError } from "./CycleNotices";
import {
  ROSTER_STATE_LABEL,
  ROSTER_STATES,
  filterRoster,
  formatPeriod,
  productionScope,
  rosterStateCounts,
  rosterStateFromUrl,
  rosterState,
  type RosterState,
  type UrlSetter,
} from "./logic";
import { RosterRow, type RosterDataState } from "./RosterRow";

const dataState = (q: { isLoading: boolean; data: unknown }): RosterDataState =>
  q.isLoading ? "loading" : q.data ? "ready" : "unavailable";

/**
 * Employees tab of a cycle page: the people assigned to the cycle, each with what they have for the chosen period (their
 * state, what payroll found, the rules they are paid under), and the way to generate (or generate again) ONE of them or a
 * handful, instead of the whole roster. A generated payroll opens on its own details page.
 */
export function EmployeesTab({
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
  const [, navigate] = useLocation();
  const info = PAY_CYCLE_INFO[cycle];
  const { triggerGenerateProduction, isGenerating, showPipeline, progress, dismiss } = usePayrollGeneration();
  const status = useProductionPeriodStatus(cycle, period);
  const scope = useMemo(() => productionScope(cycle, period), [cycle, period]);
  const issuesQuery = usePayrollIssues(scope);
  const rulesQuery = usePayrollRules(scope);

  const search = url.eq ?? "";
  const stateFilter = rosterStateFromUrl(url.estate);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [again, setAgain] = useState<PeriodEmployee | null>(null);

  const employees = useMemo(() => status.data?.employees ?? [], [status.data]);
  const counts = useMemo(() => rosterStateCounts(employees), [employees]);
  const shown = useMemo(() => filterRoster(employees, search, stateFilter), [employees, search, stateFilter]);
  const readyIds = useMemo(() => shown.filter((e) => rosterState(e) === "ready").map((e) => e.employeeId), [shown]);
  const chosen = useMemo(() => readyIds.filter((id) => selected.has(id)), [readyIds, selected]);
  const allChosen = readyIds.length > 0 && chosen.length === readyIds.length;
  const ended = status.data?.periodEnded ?? false;
  const serverCounts = status.data?.counts;
  const periodLabel = formatPeriod(period);

  const issueSummaries = useMemo(() => buildIssueSummaries(issuesQuery.data?.issues), [issuesQuery.data]);
  const rulesByEmployee = useMemo(
    () => new Map((rulesQuery.data?.employees ?? []).map((r) => [r.employeeId, r])),
    [rulesQuery.data],
  );
  const issuesState = dataState(issuesQuery);
  const rulesState = dataState(rulesQuery);

  // Asks for exactly these employees of this cycle and period (a run never touches anybody else).
  const run = useCallback(
    (ids: number[], regenerate = false) => {
      if (ids.length === 0) return;
      onPeriodChange(period);
      void triggerGenerateProduction({
        cycle,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        employeeIds: ids,
        regenerate,
      });
      setSelected(new Set());
    },
    [cycle, period, onPeriodChange, triggerGenerateProduction],
  );
  const generateOne = useCallback((e: PeriodEmployee) => run([e.employeeId]), [run]);

  const toggle = useCallback(
    (id: number) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const openDetails = useCallback(
    (payrollId: number, section?: string) => openPayrollDetails(navigate, "production", payrollId, section),
    [navigate],
  );

  const filtering = search.trim() !== "" || stateFilter !== "all";
  const clearFilters = () => setUrl({ eq: "", estate: "all" });
  const filterChips: { value: RosterState | "all"; label: string }[] = [
    { value: "all", label: "All" },
    ...ROSTER_STATES.map((s) => ({ value: s, label: ROSTER_STATE_LABEL[s] })),
  ];

  return (
    <div className="space-y-4" data-testid="pcp-employees-tab">
      <div>
        <p className="text-sm font-semibold text-gray-900">
          {periodLabel} · the {info.label} roster
        </p>
        {serverCounts ? (
          <p className="text-xs text-muted-foreground" data-testid="pcp-roster-counts">
            {employees.length} on the {info.label} cycle · {serverCounts.generated + serverCounts.paid} generated ·{" "}
            {serverCounts.ready} ready
            {serverCounts.blocked > 0 ? ` · ${serverCounts.blocked} cannot be generated` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Each employee on the cycle, with what they have for the period
          </p>
        )}
      </div>

      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismiss} />

      <div className="clay-card space-y-3 rounded-2xl border border-slate-100 p-3" data-testid="pcp-roster-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search by employee code or name"
              aria-label="Search the roster by employee name or code"
              value={search}
              onChange={(e) => setUrl({ eq: e.target.value })}
              className="h-10 pl-9"
              disabled={!status.data}
              data-testid="pcp-roster-search"
            />
          </div>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Filter by state"
            data-testid="pcp-roster-filter"
          >
            {filterChips.map((chip) => {
              const on = stateFilter === chip.value;
              return (
                <button
                  key={chip.value}
                  type="button"
                  aria-pressed={on}
                  disabled={!status.data}
                  onClick={() => setUrl({ estate: chip.value })}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50",
                    on
                      ? "border-amber-300 bg-amber-50 text-amber-800 ring-1 ring-amber-200"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
                  )}
                  data-testid={`pcp-roster-filter-${chip.value}`}
                >
                  {chip.label} <span className="tabular-nums opacity-60">{counts[chip.value]}</span>
                </button>
              );
            })}
          </div>
        </div>
        {chosen.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3"
            data-testid="pcp-roster-bulk"
          >
            <span className="text-xs font-semibold text-gray-700">{chosen.length} selected</span>
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-amber-600 hover:bg-amber-700"
              disabled={isGenerating || !ended}
              onClick={() => run(chosen)}
              data-testid="pcp-generate-selected"
            >
              <Play size={12} /> Generate selected ({chosen.length})
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}
      </div>

      {status.data && !ended && <NotEndedNote period={period} />}

      {status.isError ? (
        <PeriodError error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />
      ) : status.isLoading ? (
        <div aria-busy="true" data-testid="pcp-roster-loading">
          <SkeletonRows rows={6} />
        </div>
      ) : employees.length === 0 ? (
        <EmptyNote
          icon={Users}
          title={`No employees are assigned to the ${info.label} cycle yet`}
          hint="Assign production employees to this cycle to pay them here."
          testId="pcp-roster-empty"
          action={
            <Button asChild className="mt-2 gap-2 bg-amber-600 hover:bg-amber-700">
              <Link href="/hr/employees/productionEmployee">Open Production Employees</Link>
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyNote
          icon={SearchX}
          title="No employee matches the search or status"
          hint="Change or clear the search and the state to see the rest of the roster."
          testId="pcp-roster-no-match"
          action={
            filtering ? (
              <Button variant="outline" className="mt-2 gap-1.5" onClick={clearFilters}>
                <X size={13} /> Clear the filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="clay-card overflow-hidden rounded-2xl border border-slate-100" data-testid="pcp-roster-list">
          <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
            <Checkbox
              aria-label="Select every employee that can be generated"
              checked={allChosen}
              disabled={readyIds.length === 0 || !ended}
              onCheckedChange={(v) => setSelected(v ? new Set(readyIds) : new Set())}
              data-testid="pcp-roster-select-all"
            />
            <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="pcp-roster-showing">
              {filtering ? `Showing ${shown.length} of ${employees.length}` : `${employees.length} on the cycle`}
              {readyIds.length > 0 ? ` · ${readyIds.length} can be generated` : ""}
            </p>
          </div>
          <ul className="divide-y divide-slate-100">
            {shown.map((e) => {
              const payrollId = e.payroll?.id;
              return (
                <RosterRow
                  key={e.employeeId}
                  employee={e}
                  selected={selected.has(e.employeeId)}
                  ended={ended}
                  busy={isGenerating}
                  issues={payrollId !== undefined ? issueSummaries.get(payrollId) : undefined}
                  issuesState={issuesState}
                  rules={rulesByEmployee.get(e.employeeId)}
                  rulesState={rulesState}
                  onToggle={toggle}
                  onGenerate={generateOne}
                  onGenerateAgain={setAgain}
                  onOpenDetails={openDetails}
                />
              );
            })}
          </ul>
        </div>
      )}

      <AlertDialog open={!!again} onOpenChange={(open) => !open && setAgain(null)}>
        <AlertDialogContent data-testid="pcp-regenerate-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Generate again for {again?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This recomputes the payslip for {periodLabel} from the attendance as it is now. Anything you adjusted on
              it (bonus or deductions) is replaced, and an advance instalment already taken from it is not taken again.
              A payslip that is already paid is never recomputed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              data-testid="pcp-regenerate-confirm"
              onClick={() => {
                if (again) run([again.employeeId], true);
                setAgain(null);
              }}
            >
              Generate again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
