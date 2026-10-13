import { Info, Play, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import {
  PAY_CYCLE_INFO,
  usePayrollSettings,
  type CyclePeriod,
  type PayCycle,
  type ProductionPeriodStatus,
} from "@/lib/api-client/custom-hooks";
import { normalizeWeekStart, weekRunsText } from "../settings/production-payroll/cycles";
import { formatPeriod } from "./logic";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Generate payroll" for the whole roster of one cycle and one period. Employees who already have payroll for the
 * period are left alone, so it is safe to press again after paying or generating some people one by one.
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
  const { data: ps } = usePayrollSettings();
  const info = PAY_CYCLE_INFO[cycle];
  const own = ps?.prodCycles?.[cycle];
  const ready = status.counts.ready;
  const existing = status.counts.generated + status.counts.paid;
  const blocked = status.counts.blocked;

  const handleGenerate = () => {
    if (isGenerating) {
      toast({
        title: "A payroll run is already in progress",
        description: "Wait for it to finish before starting another.",
      });
      return;
    }
    onStarted(period);
    void triggerGenerateProduction({ cycle, periodStart: period.periodStart, periodEnd: period.periodEnd });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md" data-testid="pcp-generate-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-amber-600" /> Generate {info.label} Payroll
          </DialogTitle>
          <DialogDescription className="sr-only">
            Computes the {info.label} payroll of the period shown for the employees on the {info.label} cycle. Payroll
            that already exists is left as it is.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border-2 border-amber-500 bg-amber-50 p-3">
            <p className="text-xs font-medium text-amber-700">{info.calculation}</p>
            <p className="text-lg font-black text-amber-900" data-testid="pcp-generate-period">
              {formatPeriod(period)}
            </p>
            <p className="mt-1 text-xs text-amber-700">
              {status.periodEnded
                ? "This period has ended - ready to generate."
                : "This period has not ended yet - come back once it has."}
            </p>
          </div>

          <div className="space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
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
              <p className="text-amber-700">
                {plural(blocked, "employee", "employees")} cannot be generated (no salary per shift, or the dates
                overlap payroll already paid): see Skipped Employees.
              </p>
            )}
          </div>

          {ps && (
            <div className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="flex items-center gap-1.5 text-xs font-bold text-gray-600">
                <SlidersHorizontal size={12} /> Configuration in effect
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
                <span className="text-gray-400">Period</span>
                <span className="font-medium">
                  {info.days} days, weeks run {weekRunsText(normalizeWeekStart(own?.weekStart))}
                </span>
                <span className="text-gray-400">Attendance Mode</span>
                <span className="font-medium capitalize">{ps.prodAttendanceMode}</span>
                <span className="text-gray-400">Late Detection</span>
                <span className="font-medium">
                  {ps.prodLateDetectionEnabled ? (
                    <>
                      Enabled · {own?.lateFreeAllowance ?? ps.prodLateFreeAllowance ?? 0} free ·{" "}
                      {plural((own?.lateSlabs ?? ps.prodLateDeductionSlabs ?? []).length, "slab", "slabs")}
                    </>
                  ) : (
                    "Disabled"
                  )}
                </span>
              </div>
              <p className="text-[11px] text-gray-400">Change these in Settings → Production Payroll.</p>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 p-3">
            <Info size={14} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-800">
              Pay = total shifts earned × salary per shift, computed from punch-time coverage of the period. Only
              employees assigned to the {info.label} cycle are paid on this page.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || !status.periodEnded || ready === 0}
            className="bg-amber-600 hover:bg-amber-700"
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
