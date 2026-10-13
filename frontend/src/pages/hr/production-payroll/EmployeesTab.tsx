import { useMemo, useState } from "react";
import { Eye, Play, RefreshCcw, Search, Users } from "lucide-react";
import { Link } from "wouter";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import { BreakdownDrawer } from "@/components/payroll/BreakdownDrawer";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import {
  PAY_CYCLE_INFO,
  useProductionPeriodStatus,
  type CyclePeriod,
  type PayCycle,
  type PeriodEmployee,
  type ProductionPeriods,
} from "@/lib/api-client/custom-hooks";
import { PeriodPicker } from "./PeriodPicker";
import { ROSTER_STATE_LABEL, filterRoster, formatPeriod, rosterState, rupees, type RosterState } from "./logic";

const STATE_BADGE: Record<RosterState, string> = {
  ready: "border-gray-200 bg-gray-100 text-gray-600",
  pending: "border-amber-200 bg-amber-100 text-amber-800",
  paid: "border-emerald-200 bg-emerald-100 text-emerald-800",
  blocked: "border-red-200 bg-red-50 text-red-700",
};

/**
 * Employees tab of a cycle page: the people assigned to the cycle, each with what they have for the chosen period, and
 * the way to generate (or generate again) ONE of them or a handful, instead of the whole roster.
 */
export function EmployeesTab({
  cycle,
  period,
  periods,
  periodsLoading,
  onPeriodChange,
  onPickDate,
}: {
  cycle: PayCycle;
  period: CyclePeriod | null;
  periods: ProductionPeriods | undefined;
  periodsLoading: boolean;
  onPeriodChange: (period: CyclePeriod) => void;
  onPickDate: (date: string) => void;
}) {
  const info = PAY_CYCLE_INFO[cycle];
  const { triggerGenerateProduction, isGenerating, showPipeline, progress, dismiss } = usePayrollGeneration();
  const status = useProductionPeriodStatus(cycle, period);
  const [search, setSearch] = useState("");
  const [state, setState] = useState<RosterState | "all">("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [again, setAgain] = useState<PeriodEmployee | null>(null);
  const [breakdownId, setBreakdownId] = useState<number | null>(null);

  const employees = useMemo(() => status.data?.employees ?? [], [status.data]);
  const shown = useMemo(() => filterRoster(employees, search, state), [employees, search, state]);
  const readyIds = useMemo(() => shown.filter((e) => rosterState(e) === "ready").map((e) => e.employeeId), [shown]);
  const chosen = useMemo(() => readyIds.filter((id) => selected.has(id)), [readyIds, selected]);
  const ended = status.data?.periodEnded ?? false;

  const run = (ids: number[], regenerate = false) => {
    if (!period || ids.length === 0) return;
    onPeriodChange(period);
    void triggerGenerateProduction({
      cycle,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      employeeIds: ids,
      regenerate,
    });
    setSelected(new Set());
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChosen = readyIds.length > 0 && chosen.length === readyIds.length;

  const counts = status.data?.counts;

  return (
    <div className="space-y-4" data-testid="pcp-employees-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker
          periods={periods}
          period={period}
          onChange={onPeriodChange}
          onPickDate={onPickDate}
          loading={periodsLoading}
        />
        {counts && (
          <p className="text-xs text-muted-foreground" data-testid="pcp-roster-counts">
            {employees.length} on the {info.label} cycle · {counts.generated + counts.paid} generated · {counts.ready}{" "}
            ready
            {counts.blocked > 0 ? ` · ${counts.blocked} cannot be generated` : ""}
          </p>
        )}
      </div>

      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismiss} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by employee code or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full pl-8 text-sm"
            data-testid="pcp-roster-search"
          />
        </div>
        <Select value={state} onValueChange={(v) => setState(v as RosterState | "all")}>
          <SelectTrigger className="h-8 w-52 text-sm" data-testid="pcp-roster-state">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees</SelectItem>
            <SelectItem value="ready">{ROSTER_STATE_LABEL.ready}</SelectItem>
            <SelectItem value="pending">{ROSTER_STATE_LABEL.pending}</SelectItem>
            <SelectItem value="paid">{ROSTER_STATE_LABEL.paid}</SelectItem>
            <SelectItem value="blocked">{ROSTER_STATE_LABEL.blocked}</SelectItem>
          </SelectContent>
        </Select>
        {chosen.length > 0 && (
          <div className="ml-auto flex items-center gap-2" data-testid="pcp-roster-bulk">
            <span className="text-xs text-gray-600">{chosen.length} selected</span>
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

      {period && status.data && !ended && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="pcp-not-ended">
          {formatPeriod(period)} has not ended yet: payroll for it can be generated from its last day.
        </p>
      )}

      {status.isError ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-800"
          role="alert"
          data-testid="pcp-period-error"
        >
          {status.error instanceof Error ? status.error.message : "This period could not be loaded."} Pick another pay
          period above.
        </div>
      ) : status.isLoading ? (
        <ShieldLoader />
      ) : employees.length === 0 ? (
        <div
          className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center text-muted-foreground"
          data-testid="pcp-roster-empty"
        >
          <Users size={32} className="mx-auto mb-3 text-gray-200" />
          <p className="text-sm font-semibold text-gray-600">No employees are assigned to the {info.label} cycle yet</p>
          <p className="mt-1 text-xs text-gray-400">Assign production employees to this cycle to pay them here.</p>
          <Button asChild className="mt-4 gap-2 bg-amber-600 hover:bg-amber-700">
            <Link href="/hr/employees/productionEmployee">Open Production Employees</Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm" data-testid="pcp-roster-table">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-8 px-3 py-2">
                  <Checkbox
                    aria-label="Select every employee that can be generated"
                    checked={allChosen}
                    disabled={readyIds.length === 0 || !ended}
                    onCheckedChange={(v) => setSelected(v ? new Set(readyIds) : new Set())}
                    data-testid="pcp-roster-select-all"
                  />
                </th>
                <th className="px-3 py-2 text-left font-semibold text-gray-600">Employee</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-600">Rate / shift</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
                {/* the figures are on the Payroll tab: a phone keeps the columns that fit beside the Generate button */}
                <th className="hidden px-3 py-2 text-left font-semibold text-gray-600 md:table-cell">Shifts</th>
                <th className="hidden px-3 py-2 text-left font-semibold text-gray-600 md:table-cell">Gross</th>
                <th className="hidden px-3 py-2 text-left font-semibold text-gray-600 md:table-cell">Net</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-xs text-muted-foreground">
                    No employee matches the search or status.
                  </td>
                </tr>
              ) : (
                shown.map((e) => {
                  const st = rosterState(e);
                  const p = e.payroll;
                  return (
                    <tr
                      key={e.employeeId}
                      className="hover:bg-gray-50/50"
                      data-testid={`pcp-roster-row-${e.employeeCode}`}
                    >
                      <td className="px-3 py-2">
                        {st === "ready" && (
                          <Checkbox
                            aria-label={`Select ${e.name}`}
                            checked={selected.has(e.employeeId)}
                            disabled={!ended}
                            onCheckedChange={() => toggle(e.employeeId)}
                            data-testid={`pcp-roster-select-${e.employeeCode}`}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-semibold text-gray-900">{e.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {e.employeeCode}
                          {e.departmentName ? ` · ${e.departmentName}` : ""}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {e.salaryPerShift != null && e.salaryPerShift > 0 ? (
                          rupees(e.salaryPerShift)
                        ) : (
                          <span className="font-semibold text-amber-700">Not set</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          className={`border text-xs ${STATE_BADGE[st]}`}
                          data-testid={`pcp-roster-state-${e.employeeCode}`}
                        >
                          {ROSTER_STATE_LABEL[st]}
                        </Badge>
                        {st === "blocked" && (
                          <p className="mt-1 max-w-[16rem] text-[11px] text-red-700">{e.blockedReason}</p>
                        )}
                      </td>
                      <td className="hidden px-3 py-2 md:table-cell">{p ? p.presentDays : "—"}</td>
                      <td className="hidden px-3 py-2 md:table-cell">{p ? rupees(p.grossSalary) : "—"}</td>
                      <td className="hidden px-3 py-2 font-bold text-green-700 md:table-cell">
                        {p ? rupees(p.finalSalary) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          {st === "ready" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-xs"
                              disabled={isGenerating || !ended}
                              onClick={() => run([e.employeeId])}
                              data-testid={`pcp-generate-${e.employeeCode}`}
                            >
                              <Play size={11} /> Generate
                            </Button>
                          )}
                          {st === "pending" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-amber-700"
                              title={`Generate again for ${e.name}: recompute this payslip`}
                              aria-label={`Generate again for ${e.name}`}
                              disabled={isGenerating}
                              onClick={() => setAgain(e)}
                              data-testid={`pcp-regenerate-${e.employeeCode}`}
                            >
                              <RefreshCcw size={13} />
                            </Button>
                          )}
                          {p && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="View the breakdown"
                              aria-label={`View the breakdown for ${e.name}`}
                              onClick={() => setBreakdownId(p.id)}
                            >
                              <Eye size={13} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={!!again} onOpenChange={(open) => !open && setAgain(null)}>
        <AlertDialogContent data-testid="pcp-regenerate-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Generate again for {again?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This recomputes the payslip for {period ? formatPeriod(period) : "the period"} from the attendance as it
              is now. Anything you adjusted on it (bonus or deductions) is replaced, and an advance instalment already
              taken from it is not taken again. A payslip that is already paid is never recomputed.
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

      {breakdownId && <BreakdownDrawer payrollId={breakdownId} onClose={() => setBreakdownId(null)} />}
    </div>
  );
}
