import { useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PAY_CYCLE_INFO,
  useProductionSkipCheck,
  type CyclePeriod,
  type PayCycle,
  type ProductionPeriods,
} from "@/lib/api-client/custom-hooks";
import { formatPeriod, periodFromValue, periodOptionLabel, periodValue } from "./logic";

/**
 * Read-only dry run for one cycle and period: who a Generate would skip and why. Each person runs the real engine
 * inside a transaction that is always rolled back, so nothing is written. Opened on demand: it is the slowest call.
 */
export function SkippedDialog({
  cycle,
  initial,
  periods,
  onClose,
}: {
  cycle: PayCycle;
  initial: CyclePeriod;
  periods: ProductionPeriods | undefined;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState<CyclePeriod>(initial);
  const { data, isLoading, isFetching, refetch } = useProductionSkipCheck({ cycle, ...period });
  const info = PAY_CYCLE_INFO[cycle];
  const rows = periods?.periods ?? [];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg" data-testid="pcp-skipped-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" /> Skipped Employees
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {info.label} · {formatPeriod(period)}
          </p>
        </DialogHeader>

        {rows.length > 1 && (
          <select
            value={periodValue(period)}
            onChange={(e) => {
              const next = periodFromValue(e.target.value);
              if (next) setPeriod(next);
            }}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            aria-label="Pay period to check"
          >
            {rows.map((row) => (
              <option key={periodValue(row)} value={periodValue(row)}>
                {periodOptionLabel(row, periods?.roster ?? 0)}
              </option>
            ))}
          </select>
        )}

        {isLoading ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : !data || data.skipped.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground" data-testid="pcp-skipped-none">
            <CheckCircle2 size={28} className="mx-auto mb-2 text-green-300" />
            <p className="text-sm font-semibold text-gray-700">Nobody would be skipped</p>
            <p className="mt-0.5 text-xs">
              All {data?.totalChecked ?? 0} employees on the {info.label} cycle checked out fine for this period
              {data && data.alreadyGenerated > 0 ? ` (${data.alreadyGenerated} already have payroll)` : ""}.
            </p>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-xs text-gray-500">
              {data.skippedCount} of {data.totalChecked} employees would be skipped if you generated now
              {data.alreadyGenerated > 0 ? `; ${data.alreadyGenerated} already have payroll and are left alone` : ""}:
            </p>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {data.skipped.map((s) => (
                <div key={s.employeeId} className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-amber-900">{s.name}</span>
                    <span className="font-mono text-xs text-amber-600">{s.employeeCode}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-amber-700">{s.reason}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCcw size={12} className={isFetching ? "animate-spin" : ""} /> Re-check
          </Button>
          <Button onClick={onClose}>
            <X size={14} className="mr-1" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
