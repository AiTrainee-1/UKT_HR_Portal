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
import { Skeleton } from "@/components/ui/skeleton";
import { plural } from "@/components/payroll/kit/format";
import { Chip } from "@/components/payroll/kit/parts";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useToast } from "@/hooks/use-toast";
import {
  PAY_CYCLE_INFO,
  usePayrollSettings,
  useProductionSkipCheck,
  type CyclePeriod,
  type PayCycle,
  type ProductionPeriodStatus,
} from "@/lib/api-client/custom-hooks";
import { normalizeWeekStart, weekRunsText } from "../settings/production-payroll/cycles";
import { formatPeriod, skippedFromRoster } from "./logic";

/**
 * "Generate payroll" for the whole roster of one cycle and one period: says what the run will do and which rules it will
 * use, who it will compute and who it leaves alone, and can check beforehand who would be skipped. Employees who already
 * have payroll for the period are left as they are, so it is safe to press again after paying or generating some people
 * one by one. The run itself is the same fire-and-forget request as before (PayrollGenerationContext owns it, so it keeps
 * going after this dialog closes).
 */
export function GenerateDialog({
  cycle,
  period,
  status,
  onClose,
  onStarted,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  status: ProductionPeriodStatus;
  onClose: () => void;
  /** Called as the run starts, so the page keeps showing this period while it is generated. */
  onStarted: (period: CyclePeriod) => void;
}) {
  const { toast } = useToast();
  const { triggerGenerateProduction, isGenerating } = usePayrollGeneration();
  const settings = usePayrollSettings();
  const [checkSkips, setCheckSkips] = useState(false);
  // The real engine, run on every employee inside a transaction that is always rolled back: slow, so only on request.
  const skip = useProductionSkipCheck(checkSkips ? { cycle, ...period } : null);
  const info = PAY_CYCLE_INFO[cycle];
  const ps = settings.data;
  const own = ps?.prodCycles?.[cycle];
  const ready = status.counts.ready;
  const existing = status.counts.generated + status.counts.paid;
  const blocked = status.counts.blocked;
  const blockedPeople = useMemo(() => skippedFromRoster(status.employees), [status.employees]);
  const slabs = (own?.lateSlabs ?? ps?.prodLateDeductionSlabs ?? []).length;

  const handleGenerate = () => {
    if (isGenerating) {
      toast({
        title: "A payroll run is already in progress",
        description: "Wait for it to finish before starting another.",
      });
      return;
    }
    // Fire-and-forget: the PayrollGenerationContext owns the request and the progress polling from here, so generation
    // keeps running and stays visible through the pipeline banner even after this dialog (or the page) unmounts.
    onStarted(period);
    void triggerGenerateProduction({ cycle, periodStart: period.periodStart, periodEnd: period.periodEnd });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg" data-testid="pcp-generate-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-amber-600" /> Generate {info.label} Payroll
          </DialogTitle>
          <DialogDescription>
            Production payroll of the {info.label} cycle for the period below, worked out from attendance. Payroll that
            already exists is left as it is.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto py-1 pr-1">
          <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-3">
            <p className="text-xs font-medium text-amber-700">{info.calculation}</p>
            <p className="text-lg font-black text-amber-900" data-testid="pcp-generate-period">
              {formatPeriod(period)}
            </p>
            <p className="mt-1 text-xs font-semibold text-amber-800">
              {status.periodEnded
                ? "This period has ended - ready to generate."
                : "This period has not ended yet - come back once it has."}
            </p>
          </div>

          <div
            className="space-y-1.5 rounded-xl border bg-white p-3 text-xs text-gray-700"
            data-testid="pcp-generate-who"
          >
            <p>
              <strong data-testid="pcp-generate-ready">{plural(ready, "employee", "employees")}</strong> on the{" "}
              {info.label} cycle will be computed.
            </p>
            {existing > 0 && (
              <p className="text-gray-500">
                {plural(existing, "employee already has", "employees already have")} payroll for this period and{" "}
                {existing === 1 ? "is" : "are"} left as {existing === 1 ? "it is" : "they are"}.
              </p>
            )}
            {blocked > 0 && (
              <div className="text-amber-800">
                <p className="flex items-start gap-1.5">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
                  <span>
                    {plural(blocked, "employee", "employees")} cannot be generated (no salary per shift, or the dates
                    overlap payroll already paid): see Skipped Employees.
                  </span>
                </p>
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto pl-5 text-[11px] text-gray-600">
                  {blockedPeople.map((p) => (
                    <li key={p.employeeId}>
                      <span className="font-semibold text-gray-800">{p.name}</span>{" "}
                      <span className="font-mono text-gray-400">{p.employeeCode}</span> - {p.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <ul className="space-y-1.5 text-xs text-gray-600">
            <li className="flex items-start gap-2">
              <ClipboardList size={13} className="mt-0.5 shrink-0 text-amber-500" />
              Pay = total shifts earned × salary per shift, worked out from each employee's punches in the period.
            </li>
            <li className="flex items-start gap-2">
              <Cog size={13} className="mt-0.5 shrink-0 text-amber-500" />
              Prices late days with the late rules of the {info.label} cycle, and PF / ESI with the production rates.
            </li>
            <li className="flex items-start gap-2">
              <Wallet size={13} className="mt-0.5 shrink-0 text-amber-500" />
              Recovers the advance repayments that fall due in the month the period ends.
            </li>
          </ul>

          <div className="rounded-xl border bg-white p-3" data-testid="pcp-generate-rules">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-700">Rules this run will use</p>
              <Link
                href="/hr/settings?tab=production_payroll"
                className="text-xs font-semibold text-amber-700 hover:underline"
              >
                Review in Settings
              </Link>
            </div>
            {settings.isLoading || !ps ? (
              <div className="mt-2 flex gap-2" data-testid="pcp-generate-rules-loading">
                <Skeleton className="h-5 w-32 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-28 rounded-full" />
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="info">
                  {info.days} days, weeks run {weekRunsText(normalizeWeekStart(own?.weekStart))}
                </Chip>
                <Chip tone="info">
                  {ps.prodAttendanceMode === "strict" ? "Strict attendance" : "Simple attendance"}
                </Chip>
                {ps.prodLateDetectionEnabled ? (
                  <Chip tone="warning">
                    Late: {own?.lateFreeAllowance ?? ps.prodLateFreeAllowance ?? 0} free, {plural(slabs, "slab")}
                  </Chip>
                ) : (
                  <Chip tone="neutral">Late detection off</Chip>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-dashed border-gray-200 p-3">
            {!checkSkips ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-600">
                  Run the real calculation on everyone, without saving anything, to see who would be skipped.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 gap-1.5"
                  onClick={() => setCheckSkips(true)}
                  data-testid="pcp-generate-check"
                >
                  <ScanSearch size={13} /> Check who would be skipped
                </Button>
              </div>
            ) : skip.isLoading || skip.isFetching ? (
              <div className="flex items-center gap-2 text-xs text-gray-600" role="status">
                <Loader2 size={14} className="animate-spin text-amber-600" />
                Checking every employee on the {info.label} cycle for {formatPeriod(period)}…
              </div>
            ) : skip.isError || !skip.data ? (
              <p className="text-xs text-red-700">The check could not be completed. Try again.</p>
            ) : skip.data.skippedCount === 0 ? (
              <p
                className="flex items-center gap-2 text-xs font-semibold text-green-700"
                data-testid="pcp-generate-skips-none"
              >
                <CheckCircle2 size={14} /> Nobody would be skipped: all {skip.data.totalChecked} employees can be paid
                {skip.data.alreadyGenerated > 0 ? ` (${skip.data.alreadyGenerated} already have payroll)` : ""}.
              </p>
            ) : (
              <div className="space-y-1.5" data-testid="pcp-generate-skips">
                <p className="text-xs font-semibold text-amber-800">
                  {skip.data.skippedCount} of {skip.data.totalChecked} would be skipped
                  {skip.data.alreadyGenerated > 0
                    ? `; ${skip.data.alreadyGenerated} already have payroll and are left alone`
                    : ""}
                  :
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
            onClick={handleGenerate}
            disabled={isGenerating || !status.periodEnded || ready === 0}
            className="bg-amber-600 font-bold text-white hover:bg-amber-700"
            data-testid="pcp-generate-confirm"
          >
            {isGenerating ? (
              "A run is already in progress…"
            ) : (
              <>
                <Play size={13} className="mr-1.5" />
                Generate for {plural(ready, "employee", "employees")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
