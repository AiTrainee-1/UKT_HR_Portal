import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardList, Cog, Loader2, Play, ScanSearch, Wallet } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/payroll/kit/parts";
import { StatutoryRulesChip, StatutoryWhoNote } from "@/components/payroll/kit/StatutoryNote";
import { usePfEsiRulesSlice } from "@/components/payroll/kit/statutory-rules";
import { monthYear } from "@/components/payroll/kit/format";
import { MONTH_NAMES } from "@/components/payroll/BreakdownDrawer";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useToast } from "@/hooks/use-toast";
import { useListPayrollRuns } from "@/lib/api-client";
import { usePayrollSettings, usePayrollSkipCheck } from "@/lib/api-client/custom-hooks";
import { existingPayroll, yearOptions } from "./logic";

/**
 * "Generate Staff Payroll": picks the month, says what the run will do and which rules it will use, warns when payroll
 * already exists for that month (a run recomputes every active staff member, and a record that was marked Paid goes back
 * to Pending), and can check beforehand who would be skipped. The run itself is the same fire-and-forget request as
 * before (PayrollGenerationContext owns it, so it keeps going after this dialog closes).
 */
export function GenerateDialog({
  initialMonth,
  initialYear,
  onClose,
  onStarted,
}: {
  initialMonth: number;
  initialYear: number;
  onClose: () => void;
  /** Called as the run starts with the month it was started for, so the page can show that month. */
  onStarted: (month: number, year: number) => void;
}) {
  const { toast } = useToast();
  const { triggerGenerate, isGenerating } = usePayrollGeneration();
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [checkSkips, setCheckSkips] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const existing = useListPayrollRuns({ month, year });
  const settings = usePayrollSettings();
  const statutoryRules = usePfEsiRulesSlice();
  const skip = usePayrollSkipCheck(checkSkips ? { month, year, runType: "monthly" } : null);
  const found = useMemo(() => existingPayroll(existing.data), [existing.data]);
  const years = useMemo(() => yearOptions(new Date().getFullYear()), []);
  const needsConfirm = found.paid > 0;
  const s = settings.data;

  const setPeriod = (m: number, y: number) => {
    setMonth(m);
    setYear(y);
    setCheckSkips(false);
    setUnderstood(false);
  };

  const start = () => {
    if (isGenerating) {
      toast({
        title: "A payroll run is already in progress",
        description: "Wait for it to finish before starting another.",
      });
      return;
    }
    // Fire-and-forget: the PayrollGenerationContext owns the request and the progress polling from here, so generation
    // keeps running and stays visible through the pipeline banner even after this dialog (or the page) unmounts.
    triggerGenerate({ month, year, runType: "monthly" });
    onStarted(month, year);
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg" data-testid="staff-generate-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-indigo-600" /> Generate Staff Payroll
          </DialogTitle>
          <DialogDescription>
            Monthly payroll for every active staff employee, worked out from attendance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Month</Label>
              <select
                value={month}
                onChange={(e) => setPeriod(Number(e.target.value), year)}
                aria-label="Month to generate"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                data-testid="staff-generate-month"
              >
                {MONTH_NAMES.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Year</Label>
              <Input
                type="number"
                value={year}
                onChange={(e) => setPeriod(month, Number(e.target.value))}
                aria-label="Year to generate"
                className="h-9"
                min={years[0]}
                max={years[years.length - 1]}
                data-testid="staff-generate-year"
              />
            </div>
            <p className="col-span-2 text-xs font-semibold text-indigo-900">{monthYear(month, year)}</p>
          </div>

          <ul className="space-y-1.5 text-xs text-gray-600">
            <li className="flex items-start gap-2">
              <ClipboardList size={13} className="mt-0.5 shrink-0 text-indigo-500" />
              Reads each employee's attendance, approved leave and permissions for the month.
            </li>
            <li className="flex items-start gap-2">
              <Cog size={13} className="mt-0.5 shrink-0 text-indigo-500" />
              Prices late arrivals and half days with the rules in Settings (below).
            </li>
            <li className="flex items-start gap-2">
              <Wallet size={13} className="mt-0.5 shrink-0 text-indigo-500" />
              Recovers the advance repayments that fall due this month.
            </li>
          </ul>

          <div className="rounded-xl border bg-white p-3" data-testid="staff-generate-rules">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-700">Rules this run will use</p>
              <Link href="/hr/settings?tab=payroll" className="text-xs font-semibold text-indigo-700 hover:underline">
                Review in Settings
              </Link>
            </div>
            {settings.isLoading || !s ? (
              <div className="mt-2 flex gap-2">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-28 rounded-full" />
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="info">
                  {s.attendanceMode === "strict" ? "Strict attendance (4 punches)" : "Simple attendance"}
                </Chip>
                <StatutoryRulesChip kind="staff" rules={statutoryRules} testId="staff-generate-statutory" />
                <Chip tone="warning">
                  Late: {s.lateFreeAllowance ?? 0} free, {(s.lateDeductionSlabs ?? []).length} slab
                  {(s.lateDeductionSlabs ?? []).length === 1 ? "" : "s"}
                </Chip>
                <Chip tone="neutral">Permission cap {s.permissionMonthlyCap ?? 0} a month</Chip>
              </div>
            )}
            <StatutoryWhoNote
              kind="staff"
              rules={statutoryRules}
              className="mt-3 border-t pt-3"
              testId="staff-generate-statutory-note"
            />
          </div>

          {existing.isLoading ? (
            <Skeleton className="h-12 w-full rounded-xl" />
          ) : found.total > 0 ? (
            <div
              className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              data-testid="staff-generate-existing"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p className="font-semibold">
                  Payroll already exists for {monthYear(month, year)}: {found.total} record
                  {found.total === 1 ? "" : "s"}
                  {found.paid > 0 ? ` (${found.paid} cleared, ${found.pending} pending)` : ""}.
                </p>
                <p>
                  Generating again recomputes every active staff employee
                  {found.paid > 0 ? " and puts the records marked Cleared back to Pending" : ""}.
                </p>
                {needsConfirm && (
                  <label className="mt-1 flex cursor-pointer items-center gap-2 font-semibold">
                    <input
                      type="checkbox"
                      checked={understood}
                      onChange={(e) => setUnderstood(e.target.checked)}
                      data-testid="staff-generate-understood"
                    />
                    I understand, generate again
                  </label>
                )}
              </div>
            </div>
          ) : null}

          <div className="rounded-xl border border-dashed border-gray-200 p-3">
            {!checkSkips ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-600">
                  Find out who has no salary or no working days before you run it.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 gap-1.5"
                  onClick={() => setCheckSkips(true)}
                  data-testid="staff-generate-check"
                >
                  <ScanSearch size={13} /> Check who would be skipped
                </Button>
              </div>
            ) : skip.isLoading || skip.isFetching ? (
              <div className="flex items-center gap-2 text-xs text-gray-600" role="status">
                <Loader2 size={14} className="animate-spin text-indigo-600" />
                Checking every active staff employee for {monthYear(month, year)}…
              </div>
            ) : skip.isError || !skip.data ? (
              <p className="text-xs text-red-700">The check could not be completed. Try again.</p>
            ) : skip.data.skippedCount === 0 ? (
              <p className="flex items-center gap-2 text-xs font-semibold text-green-700">
                <CheckCircle2 size={14} /> Nobody would be skipped: all {skip.data.totalChecked} active staff can be
                paid.
              </p>
            ) : (
              <div className="space-y-1.5" data-testid="staff-generate-skips">
                <p className="text-xs font-semibold text-amber-800">
                  {skip.data.skippedCount} of {skip.data.totalChecked} would be skipped:
                </p>
                <ul className="max-h-28 space-y-1 overflow-y-auto text-xs text-gray-600">
                  {skip.data.skipped.map((p) => (
                    <li key={p.employeeId}>
                      <span className="font-semibold text-gray-800">{p.name}</span>{" "}
                      <span className="font-mono text-gray-400">{p.employeeCode}</span> - {p.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={start}
            disabled={isGenerating || (needsConfirm && !understood)}
            className="bg-indigo-600 font-bold text-white hover:bg-indigo-700"
            data-testid="staff-generate-confirm"
          >
            {isGenerating ? (
              "A run is already in progress…"
            ) : (
              <>
                <Play size={13} className="mr-1.5" />
                Generate Staff Payroll
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
